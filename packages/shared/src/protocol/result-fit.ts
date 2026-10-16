import type { ChannelReading, CheckFailure, CheckResult } from './messages.js';

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

/**
 * `CheckFailure.phase` (`P-285`): a word, as a transport or the runner names a phase — `connect`,
 * `host-key`, `getBulk`, `worker-crash`. Open, so a new transport needs no protocol bump; bounded,
 * so it cannot carry a sentence.
 */
export const FAILURE_PHASE = /^[a-z][a-zA-Z0-9-]{0,31}$/;

/**
 * `CheckFailure.target` (`P-285`): a plain host — a name, an IPv4 or IPv6 address (bracketed or
 * not, with a zone), either with a port. **Listed, not excluded**: a target is taken from an
 * error, and the characters a URL puts a user, a password or a token behind (`@`, `/`, `?`, `#`,
 * `=`) are none of these, so what passes cannot carry a credential. A name outside ASCII is left
 * off with the rest; the device's host still says it.
 */
export const FAILURE_TARGET = /^[A-Za-z0-9._:%[\]-]{1,255}$/;

/** `ChannelReading.counter`: decimal text, as the schema has it. */
const COUNTER = /^[0-9]{1,20}$/;

const ELLIPSIS = '…';

export interface FittedResult {
  readonly result: CheckResult;
  /**
   * What was taken out of the readings to fit: a channel dropped, or a field of one left off.
   * Empty when the readings were sent as they were. A message clipped or a NUL removed is not
   * listed: the message says the first itself, with its ellipsis, and the second loses nothing.
   * A channel dropped is also said in the message, by count (`P-292`).
   */
  readonly problems: readonly string[];
  /**
   * How many of the given channels were dropped: not an object, a key or a value that cannot be
   * sent, or past `RESULT_LIMITS.channels` (`P-283`). Each is a reading that exists nowhere, and
   * this is what Probe Health counts. A counter or a width left off is not among them: the value
   * was sent.
   */
  readonly dropped: number;
}

/**
 * One check result, made to fit the wire schema and the database before it leaves the runner
 * that settled it (`P-277`).
 *
 * **One result that did not fit cost every sensor on the probe.** The core validated a
 * `results` batch as a whole, and a batch that failed was a protocol violation: the core closed
 * the connection, the probe reconnected and offered the same batch from its spool, and was closed
 * on again, for ever. A result that fits the schema but holds U+0000 failed differently and as
 * completely: PostgreSQL text cannot hold it (`22021`), the write failed, the core asked for the
 * batch again, and it failed again. What a result holds comes from a sensor's words, a device's
 * and a script's — a script's JSON names its own channels and writes its own message — so none
 * of it is assumed to fit.
 *
 * **The core runs this too, on every result it receives** (`P-281`, `parseProbeToCore`), so a
 * peer that does not fit its results (a probe built before `P-277`) loses only what this drops,
 * and a result this cannot mend is refused alone. The probe still fits before it spools: what it
 * sends is then what is stored, and it is the probe that logs what was dropped, by sensor.
 *
 * **What is changed, and why that much and no more.** The message, a name and a unit lose their
 * NULs and have each lone surrogate replaced by U+FFFD, as PostgreSQL would store it; the message
 * is clipped to `RESULT_LIMITS.message`, ending in an ellipsis. A channel whose key or value
 * cannot be sent is dropped, which leaves a gap and never a made-up number, and a key is never
 * clipped or replaced, since either would make it another channel; a key with a NUL or a lone
 * surrogate is dropped. A counter or a width the schema refuses is left off,
 * which leaves the value. A name or unit is clipped, and a name left empty is left off. The
 * channels past `RESULT_LIMITS.channels` are dropped. When any channel is dropped, the message
 * ends by saying how many (`withDropped`, `P-292`). A `durationMs` that is not a finite number
 * of zero or more is 0. A `failure` is kept on a failed check only, bounded by `fitFailure`
 * (`P-285`). Fields the schema does not know are not copied.
 */
export function fitResult(result: CheckResult): FittedResult {
  const problems: string[] = [];
  const channels: ChannelReading[] = [];
  const given: readonly unknown[] = Array.isArray(result.channels) ? result.channels : [];
  const kept = given.slice(0, RESULT_LIMITS.channels);
  if (given.length > RESULT_LIMITS.channels) {
    problems.push(
      `${String(given.length - RESULT_LIMITS.channels)} channels past the first ` +
        `${String(RESULT_LIMITS.channels)} were dropped`,
    );
  }
  for (const [at, raw] of kept.entries()) {
    const fitted = fitChannel(raw, at, problems);
    if (fitted !== null) channels.push(fitted);
  }
  const duration: unknown = result.durationMs;
  const message: unknown = result.message;
  const dropped = given.length - channels.length;
  return {
    result: {
      sensorId: result.sensorId,
      at: result.at,
      outcome: result.outcome,
      message: withDropped(typeof message === 'string' ? textOf(message) : '', dropped),
      durationMs:
        typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : 0,
      channels,
      ...(result.withheld === true ? { withheld: true as const } : {}),
      ...(result.notStarted === true ? { notStarted: true as const } : {}),
      ...failureFor(result),
    },
    problems,
    dropped,
  };
}

/**
 * Where a check failed, bounded for the wire (`P-285`): a `phase` that is a word, and a `target`
 * that is a plain host, or `null` when there is no phase to say. A target that is not plain is
 * left off and the phase kept; nothing is clipped or replaced, since either would name another
 * phase or another host. What every runner sends and what the core keeps, so a probe built with
 * looser rules loses only what this drops.
 */
export function fitFailure(raw: unknown): CheckFailure | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const failure = raw as Record<string, unknown>;
  const phase = failure['phase'];
  if (typeof phase !== 'string' || !FAILURE_PHASE.test(phase)) return null;
  const target = failure['target'];
  return typeof target === 'string' && FAILURE_TARGET.test(target) ? { phase, target } : { phase };
}

/** `failure`, fitted, on a failed check only: what the schema's rule takes and nothing else. */
function failureFor(result: CheckResult): { failure?: CheckFailure } {
  if (result.outcome !== 'error' || result.failure === undefined) return {};
  const failure = fitFailure(result.failure);
  return failure === null ? {} : { failure };
}

/**
 * The check's message, clipped to leave room for what was dropped from its readings, and then
 * that (`P-292`): "2/2 replies (3 channels could not be sent)".
 *
 * **Said in the sensor's own message**, because that is where the person looking at the sensor
 * looks. Probe Health counts the channels and the log names them (`P-283`), but neither is on
 * the sensor, whose readings simply stop with nothing to say why. The note always survives the
 * clip: it is what the message would otherwise not say, and the check's own words end in the
 * ellipsis instead.
 *
 * **The message only, never the state.** A Warning would change alarm volume, and the cause is
 * one sensor's own output, mostly a script's JSON, which a state change does not fix.
 *
 * **Counted, not named**: the problems name each channel, and they go to the log, which has room.
 * Fitting what this returned drops nothing more, so it adds nothing more: a probe's drain fits
 * the spooled result again on every retry, and the core fits a result its schema refused, and
 * the note is said once either way. A limit's or a lookup's message replaces the check's on the
 * core (`StateService`), and this note with it: the sensor then says why it is in its state.
 */
function withDropped(message: string, dropped: number): string {
  if (dropped === 0) return clip(message, RESULT_LIMITS.message);
  const said = `${String(dropped)} ${dropped === 1 ? 'channel' : 'channels'} could not be sent`;
  if (message === '') return said;
  const note = ` (${said})`;
  return clip(message, RESULT_LIMITS.message - note.length) + note;
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
        'of well-formed text without a NUL, and the channel was dropped',
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
    const clipped = clip(textOf(name), RESULT_LIMITS.name);
    if (clipped !== '') fitted.name = clipped;
  }
  const unit = channel['unit'];
  if (typeof unit === 'string') fitted.unit = clip(textOf(unit), RESULT_LIMITS.unit);
  return fitted;
}

/** A key the schema takes: 1 to `RESULT_LIMITS.key` characters, counted as Ajv counts them. */
function fitsKey(key: string): boolean {
  if (key === '' || key.includes('\u0000')) return false;
  // **Well formed, or dropped** (`P-277` review). A lone surrogate survives JSON, and `pg` then
  // encodes it as U+FFFD: the channel was created under the replaced key and looked up under
  // the sent one, which never matched, so every reading was dropped as a sensor that no longer
  // exists and the channel was created again on every batch.
  if (LONE_SURROGATE.test(key)) return false;
  // Ajv counts code points; a key no longer than the limit in UTF-16 units is short enough.
  return key.length <= RESULT_LIMITS.key || Array.from(key).length <= RESULT_LIMITS.key;
}

/** A surrogate half without its other half. Code units, so no `u` flag. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * A channel's display name or unit as a `channel` row can hold it (`P-402`, `P-405`): what
 * `fitResult` makes of a reading's, for one the core takes from a type's declaration instead.
 * Nothing checks a declaration against the column — `http.transaction` names a step with no name
 * by its path, which may be 2,048 characters — and a row that broke the column's CHECK refused
 * the write that made it. **Counted in code points**, as the column's `length()` and the wire
 * schema's `maxLength` count them, where `clip` counts UTF-16 units to keep a result inside the
 * wire's limits however it is cut: every writer of a declaration fits it here, so counting as the
 * column does is what makes them write the same. Empty when nothing is left; the caller decides
 * what stands in.
 */
export function fitLabel(text: string, limit: number): string {
  const whole = textOf(text);
  // No more UTF-16 units than the limit is no more code points: the common case, with no array.
  if (whole.length <= limit) return whole;
  // `textOf` leaves no lone surrogate, so no code point here is half a pair.
  const points = Array.from(whole);
  return points.length <= limit
    ? whole
    : points.slice(0, limit - ELLIPSIS.length).join('') + ELLIPSIS;
}

/**
 * Text as PostgreSQL will store it and give it back: no NUL, which it refuses, and every lone
 * surrogate replaced by U+FFFD, which is what `pg`'s encoding would have made of it anyway, so
 * what is sent is what is stored. `String.prototype.toWellFormed`, which the `ES2023` lib this
 * build targets does not type.
 */
function textOf(text: string): string {
  const withoutNul = text.includes('\u0000') ? text.replaceAll('\u0000', '') : text;
  return LONE_SURROGATE.test(withoutNul)
    ? withoutNul.replace(new RegExp(LONE_SURROGATE.source, 'g'), '\uFFFD')
    : withoutNul;
}

/**
 * At most `limit` characters, the last an ellipsis when anything was cut. Counted in UTF-16
 * units, so never more code points than the schema allows, and never ending in half a pair.
 *
 * Exported (as `clipText` from the package) for a type that leaves room in its message for a note
 * of its own (`P-359`), so that its cut cannot leave the lone surrogate `textOf` would store as
 * U+FFFD.
 */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit - ELLIPSIS.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end) + ELLIPSIS;
}
