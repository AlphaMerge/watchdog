import { writeSync } from 'node:fs';

/**
 * How much log a service holds while its output is not being read (`P-216` part 3).
 *
 * Eight megabytes is minutes of an ordinary probe's output and seconds of nothing: `P-216c`'s
 * probe, refusing a check per line, wrote 11 KB a second. The bound is what turns a journal that
 * stops reading for a day from a gigabyte the service holds into eight megabytes and a count.
 */
export const LOG_BACKLOG_MAX_BYTES = 8 * 1024 * 1024;

/** How long an exit waits for a stalled output to take what is held, before giving up on it. */
export const LOG_EXIT_FLUSH_MS = 2_000;

/**
 * Where a process's own `LogOutput` — the one on its standard output — can be found by a sampler
 * loaded into it (`scripts/sizing/probe-memory-sampler.mjs`), which cannot import it: an installed
 * release is a bundle. Read-only use; nothing in the services reads it.
 */
export const PROCESS_LOG_OUTPUT = Symbol.for('ms.logOutput');

/** How often a stalled output is tried again. */
const RETRY_MS = 100;

/** The most one write hands the kernel, so a long backlog goes out in pieces a pipe can take. */
const MAX_WRITE_BYTES = 64 * 1024;

/** How long an exit sleeps between tries at a stalled output. */
const EXIT_RETRY_MS = 10;

export interface LogOutputStats {
  /** Lines never written: refused at the bound, lost to a closed output, or left at exit. */
  readonly droppedLines: number;
  readonly droppedBytes: number;
  /** Bytes held, waiting for the output to take them. */
  readonly backlogBytes: number;
}

export interface LogOutputOptions {
  /** Standard output unless a test says otherwise. */
  readonly fd?: number;
  readonly maxBacklogBytes?: number;
  /** `fs.writeSync`, injectable so a test can stall the output and see what is held. */
  readonly write?: (fd: number, data: Buffer) => number;
  /** How a failed output is reported, once. Standard error unless a test says otherwise. */
  readonly failed?: (line: string) => void;
}

/**
 * A service's log destination: bounded, never blocking, and counting what it drops (`P-216`).
 *
 * **Why not pino's own.** pino's default, SonicBoom, holds everything it cannot write, with no
 * bound and no count: a journal that stops reading grows the service by whatever it logs, for
 * as long as it is stopped, and nothing says so. It also writes asynchronously, and when the
 * output pushes back the write in flight is one exit cannot see: an exit while the journal is
 * behind lost the chunk in flight and wrote the ones after it, so the last lines a crash wrote
 * could be missing or out of order.
 *
 * **Synchronous writes to a descriptor that does not block.** Node puts a pipe or socket on
 * standard output into non-blocking mode as soon as `process.stdout` is touched, and the journal
 * is a socket; a regular file never stalls. So a write here returns at once: all of the line, part
 * of it, or `EAGAIN`, and what is not taken is held and tried again every 100 ms. Nothing is ever
 * in flight, so an exit writes exactly what is held, in order.
 *
 * **Past the bound a line is dropped, not an older one.** The start of an episode is the line
 * that says what happened; the count says how much more there was.
 */
export class LogOutput {
  readonly #fd: number;
  readonly #max: number;
  readonly #write: (fd: number, data: Buffer) => number;
  readonly #failed: (line: string) => void;
  #held: Buffer[] = [];
  #backlog = 0;
  #droppedLines = 0;
  #droppedBytes = 0;
  #retry: NodeJS.Timeout | undefined;
  /** Set when the output has gone for good — the reader closed it — and every line is dropped. */
  #broken = false;
  #exitHooked = false;

  constructor(options: LogOutputOptions = {}) {
    this.#fd = options.fd ?? 1;
    this.#max = options.maxBacklogBytes ?? LOG_BACKLOG_MAX_BYTES;
    this.#write = options.write ?? writeSync;
    this.#failed =
      options.failed ??
      ((line: string): void => {
        try {
          writeSync(2, line);
        } catch {
          // Standard error is the last place left to say it; if that is gone too, nobody hears.
        }
      });
    if (options.fd === undefined && options.write === undefined) {
      // Touched for its side effect: it is what puts a pipe or socket on fd 1 into non-blocking
      // mode, so the first write here cannot hold the thread. Measured in the dev container: a
      // pipe and a socket both read `O_NONBLOCK` after, and a regular file does not need it.
      void process.stdout;
      (globalThis as Record<symbol, unknown>)[PROCESS_LOG_OUTPUT] = this;
    }
  }

  /** pino's destination contract: one line, already serialised. */
  write(line: string): boolean {
    const data = Buffer.from(line, 'utf8');
    if (this.#broken || this.#backlog + data.length > this.#max) {
      this.#dropped(1, data.length);
      return true;
    }
    this.#held.push(data);
    this.#backlog += data.length;
    // Behind already: the retry takes it in order. Never ahead of what is held.
    if (this.#retry === undefined) this.#pump();
    return true;
  }

  stats(): LogOutputStats {
    return {
      droppedLines: this.#droppedLines,
      droppedBytes: this.#droppedBytes,
      backlogBytes: this.#backlog,
    };
  }

  /**
   * Everything held, written before the process goes, for at most `budgetMs` (`P-216` part 3).
   *
   * Waits on a stalled output — this is the exit, and the last line is the one that says why —
   * but not for ever: a journal that stays stopped would otherwise hold the exit until systemd's
   * stop timeout killed it, which reads as a hang. What is still held at the end is counted.
   *
   * **pino calls this too, on every `fatal` line**, with no budget, so the default applies. The
   * only `fatal` lines are `Lifecycle`'s uncaught exception and unhandled rejection, each followed
   * at once by the shutdown, so the wait is the exit's own begun a moment early. A `fatal` line
   * anywhere else would hold the thread for up to two seconds on a stalled journal.
   */
  flushSync(budgetMs: number = LOG_EXIT_FLUSH_MS): void {
    if (this.#retry !== undefined) {
      clearTimeout(this.#retry);
      this.#retry = undefined;
    }
    const deadline = performance.now() + budgetMs;
    const nap = new Int32Array(new SharedArrayBuffer(4));
    while (this.#drain() === 'stalled') {
      if (performance.now() >= deadline) {
        this.#dropped(heldLines(this.#held), this.#backlog);
        this.#held = [];
        this.#backlog = 0;
        return;
      }
      Atomics.wait(nap, 0, 0, EXIT_RETRY_MS);
    }
  }

  /**
   * Flushes on every way the process can end: `process.exit`, an uncaught exception, and the
   * event loop running dry. Idempotent.
   *
   * One hook on `exit` covers all three. `Lifecycle` ends a signal and a crash with
   * `process.exit`, a start-up failure calls it directly, and an exception nobody catches runs
   * `exit` listeners too. What it cannot cover is a `SIGKILL`, which runs nothing.
   */
  flushOnExit(budgetMs: number = LOG_EXIT_FLUSH_MS): void {
    if (this.#exitHooked) return;
    this.#exitHooked = true;
    process.once('exit', () => {
      this.flushSync(budgetMs);
    });
  }

  #pump(): void {
    if (this.#drain() !== 'stalled' || this.#retry !== undefined) return;
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      this.#pump();
    }, RETRY_MS);
    // A backlog does not keep a process alive: the exit hook writes it.
    this.#retry.unref();
  }

  /** Writes what the output will take. */
  #drain(): 'done' | 'stalled' | 'broken' {
    while (this.#held.length > 0) {
      const chunk = this.#next();
      let written: number;
      try {
        written = this.#write(this.#fd, chunk);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EINTR') return 'stalled';
        this.#break(code ?? String(error));
        return 'broken';
      }
      this.#backlog -= written;
      if (written < chunk.length) {
        this.#held[0] = chunk.subarray(written);
      } else {
        this.#held.shift();
      }
    }
    return 'done';
  }

  /** The front of the queue as one buffer of at most `MAX_WRITE_BYTES`, merged in place. */
  #next(): Buffer {
    const first = this.#held[0] as Buffer;
    if (this.#held.length === 1 || first.length >= MAX_WRITE_BYTES) return first;
    let size = 0;
    let count = 0;
    for (const chunk of this.#held) {
      if (count > 0 && size + chunk.length > MAX_WRITE_BYTES) break;
      size += chunk.length;
      count += 1;
    }
    if (count === 1) return first;
    const merged = Buffer.concat(this.#held.slice(0, count), size);
    this.#held.splice(0, count, merged);
    return merged;
  }

  /**
   * The output is gone — `EPIPE` when the reader closed it, `EBADF` when there is no descriptor.
   * Every line from here is dropped and counted, and standard error is told once.
   */
  #break(code: string): void {
    this.#broken = true;
    this.#dropped(heldLines(this.#held), this.#backlog);
    this.#held = [];
    this.#backlog = 0;
    this.#failed(`log output failed (${code}); later lines are dropped and counted\n`);
  }

  #dropped(lines: number, bytes: number): void {
    this.#droppedLines += lines;
    this.#droppedBytes += bytes;
  }
}

/**
 * How many lines a backlog holds. Not how many buffers: the front ones are merged for writing, and
 * the first may be the rest of a line the output took part of. Every line pino writes ends in a
 * newline, and none has one inside it, since JSON escapes them.
 */
function heldLines(held: readonly Buffer[]): number {
  let lines = 0;
  for (const chunk of held) {
    for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, at + 1)) lines += 1;
  }
  return lines;
}

/**
 * One line to a descriptor, synchronously, waiting at most `budgetMs` for a stalled one.
 *
 * For the lines written just before `process.exit` with no logger to write them: a configuration
 * refusal (exit 78) and a start-up failure. `process.stderr.write` on a stalled pipe queues the
 * line and returns, and the exit a moment later discards it — which leaves `systemctl status`
 * saying the unit exited 78 and nothing about why.
 */
export function writeLineSync(
  fd: number,
  line: string,
  budgetMs: number = LOG_EXIT_FLUSH_MS,
  write: (fd: number, data: Buffer) => number = writeSync,
): boolean {
  if (fd === 2) {
    // The same side effect as `LogOutput`'s: a pipe on fd 2 stops blocking once this is touched.
    void process.stderr;
  }
  let data = Buffer.from(line, 'utf8');
  const deadline = performance.now() + budgetMs;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  while (data.length > 0) {
    try {
      data = data.subarray(write(fd, data));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK' && code !== 'EINTR') return false;
      if (performance.now() >= deadline) return false;
      Atomics.wait(nap, 0, 0, EXIT_RETRY_MS);
    }
  }
  return true;
}
