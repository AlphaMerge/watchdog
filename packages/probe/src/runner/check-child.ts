import {
  RESULT_MARKER,
  UNKNOWN_SENSOR_TYPE,
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

  try {
    const registry = ((await import(request.registryModule)) as { default: CheckRegistry }).default;
    const execution = await registry.execute(request.sensorType, {
      sensorId: request.sensorId,
      target: request.target,
      params: request.params,
      credentials: request.credentials ?? {},
      signal: controller.signal,
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
      message: error instanceof Error ? error.message : String(error),
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
