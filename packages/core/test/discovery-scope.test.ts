import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/db/pool.js';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository, DatabaseAuditSink } from '../src/audit/store.js';
import { AccountService } from '../src/auth/accounts.js';
import { AccessService } from '../src/auth/access.js';
import { GroupService } from '../src/auth/groups.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { SessionService } from '../src/auth/sessions.js';
import { TokenService } from '../src/auth/tokens.js';
import { TotpService } from '../src/auth/totp.js';
import type { DiscoveryLevel } from '@ms/shared';
import { DiscoveryError } from '../src/discovery/errors.js';
import { provisionRun, type RunProvisioning } from '../src/discovery/provision.js';
import { RediscoveryService } from '../src/discovery/rediscovery.js';
import { DiscoveryService, GROUP_MOVED, type DispatchMessage } from '../src/discovery/service.js';
import { HistoryService } from '../src/timeseries/history.js';
import { ScheduleService } from '../src/schedules/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { actorNamed, buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/**
 * A discovery runs from the probe its group is under, and from no other (`A-28`).
 *
 * The route checked write on the group and nothing on the probe, so a writer on customer A's
 * group could name customer B's probe and sweep B's network from it. These cases hold the
 * service to refusing that on every path that starts a run — by hand, by a schedule when it is
 * written, switched on and fired — and hold the refusal to one answer for every wrong probe, so
 * it cannot be used to learn which ids exist above a branch.
 */
describe(
  'which probe a discovery may use',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let discovery: DiscoveryService;
    let rediscovery: RediscoveryService;
    let app: FastifyInstance;
    let cookie = '';
    let probeA = 0;
    let probeB = 0;
    let groupA = 0;
    let groupB = 0;
    let deviceA = 0;
    let now = new Date('2026-08-31T02:00:00Z');
    const sent: { probeId: number; message: DispatchMessage }[] = [];

    const runsFrom = async (probeId: number): Promise<number> =>
      Number(
        (
          await db.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM discovery_run WHERE probe_id = $1`,
            [probeId],
          )
        )[0]?.n,
      );

    const refused = async (change: () => Promise<unknown>): Promise<void> => {
      await assert.rejects(change, (error: unknown) => {
        assert.ok(error instanceof DiscoveryError);
        assert.equal(error.code, 'DISCOVERY_PROBE_INVALID');
        return true;
      });
    };

    before(async () => {
      scratch = await createScratchDatabase('discoveryscope');
      db = scratch.db;
      harness = await buildHarness(db);

      const make = async (kind: 'probe' | 'group', parentId: number, name: string) =>
        (await harness.service.create(testActor, { kind, parentId, name })).id;
      probeA = await make('probe', harness.rootId, 'probe-a');
      probeB = await make('probe', harness.rootId, 'probe-b');
      groupA = await make('group', probeA, 'Customer A');
      groupB = await make('group', probeB, 'Customer B');
      deviceA = (
        await harness.service.create(testActor, {
          kind: 'device',
          parentId: groupA,
          name: 'a-router',
          host: '192.0.2.1',
        })
      ).id;

      discovery = new DiscoveryService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silent,
        dispatch: (probeId, message) => {
          sent.push({ probeId, message });
          return { kind: 'sent' };
        },
      });
      rediscovery = new RediscoveryService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silent,
        discovery,
        windowFor: () => Promise.resolve(null),
        now: () => now,
      });

      // A writer on customer A's group and nothing else: the account the defect was about.
      const accounts = new AccountService({ db, audit: new DatabaseAuditSink(), logger: silent });
      const groups = new GroupService({ db, audit: new DatabaseAuditSink(), logger: silent });
      const access = new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent });
      const account = await accounts.create(
        { login: 'alice', password: 'correct-horse-battery', role: 'readwrite' },
        testActor,
      );
      const team = await groups.create({ name: 'Customer A team' }, testActor);
      await groups.addMember(team.id, account.id, testActor);
      await access.grant(groupA, team.id, 'write', actorNamed('scope'));

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
        service: harness.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
        schedules: new ScheduleService({ db, audit: new DatabaseAuditSink(), logger: silent }),
        discovery,
        rediscovery,
        auth: {
          accounts,
          sessions: new SessionService({ db, logger: silent }),
          throttle: new LoginThrottle({ db, logger: silent, sleep: () => Promise.resolve() }),
          groups,
          access,
          tokens: new TokenService({ db, audit: new DatabaseAuditSink(), logger: silent }),
          totp: new TotpService({ db, audit: new DatabaseAuditSink(), logger: silent }),
          required: true,
        },
      });
      await server.build('9.9.9', harness.service);
      app = server.app;
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { login: 'alice', password: 'correct-horse-battery' },
      });
      assert.equal(login.statusCode, 200);
      const setCookie = login.headers['set-cookie'];
      cookie =
        (Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '')).split(';')[0] ?? '';
    });

    after(async () => {
      await app.close();
      await scratch.drop();
    });

    describe('in the service, on every path that starts a run', () => {
      it('refuses a run from a probe its group is not under, and sends that probe nothing', async () => {
        sent.length = 0;
        await refused(() =>
          discovery.start({ groupId: groupA, probeId: probeB, range: '10.0.0.0/29' }, testActor),
        );
        assert.equal(await runsFrom(probeB), 0);
        assert.deepEqual(sent, []);
      });

      it('starts one from the probe the group is under', async () => {
        const run = await discovery.start(
          { groupId: groupA, probeId: probeA, range: '10.0.0.0/29' },
          testActor,
        );
        assert.equal(run.probeId, probeA);
      });

      it('refuses a schedule naming another probe when it is written', async () => {
        await refused(() =>
          rediscovery.create(
            {
              groupId: groupA,
              probeId: probeB,
              name: 'borrowed',
              range: '10.0.0.0/29',
              cadence: 'daily',
            },
            testActor,
          ),
        );
      });

      it('refuses to switch on, or fire, a schedule whose group has since moved', async () => {
        const moving = (
          await harness.service.create(testActor, {
            kind: 'group',
            parentId: probeA,
            name: 'moving',
          })
        ).id;
        const schedule = await rediscovery.create(
          {
            groupId: moving,
            probeId: probeA,
            name: 'nightly',
            range: '10.0.1.0/29',
            cadence: 'daily',
            cadenceMinute: 3 * 60,
            timezone: 'UTC',
            enabled: true,
          },
          testActor,
        );
        await rediscovery.setEnabled(schedule.id, false, testActor);
        await harness.service.move(testActor, moving, probeB, { kind: 'none' });

        await refused(() => rediscovery.setEnabled(schedule.id, true, testActor));

        // Switched on behind the check's back — the state a schedule enabled before the move
        // is in — so the firing is what has to refuse.
        await db.query(
          `UPDATE discovery_schedule SET enabled = true, next_run_at = $2 WHERE id = $1`,
          [schedule.id, '2026-08-31T03:00:00Z'],
        );
        const before = await runsFrom(probeA);
        now = new Date('2026-08-31T03:00:00Z');
        assert.equal(await rediscovery.tick(), 0, 'nothing started');
        assert.equal(await runsFrom(probeA), before);
        // **And the rule says why**, where somebody looks, in the refusal's own sentence: a rule
        // that fires unattended and silently stops is one nobody notices has stopped.
        assert.equal(
          (await rediscovery.get(schedule.id))?.lastProblem,
          'a discovery runs from the probe its group is under, and that is not the probe given',
        );

        // Moved back, the next firing starts a run and the problem goes with it.
        await harness.service.move(testActor, moving, probeA, { kind: 'none' });
        await db.query(`UPDATE discovery_schedule SET next_run_at = $2 WHERE id = $1`, [
          schedule.id,
          '2026-09-01T03:00:00Z',
        ]);
        now = new Date('2026-09-01T03:00:00Z');
        assert.equal(await rediscovery.tick(), 1);
        assert.equal((await rediscovery.get(schedule.id))?.lastProblem, '');
      });

      it('refuses a permitted window that does not exist, as the caller’s mistake', async () => {
        await assert.rejects(
          () =>
            rediscovery.create(
              {
                groupId: groupA,
                probeId: probeA,
                name: 'windowless',
                range: '10.0.0.0/29',
                cadence: 'daily',
                scheduleId: 999_999,
              },
              testActor,
            ),
          (error: unknown) =>
            error instanceof DiscoveryError && error.code === 'DISCOVERY_SCHEDULE_INVALID',
        );
      });
    });

    describe('a run whose group moves under another probe after it started (`P-241`)', () => {
      // The rule above was checked when a run started and never again. A run keeps its probe, so
      // after its group moved from A to B, A went on sweeping from its own network, and what it
      // found was provisioned into B's branch. Each case below checks one place the run goes to
      // its probe, or to the tree, and the ones that follow a move back hold the check to "now".

      /** Nothing else going on either probe, so `pump` reaches the run under test first. */
      const quiesce = async (): Promise<void> => {
        await db.query(
          `UPDATE discovery_run SET status = 'cancelled'
           WHERE status IN ('queued', 'running', 'identifying')`,
        );
        sent.length = 0;
      };
      const groupUnderA = async (name: string): Promise<number> =>
        (await harness.service.create(testActor, { kind: 'group', parentId: probeA, name })).id;
      const startOn = (groupId: number, range: string, level: DiscoveryLevel = 'standard') =>
        discovery.start({ groupId, probeId: probeA, range, level }, testActor);
      const moveUnder = (groupId: number, probeId: number) =>
        harness.service.move(testActor, groupId, probeId, { kind: 'none' });
      /** Every sweep or identification offered for a run, to any probe. */
      const offered = (runId: number) =>
        sent.filter(
          ({ message }) =>
            (message.kind === 'start' || message.kind === 'identify') &&
            message.job.runId === runId,
        );
      const failedFor = async (runId: number, reason: string): Promise<void> => {
        const run = await discovery.get(runId);
        assert.equal(run?.status, 'failed');
        assert.equal(run.message, reason);
      };
      /** Who the audit says failed a run, and why. */
      const failure = async (runId: number) =>
        (
          await db.query<{ actor_kind: string; actor_ref: string; reason: string }>(
            `SELECT actor_kind, actor_ref, summary->>'reason' AS reason FROM audit_log
             WHERE action = 'discovery.failed' AND (summary->>'runId')::bigint = $1`,
            [runId],
          )
        )[0];
      const found = [
        { address: '10.0.9.1', rttMs: 1 },
        { address: '10.0.9.2', rttMs: 1 },
      ];

      let provisioned = 0;
      /** What `main.ts` gives `provisionRun`, with a provisioner that only counts. */
      const wiring = (): RunProvisioning => ({
        discovery,
        provisioner: {
          provision: () => {
            provisioned += 1;
            return Promise.resolve({
              matched: 0,
              devicesCreated: 0,
              sensorsCreated: 0,
              mastersSet: 0,
              sensorsSkipped: 0,
              problems: [],
              devices: [],
            });
          },
        },
        existing: () => Promise.resolve({ devices: [], sensors: [] }),
        vouchers: {
          authRequired: false,
          ruleWriter: () => Promise.resolve(null),
          rights: () => Promise.resolve(new Map<number, 'none'>()),
        },
      });

      it('fails a waiting run when its probe asks for work, and offers the next one', async () => {
        await quiesce();
        const moving = await groupUnderA('moving while queued');
        const run = await startOn(moving, '10.0.9.0/29');
        const staying = await startOn(groupA, '10.0.10.0/29');
        // Dropped, as a probe restart leaves it: both runs wait for A to come back.
        await discovery.probeDisconnected(probeA);
        await moveUnder(moving, probeB);
        sent.length = 0;

        await discovery.pump(probeA);
        await failedFor(run.id, GROUP_MOVED);
        assert.deepEqual(offered(run.id), [], 'the old probe was offered the run again');
        assert.equal(offered(staying.id).length, 1, 'and the next run in its queue was not');
        assert.ok(
          sent.some(
            ({ probeId, message }) =>
              probeId === probeA && message.kind === 'cancel' && message.runId === run.id,
          ),
          'the probe is told to stop, as a cancel tells it',
        );

        // Recorded as the core's own decision, with the reason.
        assert.deepEqual(await failure(run.id), {
          actor_kind: 'system',
          actor_ref: 'discovery',
          reason: GROUP_MOVED,
        });

        // Terminal: neither probe is offered it again.
        sent.length = 0;
        await discovery.pump(probeA);
        await discovery.pump(probeB);
        assert.deepEqual(offered(run.id), []);
      });

      it('offers a run whose group moved away and back before its probe asked', async () => {
        // The check is where the group is now, not whether it ever moved.
        await quiesce();
        const moving = await groupUnderA('moved and back');
        const run = await startOn(moving, '10.0.11.0/29');
        await discovery.probeDisconnected(probeA);
        await moveUnder(moving, probeB);
        await moveUnder(moving, probeA);
        sent.length = 0;

        await discovery.pump(probeA);
        assert.equal(offered(run.id).length, 1);
        assert.equal((await discovery.get(run.id))?.status, 'running');
      });

      it('fails a run at the hand-off to identification, which does not pass through pump', async () => {
        await quiesce();
        const moving = await groupUnderA('moving mid-sweep');
        const run = await startOn(moving, '10.0.12.0/29');
        await discovery.progress(probeA, run.id, 4, found, 0);
        await moveUnder(moving, probeB);
        sent.length = 0;

        await discovery.finished(probeA, run.id, 'done', 8, '');
        await failedFor(run.id, GROUP_MOVED);
        assert.deepEqual(offered(run.id), [], 'identification was offered to the old probe');
      });

      it('stops identification between batches, which do not pass through pump either', async () => {
        await quiesce();
        const moving = await groupUnderA('moving mid-identification');
        const run = await startOn(moving, '10.0.13.0/29');
        await discovery.progress(probeA, run.id, 4, found, 0);
        await discovery.finished(probeA, run.id, 'done', 8, '');
        assert.equal((await discovery.get(run.id))?.status, 'identifying');
        await moveUnder(moving, probeB);
        sent.length = 0;

        await discovery.identifyFinished(probeA, run.id, 'done', '');
        await failedFor(run.id, GROUP_MOVED);
        assert.deepEqual(offered(run.id), []);
      });

      it('provisions nothing from a run that finished before its group moved', async () => {
        // The finding's own sequence: the sweep is over and nothing is offered again, so the
        // only place left to stop it is provisioning.
        await quiesce();
        const moving = await groupUnderA('moving after the sweep');
        const run = await startOn(moving, '10.0.14.0/29', 'ping');
        await discovery.progress(probeA, run.id, 4, found, 0);
        await discovery.finished(probeA, run.id, 'done', 8, '');
        assert.equal((await discovery.get(run.id))?.status, 'done');
        await moveUnder(moving, probeB);
        provisioned = 0;

        await assert.rejects(
          () => provisionRun(wiring(), run.id, testActor),
          (error: unknown) => {
            assert.ok(error instanceof DiscoveryError);
            assert.equal(error.code, 'DISCOVERY_RUN_FAILED');
            assert.match(error.message, /created nothing: its group moved to another probe/);
            return true;
          },
        );
        assert.equal(provisioned, 0, 'devices were created in the new probe’s branch');
        await failedFor(run.id, GROUP_MOVED);
        // Failed by whoever asked for it, as a deleted rule's run is.
        assert.deepEqual(await failure(run.id), {
          actor_kind: 'system',
          actor_ref: 'test',
          reason: GROUP_MOVED,
        });
      });

      it('still provisions a run whose group stayed where it was', async () => {
        await quiesce();
        const run = await startOn(groupA, '10.0.15.0/29', 'ping');
        await discovery.progress(probeA, run.id, 4, found, 0);
        await discovery.finished(probeA, run.id, 'done', 8, '');
        provisioned = 0;

        await provisionRun(wiring(), run.id, testActor);
        assert.equal(provisioned, 1);
        assert.equal((await discovery.get(run.id))?.status, 'done');
      });
    });

    describe('over HTTP, for a writer on one branch', () => {
      const post = (url: string, payload: unknown) =>
        app.inject({ method: 'POST', url, headers: { cookie }, payload: payload as never });

      it('answers every wrong probe the same, so none of them says which ids exist', async () => {
        const wrong = {
          'another customer’s probe': probeB,
          'a group, not a probe': groupB,
          'a device under the right group': deviceA,
          'no object at all': 999_999,
        };
        for (const url of ['/api/v1/discovery', '/api/v1/discovery/schedules']) {
          const answers = new Map<string, string>();
          for (const [what, probeId] of Object.entries(wrong)) {
            const response = await post(url, {
              groupId: groupA,
              probeId,
              name: 'borrowed',
              range: '10.0.0.0/29',
              cadence: 'daily',
            });
            assert.equal(response.statusCode, 400, `${url}, ${what}: ${response.body}`);
            const body = response.json<{ error: Record<string, unknown> }>();
            answers.set(what, JSON.stringify({ ...body.error, correlationId: undefined }));
          }
          assert.equal(new Set(answers.values()).size, 1, [...answers.entries()].join('\n'));
        }
        assert.equal(await runsFrom(probeB), 0);
      });

      it('lets the same writer use the probe their group is under', async () => {
        const response = await post('/api/v1/discovery', {
          groupId: groupA,
          probeId: probeA,
          range: '10.0.2.0/29',
        });
        assert.equal(response.statusCode, 201, response.body);
      });
    });

    describe('a rule addressed by its id, for a writer on one branch (`D-11`)', () => {
      const call = (
        method: 'PATCH' | 'POST' | 'DELETE',
        url: string,
        payload?: unknown,
        ifMatch?: string,
      ) =>
        app.inject({
          method,
          url,
          headers: { cookie, ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }) },
          ...(payload === undefined ? {} : { payload: payload as never }),
        });

      const rule = async (groupId: number, probeId: number, name: string): Promise<number> =>
        (
          await rediscovery.create(
            { groupId, probeId, name, range: '10.0.3.0/29', cadence: 'daily' },
            testActor,
          )
        ).id;

      it('answers a rule in a branch it cannot see exactly as an id nobody used', async () => {
        // The guard answers a caller without the right with a 403 naming the object, which for a
        // rule in another branch would be its group's id — where an unused id answers 404.
        const hidden = await rule(groupB, probeB, 'customer B nightly');
        const unused = 999_999;
        const routes: [string, 'PATCH' | 'POST' | 'DELETE', (id: number) => string, unknown][] = [
          [
            'switch',
            'POST',
            (id) => `/api/v1/discovery/schedules/${String(id)}/enabled`,
            { enabled: true },
          ],
          [
            'edit',
            'PATCH',
            (id) => `/api/v1/discovery/schedules/${String(id)}`,
            { name: 'mine now' },
          ],
          ['delete', 'DELETE', (id) => `/api/v1/discovery/schedules/${String(id)}`, undefined],
        ];
        for (const [what, method, url, payload] of routes) {
          const answers = [];
          for (const id of [hidden, unused]) {
            const response = await call(method, url(id), payload, 'W/"1"');
            const body = response.json<{ error: Record<string, unknown> }>();
            answers.push(
              JSON.stringify({
                status: response.statusCode,
                ...body.error,
                // The id asked about is echoed back, as the caller's own input; nothing else is.
                message: String(body.error['message']).replace(String(id), '<id>'),
                context: { ...(body.error['context'] as object), id: '<id>' },
                correlationId: undefined,
              }),
            );
          }
          assert.equal(answers[0], answers[1], `${what}: ${answers.join(' / ')}`);
          assert.match(answers[0] ?? '', /"status":404/, what);
        }
        const untouched = await rediscovery.get(hidden);
        assert.equal(untouched?.name, 'customer B nightly');
        assert.equal(untouched.enabled, false);
      });

      it('edits a rule it may write, on the version it read, and not on any other', async () => {
        const id = await rule(groupA, probeA, 'customer A nightly');
        const url = `/api/v1/discovery/schedules/${String(id)}`;

        const bare = await call('PATCH', url, { name: 'no version' });
        assert.equal(bare.statusCode, 428, bare.body);
        const garbled = await call('PATCH', url, { name: 'no version' }, 'yesterday');
        assert.equal(garbled.statusCode, 400, garbled.body);

        const edited = await call('PATCH', url, { name: 'customer A, later' }, 'W/"1"');
        assert.equal(edited.statusCode, 200, edited.body);
        assert.equal(edited.headers['etag'], 'W/"2"');
        const body = edited.json<Record<string, unknown>>();
        assert.equal(body['version'], 2);
        assert.equal(body['snmpCommunity'], undefined, 'a community is never returned');

        const stale = await call('PATCH', url, { name: 'on the old version' }, 'W/"1"');
        assert.equal(stale.statusCode, 412, stale.body);
        assert.equal(
          stale.json<{ error: { code: string } }>().error.code,
          'DISCOVERY_SCHEDULE_CHANGED',
        );
        assert.equal((await rediscovery.get(id))?.name, 'customer A, later');

        // The probe is asked as it is when a rule is written (`A-28`), with the same one answer.
        const borrowed = await call('PATCH', url, { probeId: probeB }, 'W/"2"');
        assert.equal(borrowed.statusCode, 400, borrowed.body);
        assert.equal(
          borrowed.json<{ error: { code: string } }>().error.code,
          'DISCOVERY_PROBE_INVALID',
        );
      });

      it('refuses an id that is not one as a 400, not a database error', async () => {
        const response = await call(
          'PATCH',
          '/api/v1/discovery/schedules/abc',
          { name: 'x' },
          'W/"1"',
        );
        assert.equal(response.statusCode, 400, response.body);
      });
    });
  },
);
