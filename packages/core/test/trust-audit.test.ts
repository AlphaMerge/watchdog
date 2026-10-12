import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { PROTOCOL_VERSION } from '@ms/shared';
import type { Database, Queryable } from '../src/db/pool.js';
import { DatabaseAuditSink } from '../src/audit/store.js';
import type { Actor, AuditSink, Mutation } from '../src/objects/audit.js';
import { ProbeRegistry } from '../src/probes/registry.js';
import { DiscoveryService, type DispatchMessage } from '../src/discovery/service.js';
import { RediscoveryService } from '../src/discovery/rediscovery.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/**
 * What the audit log says about probe trust and discovery (`A-20`).
 *
 * `audit-sweep.test.ts` proves each route writes an entry and names its caller. This says what
 * the entries hold — a probe by the facts somebody decided on and never by a key, a discovery's
 * community as present or absent and never as itself — and that each is written in the change's
 * own transaction, so a decision that rolls back leaves no entry and reaches no connection.
 */

interface Row {
  action: string;
  object_id: string | null;
  actor_kind: string;
  actor_label: string;
  summary: Record<string, unknown>;
  diff: { field: string; before: unknown; after: unknown }[];
}

/** Records, then fails: the change it rides with must roll back, and take the row with it. */
class FailsAfterRecording implements AuditSink {
  readonly #inner = new DatabaseAuditSink();
  failOn: string | null = null;

  async record(q: Queryable, actor: Actor, mutations: readonly Mutation[], at: Date) {
    await this.#inner.record(q, actor, mutations, at);
    if (mutations.some((mutation) => mutation.action === this.failOn)) {
      throw new Error(`failing after recording ${String(this.failOn)}`);
    }
  }
}

const COMMUNITY = 'trust-audit-community-51c9';

describe(
  'probe trust and discovery in the audit log',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let sink: FailsAfterRecording;
    let registry: ProbeRegistry;
    let discovery: DiscoveryService;
    let rediscovery: RediscoveryService;
    let actor: Actor;
    let userId = 0;
    let groupId = 0;
    let probeObjectId = 0;
    let now = new Date('2026-08-31T02:00:00Z');
    const closed: string[] = [];
    const sent: DispatchMessage[] = [];
    let seq = 0;

    const next = (prefix: string): string => {
      seq += 1;
      return `${prefix}-${String(seq)}`;
    };

    const rows = async (where: string, values: unknown[]): Promise<Row[]> =>
      db.query<Row>(
        `SELECT action, object_id, actor_kind, actor_label, summary, diff
         FROM audit_log WHERE ${where} ORDER BY id`,
        values,
      );

    /** Every row, as text: what a backup of the table would hold. */
    const anywhere = async (needle: string): Promise<string[]> =>
      (
        await db.query<{ action: string }>(
          `SELECT action FROM audit_log
           WHERE summary::text LIKE '%' || $1 || '%' OR diff::text LIKE '%' || $1 || '%'`,
          [needle],
        )
      ).map((row) => row.action);

    /** A probe that has connected and waits in the queue. */
    const pending = async (): Promise<string> => {
      const gid = next('gid');
      await registry.admit({
        gid,
        displayName: `backup-${gid}`,
        agentVersion: '0.1.0',
        protocolVersion: PROTOCOL_VERSION,
        accessKey: 'shared-key',
        remoteAddress: '10.4.2.9',
        certificate: null,
      });
      return gid;
    };

    const probeObject = async (): Promise<number> =>
      (
        await harness.service.create(testActor, {
          kind: 'probe',
          parentId: harness.rootId,
          name: next('probe'),
        })
      ).id;

    before(async () => {
      scratch = await createScratchDatabase('trustaudit');
      db = scratch.db;
      harness = await buildHarness(db);
      sink = new FailsAfterRecording();
      registry = new ProbeRegistry({
        db,
        audit: sink,
        logger: silent,
        enrolmentKeys: ['shared-key'],
      });
      registry.attach({
        disconnect: (gid) => {
          closed.push(gid);
          return true;
        },
        withdraw: () => false,
        remoteAddressOf: () => null,
      });
      discovery = new DiscoveryService({
        db,
        audit: sink,
        logger: silent,
        dispatch: (_probeId, message) => {
          sent.push(message);
          return { kind: 'sent' };
        },
      });
      rediscovery = new RediscoveryService({
        db,
        audit: sink,
        logger: silent,
        discovery,
        windowFor: () => Promise.resolve(null),
        now: () => now,
      });

      const user = await db.query<{ id: string }>(
        `INSERT INTO user_account (login, display_name, password_hash, role)
         VALUES ('warden', 'warden', 'x', 'admin') RETURNING id`,
      );
      userId = Number(user[0]?.id);
      actor = { kind: 'user', userId, login: 'warden' };

      probeObjectId = await probeObject();
      groupId = (
        await harness.service.create(testActor, {
          kind: 'group',
          parentId: probeObjectId,
          name: 'Datacentre',
        })
      ).id;
    });

    after(async () => {
      await scratch.drop();
    });

    describe('probe trust', () => {
      it('records an approval by what was decided on, and who decided it', async () => {
        const gid = await pending();
        const objectId = await probeObject();
        await registry.approve(gid, objectId, actor);

        const [entry] = await rows(`action = 'probe.approved' AND summary->>'gid' = $1`, [gid]);
        assert.ok(entry !== undefined);
        assert.equal(entry.object_id, String(objectId), 'in the probe object’s own history');
        assert.equal(entry.actor_label, 'warden');
        assert.deepEqual(entry.summary, {
          gid,
          name: `backup-${gid}`,
          address: '10.4.2.9',
          local: false,
        });
        assert.deepEqual(
          entry.diff.map((change) => [change.field, change.before, change.after]),
          [
            ['probe.status', 'pending', 'approved'],
            ['probe.objectId', null, objectId],
          ],
        );
        // `decided_by` was a column nothing filled: the route never passed who decided.
        const [decided] = await db.query<{ decided_by: string | null }>(
          `SELECT decided_by::text AS decided_by FROM probe_registration WHERE gid = $1`,
          [gid],
        );
        assert.equal(decided?.decided_by, String(userId));
      });

      it('never records a key: not the enrolment key, not its own, not the hash of one', async () => {
        const gid = await pending();
        await registry.approve(gid, await probeObject(), actor);
        // The key is minted at the handshake after approval, which is the moment it exists.
        const welcome = await registry.admit({
          gid,
          displayName: `backup-${gid}`,
          agentVersion: '0.1.0',
          protocolVersion: PROTOCOL_VERSION,
          accessKey: 'shared-key',
          remoteAddress: '10.4.2.9',
          certificate: null,
        });
        assert.ok(welcome.kind === 'approved' && welcome.issuedKey !== undefined);
        await registry.revoke(gid, 'decommissioned', actor);

        const [stored] = await db.query<{ hash: string | null }>(
          `SELECT access_key_hash AS hash FROM probe_registration WHERE gid = $1`,
          [gid],
        );
        assert.deepEqual(await anywhere(welcome.issuedKey), []);
        assert.deepEqual(await anywhere('shared-key'), []);
        if (stored?.hash != null) assert.deepEqual(await anywhere(stored.hash), []);
      });

      it('records a revoke with the branch it released and the reason given', async () => {
        const gid = await pending();
        const objectId = await probeObject();
        await registry.approve(gid, objectId, actor);
        await registry.revoke(gid, 'replaced by web-dc4', actor);

        const [entry] = await rows(`action = 'probe.revoked' AND summary->>'gid' = $1`, [gid]);
        assert.equal(entry?.object_id, String(objectId));
        assert.deepEqual(
          entry.diff.map((change) => [change.field, change.before, change.after]),
          [
            ['probe.status', 'approved', 'revoked'],
            ['probe.note', '', 'replaced by web-dc4'],
          ],
        );
      });

      it('records an address filter that moved, and nothing for one saved unchanged', async () => {
        const gid = await pending();
        await registry.setAllowFrom(gid, ['10.0.0.0/24', '10.1.0.0/24'], actor);
        await registry.setAllowFrom(gid, ['10.0.0.0/24', '10.1.0.0/24'], actor);
        await registry.setAllowFrom(gid, [], actor);

        const entries = await rows(`action = 'probe.allowFrom.set' AND summary->>'gid' = $1`, [
          gid,
        ]);
        assert.deepEqual(
          entries.map((row) => [row.diff[0]?.before, row.diff[0]?.after]),
          [
            ['', '10.0.0.0/24, 10.1.0.0/24'],
            ['10.0.0.0/24, 10.1.0.0/24', ''],
          ],
        );
      });

      it('records a probe forgotten, with what was known about it', async () => {
        const gid = await pending();
        assert.equal(await registry.remove(gid, actor), true);
        assert.equal(await registry.remove(gid, actor), false);

        const entries = await rows(`action = 'probe.deleted' AND summary->>'gid' = $1`, [gid]);
        assert.equal(entries.length, 1, 'once, for the delete that found something');
        assert.equal(entries[0]?.summary['address'], '10.4.2.9');
      });
    });

    describe('discovery', () => {
      it('records a run: who started it, where, and that a community was given', async () => {
        const run = await discovery.start(
          { groupId, probeId: probeObjectId, range: '10.0.0.0/29', snmpCommunity: COMMUNITY },
          actor,
        );
        const [entry] = await rows(
          `action = 'discovery.started' AND (summary->>'runId')::bigint = $1`,
          [run.id],
        );
        assert.ok(entry !== undefined);
        assert.equal(entry.object_id, String(groupId), 'in the history of the group it fills');
        assert.equal(entry.actor_label, 'warden');
        assert.equal(entry.summary['range'], '10.0.0.0/29');
        assert.equal(entry.summary['community'], true);
        assert.equal(entry.summary['scheduleId'], null);
        assert.deepEqual(await anywhere(COMMUNITY), []);
        // And the run says so itself: `created_by` existed from migration 025 and was never set.
        const [created] = await db.query<{ created_by: string | null }>(
          `SELECT created_by::text AS created_by FROM discovery_run WHERE id = $1`,
          [run.id],
        );
        assert.equal(created?.created_by, String(userId));
      });

      it('records a cancel, and nothing for a run that had already stopped', async () => {
        const run = await discovery.start(
          { groupId, probeId: probeObjectId, range: '10.0.1.0/29' },
          actor,
        );
        assert.ok((await discovery.cancel(run.id, actor)) !== null);
        assert.equal(await discovery.cancel(run.id, actor), null);

        const entries = await rows(
          `action = 'discovery.cancelled' AND (summary->>'runId')::bigint = $1`,
          [run.id],
        );
        assert.equal(entries.length, 1);
        assert.equal(entries[0]?.actor_label, 'warden');
      });

      it('records a schedule’s life, never its community, and a run it started as the system’s', async () => {
        const schedule = await rediscovery.create(
          {
            groupId,
            probeId: probeObjectId,
            name: 'Nightly',
            range: '10.0.2.0/29',
            cadence: 'daily',
            cadenceMinute: 3 * 60,
            timezone: 'UTC',
            snmpCommunity: COMMUNITY,
          },
          actor,
        );
        await rediscovery.setEnabled(schedule.id, true, actor);
        // The same state again rebooks the next run and changes nothing anybody looks for.
        await rediscovery.setEnabled(schedule.id, true, actor);
        now = new Date('2026-08-31T03:00:00Z');
        assert.equal(await rediscovery.tick(), 1);
        assert.equal(await rediscovery.remove(schedule.id, actor), true);

        const entries = await rows(
          `action LIKE 'discovery.%' AND (summary->>'scheduleId')::bigint = $1`,
          [schedule.id],
        );
        assert.deepEqual(
          entries.map((row) => [row.action, row.actor_kind]),
          [
            ['discovery.schedule.created', 'user'],
            ['discovery.schedule.updated', 'user'],
            ['discovery.started', 'system'],
            ['discovery.schedule.deleted', 'user'],
          ],
        );
        const created = entries[0];
        assert.ok(created !== undefined);
        assert.ok(
          created.diff.some(
            (change) => change.field === 'discovery.schedule.community' && change.after === true,
          ),
        );
        assert.ok(
          created.diff.some(
            (change) =>
              change.field === 'discovery.schedule.cadence' &&
              change.after === 'every day at 03:00',
          ),
          JSON.stringify(created.diff),
        );
        assert.deepEqual(
          entries[1]?.diff.map((change) => [change.field, change.before, change.after]),
          [['discovery.schedule.enabled', false, true]],
        );
        assert.deepEqual(await anywhere(COMMUNITY), []);
      });
    });

    describe('in the transaction, so a change that fails takes its entry with it', () => {
      it('leaves a probe pending, unbound and connected when its approval fails', async () => {
        const gid = await pending();
        const objectId = await probeObject();
        closed.length = 0;
        sink.failOn = 'probe.approved';
        try {
          await assert.rejects(() => registry.approve(gid, objectId, actor), /failing after/);
        } finally {
          sink.failOn = null;
        }
        assert.equal((await registry.get(gid))?.status, 'pending');
        assert.deepEqual(
          await db.query(`SELECT 1 FROM probe_config WHERE gid = $1`, [gid]),
          [],
          'the branch was not bound',
        );
        assert.deepEqual(
          await rows(`action = 'probe.approved' AND summary->>'gid' = $1`, [gid]),
          [],
        );
        // The connection is closed after the commit, so a decision that rolled back closes none.
        assert.deepEqual(closed, []);
      });

      it('leaves no run and offers the probe nothing when starting one fails', async () => {
        sent.length = 0;
        sink.failOn = 'discovery.started';
        try {
          await assert.rejects(
            () => discovery.start({ groupId, probeId: probeObjectId, range: '10.0.9.0/29' }, actor),
            /failing after/,
          );
        } finally {
          sink.failOn = null;
        }
        assert.deepEqual(
          await db.query(`SELECT 1 FROM discovery_run WHERE range_text = '10.0.9.0/29'`),
          [],
        );
        assert.deepEqual(
          await rows(`action = 'discovery.started' AND summary->>'range' = '10.0.9.0/29'`, []),
          [],
          'an entry for a run that never existed',
        );
        assert.deepEqual(sent, []);
      });

      it('leaves no schedule when creating one fails', async () => {
        sink.failOn = 'discovery.schedule.created';
        try {
          await assert.rejects(
            () =>
              rediscovery.create(
                {
                  groupId,
                  probeId: probeObjectId,
                  name: 'rolled-back',
                  range: '10.0.8.0/29',
                  cadence: 'daily',
                },
                actor,
              ),
            /failing after/,
          );
        } finally {
          sink.failOn = null;
        }
        assert.deepEqual(
          await db.query(`SELECT 1 FROM discovery_schedule WHERE name = 'rolled-back'`),
          [],
        );
        assert.deepEqual(
          await rows(
            `action = 'discovery.schedule.created' AND summary->>'name' = 'rolled-back'`,
            [],
          ),
          [],
        );
      });
    });
  },
);
