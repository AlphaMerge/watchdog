import { parentPort, workerData } from 'node:worker_threads';
import { UNKNOWN_SENSOR_TYPE, type CheckRegistry, type CheckTarget } from './types.js';

/**
 * A pool worker.
 *
 * One check at a time — the pool guarantees it — and every check gets its own `AbortController`
 * so a timeout can ask before the pool tells. The registry is imported by path rather than
 * bundled, which is what lets a test drive the pool with checks that hang and crash on purpose
 * without either behaviour living in shipped code.
 */

interface RunMessage {
  type: 'run';
  jobId: string;
  sensorId: number;
  sensorType: string;
  target: CheckTarget;
  params: Record<string, unknown>;
}

interface AbortMessage {
  type: 'abort';
  jobId: string;
}

/* c8 ignore next 2 -- a worker without a parent port cannot have been started by the pool */
if (parentPort === null) throw new Error('check worker started outside a worker thread');
const port = parentPort;

const { registryModule } = workerData as { registryModule: string };

// Top-level await: the port buffers anything the pool sends before the listener is attached, so
// a slow import delays the first check rather than losing it. An import that *fails* takes the
// worker down, which the pool sees as an early exit and reports rather than retrying for ever.
const registry = ((await import(registryModule)) as { default: CheckRegistry }).default;

const running = new Map<string, AbortController>();

port.on('message', (message: RunMessage | AbortMessage) => {
  if (message.type === 'abort') {
    running.get(message.jobId)?.abort(new Error('the check exceeded its timeout'));
    return;
  }
  void run(message);
});

async function run(message: RunMessage): Promise<void> {
  const controller = new AbortController();
  running.set(message.jobId, controller);
  const startedAt = process.hrtime.bigint();

  try {
    const execution = await registry.execute(message.sensorType, {
      sensorId: message.sensorId,
      target: message.target,
      params: message.params,
      signal: controller.signal,
    });
    port.postMessage({
      type: 'result',
      jobId: message.jobId,
      durationMs: elapsed(startedAt),
      ok: true,
      channels: execution.channels,
      message: execution.message ?? '',
    });
  } catch (error: unknown) {
    port.postMessage({
      type: 'result',
      jobId: message.jobId,
      durationMs: elapsed(startedAt),
      ok: false,
      aborted: controller.signal.aborted,
      unknownType: (error as { code?: unknown } | null)?.code === UNKNOWN_SENSOR_TYPE,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    running.delete(message.jobId);
  }
}

function elapsed(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

port.postMessage({ type: 'ready' });
