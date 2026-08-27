import { ScriptError } from './resolve.js';
// A top-level import, and it stays lazy where it matters: nothing loads this module except
// `exe.script*`'s `execute`, which is itself an `await import`. A probe running no script sensors
// never reaches `fast-xml-parser`.
import { parseXml } from '../xml.js';

/**
 * What a program's output means (`T-19`).
 *
 * **Pure, and separate from running anything**, because this is where the compatibility lives:
 * an installation moving from PRTG has scripts that already emit a particular shape, and a parser
 * that half-understood one of them would report a number that is wrong rather than a check that
 * failed. Every format here is exercised against real output in the tests.
 */

export type ScriptFormat = 'prtg' | 'number' | 'json';

export interface ScriptChannel {
  readonly key: string;
  readonly value: number;
  readonly name?: string;
  readonly unit?: string;
}

export interface ScriptOutput {
  readonly channels: readonly ScriptChannel[];
  readonly message: string;
  /**
   * The status a PRTG-format script asked for, when it asked for one.
   *
   * Kept even though this system cannot honour all of it — see `describeReturnCode`. Reporting
   * "the script said 1 (Warning)" is worth more than dropping the distinction silently.
   */
  readonly returnCode: number | null;
}

/**
 * PRTG's `returncode:value:message`, and what each code means.
 *
 * **This system has no way for a *check* to report Warning, and that is deliberate rather than
 * missing.** Warning here comes from a limit on a channel (`M-04`), evaluated by the core against
 * a reading, so it is visible, editable and inheritable — where a Warning baked into a script is
 * a threshold nobody can see or change without editing the script on every probe. So a non-zero
 * code fails the check and the message names what the script meant by it.
 */
const RETURN_CODES: Readonly<Record<number, string>> = {
  0: 'OK',
  1: 'Warning',
  2: 'System Error',
  3: 'Protocol Error',
  4: 'Content Error',
};

export function describeReturnCode(code: number): string {
  return RETURN_CODES[code] ?? 'an unrecognised status';
}

const MAX_CHANNELS = 50;

/**
 * One value and a message, from whichever format the operator said their program speaks.
 *
 * `key` is the channel the value lands on, which the caller owns: the simple sensor calls it
 * `value` and the advanced one uses whatever the operator named as primary.
 */
export function parseSimple(stdout: string, format: ScriptFormat, key: string): ScriptOutput {
  const text = stdout.trim();
  if (text === '') {
    throw new ScriptError(
      'the program printed nothing on stdout — a check needs a reading, and a program that ' +
        'succeeded silently has not produced one',
    );
  }

  if (format === 'number') {
    const value = Number(text);
    if (!Number.isFinite(value)) {
      throw new ScriptError(
        `this sensor expects a plain number and the program printed ${quote(text)}`,
      );
    }
    return { channels: [{ key, value }], message: '', returnCode: null };
  }

  if (format === 'json') {
    const parsed = parseJson(text, key);
    return parsed;
  }

  // PRTG: `returncode:value:message`, on the first line. The message may itself contain colons,
  // so it is everything after the second one rather than the third field of a split.
  const line = text.split('\n')[0] ?? '';
  const first = line.indexOf(':');
  const second = first < 0 ? -1 : line.indexOf(':', first + 1);
  if (first < 0 || second < 0) {
    throw new ScriptError(
      `this sensor expects returncode:value:message and the program printed ${quote(line)} — ` +
        'set the output format to "number" if it prints only a reading',
    );
  }

  const returnCode = Number(line.slice(0, first).trim());
  if (!Number.isInteger(returnCode)) {
    throw new ScriptError(`${quote(line.slice(0, first))} is not a return code`);
  }
  const raw = line.slice(first + 1, second).trim();
  const value = Number(raw);
  const message = line.slice(second + 1).trim();

  if (returnCode !== 0) {
    throw new ScriptError(
      `the program reported ${String(returnCode)} (${describeReturnCode(returnCode)})` +
        (message === '' ? '' : `: ${message}`),
    );
  }
  if (!Number.isFinite(value)) {
    throw new ScriptError(
      `the program reported success with ${quote(raw)} as its value, which is not a number`,
    );
  }
  return { channels: [{ key, value }], message, returnCode };
}

/**
 * Several channels, from JSON.
 *
 * **Two shapes, because one of them is not ours.** `{"channels":[…]}` is this system's, and
 * `{"prtg":{"result":[…]}}` is what an installation's existing advanced scripts already emit.
 * Accepting both costs twenty lines and saves rewriting every script somebody has.
 *
 * **XML too, since `T-24`** — and it matters more here than it does for REST, because PRTG's
 * advanced EXE sensors emit XML *by default*. An installation moving across has scripts printing
 * `<prtg><result><channel>…` and no reason to rewrite them. Which one it is comes from the first
 * character rather than from a setting: asking an operator to describe their own script's output
 * to a form is asking them to get it wrong once.
 */
export function parseAdvanced(stdout: string, primaryKey: string): ScriptOutput {
  const text = stdout.trim();
  if (text === '') {
    throw new ScriptError('the program printed nothing on stdout');
  }
  if (text.startsWith('<')) return parsePrtgXml(text, primaryKey);
  return parseJson(text, primaryKey);
}

/**
 * PRTG's advanced XML, which is what its EXE/Script Advanced sensors print by default.
 *
 * The same document its JSON form describes — `<prtg>` with a `<result>` per channel, each
 * carrying `<channel>`, `<value>` and optionally `<unit>` — so it goes through the same
 * `channelsFrom` and produces the same keys. `<error>1</error>` with `<text>` is how such a
 * script reports a failure, and it fails the check rather than becoming a reading.
 */
function parsePrtgXml(text: string, primaryKey: string): ScriptOutput {
  const tree = parseXml(text);
  const root = firstOf(tree['prtg']);
  if (!isRecord(root)) {
    throw new ScriptError(
      'the program printed XML with no <prtg> element — that is the shape an advanced script ' +
        'returns, and the whole document was ' +
        quote(text.slice(0, 200)),
    );
  }

  const error = asText(firstOf(root['error']));
  if (error === '1' || error.toLowerCase() === 'true') {
    throw new ScriptError(
      `the program reported an error: ${asText(firstOf(root['text'])) || 'it gave no reason'}`,
    );
  }

  const results = Array.isArray(root['result']) ? (root['result'] as unknown[]) : [];
  const flattened = results.map((entry) => {
    if (!isRecord(entry)) return entry;
    // `<channel>`, `<value>` and `<unit>` are each a one-element array in the tree, and
    // `channelsFrom` reads plain fields — so they are unwrapped here rather than teaching it
    // about XML.
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) out[key] = textOf(value);
    return out;
  });

  return {
    channels: channelsFrom(flattened, primaryKey),
    message: asText(firstOf(root['text'])),
    returnCode: null,
  };
}

/** The first item of what the XML tree made an array, or the value itself. */
function firstOf(value: unknown): unknown {
  return Array.isArray(value) ? (value as unknown[])[0] : value;
}

/** An element's string value: its text, past any attributes it carries. */
function textOf(value: unknown): unknown {
  const one = firstOf(value);
  return isRecord(one) && '#text' in one ? one['#text'] : one;
}

/**
 * Several channels, from JSON — both shapes.
 */
function parseJson(text: string, primaryKey: string): ScriptOutput {
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ScriptError(
      'the program did not print JSON: ' +
        (error instanceof Error ? error.message : String(error)) +
        ` — it printed ${quote(text.slice(0, 120))}`,
    );
  }
  if (!isRecord(document)) {
    throw new ScriptError('the program printed JSON that is not an object');
  }

  // PRTG's own shape, so an existing advanced script works unchanged.
  const prtg = document['prtg'];
  if (isRecord(prtg)) {
    const error = prtg['error'];
    if (error === 1 || error === '1' || error === true) {
      throw new ScriptError(
        `the program reported an error: ${asText(prtg['text']) || 'it gave no reason'}`,
      );
    }
    return {
      channels: channelsFrom(prtg['result'], primaryKey),
      message: asText(prtg['text']),
      returnCode: null,
    };
  }

  if (Array.isArray(document['channels'])) {
    return {
      channels: channelsFrom(document['channels'], primaryKey),
      message: asText(document['message']),
      returnCode: null,
    };
  }

  // The simple shape: one value and a message.
  const value = numberFrom(document['value']);
  if (value === null) {
    throw new ScriptError(
      'the JSON has no "value", no "channels" and no "prtg" — one of those is what this sensor ' +
        'reads, and the whole document was ' +
        quote(text.slice(0, 200)),
    );
  }
  return {
    channels: [{ key: primaryKey, value }],
    message: asText(document['message']),
    returnCode: null,
  };
}

function channelsFrom(raw: unknown, primaryKey: string): ScriptChannel[] {
  if (!Array.isArray(raw)) {
    throw new ScriptError('the channel list is not an array');
  }
  if (raw.length === 0) {
    throw new ScriptError(
      'the program returned no channels — a check with nothing to report is a failed check, ' +
        'not a reading of none',
    );
  }
  const out: ScriptChannel[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, MAX_CHANNELS)) {
    if (!isRecord(entry)) continue;
    // `channel` is PRTG's word for it and doubles as the display name there; `key` is ours.
    const name = asText(entry['name']) || asText(entry['channel']);
    const key = asText(entry['key']) || keyOf(name);
    if (key === '' || seen.has(key)) continue;
    const value = numberFrom(entry['value']);
    if (value === null) continue;
    seen.add(key);
    out.push({
      key,
      value,
      ...(name === '' ? {} : { name }),
      ...(asText(entry['unit']) === '' ? {} : { unit: asText(entry['unit']) }),
    });
  }
  if (out.length === 0) {
    throw new ScriptError('none of the channels the program returned had a numeric value');
  }
  // The primary must be present or the sensor has no channel to be judged by, and a silently
  // absent primary is a sensor that looks healthy while reporting nothing anybody watches.
  if (!out.some((channel) => channel.key === primaryKey)) {
    throw new ScriptError(
      `the program returned no channel called "${primaryKey}", which is the one this sensor is ` +
        `judged by — it returned ${out.map((channel) => channel.key).join(', ')}`,
    );
  }
  return out;
}

/**
 * A channel key from a display name.
 *
 * Stable across scans, because a key is what history is stored under: "Free Space" and "free
 * space" must not become two channels on a script whose author changed the capitalisation.
 */
export function keyOf(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function numberFrom(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    // PRTG's own examples quote their values, and a comma decimal separator is what a script
    // written on a German-locale machine prints.
    const parsed = Number(
      trimmed.includes(',') && !trimmed.includes('.') ? trimmed.replace(',', '.') : trimmed,
    );
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const quote = (text: string): string => `"${text.replace(/\n/g, '\\n')}"`;
