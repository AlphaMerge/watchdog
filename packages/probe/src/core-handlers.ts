import type { Logger } from 'pino';
import type { IdentifyJob, ProbeQuery, SweepJob } from '@ms/shared';
import type { ConfigUpdate } from './scheduler/assignments.js';
import type { LinkState, QueryCommand, SweepCommand } from './transport/core-client.js';

/**
 * What the probe *does* when the core says something, separated from what it is built out of
 * (`P-43`).
 *
 * **Filed from two bugs, not from taste.** `P-41` and `P-42` are the same defect — a decision
 * derived from `AssignmentStore` on every config message instead of once the push has settled —
 * they were four lines apart, and neither fix could be pinned by a test because both lived inside
 * a five-hundred-line `main()` that nothing imports. The same blindness is why `P-42`'s other
 * half, a syslog listener whose cursors were never swept at all, survived unnoticed from `T-20`.
 *
 * So the split is: `main()` builds the collaborators and owns their lifecycles; this owns the
 * policy — what runs per message, what waits for the push to settle, which listeners are swept.
 * Everything here takes its collaborators as parameters and none of them is constructed, which is
 * the whole point: a test hands it fakes and asserts on the order of what happened.
 *
 * The dependencies are declared structurally rather than as the classes themselves. A test should
 * not have to build a `TrapListener` to assert that both listeners were swept.
 */

/** Just enough of `AssignmentStore`. */
export interface Assignments {
  apply(update: ConfigUpdate): number;
  ids(): number[];
}

/** Anything holding ring cursors keyed by sensor: `TrapListener` and `SyslogListener` both do. */
export interface CursorSweeper {
  retain(sensorIds: Iterable<number>): void;
}

/** `SweepRunner` and `IdentifyRunner` share this shape; the job type is what differs. */
export interface JobRunner<TJob> {
  start(job: TJob): void;
  cancel(runId: number): void;
}

export interface CoreHandlerDeps {
  logger: Logger;
  assignments: Assignments;
  /**
   * Every listener whose cursors follow the assignment set (`P-42`).
   *
   * A list rather than two named fields, because the bug was that one of two identical listeners
   * was wired and the other was not. A caller that forgets one now forgets it visibly, in the
   * composition root, next to the other.
   */
  listeners: readonly CursorSweeper[];
  /** Recompute the derived pool ceiling (`P-34`). A no-op when `workerPoolSize` is set. */
  sizePool: () => void;
  /** The backlog is the first thing to move once the link is back. */
  wakeDrain: () => void;
  sweeps: JobRunner<SweepJob>;
  identifications: JobRunner<IdentifyJob>;
  queries: {
    run(queryId: string, query: ProbeQuery, timeoutMs: number): void;
    cancel(queryId: string): void;
  };
  /**
   * How long after the last config message a push is taken to be complete (`P-41`).
   *
   * A push arrives in a burst, so a couple of seconds after the last message is both a complete
   * picture and far faster than waiting for the thirty-second timer. Injected so a test does not
   * have to wait two seconds to observe the thing being tested.
   */
  settleMs?: number;
}

/**
 * Declared as properties holding functions rather than as methods, which is what they are: each
 * is a closure over the deps and none touches `this`. That is also what lets the composition root
 * hand them to the client as `onConfig: handlers.onConfig` without wrapping every one in an arrow.
 */
export interface CoreHandlers {
  readonly onStateChange: (state: LinkState) => void;
  /** `final` is false on a chunk of a split push that is not its last; absent means final. */
  readonly onConfig: (update: ConfigUpdate, final?: boolean) => number;
  readonly onSweep: (message: SweepCommand) => void;
  readonly onQuery: (message: QueryCommand) => void;
  /** Cancels a settle that has not fired. For shutdown. */
  readonly stop: () => void;
}

export const DEFAULT_SETTLE_MS = 2_000;

export function coreHandlers(deps: CoreHandlerDeps): CoreHandlers {
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
  let settling: NodeJS.Timeout | undefined;
  /** Whether the last config message completed its push. */
  let complete = true;

  /**
   * Everything that must read the assignment store *after* a push has finished arriving.
   *
   * **A full push is not one message.** `P-28` sends it as a `config-set` followed by deltas, and
   * `AssignmentStore` treats a set as authoritative — so between the first chunk and the last the
   * store legitimately holds a *fraction* of this probe's sensors. Two consumers read it, and
   * both are wrong per message:
   *
   * - **The pool sizer** reads a workload that does not exist: a probe holding a ceiling of 128
   *   sees the first chunks derive 64, and since `P-40` two such readings are a drop while since
   *   `P-39` a drop sheds at once. The workers are destroyed and asked for again three chunks
   *   later.
   * - **The cursor sweep** loses data rather than time, which is worse. `retain` deletes the ring
   *   cursor of every sensor absent from the set it is handed, and a sensor whose cursor is gone
   *   is indistinguishable from one that has never drained — `drain` registers it afresh at the
   *   current sequence and returns an empty batch with `dropped: 0`. Mid-push that is every trap
   *   and syslog sensor outside chunk one, so an ordinary push would discard their buffered
   *   notifications *and report none missing* (`P-42`).
   *
   * **And a push that stopped arriving is not one that finished** (`P-254`). Two seconds of quiet
   * also follows a link that dropped between chunks, leaving the store holding chunk one. A sweep
   * then would delete the cursors of every sensor in the chunks never delivered — `P-42` again —
   * and the listeners take the first set they are swept with as what the probe held across a
   * restart, so those sensors would come back on the reconnect's push as new and miss what
   * arrived before their first scan. So the sweep waits for a message that completes its push;
   * the reconnect sends the whole set again, because the cut push was never stamped (`R18`).
   * Sizing the pool is not deferred: it reads the workload the scheduler is actually running.
   */
  const settle = (): void => {
    if (settling !== undefined) clearTimeout(settling);
    settling = setTimeout(() => {
      settling = undefined;
      if (complete) {
        // One sorted copy of up to five thousand ids, not one per listener.
        const held = deps.assignments.ids();
        for (const listener of deps.listeners) listener.retain(held);
      }
      deps.sizePool();
    }, settleMs);
    settling.unref();
  };

  return {
    onStateChange: (state) => {
      deps.logger.info({ linkState: state }, 'link state changed');
      if (state === 'connected') deps.wakeDrain();
    },

    onConfig: (update, final = true) => {
      const size = deps.assignments.apply(update);
      complete = final;
      // The workload just changed, so both the ceiling derived from it (`P-34`) and the set of
      // cursors worth keeping are stale. Recomputed after a push rather than only on the timer,
      // because a push is exactly when a probe goes from fifty sensors to five thousand and
      // discovering that a tick later is a tick of backlog — but *after* the push, not during
      // (`P-41`, `P-42`).
      settle();
      return size;
    },

    onSweep: (message) => {
      switch (message.kind) {
        case 'start':
          deps.sweeps.start(message.job);
          return;
        case 'cancel':
          deps.sweeps.cancel(message.runId);
          return;
        case 'identify':
          deps.identifications.start(message.job);
          return;
        case 'identify-cancel':
          deps.identifications.cancel(message.runId);
          return;
      }
    },

    onQuery: (message) => {
      switch (message.kind) {
        case 'run':
          deps.queries.run(message.queryId, message.query, message.timeoutMs);
          return;
        case 'cancel':
          deps.queries.cancel(message.queryId);
          return;
      }
    },

    stop: () => {
      if (settling !== undefined) clearTimeout(settling);
      settling = undefined;
    },
  };
}
