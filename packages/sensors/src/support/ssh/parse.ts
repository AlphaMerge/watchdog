/**
 * Reading what a Unix box says back (`T-08`).
 *
 * Pure, and separate from the sensor types, because this is the half worth testing exhaustively:
 * every one of these formats has a variant that parses *almost* right and yields a number that
 * is wrong rather than absent. `df` wraps long device names onto two lines unless you ask it not
 * to; `/proc/meminfo` is in kB and says so on every line; `uptime` puts commas in load averages
 * in some locales. A sensor that gets one of these subtly wrong reports a plausible figure
 * nobody questions, which is worse than one that fails.
 */

/** A `key:value` reading a script produced. */
export interface ScriptReading {
  readonly key: string;
  readonly value: number;
}

export interface ScriptOutput {
  readonly readings: readonly ScriptReading[];
  readonly message: string;
  /** Lines that were not a reading and not the message. Reported, never silently dropped. */
  readonly ignored: number;
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/**
 * The output format an `ssh.script` sensor expects.
 *
 * **Line-oriented first, because the author is usually writing shell.** `echo "queue:12"` is one
 * line of a script; emitting JSON from shell means quoting and escaping, and a script that gets
 * that wrong fails in a way its author cannot see by running it. Three shapes are accepted and
 * they are in the order somebody meets them:
 *
 * ```
 *   41.5                       a bare number — one reading, the channel called "value"
 *
 *   temperature:41.5           one reading per line, "message:" reserved for the text
 *   queue:12
 *   message:all good
 *
 *   {"channels":{"temperature":41.5},"message":"all good"}      for an author who prefers it
 * ```
 *
 * `=` works wherever `:` does, because half the world writes `key=value` and being strict about
 * which would be a rule with no purpose behind it.
 */
export function parseScriptOutput(text: string): ScriptOutput {
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new ParseError('the script produced no output at all');
  }

  if (trimmed.startsWith('{')) return parseJsonOutput(trimmed);

  const lines = trimmed.split(/\r?\n/);
  const readings: ScriptReading[] = [];
  let message = '';
  let ignored = 0;

  for (const line of lines) {
    const entry = line.trim();
    if (entry === '') continue;

    const separator = entry.search(/[:=]/);
    if (separator < 0) {
      // A bare number is the single-reading shorthand, and only on a line of its own.
      const bare = Number(entry);
      if (readings.length === 0 && Number.isFinite(bare)) {
        readings.push({ key: 'value', value: bare });
        continue;
      }
      ignored += 1;
      continue;
    }

    const key = entry.slice(0, separator).trim();
    const rest = entry.slice(separator + 1).trim();
    if (key.toLowerCase() === 'message') {
      message = rest;
      continue;
    }
    if (key === '') {
      ignored += 1;
      continue;
    }

    const value = Number(rest);
    if (!Number.isFinite(value)) {
      // Not silently skipped: a channel whose value stopped being a number is the shape of a
      // script that started printing an error where it used to print a figure.
      throw new ParseError(
        `the script reported "${key}" as "${clip(rest)}", which is not a number — a channel ` +
          'holds a number, and text belongs in the message line',
      );
    }
    readings.push({ key, value });
  }

  if (readings.length === 0) {
    throw new ParseError(
      `the script produced no readings; its output was "${clip(trimmed)}". A reading is a line ` +
        'like "queue:12", or a bare number on its own',
    );
  }
  return { readings, message, ignored };
}

function parseJsonOutput(text: string): ScriptOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ParseError(
      `the script’s output starts with "{" but is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ParseError('the script’s JSON output is not an object');
  }

  const record = parsed as Record<string, unknown>;
  const channels = record['channels'];
  if (typeof channels !== 'object' || channels === null || Array.isArray(channels)) {
    throw new ParseError('the script’s JSON output has no "channels" object');
  }

  const readings: ScriptReading[] = [];
  let ignored = 0;
  for (const [key, raw] of Object.entries(channels as Record<string, unknown>)) {
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value)) {
      ignored += 1;
      continue;
    }
    readings.push({ key, value });
  }
  if (readings.length === 0) {
    throw new ParseError('the script’s JSON output has no numeric channels');
  }

  const message = record['message'];
  return { readings, message: typeof message === 'string' ? message : '', ignored };
}

export interface DiskUsage {
  readonly filesystem: string;
  readonly mountedOn: string;
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly freeBytes: number;
}

/**
 * One line of `df -P -k`.
 *
 * **`-P` is not optional and is the reason this is a shared function rather than a split().**
 * Without it `df` wraps a long device name onto its own line, so the columns an obvious parser
 * reads are the *previous* filesystem's. POSIX mode guarantees one line per filesystem and six
 * fields. `-k` fixes the block size at 1024, because `df` otherwise honours `BLOCKSIZE` and
 * `DF_BLOCK_SIZE` from the environment and a login shell may well set them.
 *
 * The capacity column is ignored and the percentage recomputed: `df` rounds it up to a whole
 * number, so a 40.4% full volume reads as 41% — fine for a person, wrong for a threshold that
 * somebody set at 41.
 */
export function parseDf(output: string): DiskUsage[] {
  const lines = output.trim().split(/\r?\n/);
  const rows: DiskUsage[] = [];

  for (const line of lines) {
    const entry = line.trim();
    if (entry === '') continue;
    // The header, whatever `df` called its columns in this locale.
    if (/^filesystem\b/i.test(entry)) continue;

    const fields = entry.split(/\s+/);
    if (fields.length < 6) continue;

    // The mount point is the last field and may contain spaces; everything before it is fixed.
    const [filesystem, blocks, used, available] = fields;
    const mountedOn = fields.slice(5).join(' ');
    const totalBlocks = Number(blocks);
    const usedBlocks = Number(used);
    const freeBlocks = Number(available);
    if (
      filesystem === undefined ||
      !Number.isFinite(totalBlocks) ||
      !Number.isFinite(usedBlocks) ||
      !Number.isFinite(freeBlocks)
    ) {
      continue;
    }

    rows.push({
      filesystem,
      mountedOn,
      totalBytes: totalBlocks * 1024,
      usedBytes: usedBlocks * 1024,
      freeBytes: freeBlocks * 1024,
    });
  }
  return rows;
}

export interface LoadAverage {
  readonly one: number;
  readonly five: number;
  readonly fifteen: number;
}

/**
 * `/proc/loadavg`, or the tail of `uptime` on a system without it.
 *
 * Both are handled because `/proc/loadavg` is Linux only and the same sensor is worth pointing
 * at a BSD or a macOS host. `uptime` is the fallback rather than the default: its output is
 * prose, it is localised, and some locales separate the three figures with commas *and* use a
 * comma as the decimal point, which is why the numbers are pulled out by a pattern that requires
 * a dot rather than by splitting on commas.
 */
export function parseLoadAverage(output: string): LoadAverage | null {
  const text = output.trim();
  if (text === '') return null;

  // `/proc/loadavg`: "0.08 0.09 0.25 1/234 5678" — three floats at the very start.
  const proc = /^(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)/.exec(text);
  if (proc !== null) {
    return { one: Number(proc[1]), five: Number(proc[2]), fifteen: Number(proc[3]) };
  }

  // `uptime`: "… load average: 0.08, 0.09, 0.25" — and "load averages:" on BSD and macOS.
  const uptime = /load averages?:\s*(\d+[.,]\d+)[,\s]+(\d+[.,]\d+)[,\s]+(\d+[.,]\d+)/i.exec(text);
  if (uptime !== null) {
    const decimal = (value: string): number => Number(value.replace(',', '.'));
    return {
      one: decimal(uptime[1] ?? ''),
      five: decimal(uptime[2] ?? ''),
      fifteen: decimal(uptime[3] ?? ''),
    };
  }
  return null;
}

/**
 * `/proc/meminfo`, as bytes. In `@ms/shared` since `P-208`, because Probe Health and Core Health
 * read the local machine's copy with the same parser this reads a remote one's with.
 */
export { parseMeminfo } from '@ms/shared';

/** Device output can be long; a sensor message and an error are read by a person. */
export function clip(text: string, limit = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}
