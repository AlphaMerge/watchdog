import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DiscoveryService, type DispatchMessage } from '../src/discovery/service.js';
import { DiscoveryError } from '../src/discovery/errors.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor } from './support/tree.js';

/**
 * Discovery runs from the core's side (`D-01`), against a real database.
 *
 * **The interesting behaviour is all about crashing at the wrong moment**, which is why this is a
 * database test rather than a unit one: whether the cursor can go backwards, whether a resumed
 * sweep double-counts the hosts it re-reports, and whether a run left behind by a dropped probe
 * comes back as resumable or as failed. None of that is visible without the row.
 */

const available = await databaseAvailable();

describe('discovery runs', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let harness: Awaited<ReturnType<typeof buildHarness>>;
  let groupId = 0;
  let probeId = 0;
  let sent: DispatchMessage[] = [];
  let connected = true;
  let discovery: DiscoveryService;

  before(async () => {
    scratch = await createScratchDatabase('discovery');
    db = scratch.db;
    harness = await buildHarness(db);
  });

  after(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM object WHERE parent_id IS NOT NULL');
    sent = [];
    connected = true;

    const probe = await harness.service.create(testActor, {
      kind: 'probe',
      parentId: harness.rootId,
      name: `probe-${String(process.hrtime.bigint())}`,
    });
    probeId = probe.id;
    const group = await harness.service.create(testActor, {
      kind: 'group',
      parentId: probe.id,
      name: 'Datacentre',
    });
    groupId = group.id;

    discovery = new DiscoveryService({
      db,
      logger: silentLogger,
      dispatch: (_probeId, message) => {
        if (!connected) return false;
        sent.push(message);
        return true;
      },
    });
  });

  /** A run that must exist, so the assertions below read as statements rather than as guards. */
  const mustGet = async (id: number) => {
    const run = await discovery.get(id);
    assert.ok(run !== null, `run ${String(id)} should exist`);
    return run;
  };

  /** The job in the message at `at`, with the shape assertion done once. */
  const jobIn = (at = 0) => {
    const message = sent[at];
    assert.ok(message !== undefined && message.kind === 'start', 'expected a start message');
    return message.job;
  };

  const start = (range = '10.0.0.0/29') =>
    discovery.start({ groupId, probeId, range, timeoutMs: 500, concurrency: 8 });

  describe('starting', () => {
    it('records the range, its size, and offers it to the probe', async () => {
      const run = await start();
      assert.equal(run.range, '10.0.0.0/29');
      assert.equal(run.total, 6, 'a /29 is six hosts, not eight');
      assert.equal(run.cursor, 0);

      assert.equal(sent.length, 1);
      assert.equal(jobIn().range, '10.0.0.0/29');

      // Offered *and* marked running, so a second pump does not start it twice.
      assert.equal((await mustGet(run.id)).status, 'running');
    });

    it('refuses a range the operator will regret, with the parser’s own sentence', async () => {
      await assert.rejects(
        () => start('10.0.0.0/8'),
        (error: unknown) =>
          error instanceof Error && /the usual cause is a \/8 where a \/24/.test(error.message),
      );
      assert.equal(sent.length, 0, 'and nothing was recorded');
    });

    it('leaves a run queued when the probe is not connected', async () => {
      // Not a failure. The run is picked up on the next connect, which is the same path a probe
      // restart takes — so this is the ordinary case rather than the exception.
      connected = false;
      const run = await start();
      assert.equal((await mustGet(run.id)).status, 'queued');

      connected = true;
      await discovery.pump(probeId);
      assert.equal((await mustGet(run.id)).status, 'running');
    });

    it('offers one run at a time, oldest first', async () => {
      // Two sweeps from one probe would each stand down for the other's traffic, and "discovery
      // is running" has no room for two.
      const first = await start('10.0.0.0/29');
      sent = [];
      const second = await start('10.0.1.0/29');
      assert.equal(sent.length, 1);
      assert.equal(jobIn().runId, first.id);
      assert.equal((await mustGet(second.id)).status, 'queued');
    });
  });

  describe('progress', () => {
    it('stores hosts and advances the cursor', async () => {
      const run = await start();
      await discovery.progress(
        run.id,
        3,
        [
          { address: '10.0.0.1', rttMs: 0.4 },
          { address: '10.0.0.3', rttMs: 1.2 },
        ],
        0,
      );

      const after = await mustGet(run.id);
      assert.equal(after.cursor, 3);
      assert.equal(after.found, 2);
      assert.deepEqual(
        (await discovery.hosts(run.id)).map((one) => one.address),
        ['10.0.0.1', '10.0.0.3'],
      );
    });

    it('sorts hosts as addresses, not as strings', async () => {
      // `inet` rather than `text`, so 10.0.0.9 comes before 10.0.0.10 — which is what an
      // operator reading the list for gaps needs.
      const run = await start('10.0.0.0/24');
      await discovery.progress(
        run.id,
        20,
        [
          { address: '10.0.0.10', rttMs: 1 },
          { address: '10.0.0.9', rttMs: 1 },
          { address: '10.0.0.2', rttMs: 1 },
        ],
        0,
      );
      assert.deepEqual(
        (await discovery.hosts(run.id)).map((one) => one.address),
        ['10.0.0.2', '10.0.0.9', '10.0.0.10'],
      );
    });

    it('makes a replayed address free, which is what lets the cursor be a floor', async () => {
      // A resume re-sweeps a few addresses after a crash. If that double-counted, every restart
      // would inflate the summary D-08 persists.
      const run = await start();
      await discovery.progress(run.id, 3, [{ address: '10.0.0.1', rttMs: 0.4 }], 0);
      await discovery.progress(run.id, 4, [{ address: '10.0.0.1', rttMs: 0.9 }], 0);

      const after = await mustGet(run.id);
      assert.equal(after.found, 1, 'the same host twice is one host');
      assert.equal((await discovery.hosts(run.id)).length, 1);
    });

    it('never walks the cursor backwards', async () => {
      // A probe that resumed from an older position and reported it would otherwise make the
      // run sweep the range twice.
      const run = await start();
      await discovery.progress(run.id, 5, [], 0);
      await discovery.progress(run.id, 2, [], 0);
      assert.equal((await mustGet(run.id)).cursor, 5);
    });

    it('counts addresses that could not be attempted', async () => {
      // A firewalled network and an empty one look identical without this.
      const run = await start();
      await discovery.progress(run.id, 2, [], 2);
      await discovery.progress(run.id, 4, [], 1);
      assert.equal((await mustGet(run.id)).failed, 3);
    });

    it('ignores progress for a run that is no longer running', async () => {
      // A cancelled run whose last in-flight pings are still reporting must not come back to
      // life, or a cancel would look like it did nothing.
      const run = await start();
      await discovery.cancel(run.id);
      await discovery.progress(run.id, 6, [], 0);
      const after = await mustGet(run.id);
      assert.equal(after.status, 'cancelled');
      assert.equal(after.cursor, 0, 'the cursor did not move');
    });
  });

  describe('finishing', () => {
    it('records a completed run', async () => {
      const run = await start();
      await discovery.finished(run.id, 'done', 6, '');
      const after = await mustGet(run.id);
      assert.equal(after.status, 'done');
      assert.equal(after.cursor, 6);
      assert.ok(after.finishedAt !== null);
    });

    it('records a failure with what to tell the operator', async () => {
      const run = await start();
      await discovery.finished(run.id, 'failed', 2, 'the "ping" binary is not available');
      const after = await mustGet(run.id);
      assert.equal(after.status, 'failed');
      assert.match(after.message, /ping/);
    });

    it('sends a run the probe stopped back to the queue, not to failed', async () => {
      // A probe restarting reports `cancelled` for everything it was doing. Marking those
      // failed would have an operator restarting a sweep that only needed to wait.
      const run = await start();
      await discovery.progress(run.id, 4, [], 0);
      await discovery.finished(run.id, 'cancelled', 4, '');

      const after = await mustGet(run.id);
      assert.equal(after.status, 'queued');
      assert.equal(after.cursor, 4, 'and it resumes from where it stopped');
    });

    it('keeps a run the operator cancelled cancelled', async () => {
      const run = await start();
      await discovery.cancel(run.id);
      await discovery.finished(run.id, 'cancelled', 3, '');
      assert.equal((await mustGet(run.id)).status, 'cancelled');
    });

    it('treats superseded as not an ending at all', async () => {
      // It means a newer `sweep-start` for the same run took over. Recording it as an ending
      // would mark a run finished at the moment it restarted.
      const run = await start();
      await discovery.finished(run.id, 'superseded', 2, '');
      assert.equal((await mustGet(run.id)).status, 'running');
    });
  });

  describe('cancelling', () => {
    it('records the decision even when the probe is unreachable', async () => {
      // Otherwise the operator's click did nothing and the sweep resumes the moment the probe
      // comes back.
      const run = await start();
      connected = false;
      const cancelled = await discovery.cancel(run.id);
      assert.ok(cancelled !== null);
      assert.equal(cancelled.status, 'cancelled');
      assert.equal((await mustGet(run.id)).status, 'cancelled');
    });

    it('tells the probe as well — both stages of it', async () => {
      // The statement that records the cancel has already changed the status, so it no longer
      // says which stage was running. A cancel for a stage that was not running is a no-op the
      // probe answers honestly.
      const run = await start();
      sent = [];
      await discovery.cancel(run.id);
      assert.deepEqual(sent, [
        { kind: 'cancel', runId: run.id },
        { kind: 'identify-cancel', runId: run.id },
      ]);
    });

    it('answers null for a run that has already finished', async () => {
      const run = await start();
      await discovery.finished(run.id, 'done', 6, '');
      assert.equal(await discovery.cancel(run.id), null);
    });
  });

  describe('a probe that dropped', () => {
    it('releases its runs for a resume rather than failing them', async () => {
      const run = await start();
      await discovery.progress(run.id, 3, [{ address: '10.0.0.1', rttMs: 1 }], 0);
      await discovery.probeDisconnected(probeId);

      const after = await mustGet(run.id);
      assert.equal(after.status, 'queued');
      assert.equal(after.cursor, 3);

      sent = [];
      await discovery.pump(probeId);
      assert.equal(jobIn().cursor, 3, 'resumed from the cursor');
      assert.equal((await mustGet(run.id)).status, 'running');
    });

    it('leaves a cancelled run cancelled', async () => {
      const run = await start();
      await discovery.cancel(run.id);
      await discovery.probeDisconnected(probeId);
      assert.equal((await mustGet(run.id)).status, 'cancelled');
    });
  });

  describe('listing', () => {
    it('lists a group’s runs newest first', async () => {
      const first = await start('10.0.0.0/29');
      await discovery.finished(first.id, 'done', 6, '');
      const second = await start('10.0.1.0/29');
      const runs = await discovery.list(groupId);
      assert.deepEqual(
        runs.map((one) => one.id),
        [second.id, first.id],
      );
    });

    it('goes away with its group', async () => {
      // ON DELETE CASCADE. A run pointing at a group that no longer exists is a row nobody can
      // read and nobody can delete through the API.
      const run = await start();
      await harness.service.delete(testActor, groupId, { kind: 'leafOnly' }, { kind: 'none' });
      assert.equal(await discovery.get(run.id), null);
    });
  });

  /**
   * The identification stage (`D-02`).
   *
   * A stage on the same run rather than a second run, so what is asserted here is the handover:
   * that a finished sweep becomes an identification rather than a finished run, that fingerprints
   * land on the right hosts, and that a probe sending something this build cannot read is
   * dropped rather than written into a column `D-03` will match templates against.
   */
  describe('identification', () => {
    const fingerprint = (address: string, over: Record<string, unknown> = {}) => ({
      address,
      ports: [{ port: 22, transport: 'tcp' }],
      kind: 'linux',
      confidence: 45,
      evidence: ['SSH is open'],
      ...over,
    });

    const sweptAndFound = async (addresses: string[]) => {
      const run = await start();
      await discovery.progress(
        run.id,
        6,
        addresses.map((address) => ({ address, rttMs: 1 })),
        0,
      );
      await discovery.finished(run.id, 'done', 6, '');
      return run;
    };

    it('hands a finished sweep over to identification rather than ending the run', async () => {
      // An operator starts one discovery and watches one thing finish. Two rows would mean two
      // progress bars, two cancels, and a question about what a cancel of one does to the other.
      sent = [];
      const run = await sweptAndFound(['10.0.0.1', '10.0.0.2']);
      const after = await mustGet(run.id);
      assert.equal(after.status, 'identifying');

      const message = sent.at(-1);
      assert.ok(message !== undefined && message.kind === 'identify');
      assert.deepEqual(message.job.addresses, ['10.0.0.1', '10.0.0.2']);
      assert.equal(message.job.cursor, 0, 'the batch is the remaining work');
    });

    it('ends the run without identifying when the level says ping only', async () => {
      const run = await discovery.start({
        groupId,
        probeId,
        range: '10.0.0.0/29',
        level: 'ping',
      });
      await discovery.progress(run.id, 6, [{ address: '10.0.0.1', rttMs: 1 }], 0);
      await discovery.finished(run.id, 'done', 6, '');
      assert.equal((await mustGet(run.id)).status, 'done');
    });

    it('ends the run without identifying when the sweep found nothing', async () => {
      const run = await start();
      await discovery.finished(run.id, 'done', 6, '');
      assert.equal((await mustGet(run.id)).status, 'done');
    });

    it('stores a fingerprint against the host it belongs to', async () => {
      const run = await sweptAndFound(['10.0.0.1', '10.0.0.2']);
      await discovery.identified(run.id, 2, [
        fingerprint('10.0.0.1', { kind: 'windows', confidence: 65 }),
        fingerprint('10.0.0.2'),
      ]);

      const hosts = await discovery.hosts(run.id);
      assert.equal(hosts[0]?.fingerprint?.kind, 'windows');
      assert.equal(hosts[1]?.fingerprint?.kind, 'linux');
      assert.equal((await mustGet(run.id)).identified, 2);
    });

    it('refuses a fingerprint for an address this run never found', async () => {
      // A probe answering about the wrong run would otherwise put a host into a run that never
      // saw it, and the run's counts would stop adding up.
      const run = await sweptAndFound(['10.0.0.1']);
      await discovery.identified(run.id, 1, [fingerprint('192.0.2.99')]);
      assert.equal((await mustGet(run.id)).identified, 0);
      assert.equal((await discovery.hosts(run.id))[0]?.fingerprint, null);
    });

    it('drops what it cannot read rather than writing it into the column', async () => {
      // The wire schema deliberately does not enumerate a fingerprint's fields, so this is the
      // boundary. TypeScript would not have caught it either — `DiscoverySink` declares
      // `unknown[]` and method parameters are bivariant.
      const run = await sweptAndFound(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
      await discovery.identified(run.id, 3, [
        fingerprint('10.0.0.1'),
        { address: '10.0.0.2', kind: 'quantum-toaster', confidence: 99, ports: [], evidence: [] },
        { kind: 'linux', confidence: 10, ports: [], evidence: [] },
        'not an object',
        null,
      ]);
      assert.equal((await mustGet(run.id)).identified, 1);
      const hosts = await discovery.hosts(run.id);
      assert.equal(hosts[0]?.fingerprint?.kind, 'linux');
      assert.equal(hosts[1]?.fingerprint, null, 'an unknown kind is not written');
    });

    it('keeps a field it does not know about, because a newer probe may send one', async () => {
      // The column is jsonb and the shape grows. Dropping an unrecognised field would lose
      // information a later release knows how to read.
      const run = await sweptAndFound(['10.0.0.1']);
      await discovery.identified(run.id, 1, [
        fingerprint('10.0.0.1', { somethingNewer: { model: 'X99' } }),
      ]);
      const stored = (await discovery.hosts(run.id))[0]?.fingerprint as
        Record<string, unknown> | null | undefined;
      assert.deepEqual(stored?.['somethingNewer'], { model: 'X99' });
    });

    it('makes a replayed fingerprint free, as the sweep does for a replayed host', async () => {
      const run = await sweptAndFound(['10.0.0.1']);
      await discovery.identified(run.id, 1, [fingerprint('10.0.0.1')]);
      await discovery.identified(run.id, 1, [fingerprint('10.0.0.1', { kind: 'windows' })]);
      assert.equal((await mustGet(run.id)).identified, 1);
      assert.equal(
        (await discovery.hosts(run.id))[0]?.fingerprint?.kind,
        'linux',
        'and the first answer stands rather than being overwritten by a replay',
      );
    });

    it('adds the probe’s cursor to its own rather than replacing it', async () => {
      // The probe counts from the start of the batch it was handed. Replacing would walk a
      // resumed pass back to the start of the list.
      const run = await sweptAndFound(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
      await discovery.identified(run.id, 2, []);
      assert.equal((await mustGet(run.id)).identifyCursor, 2);
      await discovery.identified(run.id, 1, []);
      assert.equal((await mustGet(run.id)).identifyCursor, 3);
    });

    it('finishes the run when a batch comes back empty', async () => {
      const run = await sweptAndFound(['10.0.0.1']);
      await discovery.identified(run.id, 1, [fingerprint('10.0.0.1')]);
      await discovery.identifyFinished(run.id, 'done', '');
      const after = await mustGet(run.id);
      assert.equal(after.status, 'done');
      assert.ok(after.finishedAt !== null);
    });

    it('leaves a pass the probe stopped waiting to be resumed', async () => {
      // A probe restarting reports `cancelled` for everything it was doing. The run stays
      // `identifying` so the next connect picks it up from its own cursor.
      const run = await sweptAndFound(['10.0.0.1', '10.0.0.2']);
      await discovery.identified(run.id, 1, [fingerprint('10.0.0.1')]);
      await discovery.identifyFinished(run.id, 'cancelled', '');
      assert.equal((await mustGet(run.id)).status, 'identifying');

      sent = [];
      await discovery.pump(probeId);
      const message = sent.at(-1);
      assert.ok(message !== undefined && message.kind === 'identify');
      assert.deepEqual(message.job.addresses, ['10.0.0.2'], 'and resumes from its own cursor');
    });

    it('fails the run when identification failed', async () => {
      const run = await sweptAndFound(['10.0.0.1']);
      await discovery.identifyFinished(run.id, 'failed', 'the resolver is not reachable');
      const after = await mustGet(run.id);
      assert.equal(after.status, 'failed');
      assert.match(after.message, /resolver/);
    });

    it('cancels both stages, because the status no longer says which was running', async () => {
      const run = await sweptAndFound(['10.0.0.1']);
      sent = [];
      await discovery.cancel(run.id);
      assert.deepEqual(
        sent.map((one) => one.kind),
        ['cancel', 'identify-cancel'],
      );
      assert.equal((await mustGet(run.id)).status, 'cancelled');
    });

    it('fails a run whose batch stops making progress, rather than looping for ever', async () => {
      // **Found live**, where a fingerprint PostgreSQL refused made the write throw, the cursor
      // never advanced, and the core and the probe re-ran the same batch 298 times in three
      // minutes. Every component behaved correctly on its own — the endpoint caught the error,
      // the probe answered every job, the service resumed from the cursor it had. What was
      // missing was anybody noticing that no progress was being made.
      const run = await sweptAndFound(['10.0.0.1', '10.0.0.2']);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await discovery.identifyFinished(run.id, 'done', '');
      }
      const after = await mustGet(run.id);
      assert.equal(after.status, 'failed');
      assert.match(after.message, /stopped making progress/);
      assert.equal(discovery.stats().stalled, 1, 'and it is counted, not only logged');
    });

    it('does not count an offer as stalled when the cursor is moving', async () => {
      const run = await sweptAndFound(['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await discovery.identified(run.id, 1, []);
        await discovery.identifyFinished(run.id, 'done', '');
      }
      // Four hosts, so the fifth pass finds an empty batch and finishes the run cleanly.
      assert.equal((await mustGet(run.id)).status, 'done');
      assert.equal(discovery.stats().stalled, 0);
    });

    it('does not send a run mid-identification back to the sweep on a disconnect', async () => {
      // `queued` would re-run the sweep it has already finished.
      const run = await sweptAndFound(['10.0.0.1']);
      await discovery.probeDisconnected(probeId);
      assert.equal((await mustGet(run.id)).status, 'identifying');
    });
  });

  it('is a real error type, so the API answers 400 rather than 500', () => {
    const error = new DiscoveryError('DISCOVERY_RANGE_INVALID', 'nope');
    assert.equal(error.status, 400);
    assert.equal(new DiscoveryError('DISCOVERY_RUN_NOT_FOUND', 'nope').status, 404);
  });
});
