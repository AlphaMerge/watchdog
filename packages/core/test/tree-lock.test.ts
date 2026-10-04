import { strict as assert } from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Client } from 'pg';
import { DatabaseAuditSink } from '../src/audit/store.js';
import { Visibility } from '../src/auth/access.js';
import { Database } from '../src/db/pool.js';
import { DeviceTemplateCatalogue } from '../src/device-templates/index.js';
import {
  ProvisionService,
  type ExistingDevice,
  type ProvisionReport,
} from '../src/discovery/provision.js';
import { DiscoveryService } from '../src/discovery/service.js';
import { BulkService } from '../src/objects/bulk.js';
import { ObjectError } from '../src/objects/errors.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  testDatabaseConfig,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor, type Harness } from './support/tree.js';
import { within } from './support/within.js';

const available = await databaseAvailable();

/** What a change waits for the tree here, scaled down from the core's 30 s. */
const WAIT_MS = 300;
/**
 * The bound on every wait behind the held tree. Well past one wait and short of a hang: a change
 * that ignored the limit would otherwise wait on the holder, and the holder is let go in the
 * `finally` that the wait never reaches.
 */
const BOUND_MS = WAIT_MS * 10;

/** What a provisioning run is offered: four hosts, so "the rest" is more than one. */
const HOSTS = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'];

/**
 * `P-229`: the object tree's lock is waited for, not waited on for ever.
 *
 * Before, a create, move or delete behind a lock held elsewhere held a pool connection for as
 * long as the lock was held. Now it waits `TREE_LOCK_WAIT_MS` (30 s; `WAIT_MS` here) and gives up
 * as `OBJECT_TREE_BUSY`, changing nothing. And every caller that is not one request, a bulk
 * selection and a discovery's provisioning, stops at the first one rather than waiting again for
 * every object after it.
 */
describe('P-229: the tree lock', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let h: Harness;
  let holder: Client;
  let groupId = 0;
  let probeId = 0;

  /** Holds the tree as a structural change does, from a session the core does not own. */
  async function holdTree(): Promise<void> {
    await holder.query(`SELECT pg_advisory_lock(hashtext('ms:object-tree')::bigint)`);
  }
  async function releaseTree(): Promise<void> {
    await holder.query(`SELECT pg_advisory_unlock(hashtext('ms:object-tree')::bigint)`);
  }

  before(async () => {
    scratch = await createScratchDatabase('treelock');
    // The pool's own lock limit, so the test can see the tree's wait put it back.
    db = new Database({
      config: { ...testDatabaseConfig(), lockTimeoutMs: 5_000 },
      logger: silentLogger,
      databaseOverride: scratch.name,
    });
    h = await buildHarness(db, { treeLockWaitMs: WAIT_MS });
    holder = new Client({ ...testDatabaseConfig(), database: scratch.name });
    await holder.connect();
  });

  after(async () => {
    await holder.end();
    await db.close();
    await scratch.drop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM object WHERE parent_id IS NOT NULL');
    const probe = await h.service.create(testActor, {
      kind: 'probe',
      parentId: h.rootId,
      name: `probe-${String(process.hrtime.bigint())}`,
    });
    probeId = probe.id;
    groupId = (await h.service.create(testActor, { kind: 'group', parentId: probe.id, name: 'g' }))
      .id;
  });

  const device = async (name: string): Promise<number> =>
    (
      await h.service.create(testActor, {
        kind: 'device',
        parentId: groupId,
        name,
        host: '192.0.2.1',
      })
    ).id;

  it('gives up after the wait as OBJECT_TREE_BUSY, and creates nothing', async () => {
    await holdTree();
    try {
      const started = process.hrtime.bigint();
      const refused = await within(
        BOUND_MS,
        'the create to give up on the tree',
        h.service
          .create(testActor, { kind: 'device', parentId: groupId, name: 'late', host: '192.0.2.9' })
          .catch((error: unknown) => error),
      );
      const waitedMs = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(refused instanceof ObjectError);
      assert.equal(refused.code, 'OBJECT_TREE_BUSY');
      assert.equal(refused.status, 503);
      assert.ok(
        waitedMs >= WAIT_MS - 20 && waitedMs < WAIT_MS * 5,
        `waited ${waitedMs.toFixed(0)} ms`,
      );
    } finally {
      await releaseTree();
    }
    const rows = await db.query(`SELECT 1 FROM object WHERE name = 'late'`);
    assert.equal(rows.length, 0);
  });

  it('succeeds when the tree is let go inside the wait', async () => {
    await holdTree();
    const letGo = sleep(WAIT_MS / 3).then(releaseTree);
    const id = await device('patient');
    await letGo;
    assert.ok(id > 0);
  });

  it('puts the lock limit back to what it was, the pool’s or a transaction’s own', async () => {
    const around = (limits?: { lockTimeoutMs: number }): Promise<[string, string]> =>
      db.tx(async (q) => {
        const read = async (): Promise<string> =>
          (await q.query<{ v: string }>(`SELECT current_setting('lock_timeout') AS v`))[0]?.v ?? '';
        const before = await read();
        await h.repository.lockTreeShared(q);
        return [before, await read()];
      }, limits);
    assert.deepEqual(await around(), ['5s', '5s']);
    assert.deepEqual(await around({ lockTimeoutMs: 2_000 }), ['2s', '2s']);
  });

  it('stops a bulk selection at the first object that gave up, and names the rest as not tried', async () => {
    const ids = [await device('a'), await device('b'), await device('c')];
    const target = (
      await h.service.create(testActor, { kind: 'group', parentId: probeId, name: 't' })
    ).id;
    const bulk = new BulkService({ objects: h.service, logger: silentLogger });
    await holdTree();
    let report: Awaited<ReturnType<BulkService['apply']>>;
    const started = process.hrtime.bigint();
    try {
      report = await within(
        BOUND_MS,
        'the bulk move to give up on the tree',
        bulk.apply(testActor, ids, { kind: 'move', targetParentId: target }, Visibility.EVERYTHING),
      );
    } finally {
      await releaseTree();
    }
    const tookMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(report.succeeded, 0);
    assert.deepEqual(
      report.outcomes.map((one) => one.code),
      ['OBJECT_TREE_BUSY', 'OBJECT_TREE_BUSY', 'OBJECT_TREE_BUSY'],
    );
    assert.match(report.outcomes[1]?.problem ?? '', /^not attempted/);
    assert.match(report.outcomes[2]?.problem ?? '', /^not attempted/);
    // One wait, not three.
    assert.ok(tookMs < WAIT_MS * 2, `the selection took ${tookMs.toFixed(0)} ms`);
  });

  /** A provisioning run over 10.0.0.1–4, started with the tree held and let go after. */
  async function provisionHeld(
    templates: DeviceTemplateCatalogue,
    existingDevices: ExistingDevice[],
  ): Promise<{ report: ProvisionReport; tookMs: number; recorded: string[] }> {
    const discovery = new DiscoveryService({
      db,
      audit: new DatabaseAuditSink(),
      logger: silentLogger,
      dispatch: () => ({ kind: 'sent' }),
    });
    const run = await discovery.start({ groupId, probeId, range: '10.0.0.0/29' }, testActor);
    const recorded: string[] = [];
    const provisioner = new ProvisionService({
      objects: h.service,
      templates,
      logger: silentLogger,
      credentialsFor: () => Promise.resolve(new Set<string>()),
      recordDevice: (_run, address) => {
        recorded.push(address);
        return Promise.resolve();
      },
    });
    const hosts = HOSTS.map((address) => ({ address, rttMs: 1, fingerprint: null }));
    await holdTree();
    const started = process.hrtime.bigint();
    try {
      // Resolves: the pump that called it carries on.
      const report = await within(
        BOUND_MS,
        'the provisioning run to stop',
        provisioner.provision({
          run,
          hosts,
          existingDevices,
          existingSensors: [],
          actor: testActor,
          credentials: { kind: 'installation' },
        }),
      );
      return { report, tookMs: Number(process.hrtime.bigint() - started) / 1e6, recorded };
    } finally {
      await releaseTree();
    }
  }

  /** The first host is the one that waited; every one after it is named and not tried. */
  function assertStoppedAtFirst(report: ProvisionReport, tookMs: number): void {
    assert.deepEqual(
      report.problems.map((one) => one.address),
      HOSTS,
    );
    assert.match(report.problems[0]?.problem ?? '', /held it/);
    for (const later of report.problems.slice(1)) {
      assert.match(later.problem, /^not provisioned: the run stopped/);
    }
    // One wait, not one per host.
    assert.ok(tookMs < WAIT_MS * 2, `the run took ${tookMs.toFixed(0)} ms`);
  }

  it('stops a discovery’s provisioning, names every host not tried, and returns', async () => {
    const { report, tookMs } = await provisionHeld(
      new DeviceTemplateCatalogue(() => true).seal(),
      [],
    );
    assert.equal(report.devicesCreated, 0);
    assertStoppedAtFirst(report, tookMs);
  });

  it('stops there too when the busy tree is first met by a sensor, not a device', async () => {
    // Every host already a device, so the first change is a template's sensor — whose own catch
    // records a sensor that could not be created and goes on to the next, which is right for a
    // bad parameter and wrong for a tree that will be as busy for the next host as for this one.
    const existing: ExistingDevice[] = [];
    for (const address of HOSTS) {
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: groupId,
        name: address,
        host: address,
      });
      existing.push({ id: device.id, name: device.name, host: address });
    }
    const templates = new DeviceTemplateCatalogue(() => true);
    templates.register(
      {
        id: 'test.generic',
        name: 'Generic',
        description: '',
        match: {},
        sensors: [{ type: 'icmp.ping', name: 'Ping' }],
      },
      'test',
    );
    const { report, tookMs, recorded } = await provisionHeld(templates.seal(), existing);
    assert.equal(report.matched, 1, 'the first host was reached, and no other');
    assert.equal(report.sensorsCreated, 0);
    assert.deepEqual(recorded, [], 'no host recorded as provisioned');
    assertStoppedAtFirst(report, tookMs);
  });
});
