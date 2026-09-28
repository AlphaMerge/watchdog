import { describeError, type CheckResult, type Logger } from '@ms/shared';
import type { ResultMeta } from './runner/types.js';
import { SpoolClosedError } from './spool/spool.js';

/**
 * Where every settled check goes, whichever runner settled it (`P-83`).
 *
 * **Extracted from `main()` because the property that matters here was untestable inside it.**
 * `CheckFlowWatchdog.completed(sensorId)` takes no outcome, so a test at the watchdog can only
 * call it and watch a counter — it would pass identically against a `completed` that ignored
 * outcomes, which is what it has. The real rule is the *unconditional* call below: an error is a
 * completion, because the runner came back. Wrapping this line in `if (result.outcome === 'ok')`
 * left the whole suite green while a probe watching a network segment that had gone down reported
 * nothing but errors, froze the stall clock, and raised a Warning for monitoring correctly and
 * reporting bad news — on top of the sensors' own Down alarms, which is the second alarm for one
 * outage that `CLAUDE.md` forbids.
 *
 * Same shape as `P-43`'s extraction of the config handlers, and for the same reason: a rule that
 * lives inside `main()` is a rule nothing can assert.
 */
export interface ResultSinkDeps {
  readonly logger: Logger;
  /** The spool. Only `append` is used; the drain owns everything else. */
  readonly spool: { append(results: readonly CheckResult[]): Promise<void> };
  /** Woken so a result is offered immediately when the core is reachable. */
  readonly drain: { wake(): void };
  /** Told every settled check, so `checksCompleting` means what it says (`P-76`). */
  readonly checkFlow: { completed(sensorId: number): void };
}

/** What the sink did not spool, and why. Both are counts because both are losses. */
export interface ResultSinkStats {
  /**
   * Checks a stopping runner cut off (`pool-stopped`), deliberately not spooled.
   *
   * Not a reading of the device: "probe is stopping" is the probe's own state, and spooling it
   * would hand the core one failed scan per in-flight check on every restart — a Down, and an
   * alarm, for a device nobody touched. The query runner re-labels the same phase for the same
   * reason (`R-09`).
   */
  abandoned: number;
  /** Results that arrived once the spool had closed, so nothing could hold them. */
  unspooled: number;
}

export interface ResultSink {
  (result: CheckResult, meta: ResultMeta): void;
  /**
   * Stops handing results to the spool, and says what it has not spooled so far. What arrives
   * later is counted too, so a summary reads `stats()` after the spool has closed.
   *
   * Called immediately before `spool.close()`, so no append the sink starts can reach a spool
   * that is closed: everything already on the spool's write chain is finished by `close`, and
   * anything later is counted here rather than refused there.
   */
  close(): ResultSinkStats;
  stats(): ResultSinkStats;
}

export function resultSink(deps: ResultSinkDeps): ResultSink {
  let closed = false;
  const counts: ResultSinkStats = { abandoned: 0, unspooled: 0 };
  let reportedLate = false;

  // **Logged once, counted always.** Results that miss a closed spool come in a burst — every
  // worker still delivering — and forty-five identical errors in a second is one fact repeated,
  // not forty-five. The total goes in the shutdown summary `main.ts` logs from `stats()` once the
  // spool has closed.
  const late = (sensorId: number): void => {
    counts.unspooled += 1;
    if (reportedLate) return;
    reportedLate = true;
    deps.logger.warn(
      { sensorId },
      'a check result arrived after the result spool closed; counting any more rather than logging each',
    );
  };

  const sink = (result: CheckResult, meta: ResultMeta): void => {
    // **However it ended.** An error is a completion — the runner came back, and a probe reporting
    // nothing but failures is monitoring and telling the truth, not stalled. Unconditional, and
    // first: a `spool.append` that throws synchronously must not cost the watchdog its evidence.
    deps.checkFlow.completed(result.sensorId);
    deps.logger.debug(
      { sensorId: result.sensorId, outcome: result.outcome, phase: meta.phase },
      'check finished',
    );
    if (meta.phase === 'pool-stopped') {
      counts.abandoned += 1;
      return;
    }
    if (closed) {
      late(result.sensorId);
      return;
    }
    // Straight to disk, then woken so the drain offers it immediately if the core is up.
    // The pool's callback is synchronous and must not wait for a write: `append` serialises
    // internally, so ordering holds without the scheduler ever blocking on the filesystem.
    void deps.spool
      .append([result])
      .then(() => {
        deps.drain.wake();
      })
      .catch((error: unknown) => {
        // Only reachable if something closed the spool without closing this first — the order
        // `main.ts` registers its hooks in is what prevents it — and counted the same way.
        if (error instanceof SpoolClosedError) {
          late(result.sensorId);
          return;
        }
        // A spool that cannot write is a probe that will lose readings, and the only thing worse
        // than losing them is losing them quietly. The count is `ResultSpool`'s own (`P-78`).
        deps.logger.error(
          { ...describeError(error), sensorId: result.sensorId },
          'could not spool a result',
        );
      });
  };

  return Object.assign(sink, {
    close: (): ResultSinkStats => {
      closed = true;
      return { ...counts };
    },
    stats: (): ResultSinkStats => ({ ...counts }),
  });
}
