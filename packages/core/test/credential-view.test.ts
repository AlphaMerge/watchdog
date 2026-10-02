import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import { Visibility } from '../src/auth/access.js';
import type { ObjectId } from '../src/objects/types.js';
import { HistoryService } from '../src/timeseries/history.js';
import { VaultKeyring } from '../src/vault/keyring.js';
import { CredentialVault, VaultSealer } from '../src/vault/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

/**
 * What the credential view reads and asks before it writes (`U-21`).
 *
 * The web tab needs four things the API did not say: whether a set is bounded, which of its
 * secrets hold a value, what a write or a removal will do before it is confirmed, and which sets
 * have no bounds at all. Each is asserted here for what it says and for what it must not: a
 * preview stores nothing and leaves no history, no answer carries a secret, and the list of
 * unbounded sets names no object its reader cannot see.
 */

const available = await databaseAvailable();

const COMMUNITY = 'a-very-distinctive-community';
const PASSWORD = 'a-very-distinctive-password';

describe(
  'the credential view',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let h: Harness;
    let app: FastifyInstance;
    let probeId: ObjectId;
    let groupId: ObjectId;
    let deviceId: ObjectId;
    let otherDeviceId: ObjectId;
    let sensorId: ObjectId;

    before(async () => {
      scratch = await createScratchDatabase('credview');
      h = await buildHarness(scratch.db);
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
        history: new HistoryService({ db: scratch.db, logger: silent }),
        db: scratch.db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
      });
      await server.build('9.9.9', h.service);
      app = server.app;
    });

    after(async () => {
      await app.close();
      await scratch.drop();
    });

    beforeEach(async () => {
      await scratch.db.query("DELETE FROM object WHERE kind <> 'root'");
      h.audit.recorded.length = 0;

      probeId = (
        await h.service.create(testActor, {
          kind: 'probe',
          parentId: h.rootId,
          name: 'Local probe',
        })
      ).id;
      groupId = (
        await h.service.create(testActor, { kind: 'group', parentId: probeId, name: 'Rack A' })
      ).id;
      // Two devices, one inside 10.0.0.0/24 and one outside, each with one SNMP sensor.
      deviceId = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: groupId,
          name: 'router',
          host: '10.0.0.1',
        })
      ).id;
      otherDeviceId = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: groupId,
          name: 'far-router',
          host: '10.9.0.1',
        })
      ).id;
      sensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'uptime',
          sensorType: 'snmp.traffic',
          params: {},
        })
      ).id;
      await h.service.create(testActor, {
        kind: 'sensor',
        parentId: otherDeviceId,
        name: 'far-uptime',
        sensorType: 'snmp.traffic',
        params: {},
      });
    });

    /** What is stored for one set, opened: the proof of what a preview did not change. */
    const stored = async (
      objectId: ObjectId,
      kind: string,
    ): Promise<{ publicParams: unknown; updatedAt: string; secrets: string[] } | null> => {
      const [row] = await scratch.db.query<{ public_params: unknown; updated_at: Date }>(
        'SELECT public_params, updated_at FROM credential_set WHERE object_id = $1 AND kind = $2',
        [objectId, kind],
      );
      if (row === undefined) return null;
      return {
        publicParams: row.public_params,
        updatedAt: row.updated_at.toISOString(),
        secrets: (await h.vault.secretNames(scratch.db, objectId, kind)) ?? [],
      };
    };

    /** Everything about a write's answer but when it happened. */
    const answered = (view: object): Record<string, unknown> => {
      const { updatedAt: _updatedAt, ...rest } = view as Record<string, unknown>;
      return rest;
    };

    describe('a preview of a write', () => {
      it('answers what the write then answers, and stores nothing', async () => {
        await h.service.setCredential(testActor, groupId, 'snmp', { community: COMMUNITY });
        const before = await stored(groupId, 'snmp');
        h.audit.recorded.length = 0;

        // Narrowed to a range the far device is outside.
        const values = { allowedTargets: ['10.0.0.0/24'] };
        const preview = await h.service.setCredential(
          testActor,
          groupId,
          'snmp',
          values,
          { kind: 'none' },
          { preview: true },
        );
        assert.equal(preview.withholds, 1);
        assert.equal(preview.bounded, true);
        assert.deepEqual(preview.secretsCleared, []);
        assert.deepEqual(preview.publicParams, values);

        // Nothing stored, and nothing in the history: the set is as it was, to the timestamp.
        assert.deepEqual(await stored(groupId, 'snmp'), before);
        assert.deepEqual(h.audit.recorded, []);

        const written = await h.service.setCredential(testActor, groupId, 'snmp', values);
        assert.deepEqual(answered(written), answered(preview));
        assert.equal(h.audit.recorded.length, 1);
        assert.deepEqual((await stored(groupId, 'snmp'))?.publicParams, values);
      });

      it('names the secrets a widening would clear, and leaves them where they are', async () => {
        await h.service.setCredential(testActor, groupId, 'snmp', {
          community: COMMUNITY,
          allowedTargets: ['10.0.0.0/24'],
        });
        const values = { allowedTargets: ['10.0.0.0/24', '10.9.0.0/16'] };
        const preview = await h.service.setCredential(
          testActor,
          groupId,
          'snmp',
          values,
          { kind: 'none' },
          { preview: true },
        );
        assert.deepEqual(preview.secretsCleared, ['community']);
        assert.equal(preview.withholds, 0);
        assert.deepEqual((await stored(groupId, 'snmp'))?.secrets, ['community']);

        const written = await h.service.setCredential(testActor, groupId, 'snmp', values);
        assert.deepEqual(answered(written), answered(preview));
        assert.deepEqual((await stored(groupId, 'snmp'))?.secrets, []);
      });

      it('creates nothing when the set is new', async () => {
        const preview = await h.service.setCredential(
          testActor,
          groupId,
          'snmp',
          { community: COMMUNITY, allowedTargets: ['10.9.0.0/16'] },
          { kind: 'none' },
          { preview: true },
        );
        assert.equal(preview.withholds, 1);
        assert.equal(await stored(groupId, 'snmp'), null);
        assert.deepEqual(await h.service.credentials(groupId, true), []);
      });

      it('is refused as the write is', async () => {
        await assert.rejects(
          () =>
            h.service.setCredential(
              testActor,
              groupId,
              'snmp',
              { community: COMMUNITY, allowedTargets: ['not a target at all'] },
              { kind: 'none' },
              { preview: true },
            ),
          (error: unknown) => (error as { code?: string }).code === 'CREDENTIAL_INVALID',
        );
        assert.equal(await stored(groupId, 'snmp'), null);
      });

      it('says a set was written in the log only when one was', async () => {
        const lines: string[] = [];
        const vault = new CredentialVault({
          resolver: h.resolver,
          sealer: new VaultSealer(
            VaultKeyring.fromKeys([{ id: 'test-key', key: Buffer.alloc(32, 7) }]),
          ),
          logger: pino({ level: 'info' }, { write: (line: string) => lines.push(line) }),
        });
        const written = (): number =>
          lines.filter((line) => line.includes('credential set written')).length;

        await assert.rejects(() =>
          scratch.db.tx(async (q) => {
            await vault.write(q, groupId, 'snmp', { community: COMMUNITY }, { preview: true });
            throw new Error('rolled back, as a preview is');
          }),
        );
        assert.equal(written(), 0);

        await scratch.db.tx((q) => vault.write(q, groupId, 'snmp', { community: COMMUNITY }));
        assert.equal(written(), 1);
        assert.equal(lines.join('').includes(COMMUNITY), false);
      });
    });

    describe('reading the sets on an object', () => {
      it('names the secrets its own set holds, in the kind’s order, and never their values', async () => {
        await h.service.setCredential(testActor, groupId, 'ssh', {
          username: 'monitor',
          passphrase: 'a-passphrase',
          password: PASSWORD,
        });
        const [own] = await h.service.credentials(groupId, true);
        assert.deepEqual(own?.secretsSet, ['password', 'passphrase']);
        assert.equal(JSON.stringify(own).includes(PASSWORD), false);
        assert.equal(JSON.stringify(own).includes('a-passphrase'), false);

        // Cleared, and it is no longer named.
        await h.service.setCredential(testActor, groupId, 'ssh', {
          username: 'monitor',
          passphrase: null,
        });
        const [after] = await h.service.credentials(groupId, true);
        assert.deepEqual(after?.secretsSet, ['password']);
      });

      it('says nothing about the secrets of a set stored somewhere else', async () => {
        await h.service.setCredential(testActor, groupId, 'snmp', { community: COMMUNITY });
        const [inherited] = await h.service.credentials(deviceId, true);
        assert.ok(inherited !== undefined);
        assert.equal(inherited.source.kind, 'inherited');
        assert.equal('secretsSet' in inherited, false);
      });

      it('answers no names for a record it cannot open, rather than failing the read', async () => {
        await scratch.db.query(
          `INSERT INTO credential_set (object_id, kind, public_params, secret, key_id)
           VALUES ($1, 'snmp', '{"version":"v2c"}'::jsonb, '\\x00'::bytea, 'k1')`,
          [deviceId],
        );
        const [own] = await h.service.credentials(deviceId, true);
        assert.deepEqual(own?.secretsSet, []);
        assert.equal(await h.vault.secretNames(scratch.db, groupId, 'snmp'), null);
      });

      it('says whether each set is bounded, by the rule the delivery uses', async () => {
        const bounded = async (objectId: ObjectId, kind: string): Promise<boolean | undefined> =>
          (await h.service.credentials(objectId, false)).find((view) => view.kind === kind)
            ?.bounded;

        await h.service.setCredential(testActor, deviceId, 'snmp', { community: COMMUNITY });
        assert.equal(await bounded(deviceId, 'snmp'), false);

        await h.service.setCredential(testActor, groupId, 'snmp', {
          community: COMMUNITY,
          allowedTargets: ['10.0.0.0/8'],
        });
        assert.equal(await bounded(groupId, 'snmp'), true);

        // The one legacy fingerprint bounds nothing (`A-41b`); listed keys do.
        await h.service.setCredential(testActor, groupId, 'ssh', {
          username: 'monitor',
          password: PASSWORD,
          hostKeyFingerprint: 'SHA256:abc',
        });
        assert.equal(await bounded(groupId, 'ssh'), false);
        await h.service.setCredential(testActor, probeId, 'ssh', {
          username: 'monitor',
          password: PASSWORD,
          hostKeys: ['SHA256:abc'],
        });
        assert.equal(await bounded(probeId, 'ssh'), true);
      });
    });

    describe('removing a set', () => {
      it('says how many sensors were using it, by the nearest-set rule', async () => {
        await h.service.setCredential(testActor, groupId, 'snmp', { community: 'rack-wide' });
        // The far device has a set of its own, so its sensor is not the group's to lose.
        await h.service.setCredential(testActor, otherDeviceId, 'snmp', { community: 'own' });

        const outcome = await h.service.clearCredential(testActor, groupId, 'snmp');
        assert.equal(outcome.removed, true);
        assert.equal(outcome.sensors, 1);
        assert.equal(outcome.nowInherited, null);
      });

      it('previews the removal with the same answer, and leaves the set and the history alone', async () => {
        await h.service.setCredential(testActor, probeId, 'snmp', { community: 'probe-wide' });
        await h.service.setCredential(testActor, groupId, 'snmp', { community: 'rack-wide' });
        const before = await stored(groupId, 'snmp');
        h.audit.recorded.length = 0;

        const preview = await h.service.clearCredential(
          testActor,
          groupId,
          'snmp',
          { kind: 'none' },
          { preview: true },
        );
        assert.equal(preview.removed, true);
        assert.equal(preview.sensors, 2);
        assert.deepEqual(preview.nowInherited?.source, {
          kind: 'inherited',
          objectId: probeId,
          depth: 1,
        });
        assert.deepEqual(await stored(groupId, 'snmp'), before);
        assert.deepEqual(h.audit.recorded, []);
        const resolved = await h.vault.resolveFor([sensorId], ['snmp']);
        assert.equal(resolved.get(sensorId)?.get('snmp')?.values['community'], 'rack-wide');

        const removed = await h.service.clearCredential(testActor, groupId, 'snmp');
        assert.deepEqual(removed, preview);
        assert.equal(await stored(groupId, 'snmp'), null);
        assert.equal(h.audit.recorded.length, 1);
      });

      it('counts nothing when there was no set to remove', async () => {
        await h.service.setCredential(testActor, probeId, 'snmp', { community: 'probe-wide' });
        const outcome = await h.service.clearCredential(testActor, groupId, 'snmp');
        assert.equal(outcome.removed, false);
        assert.equal(outcome.sensors, 0);
      });
    });

    describe('what a write counts for a caller with a hole beneath the object', () => {
      // `write` on the group, and the far device carved out of it: its sensor uses the group's
      // set like the other, and is not the writer's to count.
      const carved = (): Visibility =>
        Visibility.of(
          new Map([
            [groupId, true],
            [otherDeviceId, false],
          ]),
          false,
          null,
        );
      /** Bounds that leave both devices outside, so both sensors are kept from the set. */
      const values = { community: COMMUNITY, allowedTargets: ['192.0.2.0/24'] };

      it('counts the sensors kept from a set among those the caller sees, previewed or written', async () => {
        for (const preview of [true, false]) {
          h.audit.recorded.length = 0;
          const seen = await h.service.setCredential(
            testActor,
            groupId,
            'snmp',
            values,
            { kind: 'none' },
            { preview, visibility: carved() },
          );
          assert.equal(seen.withholds, 1, `preview ${String(preview)}`);
          // The history says what the write did, whoever made it.
          const [entry] = h.audit.recorded;
          assert.equal(entry === undefined, preview);
          if (entry !== undefined) {
            assert.equal(entry.action === 'credential.set' ? entry.withholds : null, 2);
          }
        }
        // Everybody else is told about both: an administrator, and a caller that names no view.
        for (const visibility of [Visibility.EVERYTHING, undefined]) {
          const all = await h.service.setCredential(
            testActor,
            groupId,
            'snmp',
            values,
            { kind: 'none' },
            { preview: true, ...(visibility === undefined ? {} : { visibility }) },
          );
          assert.equal(all.withholds, 2);
        }
        // And a caller who sees nothing beneath is told of nothing.
        const none = await h.service.setCredential(
          testActor,
          groupId,
          'snmp',
          values,
          { kind: 'none' },
          { preview: true, visibility: Visibility.nothing(null) },
        );
        assert.equal(none.withholds, 0);
      });

      it('counts the sensors using a set among those the caller sees, previewed or removed', async () => {
        await h.service.setCredential(testActor, groupId, 'snmp', { community: COMMUNITY });
        const all = await h.service.clearCredential(
          testActor,
          groupId,
          'snmp',
          { kind: 'none' },
          { preview: true, visibility: Visibility.EVERYTHING },
        );
        assert.equal(all.sensors, 2);
        for (const preview of [true, false]) {
          const seen = await h.service.clearCredential(
            testActor,
            groupId,
            'snmp',
            { kind: 'none' },
            { preview, visibility: carved() },
          );
          assert.equal(seen.removed, true);
          assert.equal(seen.sensors, 1, `preview ${String(preview)}`);
        }
      });
    });

    describe('the sets with no bounds', () => {
      beforeEach(async () => {
        await h.service.setCredential(testActor, probeId, 'snmp', { community: COMMUNITY });
        await h.service.setCredential(testActor, groupId, 'ssh', {
          username: 'monitor',
          password: PASSWORD,
        });
        await h.service.setCredential(testActor, deviceId, 'snmp', { community: COMMUNITY });
        // Bounded, so in no list.
        await h.service.setCredential(testActor, otherDeviceId, 'snmp', {
          community: COMMUNITY,
          allowedTargets: ['10.9.0.0/16'],
        });
      });

      it('lists each with the object it is stored on, and is what Core Health counts', async () => {
        const items = await h.service.unboundedCredentials(Visibility.EVERYTHING);
        assert.deepEqual(
          items.map((item) => [item.objectName, item.objectKind, item.objectId, item.kind]),
          [
            ['Local probe', 'probe', probeId, 'snmp'],
            ['Rack A', 'group', groupId, 'ssh'],
            ['router', 'device', deviceId, 'snmp'],
          ],
        );
        assert.equal(items.length, await h.vault.unboundedSets(scratch.db));
        assert.equal(JSON.stringify(items).includes(COMMUNITY), false);
        assert.equal(JSON.stringify(items).includes(PASSWORD), false);
      });

      it('leaves out a set on an object its reader cannot see, name and id', async () => {
        // Granted the group and what is beneath it; the probe above is outside the branch.
        const branch = Visibility.of(new Map([[groupId, true]]), false, null);
        const items = await h.service.unboundedCredentials(branch);
        assert.deepEqual(
          items.map((item) => item.objectName),
          ['Rack A', 'router'],
        );
        assert.equal(JSON.stringify(items).includes('Local probe'), false);
        assert.equal(
          items.some((item) => item.objectId === probeId),
          false,
        );

        // And a hole carved beneath the grant hides what is stored inside it.
        const carved = Visibility.of(
          new Map([
            [groupId, true],
            [deviceId, false],
          ]),
          false,
          null,
        );
        assert.deepEqual(
          (await h.service.unboundedCredentials(carved)).map((item) => item.objectName),
          ['Rack A'],
        );
        assert.deepEqual(await h.service.unboundedCredentials(Visibility.nothing(null)), []);
      });
    });

    describe('over the API', () => {
      const url = (objectId: ObjectId, kind: string, query = ''): string =>
        `/api/v1/objects/${String(objectId)}/credentials/${kind}${query}`;

      it('previews a write on the route that writes, and the write answers the same', async () => {
        await h.service.setCredential(testActor, groupId, 'snmp', { community: COMMUNITY });
        const payload = { values: { community: COMMUNITY, allowedTargets: ['10.0.0.0/24'] } };

        const preview = await app.inject({
          method: 'PUT',
          url: url(groupId, 'snmp', '?dryRun=true'),
          payload,
        });
        assert.equal(preview.statusCode, 200, preview.body);
        const previewed = preview.json<Record<string, unknown>>();
        assert.equal(previewed['withholds'], 1);
        assert.equal(previewed['bounded'], true);
        assert.deepEqual(previewed['secretsCleared'], []);
        assert.equal(preview.body.includes(COMMUNITY), false);
        assert.deepEqual((await stored(groupId, 'snmp'))?.publicParams, {});

        const written = await app.inject({ method: 'PUT', url: url(groupId, 'snmp'), payload });
        assert.equal(written.statusCode, 200, written.body);
        assert.deepEqual(answered(written.json<Record<string, unknown>>()), answered(previewed));
        assert.deepEqual((await stored(groupId, 'snmp'))?.publicParams, {
          allowedTargets: ['10.0.0.0/24'],
        });
      });

      it('writes when asked not to preview, and refuses a value that is neither', async () => {
        const payload = { values: { community: COMMUNITY } };
        const mistyped = await app.inject({
          method: 'PUT',
          url: url(groupId, 'snmp', '?dryRun=yes'),
          payload,
        });
        assert.equal(mistyped.statusCode, 400);
        assert.equal(await stored(groupId, 'snmp'), null);

        const real = await app.inject({
          method: 'PUT',
          url: url(groupId, 'snmp', '?dryRun=false'),
          payload,
        });
        assert.equal(real.statusCode, 200, real.body);
        assert.notEqual(await stored(groupId, 'snmp'), null);
      });

      it('reads a set with its bound and the names of its secrets, and no secret', async () => {
        await h.service.setCredential(testActor, groupId, 'snmp', {
          version: 'v2c',
          community: COMMUNITY,
          allowedTargets: ['10.0.0.0/24'],
        });
        const own = await app.inject({
          method: 'GET',
          url: `/api/v1/objects/${String(groupId)}/credentials`,
        });
        assert.equal(own.statusCode, 200);
        assert.equal(own.body.includes(COMMUNITY), false);
        const [set] = own.json<{ items: Record<string, unknown>[] }>().items;
        assert.ok(set !== undefined);
        assert.equal(set['bounded'], true);
        assert.deepEqual(set['secretsSet'], ['community']);

        const below = await app.inject({
          method: 'GET',
          url: `/api/v1/objects/${String(deviceId)}/credentials`,
        });
        const [inherited] = below.json<{ items: Record<string, unknown>[] }>().items;
        assert.ok(inherited !== undefined);
        assert.equal(inherited['bounded'], true);
        assert.equal('secretsSet' in inherited, false);
      });

      it('previews a removal, then removes, and says what lost the set both times', async () => {
        await h.service.setCredential(testActor, groupId, 'snmp', { community: COMMUNITY });

        const preview = await app.inject({
          method: 'DELETE',
          url: url(groupId, 'snmp', '?dryRun=true'),
        });
        assert.equal(preview.statusCode, 200, preview.body);
        assert.deepEqual(preview.json(), {
          kind: 'snmp',
          removed: true,
          sensors: 2,
          nowInherited: null,
        });
        assert.notEqual(await stored(groupId, 'snmp'), null);

        const removed = await app.inject({ method: 'DELETE', url: url(groupId, 'snmp') });
        assert.deepEqual(removed.json(), preview.json());
        assert.equal(await stored(groupId, 'snmp'), null);
      });

      it('lists the sets with no bounds, with their owners and nothing of the sets', async () => {
        await h.service.setCredential(testActor, groupId, 'snmp', {
          version: 'v2c',
          community: COMMUNITY,
        });
        await h.service.setCredential(testActor, deviceId, 'snmp', {
          community: COMMUNITY,
          allowedTargets: ['10.0.0.0/24'],
        });
        const response = await app.inject({ method: 'GET', url: '/api/v1/credentials/unbounded' });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.headers['cache-control'], 'private, max-age=0, must-revalidate');
        const { items } = response.json<{ items: Record<string, unknown>[] }>();
        assert.equal(items.length, 1);
        const [item] = items;
        assert.ok(item !== undefined);
        assert.deepEqual(Object.keys(item).sort(), [
          'kind',
          'objectId',
          'objectKind',
          'objectName',
          'updatedAt',
        ]);
        assert.equal(item['objectName'], 'Rack A');
        assert.equal(item['objectId'], groupId);
        assert.equal(response.body.includes(COMMUNITY), false);
      });
    });
  },
);
