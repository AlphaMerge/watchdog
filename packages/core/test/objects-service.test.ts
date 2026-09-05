import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ObjectError } from '../src/objects/errors.js';
import type { ObjectId } from '../src/objects/types.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

const INTERVAL = 'scan.intervalSeconds';

describe(
  'ObjectService',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let h: Harness;
    let probeId: ObjectId;

    before(async () => {
      scratch = await createScratchDatabase('objsvc');
      h = await buildHarness(scratch.db);
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      // A fresh probe per test keeps each one independent without rebuilding the schema.
      await scratch.db.query("DELETE FROM object WHERE kind <> 'root'");
      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'Local probe',
      });
      probeId = probe.id;
      h.audit.recorded.length = 0;
    });

    const group = async (parentId: ObjectId, name: string): Promise<ObjectId> =>
      (await h.service.create(testActor, { kind: 'group', parentId, name })).id;

    const device = async (parentId: ObjectId, name: string, host = '10.0.0.1'): Promise<ObjectId> =>
      (await h.service.create(testActor, { kind: 'device', parentId, name, host })).id;

    const sensor = async (parentId: ObjectId, name: string): Promise<ObjectId> =>
      (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId,
          name,
          sensorType: 'icmp.ping',
        })
      ).id;

    // ── create ────────────────────────────────────────────────────────────────────────────

    describe('create', () => {
      it('creates each kind under a legal parent', async () => {
        const g = await group(probeId, 'Datacentre');
        const d = await h.service.create(testActor, {
          kind: 'device',
          parentId: g,
          name: 'switch-01',
          host: '192.0.2.10',
          ipVersion: 'v4',
        });
        const s = await h.service.create(testActor, {
          kind: 'sensor',
          parentId: d.id,
          name: 'Ping',
          sensorType: 'icmp.ping',
          params: { count: 4 },
        });

        assert.equal(d.kind, 'device');
        assert.equal(d.host, '192.0.2.10');
        assert.equal(d.ipVersion, 'v4');
        assert.equal(s.kind, 'sensor');
        assert.equal(s.sensorType, 'icmp.ping');
        assert.deepEqual(s.params, { count: 4 });
        // A kind with a side table is at version 2 straight away: writing sensor_config fires
        // the trigger that invalidates the owner's ETag. What matters is that the version the
        // create returned is the one a subsequent read agrees with.
        assert.equal((await h.service.get(s.id)).version, s.version);
      });

      it('refuses an illegal parent kind, naming both kinds', async () => {
        const g = await group(probeId, 'Group');
        const error = await rejects(() =>
          h.service.create(testActor, {
            kind: 'sensor',
            parentId: g,
            name: 'Orphan',
            sensorType: 'icmp.ping',
          }),
        );

        assert.equal(error.code, 'OBJECT_PARENT_INVALID');
        assert.equal(error.status, 409);
        assert.deepEqual(error.details, { childKind: 'sensor', parentKind: 'group' });
      });

      it('reports a missing parent as 404, not 409', async () => {
        const error = await rejects(() =>
          h.service.create(testActor, { kind: 'group', parentId: 999_999, name: 'Nowhere' }),
        );
        assert.equal(error.code, 'OBJECT_PARENT_NOT_FOUND');
        assert.equal(error.status, 404);
      });

      it('rejects a malformed sensor type before touching the database', async () => {
        const d = await device(probeId, 'dev');
        for (const bad of ['SNMP.Traffic', 'traffic', 'a..b', '']) {
          const error = await rejects(() =>
            h.service.create(testActor, {
              kind: 'sensor',
              parentId: d,
              name: 'Bad',
              sensorType: bad,
            }),
          );
          assert.equal(error.code, 'OBJECT_INVALID', `expected rejection for "${bad}"`);
        }
      });

      it('records one audit entry per create', async () => {
        await group(probeId, 'Audited');
        assert.equal(h.audit.recorded.length, 1);
        assert.equal(h.audit.recorded[0]?.action, 'object.created');
      });

      it('hands back a sensor version its own first write can use (P-29)', async () => {
        // **The trap this guards.** Declaring a sensor's channels bumps the owner's version by
        // trigger, so a version read before the channels exist is stale the moment it is
        // returned — and a caller doing the obvious thing, creating a sensor and immediately
        // updating it with the version it was just given, would get a 412 it could not explain.
        //
        // `create` used to read the object early and patch the version in from a second read.
        // It now reads once, after the writes. This test does not care which: it asserts the
        // property both were for, so the next person to reorder that path finds out here.
        const d = await device(probeId, 'switch-02');
        const created = await h.service.create(testActor, {
          kind: 'sensor',
          parentId: d,
          name: 'Ping',
          sensorType: 'icmp.ping',
          params: { count: 4 },
        });

        const [row] = await scratch.db.query<{ version: number }>(
          'SELECT version FROM object WHERE id = $1',
          [created.id],
        );
        assert.equal(created.version, row?.version, 'the version returned is the version stored');

        // And the property that actually matters to a caller: it works as a precondition.
        const updated = await h.service.update(
          testActor,
          created.id,
          { kind: 'sensor', name: 'Ping, renamed' },
          { kind: 'version', expected: created.version },
        );
        assert.equal(updated.name, 'Ping, renamed');
      });
    });

    // ── version / ETag ────────────────────────────────────────────────────────────────────

    describe('optimistic concurrency', () => {
      it('bumps the version on update and rejects a stale precondition', async () => {
        const g = await group(probeId, 'Versioned');
        const first = await h.service.update(
          testActor,
          g,
          { kind: 'group', name: 'Renamed' },
          { kind: 'version', expected: 1 },
        );
        assert.equal(first.version, 2);

        const error = await rejects(() =>
          h.service.update(
            testActor,
            g,
            { kind: 'group', name: 'Later' },
            { kind: 'version', expected: 1 },
          ),
        );
        assert.equal(error.code, 'OBJECT_VERSION_CONFLICT');
        assert.equal(error.status, 412);
        assert.deepEqual(error.details, { expected: 1, actual: 2 });

        // A refused update leaves the row untouched.
        assert.equal((await h.service.get(g)).name, 'Renamed');
      });

      it('bumps the version when a setting is overridden or reverted', async () => {
        // The ETag has to mean "the state the form was rendered from", and a settings form
        // renders inherited values that do not live on the object row.
        const g = await group(probeId, 'Settings');
        const initial = (await h.service.get(g)).version;

        await h.service.setSetting(testActor, g, INTERVAL, 300);
        const afterSet = (await h.service.get(g)).version;
        assert.ok(afterSet > initial, 'setting an override must invalidate the ETag');

        await h.service.clearSetting(testActor, g, INTERVAL);
        const afterClear = (await h.service.get(g)).version;
        assert.ok(afterClear > afterSet, 'reverting to inherit must invalidate it too');
      });

      it('applies a patch that touches only a side table, and honours its ETag', async () => {
        // Regression: the version was asserted *after* the side-table write, and that write
        // fires the trigger that bumps it — so every host-only or params-only patch failed
        // 412 against its own fresh ETag, making a device's address unchangeable.
        const d = await h.service.create(testActor, {
          kind: 'device',
          parentId: probeId,
          name: 'switch-01',
          host: '10.0.0.1',
        });

        const updated = await h.service.update(
          testActor,
          d.id,
          { kind: 'device', host: '10.0.0.9', ipVersion: 'v4' },
          { kind: 'version', expected: d.version },
        );

        assert.equal(updated.kind, 'device');
        assert.equal(updated.host, '10.0.0.9');
        assert.equal(updated.ipVersion, 'v4');
        assert.ok(updated.version > d.version, 'and the ETag moves on');
      });

      it('applies a params-only patch to a sensor', async () => {
        const dev = await h.service.create(testActor, {
          kind: 'device',
          parentId: probeId,
          name: 'switch-01',
          host: '10.0.0.1',
        });
        const s = await h.service.create(testActor, {
          kind: 'sensor',
          parentId: dev.id,
          name: 'Ping',
          sensorType: 'icmp.ping',
          params: { count: 4 },
        });

        const updated = await h.service.update(
          testActor,
          s.id,
          { kind: 'sensor', params: { count: 10 } },
          { kind: 'version', expected: s.version },
        );

        assert.equal(updated.kind, 'sensor');
        assert.deepEqual(updated.params, { count: 10 });
      });

      it('refuses a stale side-table-only patch and changes nothing', async () => {
        const d = await h.service.create(testActor, {
          kind: 'device',
          parentId: probeId,
          name: 'switch-01',
          host: '10.0.0.1',
        });

        const error = await rejects(() =>
          h.service.update(
            testActor,
            d.id,
            { kind: 'device', host: '10.0.0.9' },
            { kind: 'version', expected: d.version - 1 },
          ),
        );

        assert.equal(error.code, 'OBJECT_VERSION_CONFLICT');
        const after = await h.service.get(d.id);
        assert.equal(after.kind === 'device' ? after.host : '', '10.0.0.1', 'no partial write');
      });

      it('refuses a patch whose kind does not match the stored object', async () => {
        const g = await group(probeId, 'Group');
        const error = await rejects(() =>
          h.service.update(
            testActor,
            g,
            { kind: 'device', host: 'nope' },
            { kind: 'version', expected: 1 },
          ),
        );
        assert.equal(error.code, 'OBJECT_KIND_MISMATCH');
        assert.deepEqual(error.details, { bodyKind: 'device', storedKind: 'group' });
      });
    });

    // ── move ──────────────────────────────────────────────────────────────────────────────

    describe('move', () => {
      it('refuses a direct and a transitive cycle, leaving the tree untouched', async () => {
        const a = await group(probeId, 'A');
        const b = await group(a, 'B');
        const c = await group(b, 'C');
        const d = await group(c, 'D');

        for (const target of [b, c, d, a]) {
          const error = await rejects(() => h.service.move(testActor, a, target, { kind: 'none' }));
          assert.equal(error.code, 'OBJECT_CYCLE', `moving A under ${String(target)}`);
          assert.equal(error.status, 409);
          assert.ok(Array.isArray(error.details['path']));
        }

        assert.equal((await h.service.get(a)).parentId, probeId, 'no partial write');
      });

      it('re-resolves inheritance and reports what changed', async () => {
        const fast = await group(probeId, 'Fast');
        const slow = await group(probeId, 'Slow');
        await h.service.setSetting(testActor, fast, INTERVAL, 30);
        await h.service.setSetting(testActor, slow, INTERVAL, 600);

        const d = await device(fast, 'switch-01');
        const s = await sensor(d, 'Ping');

        const result = await h.service.move(testActor, d, slow, { kind: 'none' });

        const change = result.settingsChanged.find((c) => c.key === INTERVAL);
        assert.ok(change !== undefined, 'the move must report the interval change');
        assert.equal(change.before.value, 30);
        assert.equal(change.before.source.kind, 'inherited');
        assert.equal(change.after.value, 600);

        // The descendant re-resolves too, with nothing written to object_setting.
        const sensorSetting = await h.resolver.resolve<number>(s, INTERVAL);
        assert.equal(sensorSetting.value, 600);
        assert.deepEqual(await h.resolver.own(s), {});
      });

      it('leaves a descendant with its own override alone', async () => {
        const fast = await group(probeId, 'Fast');
        const slow = await group(probeId, 'Slow');
        await h.service.setSetting(testActor, fast, INTERVAL, 30);
        await h.service.setSetting(testActor, slow, INTERVAL, 600);

        const d = await device(fast, 'switch-01');
        const s = await sensor(d, 'Ping');
        await h.service.setSetting(testActor, s, INTERVAL, 5);

        await h.service.move(testActor, d, slow, { kind: 'none' });

        const resolved = await h.resolver.resolve<number>(s, INTERVAL);
        assert.equal(resolved.value, 5);
        assert.equal(resolved.source.kind, 'own');
      });

      it('reports a credential that stops being inherited', async () => {
        // WORKFLOW.MD §1: credentials are set high in the tree. Moving a device out of the
        // group holding its SNMP community is the classic support ticket.
        const withCreds = await group(probeId, 'Has credentials');
        const without = await group(probeId, 'Has none');
        await scratch.db.query(
          `INSERT INTO credential_set (object_id, kind, public_params, secret, key_id)
           VALUES ($1, 'snmp', '{"version":"v2c"}'::jsonb, $2, 'key-1')`,
          [withCreds, Buffer.from('ciphertext')],
        );

        const d = await device(withCreds, 'switch-01');
        const result = await h.service.move(testActor, d, without, { kind: 'none' });

        assert.deepEqual(result.credentialsChanged, [
          { kind: 'snmp', before: 'inherited', after: 'none' },
        ]);
      });

      it('is idempotent when the target is already the parent', async () => {
        const g = await group(probeId, 'Stationary');
        const before = await h.service.get(g);
        h.audit.recorded.length = 0;

        const result = await h.service.move(testActor, g, probeId, { kind: 'none' });

        assert.deepEqual(result.settingsChanged, []);
        assert.equal(result.probeChanged, null);
        assert.equal((await h.service.get(g)).version, before.version, 'no version bump');
        assert.equal(h.audit.recorded.length, 0, 'and no audit entry');
      });

      it('refuses to move the root, and refuses an illegal target kind', async () => {
        const g = await group(probeId, 'Group');
        const d = await device(g, 'dev');

        assert.equal(
          (await rejects(() => h.service.move(testActor, h.rootId, probeId, { kind: 'none' })))
            .code,
          'OBJECT_NOT_MOVABLE',
        );
        assert.equal(
          (await rejects(() => h.service.move(testActor, probeId, g, { kind: 'none' }))).code,
          'OBJECT_PARENT_INVALID',
        );
        assert.equal(
          (await rejects(() => h.service.move(testActor, d, 999_999, { kind: 'none' }))).code,
          'OBJECT_PARENT_NOT_FOUND',
        );
      });

      it('moves a subtree with one row update and keeps descendant versions valid', async () => {
        const from = await group(probeId, 'From');
        const to = await group(probeId, 'To');
        const d = await device(from, 'switch-01');
        const s = await sensor(d, 'Ping');
        const sensorVersion = (await h.service.get(s)).version;

        const result = await h.service.move(testActor, d, to, { kind: 'none' });

        assert.equal(result.movedCount, 2, 'the device and its sensor');
        assert.equal(
          (await h.service.get(s)).version,
          sensorVersion,
          'no descendant row changes, so descendant ETags stay valid',
        );
      });

      it('reports a cross-probe move', async () => {
        const other = await h.service.create(testActor, {
          kind: 'probe',
          parentId: h.rootId,
          name: 'Branch probe',
        });
        const d = await device(probeId, 'switch-01');

        const result = await h.service.move(testActor, d, other.id, { kind: 'none' });

        const changed = result.probeChanged;
        assert.ok(changed !== null);
        assert.ok(changed.from !== null && changed.to !== null);
        assert.equal(changed.from.id, probeId);
        assert.equal(changed.to.id, other.id);
      });
    });

    // ── clone ─────────────────────────────────────────────────────────────────────────────

    describe('clone', () => {
      const buildSubtree = async (parentId: ObjectId): Promise<ObjectId> => {
        const g = await group(parentId, 'Berlin DC');
        const rack = await group(g, 'Rack 4');
        const d1 = await device(rack, 'switch-01', '10.1.0.1');
        const d2 = await device(rack, 'switch-02', '10.1.0.2');
        // No channel is inserted by hand any more: since P-05 the sensor type declares them,
        // so each of these two sensors arrives with `rtt` and `loss` already attached.
        await sensor(d1, 'Ping');
        await sensor(d2, 'Ping');
        await h.service.setSetting(testActor, d1, INTERVAL, 120);
        return g;
      };

      it('copies the triggers, so a clone behind the fence still notifies somebody', async () => {
        // **`P-141`.** The clone already copied `inherits_triggers` — a clone of a lab device is
        // still a lab device — and copied none of the triggers the fence exists to protect. A
        // cloned object with the fence up inherited nothing and owned nothing: it notified
        // *nobody*, silently, and looked identical to one that worked.
        const source = await buildSubtree(probeId);
        await scratch.db.query(`UPDATE object SET inherits_triggers = false WHERE id = $1`, [
          source,
        ]);
        await scratch.db.query(
          `INSERT INTO notification_trigger (object_id, kind, settings)
           VALUES ($1, 'state', '{"state":"down","initialTemplateId":1}'::jsonb)`,
          [source],
        );

        const result = await h.service.clone(testActor, source, {});

        assert.equal(result.clonedCount.trigger, 1);
        const copied = await scratch.db.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM notification_trigger WHERE object_id = $1',
          [result.object.id],
        );
        assert.equal(copied[0]?.n, '1', 'the clone has the trigger the fence was protecting');
      });

      it('copies the whole subtree with new ids, leaving the source untouched', async () => {
        const source = await buildSubtree(probeId);
        const target = await group(probeId, 'Target');

        const result = await h.service.clone(testActor, source, { targetParentId: target });

        assert.equal(result.clonedCount.total, 6, '2 groups + 2 devices + 2 sensors');
        assert.equal(result.clonedCount.group, 2);
        assert.equal(result.clonedCount.device, 2);
        assert.equal(result.clonedCount.sensor, 2);
        assert.equal(result.clonedCount.channel, 4, '2 sensors x 2 declared channels');
        assert.equal(result.clonedCount.setting, 1);
        assert.notEqual(result.object.id, source);
        assert.equal(result.object.name, 'Clone of Berlin DC');

        // Descendants keep their own names — renaming a whole subtree surprises nobody well.
        const cloned = await h.service.subtree(result.object.id, { maxDepth: 10, limit: 100 });
        const names = cloned.items.map((i) => i.name).sort();
        assert.deepEqual(names, [
          'Clone of Berlin DC',
          'Ping',
          'Ping',
          'Rack 4',
          'switch-01',
          'switch-02',
        ]);

        const sourceStillThere = await h.service.subtree(source, { maxDepth: 10, limit: 100 });
        assert.equal(sourceStillThere.items.length, 6);
      });

      it('copies own settings only, so the clone re-resolves under its new parent', async () => {
        const fast = await group(probeId, 'Fast');
        const slow = await group(probeId, 'Slow');
        await h.service.setSetting(testActor, fast, INTERVAL, 30);
        await h.service.setSetting(testActor, slow, INTERVAL, 900);

        const d = await device(fast, 'switch-01');
        const result = await h.service.clone(testActor, d, { targetParentId: slow });

        // Nothing of its own was set, so nothing was copied...
        assert.deepEqual(await h.resolver.own(result.object.id), {});
        // ...and it now inherits from its new parent.
        const resolved = await h.resolver.resolve<number>(result.object.id, INTERVAL);
        assert.equal(resolved.value, 900);
        assert.equal(resolved.source.kind, 'inherited');

        const change = result.settingsChanged.find((c) => c.key === INTERVAL);
        assert.ok(change !== undefined);
        assert.equal(change.before.value, 30);
        assert.equal(change.after.value, 900);
      });

      it('never copies a credential, and says which kinds it dropped', async () => {
        const source = await group(probeId, 'Source');
        const d = await device(source, 'switch-01');
        await scratch.db.query(
          `INSERT INTO credential_set (object_id, kind, public_params, secret, key_id)
           VALUES ($1, 'snmp', '{"version":"v2c"}'::jsonb, $2, 'key-1')`,
          [d, Buffer.from('SECRET-CANARY')],
        );

        const result = await h.service.clone(testActor, source, {});

        assert.deepEqual(result.droppedCredentialKinds, ['snmp']);

        const rows = await scratch.db.query<{ count: string }>(
          'SELECT count(*) AS count FROM credential_set WHERE secret = $1',
          [Buffer.from('SECRET-CANARY')],
        );
        assert.equal(rows[0]?.count, '1', 'the ciphertext exists in exactly one place');
      });

      it('gives cloned channels new ids, so a clone has no history', async () => {
        const d = await device(probeId, 'switch-01');
        const s = await sensor(d, 'Traffic');
        // The channels come from the sensor type now, primary flag and all.
        const sourceChannels = await h.service.channels(s);
        assert.deepEqual(
          sourceChannels.map((channel) => channel.key),
          ['rtt', 'loss'],
        );

        const result = await h.service.clone(testActor, s, {});
        const clonedChannels = await h.service.channels(result.object.id);

        assert.deepEqual(
          clonedChannels.map((channel) => channel.key),
          ['rtt', 'loss'],
        );
        const cloned = clonedChannels[0];
        const original = sourceChannels[0];
        assert.ok(cloned !== undefined && original !== undefined);
        assert.equal(cloned.key, 'rtt');
        assert.notEqual(cloned.id, original.id, 'a new id means no inherited history');
        assert.equal(cloned.isPrimary, true, 'and the clone is still judged by the same channel');
      });

      it('refuses to clone the root or a probe', async () => {
        assert.equal(
          (await rejects(() => h.service.clone(testActor, h.rootId, {}))).code,
          'OBJECT_NOT_CLONEABLE',
        );
        assert.equal(
          (await rejects(() => h.service.clone(testActor, probeId, {}))).code,
          'OBJECT_NOT_CLONEABLE',
        );
      });

      it('clones twice in place, because sibling names are deliberately not unique', async () => {
        const g = await group(probeId, 'Switch template');
        await h.service.clone(testActor, g, {});
        await h.service.clone(testActor, g, {});

        const siblings = await h.service.list(
          { parentId: probeId },
          { limit: 50, sort: 'name', cursor: null },
        );
        const clones = siblings.items.filter((i) => i.name === 'Clone of Switch template');
        assert.equal(clones.length, 2);
      });

      it('rolls back every row when a clone fails after it has started writing', async () => {
        const source = await buildSubtree(probeId);
        const before = await countObjects();

        // The size refusal happens before any object row exists, so testing rollback with it
        // would assert a count that could not have changed. Fail *after* the inserts instead:
        // a clone into a target that is deleted mid-transaction trips the FK on the depth-0
        // insert, by which point clone_map is populated and rows are going in.
        const error = await rejectsAny(() =>
          h.service.batch('shared', async (q, repo) => {
            const copied = await repo.copySubtree(q, source, probeId, 'Doomed clone', 5_000);
            // Rows are now written inside this transaction; abandon it.
            throw new Error(`clone wrote ${String(copied.counts.total)} objects, now rolling back`);
          }),
        );

        assert.match(String(error), /rolling back/);
        assert.equal(await countObjects(), before, 'not one cloned row survived');
      });

      it('refuses a clone larger than the limit, before writing anything', async () => {
        const source = await buildSubtree(probeId);
        const before = await countObjects();

        const error = await rejects(() =>
          h.service.batch('shared', async (q, repo) =>
            repo.copySubtree(q, source, probeId, 'Too big', 2),
          ),
        );

        assert.equal(error.code, 'OBJECT_CLONE_TOO_LARGE');
        assert.equal(error.details['limit'], 2);
        assert.equal(error.details['actual'], 6);
        assert.equal(await countObjects(), before);
      });

      it('can clone twice inside one transaction, which bulk operations will', async () => {
        // The temp table is ON COMMIT DROP, so a second call in the same transaction would
        // have found it still there with stale rows.
        const source = await buildSubtree(probeId);
        const target = await group(probeId, 'Target');

        const results = await h.service.batch('shared', async (q, repo) => {
          const first = await repo.copySubtree(q, source, target, 'First clone', 5_000);
          const second = await repo.copySubtree(q, source, target, 'Second clone', 5_000);
          return [first, second];
        });

        const [first, second] = results;
        assert.ok(first !== undefined && second !== undefined);
        assert.equal(first.counts.total, 6);
        assert.equal(second.counts.total, 6);
        assert.notEqual(first.cloneRootId, second.cloneRootId);
      });
    });

    // ── delete ────────────────────────────────────────────────────────────────────────────

    describe('delete', () => {
      it('deletes a leaf without a confirmation', async () => {
        const d = await device(probeId, 'switch-01');
        const s = await sensor(d, 'Ping');

        const report = await h.service.delete(testActor, s, { kind: 'leafOnly' }, { kind: 'none' });

        assert.equal(report.deleted.total, 1);
        assert.equal(report.deleted.sensor, 1);
        await rejects(() => h.service.get(s));
      });

      it('refuses a populated subtree once, and the refusal is the preview', async () => {
        const g = await group(probeId, 'Berlin DC');
        const d = await device(g, 'switch-01');
        await sensor(d, 'Ping');
        await sensor(d, 'Uptime');

        const error = await rejects(() =>
          h.service.delete(testActor, g, { kind: 'leafOnly' }, { kind: 'none' }),
        );

        assert.equal(error.code, 'OBJECT_NOT_EMPTY');
        assert.equal(error.status, 409);
        const deleted = error.details['deleted'] as Record<string, number>;
        assert.equal(deleted['total'], 4);
        assert.equal(deleted['sensor'], 2);
        assert.match(String(error.details['retryWith']), /expectedDescendants=3/);

        // Nothing was destroyed.
        assert.equal((await h.service.get(g)).id, g);
      });

      it('proceeds on the counted confirmation and returns an exact receipt', async () => {
        const g = await group(probeId, 'Doomed');
        const d = await device(g, 'switch-01');
        const s = await sensor(d, 'Ping');
        // `rtt` and `loss` come with the sensor type; nothing to insert by hand.

        const report = await h.service.delete(
          testActor,
          g,
          { kind: 'exact', descendants: 2 },
          { kind: 'none' },
        );

        assert.equal(report.deleted.total, 3);
        assert.equal(report.deleted.channels, 2, 'both declared channels went with it');
        assert.equal(report.destroyed.length, 3);
        for (const id of [g, d, s]) await rejects(() => h.service.get(id));

        const orphanChannels = await scratch.db.query<{ count: string }>(
          'SELECT count(*) AS count FROM channel WHERE sensor_id = $1',
          [s],
        );
        assert.equal(orphanChannels[0]?.count, '0', 'the cascade is verified, not assumed');
      });

      it('refuses a count that does not match, and rolls back', async () => {
        const g = await group(probeId, 'Berlin DC');
        const d = await device(g, 'switch-01');
        await sensor(d, 'Ping');

        const error = await rejects(() =>
          h.service.delete(testActor, g, { kind: 'exact', descendants: 99 }, { kind: 'none' }),
        );

        assert.equal(error.code, 'OBJECT_SUBTREE_CHANGED');
        assert.equal(error.details['expected'], 99);
        assert.equal(error.details['actual'], 2);
        assert.equal((await h.service.get(g)).id, g, 'the tree is intact');
      });

      it('refuses to delete the root', async () => {
        const error = await rejects(() =>
          h.service.delete(testActor, h.rootId, { kind: 'leafOnly' }, { kind: 'none' }),
        );
        assert.equal(error.code, 'OBJECT_NOT_DELETABLE');
      });

      it('hands the full enumeration to the audit sink before deleting', async () => {
        const g = await group(probeId, 'Audited');
        const d = await device(g, 'switch-01');
        await sensor(d, 'Ping');
        h.audit.recorded.length = 0;

        await h.service.delete(testActor, g, { kind: 'exact', descendants: 2 }, { kind: 'none' });

        const entry = h.audit.recorded.find((m) => m.action === 'object.deleted');
        assert.ok(entry !== undefined);
        assert.equal(entry.action, 'object.deleted');
        assert.equal(entry.destroyed.length, 3, 'one ref per destroyed object');
        assert.equal(entry.deleted.total, 3);
        // There is no recycle bin; this enumeration is the only reconstruction path.
        assert.deepEqual(entry.destroyed.map((r) => r.name).sort(), [
          'Audited',
          'Ping',
          'switch-01',
        ]);
      });
    });

    // ── helpers ───────────────────────────────────────────────────────────────────────────

    async function countObjects(): Promise<number> {
      const rows = await scratch.db.query<{ count: string }>(
        'SELECT count(*) AS count FROM object',
      );
      return Number(rows[0]?.count ?? 0);
    }

    async function rejectsAny(fn: () => Promise<unknown>): Promise<unknown> {
      try {
        await fn();
      } catch (error) {
        return error;
      }
      assert.fail('expected the call to reject');
    }

    async function rejects(fn: () => Promise<unknown>): Promise<ObjectError> {
      try {
        await fn();
      } catch (error) {
        assert.ok(error instanceof ObjectError, `expected ObjectError, got ${String(error)}`);
        return error;
      }
      assert.fail('expected the call to reject');
    }
  },
);
