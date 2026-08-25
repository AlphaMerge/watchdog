import { createHash } from 'node:crypto';
import {
  open,
  readdir,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckResult, Logger } from '@ms/shared';

/**
 * The probe's disk-backed result spool (R-02).
 *
 * PRTG buffers up to 500,000 results *in RAM* and loses them when the probe restarts. Spooling
 * to disk is the whole point of this file, and the properties that make it worth having are:
 * bounded size, oldest-first eviction, a count of everything dropped, and surviving a restart.
 *
 * **Newline-delimited JSON, in segments.** Not a binary format with length prefixes and
 * checksums: results are already JSON on the wire, a torn line is detectable without a checksum
 * because it does not parse, and a spool an operator can read with `tail` during an incident is
 * worth more than the bytes a binary encoding would save. Segments are what make eviction and
 * reclamation O(1) — delete a file, rather than rewrite one.
 *
 * **What a crash costs.** Appends are not fsynced per record: at five thousand checks a minute
 * that would dominate the probe's cost, and the failure it protects against — a power cut in the
 * millisecond between write and flush — loses at most the last few results. A *process* restart,
 * which is the case PRTG loses everything to, loses nothing: the data is already in the page
 * cache and the file. `open()` truncates a torn trailing line so the next append starts on a
 * clean boundary, which is what stops one bad crash from corrupting every later read.
 */
export interface SpoolOptions {
  dir: string;
  /** Total bytes across all segments. Oldest segments are evicted to stay under it. */
  maxBytes: number;
  /** Roll to a new segment past this size. Smaller means finer-grained eviction. */
  segmentMaxBytes?: number;
  logger: Logger;
}

export interface SpoolStats {
  /** Results written but not yet acknowledged by the core. */
  pending: number;
  bytes: number;
  segments: number;
  /** Evicted to stay inside `maxBytes`. The number that must never be a surprise. */
  dropped: number;
  /** Lines that did not parse — a torn write at a crash boundary. */
  corrupt: number;
}

const SEGMENT_SUFFIX = '.ndjson';
const CURSOR_FILE = 'cursor.json';
const DEFAULT_SEGMENT_BYTES = 8 * 1024 * 1024;

interface Segment {
  name: string;
  path: string;
  bytes: number;
  /** Records still ahead of the cursor in this segment. */
  pending: number;
}

interface Cursor {
  /** Segment the next unacknowledged record is in, or null when the spool is empty. */
  segment: string | null;
  /** Byte offset of the next unacknowledged record within that segment. */
  offset: number;
}

export class ResultSpool {
  readonly #dir: string;
  readonly #maxBytes: number;
  readonly #segmentMaxBytes: number;
  readonly #logger: Logger;

  #segments: Segment[] = [];
  #handle: FileHandle | undefined;
  #cursor: Cursor = { segment: null, offset: 0 };
  #dropped = 0;
  #corrupt = 0;
  /** How many records the last `peek` returned, so `commit` knows what it is confirming. */
  #peeked: { records: number; segment: string; offset: number } | undefined;
  /**
   * Appends run one at a time.
   *
   * The pool reports results from several workers and its callback is synchronous, so without
   * this two `write` calls could interleave and produce a line that is half of each. Serialising
   * here rather than at every call site means a caller cannot forget.
   */
  #writing: Promise<void> = Promise.resolve();

  private constructor(options: SpoolOptions) {
    this.#dir = options.dir;
    this.#maxBytes = options.maxBytes;
    this.#segmentMaxBytes = options.segmentMaxBytes ?? DEFAULT_SEGMENT_BYTES;
    this.#logger = options.logger.child({ component: 'spool' });
  }

  static async open(options: SpoolOptions): Promise<ResultSpool> {
    const spool = new ResultSpool(options);
    await spool.#load();
    return spool;
  }

  stats(): SpoolStats {
    return {
      pending: this.#segments.reduce((sum, segment) => sum + segment.pending, 0),
      bytes: this.#segments.reduce((sum, segment) => sum + segment.bytes, 0),
      segments: this.#segments.length,
      dropped: this.#dropped,
      corrupt: this.#corrupt,
    };
  }

  async append(results: readonly CheckResult[]): Promise<void> {
    if (results.length === 0) return;
    const queued = this.#writing.then(() => this.#appendNow(results));
    // Swallowed on the chain so one failed append cannot reject every later one; the caller
    // still sees its own error.
    this.#writing = queued.catch(() => undefined);
    return queued;
  }

  async #appendNow(results: readonly CheckResult[]): Promise<void> {
    const payload = Buffer.from(results.map((result) => JSON.stringify(result)).join('\n') + '\n');
    let active = this.#segments.at(-1);

    if (active === undefined || active.bytes + payload.byteLength > this.#segmentMaxBytes) {
      active = await this.#roll();
    }

    await this.#handle?.write(payload);
    active.bytes += payload.byteLength;
    active.pending += results.length;
    if (this.#cursor.segment === null) this.#cursor = { segment: active.name, offset: 0 };

    await this.#evict();
  }

  /**
   * The oldest unacknowledged results, without removing them.
   *
   * Nothing leaves the spool until the core has said it stored the batch: a lost acknowledgement
   * costs a duplicate write, which is free, while an optimistic delete costs the reading.
   */
  async peek(max: number): Promise<CheckResult[]> {
    if (this.#cursor.segment === null || max <= 0) return [];

    const results: CheckResult[] = [];
    // Where the *next* unread record starts. Kept as a pair rather than recomputed at the end:
    // running off the last segment must leave this at that segment's end, not reset it to the
    // beginning — which would make every commit re-read the batch it just confirmed.
    // `segment` is a string from here on: the early return above ruled out the empty spool, and
    // every reassignment below names a segment.
    let position: { segment: string; offset: number } = {
      segment: this.#cursor.segment,
      offset: this.#cursor.offset,
    };

    while (results.length < max) {
      const current = position.segment;
      const segment = this.#segments.find((candidate) => candidate.name === current);
      if (segment === undefined) break;

      const slice = (await readFile(segment.path)).subarray(position.offset);
      let consumed = 0;

      for (const line of splitLines(slice)) {
        if (results.length >= max) break;
        consumed += line.length + 1;
        const text = line.toString('utf8').trim();
        if (text === '') continue;
        try {
          results.push(JSON.parse(text) as CheckResult);
        } catch {
          // A torn line from a crash boundary. Counted rather than hidden, and skipped rather
          // than allowed to stop the whole spool from draining.
          this.#corrupt += 1;
        }
      }

      const offset = position.offset + consumed;
      const next = this.#segments[this.#segments.indexOf(segment) + 1];
      position =
        offset >= segment.bytes && next !== undefined
          ? { segment: next.name, offset: 0 }
          : { segment: current, offset };

      // Nothing more was readable here and there is nowhere else to go.
      if (consumed === 0) break;
    }

    this.#peeked = results.length === 0 ? undefined : { records: results.length, ...position };
    return results;
  }

  /** Confirms the last `peek`: those results are stored and their space can be reclaimed. */
  async commit(): Promise<void> {
    const peeked = this.#peeked;
    if (peeked === undefined) return;
    this.#peeked = undefined;

    let remaining = peeked.records;
    for (const segment of [...this.#segments]) {
      if (remaining <= 0) break;
      const taken = Math.min(segment.pending, remaining);
      segment.pending -= taken;
      remaining -= taken;
    }

    this.#cursor = { segment: peeked.segment, offset: peeked.offset };
    await this.#reclaim();
    await this.#saveCursor();
  }

  async close(): Promise<void> {
    await this.#handle?.close();
    this.#handle = undefined;
    await this.#saveCursor();
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────

  async #load(): Promise<void> {
    const names = (await readdir(this.#dir).catch(() => []))
      .filter((name) => name.endsWith(SEGMENT_SUFFIX))
      .sort();

    for (const name of names) {
      const path = join(this.#dir, name);
      const bytes = await this.#healTail(path);
      this.#segments.push({ name, path, bytes, pending: 0 });
    }

    this.#cursor = await this.#loadCursor();
    await this.#countPending();

    if (this.#segments.length > 0) {
      const active = this.#segments[this.#segments.length - 1];
      if (active !== undefined) {
        this.#handle = await open(active.path, 'a');
      }
    }

    const stats = this.stats();
    if (stats.pending > 0 || stats.corrupt > 0) {
      this.#logger.info(
        { pending: stats.pending, bytes: stats.bytes, corrupt: stats.corrupt },
        'recovered a result spool from disk',
      );
    }
  }

  /**
   * Truncates a trailing line that has no newline.
   *
   * A crash between `write` and the newline leaves half a record. Removing it here means every
   * later append starts on a clean boundary, so one bad crash cannot corrupt reads for ever.
   */
  async #healTail(path: string): Promise<number> {
    const { size } = await stat(path);
    if (size === 0) return 0;

    const handle = await open(path, 'r');
    try {
      const tail = Buffer.alloc(1);
      await handle.read(tail, 0, 1, size - 1);
      if (tail[0] === 0x0a) return size;
    } finally {
      await handle.close();
    }

    const buffer = await readFile(path);
    const lastNewline = buffer.lastIndexOf(0x0a);
    const keep = lastNewline + 1;
    await truncate(path, keep);
    this.#corrupt += 1;
    this.#logger.warn({ path, discardedBytes: size - keep }, 'discarded a torn record at the tail');
    return keep;
  }

  async #countPending(): Promise<void> {
    let counting = this.#cursor.segment === null;
    for (const segment of this.#segments) {
      if (!counting && segment.name === this.#cursor.segment) counting = true;
      if (!counting) continue;

      const buffer = await readFile(segment.path);
      const from = segment.name === this.#cursor.segment ? this.#cursor.offset : 0;
      segment.pending = countLines(buffer.subarray(from));
    }
    // A cursor naming a segment that has been evicted means everything left is unacknowledged.
    if (
      this.#cursor.segment !== null &&
      !this.#segments.some((segment) => segment.name === this.#cursor.segment)
    ) {
      const first = this.#segments[0];
      this.#cursor = { segment: first?.name ?? null, offset: 0 };
      for (const segment of this.#segments) {
        segment.pending = countLines(await readFile(segment.path));
      }
    }
  }

  async #roll(): Promise<Segment> {
    await this.#handle?.close();
    // Monotonic and lexicographically sortable, so `sort()` is chronological order.
    const name = `${String(Date.now()).padStart(14, '0')}-${randomSuffix()}${SEGMENT_SUFFIX}`;
    const path = join(this.#dir, name);
    this.#handle = await open(path, 'a');
    const segment: Segment = { name, path, bytes: 0, pending: 0 };
    this.#segments.push(segment);
    return segment;
  }

  /** Oldest-first, and counted. A spool that silently forgets is worse than no spool. */
  async #evict(): Promise<void> {
    while (this.stats().bytes > this.#maxBytes && this.#segments.length > 1) {
      const oldest = this.#segments.shift();
      if (oldest === undefined) break;

      this.#dropped += oldest.pending;
      await rm(oldest.path, { force: true });

      if (this.#cursor.segment === oldest.name) {
        this.#cursor = { segment: this.#segments[0]?.name ?? null, offset: 0 };
      }
      this.#logger.warn(
        { droppedRecords: oldest.pending, totalDropped: this.#dropped, maxBytes: this.#maxBytes },
        'spool is full; evicted the oldest results',
      );
    }
  }

  /** Deletes segments the cursor has moved past. */
  async #reclaim(): Promise<void> {
    while (this.#segments.length > 1) {
      const oldest = this.#segments[0];
      if (oldest === undefined || oldest.name === this.#cursor.segment || oldest.pending > 0) break;
      this.#segments.shift();
      await rm(oldest.path, { force: true });
    }
  }

  async #loadCursor(): Promise<Cursor> {
    try {
      const raw = await readFile(join(this.#dir, CURSOR_FILE), 'utf8');
      const parsed = JSON.parse(raw) as Partial<Cursor>;
      if (typeof parsed.offset === 'number' && parsed.offset >= 0) {
        return { segment: parsed.segment ?? null, offset: parsed.offset };
      }
    } catch {
      // No cursor, or an unreadable one. Replaying from the start costs duplicate writes, and
      // duplicates are free: the core's unique index on (channel_id, time) makes them no-ops.
    }
    return { segment: this.#segments[0]?.name ?? null, offset: 0 };
  }

  async #saveCursor(): Promise<void> {
    await writeFile(join(this.#dir, CURSOR_FILE), JSON.stringify(this.#cursor), 'utf8');
  }
}

/** Lines without their terminator. A trailing fragment with no newline is not yielded. */
function* splitLines(buffer: Buffer): Generator<Buffer> {
  let from = 0;
  for (;;) {
    const at = buffer.indexOf(0x0a, from);
    if (at === -1) return;
    yield buffer.subarray(from, at);
    from = at + 1;
  }
}

function countLines(buffer: Buffer): number {
  let count = 0;
  for (let at = buffer.indexOf(0x0a); at !== -1; at = buffer.indexOf(0x0a, at + 1)) count += 1;
  return count;
}

/** Two segments rolled in the same millisecond must still sort deterministically. */
function randomSuffix(): string {
  return createHash('sha256').update(String(process.hrtime.bigint())).digest('hex').slice(0, 8);
}
