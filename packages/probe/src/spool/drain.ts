import { DEFAULT_MAX_FRAME_BYTES, fitResult, type CheckResult, type Logger } from '@ms/shared';
import type { ResultsOutcome } from '../transport/core-client.js';
import type { ResultSpool } from './spool.js';

/** The part of `CoreClient` a drain needs. An interface so tests need no socket. */
export interface ResultSender {
  readonly connected: boolean;
  sendResults(results: readonly CheckResult[], backlog: number): Promise<ResultsOutcome>;
}

export interface SpoolDrainOptions {
  spool: ResultSpool;
  client: ResultSender;
  logger: Logger;
  batchMaxRows: number;
  /**
   * Batch size once there is a backlog. Larger than `batchMaxRows` on purpose: the same rows in
   * fewer round trips clear the backlog sooner, and the sooner it clears the less time this
   * probe's own live results spend queued behind it.
   */
  catchUpMaxRows?: number;
  /** How long to wait before looking again when there is nothing to do. */
  idleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * How long the spool may hold results, with the link up, before this says so out loud.
   *
   * **Because it once held them for ever and said nothing.** A cursor parked on a segment
   * boundary made `peek` return an empty batch while the spool reported thousands pending, and
   * the drain read that as "no work": connected, idle, silent, and thirty thousand readings on
   * disk. CLAUDE.md's rule is that backpressure is visible and never silent, and the failure that
   * broke it was not the bug — it was that nothing here was watching for progress.
   */
  stallAfterMs?: number;
  now?: () => number;
  /**
   * The most a batch's results may come to as JSON (`P-277` review). `MAX_BATCH_BYTES` unless a
   * test sets it.
   */
  maxBatchBytes?: number;
}

export interface DrainStats {
  /** Batches the core stored. */
  sent: number;
  /** Results still on disk after the last batch. Probe Health reads this (P-13). */
  backlog: number;
  /** Longest delay the core has asked this probe to wait between batches. */
  maxRetryAfterMs: number;
  /** Results the core refused as unparseable. Discarded, because they can never succeed. */
  rejected: number;
  /** Batches the core asked us to retry. */
  retried: number;
  /**
   * Results discarded because one alone is larger than a frame may carry (`P-277` review).
   * Sending it could never succeed, and keeping it would hold every result behind it.
   */
  oversized: number;
  /**
   * Milliseconds the spool has held results with the link up and nothing moving. Zero when it is
   * making progress or has nothing to make progress on.
   */
  stalledForMs: number;
}

const DEFAULT_IDLE_MS = 1_000;
/**
 * Five minutes of a connected link and a spool that will not move.
 *
 * Long enough that a core pacing a catch-up with `retryAfterMs`, or a slow batch, never trips it;
 * short enough that an operator hears about it on the same shift rather than from a disk alert a
 * week later.
 */
const DEFAULT_STALL_AFTER_MS = 300_000;

/**
 * The most one batch's results may come to as JSON (`P-277` review): a frame, less 64 KiB for
 * the rest of the message.
 *
 * **Rows alone did not bound a frame.** 500 to 2,000 results each within the schema's bounds can
 * pass 4 MiB, and then `encodeFrame` threw, the link closed, and the same batch was offered again
 * on the next one, for ever.
 */
export const MAX_BATCH_BYTES = DEFAULT_MAX_FRAME_BYTES - 64 * 1024;

/**
 * The share of `MAX_BATCH_BYTES` the spool is asked for, measured at each record's size on disk.
 * Fitting a record only shortens it, except that clipping a string of at least 201 characters
 * can lengthen it by one byte (an ellipsis for two ASCII characters), so 1% is more than fitting
 * can add, and the commas between results besides.
 */
const PEEK_SHARE = 0.99;

/**
 * Moves spooled results to the core, oldest first (R-02).
 *
 * One batch in flight at a time, and nothing leaves the spool until the core says it stored it.
 * That is what makes a dropped connection cost a duplicate write rather than a lost reading —
 * and duplicates are free, because the core's unique index on `(channel_id, time)` makes the
 * insert a no-op.
 *
 * The rate limit that stops a reconnecting probe with hours of backlog from taking down
 * ingestion for everyone is `R-03`. What is honoured here is the signal that already exists:
 * `retryAfterMs` on the acknowledgement, which rises before batches start being refused
 * outright (S-07). Waiting on it is what turns backpressure into slowing down rather than into
 * a wall.
 */
export class SpoolDrain {
  readonly #spool: ResultSpool;
  readonly #client: ResultSender;
  readonly #logger: Logger;
  readonly #batchMaxRows: number;
  readonly #catchUpMaxRows: number;
  readonly #idleMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #stallAfterMs: number;
  readonly #now: () => number;
  readonly #maxBatchBytes: number;

  #running = false;
  #loop: Promise<void> | undefined;
  #wake: (() => void) | undefined;
  /** When the spool last had nothing pending, or last moved a batch. Used only for the stall. */
  #lastProgressAt: number;
  #stallReported = false;
  #stats: DrainStats = {
    sent: 0,
    backlog: 0,
    maxRetryAfterMs: 0,
    rejected: 0,
    retried: 0,
    oversized: 0,
    stalledForMs: 0,
  };

  constructor(options: SpoolDrainOptions) {
    this.#spool = options.spool;
    this.#client = options.client;
    this.#logger = options.logger.child({ component: 'spool-drain' });
    this.#batchMaxRows = options.batchMaxRows;
    this.#catchUpMaxRows = Math.max(
      options.catchUpMaxRows ?? options.batchMaxRows,
      options.batchMaxRows,
    );
    this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.#stallAfterMs = options.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
    this.#now = options.now ?? Date.now;
    this.#maxBatchBytes = options.maxBatchBytes ?? MAX_BATCH_BYTES;
    this.#lastProgressAt = this.#now();
    this.#sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          // unref: a probe shutting down must not wait out an idle poll.
          setTimeout(resolve, ms).unref();
        }));
  }

  stats(): DrainStats {
    return { ...this.#stats };
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.wake();
    await this.#loop;
    this.#loop = undefined;
  }

  /** Something changed — a result arrived, or the link came up. Look again now. */
  wake(): void {
    this.#wake?.();
    this.#wake = undefined;
  }

  /** Resolves on the next `wake`, or after `ms`, whichever comes first. */
  async #idle(ms: number): Promise<void> {
    await Promise.race([
      new Promise<void>((resolve) => {
        this.#wake = resolve;
      }),
      this.#sleep(ms),
    ]);
    this.#wake = undefined;
  }

  async #run(): Promise<void> {
    while (this.#running) {
      try {
        const waitMs = await this.#step();
        if (waitMs > 0) await this.#idle(waitMs);
      } catch (error: unknown) {
        // The loop is the probe's only path off disk. It must not be the thing that dies.
        this.#logger.error({ err: error }, 'the spool drain hit an error; retrying');
        await this.#idle(this.#idleMs);
      }
    }
  }

  /** The spool moved, or had nothing to move. Either way it is not stuck. */
  #progress(): void {
    this.#lastProgressAt = this.#now();
    this.#stats.stalledForMs = 0;
    if (this.#stallReported) {
      this.#logger.warn('the spool is draining again');
      this.#stallReported = false;
    }
  }

  /**
   * Results on disk, the link up, and nothing moving.
   *
   * Reported once when it starts rather than every second, and again when it clears, because an
   * operator needs to know it happened and a log that repeats every second is a log nobody reads.
   * `stalledForMs` keeps climbing regardless, so Probe Health can carry it.
   */
  #noteStalled(pending: number): void {
    const stalledFor = this.#now() - this.#lastProgressAt;
    this.#stats.stalledForMs = stalledFor;
    if (stalledFor < this.#stallAfterMs || this.#stallReported) return;
    this.#stallReported = true;
    this.#logger.error(
      { pending, stalledForMs: stalledFor },
      'the spool holds results, the core is reachable, and nothing has moved — results are ' +
        'accumulating on disk and will be dropped when the spool fills',
    );
  }

  /**
   * What the spool hands back, made to fit the wire (`P-277` review). A runner fits each result
   * before it is spooled, but a record written by an earlier build was not, and one that does
   * not fit would wedge the probe this was meant to free. Logged once a batch.
   */
  #fit(records: readonly CheckResult[]): CheckResult[] {
    let unfit = 0;
    const examples: string[] = [];
    const fitted = records.map((record) => {
      const { result, problems } = fitResult(record);
      if (problems.length > 0) {
        unfit += 1;
        if (examples.length < 4)
          examples.push(`sensor ${String(record.sensorId)}: ${problems[0] ?? ''}`);
      }
      return result;
    });
    if (unfit > 0) {
      this.#logger.warn(
        { unfit, examples },
        'spooled results held readings that cannot be sent as they are; sending the rest',
      );
    }
    return fitted;
  }

  /** One pass. Returns how long to wait before the next one; zero means "immediately". */
  async #step(): Promise<number> {
    // A link that is down is not a stall: the spool is doing its job, and R-02 is the whole
    // point of it. The clock restarts so a long outage does not report a stall on reconnection.
    if (!this.#client.connected) {
      this.#progress();
      return this.#idleMs;
    }

    // Behind, so take bigger bites. `pending` is what is on disk right now, so this reads the
    // backlog before deciding how much of it to move.
    const pending = this.#spool.stats().pending;
    const take = pending > this.#batchMaxRows ? this.#catchUpMaxRows : this.#batchMaxRows;

    const batch = this.#fit(
      await this.#spool.peek(take, Math.floor(this.#maxBatchBytes * PEEK_SHARE)),
    );
    if (batch.length === 0) {
      this.#stats.backlog = 0;
      // **An empty batch with results still on disk is the shape of the bug this exists for.**
      // A spool that says it holds thousands and hands back nothing is not idle, and treating it
      // as idle is what made a permanent stall invisible for hours.
      if (pending > 0) this.#noteStalled(pending);
      else this.#progress();
      return this.#idleMs;
    }

    // **One result larger than a frame** (`P-277` review). The spool hands back its first record
    // whatever its size, and one that alone passes the bound can never be sent: kept, it would
    // hold every result behind it for ever. Discarded, counted and said, as a refusal is.
    const [only] = batch;
    if (batch.length === 1 && only !== undefined) {
      const bytes = Buffer.byteLength(JSON.stringify(only));
      if (bytes > this.#maxBatchBytes) {
        this.#stats.oversized += 1;
        this.#logger.error(
          { sensorId: only.sensorId, bytes, maxBatchBytes: this.#maxBatchBytes },
          'a spooled result is larger than a frame can carry; discarding it rather than blocking the spool',
        );
        await this.#spool.commit();
        this.#progress();
        return 0;
      }
    }

    const backlog = Math.max(0, pending - batch.length);
    this.#stats.backlog = backlog;
    const outcome = await this.#client.sendResults(batch, backlog);

    if (outcome.kind === 'ack') {
      // Counted before the commit, deliberately. These count what the core answered, which is
      // already true — and an observer that sees the spool empty must not see the counters
      // still behind, because clearing the spool is what tells everyone the batch is done.
      this.#stats.sent += 1;
      this.#stats.maxRetryAfterMs = Math.max(this.#stats.maxRetryAfterMs, outcome.retryAfterMs);
      this.#logger.debug(
        {
          results: batch.length,
          stored: outcome.storedSamples,
          backlog,
          retryAfterMs: outcome.retryAfterMs,
        },
        'sent a batch of spooled results',
      );
      await this.#spool.commit();
      this.#progress();
      // Zero means straight back round. Anything else is the core pacing this probe's catch-up,
      // which it can do and this probe cannot: only the core knows how many others are replaying.
      return outcome.retryAfterMs;
    }

    if (outcome.reason === 'invalid') {
      // The one refusal that retrying cannot fix. Keeping it would jam every result behind it
      // for ever, so it is discarded — loudly, and counted, because silently losing readings is
      // the failure mode this whole file exists to avoid.
      this.#stats.rejected += batch.length;
      this.#logger.error(
        { results: batch.length, totalRejected: this.#stats.rejected },
        'the core refused a batch as invalid; discarding it rather than blocking the spool',
      );
      await this.#spool.commit();
      this.#progress();
      return 0;
    }

    this.#stats.retried += 1;
    this.#progress();
    this.#logger.info(
      { reason: outcome.reason, retryAfterMs: outcome.retryAfterMs, results: batch.length },
      'the core asked us to retry a batch',
    );
    return Math.max(outcome.retryAfterMs, this.#idleMs);
  }
}
