/**
 * The Sensor Factory formula language (`T-21`).
 *
 * **A tiny expression language, hand-written, and deliberately not a sandbox around
 * JavaScript.** The obvious shortcut — `new Function(formula)` or `node:vm` — would let an
 * operator with sensor-create rights run code in the core process, which holds the vault key and
 * the database. `support/pattern.ts` already went to some trouble to bound an operator-supplied
 * *regular expression*; handing one an evaluator would undo all of it. So this parses what it
 * accepts and can evaluate nothing else: numbers, five operators, brackets, and a fixed list of
 * functions.
 *
 * **What it is for.** A factory sensor answers questions no single check can: total throughput
 * across four uplinks, how many of a cluster's members are up, a percentage of one channel
 * against another on a different device. PRTG's is the model and the syntax is close enough that
 * somebody who knows it will recognise this.
 *
 *   channel(42, 'traffic.in') + channel(43, 'traffic.in')
 *   percent(channel(7, 'used'), channel(7, 'total'))
 *   status(11) + status(12) + status(13)
 *   max(channel(1, 'rtt'), channel(2, 'rtt'))
 *
 * **`channel()` of something with no reading is a gap, not a zero** — the rule the whole system
 * is built on. An expression that touches a gap yields a gap, so a factory channel goes blank
 * while an input is missing rather than reporting a total that silently lost a term. The one
 * exception is spelled `default(expression, n)`, where an operator has *said* what absence means.
 */

export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaError';
  }
}

/** Longer than any formula anybody means to write, and short enough to bound a parse. */
export const MAX_FORMULA = 2_000;

export type Node =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'channel'; readonly sensorId: number; readonly channelKey: string }
  | { readonly kind: 'status'; readonly sensorId: number }
  | { readonly kind: 'unary'; readonly op: '-'; readonly operand: Node }
  | {
      readonly kind: 'binary';
      readonly op: '+' | '-' | '*' | '/' | '%';
      readonly left: Node;
      readonly right: Node;
    }
  | { readonly kind: 'call'; readonly name: FunctionName; readonly args: readonly Node[] };

/**
 * The functions a formula may call.
 *
 * A closed list, and short. Everything here is arithmetic over readings; nothing reads a clock,
 * a file or a database, because a formula that could would be a formula whose result depends on
 * something an operator cannot see in it.
 */
const FUNCTIONS = {
  min: { min: 1, max: 16 },
  max: { min: 1, max: 16 },
  avg: { min: 1, max: 16 },
  sum: { min: 1, max: 16 },
  abs: { min: 1, max: 1 },
  round: { min: 1, max: 2 },
  floor: { min: 1, max: 1 },
  ceil: { min: 1, max: 1 },
  /** `percent(a, b)` is `100 * a / b`, which is the single most common thing anybody writes. */
  percent: { min: 2, max: 2 },
  /** The one place a gap becomes a number, and only because an operator said what it means. */
  default: { min: 2, max: 2 },
} as const;

export type FunctionName = keyof typeof FUNCTIONS;

interface Token {
  readonly kind: 'number' | 'name' | 'string' | 'punct';
  readonly text: string;
  readonly at: number;
}

function tokenise(formula: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < formula.length) {
    const character = formula[at] ?? '';
    if (/\s/.test(character)) {
      at += 1;
      continue;
    }
    if (/[0-9]/.test(character) || (character === '.' && /[0-9]/.test(formula[at + 1] ?? ''))) {
      const start = at;
      while (at < formula.length && /[0-9._]/.test(formula[at] ?? '')) at += 1;
      // `_` as a digit separator, because 1_000_000 is easier to read and to check than 1000000.
      tokens.push({ kind: 'number', text: formula.slice(start, at).replace(/_/g, ''), at: start });
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const start = at;
      while (at < formula.length && /[A-Za-z0-9_]/.test(formula[at] ?? '')) at += 1;
      tokens.push({ kind: 'name', text: formula.slice(start, at), at: start });
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      const start = at;
      at += 1;
      const from = at;
      while (at < formula.length && formula[at] !== quote) at += 1;
      const value = formula.slice(from, at);
      if (at >= formula.length) {
        throw new FormulaError(`the quote opened at position ${String(start)} is never closed`);
      }
      at += 1;
      tokens.push({ kind: 'string', text: value, at: start });
      continue;
    }
    if ('+-*/%(),'.includes(character)) {
      tokens.push({ kind: 'punct', text: character, at });
      at += 1;
      continue;
    }
    throw new FormulaError(
      `"${character}" at position ${String(at)} is not something a formula may contain — this ` +
        'is arithmetic over channels, not an expression language',
    );
  }
  return tokens;
}

/**
 * Parses a formula, or says why it will not.
 *
 * Separate from evaluating it so a sensor is refused at *save* time rather than discovered as a
 * failing check a minute later — the same split `compilePattern` and `parsePath` make.
 */
export function parseFormula(formula: string): Node {
  if (formula.length > MAX_FORMULA) {
    throw new FormulaError(
      `the formula is ${String(formula.length)} characters; the limit is ${String(MAX_FORMULA)}`,
    );
  }
  const trimmed = formula.trim();
  if (trimmed === '') throw new FormulaError('the formula is empty');

  const tokens = tokenise(trimmed);
  let at = 0;

  const peek = (): Token | undefined => tokens[at];
  const eat = (text: string): boolean => {
    if (peek()?.text === text) {
      at += 1;
      return true;
    }
    return false;
  };
  const expect = (text: string, what: string): void => {
    if (!eat(text)) {
      const found = peek();
      throw new FormulaError(
        `expected ${what} but found ${found === undefined ? 'the end of the formula' : `"${found.text}"`}`,
      );
    }
  };

  // Precedence: + - bind loosest, * / % next, unary minus tightest. Two levels is all this needs.
  function expression(): Node {
    let left = term();
    for (;;) {
      const token = peek();
      if (token?.kind === 'punct' && (token.text === '+' || token.text === '-')) {
        at += 1;
        left = { kind: 'binary', op: token.text, left, right: term() };
        continue;
      }
      return left;
    }
  }

  function term(): Node {
    let left = unary();
    for (;;) {
      const token = peek();
      if (
        token?.kind === 'punct' &&
        (token.text === '*' || token.text === '/' || token.text === '%')
      ) {
        at += 1;
        left = { kind: 'binary', op: token.text, left, right: unary() };
        continue;
      }
      return left;
    }
  }

  function unary(): Node {
    if (eat('-')) return { kind: 'unary', op: '-', operand: unary() };
    // Unary plus is accepted and discarded: somebody writing `+5` means 5.
    if (eat('+')) return unary();
    return primary();
  }

  function primary(): Node {
    const token = peek();
    if (token === undefined) throw new FormulaError('the formula ends where a value was expected');

    if (token.kind === 'number') {
      at += 1;
      const value = Number(token.text);
      if (!Number.isFinite(value)) throw new FormulaError(`"${token.text}" is not a number`);
      return { kind: 'number', value };
    }

    if (token.text === '(') {
      at += 1;
      const inner = expression();
      expect(')', 'a closing bracket');
      return inner;
    }

    if (token.kind === 'name') {
      at += 1;
      const name = token.text;
      expect('(', `an opening bracket after "${name}"`);

      if (name === 'channel') return channelCall();
      if (name === 'status') return statusCall();

      const arity = FUNCTIONS[name as FunctionName] as { min: number; max: number } | undefined;
      if (arity === undefined) {
        throw new FormulaError(
          `there is no function called "${name}" — a formula may use ` +
            `${Object.keys(FUNCTIONS).join(', ')}, channel and status, and nothing else`,
        );
      }
      const args: Node[] = [];
      if (!eat(')')) {
        do {
          args.push(expression());
        } while (eat(','));
        expect(')', `a closing bracket for ${name}(`);
      }
      if (args.length < arity.min || args.length > arity.max) {
        throw new FormulaError(
          `${name}() takes ${arity.min === arity.max ? String(arity.min) : `${String(arity.min)} to ${String(arity.max)}`} ` +
            `argument${arity.max === 1 ? '' : 's'} and was given ${String(args.length)}`,
        );
      }
      return { kind: 'call', name: name as FunctionName, args };
    }

    throw new FormulaError(`"${token.text}" is not a value`);
  }

  function channelCall(): Node {
    const sensorId = sensorIdArgument('channel');
    expect(',', "a comma after channel's sensor id");
    const key = peek();
    if (key?.kind !== 'string') {
      throw new FormulaError(
        "channel()'s second argument is a channel key in quotes, like channel(42, 'traffic.in')",
      );
    }
    at += 1;
    expect(')', 'a closing bracket for channel(');
    if (key.text.trim() === '') throw new FormulaError('channel() was given an empty channel key');
    return { kind: 'channel', sensorId, channelKey: key.text.trim() };
  }

  function statusCall(): Node {
    const sensorId = sensorIdArgument('status');
    expect(')', 'a closing bracket for status(');
    return { kind: 'status', sensorId };
  }

  function sensorIdArgument(name: string): number {
    const token = peek();
    if (token?.kind !== 'number' || !/^\d+$/.test(token.text)) {
      throw new FormulaError(`${name}()'s first argument is a sensor id, which is a whole number`);
    }
    at += 1;
    return Number(token.text);
  }

  const root = expression();
  if (at < tokens.length) {
    throw new FormulaError(
      `the formula continues after it should have ended, at "${tokens[at]?.text ?? ''}"`,
    );
  }
  return root;
}

/** Every sensor a formula reads. What `T-21`'s cycle detection walks. */
export function referencedSensors(node: Node, into: Set<number> = new Set()): Set<number> {
  switch (node.kind) {
    case 'channel':
    case 'status':
      into.add(node.sensorId);
      break;
    case 'unary':
      referencedSensors(node.operand, into);
      break;
    case 'binary':
      referencedSensors(node.left, into);
      referencedSensors(node.right, into);
      break;
    case 'call':
      for (const argument of node.args) referencedSensors(argument, into);
      break;
    default:
      break;
  }
  return into;
}

/** One channel's latest reading, with the age that decides whether it still counts. */
export interface ChannelReading {
  readonly value: number;
  /**
   * Seconds between the sample and the sweep reading it. A factory's own output, written back
   * within the sweep that computed it, is 0 — it does not get older by being passed along.
   */
  readonly ageSeconds: number;
}

/** What a formula is evaluated against: the latest reading per channel, and each sensor's state. */
export interface FormulaInputs {
  /** `sensorId:channelKey` to the latest reading. Absent is a gap, not a zero. */
  readonly channels: ReadonlyMap<string, ChannelReading>;
  /** `sensorId` to whether that sensor is currently Up. Absent is unknown, which is not up. */
  readonly up: ReadonlyMap<number, boolean>;
  /**
   * Past this age a reading counts as absent. It belongs here rather than on the reading because
   * it is the *reading sensor's* setting: one factory willing to work from day-old data must not
   * widen the cut-off of a factory next to it that is not, which is what `P-59` was.
   */
  readonly maxAgeSeconds: number;
}

/**
 * The value of a formula, or `null` for a gap.
 *
 * **A gap propagates**, which is the whole reason this returns null rather than throwing or
 * substituting. `channel(1,'in') + channel(2,'in')` with sensor 2 down must not report sensor 1's
 * traffic as the total: that is a number which looks like data and is wrong, and it is exactly
 * the failure mode a factory sensor is most likely to produce. `default(…, 0)` is how an operator
 * says otherwise, in the formula, where a reader can see it.
 */
export function evaluate(node: Node, inputs: FormulaInputs): number | null {
  switch (node.kind) {
    case 'number':
      return node.value;

    case 'channel': {
      const reading = inputs.channels.get(`${String(node.sensorId)}:${node.channelKey}`);
      // Too old is absent, and absent is a gap. A source that stopped reporting leaves its last
      // value behind for ever, and arithmetic over it produces a number that looks like data.
      if (reading === undefined || reading.ageSeconds > inputs.maxAgeSeconds) return null;
      return reading.value;
    }

    case 'status':
      // Unknown is not up. A sensor the core has never heard from is not evidence of health.
      return inputs.up.get(node.sensorId) === true ? 1 : 0;

    case 'unary': {
      const operand = evaluate(node.operand, inputs);
      return operand === null ? null : -operand;
    }

    case 'binary': {
      const left = evaluate(node.left, inputs);
      const right = evaluate(node.right, inputs);
      if (left === null || right === null) return null;
      switch (node.op) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          // A gap rather than Infinity or a throw: dividing by a channel that happens to be zero
          // is an ordinary transient, and a factory sensor going Down because a denominator was
          // briefly zero would be an alarm about arithmetic.
          return right === 0 ? null : left / right;
        case '%':
          return right === 0 ? null : left % right;
      }
      return null;
    }

    case 'call':
      return call(node, inputs);
  }
}

function call(node: Extract<Node, { kind: 'call' }>, inputs: FormulaInputs): number | null {
  // `default` is the one function evaluated lazily, because its whole job is to have an answer
  // when its first argument does not.
  if (node.name === 'default') {
    const value = evaluate(node.args[0] as Node, inputs);
    if (value !== null) return value;
    return evaluate(node.args[1] as Node, inputs);
  }

  const values: number[] = [];
  for (const argument of node.args) {
    const value = evaluate(argument, inputs);
    if (value === null) return null;
    values.push(value);
  }

  switch (node.name) {
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    case 'sum':
      return values.reduce((total, one) => total + one, 0);
    case 'avg':
      return values.reduce((total, one) => total + one, 0) / values.length;
    case 'abs':
      return Math.abs(values[0] ?? 0);
    case 'floor':
      return Math.floor(values[0] ?? 0);
    case 'ceil':
      return Math.ceil(values[0] ?? 0);
    case 'round': {
      const places = Math.max(0, Math.min(10, Math.trunc(values[1] ?? 0)));
      const scale = 10 ** places;
      return Math.round((values[0] ?? 0) * scale) / scale;
    }
    case 'percent': {
      const total = values[1] ?? 0;
      return total === 0 ? null : (100 * (values[0] ?? 0)) / total;
    }
  }
}
