import type { AuditSink } from './audit.js';

/**
 * Which sinks each of the three audited services composes (`P-111`).
 *
 * **Extracted because a sink in an array cannot be guarded by a type.** Every other piece of
 * wiring in `main()` that something depends on is now a required parameter, so deleting it fails
 * the build — that is what already protects `reconcilesReadings`, `ingestionDiscards` and, since
 * this ticket, the assignment listeners and the pause message source. An element of an
 * `AuditSink[]` has no such protection: `reachabilitySync` was deleted from the object service's
 * list and all 2,118 core tests stayed green, silently reverting `P-103`.
 *
 * The parameters are required, so a new sink cannot be forgotten at a call site, and the
 * membership of each list is asserted by `audit-composition.test.ts` — so removing one from the
 * list fails there rather than in production six months later.
 *
 * **The three lists differ on purpose**, and the differences are the interesting part:
 *
 * - The **trigger library** gets no configuration notifier: a trigger decides who is told about a
 *   sensor, not what a probe scans, so pushing one to every probe is churn for a change none of
 *   them can act on.
 * - The **schedule library** gets no cache invalidator and no trigger sync: a schedule edit moves
 *   pause flags, and neither the result cache nor an alarm chain reads a schedule.
 * - Only the **object service** gets `reachabilitySync`, because only object mutations move
 *   sensors between probes.
 */
export interface AuditSinkSet {
  readonly database: AuditSink;
  readonly logging: AuditSink;
  readonly configNotifier: AuditSink;
  readonly cacheInvalidator: AuditSink;
  readonly scheduleSync: AuditSink;
  readonly dependencySync: AuditSink;
  readonly reachabilitySync: AuditSink;
  readonly triggerSync: AuditSink;
}

/** Every mutation of the tree: probes, groups, devices, sensors, settings, pauses. */
export function objectAuditSinks(all: AuditSinkSet): AuditSink[] {
  return [
    all.database,
    all.logging,
    all.configNotifier,
    all.cacheInvalidator,
    all.scheduleSync,
    all.dependencySync,
    // Only here: a move, a create, a clone or a delete is what changes which probe carries a
    // sensor, and a stale unreachable overlay outlives the tree it was taken from (`P-103`).
    all.reachabilitySync,
    all.triggerSync,
  ];
}

/** Editing the schedule library itself, which moves pause flags and nothing else. */
export function scheduleAuditSinks(all: AuditSinkSet): AuditSink[] {
  return [all.database, all.logging, all.configNotifier, all.scheduleSync, all.dependencySync];
}

/** Editing the trigger library, which changes who is notified and not what is scanned. */
export function triggerAuditSinks(all: AuditSinkSet): AuditSink[] {
  return [all.database, all.logging, all.triggerSync];
}
