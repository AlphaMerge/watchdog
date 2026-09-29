import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { CheckResult } from '@ms/shared';
import type { QueryResultRow } from 'pg';
import { CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import { AccessService, type AccessPrincipal, type Visibility } from '../src/auth/access.js';
import { AccountService, type AccountRole } from '../src/auth/accounts.js';
import { GroupService } from '../src/auth/groups.js';
import type { Database, Queryable } from '../src/db/pool.js';
import { FactoryReach } from '../src/factory/reach.js';
import { FactoryService } from '../src/factory/service.js';
import { MessageContextLoader } from '../src/notifications/context.js';
import { AlarmEngine } from '../src/notifications/engine.js';
import { AlarmScheduler } from '../src/notifications/scheduler.js';
import { TriggerSync } from '../src/notifications/sync.js';
import { TemplateService } from '../src/notifications/templates.js';
import { storedAccountWrites } from '../src/objects/credential-vouching.js';
import type { Writer } from '../src/objects/sensor-reads.js';
import { catalogueSensorTypeGate } from '../src/objects/sensor-type-gate.js';
import {
  SensorVouching,
  WITHHELD,
  type SensorToVouchFor,
  type SensorVouchingOptions,
  type StoredVoucher,
} from '../src/objects/vouching.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import { TriggerService } from '../src/triggers/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { actorNamed, buildHarness, silent, testActor, type Harness } from './support/tree.js';

/**
 * `A-29`, the second half: who vouched for a sensor, re-checked every time it is evaluated.
 *
 * The first half refuses a write that names what its writer cannot read. That is not enough on
 * its own, because a grant can be taken away after the write: an account that could read a group
 * when it wrote a Sensor Factory over it goes on publishing that group's readings, through the
 * factory, after an administrator has decided it should not see them. So the core records who
 * vouched, asks again at every sweep, and stops evaluating a sensor its voucher can no longer
 * read through — Unknown, with a gap, and with no alarm storm.
 *
 * The verdicts first, against real accounts and grants; then what a write records; then what
 * the state machine and the notification engine make of a withheld sensor, end to end.
 */

const available = await databaseAvailable();

const NEVER_ISSUED = 9_000_000;
const NONE_WITHHELD: ReadonlyMap<number, string> = new Map();
const NONE_HELD: ReadonlySet<number> = new Set();

/** The formula a factory over these sensors' `rtt` would have. */
const sumOf = (...ids: number[]): Record<string, unknown> => ({
  channels: [
    {
      key: 'total',
      formula: ids.map((id) => `channel(${String(id)}, 'rtt')`).join(' + '),
    },
  ],
});

interface Person {
  readonly id: number;
  readonly login: string;
  readonly role: AccountRole;
}

describe(
  'who vouched for a sensor, re-checked at use',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let access: AccessService;
    let accounts: AccountService;
    let groups: GroupService;
    let engine: AlarmEngine;
    let triggers: TriggerService;
    let templates: TemplateService;
    let scheduler: AlarmScheduler;

    /** Read on `site`, write on `sums`; `sources` is what the factories read. */
    let site = 0;
    let sources = 0;
    let sourcePing = 0;
    let sums = 0;
    let sumsDevice = 0;
    /** A probe the team has no right on, for Probe Health. */
    let hiddenProbe = 0;
    let team = 0;

    let analyst: Person;
    let admin: Person;

    /** Replaced per test; the state service reads whichever is current. */
    let vouching: SensorVouching | undefined;
    /** The factories held for their inputs' probe (`M-26`), replaced per test the same way. */
    let reach: FactoryReach | undefined;
    let factory: FactoryService;
    let ingested: CheckResult[] = [];

    const gate = catalogueSensorTypeGate(testCatalogue());

    const sight = (principal: AccessPrincipal, q: Queryable): Promise<Visibility> =>
      access.visibilityFor(principal, q);

    const newVouching = (on: SensorVouchingOptions['db'] = db): SensorVouching =>
      new SensorVouching({
        db: on,
        logger: silent,
        sensorTypes: gate,
        sight,
        ...(h.states === undefined ? {} : { states: h.states }),
        ...(h.dependencies === undefined ? {} : { dependencies: h.dependencies }),
      });

    /** A writer as a route builds one: what the account can see, resolved now. */
    async function as(person: Person): Promise<Writer> {
      return {
        kind: 'user',
        userId: person.id,
        login: person.login,
        voucher: {
          kind: 'account',
          userId: person.id,
          sees: await access.visibilityFor({ userId: person.id, role: person.role }),
          writes: storedAccountWrites((p, ids, q) => access.resolveManyFor(p, ids, q), person.id),
        },
      };
    }

    const administrator = actorNamed('admin');

    /** Takes the team's read on `sources` away: a `none` grant, carving a hole in `site`. */
    async function revokeSources(): Promise<void> {
      await access.grant(sources, team, 'none', administrator);
    }

    async function restoreSources(): Promise<void> {
      await access.revoke(sources, team, administrator);
    }

    /**
     * Results into states the way ingestion writes them: decide, write, then the dependency
     * reaction and the alarm reaction, in the ingestor's order (`M-11`).
     */
    async function ingest(results: readonly SensorResult[]): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      if (results.length === 0) return;
      const decisions = await states.decide(results);
      const at = results[0]?.at ?? new Date();
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
        await h.dependencies?.react(q, decisions.transitions, at);
        await engine.react(
          q,
          results.map((result) => result.sensorId),
          at,
        );
      });
    }

    async function makeFactories(writer: Writer, count: number): Promise<number[]> {
      const ids: number[] = [];
      for (let index = 0; index < count; index += 1) {
        const made = await h.service.create(writer, {
          kind: 'sensor',
          parentId: sumsDevice,
          name: `sum-${String(index).padStart(2, '0')}-${String(process.hrtime.bigint())}`,
          sensorType: 'core.factory',
          params: sumOf(sourcePing),
        });
        ids.push(made.id);
      }
      return ids;
    }

    async function runtimeOf(
      sensorId: number,
    ): Promise<{ state: string; cause: string; message: string }> {
      const [row] = await db.query<{ state: string; cause: string; message: string }>(
        `SELECT state::text AS state, cause::text AS cause, message
         FROM sensor_runtime WHERE object_id = $1`,
        [sensorId],
      );
      assert.ok(row !== undefined, `sensor ${String(sensorId)} has no runtime`);
      return row;
    }

    async function voucherOf(sensorId: number): Promise<StoredVoucher> {
      const [row] = await db.query<{ vouched_by: string; vouched_by_user: string | null }>(
        `SELECT vouched_by, vouched_by_user::text AS vouched_by_user
         FROM sensor_config WHERE object_id = $1`,
        [sensorId],
      );
      assert.ok(row !== undefined);
      return row.vouched_by === 'account'
        ? {
            kind: 'account',
            userId: row.vouched_by_user === null ? null : Number(row.vouched_by_user),
          }
        : { kind: 'installation' };
    }

    async function count(sql: string, values: readonly unknown[] = []): Promise<number> {
      const [row] = await db.query<{ n: string }>(sql, values);
      return Number(row?.n);
    }

    const requests = (): Promise<number> =>
      count('SELECT count(*)::text AS n FROM notification_request');

    /** A mail template and a state trigger on the root, as an installation's default would be. */
    async function stateTrigger(state: 'down' | 'unknown' | 'up'): Promise<void> {
      const template = await templates.create(testActor, {
        name: `Vouching ${state} ${String(process.hrtime.bigint())}`,
        method: 'email',
        settings: {},
        subject: '%sensor is %status',
        body: '%lastmessage',
        recipients: [{ kind: 'address', value: 'noc@example.test' }],
        summaryWindowSeconds: 60,
      });
      await triggers.create(testActor, h.rootId, {
        kind: 'state',
        settings: {
          state,
          initialLatencySeconds: 0,
          initialTemplateId: template.id,
          recoveryTemplateId: template.id,
        },
      });
    }

    const factorySensor = (
      sensorId: number,
      voucher: StoredVoucher,
      params: Record<string, unknown> = sumOf(sourcePing),
    ): SensorToVouchFor => ({
      sensorId,
      sensorType: 'core.factory',
      params,
      enclosingProbeId: null,
      voucher,
    });

    const byAnalyst = (): StoredVoucher => ({ kind: 'account', userId: analyst.id });

    before(async () => {
      scratch = await createScratchDatabase('vouching');
      db = scratch.db;

      engine = new AlarmEngine({ logger: silent });
      h = await buildHarness(db, {
        states: true,
        alarms: engine,
        withheldSensors: () => vouching?.withheld() ?? NONE_WITHHELD,
        unreachedFactories: () => reach?.unreached() ?? NONE_HELD,
      });
      const sync = new TriggerSync({ engine, logger: silent });
      h.audit.also = sync;
      triggers = new TriggerService({
        db,
        audit: new CompositeAuditSink([new DatabaseAuditSink(), sync]),
        logger: silent,
      });
      templates = new TemplateService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silent,
        contexts: new MessageContextLoader({
          settings: h.resolver,
          publicUrl: 'https://monitoring.example.test',
          siteName: 'Vouching',
        }),
      });
      scheduler = new AlarmScheduler({ db, engine, logger: silent });

      accounts = new AccountService({ audit: new DatabaseAuditSink(), db, logger: silent });
      groups = new GroupService({ audit: new DatabaseAuditSink(), db, logger: silent });
      access = new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent });

      const create = async (input: Record<string, unknown>): Promise<number> =>
        (await h.service.create(testActor, input as never)).id;

      site = await create({ kind: 'probe', parentId: h.rootId, name: 'site' });
      sources = await create({ kind: 'group', parentId: site, name: 'sources' });
      const sourceDevice = await create({
        kind: 'device',
        parentId: sources,
        name: 'uplink',
        host: '192.0.2.1',
      });
      sourcePing = await create({
        kind: 'sensor',
        parentId: sourceDevice,
        name: 'uplink-ping',
        sensorType: 'icmp.ping',
      });
      await db.query(
        `INSERT INTO sample (channel_id, time, value)
         SELECT id, now(), 12 FROM channel WHERE sensor_id = $1 AND key = 'rtt'`,
        [sourcePing],
      );
      // Measured, and Up: a source nobody has scanned is Unknown, and a trigger on Unknown
      // would page about it too.
      await ingest([{ sensorId: sourcePing, at: new Date(), outcome: 'ok', message: 'reachable' }]);
      sums = await create({ kind: 'group', parentId: site, name: 'sums' });
      sumsDevice = await create({
        kind: 'device',
        parentId: sums,
        name: 'sums-01',
        host: '192.0.2.2',
      });
      hiddenProbe = await create({ kind: 'probe', parentId: h.rootId, name: 'hidden' });

      team = (await groups.create({ name: 'Team' }, testActor)).id;
      await access.grant(site, team, 'read', administrator);
      await access.grant(sums, team, 'write', administrator);

      const made = await accounts.create(
        { login: 'analyst', password: 'correct-horse-battery', role: 'readwrite' },
        testActor,
      );
      await groups.addMember(team, made.id, testActor);
      analyst = { id: made.id, login: 'analyst', role: 'readwrite' };

      const root = await accounts.create(
        { login: 'root', password: 'correct-horse-battery', role: 'admin' },
        testActor,
      );
      const admins = (await groups.list()).find((group) => group.isAdmin);
      assert.ok(admins);
      await groups.addMember(admins.id, root.id, testActor);
      admin = { id: root.id, login: 'root', role: 'admin' };
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM notification_request');
      await db.query('DELETE FROM notification_summary');
      await db.query('DELETE FROM notification_alarm');
      await db.query('DELETE FROM notification_trigger');
      await db.query('DELETE FROM notification_template');
      await db.query(
        `DELETE FROM object
         WHERE id IN (SELECT object_id FROM sensor_config WHERE type = 'core.factory')`,
      );
      ingested = [];
      vouching = newVouching();
      reach = new FactoryReach();
      factory = new FactoryService({
        db,
        logger: silent,
        vouching,
        reach,
        ingest: async (results) => {
          ingested.push(...results);
          await ingest(
            results.map((result) => ({
              sensorId: result.sensorId,
              at: new Date(result.at),
              outcome: result.outcome,
              message: result.message,
            })),
          );
        },
      });
    });

    // ── the verdicts ───────────────────────────────────────────────────────────────────────

    it('asks nothing at all when every sensor is vouched for by the installation', async () => {
      // The common case, and the one every installation without accounts is in: it must cost
      // nothing, or the check becomes a tax on self-monitoring.
      let queries = 0;
      const counted = newVouching(
        countingQueries(db, () => {
          queries += 1;
        }),
      );
      const refused = await counted.refusals([
        factorySensor(1, { kind: 'installation' }),
        factorySensor(2, { kind: 'installation' }),
        { ...factorySensor(3, { kind: 'installation' }), sensorType: 'ms.core.health' },
      ]);
      assert.equal(refused.size, 0);
      assert.equal(queries, 0);
    });

    it('holds no account’s voucher against a sensor while the layer is off (A-45)', async () => {
      // Nobody's grants apply to any reader then, so withholding protected nobody, and stopped
      // Core Health for an account deleted or short of read on the root. That is also where
      // migration 059 left an installation that had run with the layer off.
      let queries = 0;
      const off = new SensorVouching({
        db: countingQueries(db, () => {
          queries += 1;
        }),
        logger: silent,
        sensorTypes: gate,
        sight,
        requireAuthentication: false,
      });
      const check = [
        factorySensor(1, byAnalyst()),
        factorySensor(2, { kind: 'account', userId: null }),
        { ...factorySensor(3, byAnalyst()), sensorType: 'ms.core.health', params: {} },
      ];
      await revokeSources();
      try {
        assert.deepEqual([...(await off.refusals(check))], []);
        assert.equal(queries, 0, 'and asks nothing');
        assert.equal((await newVouching().refusals(check)).size, 3, 'the control: the layer on');
      } finally {
        await restoreSources();
      }
    });

    it('keeps a sight resolved before a revoke out of the cache the revoke started (A-45)', async () => {
      // The three sweeps share one instance and run in phase. One waited on the analyst's sight
      // while a grant was revoked and another sweep read the new epoch; the sight that landed was
      // from before the revoke, and cached under the new epoch it kept answering with the old
      // grant until the next grant change.
      const early = await access.visibilityFor({ userId: analyst.id, role: analyst.role });
      let release: (sees: Visibility) => void = () => undefined;
      const held = { asked: false };
      const racing = new SensorVouching({
        db,
        logger: silent,
        sensorTypes: gate,
        sight: (principal, q) => {
          if (held.asked || principal.userId !== analyst.id) return sight(principal, q);
          held.asked = true;
          return new Promise<Visibility>((resolve) => {
            release = resolve;
          });
        },
      });
      const mine = [factorySensor(1, byAnalyst())];
      const waiting = racing.refusals(mine);
      for (let turns = 0; !held.asked && turns < 1_000; turns += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.ok(held.asked, 'the first sweep is waiting on the sight');

      await revokeSources();
      try {
        // Another sweep reads the revoke's epoch, and empties the caches.
        await racing.refusals([factorySensor(2, { kind: 'account', userId: admin.id })]);
        release(early);
        assert.deepEqual(
          [...(await waiting)],
          [],
          'the control: the sweep that waited answered from before the revoke',
        );
        assert.deepEqual([...(await racing.refusals(mine))], [[1, WITHHELD.lostRead]]);
      } finally {
        await restoreSources();
      }
    });

    it('withholds a sensor once its voucher loses read, and lets it go when read returns', async () => {
      const check = [factorySensor(1, byAnalyst())];
      assert.deepEqual([...((await vouching?.refusals(check)) ?? [])], []);

      await revokeSources();
      try {
        // The same instance: the grant moved the epoch, so what it cached is dropped.
        assert.deepEqual([...((await vouching?.refusals(check)) ?? [])], [[1, WITHHELD.lostRead]]);
      } finally {
        await restoreSources();
      }
      assert.deepEqual([...((await vouching?.refusals(check)) ?? [])], []);
    });

    it('withholds for a deleted account and a disabled one, and not for a locked one', async () => {
      const leaver = await accounts.create(
        { login: 'leaver', password: 'correct-horse-battery', role: 'readwrite' },
        testActor,
      );
      await groups.addMember(team, leaver.id, testActor);
      const locked = await accounts.create(
        { login: 'locked', password: 'correct-horse-battery', role: 'readwrite' },
        testActor,
      );
      await groups.addMember(team, locked.id, testActor);

      await accounts.update(leaver.id, { disabled: true }, testActor);
      // A lockout is a defence anybody can trigger from the login form; it revokes nothing.
      await db.query(
        `UPDATE user_account SET locked_until = now() + interval '1 hour' WHERE id = $1`,
        [locked.id],
      );

      const refused = await vouching?.refusals([
        factorySensor(1, { kind: 'account', userId: null }),
        factorySensor(2, { kind: 'account', userId: NEVER_ISSUED }),
        factorySensor(3, { kind: 'account', userId: leaver.id }),
        factorySensor(4, { kind: 'account', userId: locked.id }),
      ]);
      assert.deepEqual(
        [...(refused ?? [])].sort(([a], [b]) => a - b),
        [
          [1, WITHHELD.deleted],
          [2, WITHHELD.deleted],
          [3, WITHHELD.disabled],
        ],
      );
    });

    it('skips a named object that no longer exists rather than calling it a revoked grant', async () => {
      // The factory gaps that term on its own. Withholding it would say "your access changed"
      // about a sensor somebody deleted, and would hide the readings it can still compute.
      const refused = await vouching?.refusals([
        factorySensor(1, byAnalyst(), sumOf(sourcePing, NEVER_ISSUED)),
        factorySensor(2, byAnalyst(), sumOf(NEVER_ISSUED)),
      ]);
      assert.equal(refused?.size, 0);
    });

    it('holds Core Health to read on the root, and Probe Health to the probe it reports on', async () => {
      const coreHealth = (voucher: StoredVoucher, sensorId: number): SensorToVouchFor => ({
        sensorId,
        sensorType: 'ms.core.health',
        params: {},
        enclosingProbeId: null,
        voucher,
      });
      const probeHealth = (
        sensorId: number,
        params: Record<string, unknown>,
        enclosingProbeId: number | null,
      ): SensorToVouchFor => ({
        sensorId,
        sensorType: 'ms.probe.health',
        params,
        enclosingProbeId,
        voucher: byAnalyst(),
      });

      const refused = await vouching?.refusals([
        coreHealth(byAnalyst(), 1),
        coreHealth({ kind: 'account', userId: admin.id }, 2),
        probeHealth(3, {}, site),
        probeHealth(4, {}, hiddenProbe),
        probeHealth(5, { probeId: hiddenProbe }, site),
        probeHealth(6, { probeId: site }, hiddenProbe),
      ]);
      assert.deepEqual(
        [...(refused ?? [])].sort(([a], [b]) => a - b),
        [
          [1, WITHHELD.lostRead],
          [4, WITHHELD.lostRead],
          [5, WITHHELD.lostRead],
        ],
      );
    });

    it('costs a fixed number of queries a sweep, not one per sensor', async () => {
      // `CLAUDE.md`: the scheduler is never blocked, and a check that asked the database once per
      // sensor per sweep would be a sweep that grows with the installation.
      const ask = async (sensors: number): Promise<{ first: number; again: number }> => {
        let queries = 0;
        const counted = newVouching(
          countingQueries(db, () => {
            queries += 1;
          }),
        );
        const check = Array.from({ length: sensors }, (_, index) =>
          factorySensor(index + 1, byAnalyst()),
        );
        await counted.refusals(check);
        const first = queries;
        queries = 0;
        await counted.refusals(check);
        return { first, again: queries };
      };

      const few = await ask(2);
      const many = await ask(40);
      assert.equal(many.first, few.first, 'forty sensors cost what two did');
      assert.equal(few.again, 2, 'the epoch and the accounts, and which named objects exist');
      assert.equal(many.again, 2);
    });

    // ── what a write records ───────────────────────────────────────────────────────────────

    it('records who vouched on every write that names something, and not on a rename', async () => {
      const [made] = await makeFactories(await as(analyst), 1);
      assert.ok(made !== undefined);
      assert.deepEqual(await voucherOf(made), { kind: 'account', userId: analyst.id });

      // A rename names nothing, so it is not checked and vouches for nothing.
      await h.service.update(
        await as(admin),
        made,
        { kind: 'sensor', name: 'renamed' },
        { kind: 'none' },
      );
      assert.deepEqual(await voucherOf(made), { kind: 'account', userId: analyst.id });

      // Writing its parameters vouches for all of them.
      await h.service.update(
        await as(admin),
        made,
        { kind: 'sensor', params: sumOf(sourcePing) },
        { kind: 'none' },
      );
      assert.deepEqual(await voucherOf(made), { kind: 'account', userId: admin.id });

      // A move re-checks and so re-vouches: the mover is who put it where it now is.
      const elsewhere = await h.service.create(testActor, {
        kind: 'device',
        parentId: sums,
        name: `sums-02-${String(process.hrtime.bigint())}`,
        host: '192.0.2.3',
      });
      await h.service.move(await as(analyst), made, elsewhere.id, { kind: 'none' });
      assert.deepEqual(await voucherOf(made), { kind: 'account', userId: analyst.id });

      // A clone is a new sensor, vouched for by whoever made it.
      const copy = await h.service.clone(
        await as(admin),
        made,
        { name: `copied-${String(process.hrtime.bigint())}` },
        await access.visibilityFor({ userId: admin.id, role: admin.role }),
      );
      assert.deepEqual(await voucherOf(copy.object.id), { kind: 'account', userId: admin.id });

      // And the system vouches as the installation.
      const [system] = await makeFactories(testActor, 1);
      assert.ok(system !== undefined);
      assert.deepEqual(await voucherOf(system), { kind: 'installation' });
    });

    // ── what a withheld sensor looks like ──────────────────────────────────────────────────

    it('reads Unknown, says why, and gaps, until its voucher can read again', async () => {
      const [sum] = await makeFactories(await as(analyst), 1);
      assert.ok(sum !== undefined);

      await factory.sweep();
      assert.equal((await runtimeOf(sum)).state, 'up');
      assert.ok(ingested.some((result) => result.sensorId === sum));

      await revokeSources();
      try {
        ingested = [];
        await factory.sweep();
        assert.deepEqual(await runtimeOf(sum), {
          state: 'unknown',
          cause: 'access',
          message: WITHHELD.lostRead,
        });
        assert.ok(
          !ingested.some((result) => result.sensorId === sum),
          'nothing was recorded for it: its channels gap',
        );
        assert.equal(factory.stats().withheld, 1);
        assert.equal(
          await count(
            `SELECT count(*)::text AS n FROM sensor_state
             WHERE sensor_id = $1 AND state = 'unknown' AND cause = 'access'`,
            [sum],
          ),
          1,
          'and the history says why, once',
        );

        // A second sweep changes nothing: the set did not move, so nothing is re-decided.
        const history = (): Promise<number> =>
          count(`SELECT count(*)::text AS n FROM sensor_state WHERE sensor_id = $1`, [sum]);
        const recorded = await history();
        await factory.sweep();
        assert.equal(await history(), recorded);
      } finally {
        await restoreSources();
      }

      ingested = [];
      await factory.sweep();
      assert.equal((await runtimeOf(sum)).state, 'up');
      assert.ok(ingested.some((result) => result.sensorId === sum));
      assert.equal(vouching?.withheld().size, 0);
    });

    it('tries a failed re-decision again at the next sweep, both ways (A-45)', async () => {
      // The live fact moved before the write, and a write that failed left it moved: the next
      // sweep saw nothing to do, and the sensor kept its stored Up while nothing evaluated it.
      const [sum] = await makeFactories(await as(analyst), 1);
      assert.ok(sum !== undefined);
      await factory.sweep();
      assert.equal((await runtimeOf(sum)).state, 'up');

      const states = h.states;
      assert.ok(states !== undefined);
      const calls: number[][] = [];
      vouching = new SensorVouching({
        db,
        logger: silent,
        sensorTypes: gate,
        sight,
        states: {
          reevaluate: (q, ids, at, cause) => {
            calls.push([...ids]);
            // The first write each way fails, as a serialisation failure or a dropped
            // connection would.
            if (calls.length % 2 === 1) return Promise.reject(new Error('could not serialize'));
            return states.reevaluate(q, ids, at, cause);
          },
        },
        ...(h.dependencies === undefined ? {} : { dependencies: h.dependencies }),
      });
      const refused = new Map([[sum, WITHHELD.lostRead]]);

      assert.equal(await vouching.settle('factory', refused), 0);
      assert.equal((await runtimeOf(sum)).state, 'up', 'the control: the write failed');
      await vouching.settle('factory', refused);
      assert.deepEqual(await runtimeOf(sum), {
        state: 'unknown',
        cause: 'access',
        message: WITHHELD.lostRead,
      });

      assert.equal(await vouching.settle('factory', NONE_WITHHELD), 0);
      assert.equal((await runtimeOf(sum)).state, 'unknown', 'the control: the release failed');
      await vouching.settle('factory', NONE_WITHHELD);
      assert.equal((await runtimeOf(sum)).state, 'up');
      assert.deepEqual(calls, [[sum], [sum], [sum], [sum]], 'each crossing written twice');
      assert.equal(vouching.withheld().size, 0);
    });

    it('lets an account that can read it vouch again by saving it', async () => {
      const [sum] = await makeFactories(await as(analyst), 1);
      assert.ok(sum !== undefined);
      await factory.sweep();

      await revokeSources();
      try {
        await factory.sweep();
        assert.equal((await runtimeOf(sum)).cause, 'access');

        // The fix the message names: an administrator saves it, and vouches for it.
        await h.service.update(
          await as(admin),
          sum,
          { kind: 'sensor', params: sumOf(sourcePing) },
          { kind: 'none' },
        );
        await factory.sweep();
        assert.equal((await runtimeOf(sum)).state, 'up');
      } finally {
        await restoreSources();
      }
    });

    // ── and what depends on it (`M-23`) ────────────────────────────────────────────────────

    /** A factory written by `person`, with these channels. */
    async function factoryOf(
      person: Person,
      channels: readonly { key: string; formula: string }[],
    ): Promise<number> {
      return (
        await h.service.create(await as(person), {
          kind: 'sensor',
          parentId: sumsDevice,
          name: `factory-${String(process.hrtime.bigint())}`,
          sensorType: 'core.factory',
          params: { channels },
        })
      ).id;
    }

    /** A device of pings under `parentId`, made by the installation. */
    async function pingsUnder(
      parentId: number,
      count: number,
    ): Promise<{ device: number; pings: number[] }> {
      const device = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId,
          name: `pings-${String(process.hrtime.bigint())}`,
          host: '192.0.2.40',
        })
      ).id;
      const pings: number[] = [];
      for (let index = 0; index < count; index += 1) {
        const made = await h.service.create(testActor, {
          kind: 'sensor',
          parentId: device,
          name: `ping-${String(index).padStart(2, '0')}`,
          sensorType: 'icmp.ping',
        });
        pings.push(made.id);
      }
      return { device, pings };
    }

    const failing = (sensorIds: readonly number[]): SensorResult[] =>
      sensorIds.map((sensorId) => ({
        sensorId,
        at: new Date(),
        outcome: 'error' as const,
        message: 'no reply',
      }));

    it('keeps a Down master that is withheld holding its twenty dependents: no alarm for them (M-23)', async () => {
      // A master withheld while Down let go of everything it held at once, and each dependent
      // then paged on its own failure: one grant edit, twenty alarms, for an outage that had not
      // changed and that nothing had measured the end of.
      const quiet = await pingsUnder(sources, 1);
      const branch = await pingsUnder(sums, 20);
      try {
        const [unmeasured] = quiet.pings;
        assert.ok(unmeasured !== undefined);
        const master = await factoryOf(analyst, [
          { key: 'total', formula: `channel(${String(unmeasured)}, 'rtt')` },
        ]);
        await h.service.setDependency(testActor, branch.device, 'object', master, undefined);
        await stateTrigger('down');

        // Nothing to compute from, twice: Warning, then Down, and the one page it owes.
        await factory.sweep();
        await factory.sweep();
        assert.equal((await runtimeOf(master)).state, 'down');
        const held = (): Promise<number> =>
          count(
            `SELECT count(*)::text AS n FROM sensor_runtime
             WHERE object_id = ANY($1::bigint[]) AND paused_by_dependency AND state = 'paused'`,
            [branch.pings],
          );
        assert.equal(await held(), 20, 'the outage holds its dependents');
        await scheduler.sweep(new Date(Date.now() + 60_000));
        const paged = await requests();
        assert.equal(paged, 1, 'one outage, one page');

        await revokeSources();
        try {
          await factory.sweep();
          assert.deepEqual(await runtimeOf(master), {
            state: 'unknown',
            cause: 'access',
            message: WITHHELD.lostRead,
          });
          assert.equal(await held(), 20, 'withheld, the master still holds them');

          // The branch is still down, and its sensors say so: twice, so a released one would be
          // Down by now.
          await ingest(failing(branch.pings));
          await ingest(failing(branch.pings));
          assert.equal(await held(), 20);
          await scheduler.sweep(new Date(Date.now() + 60_000));
          assert.equal(await requests(), paged, 'and nothing more pages');
        } finally {
          await restoreSources();
        }

        // Vouched for again, and still Down: still holding, still one page.
        await factory.sweep();
        assert.equal((await runtimeOf(master)).state, 'down');
        assert.equal(await held(), 20);
        await scheduler.sweep(new Date(Date.now() + 60_000));
        assert.equal(await requests(), paged);

        // It recovers and lets go. Withheld again while Up, it holds nothing: the hold ended
        // when it was evaluated again, and does not outlive that.
        await db.query(
          `INSERT INTO sample (channel_id, time, value)
           SELECT id, now(), 5 FROM channel WHERE sensor_id = $1 AND key = 'rtt'`,
          [unmeasured],
        );
        await factory.sweep();
        assert.equal((await runtimeOf(master)).state, 'up');
        assert.equal(await held(), 0, 'recovered, with no delay configured');
        await revokeSources();
        try {
          await factory.sweep();
          assert.equal((await runtimeOf(master)).cause, 'access');
          assert.equal(await held(), 0, 'withheld while Up, it holds nothing');
        } finally {
          await restoreSources();
        }
      } finally {
        await db.query(
          'DELETE FROM object WHERE id = ANY($1::bigint[]) OR parent_id = ANY($1::bigint[])',
          [[quiet.device, branch.device]],
        );
      }
    });

    it('withholds a factory built on a withheld one, and one built on that, instead of downing them (M-23)', async () => {
      // The withheld factory's channels gap, which is right, and a factory reading only those had
      // nothing to compute from, reported an error, went Down and paged: a Down row and an alarm
      // on every factory downstream of one grant edit, with nothing measured having failed.
      const [first] = await makeFactories(await as(analyst), 1);
      assert.ok(first !== undefined);
      const second = await factoryOf(admin, [
        { key: 'total', formula: `channel(${String(first)}, 'total') * 8` },
      ]);
      const third = await factoryOf(admin, [
        { key: 'total', formula: `channel(${String(second)}, 'total')` },
      ]);
      // One channel still has something to compute from, so it computes it, with a gap.
      const mixed = await factoryOf(admin, [
        { key: 'total', formula: `channel(${String(first)}, 'total')` },
        { key: 'rtt', formula: `channel(${String(sourcePing)}, 'rtt')` },
      ]);
      // One gaps on the withheld factory and on something that is simply missing: the missing
      // one is its own fault, as it always was.
      const partly = await factoryOf(admin, [
        { key: 'total', formula: `channel(${String(first)}, 'total')` },
        { key: 'other', formula: `channel(${String(sourcePing)}, 'never-recorded')` },
      ]);
      // And one reads the second's status, which is Unknown from the sweep that withholds it.
      const watcher = await factoryOf(admin, [
        { key: 'up', formula: `status(${String(second)}) + 1` },
      ]);
      await factory.sweep();
      for (const id of [first, second, third, mixed, partly, watcher]) {
        assert.equal((await runtimeOf(id)).state, 'up', `sensor ${String(id)} starts Up`);
      }
      await stateTrigger('down');
      const downs = (): Promise<number> =>
        count(
          `SELECT count(*)::text AS n FROM sensor_state
           WHERE sensor_id = ANY($1::bigint[]) AND state IN ('down', 'warning')`,
          [[second, third, mixed]],
        );

      await revokeSources();
      try {
        ingested = [];
        await factory.sweep();
        assert.equal((await runtimeOf(first)).cause, 'access');
        for (const id of [second, third]) {
          assert.deepEqual(await runtimeOf(id), {
            state: 'unknown',
            cause: 'access',
            message: WITHHELD.upstream,
          });
        }
        assert.equal((await runtimeOf(mixed)).state, 'up');
        assert.deepEqual(
          ingested.filter((result) => result.sensorId === mixed).map((result) => result.outcome),
          ['ok'],
        );
        assert.ok(
          !ingested.some((result) => result.sensorId === second || result.sensorId === third),
        );
        assert.deepEqual(
          ingested.filter((result) => result.sensorId === partly).map((result) => result.outcome),
          ['error'],
        );
        assert.deepEqual(
          ingested.filter((result) => result.sensorId === watcher).map((result) => result.channels),
          [[{ key: 'up', value: 1 }]],
          'not up: withheld',
        );
        assert.equal(await downs(), 0, 'no Down, and no Warning on the way');
        await scheduler.sweep(new Date(Date.now() + 60_000));
        assert.equal(await requests(), 0);

        // A second sweep finds the same, and re-decides nothing.
        const history = (): Promise<number> =>
          count(`SELECT count(*)::text AS n FROM sensor_state WHERE sensor_id = $1`, [third]);
        const recorded = await history();
        await factory.sweep();
        assert.equal(await history(), recorded);
      } finally {
        await restoreSources();
      }

      await factory.sweep();
      for (const id of [first, second, third, mixed]) {
        assert.equal((await runtimeOf(id)).state, 'up', `sensor ${String(id)} is Up again`);
      }
      assert.equal(vouching?.withheld().size, 0);
    });

    it('withholds a factory over a sensor another sweep withholds, once its readings run out (M-23)', async () => {
      // A withheld Probe Health or Core Health is withheld by its own sweep, not this one.
      const reader = await factoryOf(admin, [
        { key: 'total', formula: `channel(${String(sourcePing)}, 'rtt')` },
      ]);
      await factory.sweep();
      assert.equal((await runtimeOf(reader)).state, 'up');

      await vouching?.settle('elsewhere', new Map([[sourcePing, WITHHELD.lostRead]]));
      await db.query(
        'DELETE FROM sample WHERE channel_id IN (SELECT id FROM channel WHERE sensor_id = $1)',
        [sourcePing],
      );
      try {
        await factory.sweep();
        assert.deepEqual(await runtimeOf(reader), {
          state: 'unknown',
          cause: 'access',
          message: WITHHELD.upstream,
        });
        // Paused, it is not swept, and a sweep with nothing to evaluate still lets it go.
        await h.service.pause(testActor, reader, { kind: 'indefinite' }, 'maintenance');
        await factory.sweep();
        assert.equal(vouching?.withheld().has(reader), false);
        await h.service.resume(testActor, reader);
      } finally {
        await vouching?.settle('elsewhere', NONE_WITHHELD);
        await db.query(
          `INSERT INTO sample (channel_id, time, value)
           SELECT id, now(), 12 FROM channel WHERE sensor_id = $1 AND key = 'rtt'`,
          [sourcePing],
        );
      }
      await factory.sweep();
      assert.equal((await runtimeOf(reader)).state, 'up');
    });

    // ── and what it notifies ───────────────────────────────────────────────────────────────

    it('turns a revoked read under twenty factories into no notification at all', async () => {
      // The orchestrating condition on `A-29`: one grant edit must not become one alarm per
      // sensor the account wrote. A Down trigger on the root is what an installation has.
      await stateTrigger('down');
      const sensors = await makeFactories(await as(analyst), 20);

      await factory.sweep();
      for (const id of sensors) assert.equal((await runtimeOf(id)).state, 'up');

      await revokeSources();
      try {
        await factory.sweep();
        for (const id of sensors) assert.equal((await runtimeOf(id)).cause, 'access');
        assert.equal(await scheduler.sweep(new Date(Date.now() + 3_600_000)), 0);
        assert.equal(await requests(), 0, 'not one notification for twenty withheld sensors');
      } finally {
        await restoreSources();
      }

      await factory.sweep();
      for (const id of sensors) assert.equal((await runtimeOf(id)).state, 'up');
      assert.equal(await scheduler.sweep(new Date(Date.now() + 3_600_000)), 0);
      assert.equal(await requests(), 0, 'and none when they came back');
    });

    it('suspends an alarm already sent rather than recovering it, and resumes it silently', async () => {
      // A Down sensor that stops being evaluated has not recovered, and "back to normal" would be
      // a false all-clear. When it is evaluated again and is still Down, the chain picks up
      // where it stopped: the same outage, not a second page.
      await stateTrigger('down');
      const sensors = await makeFactories(await as(analyst), 20);
      const now = Date.now();
      const failed = (at: number): SensorResult[] =>
        sensors.map((sensorId) => ({
          sensorId,
          at: new Date(at),
          outcome: 'error',
          message: 'the formula failed',
        }));
      // Twice, because the two-step rule takes a sensor through Warning first.
      await ingest(failed(now - 120_000));
      await ingest(failed(now - 60_000));
      assert.equal(await scheduler.sweep(new Date(now)), 20, 'the outage itself pages');
      assert.equal(await requests(), 20);

      await revokeSources();
      try {
        await factory.sweep();
        for (const id of sensors) assert.equal((await runtimeOf(id)).cause, 'access');
        assert.equal(await scheduler.sweep(new Date(now + 3_600_000)), 0);
        assert.equal(await requests(), 20, 'nothing more was queued');
        assert.equal(
          await count(
            `SELECT count(*)::text AS n FROM notification_request WHERE reason = 'recovery'`,
          ),
          0,
          'and in particular no recovery',
        );
        assert.equal(
          await count(`SELECT count(*)::text AS n FROM notification_alarm WHERE suppressed`),
          20,
          'every alarm stands, suspended',
        );
      } finally {
        await restoreSources();
      }

      // Released without being evaluated, so the last reading — a failure — decides.
      await vouching?.settle('factory', new Map());
      for (const id of sensors) assert.equal((await runtimeOf(id)).state, 'down');
      assert.equal(await scheduler.sweep(new Date(now + 7_200_000)), 0);
      assert.equal(await requests(), 20, 'the same outage, not a second page');
    });

    it('re-decides a factory crossing between what withholds and holds it once, with nothing on the way (M-28)', async () => {
      // Settled one set after another, a factory moving between two of them in one sweep was
      // re-decided in between with neither: its last reading, Up, a transition there and back,
      // and a notification on a trigger on Up.
      const probe = (
        await h.service.create(testActor, {
          kind: 'probe',
          parentId: h.rootId,
          name: `far-${String(process.hrtime.bigint())}`,
        })
      ).id;
      const box = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: probe,
          name: 'far-box',
          host: '192.0.2.9',
        })
      ).id;
      const far = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: box,
          name: 'far-ping',
          sensorType: 'icmp.ping',
        })
      ).id;
      await db.query(
        `INSERT INTO sample (channel_id, time, value)
         SELECT id, now(), 3 FROM channel WHERE sensor_id = $1 AND key = 'rtt'`,
        [far],
      );
      await ingest([{ sensorId: far, at: new Date(), outcome: 'ok', message: 'reachable' }]);
      // Its voucher's, then what it reads: `M-23`'s pair.
      const [refused] = await makeFactories(await as(analyst), 1);
      assert.ok(refused !== undefined);
      // What it reads, then its inputs' probe, and back: `M-26`'s.
      const both = await factoryOf(admin, [
        {
          key: 'total',
          formula: `channel(${String(sourcePing)}, 'rtt') + channel(${String(far)}, 'rtt')`,
        },
      ]);
      await factory.sweep();
      assert.equal((await runtimeOf(refused)).state, 'up');
      assert.equal((await runtimeOf(both)).state, 'up');
      await stateTrigger('up');
      await scheduler.sweep(new Date(Date.now() + 60_000));
      const quiet = await requests();
      const history = (id: number): Promise<number> =>
        count(`SELECT count(*)::text AS n FROM sensor_state WHERE sensor_id = $1`, [id]);

      await revokeSources();
      try {
        await factory.sweep();
        assert.deepEqual(await runtimeOf(refused), {
          state: 'unknown',
          cause: 'access',
          message: WITHHELD.lostRead,
        });
        assert.equal((await runtimeOf(both)).state, 'up', 'its voucher reads it all');
      } finally {
        await restoreSources();
      }

      // Its read back, and what it reads withheld by another sweep and out of readings: one
      // factory crosses from its voucher to what it reads, and the other goes Unknown for it.
      await vouching?.settle('elsewhere', new Map([[sourcePing, WITHHELD.lostRead]]));
      await db.query(
        'DELETE FROM sample WHERE channel_id IN (SELECT id FROM channel WHERE sensor_id = $1)',
        [sourcePing],
      );
      try {
        const sinceOf = async (id: number): Promise<number> => {
          const [row] = await db.query<{ since: Date }>(
            'SELECT since FROM sensor_runtime WHERE object_id = $1',
            [id],
          );
          assert.ok(row !== undefined);
          return row.since.getTime();
        };
        const before = await history(refused);
        const since = await sinceOf(refused);
        await factory.sweep();
        assert.deepEqual(await runtimeOf(refused), {
          state: 'unknown',
          cause: 'access',
          message: WITHHELD.upstream,
        });
        assert.equal(await history(refused), before, 'no transition, and no Up on the way');
        assert.equal(await sinceOf(refused), since, 'Unknown since its voucher was refused');
        assert.deepEqual(await runtimeOf(both), {
          state: 'unknown',
          cause: 'access',
          message: WITHHELD.upstream,
        });

        // The far probe lost, and its readings run out: withheld to held, once.
        await db.query(
          `UPDATE sensor_runtime SET state = 'unknown', cause = 'probe' WHERE object_id = $1`,
          [far],
        );
        await db.query(
          `UPDATE sample SET time = now() - interval '2 hours'
           WHERE channel_id IN (SELECT id FROM channel WHERE sensor_id = $1)`,
          [far],
        );
        let recorded = await history(both);
        await factory.sweep();
        assert.equal((await runtimeOf(both)).cause, 'probe');
        assert.equal(await history(both), recorded + 1, 'one transition, from access to probe');

        // Back and reporting: held to withheld, once.
        await db.query(
          `UPDATE sensor_runtime SET state = 'up', cause = 'scan', last_result_at = now()
           WHERE object_id = $1`,
          [far],
        );
        await db.query(
          `INSERT INTO sample (channel_id, time, value)
           SELECT id, now(), 4 FROM channel WHERE sensor_id = $1 AND key = 'rtt'`,
          [far],
        );
        recorded = await history(both);
        await factory.sweep();
        assert.deepEqual(await runtimeOf(both), {
          state: 'unknown',
          cause: 'access',
          message: WITHHELD.upstream,
        });
        assert.equal(await history(both), recorded + 1, 'one transition, from probe to access');

        await scheduler.sweep(new Date(Date.now() + 60_000));
        assert.equal(await requests(), quiet, 'no Up for either on the way');
      } finally {
        await vouching?.settle('elsewhere', NONE_WITHHELD);
        await db.query(
          `INSERT INTO sample (channel_id, time, value)
           SELECT id, now(), 12 FROM channel WHERE sensor_id = $1 AND key = 'rtt'`,
          [sourcePing],
        );
      }
      await factory.sweep();
      assert.equal((await runtimeOf(both)).state, 'up');
      assert.equal((await runtimeOf(refused)).state, 'up');
    });

    it('notifies through a trigger on Unknown, as a lost probe does', async () => {
      // The operator who asked to hear about Unknown hears about this too — once per sensor,
      // which the template's summary window turns into one message and a digest, exactly as it
      // does when a probe's sensors all go Unknown together.
      const sensors = await makeFactories(await as(analyst), 5);
      await factory.sweep();
      await stateTrigger('unknown');

      await revokeSources();
      try {
        await factory.sweep();
        assert.equal(await scheduler.sweep(new Date(Date.now() + 60_000)), sensors.length);
        assert.equal(await requests(), sensors.length);
      } finally {
        await restoreSources();
      }
    });
  },
);

/** The database, counting every query made on it outside a transaction. */
function countingQueries(db: Database, counted: () => void): SensorVouchingOptions['db'] {
  return {
    query<T extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<T[]> {
      counted();
      return db.query<T>(text, values);
    },
    tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      return db.tx(fn);
    },
  };
}
