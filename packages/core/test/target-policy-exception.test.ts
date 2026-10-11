import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { parseCoreToProbe, PROTOCOL_VERSION, type SensorAssignment } from '@ms/shared';
import { ApiServer } from '../src/api/server.js';
import { AccessService } from '../src/auth/access.js';
import { Visibility } from '../src/auth/access.js';
import { AccountService, type AccountRole } from '../src/auth/accounts.js';
import { GroupService } from '../src/auth/groups.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { SessionService } from '../src/auth/sessions.js';
import { TokenService } from '../src/auth/tokens.js';
import { TotpService } from '../src/auth/totp.js';
import { AuditRepository, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { ProbeConfigService } from '../src/probes/config.js';
import { InheritanceResolver } from '../src/settings/inheritance.js';
import { settingRegistry } from '../src/settings/registry.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { actorNamed, buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { sessionsWait } from './support/waits-for-lock.js';
import { within } from './support/within.js';

/**
 * One device's exception to its probe's target policy, on the core (`A-64`).
 *
 * **Who may change it is the point.** The policy exists because whoever may write a device could
 * otherwise point a probe at the cloud's metadata service, so an exception that account could
 * write would be the policy turned off by the person it is there for. Each case here is a way of
 * trying to get one without being an administrator with a `full` token: the route, a device edit,
 * a setting on a group, a clone. Then what it does once set: it is audited, it reaches a probe
 * that understands it and no other, and it is never inherited.
 */

const available = await databaseAvailable();
const PASSWORD = 'correct-horse-battery';

interface DeviceBody {
  id: number;
  kind: string;
  version: number;
  targetPolicyException?: string[];
}

describe(
  'a device’s exception to the target policy',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let app: FastifyInstance;
    let accounts: AccountService;
    let groups: GroupService;
    let access: AccessService;
    let tokens: TokenService;
    let config: ProbeConfigService;
    let teamId = 0;
    let probeId = 0;
    let groupId = 0;
    let deviceId = 0;
    let siblingId = 0;
    let sensorId = 0;
    const cookies = new Map<AccountRole, string>();
    const userIds = new Map<AccountRole, number>();

    before(async () => {
      scratch = await createScratchDatabase('targetexception');
      db = scratch.db;
      h = await buildHarness(db);
      // The real audit log beside the capture, so an entry is a row somebody can read.
      h.audit.also = new DatabaseAuditSink();
      accounts = new AccountService({ audit: new DatabaseAuditSink(), db, logger: silent });
      groups = new GroupService({ audit: new DatabaseAuditSink(), db, logger: silent });
      access = new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent });
      tokens = new TokenService({ audit: new DatabaseAuditSink(), db, logger: silent });
      config = new ProbeConfigService({
        db,
        resolver: new InheritanceResolver({ db, logger: silent }),
      });

      const server = new ApiServer({
        config: {
          host: '127.0.0.1',
          port: 0,
          webRoot: '',
          allowedOrigins: [],
          requireAuthentication: true,
        },
        logger: silent,
        version: '9.9.9',
        service: h.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
        auth: {
          accounts,
          sessions: new SessionService({ db, logger: silent }),
          throttle: new LoginThrottle({ db, logger: silent, sleep: () => Promise.resolve() }),
          groups,
          access,
          tokens,
          totp: new TotpService({ audit: new DatabaseAuditSink(), db, logger: silent }),
          required: true,
        },
      });
      await server.build('9.9.9', h.service);
      app = server.app;

      teamId = (await groups.create({ name: 'Team' }, testActor)).id;
      for (const role of ['admin', 'readwrite', 'readonly'] as const) {
        const account = await accounts.create({ login: role, password: PASSWORD, role }, testActor);
        userIds.set(role, account.id);
        if (role === 'admin') {
          const admins = (await groups.list()).find((group) => group.isAdmin);
          assert.ok(admins);
          await groups.addMember(admins.id, account.id, testActor);
        } else {
          await groups.addMember(teamId, account.id, testActor);
        }
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { login: role, password: PASSWORD },
        });
        assert.equal(response.statusCode, 200, `${role} could not log in`);
        const setCookie = response.headers['set-cookie'];
        const header = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '');
        cookies.set(role, header.split(';')[0] ?? '');
      }
    });

    after(async () => {
      await app.close();
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM object_access');
      await db.query("DELETE FROM object WHERE kind <> 'root'");
      h.audit.recorded.length = 0;
      probeId = (
        await h.service.create(testActor, {
          kind: 'probe',
          parentId: h.rootId,
          name: 'Local probe',
          gid: `gid-${String(process.hrtime.bigint())}`,
        })
      ).id;
      groupId = (
        await h.service.create(testActor, { kind: 'group', parentId: probeId, name: 'Rack A' })
      ).id;
      deviceId = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: groupId,
          name: 'bmc',
          host: '169.254.10.5',
        })
      ).id;
      siblingId = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: groupId,
          name: 'switch',
          host: '169.254.10.6',
        })
      ).id;
      sensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'Port',
          sensorType: 'icmp.ping',
          params: {},
        })
      ).id;
      await h.service.create(testActor, {
        kind: 'sensor',
        parentId: siblingId,
        name: 'Port',
        sensorType: 'icmp.ping',
        params: {},
      });
      // The read-write account may do anything to the device but this: `full` on its group.
      await access.grant(groupId, teamId, 'full', actorNamed('test'));
    });

    const as = (role: AccountRole) => ({ cookie: cookies.get(role) ?? '' });
    const url = (id: number): string => `/api/v1/objects/${String(id)}/target-policy-exception`;
    const put = (id: number, addresses: unknown, headers: Record<string, string> = as('admin')) =>
      app.inject({
        method: 'PUT',
        url: url(id),
        headers,
        payload: { addresses } as Record<string, unknown>,
      });
    const read = async (id: number, role: AccountRole = 'admin'): Promise<DeviceBody> => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/objects/${String(id)}`,
        headers: as(role),
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<DeviceBody>();
    };
    const stored = async (id: number): Promise<string[]> =>
      (
        await db.query<{ list: string[] }>(
          'SELECT target_policy_exception AS list FROM device_config WHERE object_id = $1',
          [id],
        )
      )[0]?.list ?? assert.fail('no device_config row');
    /**
     * Another administrator's transaction: it locks the device, stores `addresses` as its
     * exception, and commits once released. `holds` settles once the lock is held, and `done`
     * once it has committed; a transaction that fails before it holds rejects both.
     */
    const holding = (
      addresses: readonly string[],
    ): { holds: Promise<void>; done: Promise<void>; release: () => void } => {
      let held = (): void => undefined;
      let release = (): void => undefined;
      const holds = new Promise<void>((resolve) => {
        held = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const done = db.tx(async (q) => {
        await q.query('SELECT 1 FROM object WHERE id = $1 FOR UPDATE', [deviceId]);
        await q.query(
          'UPDATE device_config SET target_policy_exception = $2::text[] WHERE object_id = $1',
          [deviceId, addresses],
        );
        held();
        await released;
      });
      return { holds: Promise.race([holds, done]), done, release };
    };

    const auditRows = async (id: number) =>
      db.query<{
        action: string;
        actor_label: string;
        diff: { field: string; before: unknown; after: unknown }[];
      }>(
        `SELECT action, actor_label, diff FROM audit_log
         WHERE object_id = $1 AND action = 'object.updated' ORDER BY id`,
        [id],
      );

    describe('who may set it', () => {
      it('an administrator sets it, and whoever may read the device sees it', async () => {
        const response = await put(deviceId, ['169.254.10.5', ' fe80::5 ', '169.254.10.5']);
        assert.equal(response.statusCode, 200, response.body);
        // Trimmed, and each address once.
        assert.deepEqual(response.json<DeviceBody>().targetPolicyException, [
          '169.254.10.5',
          'fe80::5',
        ]);
        assert.ok(response.headers['etag'] !== undefined);
        assert.deepEqual(await stored(deviceId), ['169.254.10.5', 'fe80::5']);
        for (const role of ['admin', 'readwrite', 'readonly'] as const) {
          assert.deepEqual(
            (await read(deviceId, role)).targetPolicyException,
            ['169.254.10.5', 'fe80::5'],
            role,
          );
        }
        // A device without one reads as it always did: no field at all.
        assert.equal('targetPolicyException' in (await read(siblingId)), false);
      });

      it('an account that may do anything else to the device is refused, and nothing changes', async () => {
        const before = await read(deviceId);
        for (const role of ['readwrite', 'readonly'] as const) {
          const response = await put(deviceId, ['169.254.10.5'], as(role));
          assert.equal(response.statusCode, 403, `${role}: ${response.body}`);
        }
        // Nor through an edit of the device, which is the route it may use.
        const patched = await app.inject({
          method: 'PATCH',
          url: `/api/v1/objects/${String(deviceId)}`,
          headers: { ...as('readwrite'), 'if-match': `W/"${String(before.version)}"` },
          payload: { kind: 'device', targetPolicyException: ['169.254.10.5'] },
        });
        assert.equal(patched.statusCode, 400, patched.body);
        // Nor as a setting, on the device or on the group above it.
        for (const id of [deviceId, groupId]) {
          const setting = await app.inject({
            method: 'PUT',
            url: `/api/v1/objects/${String(id)}/settings/targetPolicyException`,
            headers: as('readwrite'),
            payload: { value: ['169.254.10.5'] },
          });
          assert.equal(setting.statusCode, 400, setting.body);
        }
        assert.deepEqual(await stored(deviceId), []);
        assert.equal((await read(deviceId)).version, before.version);
        assert.deepEqual(await auditRows(deviceId), []);
      });

      it('an administrator’s token must be `full`, as for a grant', async () => {
        const admin = userIds.get('admin') ?? assert.fail('no admin');
        const write = await tokens.issue(
          { userId: admin, role: 'admin' },
          { name: 'writer', scope: 'write' },
          testActor,
        );
        const refused = await put(deviceId, ['169.254.10.5'], {
          authorization: `Bearer ${write.secret}`,
        });
        assert.equal(refused.statusCode, 403, refused.body);
        const full = await tokens.issue(
          { userId: admin, role: 'admin' },
          { name: 'granter', scope: 'full' },
          testActor,
        );
        const allowed = await put(deviceId, ['169.254.10.5'], {
          authorization: `Bearer ${full.secret}`,
        });
        assert.equal(allowed.statusCode, 200, allowed.body);
      });
    });

    describe('what it may hold, and where', () => {
      it('addresses only, never a metadata service, and a short list', async () => {
        const refused: unknown[] = [
          ['device.example'],
          ['169.254.10.0/24'],
          ['fe80::5%eth0'],
          ['169.254.169.254'],
          ['::ffff:a9fe:a9fe'],
          ['fd00:ec2::254'],
          ['169.254.170.2'],
          ['224.0.0.1'],
          ['0.0.0.0'],
          ['169.254.10.5', 'not-an-address'],
          Array.from({ length: 17 }, (_, at) => `169.254.10.${String(at + 1)}`),
          '169.254.10.5',
        ];
        for (const addresses of refused) {
          const response = await put(deviceId, addresses);
          assert.equal(response.statusCode, 400, `${JSON.stringify(addresses)}: ${response.body}`);
        }
        const metadata = await put(deviceId, ['169.254.169.254']);
        assert.match(
          metadata.json<{ error: { message: string } }>().error.message,
          /instance-metadata service/,
        );
        assert.deepEqual(await stored(deviceId), []);
      });

      it('a device only: a group, a probe and the root cannot carry one', async () => {
        for (const id of [groupId, probeId, h.rootId, sensorId]) {
          const response = await put(id, ['169.254.10.5']);
          assert.equal(response.statusCode, 409, `${String(id)}: ${response.body}`);
          assert.match(
            response.json<{ error: { message: string } }>().error.message,
            /only a device/,
          );
        }
        assert.equal((await put(999_999_999, ['169.254.10.5'])).statusCode, 404);
      });

      it('is not a setting, so nothing inherits it', async () => {
        await put(deviceId, ['169.254.10.5']);
        assert.equal(settingRegistry.has('targetPolicyException'), false);
        // The device's sensor resolves no such thing, and neither does the sibling device.
        const keys = (await h.service.settings(sensorId)).map((setting) => setting.key);
        assert.equal(
          keys.some((key) => /policy/i.test(key)),
          false,
        );
        assert.equal('targetPolicyException' in (await read(siblingId)), false);
      });

      it('a clone starts without one', async () => {
        await put(deviceId, ['169.254.10.5']);
        const cloned = await h.service.clone(
          testActor,
          deviceId,
          { targetParentId: groupId, name: 'bmc copy' },
          Visibility.EVERYTHING,
          'all',
        );
        assert.equal('targetPolicyException' in cloned.object, false);
        assert.deepEqual(await stored(cloned.object.id), []);
      });

      it('takes If-Match, and a stale one changes nothing', async () => {
        const before = await read(deviceId);
        const stale = await put(deviceId, ['169.254.10.5'], {
          ...as('admin'),
          'if-match': `W/"${String(before.version - 1)}"`,
        });
        assert.equal(stale.statusCode, 412, stale.body);
        assert.deepEqual(await stored(deviceId), []);
        const fresh = await put(deviceId, ['169.254.10.5'], {
          ...as('admin'),
          'if-match': `W/"${String(before.version)}"`,
        });
        assert.equal(fresh.statusCode, 200, fresh.body);
        assert.equal(fresh.json<DeviceBody>().version, before.version + 1);
      });
    });

    describe('every change is audited', () => {
      it('as an update of the device, naming the administrator, the before and the after', async () => {
        await put(deviceId, ['169.254.10.5']);
        await put(deviceId, ['169.254.10.5', 'fe80::5']);
        // The same list again is no change: no row, no version.
        const version = (await read(deviceId)).version;
        await put(deviceId, ['169.254.10.5', 'fe80::5']);
        assert.equal((await read(deviceId)).version, version);
        await put(deviceId, []);

        const rows = await auditRows(deviceId);
        assert.deepEqual(
          rows.map((row) => ({
            by: row.actor_label,
            diff: row.diff.filter((change) => change.field === 'targetPolicyException'),
            others: row.diff.filter((change) => change.field !== 'targetPolicyException').length,
          })),
          [
            {
              by: 'admin',
              diff: [{ field: 'targetPolicyException', before: null, after: ['169.254.10.5'] }],
              others: 0,
            },
            {
              by: 'admin',
              diff: [
                {
                  field: 'targetPolicyException',
                  before: ['169.254.10.5'],
                  after: ['169.254.10.5', 'fe80::5'],
                },
              ],
              others: 0,
            },
            {
              by: 'admin',
              diff: [
                {
                  field: 'targetPolicyException',
                  before: ['169.254.10.5', 'fe80::5'],
                  after: null,
                },
              ],
              others: 0,
            },
          ],
        );
        // Cleared is absent again, as on a device that never had one.
        assert.equal('targetPolicyException' in (await read(deviceId)), false);
        // And visible in the device's history to whoever may read it.
        const history = await app.inject({
          method: 'GET',
          url: `/api/v1/objects/${String(deviceId)}/audit`,
          headers: as('readwrite'),
        });
        assert.equal(history.statusCode, 200, history.body);
        assert.match(history.body, /targetPolicyException/);
      });
    });

    describe('a change of address is a change', () => {
      it('however long the list: another address in the same place is stored and audited', async () => {
        await put(deviceId, ['169.254.10.5']);
        const version = (await read(deviceId)).version;
        const response = await put(deviceId, ['169.254.10.7']);
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(await stored(deviceId), ['169.254.10.7']);
        assert.equal((await read(deviceId)).version, version + 1);
        const rows = await auditRows(deviceId);
        assert.deepEqual(rows.at(-1)?.diff, [
          { field: 'targetPolicyException', before: ['169.254.10.5'], after: ['169.254.10.7'] },
        ]);
      });
    });

    describe('two administrators at once', () => {
      it('the second is answered 412 on the version the first replaced, and nothing is put back', async () => {
        await put(deviceId, ['169.254.10.5', 'fe80::5']);
        const seen = (await read(deviceId)).version;
        // Another administrator's write: it holds the device, takes `fe80::5` out, and commits
        // only once both requests below are waiting on it (`P-395`: a fixed sleep stood in for
        // the waiting, and nothing said the holder held before the requests were sent).
        const first = holding(['169.254.10.5']);
        const ifMatch = { ...as('admin'), 'if-match': `W/"${String(seen)}"` };
        let racing: Promise<{ statusCode: number; body: string }>[] = [];
        try {
          await within(10_000, 'the first administrator to hold the device', first.holds);
          racing = [
            put(deviceId, ['169.254.10.5', 'fe80::5', '10.0.0.5'], ifMatch),
            put(deviceId, ['169.254.10.5', 'fe80::5'], ifMatch),
          ];
          await sessionsWait(db, 2, 'both requests to wait on the device');
        } finally {
          first.release();
        }
        await within(10_000, 'the first administrator to commit', first.done);
        const answers = await within(10_000, 'both requests to be answered', Promise.all(racing));
        assert.deepEqual(
          answers.map((one) => one.statusCode),
          [412, 412],
          answers.map((one) => one.body).join('\n'),
        );
        assert.deepEqual(await stored(deviceId), ['169.254.10.5'], 'what the first left');

        // Without If-Match the later write wins, and its `before` is the row it replaced. The
        // holder holds before the request is sent: a request that got there first would find
        // what it sends already stored, change nothing and write no audit row.
        const second = holding(['169.254.10.9']);
        const late = second.holds.then(() => put(deviceId, ['169.254.10.5']));
        try {
          await within(10_000, 'the second administrator to hold the device', second.holds);
          await sessionsWait(db, 1, 'the late request to wait on the device');
        } finally {
          second.release();
        }
        await within(10_000, 'the second administrator to commit', second.done);
        const lateAnswer = await within(10_000, 'the late request to be answered', late);
        assert.equal(lateAnswer.statusCode, 200, lateAnswer.body);
        const rows = await auditRows(deviceId);
        assert.deepEqual(rows.at(-1)?.diff, [
          { field: 'targetPolicyException', before: ['169.254.10.9'], after: ['169.254.10.5'] },
        ]);
      });
    });

    describe('a move to another probe does not take an exception with it', () => {
      let otherProbe = 0;
      let otherGroup = 0;
      let sameProbeGroup = 0;
      beforeEach(async () => {
        otherProbe = (
          await h.service.create(testActor, {
            kind: 'probe',
            parentId: h.rootId,
            name: 'Remote probe',
          })
        ).id;
        otherGroup = (
          await h.service.create(testActor, { kind: 'group', parentId: otherProbe, name: 'Rack Z' })
        ).id;
        sameProbeGroup = (
          await h.service.create(testActor, { kind: 'group', parentId: probeId, name: 'Rack B' })
        ).id;
        // The read-write account may write at both ends of every move here.
        await access.grant(otherGroup, teamId, 'full', actorNamed('test'));
        await access.grant(sameProbeGroup, teamId, 'full', actorNamed('test'));
        await put(deviceId, ['169.254.10.5']);
      });
      const move = (id: number, targetParentId: number, role: AccountRole) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/objects/${String(id)}/move`,
          headers: as(role),
          payload: { targetParentId },
        });
      const parentOf = async (id: number): Promise<number | null> =>
        (await h.service.get(id)).parentId;

      it('is refused to anybody who may not grant, saying why, and nothing moves', async () => {
        const refused = await move(deviceId, otherGroup, 'readwrite');
        assert.equal(refused.statusCode, 403, refused.body);
        assert.match(
          refused.json<{ error: { message: string } }>().error.message,
          /exception to the target policy .*another probe.*an administrator must move it, or clear the exception first/,
        );
        assert.equal(await parentOf(deviceId), groupId);
        assert.deepEqual(await stored(deviceId), ['169.254.10.5']);
        // The subtree: the group that holds the device, moved somewhere the account may write,
        // so that the exception is the only reason it is refused.
        const group = await move(groupId, otherGroup, 'readwrite');
        assert.equal(group.statusCode, 403, group.body);
        assert.match(
          group.json<{ error: { message: string } }>().error.message,
          /moving "Rack A" takes 1 device\(s\) with an exception to the target policy/,
        );
        assert.equal(await parentOf(groupId), probeId);
        // And in a batch, by the same code.
        const bulk = await app.inject({
          method: 'POST',
          url: '/api/v1/objects/bulk',
          headers: as('readwrite'),
          payload: { ids: [deviceId], operation: 'move', targetParentId: otherGroup },
        });
        assert.equal(bulk.statusCode, 200, bulk.body);
        const [outcome] = bulk.json<{ outcomes: { ok: boolean; code?: string }[] }>().outcomes;
        assert.deepEqual(
          { ok: outcome?.ok, code: outcome?.code },
          { ok: false, code: 'AUTH_FORBIDDEN' },
        );
        assert.equal(await parentOf(deviceId), groupId);
      });

      it('an administrator’s move clears it on the device, audited, and says so', async () => {
        const moved = await move(deviceId, otherGroup, 'admin');
        assert.equal(moved.statusCode, 200, moved.body);
        const body = moved.json<{ exceptionsCleared: number; object: DeviceBody }>();
        assert.equal(body.exceptionsCleared, 1);
        assert.equal('targetPolicyException' in body.object, false);
        assert.equal(body.object.version, (await read(deviceId)).version);
        assert.deepEqual(await stored(deviceId), []);
        assert.deepEqual((await auditRows(deviceId)).at(-1)?.diff, [
          { field: 'targetPolicyException', before: ['169.254.10.5'], after: null },
        ]);
        const order = await db.query<{ action: string }>(
          `SELECT action FROM audit_log WHERE object_id = $1 ORDER BY id DESC LIMIT 2`,
          [deviceId],
        );
        assert.deepEqual(
          order.map((row) => row.action),
          ['object.updated', 'object.moved'],
        );
      });

      it('an administrator’s move of the group clears it on every device beneath, and only those', async () => {
        const moved = await move(groupId, otherProbe, 'admin');
        assert.equal(moved.statusCode, 200, moved.body);
        assert.equal(moved.json<{ exceptionsCleared: number }>().exceptionsCleared, 1);
        assert.deepEqual(await stored(deviceId), []);
        assert.deepEqual(await stored(siblingId), []);
        assert.deepEqual(await auditRows(siblingId), [], 'nothing to clear on the sibling');
        // A batch move by an administrator clears as the single one does.
        await put(deviceId, ['169.254.10.5']);
        const bulk = await app.inject({
          method: 'POST',
          url: '/api/v1/objects/bulk',
          headers: as('admin'),
          payload: { ids: [deviceId], operation: 'move', targetParentId: sameProbeGroup },
        });
        assert.equal(bulk.statusCode, 200, bulk.body);
        assert.equal(bulk.json<{ outcomes: { ok: boolean }[] }>().outcomes[0]?.ok, true);
        assert.deepEqual(await stored(deviceId), []);
      });

      it('a move under the same probe keeps it, for anybody who may move it', async () => {
        const moved = await move(deviceId, sameProbeGroup, 'readwrite');
        assert.equal(moved.statusCode, 200, moved.body);
        assert.equal(moved.json<{ exceptionsCleared: number }>().exceptionsCleared, 0);
        assert.equal(await parentOf(deviceId), sameProbeGroup);
        assert.deepEqual(await stored(deviceId), ['169.254.10.5']);
        // And a device with none crosses probes for anybody, as before.
        const sibling = await move(siblingId, otherGroup, 'readwrite');
        assert.equal(sibling.statusCode, 200, sibling.body);
      });
    });

    describe('it reaches the probe with the assignment', () => {
      const own = (sensors: readonly SensorAssignment[]): SensorAssignment =>
        sensors.find((sensor) => sensor.sensorId === sensorId) ?? assert.fail('not assigned');
      const others = (sensors: readonly SensorAssignment[]): SensorAssignment[] =>
        sensors.filter((sensor) => sensor.sensorId !== sensorId);

      it('to a probe at 28, on the device’s sensors only, and moves the fingerprint', async () => {
        const without = await config.assignmentsFor(probeId, 28);
        assert.equal('policyException' in own(without.sensors).target, false);

        await put(deviceId, ['169.254.10.5', 'fe80::5']);
        const withIt = await config.assignmentsFor(probeId, 28);
        assert.deepEqual(own(withIt.sensors).target, {
          host: '169.254.10.5',
          ipVersion: 'auto',
          policyException: ['169.254.10.5', 'fe80::5'],
        });
        // The sibling device's sensor carries none, and is the same assignment it was.
        assert.deepEqual(others(withIt.sensors), others(without.sensors));
        assert.notEqual(withIt.version, without.version, 'a change the probe is sent');
        // And what is sent is a configuration a probe at 28 takes.
        assert.equal(
          parseCoreToProbe({
            type: 'config-set',
            version: withIt.version,
            sensors: [...withIt.sensors],
          }).type,
          'config-set',
        );

        // Changed again, it moves again; cleared, it is what it was before.
        await put(deviceId, ['169.254.10.5']);
        const changed = await config.assignmentsFor(probeId, 28);
        assert.notEqual(changed.version, withIt.version);
        await put(deviceId, []);
        assert.equal((await config.assignmentsFor(probeId, 28)).version, without.version);
      });

      it('not to a probe below 28, which refuses those addresses as before', async () => {
        const before = await config.assignmentsFor(probeId, 27);
        await put(deviceId, ['169.254.10.5']);
        const after = await config.assignmentsFor(probeId, 27);
        assert.equal('policyException' in own(after.sensors).target, false);
        // Nothing an older probe acts on moved, so it is sent nothing.
        assert.equal(after.version, before.version);
      });

      it('with “check now”, to the probe on the line, by its version', async () => {
        await put(deviceId, ['169.254.10.5']);
        const current = await config.assignmentFor(sensorId, () => PROTOCOL_VERSION);
        assert.deepEqual(current?.assignment?.target.policyException, ['169.254.10.5']);
        const older = await config.assignmentFor(sensorId, () => 27);
        assert.ok(older?.assignment !== null && older?.assignment !== undefined);
        assert.equal('policyException' in older.assignment.target, false);
      });
    });
  },
);
