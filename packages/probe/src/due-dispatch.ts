import type { SensorAssignment } from '@ms/shared';
import type { ReceivedBatch } from '@ms/sensors';
import type { CheckRequest } from './runner/types.js';
import type { SubmitOutcome } from './runner/pool.js';

/**
 * What the wheel does with a tick's worth of due sensors (`P-57`).
 *
 * **Extracted for the same reason `P-43` extracted the config handlers, after the same thing
 * happened again.** `P-41` and `P-42` were policy written inline in `main()` where no test could
 * reach it; `P-43` moved the config path out and said plainly that construction and the *dispatch*
 * path were still uncovered. `P-57` is a defect in the dispatch path — found by an audit rather
 * than by a test, because there was no test that could have found it.
 *
 * The policy here is small and entirely about ordering:
 *
 * - a sensor with no assignment is skipped, because a tick can outlive a removal;
 * - a sensor type marked isolated goes to the child-process runner, everything else to the pool;
 * - a listener sensor is handed what arrived since its last scan **only if the runner will take
 *   the check**, because draining is destructive.
 *
 * That last one is the whole of `P-57`. `NotificationRing.drain` advances the cursor whether or
 * not the caller does anything with what it returns, so draining first and submitting second lost
 * the batch every time the runner answered `already-running` — which is the ordinary answer, not a
 * rare one: skipping while the previous scan is still going is the rule (`WORKFLOW.MD §3`), and a
 * syslog sensor in the middle of a flood is exactly the sensor whose previous scan is still going.
 * The messages were gone and `drain` had reported none missing, which is `P-42`'s shape again.
 *
 * The submit happens either way, so a deferral is still counted and still reaches Probe Health.
 * What changes is that the ring keeps its messages for the next scan.
 */

/** Just enough of `CheckPool` and `ProcessRunner`. */
export interface DueRunner {
  /** `submit`'s rule without `submit`'s counters, so asking costs nothing. */
  accepts(sensorId: number): boolean;
  submit(request: CheckRequest): SubmitOutcome;
}

/** Just enough of `TrapListener` and `SyslogListener`. */
export interface DueListener {
  /**
   * `windowMs` is the sensor's interval, and required: it is how far back a sensor's first scan
   * after a probe restart reads (`P-254`), and a caller that forgot it would hand that scan
   * everything since the listener started — hours, after a long wait for the core — as one
   * reading.
   */
  drain(sensorId: number, windowMs: number): ReceivedBatch;
}

export interface DueDispatchDeps {
  assignments: { get(sensorId: number): SensorAssignment | undefined };
  /** Sensor type to the id of the listener that feeds it. */
  listenerFor: ReadonlyMap<string, string>;
  /** Listener id to the listener. A listener the operator disabled is simply absent. */
  listeners: ReadonlyMap<string, DueListener>;
  /** Sensor types that run in a child process rather than a worker. */
  isolated: ReadonlySet<string>;
  pool: DueRunner;
  processRunner: DueRunner;
  /**
   * Told which checks a runner actually accepted (`P-76`).
   *
   * Only `accepted`: a deferral or a refusal was never dispatched, so it is not outstanding and
   * counting it would make backpressure look like a stall. The outcome is already returned here
   * and was already being discarded — this is the one place that knows.
   */
  /**
   * Told which runner accepted each check (`P-82`), and **required** (`P-111`).
   *
   * Optional was the wrong shape: `CheckFlowWatchdog` judges each runner against its own
   * completions, and this is the only place that knows which runner a check went to. Deleting the
   * one line in `main()` that passes it compiled, ran, and left every check-flow test green —
   * because they pass the label themselves. A caller that genuinely has nobody to tell can say so
   * with an empty function; the point is that it has to say it.
   */
  onDispatch: (sensorId: number, timeoutMs: number, runner: 'pool' | 'process') => void;
}

export function dueDispatcher(deps: DueDispatchDeps): (due: Iterable<number>) => void {
  return (due) => {
    for (const sensorId of due) {
      const assignment = deps.assignments.get(sensorId);
      if (assignment === undefined) continue;

      const isolated = deps.isolated.has(assignment.sensorType);
      const runner = isolated ? deps.processRunner : deps.pool;

      // The drain is a slice of a ring buffer — O(what arrived) and no I/O — so it is safe on the
      // wheel's own thread, which must never wait for anything. Asking first costs a Set lookup.
      const wants = deps.listenerFor.get(assignment.sensorType);
      const listener = wants === undefined ? undefined : deps.listeners.get(wants);
      const received =
        listener !== undefined && runner.accepts(sensorId)
          ? listener.drain(sensorId, assignment.intervalSeconds * 1_000)
          : undefined;

      const outcome = runner.submit({
        sensorId,
        sensorType: assignment.sensorType,
        target: assignment.target,
        params: assignment.params,
        ...(assignment.credentials === undefined ? {} : { credentials: assignment.credentials }),
        ...(received === undefined ? {} : { received }),
        timeoutMs: assignment.timeoutMs,
      });
      // Which runner took it, because both settle into one sink and only here knows (`P-82`).
      if (outcome === 'accepted') {
        deps.onDispatch(sensorId, assignment.timeoutMs, isolated ? 'process' : 'pool');
      }
    }
  };
}
