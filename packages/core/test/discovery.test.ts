import { strict as assert } from 'node:assert';
import { parseCoreToProbe } from '@ms/shared';
import { DatabaseAuditSink } from '../src/audit/store.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DiscoveryService, type DispatchMessage } from '../src/discovery/service.js';
import { DiscoveryError } from '../src/discovery/errors.js';
import { ProbeRefusals } from '../src/probes/refusals.js';
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
  let tooOld = false;
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
    tooOld = false;

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
      audit: new DatabaseAuditSink(),
      logger: silentLogger,
      dispatch: (_probeId, message) => {
        if (tooOld) return { kind: 'too-old', protocolVersion: 2, needs: 4 };
        if (!connected) return { kind: 'offline' };
        sent.push(message);
        return { kind: 'sent' };
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
    discovery.start({ groupId, probeId, range, timeoutMs: 500, concurrency: 8 }, testActor);

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

    it('fails a run whose probe can never accept it, rather than waiting forever', async () => {
      // **`offline` and `too-old` used to be the same answer**, and the consequences are
      // opposite: waiting is right for a probe that is coming back and wrong for one whose build
      // will never understand the message. Such a run reported "waiting for a probe" for as long
      // as anybody left it, which is indistinguishable from the ordinary case above.
      tooOld = true;
      const run = await start();

      const stored = await mustGet(run.id);
      assert.equal(stored.status, 'failed');
      assert.match(stored.message, /protocol 2/, 'names what the probe speaks');
      assert.match(stored.message, /needs 4/, 'and what the stage needs');
      assert.match(stored.message, /upgrade the probe/, 'and what to do about it');
    });

    it('does not re-offer a run it failed for skew', async () => {
      tooOld = true;
      const run = await start();
      assert.equal((await mustGet(run.id)).status, 'failed');

      // A pump after the probe reconnects must not resurrect it: the run was ended with a
      // reason, and quietly restarting it would discard that reason.
      tooOld = false;
      await discovery.pump(probeId);
      assert.equal((await mustGet(run.id)).status, 'failed');
      assert.equal(sent.length, 0);
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
        probeId,
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
        probeId,
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
      await discovery.progress(probeId, run.id, 3, [{ address: '10.0.0.1', rttMs: 0.4 }], 0);
      await discovery.progress(probeId, run.id, 4, [{ address: '10.0.0.1', rttMs: 0.9 }], 0);

      const after = await mustGet(run.id);
      assert.equal(after.found, 1, 'the same host twice is one host');
      assert.equal((await discovery.hosts(run.id)).length, 1);
    });

    it('never walks the cursor backwards', async () => {
      // A probe that resumed from an older position and reported it would otherwise make the
      // run sweep the range twice.
      const run = await start();
      await discovery.progress(probeId, run.id, 5, [], 0);
      await discovery.progress(probeId, run.id, 2, [], 0);
      assert.equal((await mustGet(run.id)).cursor, 5);
    });

    it('counts addresses that could not be attempted', async () => {
      // A firewalled network and an empty one look identical without this.
      const run = await start();
      await discovery.progress(probeId, run.id, 2, [], 2);
      await discovery.progress(probeId, run.id, 4, [], 1);
      assert.equal((await mustGet(run.id)).failed, 3);
    });

    it('ignores progress for a run that is no longer running', async () => {
      // A cancelled run whose last in-flight pings are still reporting must not come back to
      // life, or a cancel would look like it did nothing.
      const run = await start();
      await discovery.cancel(run.id, testActor);
      await discovery.progress(probeId, run.id, 6, [], 0);
      const after = await mustGet(run.id);
      assert.equal(after.status, 'cancelled');
      assert.equal(after.cursor, 0, 'the cursor did not move');
    });
  });

  describe('finishing', () => {
    it('records a completed run', async () => {
      const run = await start();
      await discovery.finished(probeId, run.id, 'done', 6, '');
      const after = await mustGet(run.id);
      assert.equal(after.status, 'done');
      assert.equal(after.cursor, 6);
      assert.ok(after.finishedAt !== null);
    });

    it('records a failure with what to tell the operator', async () => {
      const run = await start();
      await discovery.finished(probeId, run.id, 'failed', 2, 'the "ping" binary is not available');
      const after = await mustGet(run.id);
      assert.equal(after.status, 'failed');
      assert.match(after.message, /ping/);
    });

    it('sends a run the probe stopped back to the queue, not to failed', async () => {
      // A probe restarting reports `cancelled` for everything it was doing. Marking those
      // failed would have an operator restarting a sweep that only needed to wait.
      const run = await start();
      await discovery.progress(probeId, run.id, 4, [], 0);
      await discovery.finished(probeId, run.id, 'cancelled', 4, '');

      const after = await mustGet(run.id);
      assert.equal(after.status, 'queued');
      assert.equal(after.cursor, 4, 'and it resumes from where it stopped');
    });

    it('keeps a run the operator cancelled cancelled', async () => {
      const run = await start();
      await discovery.cancel(run.id, testActor);
      await discovery.finished(probeId, run.id, 'cancelled', 3, '');
      assert.equal((await mustGet(run.id)).status, 'cancelled');
    });

    it('treats superseded as not an ending at all', async () => {
      // It means a newer `sweep-start` for the same run took over. Recording it as an ending
      // would mark a run finished at the moment it restarted.
      const run = await start();
      await discovery.finished(probeId, run.id, 'superseded', 2, '');
      assert.equal((await mustGet(run.id)).status, 'running');
    });
  });

  describe('cancelling', () => {
    it('records the decision even when the probe is unreachable', async () => {
      // Otherwise the operator's click did nothing and the sweep resumes the moment the probe
      // comes back.
      const run = await start();
      connected = false;
      const cancelled = await discovery.cancel(run.id, testActor);
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
      await discovery.cancel(run.id, testActor);
      assert.deepEqual(sent, [
        { kind: 'cancel', runId: run.id },
        { kind: 'identify-cancel', runId: run.id },
      ]);
    });

    it('answers null for a run that has already finished', async () => {
      const run = await start();
      await discovery.finished(probeId, run.id, 'done', 6, '');
      assert.equal(await discovery.cancel(run.id, testActor), null);
    });
  });

  describe('a probe that dropped', () => {
    it('releases its runs for a resume rather than failing them', async () => {
      const run = await start();
      await discovery.progress(probeId, run.id, 3, [{ address: '10.0.0.1', rttMs: 1 }], 0);
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
      await discovery.cancel(run.id, testActor);
      await discovery.probeDisconnected(probeId);
      assert.equal((await mustGet(run.id)).status, 'cancelled');
    });
  });

  describe('listing', () => {
    it('lists a group’s runs newest first', async () => {
      const first = await start('10.0.0.0/29');
      await discovery.finished(probeId, first.id, 'done', 6, '');
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
        probeId,
        run.id,
        6,
        addresses.map((address) => ({ address, rttMs: 1 })),
        0,
      );
      await discovery.finished(probeId, run.id, 'done', 6, '');
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

    it('fails rather than identifying against a probe too old for the stage', async () => {
      // **The second stage arrived in a later protocol version than the first**, so a probe can
      // be new enough to sweep and too old to identify — which means this path is reachable
      // without the run ever having been refused. Left alone it stayed `identifying` forever,
      // with a progress bar that had finished sweeping and would never finish anything else.
      const run = await start();
      await discovery.progress(probeId, run.id, 6, [{ address: '10.0.0.1', rttMs: 1 }], 0);

      tooOld = true;
      await discovery.finished(probeId, run.id, 'done', 6, '');

      const stored = await mustGet(run.id);
      assert.equal(stored.status, 'failed');
      assert.match(stored.message, /identification needs 4/);
      assert.match(stored.message, /protocol 2/);
    });

    it('ends the run without identifying when the level says ping only', async () => {
      const run = await discovery.start(
        {
          groupId,
          probeId,
          range: '10.0.0.0/29',
          level: 'ping',
        },
        testActor,
      );
      await discovery.progress(probeId, run.id, 6, [{ address: '10.0.0.1', rttMs: 1 }], 0);
      await discovery.finished(probeId, run.id, 'done', 6, '');
      assert.equal((await mustGet(run.id)).status, 'done');
    });

    it('ends the run without identifying when the sweep found nothing', async () => {
      const run = await start();
      await discovery.finished(probeId, run.id, 'done', 6, '');
      assert.equal((await mustGet(run.id)).status, 'done');
    });

    it('stores a fingerprint against the host it belongs to', async () => {
      const run = await sweptAndFound(['10.0.0.1', '10.0.0.2']);
      await discovery.identified(probeId, run.id, 2, [
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
      await discovery.identified(probeId, run.id, 1, [fingerprint('192.0.2.99')]);
      assert.equal((await mustGet(run.id)).identified, 0);
      assert.equal((await discovery.hosts(run.id))[0]?.fingerprint, null);
    });

    it('drops what it cannot read rather than writing it into the column', async () => {
      // The wire schema deliberately does not enumerate a fingerprint's fields, so this is the
      // boundary. TypeScript would not have caught it either — `DiscoverySink` declares
      // `unknown[]` and method parameters are bivariant.
      const run = await sweptAndFound(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
      await discovery.identified(probeId, run.id, 3, [
        fingerprint('10.0.0.1'),
        { address: '10.0.0.2', kind: 'quantum-toaster', confidence: 99, ports: [], evidence: [] },
        { kind: 'linux', confidence: 10, ports: [], evidence: [] },
        'not an object',
        null,
        // The two a template's criteria would have thrown on (`D-12`).
        fingerprint('10.0.0.3', { vendor: 5 }),
        fingerprint('10.0.0.3', { ports: [null] }),
      ]);
      assert.equal((await mustGet(run.id)).identified, 1);
      const hosts = await discovery.hosts(run.id);
      assert.equal(hosts[0]?.fingerprint?.kind, 'linux');
      assert.equal(hosts[1]?.fingerprint, null, 'an unknown kind is not written');
      assert.equal(hosts[2]?.fingerprint, null, 'a numeric vendor or a null port is not written');
    });

    it('reads a stored fingerprint the matcher could not as unidentified (D-12)', async () => {
      // Written before `D-12`, whose reader let a numeric vendor through: the run's plan read it
      // and answered 500. Now it reads as a host nobody identified, which gets the generic plan.
      const run = await sweptAndFound(['10.0.0.1', '10.0.0.2']);
      await discovery.identified(probeId, run.id, 2, [
        fingerprint('10.0.0.1'),
        fingerprint('10.0.0.2'),
      ]);
      await db.query(
        `UPDATE discovery_host SET fingerprint = fingerprint || '{"vendor": 5}'::jsonb
         WHERE run_id = $1 AND address = '10.0.0.2'::inet`,
        [run.id],
      );
      const hosts = await discovery.hosts(run.id);
      assert.equal(hosts[0]?.fingerprint?.kind, 'linux');
      assert.equal(hosts[1]?.fingerprint, null);
    });

    it('keeps a field it does not know about, because a newer probe may send one', async () => {
      // The column is jsonb and the shape grows. Dropping an unrecognised field would lose
      // information a later release knows how to read.
      const run = await sweptAndFound(['10.0.0.1']);
      await discovery.identified(probeId, run.id, 1, [
        fingerprint('10.0.0.1', { somethingNewer: { model: 'X99' } }),
      ]);
      const stored = (await discovery.hosts(run.id))[0]?.fingerprint as
        Record<string, unknown> | null | undefined;
      assert.deepEqual(stored?.['somethingNewer'], { model: 'X99' });
    });

    it('makes a replayed fingerprint free, as the sweep does for a replayed host', async () => {
      const run = await sweptAndFound(['10.0.0.1']);
      await discovery.identified(probeId, run.id, 1, [fingerprint('10.0.0.1')]);
      await discovery.identified(probeId, run.id, 1, [
        fingerprint('10.0.0.1', { kind: 'windows' }),
      ]);
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
      await discovery.identified(probeId, run.id, 2, []);
      assert.equal((await mustGet(run.id)).identifyCursor, 2);
      await discovery.identified(probeId, run.id, 1, []);
      assert.equal((await mustGet(run.id)).identifyCursor, 3);
    });

    it('finishes the run when a batch comes back empty', async () => {
      const run = await sweptAndFound(['10.0.0.1']);
      await discovery.identified(probeId, run.id, 1, [fingerprint('10.0.0.1')]);
      await discovery.identifyFinished(probeId, run.id, 'done', '');
      const after = await mustGet(run.id);
      assert.equal(after.status, 'done');
      assert.ok(after.finishedAt !== null);
    });

    it('leaves a pass the probe stopped waiting to be resumed', async () => {
      // A probe restarting reports `cancelled` for everything it was doing. The run stays
      // `identifying` so the next connect picks it up from its own cursor.
      const run = await sweptAndFound(['10.0.0.1', '10.0.0.2']);
      await discovery.identified(probeId, run.id, 1, [fingerprint('10.0.0.1')]);
      await discovery.identifyFinished(probeId, run.id, 'cancelled', '');
      assert.equal((await mustGet(run.id)).status, 'identifying');

      sent = [];
      await discovery.pump(probeId);
      const message = sent.at(-1);
      assert.ok(message !== undefined && message.kind === 'identify');
      assert.deepEqual(message.job.addresses, ['10.0.0.2'], 'and resumes from its own cursor');
    });

    it('fails the run when identification failed', async () => {
      const run = await sweptAndFound(['10.0.0.1']);
      await discovery.identifyFinished(probeId, run.id, 'failed', 'the resolver is not reachable');
      const after = await mustGet(run.id);
      assert.equal(after.status, 'failed');
      assert.match(after.message, /resolver/);
    });

    it('cancels both stages, because the status no longer says which was running', async () => {
      const run = await sweptAndFound(['10.0.0.1']);
      sent = [];
      await discovery.cancel(run.id, testActor);
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
        await discovery.identifyFinished(probeId, run.id, 'done', '');
      }
      const after = await mustGet(run.id);
      assert.equal(after.status, 'failed');
      assert.match(after.message, /stopped making progress/);
      assert.equal(discovery.stats().stalled, 1, 'and it is counted, not only logged');
    });

    it('does not count an offer as stalled when the cursor is moving', async () => {
      const run = await sweptAndFound(['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await discovery.identified(probeId, run.id, 1, []);
        await discovery.identifyFinished(probeId, run.id, 'done', '');
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

  /**
   * Discovery levels (`D-06`).
   *
   * A level is a real trade of time against what it finds, and the two halves of that live in
   * different places: the level table decides what to ask, and the estimate says what it costs.
   * What is asserted here is that the run actually carries the level's choices to the probe —
   * an estimate about a run that then behaves differently is worse than no estimate.
   */
  describe('levels', () => {
    const sweptAndDone = async (level: 'ping' | 'standard' | 'detailed') => {
      const record = await discovery.start(
        { groupId, probeId, range: '10.0.0.0/29', level },
        testActor,
      );
      await discovery.progress(probeId, record.id, 6, [{ address: '10.0.0.1', rttMs: 1 }], 0);
      sent = [];
      await discovery.finished(probeId, record.id, 'done', 6, '');
      return record;
    };

    it('defaults to standard', async () => {
      assert.equal((await start()).level, 'standard');
    });

    it('stops after the sweep at ping level', async () => {
      const record = await sweptAndDone('ping');
      assert.equal((await mustGet(record.id)).status, 'done');
      assert.equal(sent.length, 0, 'and asked the probe nothing further');
    });

    it('sends the level’s ports and its own timeout, not the sweep’s', async () => {
      // A sweep's timeout is how long to wait for an ICMP echo; identification's is how long to
      // wait for a TCP handshake, a resolver and an SNMP agent. Conflating them made `detailed`
      // no more patient than `standard`.
      const standard = await sweptAndDone('standard');
      const first = sent.at(-1);
      assert.ok(first !== undefined && first.kind === 'identify');
      const standardPorts = first.job.ports ?? [];
      assert.ok(standardPorts.length > 0);
      const standardTimeout = first.job.timeoutMs;

      // One run per probe at a time, so this one has to finish before the next is offered.
      await discovery.identified(probeId, standard.id, 1, []);
      await discovery.identifyFinished(probeId, standard.id, 'done', '');
      assert.equal((await mustGet(standard.id)).status, 'done');

      await sweptAndDone('detailed');
      const second = sent.at(-1);
      assert.ok(second !== undefined && second.kind === 'identify');
      assert.ok(
        (second.job.ports ?? []).length > standardPorts.length,
        'detailed asks about more ports',
      );
      assert.ok(second.job.timeoutMs > standardTimeout, 'and waits longer for each');
    });

    it('records which templates a run may use, empty meaning all', async () => {
      const all = await start();
      assert.deepEqual(all.templates, []);

      const some = await discovery.start(
        {
          groupId,
          probeId,
          range: '10.0.0.0/29',
          templates: ['acme.switch', 'acme.router'],
        },
        testActor,
      );
      assert.deepEqual((await mustGet(some.id)).templates, ['acme.switch', 'acme.router']);
    });

    it('reads a level it does not know as standard rather than refusing the run', async () => {
      // A newer core wrote the row and an older one is reading it. Doing the sensible thing
      // beats a run that cannot be resumed at all.
      const record = await start();
      await db.query(`UPDATE discovery_run SET level = 'ping' WHERE id = $1`, [record.id]);
      assert.equal((await mustGet(record.id)).level, 'ping');
    });
  });

  /**
   * The summary (`D-08`).
   *
   * The sentence and the arithmetic are proved without a database in
   * `discovery-summary.test.ts`; what needs a database is that the summary reads the *right*
   * columns and that the breakdown aggregates over what was actually stored. A summary assembled
   * from the wrong column is the failure a pure test cannot see, and it is the one that puts
   * confident wrong numbers on a page.
   */
  describe('the summary', () => {
    const fingerprint = (address: string, over: Record<string, unknown> = {}) => ({
      address,
      ports: [],
      kind: 'linux',
      confidence: 45,
      evidence: ['SSH is open'],
      ...over,
    });

    it('reports nothing for a run that is not there', async () => {
      assert.equal(await discovery.summary(999_999), null);
    });

    it('counts what was swept, found and identified', async () => {
      const run = await start();
      await discovery.progress(
        probeId,
        run.id,
        6,
        [
          { address: '10.0.0.1', rttMs: 1 },
          { address: '10.0.0.2', rttMs: 2 },
        ],
        1,
      );
      await discovery.finished(probeId, run.id, 'done', 6, '');
      await discovery.identified(probeId, run.id, 2, [
        fingerprint('10.0.0.1', { kind: 'windows', vendor: 'Dell' }),
        fingerprint('10.0.0.2', { vendor: 'Dell' }),
      ]);

      const summary = await discovery.summary(run.id);
      assert.ok(summary !== null);
      assert.equal(summary.scanned.addresses, 6);
      assert.equal(summary.scanned.swept, 6);
      assert.equal(summary.scanned.alive, 2);
      assert.equal(summary.scanned.failed, 1);
      assert.equal(summary.scanned.unreachable, 3, 'swept, silent, and not an error');
      assert.equal(summary.scanned.identified, 2);
      assert.equal(summary.scanned.complete, true);
      assert.deepEqual(summary.found.byVendor, [{ vendor: 'Dell', count: 2 }]);
      // Ordered by count, so the breakdown reads as "mostly X" without anybody sorting it.
      assert.deepEqual(summary.found.byKind.map((one) => one.kind).sort(), ['linux', 'windows']);
    });

    it('leaves a host whose vendor nothing said out of the vendor breakdown', async () => {
      // Most hosts have no vendor: nothing said so, and "23 hosts, vendor null" is the default
      // state of the column rather than a finding. The kind breakdown's null *is* a finding,
      // which is why only one of the two is filtered — and a null here would reach the API as a
      // required string. Found by a mutation: the first fixture gave every host a vendor.
      const run = await start();
      await discovery.progress(
        probeId,
        run.id,
        6,
        [
          { address: '10.0.0.1', rttMs: 1 },
          { address: '10.0.0.2', rttMs: 1 },
          { address: '10.0.0.3', rttMs: 1 },
        ],
        0,
      );
      await discovery.finished(probeId, run.id, 'done', 6, '');
      await discovery.identified(probeId, run.id, 3, [
        fingerprint('10.0.0.1', { vendor: 'Cisco' }),
        fingerprint('10.0.0.2'),
        fingerprint('10.0.0.3'),
      ]);

      const summary = await discovery.summary(run.id);
      assert.deepEqual(summary?.found.byVendor, [{ vendor: 'Cisco', count: 1 }]);
      // The two that said nothing are still counted as hosts, and still identified as Linux.
      assert.deepEqual(summary.found.byKind, [{ kind: 'linux', count: 3 }]);
    });

    it('counts a host nobody identified as unidentified rather than unknown', async () => {
      // A `ping` run identifies nothing, and that is the level working rather than failing.
      const run = await discovery.start(
        { groupId, probeId, range: '10.0.0.0/29', level: 'ping' },
        testActor,
      );
      await discovery.progress(probeId, run.id, 6, [{ address: '10.0.0.1', rttMs: 1 }], 0);
      await discovery.finished(probeId, run.id, 'done', 6, '');

      const summary = await discovery.summary(run.id);
      assert.deepEqual(summary?.found.byKind, [{ kind: 'unidentified', count: 1 }]);
    });

    it('carries what provisioning did, and what it could not do', async () => {
      // `ping`, so the sweep's ending is the run's ending — provisioning is what is under test
      // here and a run parked in `identifying` would only be testing the fixture.
      const run = await discovery.start(
        { groupId, probeId, range: '10.0.0.0/29', level: 'ping' },
        testActor,
      );
      await discovery.progress(probeId, run.id, 6, [{ address: '10.0.0.1', rttMs: 1 }], 0);
      await discovery.finished(probeId, run.id, 'done', 6, '');
      await discovery.recordProvisioning(run.id, {
        devicesCreated: 3,
        matched: 2,
        sensorsCreated: 9,
        problems: [{ address: '10.0.0.4', problem: 'no credential for snmp' }],
      });

      const summary = await discovery.summary(run.id);
      assert.ok(summary !== null);
      assert.equal(summary.created.devices, 3);
      assert.equal(summary.created.matched, 2);
      assert.equal(summary.created.sensors, 9);
      assert.notEqual(summary.created.provisionedAt, null);
      assert.deepEqual(summary.errors, [
        { address: '10.0.0.4', problem: 'no credential for snmp' },
      ]);
      assert.match(
        summary.headline,
        /3 devices and 9 sensors created, 2 already existed, 1 address had problems\./,
      );
    });

    it('reports a host the probe refused to identify as refused, not as identified (A-63)', async () => {
      const run = await start();
      await discovery.progress(
        probeId,
        run.id,
        6,
        [
          { address: '10.0.0.1', rttMs: 1 },
          { address: '10.0.0.2', rttMs: 1 },
          { address: '10.0.0.3', rttMs: 1 },
          { address: '10.0.0.4', rttMs: 1 },
        ],
        0,
      );
      await discovery.finished(probeId, run.id, 'done', 6, '');
      const why = 'not identified: refusing to identify 10.0.0.2, which is a private address';
      await discovery.identified(probeId, run.id, 3, [
        fingerprint('10.0.0.1'),
        fingerprint('10.0.0.2', { kind: 'unknown', confidence: 0, evidence: [why], refused: why }),
        fingerprint('10.0.0.3', { kind: 'unknown', confidence: 0, evidence: [] }),
      ]);
      await discovery.recordProvisioning(run.id, {
        devicesCreated: 0,
        matched: 0,
        sensorsCreated: 0,
        problems: [
          { address: '10.0.0.2', problem: 'no template matched' },
          { address: '10.0.0.4', problem: 'no credential for snmp' },
        ],
      });

      const summary = await discovery.summary(run.id);
      assert.ok(summary !== null);
      // Nothing was asked of it, so it is not among the identified...
      assert.equal(summary.scanned.identified, 2);
      // ...nor an `unknown`, which is a host that was looked at: it counts with the host
      // identification never reached.
      assert.deepEqual(
        [...summary.found.byKind].sort((a, b) => a.kind.localeCompare(b.kind)),
        [
          { kind: 'linux', count: 1 },
          { kind: 'unidentified', count: 2 },
          { kind: 'unknown', count: 1 },
        ],
      );
      // One entry an address, the refusal first, beside what provisioning could not do.
      assert.deepEqual(summary.errors, [
        { address: '10.0.0.2', problem: `${why}; no template matched` },
        { address: '10.0.0.4', problem: 'no credential for snmp' },
      ]);
      // And the reason is on the host, for whoever reads the hosts.
      const hosts = await discovery.hosts(run.id);
      assert.equal(hosts.find((one) => one.address === '10.0.0.2')?.fingerprint?.refused, why);
      assert.equal(
        hosts.find((one) => one.address === '10.0.0.1')?.fingerprint?.refused,
        undefined,
      );
    });

    it('lists a refused host that provisioning had no complaint about', async () => {
      const run = await start();
      await discovery.progress(probeId, run.id, 6, [{ address: '10.0.0.5', rttMs: 1 }], 0);
      await discovery.finished(probeId, run.id, 'done', 6, '');
      const why = 'not identified: refusing to identify 10.0.0.5';
      await discovery.identified(probeId, run.id, 1, [
        fingerprint('10.0.0.5', { kind: 'unknown', confidence: 0, evidence: [why], refused: why }),
      ]);
      const summary = await discovery.summary(run.id);
      assert.deepEqual(summary?.errors, [{ address: '10.0.0.5', problem: why }]);
      assert.equal(summary.scanned.identified, 0);
    });

    it('counts every host once whatever a probe says of it: the breakdown sums to the hosts (A-63)', async () => {
      // `refused` is a remote probe's word. Believed of a host with nothing found on it, and
      // set aside, with a line in the errors, where the same fingerprint carries findings.
      const why = 'not identified: refusing to identify it';
      const said = (over: Record<string, unknown>) => ({ kind: 'unknown', confidence: 0, ...over });
      const TABLE: readonly (readonly [string, Record<string, unknown> | null, string, boolean])[] =
        [
          // address, fingerprint (null: never identified), kind it counts as, whether identified
          ['10.0.0.1', said({ kind: 'linux' }), 'linux', true],
          ['10.0.0.2', said({ refused: why, evidence: [why] }), 'unidentified', false],
          ['10.0.0.3', said({ kind: 'windows', refused: why }), 'windows', true],
          ['10.0.0.4', said({ refused: why, sysDescr: 'Linux 6.1' }), 'unknown', true],
          [
            '10.0.0.5',
            said({ refused: why, ports: [{ port: 22, transport: 'tcp' }] }),
            'unknown',
            true,
          ],
          ['10.0.0.6', null, 'unidentified', false],
        ];
      const run = await start();
      await discovery.progress(
        probeId,
        run.id,
        6,
        TABLE.map(([address]) => ({ address, rttMs: 1 })),
        0,
      );
      await discovery.finished(probeId, run.id, 'done', 6, '');
      await discovery.identified(
        probeId,
        run.id,
        5,
        TABLE.filter(([, given]) => given !== null).map(([address, given]) =>
          fingerprint(address, given ?? {}),
        ),
      );

      const summary = await discovery.summary(run.id);
      assert.ok(summary !== null);
      const expected = new Map<string, number>();
      for (const [, , kind] of TABLE) expected.set(kind, (expected.get(kind) ?? 0) + 1);
      assert.deepEqual(
        new Map<string, number>(summary.found.byKind.map((one) => [one.kind, one.count])),
        expected,
      );
      // The invariant: every host is in the breakdown exactly once, and the identified and the
      // unidentified are all of them.
      const counted = summary.found.byKind.reduce((sum, one) => sum + one.count, 0);
      const unidentified =
        summary.found.byKind.find((one) => one.kind === 'unidentified')?.count ?? 0;
      assert.equal(counted, TABLE.length);
      assert.equal(summary.scanned.alive, TABLE.length);
      assert.equal(summary.scanned.identified, TABLE.filter(([, , , is]) => is).length);
      assert.equal(summary.scanned.identified + unidentified, TABLE.length);

      // The one refusal that is believed says what the probe said; each contradiction says so.
      const contradiction =
        'the probe reported this host as refused and also reported findings for it, so it is ' +
        `counted by what was found; the probe said: ${why}`;
      assert.deepEqual(summary.errors, [
        { address: '10.0.0.2', problem: why },
        { address: '10.0.0.3', problem: contradiction },
        { address: '10.0.0.4', problem: contradiction },
        { address: '10.0.0.5', problem: contradiction },
      ]);

      const hosts = await discovery.hosts(run.id);
      const of = (address: string) => hosts.find((one) => one.address === address)?.fingerprint;
      assert.equal(of('10.0.0.3')?.refused, undefined);
      assert.equal(of('10.0.0.3')?.refusalIgnored, why);
      assert.equal(of('10.0.0.2')?.refused, why);
    });

    it('shows a probe’s refusal as one bounded line, and cuts what is merged with it', async () => {
      const run = await start();
      await discovery.progress(
        probeId,
        run.id,
        6,
        [
          { address: '10.0.0.1', rttMs: 1 },
          { address: '10.0.0.2', rttMs: 1 },
        ],
        0,
      );
      await discovery.finished(probeId, run.id, 'done', 6, '');
      await discovery.identified(probeId, run.id, 2, [
        fingerprint('10.0.0.1', {
          kind: 'unknown',
          refused: `refused\n10.0.0.9 — forged line\u0001${'x'.repeat(5_000)}`,
        }),
        fingerprint('10.0.0.2', { kind: 'unknown', refused: 'refused' }),
      ]);
      await discovery.recordProvisioning(run.id, {
        devicesCreated: 0,
        matched: 0,
        sensorsCreated: 0,
        problems: [{ address: '10.0.0.2', problem: 'p'.repeat(2_000) }],
      });

      const summary = await discovery.summary(run.id);
      const [first, second] = summary?.errors ?? [];
      assert.ok(first !== undefined && second !== undefined);
      assert.equal(first.problem.length, 500);
      assert.ok(first.problem.startsWith('refused 10.0.0.9 — forged line x'), first.problem);
      // eslint-disable-next-line no-control-regex -- that there are none is the assertion.
      assert.doesNotMatch(first.problem, /[\u0000-\u001f\u007f-\u009f]/);
      // The refusal first, and the two together no longer than a provisioning problem may be.
      assert.equal(second.problem.length, 2_000);
      assert.ok(second.problem.startsWith('refused; ppp'));
    });

    it('cleans a refusal that was stored by something other than the check', async () => {
      const run = await start();
      await discovery.progress(probeId, run.id, 6, [{ address: '10.0.0.1', rttMs: 1 }], 0);
      await db.query(`UPDATE discovery_host SET fingerprint = $2::jsonb WHERE run_id = $1`, [
        run.id,
        JSON.stringify({
          address: '10.0.0.1',
          kind: 'unknown',
          ports: [],
          refused: `a\nb${'y'.repeat(5_000)}`,
        }),
      ]);
      const summary = await discovery.summary(run.id);
      const problem = summary?.errors[0]?.problem ?? '';
      assert.equal(problem.length, 500);
      assert.ok(problem.startsWith('a by'), problem.slice(0, 20));
    });

    it('stores a probe’s text bounded, whatever length it arrived at (A-69)', async () => {
      const run = await start();
      await discovery.progress(probeId, run.id, 6, [{ address: '10.0.0.1', rttMs: 1 }], 0);
      await discovery.finished(probeId, run.id, 'done', 6, '');
      await discovery.identified(probeId, run.id, 1, [
        {
          address: '10.0.0.1',
          kind: 'linux',
          confidence: 45,
          sysDescr: `Linux\r\n${'d'.repeat(50_000)}`,
          sysName: 'n'.repeat(50_000),
          ports: Array.from({ length: 200 }, (_, at) => ({
            port: at + 1,
            transport: 'tcp',
            banner: 'b'.repeat(50_000),
          })),
          evidence: Array.from({ length: 200 }, () => 'e'.repeat(50_000)),
        },
      ]);
      const rows = await db.query<{ stored: Record<string, unknown>; size: number }>(
        `SELECT fingerprint AS stored, length(fingerprint::text) AS size
         FROM discovery_host WHERE run_id = $1`,
        [run.id],
      );
      const stored = rows[0]?.stored ?? {};
      assert.equal(stored['sysDescr'], `Linux ${'d'.repeat(994)}`);
      assert.equal(stored['sysName'], 'n'.repeat(255));
      const ports = stored['ports'] as { banner: string }[];
      assert.equal(ports.length, 64);
      assert.ok(ports.every((one) => one.banner === 'b'.repeat(200)));
      const evidence = stored['evidence'] as string[];
      assert.equal(evidence.length, 32);
      assert.ok(evidence.every((one) => one === 'e'.repeat(500)));
      // Twenty megabytes arrived. What is kept is a few dozen kilobytes.
      assert.ok((rows[0]?.size ?? 0) < 40_000, `stored ${String(rows[0]?.size)} characters`);
    });

    it('reads a row stored before the bound as bounded, and writes nothing back (A-69)', async () => {
      const run = await start();
      await discovery.progress(probeId, run.id, 6, [{ address: '10.0.0.1', rttMs: 1 }], 0);
      const old = {
        address: '10.0.0.1',
        kind: 'linux',
        confidence: 45,
        ports: [{ port: 22, transport: 'tcp', banner: `SSH-2.0\r\n${'b'.repeat(900)}` }],
        sysName: `sw-01\n${'n'.repeat(900)}`,
        evidence: ['e'.repeat(900)],
      };
      await db.query(`UPDATE discovery_host SET fingerprint = $2::jsonb WHERE run_id = $1`, [
        run.id,
        JSON.stringify(old),
      ]);
      const stored = async (): Promise<unknown> =>
        (
          await db.query<{ fingerprint: unknown }>(
            `SELECT fingerprint FROM discovery_host WHERE run_id = $1`,
            [run.id],
          )
        )[0]?.fingerprint;

      const [host] = await discovery.hosts(run.id);
      assert.equal(host?.fingerprint?.sysName, `sw-01 ${'n'.repeat(249)}`);
      assert.equal(host.fingerprint.ports[0]?.banner, `SSH-2.0 ${'b'.repeat(192)}`);
      assert.deepEqual(host.fingerprint.evidence, ['e'.repeat(500)]);
      await discovery.summary(run.id);
      // The row is as it was written: a read bounds what it hands on and rewrites nothing.
      assert.deepEqual(await stored(), old);
    });

    it('offers identification only dotted quads, whatever a probe said it found (A-69)', async () => {
      // `identify-start` takes IPv4 and nothing else. `sweep-progress` is held only to a length
      // and the column is `inet`, so a probe that is not ours can have left an IPv6 row; here
      // one is written as such a probe's report would be. It is never offered: a frame carrying
      // it would be refused by the probe it was sent to.
      sent = [];
      const run = await start();
      await discovery.progress(
        probeId,
        run.id,
        6,
        [
          { address: '10.0.0.2', rttMs: 1 },
          { address: 'fe80::1', rttMs: 1 },
          { address: '::ffff:10.0.0.9', rttMs: 1 },
          { address: '10.0.0.1', rttMs: 1 },
        ],
        0,
      );
      await discovery.finished(probeId, run.id, 'done', 6, '');
      const message = sent.at(-1);
      assert.ok(message !== undefined && message.kind === 'identify');
      assert.deepEqual(message.job.addresses, ['10.0.0.1', '10.0.0.2']);
      // And what is offered is a frame the probe's own parser takes.
      assert.equal(
        parseCoreToProbe({ type: 'identify-start', job: message.job }).type,
        'identify-start',
      );
      // The control: with either of the other rows in it, the frame is one the probe refuses.
      assert.throws(() =>
        parseCoreToProbe({
          type: 'identify-start',
          job: { ...message.job, addresses: ['10.0.0.1', 'fe80::1'] },
        }),
      );

      // The pass ends, and the rows it left out are still there, unidentified.
      await discovery.identified(probeId, run.id, 2, [
        fingerprint('10.0.0.1'),
        fingerprint('10.0.0.2'),
      ]);
      await discovery.identifyFinished(probeId, run.id, 'done', '');
      assert.equal((await mustGet(run.id)).status, 'done');
      const summary = await discovery.summary(run.id);
      assert.deepEqual(
        [...(summary?.found.byKind ?? [])].sort((a, b) => a.kind.localeCompare(b.kind)),
        [
          { kind: 'linux', count: 2 },
          { kind: 'unidentified', count: 2 },
        ],
      );
    });

    it('says where a run nobody started came from', async () => {
      // `D-07`. The schedule id is on the run row, because the question is asked from the run's
      // end and a schedule holds only its most recent one.
      const run = await start();
      const rows = await db.query<{ id: string }>(
        `INSERT INTO discovery_schedule
           (group_id, probe_id, name, range_text, cadence)
         VALUES ($1, $2, 'Nightly', '10.0.0.0/29', 'daily')
         RETURNING id::text AS id`,
        [groupId, probeId],
      );
      const scheduleId = Number(rows[0]?.id);
      await db.query(`UPDATE discovery_run SET schedule_id = $2 WHERE id = $1`, [
        run.id,
        scheduleId,
      ]);

      assert.equal((await discovery.summary(run.id))?.scheduleId, scheduleId);
    });
  });

  /**
   * Only the probe a run was dispatched to may report on it (`P-228`).
   *
   * The messages used to name a run and nothing else, and every write was `WHERE id = $1`: a
   * probe could add hosts to another probe's run, write the fingerprints provisioning turns into
   * devices, and finish it — which is what provisions it (`D-07`).
   */
  describe('a probe other than the run’s', () => {
    const fingerprint = (address: string) => ({
      address,
      ports: [{ port: 22, transport: 'tcp' }],
      kind: 'linux',
      confidence: 45,
      evidence: ['SSH is open'],
    });

    let refusals: ProbeRefusals;
    let finished: number[];
    let otherId = 0;

    beforeEach(async () => {
      refusals = new ProbeRefusals();
      finished = [];
      const other = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: `other-${String(process.hrtime.bigint())}`,
      });
      otherId = other.id;
      discovery = new DiscoveryService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silentLogger,
        dispatch: (_probeId, message) => {
          sent.push(message);
          return { kind: 'sent' };
        },
        onFinished: (runId) => {
          finished.push(runId);
          return Promise.resolve();
        },
        refusals,
      });
    });

    const hostsOf = async (runId: number): Promise<number> => {
      const rows = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM discovery_host WHERE run_id = $1',
        [runId],
      );
      return Number(rows[0]?.n ?? 0);
    };

    it('writes nothing for its sweep messages, and does not finish the run', async () => {
      const run = await start();
      await discovery.progress(otherId, run.id, 6, [{ address: '10.0.0.1', rttMs: 1 }], 2);
      await discovery.finished(otherId, run.id, 'done', 6, '');
      await discovery.finished(otherId, run.id, 'failed', 6, 'forged');

      const after = await mustGet(run.id);
      assert.equal(after.status, 'running');
      assert.equal(after.cursor, 0);
      assert.equal(after.found, 0);
      assert.equal(await hostsOf(run.id), 0, 'no host planted in the run');
      assert.deepEqual(finished, [], 'and nothing announced to provisioning');
      assert.deepEqual(refusals.countsFor(otherId), { refused: 3, foreignRecently: 3 });
      assert.equal(discovery.stats().foreign, 3);
    });

    it('writes no fingerprint and ends no identification', async () => {
      const run = await start();
      await discovery.progress(probeId, run.id, 6, [{ address: '10.0.0.1', rttMs: 1 }], 0);
      await discovery.finished(probeId, run.id, 'done', 6, '');
      assert.equal((await mustGet(run.id)).status, 'identifying');
      const offered = sent.length;

      await discovery.identified(otherId, run.id, 1, [fingerprint('10.0.0.1')]);
      await discovery.identifyFinished(otherId, run.id, 'done', '');
      await discovery.identifyFinished(otherId, run.id, 'failed', 'forged');

      const after = await mustGet(run.id);
      assert.equal(after.status, 'identifying');
      assert.equal(after.identified, 0);
      assert.equal((await discovery.hosts(run.id))[0]?.fingerprint ?? null, null);
      assert.equal(sent.length, offered, 'no next batch offered on its say-so');
      assert.deepEqual(finished, []);
      assert.equal(refusals.countsFor(otherId).foreignRecently, 3);
    });

    it('lets the run’s own probe carry on as before', async () => {
      const run = await start();
      await discovery.progress(otherId, run.id, 6, [{ address: '10.0.0.9', rttMs: 1 }], 0);
      await discovery.progress(probeId, run.id, 3, [{ address: '10.0.0.1', rttMs: 1 }], 0);

      const after = await mustGet(run.id);
      assert.equal(after.cursor, 3);
      assert.equal(after.found, 1);
      assert.equal(await hostsOf(run.id), 1);
      assert.deepEqual(refusals.countsFor(probeId), { refused: 0, foreignRecently: 0 });
    });

    it('refuses a GID no probe object has claimed, which was dispatched nothing', async () => {
      const run = await start();
      await discovery.progress(null, run.id, 6, [{ address: '10.0.0.1', rttMs: 1 }], 0);
      assert.equal(await hostsOf(run.id), 0);
      assert.deepEqual(refusals.stats(), { refused: 1, foreign: 1 });
    });

    it('refuses a run that no longer exists without calling it foreign', async () => {
      // A group deleted while its probe was still sweeping: the probe reports on a run the
      // cascade took with it. Ordinary, and counted as refused only.
      await discovery.progress(probeId, 2_000_000_000, 6, [], 0);
      assert.deepEqual(refusals.countsFor(probeId), { refused: 1, foreignRecently: 0 });
      assert.equal(discovery.stats().foreign, 0);
    });
  });
});
