import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { Database } from '../src/db/pool.js';
import { DatabaseAuditSink } from '../src/audit/store.js';
import { AccessService } from '../src/auth/access.js';
import { RecipientResolver, type SkippedRecipient } from '../src/notifications/recipients.js';
import type { Recipient } from '../src/notifications/templates.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { actorNamed, buildHarness, silent, testActor } from './support/tree.js';

const available = await databaseAvailable();

/**
 * Who a template's users and groups turn into when a message is sent (`M-19`).
 *
 * A table, because the rule has six ways to leave somebody out and each has to be named: the
 * failure this replaces sent to some of a template and said nothing about the rest.
 */
describe(
  'resolving a template’s recipients',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let access: AccessService;
    let resolver: RecipientResolver;
    const id: Record<string, number> = {};

    const user = (name: string): Recipient => ({ kind: 'user', value: String(id[name]) });
    const group = (name: string): Recipient => ({ kind: 'userGroup', value: String(id[name]) });
    const address = (value: string): Recipient => ({ kind: 'address', value });

    before(async () => {
      scratch = await createScratchDatabase('recipients');
      db = scratch.db;
      const harness = await buildHarness(db);
      access = new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent });
      resolver = new RecipientResolver({ db, access });

      const make = async (
        kind: 'probe' | 'group' | 'device' | 'sensor',
        parentId: number,
        name: string,
      ) =>
        (
          await harness.service.create(
            testActor,
            kind === 'device'
              ? { kind, parentId, name, host: '192.0.2.1' }
              : kind === 'sensor'
                ? { kind, parentId, name, sensorType: 'icmp.ping' }
                : { kind, parentId, name },
          )
        ).id;
      const probe = await make('probe', harness.rootId, 'probe');
      id['customerA'] = await make('group', probe, 'Customer A');
      id['customerB'] = await make('group', probe, 'Customer B');
      id['sensorA'] = await make(
        'sensor',
        await make('device', id['customerA'], 'a-router'),
        'a-ping',
      );
      id['sensorB'] = await make(
        'sensor',
        await make('device', id['customerB'], 'b-router'),
        'b-ping',
      );

      const account = async (
        login: string,
        email: string,
        disabled = false,
        role = 'readwrite',
      ) => {
        id[login] = Number(
          (
            await db.query<{ id: string }>(
              `INSERT INTO user_account (login, display_name, email, password_hash, role, disabled)
               VALUES ($1, $1, $2, 'x', $3, $4) RETURNING id::text AS id`,
              [login, email, role, disabled],
            )
          )[0]?.id,
        );
      };
      await account('alice', 'alice@example.test');
      await account('bob', 'bob@example.test', true);
      await account('carol', '');
      await account('dave', 'dave@example.test');
      await account('erin', 'erin@example.test', false, 'admin');

      const team = async (name: string, members: string[]) => {
        id[name] = Number(
          (
            await db.query<{ id: string }>(
              `INSERT INTO user_group (name) VALUES ($1) RETURNING id::text AS id`,
              [name],
            )
          )[0]?.id,
        );
        for (const member of members) {
          await db.query(`INSERT INTO user_group_member (group_id, user_id) VALUES ($1, $2)`, [
            id[name],
            id[member],
          ]);
        }
      };
      // Alice, Bob and Carol work on customer A; Dave on customer B; NOC is all four.
      await team('teamA', ['alice', 'bob', 'carol']);
      await team('teamB', ['dave']);
      await team('NOC', ['alice', 'bob', 'carol', 'dave']);
      await team('Empty', []);
      await access.grant(id['customerA'] ?? 0, id['teamA'] ?? 0, 'read', actorNamed('test'));
      await access.grant(id['customerB'] ?? 0, id['teamB'] ?? 0, 'read', actorNamed('test'));
      const admins = await db.query<{ id: string }>(
        `SELECT id::text AS id FROM user_group WHERE is_admin ORDER BY user_group.id LIMIT 1`,
      );
      await db.query(`INSERT INTO user_group_member (group_id, user_id) VALUES ($1, $2)`, [
        Number(admins[0]?.id),
        id['erin'],
      ]);
    });

    after(async () => {
      await scratch.drop();
    });

    const cases: {
      name: string;
      recipients: () => Recipient[];
      about: () => number[];
      addresses: string[];
      skipped: SkippedRecipient[];
    }[] = [
      {
        name: 'a user who may read the sensor',
        recipients: () => [user('alice')],
        about: () => [id['sensorA'] ?? 0],
        addresses: ['alice@example.test'],
        skipped: [],
      },
      {
        name: 'a disabled account',
        recipients: () => [user('bob')],
        about: () => [id['sensorA'] ?? 0],
        addresses: [],
        skipped: [{ who: 'user "bob"', reason: 'disabled' }],
      },
      {
        name: 'an account with no address',
        recipients: () => [user('carol')],
        about: () => [id['sensorA'] ?? 0],
        addresses: [],
        skipped: [{ who: 'user "carol"', reason: 'no email address' }],
      },
      {
        name: 'a user who may not read the sensor',
        recipients: () => [user('dave')],
        about: () => [id['sensorA'] ?? 0],
        addresses: [],
        skipped: [{ who: 'user "dave"', reason: 'may not see this sensor' }],
      },
      {
        name: 'the same user, about a sensor they may read',
        recipients: () => [user('dave')],
        about: () => [id['sensorB'] ?? 0],
        addresses: ['dave@example.test'],
        skipped: [],
      },
      {
        name: 'a group: its members, each for their own reason',
        recipients: () => [group('NOC')],
        about: () => [id['sensorA'] ?? 0],
        addresses: ['alice@example.test'],
        skipped: [
          { who: '"bob" in group "NOC"', reason: 'disabled' },
          { who: '"carol" in group "NOC"', reason: 'no email address' },
          { who: '"dave" in group "NOC"', reason: 'may not see this sensor' },
        ],
      },
      {
        name: 'addresses, users and groups together, with nobody dropped silently',
        recipients: () => [address('ops@example.test'), user('dave'), group('teamA')],
        about: () => [id['sensorA'] ?? 0],
        addresses: ['ops@example.test', 'alice@example.test'],
        skipped: [
          { who: 'user "dave"', reason: 'may not see this sensor' },
          { who: '"bob" in group "teamA"', reason: 'disabled' },
          { who: '"carol" in group "teamA"', reason: 'no email address' },
        ],
      },
      {
        name: 'somebody named twice, and an address that is theirs, sent to once',
        recipients: () => [user('alice'), group('teamA'), address('ALICE@example.test')],
        about: () => [id['sensorA'] ?? 0],
        addresses: ['alice@example.test'],
        skipped: [
          { who: '"bob" in group "teamA"', reason: 'disabled' },
          { who: '"carol" in group "teamA"', reason: 'no email address' },
        ],
      },
      {
        name: 'a digest: only those who may read every sensor it names',
        recipients: () => [user('alice'), user('dave'), user('erin')],
        about: () => [id['sensorA'] ?? 0, id['sensorB'] ?? 0],
        addresses: ['erin@example.test'],
        skipped: [
          { who: 'user "alice"', reason: 'may not see this sensor' },
          { who: 'user "dave"', reason: 'may not see this sensor' },
        ],
      },
      {
        name: 'a test send from example values, which names no sensor',
        recipients: () => [user('dave')],
        about: () => [],
        addresses: ['dave@example.test'],
        skipped: [],
      },
      {
        name: 'a sensor that has been deleted: administrators only, as its log is',
        recipients: () => [user('alice'), user('erin')],
        about: () => [999_999],
        addresses: ['erin@example.test'],
        skipped: [{ who: 'user "alice"', reason: 'may not see this sensor' }],
      },
      {
        name: 'ids that name nothing, and a value that is not an id',
        recipients: () => [
          { kind: 'user', value: '999999' },
          { kind: 'userGroup', value: '999999' },
          { kind: 'user', value: 'alice' },
          group('Empty'),
        ],
        about: () => [id['sensorA'] ?? 0],
        addresses: [],
        skipped: [
          { who: 'user "alice"', reason: 'no such account' },
          { who: 'user 999999', reason: 'no such account' },
          { who: 'group 999999', reason: 'no such group' },
          { who: 'group "Empty"', reason: 'no members' },
        ],
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, async () => {
        const resolved = await resolver.resolve(testCase.recipients(), testCase.about());
        assert.deepEqual(resolved.addresses, testCase.addresses);
        assert.deepEqual(resolved.skipped, testCase.skipped);
      });
    }

    it('resolves a group as it is when the message is sent, not when the template was saved', async () => {
      const recipients = [group('teamB')];
      const about = [id['sensorB'] ?? 0];
      assert.deepEqual((await resolver.resolve(recipients, about)).addresses, [
        'dave@example.test',
      ]);
      await db.query(`DELETE FROM user_group_member WHERE group_id = $1 AND user_id = $2`, [
        id['teamB'],
        id['dave'],
      ]);
      await db.query(`INSERT INTO user_group_member (group_id, user_id) VALUES ($1, $2)`, [
        id['teamB'],
        id['alice'],
      ]);
      // Alice is on customer A's team as well, so the rights rule is not what changes here.
      await access.grant(id['customerB'] ?? 0, id['teamA'] ?? 0, 'read', actorNamed('test'));
      assert.deepEqual((await resolver.resolve(recipients, about)).addresses, [
        'alice@example.test',
      ]);
    });
  },
);
