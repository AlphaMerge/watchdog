import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { toHttpError } from '../src/api/errors.js';
import type { ObjectId } from '../src/objects/types.js';
import { CREDENTIAL_KINDS, type CredentialKindDefinition } from '@ms/sensors';
import { invalidValues, VaultError, writeChecks } from '../src/vault/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

const COMMUNITY = 'a-very-distinctive-community';

describe('a credential kind the vault compiles (P-379)', () => {
  /** A kind with one public field, `user`, beside the secret, holding it to `user`'s schema. */
  const kind = (user: Record<string, unknown>): CredentialKindDefinition => ({
    id: 'test',
    name: 'Test',
    description: '',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        user,
        password: { type: 'string', writeOnly: true },
        allowedTargets: { type: 'array', items: { type: 'string' } },
      },
    },
    secretDestinations: { password: ['allowedTargets'] },
  });

  it('refuses a pattern with no sentence, and a sentence with no pattern, at load', () => {
    // As `MethodRegistry` refuses one (`P-372`): a write a pattern refuses is told its sentence.
    assert.throws(
      () => writeChecks([kind({ type: 'string', pattern: '^[a-z]+$' })]),
      /credential kind test gives "user" a pattern without x-patternMessage/,
    );
    assert.throws(
      () => writeChecks([kind({ type: 'string', 'x-patternMessage': 'must be a word' })]),
      /credential kind test gives "user" x-patternMessage without a pattern/,
    );
  });

  it('refuses a mistyped keyword at load, which used to constrain nothing', () => {
    assert.throws(
      () => writeChecks([kind({ type: 'string', maxLenght: 5 })]),
      /unknown keyword: "maxLenght"/,
    );
  });

  it('says a refused pattern’s sentence, and not the value, which may be the secret', () => {
    const definition = kind({
      type: 'string',
      pattern: '^[a-z]+$',
      'x-patternMessage': 'must be a lowercase word',
    });
    const check = writeChecks([definition]).get('test')?.created;
    assert.ok(check !== undefined);
    assert.equal(check({ user: 'CANARY-1', password: 'p' }), false);
    const refused = invalidValues(definition, check.errors ?? []);
    assert.equal(refused.message, 'user must be a lowercase word for Test credentials');
    assert.doesNotMatch(JSON.stringify(refused.context), /CANARY/);
  });

  it('takes the kinds it ships, and what they took before', () => {
    const checks = writeChecks(CREDENTIAL_KINDS);
    assert.deepEqual(
      [...checks.keys()],
      CREDENTIAL_KINDS.map((each) => each.id),
    );
    assert.equal(checks.get('snmp')?.created({ version: 'v2c', community: COMMUNITY }), true);
  });
});

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

    describe('what a write may hold (A-43)', () => {
      const TYPO = 'a-secret-under-the-wrong-name';

      it('refuses a key its kind does not declare, storing and auditing nothing', async () => {
        // `comunity`: the typo that stored a community string in the clear. `splitCredential`
        // sorts by whether a key is a declared secret, so an undeclared one was public.
        const refusal = await h.service
          .setCredential(testActor, deviceId, 'snmp', { version: 'v2c', comunity: TYPO })
          .then(
            () => assert.fail('the mistyped key was accepted'),
            (error: unknown) => error,
          );
        assert.ok(refusal instanceof VaultError);
        assert.equal(refusal.code, 'CREDENTIAL_INVALID');
        assert.match(refusal.message, /^"comunity" is not a field of SNMP credentials/);
        assert.match(refusal.message, /\bcommunity\b/, 'the fields it does have, to spot a typo');
        const answer = toHttpError(refusal);
        assert.equal(answer.status, 400);
        assert.equal(JSON.stringify(answer).includes(TYPO), false, 'the answer echoes the value');

        const rows = await scratch.db.query('SELECT 1 FROM credential_set WHERE object_id = $1', [
          deviceId,
        ]);
        assert.equal(rows.length, 0, 'something was stored');
        assert.deepEqual(
          h.audit.recorded.filter((entry) => entry.action === 'credential.set'),
          [],
        );
        assert.equal(JSON.stringify(h.audit.recorded).includes(TYPO), false);
      });

      it('refuses a value of the wrong type, and one outside its enum, naming the field', async () => {
        await assert.rejects(
          () => h.service.setCredential(testActor, deviceId, 'snmp', { community: 5 }),
          (error: unknown) =>
            error instanceof VaultError && /^community must be string,null/.test(error.message),
        );
        await assert.rejects(
          () => h.service.setCredential(testActor, deviceId, 'snmp', { version: 'v4' }),
          (error: unknown) => error instanceof VaultError && /^version /.test(error.message),
        );
      });

      it('still takes null as the unset, and keeps a secret the write leaves out', async () => {
        await h.service.setCredential(testActor, deviceId, 'snmp', { community: COMMUNITY });
        await h.service.setCredential(testActor, deviceId, 'snmp', { version: 'v1' });
        let resolved = await h.vault.resolveFor([sensorId], ['snmp']);
        assert.equal(resolved.get(sensorId)?.get('snmp')?.values['community'], COMMUNITY);
        await h.service.setCredential(testActor, deviceId, 'snmp', { community: null });
        resolved = await h.vault.resolveFor([sensorId], ['snmp']);
        assert.equal(resolved.get(sensorId)?.get('snmp')?.values['community'], undefined);
      });

      it('returns no key a set written before it holds, to the API or the probe, and counts the set', async () => {
        // A row as a write before `A-43` could leave it: the typo beside a declared field.
        await h.service.setCredential(testActor, deviceId, 'snmp', {
          version: 'v2c',
          community: COMMUNITY,
        });
        await scratch.db.query(
          `UPDATE credential_set SET public_params = public_params || $2::jsonb
           WHERE object_id = $1`,
          [deviceId, JSON.stringify({ comunity: TYPO })],
        );

        const [view] = await h.resolver.resolveCredentials(deviceId);
        assert.deepEqual(view?.publicParams, { version: 'v2c' });
        const resolved = await h.vault.resolveFor([sensorId], ['snmp']);
        const values = resolved.get(sensorId)?.get('snmp')?.values ?? {};
        assert.equal(JSON.stringify(values).includes(TYPO), false, 'the probe was sent it');
        assert.equal(values['community'], COMMUNITY, 'and the real secret still reaches it');

        assert.deepEqual(await h.vault.setsWithUndeclaredKeys(scratch.db), [
          { objectId: deviceId, kind: 'snmp', keys: 1 },
        ]);
        assert.equal(await h.vault.warnOfUndeclaredKeys(scratch.db), 1);

        // Re-entering it replaces the public half, and the key goes with it.
        await h.service.setCredential(testActor, deviceId, 'snmp', { version: 'v2c' });
        assert.deepEqual(await h.vault.setsWithUndeclaredKeys(scratch.db), []);
        const [row] = await scratch.db.query<{ public_params: Record<string, unknown> }>(
          'SELECT public_params FROM credential_set WHERE object_id = $1',
          [deviceId],
        );
        assert.deepEqual(row?.public_params, { version: 'v2c' });
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
          'bounded',
          'kind',
          'publicParams',
          'source',
          'updatedAt',
        ]);
        assert.equal(JSON.stringify(views).includes(COMMUNITY), false);

        // Read where it is stored, it also names which secrets hold a value (`U-21`): names.
        const own = await h.service.credentials(deviceId, true);
        assert.deepEqual(Object.keys(own[0] ?? {}).sort(), [
          'bounded',
          'kind',
          'publicParams',
          'secretsSet',
          'source',
          'updatedAt',
        ]);
        assert.deepEqual(own[0]?.secretsSet, ['community']);
        assert.equal(JSON.stringify(own).includes(COMMUNITY), false);
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

    describe('where a set may go (A-41b)', () => {
      const communityOf = async (): Promise<unknown> =>
        (await h.vault.resolveFor([sensorId], ['snmp'])).get(sensorId)?.get('snmp')?.values[
          'community'
        ];

      it('refuses a target that is none of the four things one may be, storing nothing', async () => {
        await assert.rejects(
          h.service.setCredential(testActor, groupId, 'snmp', {
            community: COMMUNITY,
            allowedTargets: ['10.0.0.0/8', 'db*.example.com'],
          }),
          (error: unknown) =>
            error instanceof VaultError &&
            error.code === 'CREDENTIAL_INVALID' &&
            /allowed target 2: "db\*\.example\.com" puts \*/.test(error.message) &&
            error.context['field'] === 'allowedTargets/1',
        );
        assert.equal(await communityOf(), undefined);
        assert.deepEqual(
          h.audit.recorded.filter((entry) => entry.action === 'credential.set'),
          [],
        );
      });

      it('refuses an SSH set that lists host keys and checks none of them', async () => {
        await assert.rejects(
          h.service.setCredential(testActor, groupId, 'ssh', {
            username: 'monitor',
            password: 'a-long-enough-password',
            hostKeys: ['SHA256:abc'],
            hostKeyPolicy: 'accept-any',
          }),
          /list host keys cannot also accept any key/,
        );
        await h.service.setCredential(testActor, groupId, 'ssh', {
          username: 'monitor',
          password: 'a-long-enough-password',
          hostKeys: ['SHA256:abc'],
        });
      });

      it('keeps the secret through a write that narrows the targets, and clears it through one that widens them', async () => {
        await h.service.setCredential(testActor, groupId, 'snmp', {
          community: COMMUNITY,
          allowedTargets: ['10.0.0.0/8', 'router.example.test'],
        });
        // Narrowed: an entry taken away.
        let view = await h.service.setCredential(testActor, groupId, 'snmp', {
          allowedTargets: ['10.0.0.0/8'],
        });
        assert.deepEqual(view.secretsCleared, []);
        assert.equal(await communityOf(), COMMUNITY);

        // Widened: an entry that was not there, without the community.
        view = await h.service.setCredential(testActor, groupId, 'snmp', {
          allowedTargets: ['10.0.0.0/8', '192.168.0.0/16'],
        });
        assert.deepEqual(view.secretsCleared, ['community']);
        assert.equal(await communityOf(), undefined);
        const entry = h.audit.recorded.at(-1);
        assert.ok(entry?.action === 'credential.set');
        assert.deepEqual(entry.secretsCleared, ['community']);
        assert.equal(JSON.stringify(h.audit.recorded).includes(COMMUNITY), false);

        // Widened again, with the community sent: nothing cleared.
        view = await h.service.setCredential(testActor, groupId, 'snmp', {
          community: COMMUNITY,
        });
        assert.deepEqual(view.secretsCleared, []);
        assert.equal(await communityOf(), COMMUNITY);
      });

      it('says how many sensors beneath its targets now keep it from, in the response and the audit entry', async () => {
        // The device is 10.0.0.1.
        let view = await h.service.setCredential(testActor, groupId, 'snmp', {
          community: COMMUNITY,
          allowedTargets: ['10.9.0.0/16'],
        });
        assert.equal(view.withholds, 1);
        const entry = h.audit.recorded.at(-1);
        assert.equal(entry?.action === 'credential.set' ? entry.withholds : null, 1);

        view = await h.service.setCredential(testActor, groupId, 'snmp', {
          community: COMMUNITY,
          allowedTargets: ['10.0.0.0/24'],
        });
        assert.equal(view.withholds, 0);

        // A set with no targets withholds nothing, and its audit entry does not pretend to count.
        view = await h.service.setCredential(testActor, deviceId, 'snmp', { community: COMMUNITY });
        assert.equal(view.withholds, 0);
        const unbounded = h.audit.recorded.at(-1);
        assert.equal(
          unbounded?.action === 'credential.set' ? 'withholds' in unbounded : null,
          false,
        );
      });

      it('counts the sets with no bounds, for Core Health', async () => {
        assert.equal(await h.vault.unboundedSets(scratch.db), 0);
        await h.service.setCredential(testActor, deviceId, 'snmp', { community: COMMUNITY });
        await h.service.setCredential(testActor, groupId, 'snmp', {
          community: COMMUNITY,
          allowedTargets: ['10.0.0.0/8'],
        });
        await h.service.setCredential(testActor, groupId, 'ssh', {
          username: 'monitor',
          password: 'a-long-enough-password',
          hostKeyFingerprint: 'SHA256:abc',
        });
        await h.service.setCredential(testActor, probeId, 'ssh', {
          username: 'monitor',
          password: 'a-long-enough-password',
          hostKeys: ['SHA256:abc'],
        });
        await h.service.setCredential(testActor, probeId, 'snmp', { community: COMMUNITY });
        // Two sets are bounded. The three that are not: the device's SNMP set, the probe's, and
        // the group's SSH set, whose one fingerprint bounds nothing.
        assert.equal(await h.vault.unboundedSets(scratch.db), 3);
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
