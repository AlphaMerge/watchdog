import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  objectAuditSinks,
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
    triggerSync: make('triggerSync'),
    named: (sink) => made.get(sink) ?? 'unknown',
  };
}

describe('what each audited service tells', () => {
  it('gives every tree mutation to all eight sinks', () => {
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
      'triggerSync',
    ]);
  });

  it('keeps reachability on the object service alone', () => {
    // **The one that was deleted with nothing failing.** Only an object mutation moves a sensor
    // between probes, so this is the only list that needs it — and being the only one is exactly
    // why nothing else would have noticed its absence.
    const all = sinks();
    assert.ok(objectAuditSinks(all).includes(all.reachabilitySync));
    assert.ok(!scheduleAuditSinks(all).includes(all.reachabilitySync));
    assert.ok(!triggerAuditSinks(all).includes(all.reachabilitySync));
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

  it('leaves the configuration push out of a trigger edit', () => {
    // A trigger decides who is told about a sensor, not what a probe scans, so pushing one to
    // every probe would be churn for a change none of them can act on.
    const all = sinks();
    assert.deepEqual(triggerAuditSinks(all).map(all.named), ['database', 'logging', 'triggerSync']);
  });
});
