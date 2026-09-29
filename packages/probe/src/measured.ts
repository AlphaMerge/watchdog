/**
 * Numbers this project measured, in one place, because copying them is what broke (`P-35`).
 *
 * **Every constant here has already caused a defect by being duplicated.** Four in one day:
 * the scheduler benchmark modelled a three-second `icmp.ping` for a week after `P-07` measured
 * it at 600 ms (`P-31`); `defaultPoolSize()` was chosen against a 200 ms model while `P-07`'s
 * own finding recorded that the v1 target needs about 55 workers (`P-32`); `sizing.md` published
 * a worker rule whose every worked example sat under its own stability floor (`P-33`); and
 * `PLAN.md` still quoted a tree-build time that Phase 3 had invalidated.
 *
 * Nobody was careless in any of those. Each measurement was right in the file that took it. What
 * was missing is this file: a place where the number lives once, so that changing it moves — or
 * breaks — everything derived from it.
 *
 * **The rule for adding to this module.** A constant belongs here when it is a *measurement*
 * that more than one place depends on, and it must name the finding it came from. A number that
 * only one file uses stays in that file; a number nobody measured does not belong here at all.
 */

/**
 * The v1 target, from `CAPABILITIES.MD` §13: five thousand sensors on a one-minute interval.
 *
 * Not a measurement but a *commitment*, and the thing every measurement is taken against — which
 * is why it lives beside them rather than being retyped in each benchmark.
 */
export const V1_TARGET_SENSORS = 5_000;
export const V1_TARGET_INTERVAL_SECONDS = 60;

/**
 * Checks arriving per second at the v1 target — 83.3.
 *
 * The wheel fires per-second buckets, so this is a *burst* rather than a smooth rate: the whole
 * second's work is handed over at once (`docs/findings/2026-08-26-scheduler-benchmark.md`).
 */
export const V1_TARGET_BURST = V1_TARGET_SENSORS / V1_TARGET_INTERVAL_SECONDS;

/**
 * The dispatch-jitter budget, from `PLAN.md` Phase 2 and `WORKFLOW.MD` §3: a 60-second sensor
 * fires every 60 seconds ±1 s under full load. `P-15`'s gate is this number at the p95.
 */
export const DISPATCH_BUDGET_MS = 1_000;

/**
 * What one `icmp.ping` check costs, measured (`docs/findings/2026-08-29-icmp-throughput.md`).
 *
 * **This is the constant whose copies caused `P-31` and `P-32`.** It was three seconds when the
 * scheduler benchmark was written — `ping` idles a second between packets — and `P-07` passed
 * `-i 0.2`, making the same check 600 ms with identical reply counts. Three files kept the old
 * number; one of them was the pool default's justification.
 */
export const ICMP_PING_CHECK_MS = 600;

/**
 * The check duration the scheduler benchmark models by default.
 *
 * An ordinary SNMP round trip on a LAN and a fast HTTP check. Kept distinct from
 * `ICMP_PING_CHECK_MS` on purpose: this is the *model*, that is the *shipped type*, and treating
 * one as the other is exactly what `P-31` was.
 */
export const MODEL_CHECK_MS = 200;

/**
 * Headroom over the raw Little's-law requirement when sizing a pool
 * (`docs/findings/2026-09-03-pool-default.md`).
 *
 * Measured rather than chosen: at 1.12× the requirement a ping-shaped workload measured a p95 of
 * 822 ms where the tranche model predicted 600, because the queueing the model omits is still on
 * top; by 1.28× it measured 614 and the model held.
 */
export const POOL_DEMAND_MARGIN = 1.3;

/**
 * What one check worker holds resident, in MiB, when its checks wait
 * (`docs/findings/2026-09-29-probe-starvation-b.md`).
 *
 * Measured from the probe's own samples under 5,000 `port.tcp` checks that each waited out a 5 s
 * timeout: the resident size above what the probe held at five workers, divided by the workers
 * added, came to 35 MiB at 99 workers and 40 at 66. The larger, because `P-236` divides the memory
 * left by this to decide how many more workers fit, and an estimate that is low is a probe that
 * grows past its limit. An idle pool costs less, about 27 MiB a worker in `P-216`'s first run, which
 * only means the cap is conservative there.
 */
export const WORKER_RESIDENT_MIB = 40;

/**
 * Workers a workload needs merely to keep up — Little's law (`P-33`).
 *
 * A pool completes `workers / checkDuration` checks a second, so below this the backlog grows
 * for as long as the probe runs, quietly, because the queue absorbs it and nothing is refused
 * until the queue's own bound is reached. **This is the bound `sizing.md` was missing**, and
 * expressing it as a function rather than a number is the point: it is a relationship between
 * two measurements, and a relationship survives both of them changing.
 */
export function littleFloor(burst: number, checkMs: number): number {
  return (burst * checkMs) / 1_000;
}
