import type { ChannelReading, CheckResult } from './messages.js';

/**
 * The bounds the wire schema puts on one check result (`P-277`), here so that the schema and
 * `fitResult` read the same numbers and cannot drift apart.
 */
export const RESULT_LIMITS = {
  /** Characters of a result's message. */
  message: 2000,
  /** Channels in one result. */
  channels: 500,
  /** Characters of a channel's key. At least one. */
  key: 100,
  /** Characters of a channel's display name. At least one. */
  name: 200,
  /** Characters of a channel's unit. */
  unit: 50,
} as const;

/** `ChannelReading.counter`: decimal text, as the schema has it. */
const COUNTER = /^[0-9]{1,20}$/;

const ELLIPSIS = '…';

export interface FittedResult {
  readonly result: CheckResult;
  /**
   * What was taken out of the readings to fit: a channel dropped, or a field of one left off.
   * Empty when the readings were sent as they were. A message clipped or a NUL removed is not
   * listed: the message says the first itself, with its ellipsis, and the second loses nothing.
   */
  readonly problems: readonly string[];
}

/**
 * One check result, made to fit the wire schema and the database before it leaves the runner
 * that settled it (`P-277`).
 *
 * **One result that does not fit costs every sensor on the probe.** The core validates a
 * `results` batch as a whole, and a batch that fails is a protocol violation: the core closes the
 * connection, the probe reconnects and offers the same batch from its spool, and is closed on
 * again, for ever. A result that fits the schema but holds U+0000 fails differently and as
 * completely: PostgreSQL text cannot hold it (`22021`), the write fails, the core asks for the
 * batch again, and it fails again. What a result holds comes from a sensor's words, a device's
 * and a script's — a script's JSON names its own channels and writes its own message — so none
 * of it is assumed to fit.
 *
 * **What is changed, and why that much and no more.** The message loses its NULs and is clipped
 * to `RESULT_LIMITS.message`, ending in an ellipsis. A channel whose key or value cannot be sent
 * is dropped, which leaves a gap and never a made-up number, and a key is never clipped, since a
 * clipped key would be another channel. A counter or a width the schema refuses is left off,
 * which leaves the value. A name or unit is clipped, and a name left empty is left off. The
 * channels past `RESULT_LIMITS.channels` are dropped. A `durationMs` that is not a finite number
 * of zero or more is 0. Fields the schema does not know are not copied.
 */
export function fitResult(result: CheckResult): FittedResult {
  const problems: string[] = [];
  const channels: ChannelReading[] = [];
  const given: readonly unknown[] = Array.isArray(result.channels) ? result.channels : [];
  if (given.length > RESULT_LIMITS.channels) {
    problems.push(
      `${String(given.length - RESULT_LIMITS.channels)} channels past the first ` +
        `${String(RESULT_LIMITS.channels)} were dropped`,
    );
  }
  for (const [at, raw] of given.slice(0, RESULT_LIMITS.channels).entries()) {
    const fitted = fitChannel(raw, at, problems);
    if (fitted !== null) channels.push(fitted);
  }
  const duration: unknown = result.durationMs;
  const message: unknown = result.message;
  return {
    result: {
      sensorId: result.sensorId,
      at: result.at,
      outcome: result.outcome,
      message: typeof message === 'string' ? clip(withoutNul(message), RESULT_LIMITS.message) : '',
      durationMs:
        typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : 0,
      channels,
      ...(result.withheld === true ? { withheld: true as const } : {}),
    },
    problems,
  };
}

function fitChannel(raw: unknown, at: number, problems: string[]): ChannelReading | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push(`channel ${String(at)} is not an object and was dropped`);
    return null;
  }
  const channel = raw as Record<string, unknown>;
  const key = channel['key'];
  if (typeof key !== 'string' || !fitsKey(key)) {
    problems.push(
      `channel ${String(at)}'s key is not 1 to ${String(RESULT_LIMITS.key)} characters ` +
        'without a NUL, and the channel was dropped',
    );
    return null;
  }
  const value = channel['value'];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push(`channel "${key}" has no finite number for a value and was dropped`);
    return null;
  }
  const fitted: ChannelReading = { key, value };
  const counter = channel['counter'];
  if (counter !== undefined) {
    if (typeof counter === 'string' && COUNTER.test(counter)) fitted.counter = counter;
    else problems.push(`channel "${key}"'s counter is not decimal text and was left off`);
  }
  const bits = channel['counterBits'];
  if (bits !== undefined) {
    if (bits === 32 || bits === 64) fitted.counterBits = bits;
    else problems.push(`channel "${key}"'s counter width is not 32 or 64 and was left off`);
  }
  const name = channel['name'];
  if (typeof name === 'string') {
    const clipped = clip(withoutNul(name), RESULT_LIMITS.name);
    if (clipped !== '') fitted.name = clipped;
  }
  const unit = channel['unit'];
  if (typeof unit === 'string') fitted.unit = clip(withoutNul(unit), RESULT_LIMITS.unit);
  return fitted;
}

/** A key the schema takes: 1 to `RESULT_LIMITS.key` characters, counted as Ajv counts them. */
function fitsKey(key: string): boolean {
  if (key === '' || key.includes('\u0000')) return false;
  // Ajv counts code points; a key no longer than the limit in UTF-16 units is short enough.
  return key.length <= RESULT_LIMITS.key || Array.from(key).length <= RESULT_LIMITS.key;
}

function withoutNul(text: string): string {
  return text.includes('\u0000') ? text.replaceAll('\u0000', '') : text;
}

/**
 * At most `limit` characters, the last an ellipsis when anything was cut. Counted in UTF-16
 * units, so never more code points than the schema allows, and never ending in half a pair.
 */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit - ELLIPSIS.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end) + ELLIPSIS;
}
