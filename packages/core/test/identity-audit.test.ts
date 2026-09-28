import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import * as OTPAuth from 'otpauth';
import type { Database, Queryable } from '../src/db/pool.js';
import { DatabaseAuditSink } from '../src/audit/store.js';
import type { Actor, AuditSink, Mutation } from '../src/objects/audit.js';
import { AccountService, type Account } from '../src/auth/accounts.js';
import { GroupService } from '../src/auth/groups.js';
import { TokenService } from '../src/auth/tokens.js';
import { TotpService } from '../src/auth/totp.js';
import { Migrator } from '../src/db/migrator.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { silent } from './support/tree.js';

const available = await databaseAvailable();

/**
 * What the audit log says about accounts, groups, memberships, passwords, second factors and API
 * tokens (`A-18`).
 *
 * `audit-sweep.test.ts` proves each identity route writes *an* entry. This says what the entries
 * hold — the role before and after, whether a group administers the installation — and proves the
 * two things a row count cannot: that a change which fails takes its entry with it, and that no
 * entry carries anything that signs somebody in.
 */

interface Row {
  action: string;
  actor_kind: string;
  actor_ref: string;
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

/** A code from the authenticator an enrolment was handed, as a person would type it. */
function codeFor(secret: string): string {
  return new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
}

describe(
  'identity changes in the audit log',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let sink: FailsAfterRecording;
    let accounts: AccountService;
    let groups: GroupService;
    let tokens: TokenService;
    let totp: TotpService;
    let actor: Actor;
    let administrators = 0;
    let seq = 0;
    /** Everything that signs somebody in, gathered as the tests make it; the last test hunts it. */
    const planted: string[] = [];

    const login = (prefix: string): string => {
      seq += 1;
      return `${prefix}-${String(seq)}`;
    };
    const PASSWORD = 'identity-planted-password-3c9e';

    const rows = async (action: string, where = 'TRUE', values: unknown[] = []): Promise<Row[]> =>
      db.query<Row>(
        `SELECT action, actor_kind, actor_ref, actor_label, summary, diff
         FROM audit_log WHERE action = $1 AND ${where} ORDER BY id`,
        [action, ...values],
      );
    const about = (action: string, accountId: number): Promise<Row[]> =>
      rows(action, `summary->>'accountId' = $2`, [String(accountId)]);
    const account = async (role: Account['role'] = 'readwrite'): Promise<Account> =>
      accounts.create({ login: login('person'), password: PASSWORD, role }, actor);

    before(async () => {
      scratch = await createScratchDatabase('identityaudit');
      db = scratch.db;
      // No object tree is needed, so the migrator is driven directly, as `accounts.test.ts` does.
      await new Migrator({ db, logger: silent, migrations: MIGRATIONS }).up();
      sink = new FailsAfterRecording();
      accounts = new AccountService({ db, audit: sink, logger: silent });
      groups = new GroupService({ db, audit: sink, logger: silent });
      tokens = new TokenService({ db, audit: sink, logger: silent });
      totp = new TotpService({ db, audit: sink, logger: silent });

      // First, while the installation has no account at all: this is the one change nobody makes.
      const first = await accounts.ensureFirstAdministrator('root');
      assert.ok(first !== null, 'the scratch database already had an account');
      planted.push(first.password);
      const root = await accounts.byLogin('root');
      assert.ok(root !== null);
      actor = { kind: 'user', userId: root.id, login: 'root' };

      const found = await db.query<{ id: string }>(
        `SELECT id::text AS id FROM user_group WHERE is_builtin AND is_admin`,
      );
      administrators = Number(found[0]?.id);
      assert.ok(administrators > 0);
    });

    after(async () => {
      await scratch.drop();
    });

    it('records the first administrator, and how it came to administer, as the system', async () => {
      const root = await accounts.byLogin('root');
      assert.ok(root !== null);
      const [created] = await about('account.created', root.id);
      assert.ok(created !== undefined);
      assert.equal(created.actor_kind, 'system');
      assert.equal(created.actor_ref, 'first-administrator');
      assert.ok(
        created.diff.some((one) => one.field === 'account.role' && one.after === 'admin'),
        JSON.stringify(created.diff),
      );

      const [joined] = await about('group.memberAdded', root.id);
      assert.ok(
        joined !== undefined,
        'the membership that makes it an administrator is unrecorded',
      );
      assert.equal(joined.actor_kind, 'system');
      assert.equal(joined.summary['administers'], true);
      assert.equal(joined.summary['groupId'], administrators);
      assert.equal(joined.summary['primary'], true);
    });

    // ---------------------------------------------------------------------------- accounts

    it('records a role change with the role before and after, and who made it', async () => {
      const person = await account('readonly');
      const [created] = await about('account.created', person.id);
      assert.ok(created !== undefined);
      assert.ok(
        created.diff.some((one) => one.field === 'account.role' && one.after === 'readonly'),
      );

      await accounts.update(person.id, { role: 'readwrite' }, actor);
      const updates = await about('account.updated', person.id);
      assert.equal(updates.length, 1);
      const [update] = updates;
      assert.ok(update !== undefined);
      // The role, and nothing that did not move.
      assert.deepEqual(update.diff, [
        { field: 'account.role', before: 'readonly', after: 'readwrite' },
      ]);
      assert.equal(update.actor_kind, 'user');
      assert.equal(update.actor_ref, String(actor.kind === 'user' ? actor.userId : 0));
      assert.equal(update.actor_label, 'root');
      assert.equal(update.summary['login'], person.login);

      await accounts.update(person.id, { role: 'admin', disabled: true }, actor);
      const [, second] = await about('account.updated', person.id);
      assert.ok(second !== undefined);
      assert.deepEqual(
        second.diff.map((one) => [one.field, one.before, one.after]),
        [
          ['account.role', 'readwrite', 'admin'],
          ['account.disabled', false, true],
        ],
      );
    });

    it('writes nothing for an update that changed nothing', async () => {
      const person = await account('readwrite');
      await accounts.update(
        person.id,
        { role: 'readwrite', displayName: person.displayName },
        actor,
      );
      assert.deepEqual(await about('account.updated', person.id), []);
    });

    it('leaves no entry for a role change the database refuses', async () => {
      // `A-04`: a member of an administrator group cannot be made read-only.
      const person = await account('readwrite');
      await groups.addMember(administrators, person.id, actor);
      await assert.rejects(
        () => accounts.update(person.id, { role: 'readonly' }, actor),
        /remove it from that group/,
      );
      assert.deepEqual(await about('account.updated', person.id), []);
      assert.equal((await accounts.get(person.id))?.role, 'readwrite');
    });

    it('records a deleted account as it was', async () => {
      const person = await account('readonly');
      await accounts.delete(person.id, actor);
      const [deleted] = await about('account.deleted', person.id);
      assert.ok(deleted !== undefined);
      assert.equal(deleted.summary['login'], person.login);
      assert.ok(
        deleted.diff.some((one) => one.field === 'account.role' && one.before === 'readonly'),
      );
    });

    it('records that a password changed, and nothing about the password', async () => {
      const person = await account();
      await accounts.changePassword(person.id, `${PASSWORD}-2`, actor, { current: PASSWORD });
      await accounts.changePassword(person.id, `${PASSWORD}-3`, actor, { byAdministrator: true });
      planted.push(`${PASSWORD}-2`, `${PASSWORD}-3`);

      const changes = await about('account.passwordChanged', person.id);
      assert.deepEqual(
        changes.map((one) => [one.summary['reset'], one.diff]),
        [
          [false, []],
          [true, []],
        ],
      );
      assert.deepEqual(Object.keys(changes[0]?.summary ?? {}).sort(), [
        'accountId',
        'login',
        'reset',
      ]);
    });

    // ------------------------------------------------------------------------------ groups

    it('says in the entry that a group administers the installation, joining and leaving', async () => {
      const person = await account();
      const team = await groups.create({ name: login('Team') }, actor);
      await groups.addMember(team.id, person.id, actor);
      await groups.addMember(administrators, person.id, actor);

      const added = await about('group.memberAdded', person.id);
      assert.deepEqual(
        added.map((one) => [
          one.summary['groupId'],
          one.summary['administers'],
          one.summary['primary'],
        ]),
        [
          [team.id, false, true],
          [administrators, true, false],
        ],
      );
      const joined = added[1];
      assert.ok(joined !== undefined);
      assert.equal(joined.summary['login'], person.login);
      assert.deepEqual(joined.diff, [{ field: 'group.member', before: null, after: person.login }]);

      await groups.removeMember(administrators, person.id, actor);
      const [removed] = await about('group.memberRemoved', person.id);
      assert.ok(removed !== undefined);
      assert.equal(removed.summary['administers'], true);
      assert.equal(removed.summary['wasPrimary'], false);
      assert.equal(removed.actor_label, 'root');
    });

    it('writes nothing for a member added twice, and records a primary group that moves', async () => {
      const person = await account();
      const first = await groups.create({ name: login('First') }, actor);
      const second = await groups.create({ name: login('Second') }, actor);
      await groups.addMember(first.id, person.id, actor);
      await groups.addMember(second.id, person.id, actor);
      const before = (await about('group.memberAdded', person.id)).length;

      await groups.addMember(second.id, person.id, actor);
      assert.equal((await about('group.memberAdded', person.id)).length, before);
      assert.deepEqual(await about('group.primarySet', person.id), []);

      await groups.addMember(second.id, person.id, actor, true);
      await groups.setPrimary(first.id, person.id, actor);
      await groups.setPrimary(first.id, person.id, actor);
      const moves = await about('group.primarySet', person.id);
      assert.deepEqual(
        moves.map((one) => one.diff[0]),
        [
          { field: 'account.primaryGroup', before: first.name, after: second.name },
          { field: 'account.primaryGroup', before: second.name, after: first.name },
        ],
      );

      // Leaving the primary group hands out another, and says which.
      await groups.removeMember(first.id, person.id, actor);
      const [removed] = await about('group.memberRemoved', person.id);
      assert.equal(removed?.summary['wasPrimary'], true);
      const last = (await about('group.primarySet', person.id)).at(-1);
      assert.deepEqual(last?.diff[0], {
        field: 'account.primaryGroup',
        before: first.name,
        after: second.name,
      });
    });

    it('records the admin flag in a group edit, and a deleted group with its members', async () => {
      const person = await account();
      const crew = await groups.create({ name: login('Crew') }, actor);
      await groups.addMember(crew.id, person.id, actor);

      await groups.update(crew.id, { isAdmin: true }, actor);
      await groups.update(crew.id, { isAdmin: true }, actor);
      const edits = await rows('group.updated', `summary->>'groupId' = $2`, [String(crew.id)]);
      assert.equal(edits.length, 1, 'an edit that changed nothing wrote an entry');
      assert.deepEqual(edits[0]?.diff, [{ field: 'group.isAdmin', before: false, after: true }]);

      await groups.delete(crew.id, actor);
      const [deleted] = await rows('group.deleted', `summary->>'groupId' = $2`, [String(crew.id)]);
      assert.ok(deleted !== undefined);
      assert.deepEqual(deleted.summary['members'], [person.login]);
      assert.ok(deleted.diff.some((one) => one.field === 'group.isAdmin' && one.before === true));
    });

    // ------------------------------------------------------------------------------ tokens

    it('records a token by its prefix, never the token, and its owner beside its issuer', async () => {
      const person = await account();
      const { token, secret } = await tokens.issue(
        { userId: person.id, role: person.role },
        { name: 'backup', scope: 'full' },
        actor,
      );
      planted.push(secret);

      const [issued] = await about('token.issued', person.id);
      assert.ok(issued !== undefined);
      assert.deepEqual(issued.summary, {
        tokenId: token.id,
        accountId: person.id,
        login: person.login,
        name: 'backup',
        prefix: token.prefix,
        scope: 'full',
        expiresAt: null,
      });
      assert.ok(secret.startsWith(token.prefix) && secret.length > token.prefix.length);
      // Issued by somebody other than the owner, and the entry says both.
      assert.notEqual(issued.actor_ref, String(person.id));

      assert.equal(await tokens.revoke(person.id, token.id, actor), true);
      assert.equal(await tokens.revoke(person.id, token.id, actor), false);
      const revoked = await about('token.revoked', person.id);
      assert.equal(revoked.length, 1, 'a revoke that found nothing wrote an entry');
      assert.equal(revoked[0]?.summary['prefix'], token.prefix);

      const more = await Promise.all(
        ['one', 'two'].map((name) =>
          tokens.issue({ userId: person.id, role: person.role }, { name }, actor),
        ),
      );
      planted.push(...more.map((one) => one.secret));
      assert.equal(await tokens.revokeAllFor(person.id, actor), 2);
      assert.equal((await about('token.revoked', person.id)).length, 3);
    });

    // -------------------------------------------------------------------------------- MFA

    it('records a second factor turned on, its codes replaced and turned off, by count', async () => {
      const person = await account();
      const { secret } = await totp.beginEnrolment(person.id, person.login);
      planted.push(secret);
      // Starting an enrolment changes how nobody signs in, and is not recorded.
      assert.deepEqual(await about('account.mfaEnabled', person.id), []);

      const { recoveryCodes } = await totp.confirmEnrolment(person.id, codeFor(secret), actor);
      planted.push(...recoveryCodes, ...recoveryCodes.map((code) => code.replace('-', '')));
      planted.push(...(await hashesOf('user_recovery_code', 'code_hash', person.id)));
      const fresh = await totp.regenerateRecoveryCodes(person.id, actor);
      planted.push(...fresh, ...fresh.map((code) => code.replace('-', '')));
      planted.push(...(await hashesOf('user_recovery_code', 'code_hash', person.id)));
      await totp.disable(person.id, actor);
      await totp.disable(person.id, actor);

      const history = await db.query<Row>(
        `SELECT action, actor_kind, actor_ref, actor_label, summary, diff FROM audit_log
         WHERE action LIKE 'account.%' AND summary->>'accountId' = $1
           AND action IN ('account.mfaEnabled', 'account.recoveryCodesRegenerated',
                          'account.mfaDisabled')
         ORDER BY id`,
        [String(person.id)],
      );
      assert.deepEqual(
        history.map((one) => [one.action, one.summary['recoveryCodes'] ?? null, one.diff]),
        [
          ['account.mfaEnabled', 10, [{ field: 'account.mfa', before: false, after: true }]],
          ['account.recoveryCodesRegenerated', 10, []],
          // Once: the second disable found no factor to turn off.
          ['account.mfaDisabled', null, [{ field: 'account.mfa', before: true, after: false }]],
        ],
      );
    });

    // ------------------------------------------------------------------ the transaction

    /**
     * Each kind of change, made to fail after its entry was written: the entry must go with it.
     * `check` answers whether the change itself is absent, so a pass cannot be a change that
     * happened with its record rolled back — the one outcome worse than no audit log.
     */
    const failing: {
      action: string;
      make: () => Promise<{ run: () => Promise<unknown>; unchanged: () => Promise<boolean> }>;
    }[] = [
      {
        action: 'account.created',
        make: () => {
          const name = login('ghost');
          return Promise.resolve({
            run: () =>
              accounts.create({ login: name, password: PASSWORD, role: 'readonly' }, actor),
            unchanged: async () => (await accounts.byLogin(name)) === null,
          });
        },
      },
      {
        action: 'account.updated',
        make: async () => {
          const person = await account('readonly');
          return {
            run: () => accounts.update(person.id, { role: 'admin' }, actor),
            unchanged: async () => (await accounts.get(person.id))?.role === 'readonly',
          };
        },
      },
      {
        action: 'account.passwordChanged',
        make: async () => {
          const person = await account();
          return {
            run: () =>
              accounts.changePassword(person.id, `${PASSWORD}-x`, actor, { current: PASSWORD }),
            unchanged: async () =>
              (await accounts.authenticate(person.login, PASSWORD)).kind === 'ok',
          };
        },
      },
      {
        action: 'group.memberAdded',
        make: async () => {
          const person = await account();
          return {
            run: () => groups.addMember(administrators, person.id, actor),
            unchanged: async () => !(await groups.administers(person.id)),
          };
        },
      },
      {
        action: 'group.deleted',
        make: async () => {
          const person = await account();
          const doomed = await groups.create({ name: login('Doomed') }, actor);
          await groups.addMember(doomed.id, person.id, actor);
          return {
            run: () => groups.delete(doomed.id, actor),
            unchanged: async () => (await groups.get(doomed.id))?.memberCount === 1,
          };
        },
      },
      {
        action: 'token.issued',
        make: async () => {
          const person = await account();
          return {
            run: () => tokens.issue({ userId: person.id, role: person.role }, { name: 'x' }, actor),
            unchanged: async () => (await tokens.listFor(person.id, true)).length === 0,
          };
        },
      },
      {
        action: 'account.mfaEnabled',
        make: async () => {
          const person = await account();
          const { secret } = await totp.beginEnrolment(person.id, person.login);
          planted.push(secret);
          return {
            run: () => totp.confirmEnrolment(person.id, codeFor(secret), actor),
            unchanged: async () => !(await totp.isEnrolled(person.id)),
          };
        },
      },
    ];

    for (const { action, make } of failing) {
      it(`leaves no ${action} entry, and no change, when the change fails`, async () => {
        const arranged = await make();
        const before = (await rows(action)).length;
        sink.failOn = action;
        try {
          await assert.rejects(arranged.run, /failing after recording/);
        } finally {
          sink.failOn = null;
        }
        assert.equal((await rows(action)).length, before, 'the entry outlived its change');
        assert.ok(await arranged.unchanged(), 'the change outlived its failure');
      });
    }

    // --------------------------------------------------------------------------- redaction

    it('holds no password, token, TOTP secret or recovery code, in any encoding', async () => {
      planted.push(PASSWORD);
      planted.push(...(await hashesOf('user_account', 'password_hash')));
      planted.push(...(await hashesOf('api_token', 'token_hash')));
      planted.push(...(await hashesOf('user_totp', 'secret')));

      const text = (
        await db.query<{ row: string }>(
          `SELECT concat_ws(' ', action, actor_ref, actor_label, summary::text, diff::text) AS row
           FROM audit_log`,
        )
      )
        .map((one) => one.row)
        .join('\n');

      const leaks: string[] = [];
      for (const secret of new Set(planted.filter((one) => one.length >= 8))) {
        const bytes = Buffer.from(secret);
        const renderings: [string, string][] = [
          ['text', secret],
          ['base64', bytes.toString('base64')],
          ['base64url', bytes.toString('base64url')],
          ['hex', bytes.toString('hex')],
          ['bytes', JSON.stringify([...bytes]).slice(1, -1)],
        ];
        for (const [how, form] of renderings) {
          if (text.includes(form)) leaks.push(`${secret.slice(0, 6)}… as ${how}`);
        }
      }
      assert.deepEqual(leaks, []);

      // The hunt found something to hunt for, and the entries it searched exist.
      const kinds = await db.query<{ action: string }>(
        `SELECT DISTINCT action FROM audit_log ORDER BY action`,
      );
      for (const action of [
        'account.created',
        'account.passwordChanged',
        'account.mfaEnabled',
        'account.recoveryCodesRegenerated',
        'token.issued',
      ]) {
        assert.ok(
          kinds.some((one) => one.action === action),
          `no ${action} entry, so its absence of secrets proves nothing`,
        );
      }
      assert.ok(planted.length > 40, `only ${String(planted.length)} secrets were planted`);
    });

    async function hashesOf(table: string, column: string, userId?: number): Promise<string[]> {
      const found = await db.query<{ value: string }>(
        `SELECT ${column}::text AS value FROM ${table}
         ${userId === undefined ? '' : 'WHERE user_id = $1'}`,
        userId === undefined ? [] : [userId],
      );
      return found.map((one) => one.value);
    }
  },
);
