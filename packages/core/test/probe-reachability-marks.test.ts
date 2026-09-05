import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ProbeReachability } from '../src/probes/reachability.js';
import type { Database } from '../src/db/pool.js';
import { silentLogger } from './support/database.js';

/**
 * What `ProbeReachability` records, as opposed to what it decides (`P-80`).
 *
 * `probe-offline.test.ts` covers the decision end to end against a real database. What is here is
 * the bookkeeping either side of the write — whether the in-memory marks survive a write that did
 * not happen, and whether the counter an operator reads still means what its channel says. Both
 * are stubs on purpose: neither question needs a database, and both were invisible to a suite
 * that only ever exercised the happy path.
 */

function reachabilityOver(options: { txFails?: boolean; sensorIds?: number[] } = {}) {
  // Mutable, so one instance can succeed at marking a probe lost and then fail at clearing it —
  // which is the only way to reach `#online`'s rollback at all.
  const failing = { now: options.txFails === true };
  const reevaluated: number[][] = [];
  const db = {
    query: () =>
      Promise.resolve((options.sensorIds ?? [1, 2, 3]).map((id) => ({ id: String(id) }))),
    // The body runs and *then* the commit fails, which is the realistic shape — a deadlock,
    // a statement timeout, a failover mid-transaction. Rejecting before calling `fn` would
    // model a pool that could not hand out a connection, and would let the assertion below
    // pass by testing this stub rather than the rollback.
    tx: async <T>(fn: (q: unknown) => Promise<T>): Promise<T> => {
      const result = await fn({ query: () => Promise.resolve([]) });
      if (failing.now) throw new Error('deadlock detected');
      return result;
    },
  } as unknown as Database;

  const service = new ProbeReachability({
    db,
    logger: silentLogger,
    states: {
      reevaluate: (_q, sensorIds) => {
        reevaluated.push([...sensorIds]);
        return Promise.resolve(sensorIds.length);
      },
    },
  });
  return { service, reevaluated, failing };
}

describe('what reachability records', () => {
  it('does not hold a probe marked when the write that marks it failed', async () => {
    // **`P-77`'s defect, one layer down.** `P-77` replaced the sweep's shadow `Set` with a read of
    // `offlineReason()` precisely so that a marking which did not take would be retried. But the
    // in-memory marks are written *before* the transaction — deliberately, because the overlay has
    // to be in place for the re-evaluation to see it — and nothing rolled them back when that
    // transaction rejected. `offlineReason()` then answered 'silence' for a probe whose sensors
    // were never touched, so the sweep read "already handled" for ever: no `sensor_state` row for
    // the outage, the UI showing every sensor Up through a total blackout, and SLA reporting 100%.
    //
    // The overlay still goes in first. It is simply taken back out if the write does not land.
    const { service, reevaluated } = reachabilityOver({ txFails: true });

    assert.equal(await service.lost(7, 'silence'), 0, 'nothing moved, and it says so');
    assert.equal(reevaluated.length, 1, 'the re-evaluation was attempted');
    assert.equal(service.offlineReason(7), undefined, 'and the probe is not claimed as handled');
    assert.equal(service.stats().sensorsUnknown, 0, 'nor are its sensors');

    // The point of all of it: the next sweep tries again rather than deciding it is done.
    const retry = reachabilityOver();
    assert.equal(await retry.service.lost(7, 'silence'), 3);
    assert.equal(retry.service.offlineReason(7), 'silence');
  });

  it('does not hold a probe cleared when the write that clears it failed', async () => {
    // **`P-90`: the same defect, in the mirror method, left behind by `P-80`.** `#online` drops
    // the overlay before the write and never put it back — so a rejected transaction left the
    // database holding `unknown`/`probe` for every sensor while this process believed the probe
    // was fine. `offlineReason` then answers undefined, the sweep's `held === 'silence'` branch
    // can never fire again, and the recovery transition is a permanent hole in the history.
    const { service, failing } = reachabilityOver();

    assert.equal(await service.lost(7, 'silence'), 3);
    assert.equal(service.offlineReason(7), 'silence');

    failing.now = true;
    assert.equal(await service.resumed(7), 0, 'nothing moved, and it says so rather than throwing');
    assert.equal(
      service.offlineReason(7),
      'silence',
      'still held, because the clearing never landed',
    );
    assert.equal(service.stats().sensorsUnknown, 3, 'and its sensors are still marked');

    // Which is the point: the next sweep retries instead of deciding it is done.
    failing.now = false;
    assert.equal(await service.resumed(7), 3);
    assert.equal(service.offlineReason(7), undefined);
  });

  it('counts a probe that is connected but silent apart from one that is not connected', async () => {
    // `P-74` began putting `reason: 'silence'` entries into the same map, and `probesDown` is that
    // map's size — published to Core Health as **'Probes not connected'**, whose summary line
    // reads 'N probes down'. So a probe that was connected and heartbeating normally was reported
    // as not connected, while its own Probe Health said `connected: 1`. An operator reading the
    // two together goes looking for a network fault that does not exist, and the signal that is
    // actually true — `delivering: 0` on that probe — is buried under the contradiction.
    const { service } = reachabilityOver();

    await service.lost(7, 'silence');
    assert.equal(service.stats().probesDown, 0, 'connected: not what that channel counts');
    assert.equal(service.stats().probesSilent, 1, 'counted, on the channel that means it');
    assert.equal(service.stats().sensorsUnknown, 3, 'its sensors are Unknown either way');

    await service.lost(9, 'link');
    assert.equal(service.stats().probesDown, 1);
    assert.equal(service.stats().probesSilent, 1);
  });
});
