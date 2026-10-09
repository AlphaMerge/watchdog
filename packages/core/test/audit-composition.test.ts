import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  credentialAdoptionAuditSinks,
  discoveryAuditSinks,
  grantAuditSinks,
  identityAuditSinks,
  ingestionAuditSinks,
  libraryAuditSinks,
  mapAuditSinks,
  probeAuditSinks,
  objectAuditSinks,
  reportAuditSinks,
  scheduleAuditSinks,
  triggerAuditSinks,
  type AuditSinkSet,
} from '../src/objects/audit-composition.js';
import type { AuditSink } from '../src/objects/audit.js';

/**
 * Which sinks each audited service composes (`P-111`).
 *
 * **This exists because a sink in an array is the one piece of wiring a type cannot guard.**
 * Every other dependency `main()` carries is now a required parameter, so deleting it fails the
 * build. An element of an `AuditSink[]` has no such protection, and it was measured rather than
 * assumed: `reachabilitySync` was deleted from the object service's list and **all 2,118 core
 * tests stayed green**, silently reverting `P-103` — a sensor moved off a dead probe would go
 * back to reading Unknown for as long as that probe stayed away.
 *
 * The lists are named values rather than literals at three call sites, so this can assert their
 * membership. What it cannot assert is that `main()` passes these lists to those services; that
 * is one line each, and `main()` still has no test. The gap is smaller and it is not closed.
 */

/** A distinguishable stand-in per slot, so the assertions are about identity rather than shape. */
function sinks(): AuditSinkSet & { named: (sink: AuditSink) => string } {
  const made = new Map<AuditSink, string>();
  const make = (name: string): AuditSink => {
    const sink: AuditSink = { record: () => Promise.resolve() };
    made.set(sink, name);
    return sink;
  };
  return {
    database: make('database'),
    logging: make('logging'),
    configNotifier: make('configNotifier'),
    cacheInvalidator: make('cacheInvalidator'),
    scheduleSync: make('scheduleSync'),
    dependencySync: make('dependencySync'),
    reachabilitySync: make('reachabilitySync'),
    clockFreezeSync: make('clockFreezeSync'),
    triggerSync: make('triggerSync'),
    storedParams: make('storedParams'),
    named: (sink) => made.get(sink) ?? 'unknown',
  };
}

describe('what each audited service tells', () => {
  it('gives every tree mutation to all ten sinks', () => {
    // A create, a move, a clone or a delete can change what a probe scans, who a sensor depends
    // on, which schedule holds it, which probe carries it and which alarms stand — so this is the
    // one list with nothing left out.
    const all = sinks();
    assert.deepEqual(objectAuditSinks(all).map(all.named), [
      'database',
      'logging',
      'configNotifier',
      'cacheInvalidator',
      'scheduleSync',
      'dependencySync',
      'reachabilitySync',
      'clockFreezeSync',
      'triggerSync',
      'storedParams',
    ]);
  });

  it('keeps reachability and the clock freeze on the object service alone', () => {
    // **The one that was deleted with nothing failing**, and the overlay with the same defect
    // (`P-239`). Only an object mutation moves a sensor between probes, so this is the only list
    // that needs them — and being the only one is exactly why nothing else would have noticed
    // either's absence.
    const all = sinks();
    // And the count of sensors with invalid parameters (`P-367`): only an object mutation writes
    // a sensor's parameters.
    for (const sink of [all.reachabilitySync, all.clockFreezeSync, all.storedParams]) {
      const name = all.named(sink);
      assert.ok(objectAuditSinks(all).includes(sink), name);
      for (const others of [
        scheduleAuditSinks,
        triggerAuditSinks,
        reportAuditSinks,
        libraryAuditSinks,
        mapAuditSinks,
        grantAuditSinks,
        probeAuditSinks,
        discoveryAuditSinks,
        ingestionAuditSinks,
      ]) {
        assert.ok(!others(all).includes(sink), `${name} is not in ${others.name}`);
      }
    }
  });

  it('leaves the result cache and the alarm chain out of a schedule edit', () => {
    // A schedule edit moves pause flags. Neither the result cache nor a notification chain reads
    // a schedule, so telling them would be work for a change they cannot act on.
    const all = sinks();
    assert.deepEqual(scheduleAuditSinks(all).map(all.named), [
      'database',
      'logging',
      'configNotifier',
      'scheduleSync',
      'dependencySync',
    ]);
  });

  it('gives a primary a reading moved to the record and the result cache alone (P-314)', () => {
    // A `channel.*` entry is what makes ingestion forget a sensor's cached channels, so the
    // invalidator is in. Which channel is primary changes nothing a probe scans, no pause flag,
    // no probe's ownership of a sensor and no state an alarm chain reacts to.
    const all = sinks();
    assert.deepEqual(ingestionAuditSinks(all).map(all.named), [
      'database',
      'logging',
      'cacheInvalidator',
    ]);
  });

  it('leaves the configuration push out of a trigger edit', () => {
    // A trigger decides who is told about a sensor, not what a probe scans, so pushing one to
    // every probe would be churn for a change none of them can act on.
    const all = sinks();
    assert.deepEqual(triggerAuditSinks(all).map(all.named), ['database', 'logging', 'triggerSync']);
  });

  it('keeps reports, libraries and maps to the record alone', () => {
    // None changes anything a probe, a cache, a schedule or an alarm chain holds: a report moved
    // data past a boundary, and a library or a map changed what somebody is shown when they next
    // open it (`L-01`, `A-17`). Anything else on these lists would be work for a change it cannot
    // act on.
    const all = sinks();
    assert.deepEqual(reportAuditSinks(all).map(all.named), ['database', 'logging']);
    assert.deepEqual(libraryAuditSinks(all).map(all.named), ['database', 'logging']);
    assert.deepEqual(mapAuditSinks(all).map(all.named), ['database', 'logging']);
  });

  it('pushes configuration on a grant or an identity change, and nothing else', () => {
    // What a grant changes is who is shown a branch, and that is resolved when they ask; the
    // epoch that invalidates a cached answer moves with the grant's own statement (`A-12`). But
    // a sensor is sent its inherited credentials only while its voucher can write where they are
    // stored, so a revoked grant or a disabled account has to reach the probes (`A-41`).
    const all = sinks();
    assert.deepEqual(grantAuditSinks(all).map(all.named), [
      'database',
      'logging',
      'configNotifier',
    ]);
    assert.deepEqual(identityAuditSinks(all).map(all.named), [
      'database',
      'logging',
      'configNotifier',
    ]);
  });

  it('keeps probe trust and discovery to the record alone', () => {
    // The registry acts on its own decisions — it closes or withdraws the connection, and the
    // handshake that follows carries the key and the configuration (`P-189`) — and a discovery
    // run's objects are audited by the object service as they are created (`A-20`).
    const all = sinks();
    assert.deepEqual(probeAuditSinks(all).map(all.named), ['database', 'logging']);
    assert.deepEqual(discoveryAuditSinks(all).map(all.named), ['database', 'logging']);
  });

  it('keeps the boot step that adopts credential vouchers to the record alone (A-41)', () => {
    // It runs before any probe is served and changes nothing an alarm chain reads.
    const all = sinks();
    assert.deepEqual(credentialAdoptionAuditSinks(all).map(all.named), ['database', 'logging']);
  });
});
