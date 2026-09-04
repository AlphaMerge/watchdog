import { describeError, type CheckResult, type Logger } from '@ms/shared';
import type { ResultMeta } from './runner/types.js';

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

export function resultSink(deps: ResultSinkDeps): (result: CheckResult, meta: ResultMeta) => void {
  return (result, meta) => {
    // **However it ended.** An error is a completion — the runner came back, and a probe reporting
    // nothing but failures is monitoring and telling the truth, not stalled. Unconditional, and
    // first: a `spool.append` that throws synchronously must not cost the watchdog its evidence.
    deps.checkFlow.completed(result.sensorId);
    deps.logger.debug(
      { sensorId: result.sensorId, outcome: result.outcome, phase: meta.phase },
      'check finished',
    );
    // Straight to disk, then woken so the drain offers it immediately if the core is up.
    // The pool's callback is synchronous and must not wait for a write: `append` serialises
    // internally, so ordering holds without the scheduler ever blocking on the filesystem.
    void deps.spool
      .append([result])
      .then(() => {
        deps.drain.wake();
      })
      .catch((error: unknown) => {
        // A spool that cannot write is a probe that will lose readings, and the only thing worse
        // than losing them is losing them quietly. The count is `ResultSpool`'s own (`P-78`).
        deps.logger.error(
          { ...describeError(error), sensorId: result.sensorId },
          'could not spool a result',
        );
      });
  };
}
