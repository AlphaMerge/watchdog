import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import {
  AuditRepository,
  CompositeAuditSink,
  DatabaseAuditSink,
  type AuditEntry,
} from '../src/audit/store.js';
import { changedParamKeys, describeCreated, diffObjects } from '../src/audit/diff.js';
import type { Database } from '../src/db/pool.js';
import { LoggingAuditSink, type Actor } from '../src/objects/audit.js';
import { ObjectRepository } from '../src/objects/repository.js';
import { ObjectService } from '../src/objects/service.js';
import type { ObjectDetail } from '../src/objects/types.js';
import { InheritanceResolver } from '../src/settings/inheritance.js';
import { HistoryService } from '../src/timeseries/history.js';
import { Housekeeper } from '../src/timeseries/housekeeper.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue, testSensorTypes } from './support/sensor-types.js';
import { buildHarness, silent, testActor } from './support/tree.js';

const available = await databaseAvailable();

const SECRET = 'community-string-nobody-should-persist';

function device(overrides: Partial<Extract<ObjectDetail, { kind: 'device' }>> = {}) {
  return {
    id: 10,
    kind: 'device' as const,
    parentId: 2,
    name: 'db-01',
    tags: ['prod', 'linux'],
    priority: 3 as const,
    comments: '',
    host: '10.0.0.1',
    ipVersion: 'v4' as const,
    version: 4,
    childCount: 2,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

/** Pure: the diff is a function of two objects, and it decides what an operator ever sees. */
describe('audit diff', () => {
  it('reports what someone changed and nothing else', () => {
    const changes = diffObjects(
      device(),
      device({ name: 'db-02', version: 5, childCount: 3, updatedAt: '2026-08-03T00:00:00.000Z' }),
    );

    // Bookkeeping that moves on every edit is excluded on purpose: a diff that always says
    // "version 4 -> 5" teaches people to stop reading diffs.
    assert.deepEqual(changes, [{ field: 'name', before: 'db-01', after: 'db-02' }]);
  });

  it('treats a tag list as one field', () => {
    const changes = diffObjects(device(), device({ tags: ['prod'] }));
    assert.deepEqual(changes, [{ field: 'tags', before: ['prod', 'linux'], after: ['prod'] }]);
  });

  it('says nothing about a reparent, which is a move', () => {
    // Recording it here as well would double every move in the history tab.
    assert.deepEqual(diffObjects(device(), device({ parentId: 99 })), []);
  });

  it('describes a created object as a diff from nothing', () => {
    const created = describeCreated(device());
    assert.deepEqual(
      created.find((change) => change.field === 'host'),
      { field: 'host', before: null, after: '10.0.0.1' },
    );
    assert.ok(created.every((change) => change.before === null));
  });

  it('lists changed sensor parameters by key and never by value', () => {
    const sensor = (params: Record<string, unknown>): ObjectDetail => ({
      id: 20,
      kind: 'sensor',
      parentId: 10,
      name: 's',
      tags: [],
      priority: 3,
      comments: '',
      sensorType: 'snmp.traffic',
      params,
      redactedParams: [],
      version: 1,
      childCount: 0,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });

    const keys = changedParamKeys(
      sensor({ community: 'old', timeout: 5_000 }),
      sensor({ community: SECRET, port: 161 }),
    );
    assert.deepEqual(keys, ['community', 'port', 'timeout'], 'sorted, and keys only');
    assert.ok(!JSON.stringify(keys).includes(SECRET));
  });
});

describe(
  'audit log',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let app: FastifyInstance;
    let service: ObjectService;
    let repository: AuditRepository;
    let rootId: number;
    let probeId: number;

    before(async () => {
      scratch = await createScratchDatabase('audit');
      db = scratch.db;
      const harness = await buildHarness(db);
      rootId = harness.rootId;
      repository = new AuditRepository();

      // The real wiring: the database sink alongside the log one, both inside the mutation's
      // transaction, exactly as main.ts assembles them.
      service = new ObjectService({
        db,
        repository: new ObjectRepository(),
        resolver: new InheritanceResolver({ db, logger: silent }),
        audit: new CompositeAuditSink([new DatabaseAuditSink(), new LoggingAuditSink(silent)]),
        sensorTypes: testSensorTypes(),
        logger: silent,
      });

      const server = new ApiServer({
        config: { host: '127.0.0.1', port: 0, webRoot: '' },
        logger: silent,
        version: '9.9.9',
        service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: repository,
        catalogue: testCatalogue(),
      });
      await server.build('9.9.9', service);
      app = server.app;
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM audit_log');
      const probe = await service.create(testActor, {
        kind: 'probe',
        parentId: rootId,
        name: `probe-${String(Date.now())}-${String(Math.round(performance.now() * 1000))}`,
      });
      probeId = probe.id;
      await db.query('DELETE FROM audit_log');
    });

    async function entries(objectId?: number): Promise<AuditEntry[]> {
      return db.tx((q) =>
        repository.list(q, { limit: 100, ...(objectId === undefined ? {} : { objectId }) }),
      );
    }

    // ---------------------------------------------------------------------------------------
    // The property the whole thing rests on.
    // ---------------------------------------------------------------------------------------

    it('leaves no entry behind when the change it recorded rolled back', async () => {
      const sink = new DatabaseAuditSink();
      await assert.rejects(() =>
        db.tx(async (q) => {
          await sink.record(
            q,
            testActor,
            [
              {
                action: 'object.created',
                objectId: 999,
                kind: 'device',
                after: device() as ObjectDetail,
              },
            ],
            new Date(),
          );
          throw new Error('the mutation failed after the audit was written');
        }),
      );

      // An audit entry for a change that never happened is worse than no audit log at all.
      assert.deepEqual(await entries(999), []);
    });

    // ---------------------------------------------------------------------------------------
    // What each mutation records.
    // ---------------------------------------------------------------------------------------

    it('records a create with the state it was created in', async () => {
      const created = await service.create(testActor, {
        kind: 'device',
        parentId: probeId,
        name: 'audited-device',
        host: '192.0.2.60',
        tags: ['prod'],
      });

      const [entry] = await entries(created.id);
      assert.ok(entry);
      assert.equal(entry.action, 'object.created');
      assert.equal(entry.objectKind, 'device');
      assert.deepEqual(entry.actor, testActor);
      assert.deepEqual(
        entry.diff.find((change) => change.field === 'host'),
        { field: 'host', before: null, after: '192.0.2.60' },
      );
    });

    it('records an update as only what changed', async () => {
      const created = await service.create(testActor, {
        kind: 'device',
        parentId: probeId,
        name: 'before-rename',
        host: '192.0.2.61',
      });
      await db.query('DELETE FROM audit_log');

      await service.update(
        testActor,
        created.id,
        { kind: 'device', name: 'after-rename' },
        { kind: 'none' },
      );

      const [entry] = await entries(created.id);
      assert.ok(entry);
      assert.equal(entry.action, 'object.updated');
      assert.deepEqual(entry.diff, [
        { field: 'name', before: 'before-rename', after: 'after-rename' },
      ]);
    });

    it('records a move as a change of parent', async () => {
      const target = await service.create(testActor, {
        kind: 'group',
        parentId: probeId,
        name: 'target-group',
      });
      const moved = await service.create(testActor, {
        kind: 'device',
        parentId: probeId,
        name: 'moving-device',
        host: '192.0.2.62',
      });
      await db.query('DELETE FROM audit_log');

      await service.move(testActor, moved.id, target.id, { kind: 'none' });

      const [entry] = await entries(moved.id);
      assert.ok(entry);
      assert.equal(entry.action, 'object.moved');
      assert.deepEqual(entry.diff, [{ field: 'parentId', before: probeId, after: target.id }]);
      assert.equal(entry.summary['movedCount'], 1);
    });

    it('records a reorder as the positions it moved between', async () => {
      const first = await service.create(testActor, {
        kind: 'group',
        parentId: probeId,
        name: 'aaa-first',
      });
      await service.create(testActor, { kind: 'group', parentId: probeId, name: 'bbb-second' });
      await db.query('DELETE FROM audit_log');

      await service.reorder(testActor, first.id, 'last', { kind: 'none' });

      const [entry] = await entries(first.id);
      assert.ok(entry);
      assert.equal(entry.action, 'object.reordered');
      assert.equal(entry.summary['move'], 'last');
      assert.equal(entry.summary['parentId'], probeId);
      assert.deepEqual(entry.diff, [{ field: 'siblingPosition', before: 0, after: 1 }]);
    });

    it('keeps the record of a deletion after its subject is gone', async () => {
      const group = await service.create(testActor, {
        kind: 'group',
        parentId: probeId,
        name: 'doomed-group',
      });
      const child = await service.create(testActor, {
        kind: 'device',
        parentId: group.id,
        name: 'doomed-device',
        host: '192.0.2.63',
      });
      await db.query('DELETE FROM audit_log');

      await service.delete(
        testActor,
        group.id,
        { kind: 'exact', descendants: 1 },
        { kind: 'none' },
      );

      // No foreign key to object, on purpose: the most important entry an audit log holds is the
      // one recording a deletion, and a foreign key would take it away with its subject.
      const [entry] = await entries(group.id);
      assert.ok(entry);
      assert.equal(entry.action, 'object.deleted');
      assert.deepEqual(
        entry.diff.find((change) => change.field === 'name'),
        { field: 'name', before: 'doomed-group', after: null },
      );
      assert.equal(entry.summary['destroyedCount'], 2);
      assert.equal(entry.summary['destroyedTruncated'], false);
      const destroyed = entry.summary['destroyed'] as { id: number }[];
      assert.ok(destroyed.some((ref) => ref.id === child.id));
    });

    it('records a setting being set and reverted', async () => {
      await service.setSetting(testActor, probeId, 'scan.intervalSeconds', 120, { kind: 'none' });
      await service.clearSetting(testActor, probeId, 'scan.intervalSeconds', { kind: 'none' });

      const history = await entries(probeId);
      assert.deepEqual(
        history.map((entry) => entry.action),
        ['setting.reverted', 'setting.set'],
        'newest first',
      );
      assert.deepEqual(history[1]?.diff, [
        { field: 'setting.scan.intervalSeconds', before: null, after: 120 },
      ]);
      assert.equal(history[0]?.diff[0]?.after, null, 'reverting means inherit again');
    });

    // ---------------------------------------------------------------------------------------
    // What must never reach the table.
    // ---------------------------------------------------------------------------------------

    it('never writes a sensor parameter value, only its name', async () => {
      const host = await service.create(testActor, {
        kind: 'device',
        parentId: probeId,
        name: 'snmp-device',
        host: '192.0.2.65',
      });
      const sensor = await service.create(testActor, {
        kind: 'sensor',
        parentId: host.id,
        name: 'snmp-sensor',
        sensorType: 'snmp.traffic',
        params: { community: SECRET, timeout: 5_000 },
      });
      await service.update(
        testActor,
        sensor.id,
        { kind: 'sensor', params: { community: `${SECRET}-rotated`, timeout: 5_000 } },
        { kind: 'none' },
      );

      // A parameter can hold a credential until P-05 lands writeOnly redaction. The API already
      // returns them verbatim, which is bad enough; a long-lived table with its own retention
      // would make a present-tense exposure permanent, and redacting later cannot unwrite
      // history. So the canary is the whole table, not one column.
      const raw = await db.query<{ everything: string }>(
        'SELECT (summary::text || diff::text) AS everything FROM audit_log',
      );
      for (const row of raw) {
        assert.ok(!row.everything.includes(SECRET), `a parameter value reached the audit log`);
      }

      const history = await entries(sensor.id);
      assert.deepEqual(history[0]?.summary['paramsChanged'], ['community']);
      assert.deepEqual(history[1]?.summary['paramsChanged'], ['community', 'timeout']);
    });

    it('round-trips every kind of actor through the flat columns', async () => {
      const actors: Actor[] = [
        { kind: 'user', userId: 42, login: 'alice' },
        { kind: 'token', tokenId: 7 },
        { kind: 'system', component: 'discovery' },
        { kind: 'anonymous', remoteAddress: '203.0.113.5' },
      ];
      const sink = new DatabaseAuditSink();
      for (const actor of actors) {
        await db.tx((q) =>
          sink.record(
            q,
            actor,
            [{ action: 'setting.set', objectId: probeId, key: 'k', before: null, after: 1 }],
            new Date(),
          ),
        );
      }

      const history = await entries(probeId);
      assert.deepEqual(
        [...history].reverse().map((entry) => entry.actor),
        actors,
      );
    });

    // ---------------------------------------------------------------------------------------
    // Reading it back.
    // ---------------------------------------------------------------------------------------

    it('pages an object history newest first', async () => {
      for (let index = 0; index < 5; index += 1) {
        await service.update(
          testActor,
          probeId,
          { kind: 'probe', name: `probe-rename-${String(index)}` },
          { kind: 'none' },
        );
      }

      const first = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(probeId)}/audit`,
        query: { limit: '2' },
      });
      assert.equal(first.statusCode, 200);
      const page1 = first.json<{ items: AuditEntry[]; nextBefore: string | null }>();
      assert.equal(page1.items.length, 2);
      assert.ok(page1.nextBefore);
      assert.ok(
        Number(page1.items[0]?.id) > Number(page1.items[1]?.id),
        'newest first, by an id that orders two changes in the same millisecond',
      );

      const second = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(probeId)}/audit`,
        query: { limit: '2', before: page1.nextBefore },
      });
      const page2 = second.json<{ items: AuditEntry[]; nextBefore: string | null }>();
      assert.equal(page2.items.length, 2);
      assert.ok(
        Number(page2.items[0]?.id) < Number(page1.items[1]?.id),
        'and the pages do not overlap',
      );
    });

    it('still serves the history of an object that has been deleted', async () => {
      const doomed = await service.create(testActor, {
        kind: 'device',
        parentId: probeId,
        name: 'gone-but-audited',
        host: '192.0.2.64',
      });
      await service.delete(
        testActor,
        doomed.id,
        { kind: 'exact', descendants: 0 },
        { kind: 'none' },
      );

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(doomed.id)}/audit`,
      });

      // Not a 404. Refusing history for something deleted would hide exactly the change someone
      // came looking for.
      assert.equal(response.statusCode, 200);
      const body = response.json<{ items: AuditEntry[] }>();
      assert.deepEqual(
        body.items.map((entry) => entry.action),
        ['object.deleted', 'object.created'],
      );
    });

    // ---------------------------------------------------------------------------------------
    // Retention.
    // ---------------------------------------------------------------------------------------

    it('prunes entries past their horizon and leaves the rest', async () => {
      await db.query(
        // Half a day off the boundary in both directions, so the horizon cannot land on a row:
        // an entry written at exactly now() - 20 days races the horizon computed a moment later.
        `INSERT INTO audit_log (at, action, object_id, actor_kind, actor_ref)
         SELECT now() - make_interval(days => d) + interval '12 hours',
                'object.updated', $1, 'system', 'test'
         FROM generate_series(1, 40) d`,
        [probeId],
      );

      const housekeeper = new Housekeeper({
        db,
        logger: silent,
        config: {
          enabled: false,
          intervalSeconds: 300,
          rollupLagSeconds: 0,
          retention: {
            rawDays: 40,
            fiveMinuteDays: 365,
            hourlyDays: 730,
            dailyDays: 3_650,
            auditDays: 20,
          },
          compression: { rawAfterDays: 7, fiveMinuteAfterDays: 30 },
        },
      });
      const report = await housekeeper.runOnce();

      assert.equal(report.prunedAuditEntries, 20, 'days 21 through 40');
      const left = await db.query<{ count: string }>('SELECT count(*) AS count FROM audit_log');
      assert.equal(left[0]?.count, '20');
    });
  },
);
