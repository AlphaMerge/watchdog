/**
 * A bounded JSONPath, for turning what a REST endpoint returned into channels (`T-16`).
 *
 * **A subset, deliberately, and the subset is documented rather than discovered.** Full JSONPath
 * is a specification with script expressions in it — `[?(@.length-1)]` evaluates JavaScript in
 * the reference implementation — and an operator-supplied expression that can execute is a thing
 * this codebase already refused once, in `support/pattern.ts`. What is here is the part people
 * actually write against a status endpoint: members, indexes, a wildcard, recursive descent, and
 * one comparison filter.
 *
 *   $.queue.depth            a member
 *   $.nodes[0].load          an index; [-1] counts from the end
 *   $.nodes[*].load          every element — see `aggregate`
 *   $..load                  every `load` at any depth
 *   $.nodes[?(@.state=='down')]   the ones matching a comparison
 *   $.nodes[?(@.load>0.9)].name
 *
 * **A path selects a set, never a value**, which is what makes the aggregate an explicit choice
 * rather than a guess. "How many nodes are down" and "the worst load on any node" are the same
 * path with a different aggregate, and a language that silently returned the first match would
 * answer both of them wrongly and never say so.
 */

export class JsonPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonPathError';
  }
}

type Step =
  | {
      readonly kind: 'member';
      readonly name: string;
      /**
       * Apply this step to every element of an array rather than to the array itself (`T-24`).
       *
       * Set only for XPath-spelled paths, and it is what makes them work over an XML tree: every
       * element in that tree is an array, so `/prtg/result/channel` has to walk *through* the
       * one-element array `prtg` is. That is exactly XPath's own semantics — a location step
       * applies to a node-set, not to a node.
       *
       * Deliberately not the default. In JSON, `$.a.b` where `a` is an array selects nothing and
       * `$.a[*].b` is how you say otherwise; changing that would silently alter every path
       * `T-16` shipped.
       */
      readonly through?: true;
    }
  | { readonly kind: 'index'; readonly at: number }
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'descend'; readonly name: string; readonly through?: true }
  /**
   * An XPath predicate, which applies to the **node-set** rather than inside each node (`T-24`).
   *
   * This is the real difference between the two syntaxes, and it is not cosmetic. `$.a[0]` in
   * JSONPath means "index into the array `a`"; `/a[1]` in XPath means "the first node of the set
   * `/a` produced". Same brackets, different subject — so they are different steps, and the
   * syntax the path was written in decides which one is built.
   */
  | { readonly kind: 'position'; readonly at: number }
  | {
      readonly kind: 'select';
      readonly name: string;
      readonly op: '==' | '!=' | '<' | '>' | '<=' | '>=';
      readonly value: string | number | boolean | null;
    }
  | {
      readonly kind: 'filter';
      readonly name: string;
      readonly op: '==' | '!=' | '<' | '>' | '<=' | '>=';
      readonly value: string | number | boolean | null;
    };

/** Longer than any real path, and short enough that a parse cannot be made expensive. */
export const MAX_PATH = 200;

/**
 * Turns a path into steps, or says why it is not one.
 *
 * Separate from evaluating it so a sensor can be refused at *save* time rather than discovered as
 * a failing check twenty seconds later — the same reason `paramsSchema` validates the API and the
 * same split `compilePattern` makes.
 */
export function parsePath(path: string): Step[] {
  if (path.length > MAX_PATH) {
    throw new JsonPathError(
      `the path is ${String(path.length)} characters; the limit is ${String(MAX_PATH)}`,
    );
  }
  const steps: Step[] = [];
  let at = 0;
  const text = path.trim();
  if (text === '') throw new JsonPathError('the path is empty');
  // A path beginning with a slash is XPath spelling (`T-24`), translated to the same steps.
  if (text.startsWith('/')) return parseLocationPath(text);
  if (text.startsWith('$')) at = 1;
  else if (!text.startsWith('.') && !text.startsWith('[')) {
    // `queue.depth` rather than `$.queue.depth`. Accepted because everybody writes it, and
    // rejecting it would be a rule with no purpose behind it.
    steps.push({ kind: 'member', name: readBareName() });
  }

  function readBareName(): string {
    const start = at;
    while (at < text.length && /[A-Za-z0-9_\-@ ]/.test(text[at] ?? '')) at += 1;
    if (at === start) throw new JsonPathError(`expected a name at position ${String(start)}`);
    return text.slice(start, at);
  }

  while (at < text.length) {
    const character = text[at];
    if (character === '.') {
      at += 1;
      if (text[at] === '.') {
        at += 1;
        if (text[at] === '*') {
          throw new JsonPathError(
            '`..*` selects everything at every depth, which is never a check',
          );
        }
        steps.push({ kind: 'descend', name: readBareName() });
        continue;
      }
      if (text[at] === '*') {
        at += 1;
        steps.push({ kind: 'wildcard' });
        continue;
      }
      steps.push({ kind: 'member', name: readBareName() });
      continue;
    }
    if (character === '[') {
      at += 1;
      steps.push(readBracket());
      if (text[at] !== ']') {
        throw new JsonPathError(`"${text}" has a [ that is never closed`);
      }
      at += 1;
      continue;
    }
    throw new JsonPathError(
      `"${text}" has an unexpected "${character ?? ''}" at position ${String(at)}`,
    );
  }
  if (steps.length === 0) throw new JsonPathError('`$` on its own selects the whole document');
  return steps;

  function readBracket(): Step {
    if (text[at] === '*') {
      at += 1;
      return { kind: 'wildcard' };
    }
    if (text[at] === "'" || text[at] === '"') {
      const quote = text[at];
      at += 1;
      const start = at;
      while (at < text.length && text[at] !== quote) at += 1;
      const name = text.slice(start, at);
      at += 1;
      return { kind: 'member', name };
    }
    if (text[at] === '?') {
      at += 1;
      return readFilter();
    }
    const start = at;
    if (text[at] === '-') at += 1;
    while (at < text.length && /[0-9]/.test(text[at] ?? '')) at += 1;
    if (at === start) throw new JsonPathError(`expected an index at position ${String(start)}`);
    return { kind: 'index', at: Number(text.slice(start, at)) };
  }

  function readFilter(): Step {
    // `[?(@.state=='down')]`. The parentheses are optional because half the world writes them and
    // half does not, and being strict about it would only ever produce a support question.
    const closing = text.indexOf(']', at);
    if (closing < 0) throw new JsonPathError(`"${text}" has a filter that is never closed`);
    let inner = text.slice(at, closing).trim();
    if (inner.startsWith('(') && inner.endsWith(')')) inner = inner.slice(1, -1).trim();
    at = closing;

    const match = /^@\.?([A-Za-z0-9_.-]*)\s*(==|!=|<=|>=|<|>)\s*(.+)$/.exec(inner);
    if (match === null) {
      throw new JsonPathError(
        `"${inner}" is not a comparison — a filter looks like [?(@.state=='down')] or ` +
          '[?(@.load>0.9)], and nothing else is supported here on purpose: a JSONPath filter that ' +
          'can evaluate an expression is an operator-supplied expression that can run',
      );
    }
    const raw = (match[3] ?? '').trim();
    let value: string | number | boolean | null;
    if (/^'.*'$/.test(raw) || /^".*"$/.test(raw)) value = raw.slice(1, -1);
    else if (raw === 'true') value = true;
    else if (raw === 'false') value = false;
    else if (raw === 'null') value = null;
    else if (raw !== '' && Number.isFinite(Number(raw))) value = Number(raw);
    else value = raw;

    return {
      kind: 'filter',
      name: match[1] ?? '',
      op: (match[2] ?? '==') as '==' | '!=' | '<' | '>' | '<=' | '>=',
      value,
    };
  }
}

/**
 * An XPath-style location path, over the same steps (`T-24`).
 *
 * **XPath spelling, not a second engine.** `T-24` asks for "XPath extraction", and a second path
 * language would be two things for an operator to learn, two to test and two to get subtly wrong.
 * So a path beginning with `/` is read here and produces the steps `selectPath` already walks:
 *
 *   /prtg/result/channel          members, in order
 *   /prtg/result[2]/value         **one-based**, as XPath is — see below
 *   /prtg/result[last()]/value    the last one
 *   //channel                     at any depth
 *   /result/@name                 an attribute
 *   /result/text()                the element's own text
 *   /result[@state='down']/name   a predicate on an attribute
 *
 * **`[1]` is the first, and that is the one place these two syntaxes disagree.** JSONPath counts
 * from zero and XPath from one. Silently treating them the same would make `[1]` mean the second
 * element to one operator and the first to another, in the same field of the same form — so the
 * *syntax the path is written in* decides, and the description on the parameter says which.
 */
function parseLocationPath(text: string): Step[] {
  const steps: Step[] = [];
  let rest = text;

  while (rest.startsWith('/')) {
    const descend = rest.startsWith('//');
    rest = rest.slice(descend ? 2 : 1);
    if (rest === '') break;

    const match = /^([^/[]+)/.exec(rest);
    const raw = (match?.[1] ?? '').trim();
    if (raw === '') throw new JsonPathError(`"${text}" has an empty step`);
    rest = rest.slice(match?.[0].length ?? 0);

    if (raw === '*') {
      if (descend) throw new JsonPathError('`//*` selects everything at every depth');
      steps.push({ kind: 'wildcard' });
    } else if (raw === 'text()') {
      // `#text` is where `fast-xml-parser` puts an element's own text when it also has
      // attributes or children. An element with neither *is* its text, which `selectPath`
      // reaches because a member step over a string simply selects nothing and the caller
      // already has the element.
      steps.push({ kind: 'member', name: '#text', through: true });
    } else if (raw.startsWith('@')) {
      steps.push({ kind: 'member', name: `@_${raw.slice(1)}`, through: true });
    } else if (descend) {
      steps.push({ kind: 'descend', name: raw, through: true });
    } else {
      steps.push({ kind: 'member', name: raw, through: true });
    }

    // Predicates. `[2]`, `[last()]`, or a comparison on an attribute or child.
    while (rest.startsWith('[')) {
      const close = rest.indexOf(']');
      if (close < 0) throw new JsonPathError(`"${text}" has a [ that is never closed`);
      const inner = rest.slice(1, close).trim();
      rest = rest.slice(close + 1);

      if (/^\d+$/.test(inner)) {
        const position = Number(inner);
        if (position < 1) {
          throw new JsonPathError('XPath positions start at 1, so [0] selects nothing');
        }
        steps.push({ kind: 'position', at: position - 1 });
        continue;
      }
      if (inner === 'last()') {
        steps.push({ kind: 'position', at: -1 });
        continue;
      }
      const comparison = /^@?([A-Za-z0-9_.:-]+)\s*(=|!=|<=|>=|<|>)\s*(.+)$/.exec(inner);
      if (comparison === null) {
        throw new JsonPathError(
          `"[${inner}]" is not a predicate this reads — a position, last(), or a comparison ` +
            "such as [@state='down']",
        );
      }
      const name = inner.startsWith('@') ? `@_${comparison[1] ?? ''}` : (comparison[1] ?? '');
      const operator = comparison[2] === '=' ? '==' : (comparison[2] ?? '==');
      steps.push({
        kind: 'select',
        name,
        op: operator as '==' | '!=' | '<' | '>' | '<=' | '>=',
        value: literal((comparison[3] ?? '').trim()),
      });
    }
  }

  if (steps.length === 0) throw new JsonPathError('`/` on its own selects the whole document');
  return steps;
}

/** A predicate's right-hand side. Same rules as the JSONPath filter's, so they cannot drift. */
function literal(raw: string): string | number | boolean | null {
  if (/^'.*'$/.test(raw) || /^".*"$/.test(raw)) return raw.slice(1, -1);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw !== '' && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}

/** How many nodes one path may visit, so a recursive descent over a huge document is bounded. */
const MAX_VISITS = 200_000;

/** Every value the path selects, in document order. */
export function selectPath(document: unknown, steps: readonly Step[]): unknown[] {
  let current: unknown[] = [document];
  let visits = 0;

  const budget = (by: number): void => {
    visits += by;
    if (visits > MAX_VISITS) {
      throw new JsonPathError(
        `this path visited more than ${String(MAX_VISITS)} values — a recursive descent over a ` +
          'large document is usually the cause, and a more specific path is the fix',
      );
    }
  };

  for (const step of steps) {
    // The two XPath steps act on the node-set as a whole, so they are handled before the loop
    // that visits each node.
    if (step.kind === 'position') {
      budget(1);
      const at = step.at < 0 ? current.length + step.at : step.at;
      const one = current[at];
      current = at >= 0 && at < current.length && one !== undefined ? [one] : [];
      if (current.length === 0) return [];
      continue;
    }
    if (step.kind === 'select') {
      budget(current.length);
      current = current.filter((node) => {
        const raw = step.name === '' ? node : memberAt(node, step.name);
        return compare(stringValue(raw), step.op, step.value);
      });
      if (current.length === 0) return [];
      continue;
    }

    const next: unknown[] = [];
    budget(current.length);
    for (const value of current) {
      switch (step.kind) {
        case 'member': {
          if (step.through === true) {
            // **An XPath step yields a node-set, and that is what the flattening is for.** Every
            // element in the XML tree is an array — `<value>91.5</value>` is `value: ['91.5']` —
            // so a step both walks *through* the array it is applied to and flattens the array it
            // produces. Without the second half, `/prtg/result/value` returns `[['91.5'], ...]`
            // and every aggregate over it reports nothing, which is a path that looks right and
            // silently measures nothing.
            for (const element of Array.isArray(value) ? (value as unknown[]) : [value]) {
              if (step.name === TEXT && !isRecord(element)) {
                // An element with no attributes and no children *is* its text.
                if (element !== undefined && element !== null) next.push(element);
                continue;
              }
              if (!isRecord(element) || !(step.name in element)) continue;
              const found = element[step.name];
              if (Array.isArray(found)) next.push(...(found as unknown[]));
              else next.push(found);
            }
            break;
          }
          if (isRecord(value) && step.name in value) next.push(value[step.name]);
          break;
        }
        case 'index': {
          if (Array.isArray(value)) {
            const at = step.at < 0 ? value.length + step.at : step.at;
            if (at >= 0 && at < value.length) next.push(value[at]);
          }
          break;
        }
        case 'wildcard': {
          if (Array.isArray(value)) next.push(...(value as unknown[]));
          else if (isRecord(value)) next.push(...Object.values(value));
          break;
        }
        case 'descend': {
          const found: unknown[] = [];
          descend(value, step.name, found, budget);
          // An XPath descent yields a node-set too, so it flattens the same way a step does.
          for (const one of found) {
            if (step.through === true && Array.isArray(one)) next.push(...(one as unknown[]));
            else next.push(one);
          }
          break;
        }
        case 'filter': {
          // An XPath predicate filters the node-set the step before it produced, and that set is
          // already an array of elements — so the candidates are the same either way.
          const candidates: unknown[] = Array.isArray(value)
            ? (value as unknown[])
            : isRecord(value)
              ? Object.values(value)
              : [];
          for (const candidate of candidates) {
            const field = step.name === '' ? candidate : memberAt(candidate, step.name);
            if (compare(field, step.op, step.value)) next.push(candidate);
          }
          break;
        }
      }
    }
    current = next;
    if (current.length === 0) return [];
  }
  return current;
}

/**
 * `$..name`, iteratively.
 *
 * **An explicit stack rather than recursion**, because a JSON document nests as deeply as
 * whatever produced it felt like: the recursive version overflowed the call stack at around
 * 12,000 levels and reported `Maximum call stack size exceeded`, which tells an operator nothing
 * about their sensor and is not even catchable as a diagnosis. Now the visit budget is the only
 * bound, and it says what to do about it.
 *
 * Children are pushed in reverse so they pop in document order, and the named member is
 * collected without descending into it — `$..free` on a `free` that is itself an object is
 * asking for that object, not for a `free` inside it.
 */
function descend(root: unknown, name: string, into: unknown[], budget: (by: number) => void): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    budget(1);
    if (Array.isArray(value)) {
      for (let at = value.length - 1; at >= 0; at -= 1) stack.push(value[at]);
      continue;
    }
    if (!isRecord(value)) continue;
    if (name in value) into.push(value[name]);
    const entries = Object.entries(value).filter(([key]) => key !== name);
    for (let at = entries.length - 1; at >= 0; at -= 1) stack.push(entries[at]?.[1]);
  }
}

/** Where an XML element's own text lands when it also has attributes or children. */
const TEXT = '#text';

/**
 * What an XPath predicate compares against — the node's *string value*.
 *
 * Two unwrappings, and both are the XML tree showing through. A member is a one-element array
 * because every element is; and an element that carries attributes is an object whose own text
 * sits under `#text`, so `[unit='%']` on `<unit state="ok">%</unit>` has to reach past the
 * attributes to the text. Comparing the object instead would make that predicate silently false
 * — a filter that matches nothing and looks like a document that contains nothing.
 */
function stringValue(raw: unknown): unknown {
  const one = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
  return isRecord(one) && TEXT in one ? one[TEXT] : one;
}

/** `a.b.c` inside a filter, so `[?(@.status.state=='up')]` works. */
function memberAt(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function compare(left: unknown, op: string, right: string | number | boolean | null): boolean {
  if (op === '==' || op === '!=') {
    // Loose on the number/string boundary, because JSON carries "3" and 3 from the same field on
    // different days and an operator comparing to 3 means both.
    const same =
      left === right ||
      (typeof left === 'number' && typeof right === 'string' && String(left) === right) ||
      (typeof left === 'string' && typeof right === 'number' && left === String(right));
    return op === '==' ? same : !same;
  }
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (op === '<') return a < b;
  if (op === '>') return a > b;
  if (op === '<=') return a <= b;
  return a >= b;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type Aggregate = 'first' | 'last' | 'count' | 'sum' | 'min' | 'max' | 'avg';

/**
 * The one number a set of selected values becomes.
 *
 * **`count` counts what the path selected; every other aggregate counts what is a number.** That
 * distinction is the whole point of having them: "how many nodes are down" counts objects, and
 * "the worst load" has nothing to do with how many entries were strings. Returns null when there
 * is nothing to report — which becomes a gap, never a zero.
 */
export function aggregateOf(values: readonly unknown[], how: Aggregate): number | null {
  if (how === 'count') return values.length;
  if (values.length === 0) return null;

  const numbers: number[] = [];
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) numbers.push(value);
    else if (typeof value === 'boolean') numbers.push(value ? 1 : 0);
    else if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      // A gauge sent as a string is what half the world's REST endpoints do.
      numbers.push(Number(value));
    }
  }
  if (numbers.length === 0) return null;

  switch (how) {
    case 'first':
      return numbers[0] ?? null;
    case 'last':
      return numbers[numbers.length - 1] ?? null;
    case 'sum':
      return numbers.reduce((total, one) => total + one, 0);
    case 'min':
      return Math.min(...numbers);
    case 'max':
      return Math.max(...numbers);
    case 'avg':
      return numbers.reduce((total, one) => total + one, 0) / numbers.length;
  }
}
