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
import { describeError, type CheckResult, type Logger } from '@ms/shared';

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
  /**
   * Results handed to the spool that never reached disk (`P-78`).
   *
   * Distinct from `dropped`, which is eviction at the cap — a deliberate choice made with the
   * results already safely written. This is the other kind: a write that failed, so the readings
   * were lost before the spool ever held them. Both end with a measurement that exists nowhere,
   * and an operator needs to tell a full disk from a broken one.
   */
  unwritten: number;
}

/**
 * `append` after `close` (`P-80`), as a type of its own so a caller can tell it from a disk that
 * failed. The two want different handling: a failed write is news per result, while a refusal at
 * shutdown arrives in a burst and is one fact with a count.
 */
export class SpoolClosedError extends Error {
  constructor() {
    super('the result spool is closed and cannot accept results');
    this.name = 'SpoolClosedError';
  }
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

/** Lines a peek consumed from one segment: its records and the lines it skipped. */
interface Span {
  segment: string;
  lines: number;
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
  #unwritten = 0;
  /**
   * Shut down, so `append` must refuse rather than pretend (`P-80`).
   *
   * `#appendNow` writes through `await this.#handle?.write` and `close()` clears that handle, so
   * without this flag an append after close short-circuited to a no-op, incremented `pending` and
   * `bytes` for records on no disk, and **resolved** — which meant `P-78`'s counter never fired
   * either. It was reachable on every shutdown while the spool-drain hook closed the spool first,
   * with the runners still settling checks into `spoolResult`; `main.ts` now closes it last, and
   * this stays as the backstop for anything that gets the order wrong again.
   */
  #closed = false;
  /**
   * What the last `peek` covered, so `commit` knows what it is confirming.
   *
   * `skipped` is lines consumed that could never become a record — blank, or unparseable. They
   * have to be here because `#countPending` counts *newlines*, so a line the reader passes over
   * and `commit` does not subtract leaves a permanent residue in `segment.pending` that no path
   * can remove (`P-80`). `torn` is the subset that failed to parse, counted into `#corrupt` at
   * commit rather than at read: `peek` re-reads from the cursor until the batch is confirmed, and
   * the drain does not confirm on a retryable nack, so counting at read turned one torn record
   * into a fabricated per-second rate of unreadable results.
   *
   * **`spans` is per segment, because a segment can go while the batch is in flight (`P-227`).**
   * The drain peeks, waits for the core, then commits, and appends keep arriving in between. At
   * the cap, one of them evicts the segment the batch was read from. `commit` used to subtract
   * the batch from whatever segments were left, which were the wrong ones, and then put the cursor
   * back on the deleted segment. Every later `peek` found no such segment and returned nothing,
   * with the link up and the probe heartbeating, until a restart. Eviction now takes a span's
   * lines out of the batch and into `evicted`: they were neither dropped nor delivered yet. The
   * batch's outcome settles them. An acknowledgement delivered them, and a batch replaced by a
   * fresh peek, or still open at close, means they are gone, and they are counted as dropped then.
   */
  #peeked:
    | {
        records: number;
        skipped: number;
        torn: number;
        spans: Span[];
        evicted: number;
        segment: string;
        offset: number;
      }
    | undefined;
  /**
   * Everything that touches the segments runs one at a time: appends, eviction, `peek` and
   * `commit`.
   *
   * The pool reports results from several workers and its callback is synchronous, so without
   * this two `write` calls could interleave and produce a line that is half of each. Serialising
   * here rather than at every call site means a caller cannot forget. `peek` and `commit` are on
   * it too (`P-227`), so an eviction cannot delete a segment while `peek` is between finding it
   * and reading it.
   */
  #writing: Promise<void> = Promise.resolve();
  /**
   * The next append starts a new segment (`P-227`). Set when a failed write left bytes that
   * could not be taken back, so that the segment is sealed with the fragment inside it. `peek`
   * passes a sealed segment's unterminated tail as torn, where the active segment's would wait
   * for the rest of the line.
   */
  #rollNext = false;

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
      unwritten: this.#unwritten,
    };
  }

  async append(results: readonly CheckResult[]): Promise<void> {
    if (results.length === 0) return;
    if (this.#closed) {
      // Counted before throwing, because the caller only gets an error and an error carries no
      // number — the same reasoning as the `.catch` below, for the case that never reached it.
      this.#unwritten += results.length;
      throw new SpoolClosedError();
    }
    const queued = this.#serially(() => this.#appendNow(results));
    // **Counted here, not at the call site** (`P-78`). A failed write loses exactly these
    // results, and this is the only place that knows how many — every caller sees a rejected
    // promise and an error, neither of which carries a number. `main.ts` logged the error and the
    // readings were gone, counted nowhere: the one thing `CLAUDE.md` says never to do. The error
    // is rethrown untouched, so nothing above this changes.
    return queued.catch((error: unknown) => {
      this.#unwritten += results.length;
      throw error;
    });
  }

  /**
   * Runs `task` after everything already queued, and before anything queued later.
   *
   * Failures are swallowed on the chain, so one failed append cannot reject every later one. The
   * caller still sees its own error.
   */
  #serially<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#writing.then(task);
    this.#writing = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #appendNow(results: readonly CheckResult[]): Promise<void> {
    const payload = Buffer.from(results.map((result) => JSON.stringify(result)).join('\n') + '\n');
    let active = this.#segments.at(-1);

    if (
      active === undefined ||
      this.#rollNext ||
      active.bytes + payload.byteLength > this.#segmentMaxBytes
    ) {
      active = await this.#roll();
      this.#rollNext = false;
    }

    await this.#write(active, payload);
    active.bytes += payload.byteLength;
    active.pending += results.length;
    if (this.#cursor.segment === null) this.#cursor = { segment: active.name, offset: 0 };

    await this.#evict();
  }

  /**
   * Writes all of `payload` to the active segment, or none of it (`P-227`).
   *
   * **A write can succeed with fewer bytes than it was given.** On a filesystem that fills up,
   * the bytes that fit in the file's last block land and the call returns a short count rather
   * than an error, and `FileHandle.write` hands that count back without trying again. This used
   * to ignore it. The fragment then joined the next record into one line that did not parse, and
   * `segment.bytes` ran ahead of the file, so once the segment rolled `peek` waited at its real
   * end for bytes that would never come. The drain stalled until a restart. Now the rest is
   * written, and if that fails the fragment is cut off again, so the segment still ends on a
   * record boundary and its size is still its file's.
   */
  async #write(active: Segment, payload: Buffer): Promise<void> {
    const handle = this.#handle;
    if (handle === undefined) throw new Error('the result spool has no segment open to write to');
    let written = 0;
    try {
      while (written < payload.byteLength) {
        const { bytesWritten } = await handle.write(payload, written);
        if (bytesWritten === 0) {
          throw new Error(
            `the disk took none of the last ${String(payload.byteLength - written)} bytes of a record`,
          );
        }
        written += bytesWritten;
      }
    } catch (error) {
      if (written > 0) await this.#cutFragment(handle, active, written);
      throw error;
    }
  }

  /** Takes back the part of a record a failed write left, or seals the segment around it. */
  async #cutFragment(handle: FileHandle, active: Segment, written: number): Promise<void> {
    try {
      await handle.truncate(active.bytes);
    } catch (error) {
      // Shrinking a file needs no space, so this is very unlikely. If it happens anyway, the
      // fragment stays, the size is taken from the file, and the next append starts a new
      // segment. `peek` then passes the unterminated tail of a sealed segment as torn.
      active.bytes = await handle
        .stat()
        .then((stats) => stats.size)
        .catch(() => active.bytes + written);
      this.#rollNext = true;
      this.#logger.error(
        { ...describeError(error), segment: active.name, fragmentBytes: written },
        'could not remove part of a record a failed write left; sealing the segment around it',
      );
    }
  }

  /**
   * The oldest unacknowledged results, without removing them.
   *
   * Nothing leaves the spool until the core has said it stored the batch: a lost acknowledgement
   * costs a duplicate write, which is free, while an optimistic delete costs the reading.
   */
  peek(max: number): Promise<CheckResult[]> {
    return this.#serially(() => this.#peekNow(max));
  }

  async #peekNow(max: number): Promise<CheckResult[]> {
    // A batch that was never confirmed, replaced by this one. Whatever eviction took from it is
    // on no disk and was not acknowledged, so it is gone now and is counted as gone.
    this.#settleUnconfirmed();
    if (this.#cursor.segment === null || max <= 0) return [];
    // **A cursor on a segment that is not there is repaired, not obeyed.** Every later read would
    // find nothing, with the link up and results on disk, which is the silent stall `P-227` was
    // filed for. Replaying from the oldest segment costs duplicates at worst, and the core's
    // unique index makes those free, which is `#loadCursor`'s rule for a cursor it cannot read.
    const named = this.#cursor.segment;
    if (!this.#segments.some((segment) => segment.name === named)) {
      this.#logger.error(
        { cursor: named, oldest: this.#segments[0]?.name ?? null },
        'the spool cursor names a segment that no longer exists; replaying from the oldest',
      );
      await this.#countPending();
      // Typed as declared: the checker narrowed the field above and cannot see `#countPending` move it.
      const repaired: Cursor = this.#cursor;
      if (repaired.segment === null) return [];
    }

    const results: CheckResult[] = [];
    // Consumed but unusable, and the unparseable subset of it. Across segments, because one peek
    // may span a boundary.
    let skipped = 0;
    let torn = 0;
    const spans: Span[] = [];
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
      let lines = 0;
      let full = false;

      for (const line of splitLines(slice)) {
        if (results.length >= max) {
          full = true;
          break;
        }
        consumed += line.length + 1;
        lines += 1;
        const text = line.toString('utf8').trim();
        if (text === '') {
          skipped += 1;
          continue;
        }
        try {
          results.push(JSON.parse(text) as CheckResult);
        } catch {
          // A torn line from a crash boundary. Skipped rather than allowed to stop the spool
          // draining, and carried to `commit` rather than counted here — see `#peeked`.
          skipped += 1;
          torn += 1;
        }
      }
      if (lines > 0) spans.push({ segment: current, lines });

      const next = this.#segments[this.#segments.indexOf(segment) + 1];
      // **A segment with one after it is finished when its lines are** (`P-227`), whatever its
      // counted size says. Nothing appends to a segment once the next is rolled, so what is left
      // past its last newline is a fragment no write will complete. This used to compare the
      // offset with `segment.bytes`, and a count that ran ahead of the file held `peek` at the
      // file's real end for good. The fragment is torn, counted once at commit like any other.
      if (next !== undefined && !full) {
        if (consumed < slice.length) torn += 1;
        position = { segment: next.name, offset: 0 };
      } else {
        position = { segment: current, offset: position.offset + consumed };
      }

      // Nothing readable in this segment. Break only if we did not just step to another one:
      // a cursor parked exactly on a boundary — which is where a drain that caught up leaves it,
      // since there was no next segment at the time — consumes nothing from the segment it is in
      // and must still be allowed to read the one that has since been rolled. Breaking here
      // regardless made `peek` return an empty batch for ever while `pending` climbed, which the
      // drain reads as "no work": link up, nothing logged, results piling up until the spool hits
      // its size cap and begins dropping them.
      if (consumed === 0 && position.segment === current) break;
    }

    this.#peeked =
      results.length === 0 && skipped === 0 && torn === 0
        ? undefined
        : { records: results.length, skipped, torn, spans, evicted: 0, ...position };

    // Bytes consumed, nothing to send. No batch means nothing will ever acknowledge these, so
    // nothing would call `commit` — and the same unusable lines would be re-read for ever while
    // `pending` never reached zero. Confirming here discards no result: only lines that cannot
    // become one.
    if (results.length === 0 && (skipped > 0 || torn > 0)) await this.#commitNow();
    return results;
  }

  /** Confirms the last `peek`: those results are stored and their space can be reclaimed. */
  commit(): Promise<void> {
    return this.#serially(() => this.#commitNow());
  }

  async #commitNow(): Promise<void> {
    const peeked = this.#peeked;
    if (peeked === undefined) return;
    this.#peeked = undefined;

    // Counted here, once, for the reason given on `#peeked`.
    this.#corrupt += peeked.torn;
    // Skipped lines are subtracted too: `pending` is a count of lines, so a line the reader
    // passed over is no longer pending however unusable it was. Each span from the segment it
    // was read from, and none from a segment eviction took while the batch was in flight.
    for (const span of peeked.spans) {
      const segment = this.#segments.find((candidate) => candidate.name === span.segment);
      if (segment !== undefined) segment.pending -= Math.min(segment.pending, span.lines);
    }

    // Onto where the batch ended, unless eviction took that segment too. Then `#evict` has
    // already moved the cursor to the oldest segment left, and every segment the batch read has
    // gone, so that is where the next unconfirmed record is.
    if (this.#segments.some((segment) => segment.name === peeked.segment)) {
      this.#cursor = { segment: peeked.segment, offset: peeked.offset };
    }
    await this.#reclaim();
    await this.#saveCursor();
  }

  /** Counts as dropped what eviction took from a batch that will now never be confirmed. */
  #settleUnconfirmed(): void {
    const peeked = this.#peeked;
    if (peeked === undefined) return;
    this.#peeked = undefined;
    this.#dropped += peeked.evicted;
  }

  async close(): Promise<void> {
    this.#closed = true;
    // Appends accepted before this point are already on the chain and must finish while the handle
    // is still open; without this they ran after it was cleared and vanished silently.
    await this.#writing.catch(() => undefined);
    this.#settleUnconfirmed();
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
    const name = `${String(this.#nextSegmentMs()).padStart(14, '0')}-${randomSuffix()}${SEGMENT_SUFFIX}`;
    const path = join(this.#dir, name);
    this.#handle = await open(path, 'a');
    const segment: Segment = { name, path, bytes: 0, pending: 0 };
    this.#segments.push(segment);
    return segment;
  }

  /**
   * The time a new segment is named for: now, or just after the newest segment, whichever is
   * later (`P-227`).
   *
   * Names sort into the order `#load` reads segments in after a restart, and the wall clock can
   * step backwards (an NTP step, a clock that ran ahead, `date -s`). A segment rolled after a step
   * used to be named before the segment the cursor was in. After a restart it sorted in front of
   * the cursor, so nothing counted it and nothing read it, and the first commit's `#reclaim`
   * deleted it as already confirmed. Every result in it was lost, and none was counted.
   */
  #nextSegmentMs(): number {
    const now = Date.now();
    const newest = Number.parseInt(this.#segments.at(-1)?.name.slice(0, 14) ?? '', 10);
    if (Number.isNaN(newest) || now > newest) return now;
    this.#logger.warn(
      { clockMs: now, newestSegmentMs: newest },
      'the wall clock is behind the newest spool segment; naming the next one after it, so the ' +
        'order survives a restart',
    );
    return newest + 1;
  }

  /** Oldest-first, and counted. A spool that silently forgets is worse than no spool. */
  async #evict(): Promise<void> {
    while (this.stats().bytes > this.#maxBytes && this.#segments.length > 1) {
      const oldest = this.#segments.shift();
      if (oldest === undefined) break;

      // Lines of a batch the drain is waiting on are not dropped yet: the acknowledgement may
      // still deliver them. They move to the batch, which settles them (see `#peeked`).
      const peeked = this.#peeked;
      const inFlight = peeked?.spans.find((span) => span.segment === oldest.name)?.lines ?? 0;
      if (peeked !== undefined && inFlight > 0) peeked.evicted += inFlight;
      const dropped = Math.max(0, oldest.pending - inFlight);
      this.#dropped += dropped;
      await rm(oldest.path, { force: true });

      if (this.#cursor.segment === oldest.name) {
        this.#cursor = { segment: this.#segments[0]?.name ?? null, offset: 0 };
      }
      this.#logger.warn(
        {
          droppedRecords: dropped,
          inFlight,
          totalDropped: this.#dropped,
          maxBytes: this.#maxBytes,
        },
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
