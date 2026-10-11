import { parentPort, workerData } from 'node:worker_threads';
import {
  CREDENTIALS_WITHHELD,
  UNKNOWN_SENSOR_TYPE,
  type CheckRegistry,
  type CheckTarget,
  type ReceivedBatch,
  type SessionCounters,
} from './types.js';

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
  credentials?: Record<string, Record<string, unknown>>;
  received?: ReceivedBatch;
  timeoutMs?: number;
}

interface AbortMessage {
  type: 'abort';
  jobId: string;
}

/* c8 ignore next 2 -- a worker without a parent port cannot have been started by the pool */
if (parentPort === null) throw new Error('check worker started outside a worker thread');
const port = parentPort;

const { registryModule, sessionReportMs } = workerData as {
  registryModule: string;
  /** How often an idle worker says its session pools changed (`P-256`). */
  sessionReportMs: number;
};

// Top-level await: the port buffers anything the pool sends before the listener is attached, so
// a slow import delays the first check rather than losing it. An import that *fails* takes the
// worker down, which the pool sees as an early exit and reports rather than retrying for ever. One
// that never *finishes* is the pool's to end: it terminates a worker that has not posted `ready`
// within its start-up bound, and starts another after a growing delay (`P-263`).
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
      credentials: message.credentials ?? {},
      signal: controller.signal,
      ...(message.timeoutMs === undefined ? {} : { timeoutMs: message.timeoutMs }),
      ...(message.received === undefined ? {} : { received: message.received }),
    });
    port.postMessage({
      type: 'result',
      jobId: message.jobId,
      durationMs: elapsed(startedAt),
      ok: true,
      channels: execution.channels,
      message: execution.message ?? '',
      ...sessions(),
    });
  } catch (error: unknown) {
    port.postMessage({
      type: 'result',
      jobId: message.jobId,
      durationMs: elapsed(startedAt),
      ok: false,
      aborted: controller.signal.aborted,
      unknownType: (error as { code?: unknown } | null)?.code === UNKNOWN_SENSOR_TYPE,
      withheld: (error as { code?: unknown } | null)?.code === CREDENTIALS_WITHHELD,
      message: error instanceof Error ? error.message : String(error),
      ...sessions(),
    });
  } finally {
    running.delete(message.jobId);
  }
}

function elapsed(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

/** What this worker last told the pool about its session pools. */
let reported: SessionCounters | undefined;

/**
 * This worker's session-pool counters, to ride back with the result (`P-36`).
 *
 * It costs four integers on a message that already exists. A worker running checks reports
 * this way, and `reportIdleSessions` covers the one that is not.
 *
 * Absent when the registry keeps no pools — a fixture registry, mostly — and absent means
 * absent: the pool leaves the field off rather than sending zeros, so a build with no session
 * pools gaps the channel instead of claiming a healthy nothing (`R-06`).
 */
function sessions(): { sessions?: SessionCounters } {
  const counters = registry.sessionCounters?.();
  if (counters === undefined) return {};
  reported = counters;
  return { sessions: counters };
}

/**
 * Tells the pool when this worker's session pools changed with no check running (`P-256`).
 *
 * **An idle worker's counters do change.** Each pool closes a session nobody has used for its
 * `idleMs`, on a timer of its own, and the worker that holds it is usually one that has stopped
 * being sent checks. Reported only on results, those closes were never heard: `H-15` read
 * `sessionsOpen` at 8 for 85 minutes after a device recovered, with `sessionsEvicted` flat, while
 * the workers that had taken the device's checks during its hang had long since closed them.
 * The pool dispatches to the first idle worker, so after a spike the higher ones go quiet.
 *
 * Polled rather than told, because the pools belong to the registry and a change can come from
 * any of them. Sent only when something differs from what the pool last heard, so a quiet worker
 * sends nothing.
 */
function reportIdleSessions(): void {
  const counters = registry.sessionCounters?.();
  if (counters === undefined || (reported !== undefined && same(counters, reported))) return;
  reported = counters;
  port.postMessage({ type: 'sessions', sessions: counters });
}

function same(a: SessionCounters, b: SessionCounters): boolean {
  return (
    a.open === b.open &&
    a.overflowed === b.overflowed &&
    a.evicted === b.evicted &&
    a.opened === b.opened
  );
}

// A registry that keeps no pools has nothing to report, and gets no timer.
if (registry.sessionCounters !== undefined) {
  // `unref`'d: the port is what keeps this thread alive, never the report.
  setInterval(reportIdleSessions, sessionReportMs).unref();
}

port.postMessage({ type: 'ready' });
