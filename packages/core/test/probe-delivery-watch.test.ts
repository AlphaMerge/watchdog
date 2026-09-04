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
 * cannot see: that a transition is written once rather than once per sweep, that a lost link is
 * `R-05`'s and not this sweep's, and that a probe which disconnects while silent can be marked
 * again when it comes back still silent — which is the case a naive edge-trigger gets wrong.
 */

const START = new Date('2026-09-04T00:00:00.000Z');
const GRACE_OVER = 200; // seconds; the default grace is 120

function link(over: Partial<Extract<ProbeLink, { connected: true }>> = {}): ProbeLink {
  return {
    connected: true,
    protocolVersion: 13,
    connectedAt: START,
    lastHeartbeatAt: START,
    approved: true,
    agentVersion: '1.0.0',
    assignedSensors: 100,
    cadenceSeconds: 60,
    lastResultsAt: START,
    configSentAt: START,
    ...over,
  };
}

/** Records what the sweep asked of reachability, without touching a database. */
function fakeReachability() {
  const calls: string[] = [];
  return {
    calls,
    service: {
      lost: (probeObjectId: number, reason?: string) => {
        calls.push(`lost:${String(probeObjectId)}:${reason ?? 'link'}`);
        return Promise.resolve(3);
      },
      resumed: (probeObjectId: number) => {
        calls.push(`resumed:${String(probeObjectId)}`);
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

function watchOver(links: Map<number, ProbeLink>, clock: { now: Date }) {
  const reach = fakeReachability();
  const watch = new ProbeDeliveryWatch({
    db: fakeDb([...links.keys()]),
    logger: silentLogger,
    reachability: reach.service,
    linkFor: (id) => links.get(id) ?? { connected: false },
    startedAt: START,
    now: () => clock.now,
  });
  return { watch, calls: reach.calls };
}

const at = (seconds: number): Date => new Date(START.getTime() + seconds * 1_000);

describe('the probe delivery sweep', () => {
  it('marks a silent probe once, not once per sweep', async () => {
    // **The property that matters most.** `lost` re-evaluates every sensor under the probe and
    // writes state history, so calling it every thirty seconds while a probe stayed stalled would
    // write a transition per sweep into the table uptime and SLA are computed from — worse than
    // the silence it is fixing.
    const links = new Map([[7, link({ lastResultsAt: at(GRACE_OVER) })]]);
    const clock = { now: at(GRACE_OVER + 1_000) };
    const { watch, calls } = watchOver(links, clock);

    await watch.settle();
    await watch.settle();
    await watch.settle();

    assert.deepEqual(calls, ['lost:7:silence']);
    assert.equal(watch.stats().transitions, 1, 'three sweeps, one transition');
    assert.equal(watch.stats().sweeps, 3);
  });

  it('says silence, not a lost link, so the message an operator reads is true', async () => {
    const links = new Map([[7, link({ lastResultsAt: at(GRACE_OVER) })]]);
    const { watch, calls } = watchOver(links, { now: at(GRACE_OVER + 1_000) });
    await watch.settle();
    assert.deepEqual(calls, ['lost:7:silence']);
  });

  it('clears it when results start arriving again, once', async () => {
    const links = new Map([[7, link({ lastResultsAt: at(GRACE_OVER) })]]);
    const clock = { now: at(GRACE_OVER + 1_000) };
    const { watch, calls } = watchOver(links, clock);
    await watch.settle();

    links.set(7, link({ lastResultsAt: clock.now }));
    await watch.settle();
    await watch.settle();

    assert.deepEqual(calls, ['lost:7:silence', 'resumed:7']);
  });

  it('leaves a probe that is delivering completely alone', async () => {
    const clock = { now: at(GRACE_OVER + 1_000) };
    const links = new Map([[7, link({ lastResultsAt: at(GRACE_OVER + 900) })]]);
    const { watch, calls } = watchOver(links, clock);
    await watch.settle();
    assert.deepEqual(calls, []);
  });

  it('hands a disconnected probe to R-05 rather than deciding anything about it', async () => {
    const clock = { now: at(GRACE_OVER + 1_000) };
    const links = new Map<number, ProbeLink>([[7, { connected: false }]]);
    const { watch, calls } = watchOver(links, clock);
    await watch.settle();
    assert.deepEqual(calls, [], 'the link going is not this sweep’s business');
  });

  it('can mark a probe again after it disconnected while silent and came back still silent', async () => {
    // The case a naive edge-trigger gets wrong. The reconnect clears the reachability entry —
    // `R-05`'s rule, sensors return to their last reading — so a watch still holding its claim
    // would read the next stall as no change and never mark it again.
    const clock = { now: at(GRACE_OVER + 1_000) };
    const links = new Map<number, ProbeLink>([[7, link({ lastResultsAt: at(GRACE_OVER) })]]);
    const { watch, calls } = watchOver(links, clock);
    await watch.settle();
    assert.deepEqual(calls, ['lost:7:silence']);

    links.set(7, { connected: false });
    await watch.settle();

    // Back, and still not delivering: its config was pushed on reconnect and nothing has arrived.
    clock.now = at(GRACE_OVER + 3_000);
    links.set(7, link({ lastResultsAt: null, configSentAt: at(GRACE_OVER + 1_500) }));
    await watch.settle();

    assert.deepEqual(calls, ['lost:7:silence', 'lost:7:silence'], 'marked again, not forgotten');
  });

  it('survives a database that cannot list probes', async () => {
    const watch = new ProbeDeliveryWatch({
      db: { query: () => Promise.reject(new Error('down')) } as unknown as Database,
      logger: silentLogger,
      reachability: fakeReachability().service,
      linkFor: () => ({ connected: false }),
      startedAt: START,
      now: () => at(GRACE_OVER + 1_000),
    });
    assert.equal(await watch.settle(), 0, 'a sweep that cannot read decides nothing');
  });
});
