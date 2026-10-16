import { subscribe } from 'node:diagnostics_channel';
import { PROGRAM_GROUP_CHANNEL, type ProgramGroupEvent } from '@ms/shared/process-group';
import {
  GROUP_MARKER,
  READY_MARKER,
  RESULT_MARKER,
  CREDENTIALS_WITHHELD,
  UNKNOWN_SENSOR_TYPE,
  failureSaid,
  type CheckRegistry,
  type CheckTarget,
  type ReceivedBatch,
} from './types.js';

/**
 * One check, in a process of its own (`P-03`).
 *
 * **The request arrives on stdin, never in argv.** A `CheckRequest` carries decrypted credentials
 * (`A-05`), and argv is world-readable through `ps` on every POSIX machine — an SNMP community
 * string or a database password on the command line would be a credential this system took care
 * to encrypt at rest and then published to every local user.
 *
 * **The answer leaves on a marked line of stdout**, not as the whole of it. A sensor type must
 * never `console.log` (CLAUDE.md), but a *library* one imports can and does, and a runner that
 * parsed the whole stream would turn one stray banner from a third-party module into a check
 * that fails with "unexpected token" for ever.
 */

interface ChildRequest {
  readonly sensorType: string;
  readonly sensorId: number;
  readonly target: CheckTarget;
  readonly params: Record<string, unknown>;
  readonly credentials?: Record<string, Record<string, unknown>>;
  readonly received?: ReceivedBatch;
  readonly registryModule: string;
  readonly timeoutMs: number;
}

async function main(): Promise<void> {
  const request = JSON.parse(await readStdin()) as ChildRequest;

  // **The catalogue first, and only then the check's clock** (`P-260`). The import is the probe's
  // start-up, not the check: 21 ms on a quiet machine, and 0.45–14.8 s measured on a loaded one
  // (`P-258`). Armed before it, the abort below spent that on loading and blamed the check. The
  // parent bounds this part on its own clock, and is told on stdout when it is over.
  let registry: CheckRegistry;
  try {
    registry = ((await import(request.registryModule)) as { default: CheckRegistry }).default;
  } catch (error: unknown) {
    // No check ran, so it took no time: what the start-up took is the parent's to measure.
    emit({
      ok: false,
      durationMs: 0,
      startup: true,
      message:
        'this probe could not load its sensor types to run the check: ' +
        (error instanceof Error ? error.message : String(error)),
    });
    return;
  }
  process.stdout.write(READY_MARKER + '\n');
  const startedAt = process.hrtime.bigint();

  // The parent kills this process when the deadline passes, and that is the backstop rather than
  // the mechanism: a check must honour its signal, so it is given one that fires a little first.
  // The difference is a check that reports its own diagnosis against one that is killed and can
  // say nothing about where it got to.
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error('the check exceeded its timeout'));
  }, request.timeoutMs);
  timer.unref();
  // **The probe's `SIGTERM` is a cancel, not a death** (`P-262`). The runner sends it when the
  // probe stops and abandons a running check, and when the check outruns its timeout and margin.
  // A check that shells out puts its program in a process group of its own, which the runner's
  // kill of *this* group does not reach, so dying here at once would leave a script running with
  // nobody to end it. Aborted instead, the check ends what it started and answers; the runner's
  // `SIGKILL`, its grace later, is still there for a check that does not listen. Installed after
  // the ready line: a process still loading has started nothing, and dies as it always did.
  // `on`, not `once`: a second `SIGTERM` (a service manager signalling the whole group as well)
  // must not undo the first. The reason is the runner's two cases in one, since a signal cannot
  // say which; after the check's own timeout the controller has already aborted with that.
  process.on('SIGTERM', () => {
    controller.abort(new Error('the probe ended the check’s process'));
  });
  // **And for a check process that dies without hearing it** (`P-266`): the runner's `SIGKILL`
  // after its grace, a heap exhausted, a crash. The runner is told each group the check starts and
  // each that ends, as it happens, and ends any still open once this process has gone. Written
  // in the same turn as the spawn, so a process killed a moment later has already said it.
  subscribe(PROGRAM_GROUP_CHANNEL, (message) => {
    const { event, pgid } = message as ProgramGroupEvent;
    process.stdout.write(`${GROUP_MARKER}${event} ${String(pgid)}\n`);
  });

  try {
    const execution = await registry.execute(request.sensorType, {
      sensorId: request.sensorId,
      target: request.target,
      params: request.params,
      credentials: request.credentials ?? {},
      signal: controller.signal,
      timeoutMs: request.timeoutMs,
      ...(request.received === undefined ? {} : { received: request.received }),
    });
    emit({
      ok: true,
      durationMs: elapsed(startedAt),
      channels: execution.channels,
      message: execution.message ?? '',
    });
  } catch (error: unknown) {
    emit({
      ok: false,
      durationMs: elapsed(startedAt),
      aborted: controller.signal.aborted,
      unknownType: (error as { code?: unknown } | null)?.code === UNKNOWN_SENSOR_TYPE,
      withheld: (error as { code?: unknown } | null)?.code === CREDENTIALS_WITHHELD,
      message: error instanceof Error ? error.message : String(error),
      // Where it failed (`P-285`), copied out: JSON would keep only the message.
      failure: failureSaid(error),
    });
  }
}

function emit(payload: unknown): void {
  process.stdout.write(RESULT_MARKER + JSON.stringify(payload) + '\n');
}

function elapsed(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      text += chunk;
    });
    process.stdin.on('end', () => {
      resolve(text);
    });
    process.stdin.on('error', reject);
  });
}

await main();
// Explicit, because a check may leave a socket or a timer behind and this process has one job.
// The marked line is already written by here; `process.stdout.write` to a pipe is synchronous
// enough for a line, and the parent reads the stream to its end regardless.
process.exit(0);
