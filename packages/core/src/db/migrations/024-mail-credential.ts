import type { Migration } from './types.js';

/**
 * `mail` joins the credential kinds (`T-17`).
 *
 * **A migration for one enum value, because the kind is a column value.** `credential_set.kind`
 * is a Postgres enum declared in migration 001 with the kinds that were foreseen then — `snmp`,
 * `windows`, `ssh`, `vmware`, `database`, `http`. Mail was not among them, and the registry in
 * `packages/sensors/src/credentials` is explicitly a mirror of this list rather than the other
 * way round: an installation that could store a kind the database rejects would fail at the
 * moment somebody types a password in, which is the worst possible time to find out.
 *
 * **`ALTER TYPE … ADD VALUE` is transactional on PostgreSQL 12 and later**, as long as the new
 * value is not *used* in the same transaction. It is not used here.
 *
 * **The rollback recreates the type, and it deletes mail credentials on the way.** Postgres has
 * no `DROP VALUE`: taking a value out means building the enum again without it and casting the
 * column across, which cannot carry rows still holding the removed value. That is genuine data
 * loss and it is stated rather than hidden — it is also the only sensible reading of "roll back
 * the migration that introduced mail credentials", since the alternative is a rollback that
 * silently leaves rows a re-application would collide with.
 */
export const migration024: Migration = {
  id: 24,
  name: 'mail-credential',

  up: `
    ALTER TYPE credential_kind ADD VALUE IF NOT EXISTS 'mail';
  `,

  down: `
    -- Data loss, deliberately: see the comment above. A mail credential cannot survive the
    -- removal of the value that names its kind.
    DELETE FROM credential_set WHERE kind = 'mail';

    ALTER TYPE credential_kind RENAME TO credential_kind_old;
    CREATE TYPE credential_kind AS ENUM ('snmp', 'windows', 'ssh', 'vmware', 'database', 'http');
    ALTER TABLE credential_set
      ALTER COLUMN kind TYPE credential_kind USING kind::text::credential_kind;
    DROP TYPE credential_kind_old;
  `,
};
