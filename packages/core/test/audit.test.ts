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
    inheritsTriggers: true,
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
      inheritsTriggers: true,
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
        config: { host: '127.0.0.1', port: 0, webRoot: '', allowedOrigins: [] },
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
            stateDays: 3_650,
          },
          compression: { rawAfterDays: 7, fiveMinuteAfterDays: 30 },
        },
      });
      const report = await housekeeper.runOnce();

      assert.equal(report.prunedAuditEntries, 20, 'days 21 through 40');
      const left = await db.query<{ count: string }>('SELECT count(*) AS count FROM audit_log');
      assert.equal(left[0]?.count, '20');
    });

    // ---------------------------------------------------------------------------------------
    // Ordering. Found by U-04's history tab, which showed yesterday's entries above today's.
    // ---------------------------------------------------------------------------------------

    describe('ordering and paging', () => {
      /** Entries at chosen ids, so the digit boundary is in the test rather than in the luck. */
      async function place(ids: readonly number[]): Promise<void> {
        await db.query(
          // OVERRIDING SYSTEM VALUE because `id` is GENERATED ALWAYS — which is right for the
          // column and is exactly why the ids a real installation ends up with are not something
          // a test can choose by accident.
          `INSERT INTO audit_log
             (id, at, action, object_id, object_kind, actor_kind, actor_ref, actor_label,
              summary, diff)
           OVERRIDING SYSTEM VALUE
           SELECT n, $2::timestamptz + make_interval(secs => n), 'object.updated', $1,
                  'probe', 'system', '', '', '{}'::jsonb, '[]'::jsonb
           FROM unnest($3::bigint[]) AS n`,
          [probeId, new Date('2026-01-01T00:00:00Z'), [...ids]],
        );
      }

      it('returns entries newest first, whatever the ids look like as text', async () => {
        // The defect this exists to catch: the select list casts `id` to text, and an unqualified
        // `ORDER BY id` binds to that output column — so entry 9 sorted above entry 253 and the
        // log read as though it had jumped back in time. The ids are placed rather than grown,
        // because with fewer than ten entries lexicographic and numeric order agree and the bug
        // hides.
        await place([3, 9, 25, 100, 253]);
        const listed = await entries(probeId);
        assert.deepEqual(
          listed.map((entry) => Number(entry.id)),
          [253, 100, 25, 9, 3],
        );
        const times = listed.map((entry) => Date.parse(entry.at));
        assert.deepEqual(
          times,
          [...times].sort((a, b) => b - a),
          'and newest first',
        );
      });

      it('filters by category, which is the action first segment and not a prefix match', async () => {
        // Twenty-six actions is too many to put in front of an operator; seven categories is a
        // row of chips. `split_part` rather than LIKE, so "object" never selects "objectgroup".
        await service.setSetting(testActor, probeId, 'scan.intervalSeconds', 120, { kind: 'none' });
        await service.update(
          testActor,
          probeId,
          { kind: 'probe', name: 'renamed' },
          { kind: 'none' },
        );

        const settings = await db.tx((q) =>
          repository.list(q, { limit: 100, categories: ['setting'] }),
        );
        assert.ok(settings.length > 0);
        assert.ok(settings.every((entry) => entry.action.startsWith('setting.')));

        const both = await db.tx((q) =>
          repository.list(q, { limit: 100, categories: ['setting', 'object'] }),
        );
        assert.ok(both.length > settings.length);
      });

      it('filters by who did it', async () => {
        await service.update(
          testActor,
          probeId,
          { kind: 'probe', name: 'renamed' },
          { kind: 'none' },
        );
        const mine = await db.tx((q) =>
          repository.list(q, { limit: 100, actorKinds: [testActor.kind] }),
        );
        assert.ok(mine.length > 0);
        const nobody = await db.tx((q) =>
          repository.list(q, { limit: 100, actorKinds: ['nonexistent-kind'] }),
        );
        assert.deepEqual(nobody, []);
      });

      it('filters to one actor, which is the question the log gets opened for', async () => {
        // `actorKinds` narrows to *all* users, which during an incident is everybody. "Everything
        // this person did" needs the ref, and `audit_log_actor_idx` is (actor_kind, actor_ref,
        // id DESC) for exactly this.
        const ada: Actor = { kind: 'user', userId: 4, login: 'ada' };
        const bob: Actor = { kind: 'user', userId: 5, login: 'bob' };
        await service.update(ada, probeId, { kind: 'probe', name: 'by-ada' }, { kind: 'none' });
        await service.update(bob, probeId, { kind: 'probe', name: 'by-bob' }, { kind: 'none' });

        const hers = await db.tx((q) =>
          repository.list(q, { limit: 100, actorKinds: ['user'], actorRef: '4' }),
        );
        assert.ok(hers.length > 0);
        assert.deepEqual(
          [...new Set(hers.map((entry) => JSON.stringify(entry.actor)))],
          [JSON.stringify(ada)],
          'nobody else came back',
        );

        const both = await db.tx((q) => repository.list(q, { limit: 100, actorKinds: ['user'] }));
        assert.ok(both.length > hers.length, 'and the kind filter alone is wider');
      });

      it('needs the kind too, because a ref is unique only within one', async () => {
        // User 4 and token 4 are different actors. A ref-only filter would report one person's
        // changes as another's, which in an audit log is worse than reporting none.
        const ada: Actor = { kind: 'user', userId: 4, login: 'ada' };
        const token: Actor = { kind: 'token', tokenId: 4 };
        await service.update(ada, probeId, { kind: 'probe', name: 'by-ada' }, { kind: 'none' });
        await service.update(token, probeId, { kind: 'probe', name: 'by-token' }, { kind: 'none' });

        const shared = await db.tx((q) => repository.list(q, { limit: 100, actorRef: '4' }));
        assert.equal(
          new Set(shared.map((entry) => entry.actor.kind)).size,
          2,
          'the ref alone spans both, which is why the UI always sends the kind with it',
        );

        const hers = await db.tx((q) =>
          repository.list(q, { limit: 100, actorKinds: ['user'], actorRef: '4' }),
        );
        assert.ok(hers.length > 0);
        assert.ok(hers.every((entry) => entry.actor.kind === 'user'));
      });

      it('treats an empty ref as no filter rather than as an actor named ""', async () => {
        // A cleared filter box sends `actorRef=`. Matching it literally would answer "nothing
        // happened", which reads as a fact about the installation rather than about the query.
        await service.update(testActor, probeId, { kind: 'probe', name: 'x' }, { kind: 'none' });
        const all = await db.tx((q) => repository.list(q, { limit: 100 }));
        const empty = await db.tx((q) => repository.list(q, { limit: 100, actorRef: '' }));
        assert.equal(empty.length, all.length);
      });

      it('filters by time, half-open so two adjacent windows never double-count', async () => {
        await place([500, 501, 502]);
        const at = (n: number): Date => new Date(Date.parse('2026-01-01T00:00:00Z') + n * 1_000);

        const first = await db.tx((q) =>
          repository.list(q, { limit: 100, objectId: probeId, from: at(500), to: at(501) }),
        );
        assert.deepEqual(
          first.map((entry) => Number(entry.id)),
          [500],
          'from is inclusive and to is exclusive',
        );

        const rest = await db.tx((q) =>
          repository.list(q, { limit: 100, objectId: probeId, from: at(501) }),
        );
        assert.deepEqual(
          rest.map((entry) => Number(entry.id)),
          [502, 501],
        );
      });

      it('scopes to one object exactly, never to its subtree', async () => {
        // A subtree scope has to walk `object` to find descendants, and the entry most worth
        // reading is the one recording a deletion — written about an object with no parent left
        // to be found through. Scoping that way would drop precisely those.
        const child = await service.create(testActor, {
          kind: 'group',
          parentId: probeId,
          name: 'below',
        });
        const forProbe = await db.tx((q) => repository.list(q, { limit: 100, objectId: probeId }));
        assert.ok(
          forProbe.every((entry) => entry.objectId === probeId),
          'the child creation is not in the parent history',
        );
        const forChild = await db.tx((q) => repository.list(q, { limit: 100, objectId: child.id }));
        assert.ok(forChild.some((entry) => entry.action === 'object.created'));
      });

      it('serves the global list over HTTP, filtered and paged', async () => {
        await place([600, 601, 602, 603]);
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/audit',
          query: { objectId: String(probeId), limit: '2' },
        });
        assert.equal(response.statusCode, 200);
        const body = response.json<{ items: { id: string }[]; nextBefore: string | null }>();
        assert.deepEqual(
          body.items.map((entry) => Number(entry.id)),
          [603, 602],
        );
        assert.equal(body.nextBefore, '602');

        const next = await app.inject({
          method: 'GET',
          url: '/api/v1/audit',
          query: { objectId: String(probeId), limit: '2', before: '602' },
        });
        assert.deepEqual(
          next.json<{ items: { id: string }[] }>().items.map((entry) => Number(entry.id)),
          [601, 600],
        );
      });

      it('filters over HTTP to one actor, and says who each entry was', async () => {
        // The route's half of the same question, and the reason the wire shape matters: the UI
        // has to be able to build this link out of an entry it was given, so the entry has to
        // carry the ref. It does — as `userId` on the actor union — and a response schema that
        // dropped it would break the link silently, because `additionalProperties: false` strips
        // rather than refuses.
        const ada: Actor = { kind: 'user', userId: 4, login: 'ada' };
        // A second *user*, not merely a second actor. With only one user in the log, dropping
        // the ref and keeping the kind returns exactly the same rows, and the test passes on a
        // route that ignores the ref altogether — which is the mutant that found this.
        const bob: Actor = { kind: 'user', userId: 5, login: 'bob' };
        await service.update(ada, probeId, { kind: 'probe', name: 'by-ada' }, { kind: 'none' });
        await service.update(bob, probeId, { kind: 'probe', name: 'by-bob' }, { kind: 'none' });
        await service.update(
          testActor,
          probeId,
          { kind: 'probe', name: 'by-system' },
          {
            kind: 'none',
          },
        );

        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/audit',
          query: { actorKind: 'user', actorRef: '4' },
        });
        assert.equal(response.statusCode, 200);
        const body = response.json<{ items: { actor: Actor }[] }>();
        assert.ok(body.items.length > 0);
        for (const entry of body.items) assert.deepEqual(entry.actor, ada);
      });

      it('refuses an actorRef longer than any ref can be', async () => {
        // Bounded at the boundary rather than at the query: `actor_ref` is text, and an
        // unbounded filter value is a free megabyte in a WHERE clause.
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/audit',
          query: { actorRef: 'x'.repeat(65) },
        });
        assert.equal(response.statusCode, 400);
      });

      it('refuses a category that is not one', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/audit',
          query: { category: 'bogus' },
        });
        assert.equal(response.statusCode, 400);
      });

      it('pages without skipping or repeating an entry', async () => {
        // The cursor compares numerically (`id < $n`) while the sort was lexicographic, so the
        // two disagreed at a page boundary: entries were dropped and others came back twice.
        // Placed ids again, spanning three digit widths, so the disagreement is guaranteed.
        await place([3, 9, 25, 100, 253, 1_000, 1_001]);
        const seen: number[] = [];
        let before: string | undefined;
        for (let page = 0; page < 6; page += 1) {
          const batch = await db.tx((q) =>
            repository.list(q, {
              objectId: probeId,
              limit: 3,
              ...(before === undefined ? {} : { before }),
            }),
          );
          if (batch.length === 0) break;
          seen.push(...batch.map((entry) => Number(entry.id)));
          before = batch[batch.length - 1]?.id;
        }

        assert.deepEqual(seen, [1_001, 1_000, 253, 100, 25, 9, 3]);
        assert.equal(new Set(seen).size, seen.length, 'and nothing twice');
      });
    });
  },
);
