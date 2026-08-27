import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { ObjectId } from '../src/objects/types.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

const COMMUNITY = 'a-very-distinctive-community';

describe(
  'the credential vault',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let h: Harness;
    let probeId: ObjectId;
    let groupId: ObjectId;
    let deviceId: ObjectId;
    let sensorId: ObjectId;

    before(async () => {
      scratch = await createScratchDatabase('vault');
      h = await buildHarness(scratch.db);
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      await scratch.db.query("DELETE FROM object WHERE kind <> 'root'");
      h.audit.recorded.length = 0;

      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'Local probe',
      });
      probeId = probe.id;
      const group = await h.service.create(testActor, {
        kind: 'group',
        parentId: probeId,
        name: 'Rack A',
      });
      groupId = group.id;
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: groupId,
        name: 'router',
        host: '10.0.0.1',
      });
      deviceId = device.id;
      const sensor = await h.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: 'uptime',
        sensorType: 'snmp.traffic',
        params: {},
      });
      sensorId = sensor.id;
    });

    describe('storing one', () => {
      it('splits the record by what the schema marks write-only', async () => {
        const view = await h.service.setCredential(testActor, deviceId, 'snmp', {
          version: 'v2c',
          community: COMMUNITY,
        });
        // The version is public and comes back; the community is not and does not.
        assert.deepEqual(view.publicParams, { version: 'v2c' });
        assert.equal(JSON.stringify(view).includes(COMMUNITY), false);
      });

      it('never writes the secret into the column the API returns', async () => {
        await h.service.setCredential(testActor, deviceId, 'snmp', {
          version: 'v2c',
          community: COMMUNITY,
        });
        const [row] = await scratch.db.query<{ public_params: Record<string, unknown> }>(
          'SELECT public_params FROM credential_set WHERE object_id = $1',
          [deviceId],
        );
        assert.deepEqual(row?.public_params, { version: 'v2c' });
      });

      it('leaves no plaintext in the stored bytes', async () => {
        await h.service.setCredential(testActor, deviceId, 'snmp', {
          version: 'v2c',
          community: COMMUNITY,
        });
        const [row] = await scratch.db.query<{ secret: Buffer }>(
          'SELECT secret FROM credential_set WHERE object_id = $1',
          [deviceId],
        );
        assert.ok(row);
        assert.equal(row.secret.includes(Buffer.from(COMMUNITY)), false);
      });

      it('refuses a kind with no transport behind it', async () => {
        // Storing a password nothing will ever authenticate with is worse than not offering the
        // field: it is a forgotten secret in a database.
        await assert.rejects(
          () => h.service.setCredential(testActor, deviceId, 'vmware', { username: 'x' }),
          /not a credential kind this build can use/,
        );
      });

      it('refuses to write against an object that is not there', async () => {
        await assert.rejects(
          () => h.service.setCredential(testActor, 999_999, 'snmp', { community: 'x' }),
          /does not exist/,
        );
      });
    });

    describe('editing one', () => {
      it('keeps a secret the caller did not send', async () => {
        // The mirror of `U-08`'s `carryWriteOnly`, and the failure it prevents: a read never
        // returns the community string, so a form correcting the SNMP version beside it cannot
        // send one back — and a write that replaced the record would delete it every time.
        await h.service.setCredential(testActor, deviceId, 'snmp', {
          version: 'v2c',
          community: COMMUNITY,
        });
        await h.service.setCredential(testActor, deviceId, 'snmp', { version: 'v1' });

        const resolved = await h.vault.resolveFor([sensorId], ['snmp']);
        assert.equal(resolved.get(sensorId)?.get('snmp')?.values['community'], COMMUNITY);
        assert.equal(resolved.get(sensorId)?.get('snmp')?.values['version'], 'v1');
      });

      it('rotates a secret that is sent', async () => {
        await h.service.setCredential(testActor, deviceId, 'snmp', { community: COMMUNITY });
        await h.service.setCredential(testActor, deviceId, 'snmp', { community: 'rotated' });
        const resolved = await h.vault.resolveFor([sensorId], ['snmp']);
        assert.equal(resolved.get(sensorId)?.get('snmp')?.values['community'], 'rotated');
      });

      it('removes a secret sent as null', async () => {
        // Distinct from omitting it, which keeps it. A form's Clear button relies on the two
        // being different, and getting them the same way round makes one of them impossible.
        await h.service.setCredential(testActor, deviceId, 'snmp', {
          version: 'v2c',
          community: COMMUNITY,
        });
        await h.service.setCredential(testActor, deviceId, 'snmp', {
          version: 'v2c',
          community: null,
        });
        const resolved = await h.vault.resolveFor([sensorId], ['snmp']);
        assert.equal('community' in (resolved.get(sensorId)?.get('snmp')?.values ?? {}), false);
      });
    });

    describe('inheritance', () => {
      it('gives a sensor the credential set on its device', async () => {
        await h.service.setCredential(testActor, deviceId, 'snmp', { community: COMMUNITY });
        const resolved = await h.vault.resolveFor([sensorId], ['snmp']);
        assert.equal(resolved.get(sensorId)?.get('snmp')?.values['community'], COMMUNITY);
      });

      it('reaches up past the device to a group', async () => {
        // The whole point of the ticket: set a community string once on a rack, not on every
        // sensor under it.
        await h.service.setCredential(testActor, groupId, 'snmp', { community: 'rack-wide' });
        const resolved = await h.vault.resolveFor([sensorId], ['snmp']);
        assert.equal(resolved.get(sensorId)?.get('snmp')?.values['community'], 'rack-wide');
      });

      it('prefers the nearest ancestor', async () => {
        await h.service.setCredential(testActor, groupId, 'snmp', { community: 'rack-wide' });
        await h.service.setCredential(testActor, deviceId, 'snmp', { community: 'device-only' });
        const resolved = await h.vault.resolveFor([sensorId], ['snmp']);
        assert.equal(resolved.get(sensorId)?.get('snmp')?.values['community'], 'device-only');
      });

      it('decrypts an inherited record against the object that owns it', async () => {
        // The seal is bound to the object it is stored on. Opening it against the *sensor* that
        // inherited it would fail every inherited credential in the installation, which is the
        // easy version of this bug to write.
        await h.service.setCredential(testActor, groupId, 'snmp', { community: 'rack-wide' });
        const resolved = await h.vault.resolveFor([sensorId, deviceId], ['snmp']);
        assert.equal(resolved.get(sensorId)?.get('snmp')?.values['community'], 'rack-wide');
        assert.equal(resolved.get(deviceId)?.get('snmp')?.values['community'], 'rack-wide');
      });

      it('returns nothing for a kind nobody up the tree defines', async () => {
        const resolved = await h.vault.resolveFor([sensorId], ['snmp']);
        assert.equal(resolved.has(sensorId), false);
      });
    });

    describe('removing one', () => {
      it('reveals the ancestor’s rather than leaving nothing', async () => {
        await h.service.setCredential(testActor, groupId, 'snmp', { community: 'rack-wide' });
        await h.service.setCredential(testActor, deviceId, 'snmp', { community: 'device-only' });

        const outcome = await h.service.clearCredential(testActor, deviceId, 'snmp');
        assert.equal(outcome.removed, true);
        // The response says which one is now in force, so an operator is not left to discover it
        // from a sensor that kept working.
        assert.equal(outcome.nowInherited?.source.kind, 'inherited');

        const resolved = await h.vault.resolveFor([sensorId], ['snmp']);
        assert.equal(resolved.get(sensorId)?.get('snmp')?.values['community'], 'rack-wide');
      });

      it('reports nothing removed when there was none, without failing', async () => {
        const outcome = await h.service.clearCredential(testActor, deviceId, 'snmp');
        assert.equal(outcome.removed, false);
        assert.equal(outcome.nowInherited, null);
      });
    });

    describe('the read path', () => {
      it('has no field a secret could occupy', async () => {
        await h.service.setCredential(testActor, deviceId, 'snmp', {
          version: 'v2c',
          community: COMMUNITY,
        });
        const views = await h.service.credentials(sensorId, true);
        assert.equal(views.length, 1);
        assert.deepEqual(Object.keys(views[0] ?? {}).sort(), [
          'kind',
          'publicParams',
          'source',
          'updatedAt',
        ]);
        assert.equal(JSON.stringify(views).includes(COMMUNITY), false);
      });
    });

    describe('the audit trail', () => {
      it('records that a secret was set, and never what it was', async () => {
        // An audit row is permanent and readable through the history API. A diff carrying values
        // would be a plaintext archive of every credential this installation has ever held —
        // exactly what encrypting the column was for.
        await h.service.setCredential(testActor, deviceId, 'snmp', {
          version: 'v2c',
          community: COMMUNITY,
        });
        const entry = h.audit.recorded.find((m) => m.action === 'credential.set');
        assert.ok(entry, 'a credential.set entry should have been recorded');
        assert.equal(JSON.stringify(entry).includes(COMMUNITY), false);
        assert.equal(JSON.stringify(entry).includes('community'), true, 'the field name is useful');
      });

      it('records a removal', async () => {
        await h.service.setCredential(testActor, deviceId, 'snmp', { community: COMMUNITY });
        h.audit.recorded.length = 0;
        await h.service.clearCredential(testActor, deviceId, 'snmp');
        assert.ok(h.audit.recorded.some((m) => m.action === 'credential.deleted'));
      });

      it('writes nothing at all when the write rolls back', async () => {
        h.audit.recorded.length = 0;
        await assert.rejects(() =>
          h.service.setCredential(testActor, 999_999, 'snmp', { community: COMMUNITY }),
        );
        assert.equal(h.audit.recorded.length, 0);
      });
    });

    describe('a rotated vault key', () => {
      it('still reads what an older key sealed', async () => {
        await h.service.setCredential(testActor, deviceId, 'snmp', { community: COMMUNITY });
        const [row] = await scratch.db.query<{ key_id: string }>(
          'SELECT key_id FROM credential_set WHERE object_id = $1',
          [deviceId],
        );
        assert.equal(row?.key_id, 'test-key', 'the record names the key that sealed it');
      });
    });

    describe('a probe subtree', () => {
      it('resolves credentials for every sensor in one pass', async () => {
        // A branch is a handful of sensor types over thousands of sensors, and one query per
        // sensor per kind would be thousands of round trips to build a single config push.
        await h.service.setCredential(testActor, probeId, 'snmp', { community: 'probe-wide' });
        const extra = await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'second',
          sensorType: 'snmp.traffic',
          params: {},
        });
        const resolved = await h.vault.resolveFor([sensorId, extra.id], ['snmp']);
        assert.equal(resolved.size, 2);
        for (const id of [sensorId, extra.id]) {
          assert.equal(resolved.get(id)?.get('snmp')?.values['community'], 'probe-wide');
        }
      });

      it('gives sensors sharing a record the same rotation stamp', async () => {
        await h.service.setCredential(testActor, probeId, 'snmp', { community: 'probe-wide' });
        const extra = await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'second',
          sensorType: 'snmp.traffic',
          params: {},
        });
        const resolved = await h.vault.resolveFor([sensorId, extra.id], ['snmp']);
        assert.equal(
          resolved.get(sensorId)?.get('snmp')?.stamp,
          resolved.get(extra.id)?.get('snmp')?.stamp,
        );
      });

      it('changes the stamp when the credential is rotated, and never carries its value', async () => {
        await h.service.setCredential(testActor, deviceId, 'snmp', { community: COMMUNITY });
        const before = (await h.vault.resolveFor([sensorId], ['snmp']))
          .get(sensorId)
          ?.get('snmp')?.stamp;
        // `updated_at` has second-or-better resolution in Postgres; nudge it rather than sleep.
        await scratch.db.query(
          "UPDATE credential_set SET updated_at = now() + interval '1 second' WHERE object_id = $1",
          [deviceId],
        );
        const after = (await h.vault.resolveFor([sensorId], ['snmp']))
          .get(sensorId)
          ?.get('snmp')?.stamp;

        assert.notEqual(before, after, 'a rotation has to change the configuration fingerprint');
        // The stamp is hashed into the probe's config fingerprint, which is sent to probes and
        // written to logs. A community string is short and low-entropy, so a published digest of
        // one is recovered by guessing.
        assert.equal(String(before).includes(COMMUNITY), false);
        assert.equal(String(after).includes(COMMUNITY), false);
      });
    });
  },
);
