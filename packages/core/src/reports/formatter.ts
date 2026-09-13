import { Worker } from 'node:worker_threads';
import { describeError, type ErrorContext, type Logger } from '@ms/shared';
import { ReportError, type ReportErrorCode } from './errors.js';
import type { RenderedOutput, StoredFormat } from './formats.js';
import type { ReportFormat, ReportOutputs } from './outputs.js';
import type { ReportRow } from './repository.js';
import type { ReportDocument } from './table.js';

/**
 * Report formatting, off the event loop (`P-204`).
 *
 * **What this exists to stop, measured.** `P-203` found every format synchronous for its whole
 * duration — an HTML document near the value limit holds the core's event loop for most of a
 * second, and a PDF refused for its page count for a second and a half before it says so — and two
 * reports formatting at once made a request arriving meanwhile wait 1.27 s at p95 and 2.6 s at
 * worst, against 11 ms idle. Everything on that loop waits the same: the API, the probes' results,
 * the state machine deciding alarms, the WebSocket every open browser is watching.
 *
 * So formatting runs in `worker_threads` workers, the shape `CLAUDE.md` already uses for checks:
 * the document goes in by structured clone and the bytes come back transferred. **The core still
 * builds the document** — reading history is I/O that yields, and `P-203` measured it costing a
 * concurrent request nothing — and a worker only turns that document into files.
 *
 * ## The rules, and the failure each prevents
 *
 * - **A fixed, small pool, started on first use.** Two workers by default, `ReportRunner`'s own
 *   bound, so the scheduled path never waits on itself; a core that never renders a report never
 *   starts one. An idle worker is given back after a minute, because each holds `pdfkit` and a
 *   font it will not need again until the next report.
 * - **A bounded queue, refused when full.** The render route is not bounded by `ReportRunner` — any
 *   number of people can press "render" at once — so the pool is where the bound lives. A job over
 *   it is refused with `REPORT_BUSY` rather than queued without limit (`CLAUDE.md`: backpressure is
 *   visible, never silent), and `stats().refused` puts the count on Core Health.
 * - **A job over its time is ended, with its worker.** A formatter that hangs must not take a slot
 *   for ever, and the only way to stop a thread that is not listening is to terminate it.
 * - **A crashed worker fails one job, not the pool.** It is replaced when there is next work.
 * - **A refusal crosses the thread as a refusal** — see `format-worker.ts`.
 */

/** What the pool sends a worker. */
export interface FormatRequest {
  readonly id: number;
  readonly name: string;
  readonly document: ReportDocument;
  readonly outputs: ReportOutputs;
  readonly at: Date;
}

/** What a worker sends back. */
export type FormatReply =
  | {
      readonly id: number;
      readonly ok: true;
      readonly parts: readonly { format: StoredFormat; filename: string; body: Uint8Array }[];
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error:
        | {
            readonly kind: 'report';
            readonly code: ReportErrorCode;
            readonly message: string;
            readonly details: Record<string, unknown>;
            readonly context: ErrorContext;
          }
        | { readonly kind: 'other'; readonly message: string };
    };

export interface ReportFormatterOptions {
  readonly logger: Logger;
  /** Workers at most. Default 2 — `ReportRunner`'s own bound. */
  readonly size?: number;
  /** Jobs that may wait for a worker before another is refused. Default 8. */
  readonly maxQueued?: number;
  /** A job taking longer than this is ended, with its worker. Default two minutes. */
  readonly timeoutMs?: number;
  /** A worker idle this long is given back. Default a minute. */
  readonly idleMs?: number;
  /** The worker module. For tests that need a worker which crashes or hangs on purpose. */
  readonly workerUrl?: URL;
}

export interface FormatterStats {
  /** Workers held right now. */
  readonly workers: number;
  readonly busy: number;
  /** Jobs waiting for a worker. The backpressure gauge. */
  readonly queued: number;
  readonly completed: number;
  /** Jobs that ended in an error — a refusal, a crash or a timeout. */
  readonly failed: number;
  /** Jobs turned away because the queue was full. */
  readonly refused: number;
  readonly crashed: number;
  readonly timedOut: number;
}

interface Pending {
  readonly request: FormatRequest;
  readonly resolve: (parts: RenderedOutput[]) => void;
  readonly reject: (error: Error) => void;
}

interface Slot {
  readonly worker: Worker;
  job: Pending | undefined;
  timer: NodeJS.Timeout | undefined;
  idle: NodeJS.Timeout | undefined;
}

const DEFAULT_SIZE = 2;
const DEFAULT_MAX_QUEUED = 8;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_MS = 60_000;

export class ReportFormatter {
  readonly #logger: Logger;
  readonly #size: number;
  readonly #maxQueued: number;
  readonly #timeoutMs: number;
  readonly #idleMs: number;
  readonly #workerUrl: URL;
  readonly #slots: Slot[] = [];
  readonly #queue: Pending[] = [];
  #nextId = 0;
  #closed = false;
  #completed = 0;
  #failed = 0;
  #refused = 0;
  #crashed = 0;
  #timedOut = 0;

  constructor(options: ReportFormatterOptions) {
    this.#logger = options.logger.child({ component: 'report-formatter' });
    this.#size = Math.max(1, options.size ?? DEFAULT_SIZE);
    this.#maxQueued = Math.max(0, options.maxQueued ?? DEFAULT_MAX_QUEUED);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.#workerUrl = options.workerUrl ?? new URL('./format-worker.js', import.meta.url);
  }

  /** Every file a report's outputs document asks for, as `renderOutputs` would make them. */
  outputs(
    report: Pick<ReportRow, 'name'>,
    document: ReportDocument,
    outputs: ReportOutputs,
    at: Date,
  ): Promise<RenderedOutput[]> {
    if (this.#closed) return Promise.reject(new Error('the report formatter has been closed'));
    const busy = this.#slots.filter((slot) => slot.job !== undefined).length;
    if (busy >= this.#size && this.#queue.length >= this.#maxQueued) {
      this.#refused += 1;
      return Promise.reject(
        new ReportError(
          'REPORT_BUSY',
          `every report formatter is busy and ${String(this.#queue.length)} more are waiting; ` +
            'try again once one has finished',
          {
            context: { phase: 'format' },
            details: { workers: this.#size, queued: this.#queue.length, limit: this.#maxQueued },
          },
        ),
      );
    }
    this.#nextId += 1;
    const request: FormatRequest = { id: this.#nextId, name: report.name, document, outputs, at };
    return new Promise<RenderedOutput[]>((resolve, reject) => {
      this.#queue.push({ request, resolve, reject });
      this.#pump();
    });
  }

  /** One format of a document, for the render route. */
  async format(format: ReportFormat, document: ReportDocument): Promise<Buffer> {
    const [part] = await this.outputs(
      { name: document.report.name },
      document,
      { formats: [format], delivery: 'store', recipients: [], zip: false },
      document.generatedAt,
    );
    if (part === undefined) throw new Error(`the formatter produced no ${format}`);
    return part.body;
  }

  stats(): FormatterStats {
    return {
      workers: this.#slots.length,
      busy: this.#slots.filter((slot) => slot.job !== undefined).length,
      queued: this.#queue.length,
      completed: this.#completed,
      failed: this.#failed,
      refused: this.#refused,
      crashed: this.#crashed,
      timedOut: this.#timedOut,
    };
  }

  /** Refuses what is waiting, ends what is running, and gives back every worker. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const pending of this.#queue.splice(0)) {
      pending.reject(new Error('the report formatter was closed before this report was formatted'));
    }
    await Promise.all(
      [...this.#slots].map(async (slot) => {
        this.#finish(slot, (pending) => {
          pending.reject(new Error('the report formatter was closed while formatting this report'));
        });
        await slot.worker.terminate();
      }),
    );
    this.#slots.length = 0;
  }

  #pump(): void {
    while (this.#queue.length > 0) {
      let slot = this.#slots.find((one) => one.job === undefined);
      if (slot === undefined) {
        if (this.#slots.length >= this.#size) return;
        slot = this.#spawn();
      }
      const pending = this.#queue.shift();
      if (pending === undefined) return;
      this.#dispatch(slot, pending);
    }
  }

  #spawn(): Slot {
    const worker = new Worker(this.#workerUrl);
    const slot: Slot = { worker, job: undefined, timer: undefined, idle: undefined };
    this.#slots.push(slot);

    worker.on('message', (reply: FormatReply) => {
      const pending = slot.job;
      if (pending?.request.id !== reply.id) return;
      this.#finish(slot, (job) => {
        if (reply.ok) {
          this.#completed += 1;
          job.resolve(
            reply.parts.map((part) => ({
              format: part.format,
              filename: part.filename,
              body: Buffer.from(part.body.buffer, part.body.byteOffset, part.body.byteLength),
            })),
          );
          return;
        }
        this.#failed += 1;
        job.reject(
          reply.error.kind === 'report'
            ? new ReportError(reply.error.code, reply.error.message, {
                context: reply.error.context,
                details: reply.error.details,
              })
            : new Error(reply.error.message),
        );
      });
      this.#pump();
    });
    worker.on('error', (error) => {
      this.#logger.error({ err: describeError(error) }, 'a report format worker failed');
      this.#lose(slot, `the report formatter failed: ${error.message}`);
    });
    worker.on('exit', (code) => {
      this.#lose(slot, `the report formatter stopped with exit code ${String(code)}`);
    });
    return slot;
  }

  #dispatch(slot: Slot, pending: Pending): void {
    if (slot.idle !== undefined) clearTimeout(slot.idle);
    slot.idle = undefined;
    slot.job = pending;
    // Held open while it works, so a core shutting down waits for the report in hand; let go of
    // while idle, so an idle pool is never the reason a process — or a test — cannot exit.
    slot.worker.ref();
    slot.timer = setTimeout(() => {
      this.#timedOut += 1;
      this.#logger.warn(
        { reportName: pending.request.name, timeoutMs: this.#timeoutMs },
        'a report took too long to format, and its worker was ended',
      );
      this.#finish(slot, (job) => {
        this.#failed += 1;
        job.reject(
          new Error(`formatting this report took longer than ${String(this.#timeoutMs / 1_000)} s`),
        );
      });
      this.#remove(slot);
      void slot.worker.terminate();
      this.#pump();
    }, this.#timeoutMs);
    slot.worker.postMessage(pending.request);
  }

  /** Settles the slot's job, if it has one, and marks the slot free. */
  #finish(slot: Slot, settle: (job: Pending) => void): void {
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    slot.timer = undefined;
    const job = slot.job;
    slot.job = undefined;
    if (job !== undefined) settle(job);
    if (!this.#slots.includes(slot)) return;
    slot.worker.unref();
    if (this.#queue.length === 0 && this.#idleMs > 0) {
      slot.idle = setTimeout(() => {
        if (slot.job !== undefined) return;
        this.#remove(slot);
        void slot.worker.terminate();
      }, this.#idleMs);
      slot.idle.unref();
    }
  }

  /** A worker that went away, with or without a job in hand. */
  #lose(slot: Slot, message: string): void {
    if (!this.#slots.includes(slot)) return;
    if (slot.job !== undefined) {
      this.#crashed += 1;
      this.#finish(slot, (job) => {
        this.#failed += 1;
        job.reject(new Error(message));
      });
    }
    this.#remove(slot);
    // A queue that was waiting on this worker gets a new one rather than waiting for ever.
    if (!this.#closed) this.#pump();
  }

  #remove(slot: Slot): void {
    if (slot.idle !== undefined) clearTimeout(slot.idle);
    slot.idle = undefined;
    const index = this.#slots.indexOf(slot);
    if (index >= 0) this.#slots.splice(index, 1);
  }
}
