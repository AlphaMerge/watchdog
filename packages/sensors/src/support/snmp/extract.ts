import { createContext, Script, type Context } from 'node:vm';

/**
 * Getting a number out of a string a device returned (`T-03`).
 *
 * Pure, and separate from the sensor type, because this is the half with the sharp edges: an
 * operator-supplied regular expression run against device-supplied text, inside a worker.
 *
 * **Catastrophic backtracking is the risk, and it is genuinely bounded rather than hoped away.**
 * JavaScript has no interruptible regular expression: once `exec` is running, nothing stops it —
 * not the `AbortSignal` every check is required to honour, not a timer. Measured here while
 * building this: `(a+)+$` against forty characters and a `b` takes **86 seconds**. Truncating the
 * subject does not help, because forty characters was already enough; refusing "dangerous"
 * patterns does not either, since deciding whether a regex backtracks badly is a research problem
 * and every heuristic both rejects working patterns and admits broken ones.
 *
 * What does work is V8's own watchdog. The match runs inside a `node:vm` context with a timeout,
 * which *can* interrupt it — the same 86-second pattern returns in 265 ms. Measured cost of
 * doing every match that way, on the same machine:
 *
 *   direct  0.19 µs per match
 *   in a vm 99.7 µs per match
 *
 * Five hundred times slower and completely irrelevant: a tenth of a millisecond against an SNMP
 * round trip measured in milliseconds to seconds, and 0.5 s of CPU a minute if all 5,000 sensors
 * at the v1 target were this type. The trade is a tenth of a millisecond per check to turn "a
 * mistyped pattern hangs a worker until the pool terminates it" into "this check failed in 250 ms
 * and said why".
 *
 * The context and the compiled script are made once per worker and reused; a worker that never
 * runs one of these types pays nothing for them.
 */

/** Longer than any legible pattern, and short enough to keep in an error message. */
export const MAX_PATTERN = 500;

/**
 * How much device text is matched against.
 *
 * Not the defence against backtracking — the timeout is — but still worth having: SNMP allows an
 * OctetString of 65,535 bytes, cost grows with the subject, and 4 KB is far more than any
 * `sysDescr` or vendor status string.
 */
export const MAX_SUBJECT = 4_096;

/**
 * How long one match may run.
 *
 * Generous by four orders of magnitude for any pattern anybody meant to write, and short enough
 * that hitting it fails the check rather than the scan interval.
 */
export const MATCH_TIMEOUT_MS = 250;

export type ExtractMode = 'number' | 'match';

export type Extracted =
  /** The pattern matched (or there was none) and a number came out of it. */
  | { readonly kind: 'value'; readonly value: number; readonly matched: string }
  /** The pattern did not match. In `match` mode this is a zero; in `number` mode it is a failure. */
  | { readonly kind: 'no-match' }
  /** It matched, and what it matched is not a number. Only reachable in `number` mode. */
  | { readonly kind: 'not-a-number'; readonly matched: string }
  /** The match was still running when the watchdog stopped it. */
  | { readonly kind: 'too-slow'; readonly afterMs: number };

export class PatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatternError';
  }
}

/**
 * Checks a pattern is one this will run, without running it.
 *
 * Separate from `extract` so a sensor can be refused at *save* time rather than discovered as a
 * failing check twenty seconds later — the same reason `paramsSchema` validates the API.
 *
 * No `g` flag, ever: a global regular expression carries `lastIndex` between calls, so the same
 * pattern against the same string matches on one scan and not the next. That reads as a flapping
 * device and cannot be reproduced by hand.
 */
export function compilePattern(pattern: string): RegExp {
  if (pattern.length > MAX_PATTERN) {
    throw new PatternError(
      `the pattern is ${String(pattern.length)} characters; the limit is ${String(MAX_PATTERN)}`,
    );
  }
  try {
    return new RegExp(pattern, 'u');
  } catch (error) {
    throw new PatternError(
      `"${pattern}" is not a valid regular expression: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

/*
 * Built on first use and reused for the life of the worker.
 *
 * The script returns a *string or null* rather than the match array: primitives cross the realm
 * boundary cleanly, and nothing from inside the sandbox is then held by the caller.
 */
let sandbox: Context | undefined;
let matcher: Script | undefined;

function runMatch(subject: string, pattern: string, timeoutMs: number): string | null {
  sandbox ??= createContext({ s: '', p: '' });
  matcher ??= new Script(
    // `m[1] === undefined` rather than `m[1] ?? m[0]`: a group that did not participate is
    // undefined, and falling back to the whole match is what a pattern like `(?:a)|(b)` needs.
    '(function () { const m = new RegExp(p, "u").exec(s); ' +
      'return m === null ? null : (m[1] === undefined ? m[0] : m[1]); })()',
  );
  const context = sandbox as { s: string; p: string };
  context.s = subject;
  context.p = pattern;
  const result: unknown = matcher.runInContext(sandbox, { timeout: timeoutMs });
  return typeof result === 'string' ? result : null;
}

/**
 * The number a device's string yields.
 *
 * With a capture group, the **first group** is what is used — `Temp: ([0-9.]+)C` on
 * "Temp: 41.5C" gives 41.5. Without one the whole match is used, which is what a pattern like
 * `[0-9.]+` is for. Without a pattern at all the whole string is parsed, which covers the common
 * case of an agent returning a number as an OctetString.
 */
export function extract(
  text: string,
  pattern: string | null,
  mode: ExtractMode,
  timeoutMs: number = MATCH_TIMEOUT_MS,
): Extracted {
  const subject = text.length > MAX_SUBJECT ? text.slice(0, MAX_SUBJECT) : text;

  if (pattern === null || pattern === '') {
    if (mode === 'match') return { kind: 'value', value: 1, matched: subject };
    return numberFrom(subject.trim());
  }

  const started = Date.now();
  let matched: string | null;
  try {
    matched = runMatch(subject, pattern, timeoutMs);
  } catch (error) {
    // Not `instanceof Error`: what the watchdog throws does not always satisfy it across the
    // realm boundary, and reading `code` off the value is both cheaper and correct either way.
    // Getting this wrong turns "the pattern backtracks" into an unexplained failure, which is
    // exactly the diagnosis the timeout exists to produce.
    if (timedOut(error)) return { kind: 'too-slow', afterMs: Date.now() - started };
    throw new PatternError(`matching /${pattern}/ failed: ${describe(error)}`);
  }

  if (matched === null) return { kind: 'no-match' };
  if (mode === 'match') return { kind: 'value', value: 1, matched };
  return numberFrom(matched.trim());
}

function timedOut(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code } = error as { code?: unknown };
  return code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || /timed out/i.test(describe(error));
}

/** Whatever the sandbox threw, as one line, without assuming it is an `Error`. */
function describe(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error;
    if (typeof message === 'string') return message;
  }
  if (typeof error === 'string') return error;
  if (typeof error === 'number' || typeof error === 'boolean') return String(error);
  // `JSON.stringify` is typed as always returning a string here, and for an object it does.
  return JSON.stringify(error);
}

function numberFrom(text: string): Extracted {
  if (text === '') return { kind: 'not-a-number', matched: text };
  const value = Number(text);
  // `Number('')` is 0 and `Number(' 12 ')` is 12, both of which would quietly turn a device
  // saying nothing useful into a reading. `Number.isFinite` also rejects Infinity and NaN.
  return Number.isFinite(value)
    ? { kind: 'value', value, matched: text }
    : { kind: 'not-a-number', matched: text };
}
