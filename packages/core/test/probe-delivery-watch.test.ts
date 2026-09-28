import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ProbeDeliveryWatch } from '../src/probes/delivery-watch.js';
import type { Database } from '../src/db/pool.js';
import type { ProbeReachability } from '../src/probes/reachability.js';
import type { ProbeLink } from '../src/transport/probe-endpoint.js';
import { silentLogger } from './support/database.js';

/**
 * The sweep half of `P-74` — finding the probes and moving the answer, not deciding it.
 *
 * The rule itself is `probe-delivery.test.ts`. What is here is everything the pure function
 * cannot see: that a transition is written once rather than once per sweep, that a probe which
 * disconnects while silent can be marked again when it comes back still silent — the case a
 * naive edge-trigger gets wrong — and that a probe which has *never* connected in this process
 * is marked at all.
 *
 * That last one used to read "a lost link is `R-05`'s and not this sweep's", which was true of
 * the design and false of the system: `R-05` hears about a disconnect from a session closing,
 * and a probe that went away while the core was down has no session to close (`P-110`).
 */

const START = new Date('2026-09-04T00:00:00.000Z');
/**
 * Core uptime for these tests: well past the 120 s grace, in milliseconds (`P-81`).
 *
 * The sweep is driven by a monotonic uptime now rather than a wall-clock instant, so what a test
 * moves is a duration. That is not a cosmetic change: a scenario where `now` goes backwards, or
 * jumps forward independently of how long a probe has actually been quiet, is no longer
 * expressible against this interface — which is the point of the ticket.
 */
const UPTIME = 2_000_000;

function link(over: Partial<Extract<ProbeLink, { connected: true }>> = {}): ProbeLink {
  return {
    connected: true,
    gid: 'probe-gid',
    clockOffsetMs: null,
    protocolVersion: 13,
    connectedAt: START,
    lastHeartbeatAt: START,
    approved: true,
    agentVersion: '1.0.0',
    assignedSensors: 100,
    cadenceSeconds: 60,
    // The `Date`s the API and `resultAge` still want; the rule reads the ages below (`P-81`).
    lastResultsAt: START,
    configSentAt: START,
    connectedForMs: Number.MAX_SAFE_INTEGER,
    // A healthy probe: configured long ago at connect, delivering right now. A test that wants a
    // silent one overrides the arrival age.
    sinceResultsMs: 0,
    sinceConfigMs: 1_000_000,
    configured: true,
    configurable: true,
    ...over,
  };
}

/** Records what the sweep asked of reachability, without touching a database. */
function fakeReachability(options: { lostFails?: boolean } = {}) {
  const calls: string[] = [];
  // A reason map rather than a boolean, because that is what the real one keeps — and because the
  // sweep now reads it instead of shadowing it (`P-77`).
  const reasons = new Map<number, string>();
  return {
    calls,
    reasons,
    service: {
      offlineReason: (probeObjectId: number) => reasons.get(probeObjectId),
      lost: (probeObjectId: number, reason?: string) => {
        calls.push(`lost:${String(probeObjectId)}:${reason ?? 'link'}`);
        // The real `lost` logs and returns without marking when it cannot read the probe's
        // sensors. Modelling that is the whole point of this fake.
        if (options.lostFails === true) return Promise.resolve(0);
        reasons.set(probeObjectId, reason ?? 'link');
        return Promise.resolve(3);
      },
      // What the endpoint calls when a reconnecting probe claims its branch
      // (`probe-endpoint.ts`, at the first config poll of every new session). It clears the entry
      // whatever the reason — the probe is back, and `R-05` says its sensors return to their last
      // reading. This sweep then re-decides from scratch, which is the point.
      found: (probeObjectId: number) => {
        calls.push(`found:${String(probeObjectId)}`);
        reasons.delete(probeObjectId);
        return Promise.resolve(3);
      },
      resumed: (probeObjectId: number) => {
        calls.push(`resumed:${String(probeObjectId)}`);
        if (reasons.get(probeObjectId) !== 'silence') return Promise.resolve(0);
        reasons.delete(probeObjectId);
        return Promise.resolve(3);
      },
    } as unknown as ProbeReachability,
  };
}

function fakeDb(probeIds: number[]): Database {
  return {
    query: () => Promise.resolve(probeIds.map((id) => ({ id: String(id) }))),
  } as unknown as Database;
}

function watchOver(
  links: Map<number, ProbeLink>,
  clock: { uptimeMs: number },
  options: { lostFails?: boolean; maxPerSweep?: number } = {},
) {
  const reach = fakeReachability(options);
  const watch = new ProbeDeliveryWatch({
    db: fakeDb([...links.keys()]),
    logger: silentLogger,
    reachability: reach.service,
    linkFor: (id) => links.get(id) ?? { connected: false },
    uptimeMs: () => clock.uptimeMs,
    ...(options.maxPerSweep === undefined ? {} : { maxPerSweep: options.maxPerSweep }),
  });
  return { watch, calls: reach.calls, reasons: reach.reasons, reach: reach.service };
}

describe('the probe delivery sweep', () => {
  it('marks a silent probe once, not once per sweep', async () => {
    // **The property that matters most.** `lost` re-evaluates every sensor under the probe and
    // writes state history, so calling it every thirty seconds while a probe stayed stalled would
    // write a transition per sweep into the table uptime and SLA are computed from — worse than
    // the silence it is fixing.
    const links = new Map([[7, link({ sinceResultsMs: 1_000_000 })]]);
    const clock = { uptimeMs: UPTIME };
    const { watch, calls } = watchOver(links, clock);

    await watch.settle();
    await watch.settle();
    await watch.settle();

    assert.deepEqual(calls, ['lost:7:silence']);
    assert.equal(watch.stats().transitions, 1, 'three sweeps, one transition');
    assert.equal(watch.stats().sweeps, 3);
  });

  it('says silence, not a lost link, so the message an operator reads is true', async () => {
    const links = new Map([[7, link({ sinceResultsMs: 1_000_000 })]]);
    const { watch, calls } = watchOver(links, { uptimeMs: UPTIME });
    await watch.settle();
    assert.deepEqual(calls, ['lost:7:silence']);
  });

  it('clears it when results start arriving again, once', async () => {
    const links = new Map([[7, link({ sinceResultsMs: 1_000_000 })]]);
    const clock = { uptimeMs: UPTIME };
    const { watch, calls } = watchOver(links, clock);
    await watch.settle();

    links.set(7, link({ sinceResultsMs: 0 }));
    await watch.settle();
    await watch.settle();

    assert.deepEqual(calls, ['lost:7:silence', 'resumed:7']);
  });

  it('leaves a probe that is delivering completely alone', async () => {
    const clock = { uptimeMs: UPTIME };
    const links = new Map([[7, link({ sinceResultsMs: 100_000 })]]);
    const { watch, calls } = watchOver(links, clock);
    await watch.settle();
    assert.deepEqual(calls, []);
  });

  it('marks a probe that has not connected since this core started', async () => {
    // **`P-110`.** This used to hand a disconnected probe to `R-05` and decide nothing, on the
    // reasoning that a link going is `R-05`'s business. It is — but `R-05` learns about a
    // disconnect from `ProbeEndpoint.#handleClose`, which fires only for a session that
    // *existed*. A probe whose host went away while the core was down has no session to close,
    // nothing seeds the unreachable set at boot, and `loadRuntimes` restores `probeReachable:
    // true` optimistically: its sensors read Up, green in the tree and absent from the alarms
    // view, with `since` from before the crash, and `sensor_state` gets no row at all — so the
    // whole absence integrates as Up for uptime and SLA.
    //
    // The same probe dropping while the core is running becomes Unknown within seconds, so a
    // restart silently reversed the correct answer for an outage still in progress.
    const clock = { uptimeMs: UPTIME };
    const links = new Map<number, ProbeLink>([[7, { connected: false }]]);
    const { watch, calls } = watchOver(links, clock);
    await watch.settle();
    assert.deepEqual(calls, ['lost:7:link'], 'nothing else was going to');
  });

  it('says nothing about it while the core is still starting up', async () => {
    // The half that keeps a restart quiet, and the same grace the delivery rule uses: a core
    // that has just started has not yet learned which probes are missing, and marking thousands
    // of sensors Unknown on every restart would be an alarm storm generated by the restart.
    const clock = { uptimeMs: 60_000 };
    const links = new Map<number, ProbeLink>([[7, { connected: false }]]);
    const { watch, calls } = watchOver(links, clock);
    await watch.settle();
    assert.deepEqual(calls, [], 'inside the 120 s grace');
  });

  it('does not mark a disconnected probe twice', async () => {
    // `#handleClose` marks on the way out, so the ordinary disconnect is already held by the
    // time a sweep sees it. This is a backstop for the case nothing else covers, not a second
    // opinion about one that is covered.
    const clock = { uptimeMs: UPTIME };
    const links = new Map<number, ProbeLink>([[7, { connected: false }]]);
    const { watch, calls } = watchOver(links, clock);
    await watch.settle();
    await watch.settle();
    assert.deepEqual(calls, ['lost:7:link'], 'once, not once per sweep');
  });

  it('can mark a probe again after it disconnected while silent and came back still silent', async () => {
    // The case a naive edge-trigger gets wrong. The reconnect clears the reachability entry —
    // `R-05`'s rule, sensors return to their last reading — so a watch still holding its claim
    // would read the next stall as no change and never mark it again.
    const clock = { uptimeMs: UPTIME };
    const links = new Map<number, ProbeLink>([[7, link({ sinceResultsMs: 1_000_000 })]]);
    const { watch, calls, reach } = watchOver(links, clock);
    await watch.settle();
    assert.deepEqual(calls, ['lost:7:silence']);

    links.set(7, { connected: false });
    await watch.settle();

    // Back, and still not delivering: its config was pushed on reconnect and nothing has arrived.
    // The endpoint calls `found` as the new session claims its branch, which is what clears the
    // mark — this sweep does not track the reconnect itself, it just stops seeing a mark.
    clock.uptimeMs = UPTIME + 2_000_000;
    links.set(7, link({ sinceResultsMs: null, sinceConfigMs: 1_500_000 }));
    await reach.found(7);
    await watch.settle();

    assert.deepEqual(
      calls,
      ['lost:7:silence', 'found:7', 'lost:7:silence'],
      'marked again, not forgotten',
    );
  });

  it('retries a marking that did not take, instead of recording it as done', async () => {
    // **`P-77`.** The sweep kept its own set of marked probes and added to it *before* awaiting
    // `lost`, which logs and returns without marking anything when it cannot read the probe's
    // sensors. The shadow then said "already handled" for ever and the sensors it never marked
    // stayed Up — the exact failure this whole ticket exists to prevent, reached through the
    // thing meant to prevent it. It reads reachability's own state now, so a failed marking is
    // simply still unmarked and the next sweep tries again.
    const links = new Map([[7, link({ sinceResultsMs: 1_000_000 })]]);
    const clock = { uptimeMs: UPTIME };
    const { watch, calls } = watchOver(links, clock, { lostFails: true });

    await watch.settle();
    await watch.settle();
    await watch.settle();

    assert.deepEqual(calls, ['lost:7:silence', 'lost:7:silence', 'lost:7:silence']);
  });

  it('leaves a probe already marked for a lost link alone', async () => {
    // `R-05` owns that probe. Re-marking it would be wrong and un-marking it would be worse: the
    // link is genuinely down, and this sweep has no business deciding otherwise.
    const links = new Map([[7, link({ sinceResultsMs: 100_000 })]]);
    const clock = { uptimeMs: UPTIME };
    const { watch, calls, reasons } = watchOver(links, clock);
    reasons.set(7, 'link');

    await watch.settle();
    assert.deepEqual(calls, [], 'delivering, but not this sweep’s to clear');
  });

  it('rations itself when every probe stops delivering at once', async () => {
    // **`P-81`.** Each `lost` walks a subtree, opens a transaction and writes a `sensor_state`
    // row per sensor that moves. Nothing bounded how many probes one pass could do that to —
    // while `AlarmEngine` in this same codebase bounds `maxPerSweep` naming a forward clock jump
    // as the reason. Monotonic ages make the clock jump unreachable, but a real core-wide outage
    // still leaves every probe silent at once, and the honest answer is to mark them all without
    // doing it in a single transaction storm.
    const links = new Map<number, ProbeLink>();
    for (let id = 1; id <= 10; id += 1) links.set(id, link({ sinceResultsMs: 1_000_000 }));
    const { watch, calls } = watchOver(links, { uptimeMs: UPTIME }, { maxPerSweep: 3 });

    await watch.settle();
    assert.equal(calls.length, 3, 'three this pass');
    assert.equal(watch.stats().deferred, 7, 'and the rest counted rather than forgotten');

    // Still stalled thirty seconds later, so the sweep works through them.
    await watch.settle();
    await watch.settle();
    await watch.settle();
    assert.equal(calls.length, 10, 'every one of them, in four passes');
    assert.equal(watch.stats().deferred, 0);
  });

  it('survives a database that cannot list probes', async () => {
    const watch = new ProbeDeliveryWatch({
      db: { query: () => Promise.reject(new Error('down')) } as unknown as Database,
      logger: silentLogger,
      reachability: fakeReachability().service,
      linkFor: () => ({ connected: false }),
      uptimeMs: () => UPTIME,
    });
    assert.equal(await watch.settle(), 0, 'a sweep that cannot read decides nothing');
  });
});
