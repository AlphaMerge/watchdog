import { spawn, type ChildProcess } from 'node:child_process';

export interface ProgramRunOptions {
  /** An absolute path to the program. Resolving and containing it is the caller's job. */
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /**
   * The child's **whole** environment, not a patch over this process's.
   *
   * Deliberately not a patch. A monitoring service holds an SMTP password, a database URL and
   * whatever else arrived through `MS_*` overrides, and handing all of it to a script somebody
   * dropped in a directory is how a credential leaves the machine. The caller states what the
   * program gets.
   */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Bytes kept per stream. Reading continues past it; only the keeping stops. */
  readonly maxOutputBytes: number;
  /** Written to the child's stdin, which is then closed. */
  readonly stdin?: string;
  /** POSIX only, and only possible when this process has the privilege to do it. */
  readonly uid?: number;
  readonly gid?: number;
  /** How long a timed-out program is given to end on `SIGTERM` before `SIGKILL`. */
  readonly graceMs?: number;
  /**
   * Ends the program early, the way its deadline would, and it is reported as a `timeout`
   * (`P-227`) with `endedBy: 'signal'`. The caller that aborted knows why. What the program
   * started goes with it.
   */
  readonly signal?: AbortSignal;
  /**
   * Each chunk of stdout as it arrives, whether or not it is kept (`P-260`).
   *
   * For a caller that has to act on what a program says before it ends: the probe's check
   * process says when it is ready to run its check, and the probe's clock for that check starts
   * there. Called past `maxOutputBytes` as well, because the bound is on keeping, not reading.
   */
  readonly onStdout?: (chunk: Buffer) => void;
}

interface ProgramOutput {
  readonly stdout: string;
  readonly stderr: string;
  /** True when either stream produced more than `maxOutputBytes` and was cut. */
  readonly truncated: boolean;
  readonly durationMs: number;
}

/**
 * How a run ended.
 *
 * A discriminated union rather than an exit code and some optional fields, because the four cases
 * mean genuinely different things to a caller: a non-zero exit is the program's own answer, a
 * timeout is ours, a signal is somebody else's, and a spawn failure means it never ran at all.
 */
export type ProgramRun =
  | ({ readonly outcome: 'exited'; readonly code: number } & ProgramOutput)
  | ({ readonly outcome: 'signalled'; readonly signal: string } & ProgramOutput)
  | ({
      readonly outcome: 'timeout';
      readonly hardKilled: boolean;
      /**
       * Which of the two ended it (`P-262`): `timeoutMs`, or the caller's `signal`. Whichever came
       * first, and only that one: the other arriving while the program is being stopped does not
       * change the answer, so a caller can say which limit the program ran into.
       */
      readonly endedBy: 'deadline' | 'signal';
      /**
       * How long the program had run when that limit came, in ms. Not `durationMs`, which is
       * taken once it has ended and so holds the grace and the stopping as well: a program asked
       * to stop at 10 s that ignores `SIGTERM` for 5 s has a `durationMs` of 15 s.
       */
      readonly endedAfterMs: number;
    } & ProgramOutput)
  | ({
      readonly outcome: 'failed';
      readonly code: string;
      readonly message: string;
    } & ProgramOutput);

const DEFAULT_GRACE_MS = 5_000;

/**
 * Runs a program, bounded in every direction it could be unbounded in.
 *
 * Shared rather than written where it is used, because two subsystems need exactly this and
 * neither should have its own version of it: `N-10`'s execute-program notification method, and
 * `P-03`/`T-19`'s shell-outs and user scripts on the probe.
 *
 * **Never through a shell.** `spawn` with an argv array, `shell: false`, always. A notification
 * argument carries `%lastmessage`, a check message is whatever a monitored device said, and a
 * shell would turn `; rm -rf /` in a device's SNMP description into a command. This is the whole
 * of the argument-injection defence and it is one word.
 *
 * **The process group, not the process.** `detached: true` makes the child a group leader on
 * POSIX so a timeout kills whatever it started as well; a script that backgrounds `curl` and
 * exits would otherwise leave it running for ever. Windows has no process groups to signal, so
 * the tree is taken down with `taskkill /T` instead — the same intention through the only
 * mechanism the platform offers.
 *
 * **Output is bounded but still drained.** A program that writes a gigabyte must not be buffered,
 * and must not be left blocked on a full pipe either — that would turn a chatty program into a
 * hang. So reading continues after the limit and only the keeping stops.
 */
export async function runProgram(options: ProgramRunOptions): Promise<ProgramRun> {
  const startedAt = process.hrtime.bigint();
  const elapsed = (): number => Number((process.hrtime.bigint() - startedAt) / 1_000_000n);

  let child: ChildProcess;
  try {
    child = spawn(options.file, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      // A new process group, so a timeout can take down what the program started as well.
      detached: process.platform !== 'win32',
      windowsHide: true,
      ...(options.uid === undefined ? {} : { uid: options.uid }),
      ...(options.gid === undefined ? {} : { gid: options.gid }),
    });
  } catch (error: unknown) {
    // `spawn` throws synchronously for an invalid uid or gid, and emits an error for the rest.
    return { outcome: 'failed', ...describeSpawnError(error), ...empty(elapsed()) };
  }

  const stdout = new BoundedSink(options.maxOutputBytes);
  const stderr = new BoundedSink(options.maxOutputBytes);
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout.push(chunk);
    options.onStdout?.(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk);
  });

  if (child.stdin !== null) {
    // A program that does not read stdin closes it, and writing to it raises EPIPE. That is the
    // program's prerogative, not a delivery failure.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.stdin ?? '');
  }

  return new Promise<ProgramRun>((resolve) => {
    let settled = false;
    let timedOut = false;
    let hardKilled = false;
    let endedBy: 'deadline' | 'signal' = 'deadline';
    let endedAfterMs = 0;

    const grace = options.graceMs ?? DEFAULT_GRACE_MS;
    let hardTimer: NodeJS.Timeout | undefined;
    const end = (by: 'deadline' | 'signal'): void => {
      if (timedOut || settled) return;
      timedOut = true;
      endedBy = by;
      endedAfterMs = elapsed();
      terminate(child, 'SIGTERM');
      // Asked to stop, then made to. A program that ignores SIGTERM is exactly the one a hard
      // timeout exists for.
      hardTimer = setTimeout(() => {
        hardKilled = true;
        terminate(child, 'SIGKILL');
      }, grace);
    };
    const deadline = setTimeout(() => {
      end('deadline');
    }, options.timeoutMs);
    const aborted = (): void => {
      end('signal');
    };
    options.signal?.addEventListener('abort', aborted, { once: true });
    if (options.signal?.aborted === true) end('signal');

    const finish = (run: ProgramRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (hardTimer !== undefined) clearTimeout(hardTimer);
      options.signal?.removeEventListener('abort', aborted);
      resolve(run);
    };

    const output = (): ProgramOutput => ({
      stdout: stdout.text(),
      stderr: stderr.text(),
      truncated: stdout.truncated || stderr.truncated,
      durationMs: elapsed(),
    });

    child.on('error', (error: unknown) => {
      finish({ outcome: 'failed', ...describeSpawnError(error), ...output() });
    });

    // `close` rather than `exit`: the process has ended *and* its pipes have been read to the
    // end. Resolving on `exit` loses whatever the program wrote just before it finished, which
    // is usually the line explaining why it failed.
    child.on('close', (code: number | null, signal: string | null) => {
      if (timedOut) {
        finish({ outcome: 'timeout', hardKilled, endedBy, endedAfterMs, ...output() });
        return;
      }
      if (signal !== null) {
        finish({ outcome: 'signalled', signal, ...output() });
        return;
      }
      finish({ outcome: 'exited', code: code ?? 0, ...output() });
    });
  });
}

/** Ends the program and anything it started. */
function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      // No process groups to signal. `taskkill /T` walks the tree, which is the same intention.
      if (signal === 'SIGKILL') spawn('taskkill', ['/pid', String(pid), '/T', '/F']).unref();
      else child.kill(signal);
      return;
    }
    // The negative pid is the group, which is why the child was spawned detached.
    process.kill(-pid, signal);
  } catch {
    // ESRCH: it ended between the timer firing and the signal. Nothing to do.
  }
}

function describeSpawnError(error: unknown): { code: string; message: string } {
  const errno = error as NodeJS.ErrnoException;
  return {
    code: typeof errno.code === 'string' ? errno.code : 'UNKNOWN',
    message: typeof errno.message === 'string' ? errno.message : String(error),
  };
}

function empty(durationMs: number): ProgramOutput {
  return { stdout: '', stderr: '', truncated: false, durationMs };
}

/** Keeps the first `limit` bytes of a stream and counts the rest away. */
class BoundedSink {
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  #size = 0;
  truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Buffer): void {
    if (this.#size >= this.#limit) {
      this.truncated = true;
      return;
    }
    const room = this.#limit - this.#size;
    if (chunk.length > room) {
      this.#chunks.push(chunk.subarray(0, room));
      this.#size = this.#limit;
      this.truncated = true;
      return;
    }
    this.#chunks.push(chunk);
    this.#size += chunk.length;
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString('utf8');
  }
}
