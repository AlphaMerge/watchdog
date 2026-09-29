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
 * - Only the **object service** gets `reachabilitySync` and `clockFreezeSync`, because only
 *   object mutations move sensors between probes.
 */
export interface AuditSinkSet {
  readonly database: AuditSink;
  readonly logging: AuditSink;
  readonly configNotifier: AuditSink;
  readonly cacheInvalidator: AuditSink;
  readonly scheduleSync: AuditSink;
  readonly dependencySync: AuditSink;
  readonly reachabilitySync: AuditSink;
  readonly clockFreezeSync: AuditSink;
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
    // And the clock-freeze overlay, for the same reason: a sensor moved off a frozen probe that
    // has gone away is never swept by it again (`P-239`).
    all.clockFreezeSync,
    all.triggerSync,
  ];
}

/** Editing the schedule library itself, which moves pause flags and nothing else. */
export function scheduleAuditSinks(all: AuditSinkSet): AuditSink[] {
  return [all.database, all.logging, all.configNotifier, all.scheduleSync, all.dependencySync];
}

/**
 * A report that ran (`E-08`).
 *
 * **The record and nothing else**, deliberately. The other sets here fan out to caches and
 * synchronisers because the mutation *changed* something they hold; a report that ran changed no
 * configuration at all. What it did was move data past a boundary under somebody's visibility
 * scope, and the only things that want to know are the two that keep the record.
 */
export function reportAuditSinks(all: AuditSinkSet): AuditSink[] {
  return [all.database, all.logging];
}

/**
 * Editing a map, its background, its share links or its grants (`A-17`).
 *
 * **The record and nothing else**, for a library's reason: a map is drawn from what the resolver
 * reads when somebody opens it, so no probe, cache, schedule or alarm chain holds anything a map
 * edit could leave stale.
 */
export function mapAuditSinks(all: AuditSinkSet): AuditSink[] {
  return [all.database, all.logging];
}

/**
 * Editing a library (`L-01`).
 *
 * **The record and nothing else**, for the reason a report's is: a library holds rules about what
 * people are shown, and no probe, cache, schedule or alarm chain reads one. What a library shows
 * is evaluated when somebody reads it (`L-02`), so there is nothing downstream to bring up to date.
 */
export function libraryAuditSinks(all: AuditSinkSet): AuditSink[] {
  return [all.database, all.logging];
}

/**
 * Granting or revoking a group's right on an object (`A-17`).
 *
 * **The record and nothing else**, though the grant is on the tree. What somebody is shown is
 * resolved when they ask, and the visibility epoch that tells every cached answer it is stale is
 * bumped by the grant's own statement (`A-12`, migration 052) — so no probe, cache, schedule or
 * alarm chain holds anything a grant leaves stale. The configuration push above all would be
 * wrong here: a grant changes who may look at a sensor, never what a probe scans.
 */
export function grantAuditSinks(all: AuditSinkSet): AuditSink[] {
  return [all.database, all.logging];
}

/**
 * Approving, refusing, fencing or forgetting a probe (`A-20`).
 *
 * **The record and nothing else**, because the registry already acts on the decision itself: it
 * closes or withdraws the probe's connection (`P-189`), and the handshake that follows issues the
 * key and the configuration. A configuration push from here would race that reconnect for a
 * probe that is, at that moment, not connected.
 */
export function probeAuditSinks(all: AuditSinkSet): AuditSink[] {
  return [all.database, all.logging];
}

/**
 * Starting or stopping a discovery run, and editing a rediscovery schedule (`A-20`).
 *
 * **The record and nothing else.** What a run creates is audited as the objects it creates,
 * through the object service's own sinks; the run and its schedule hold nothing a probe's
 * configuration, a cache or an alarm chain reads.
 */
export function discoveryAuditSinks(all: AuditSinkSet): AuditSink[] {
  return [all.database, all.logging];
}

/**
 * Changing an account, a user group, a membership, a password, a second factor or an API token
 * (`A-18`).
 *
 * **The record and nothing else**, for a grant's reason: who may see what is resolved when they
 * ask, and a membership's own statement bumps the visibility epoch that tells every cached answer
 * it is stale (`A-12`, migration 052). No probe scans anything an identity change touches.
 */
export function identityAuditSinks(all: AuditSinkSet): AuditSink[] {
  return [all.database, all.logging];
}

/** Editing the trigger library, which changes who is notified and not what is scanned. */
export function triggerAuditSinks(all: AuditSinkSet): AuditSink[] {
  return [all.database, all.logging, all.triggerSync];
}
