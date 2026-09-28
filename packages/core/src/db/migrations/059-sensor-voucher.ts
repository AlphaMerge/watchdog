import type { Migration } from './types.js';

/**
 * Who vouched for a sensor, and the state it is in when that is no longer enough (`A-29`).
 *
 * **A sensor that republishes another object's data is evaluated through its voucher's eyes.** A
 * Sensor Factory, a Probe Health sensor and a Core Health sensor publish what they read to
 * everybody who can read them, so the account that last wrote one's parameters, moved it or cloned
 * it — having passed the check `ObjectService` makes on every such write — is recorded here, and
 * the core re-checks it every sweep. `A-22`'s reasoning about a share link, applied to a sensor:
 * a delegation must not outlive the right it was made from.
 *
 * **`vouched_by` says which kind, and `vouched_by_user` which account.** `installation` is the
 * core itself, a discovery run from a template an administrator installed, or an installation with
 * the authorisation layer off. `account` with a NULL user is an account since deleted: the column
 * goes NULL with it, as `map_share.created_by_user` does (054), and the sensor stops being
 * evaluated until somebody saves it again — a deleted author is not the system. Written only for
 * the types that declare what they read; for every other sensor it is never consulted.
 *
 * **The backfill asks the audit log** who last created the sensor or wrote its parameters. When
 * that was an account that still exists — directly, or through one of its tokens, which is who a
 * token's write vouches as from now on — it vouches, and the sweep will find out at once whether
 * it can still read what the sensor names — which is the whole point, since `A-29` was found in
 * sensors that already existed. Anything else — the system, an account since deleted, a sensor
 * with no row of its own (the sensors inside a clone are recorded under the clone's root) —
 * vouches as the installation. That is the permissive reading, and it is taken deliberately: making every Core
 * Health and Probe Health sensor an administrator set up read Unknown on upgrade would be the
 * self-monitoring switching itself off, which `CLAUDE.md` rules out harder than it rules out
 * anything here.
 *
 * **`access` joins the causes**, because it says why a state changed — the reason `037` gave for
 * not adding `carried` as one does not apply. `ALTER TYPE … ADD VALUE` is transactional on
 * PostgreSQL 12 and later as long as nothing uses the value in the same transaction (024, 050).
 *
 * **The rollback rewrites `access` as `scan`, and says so.** PostgreSQL has no `DROP VALUE`, so the
 * type is rebuilt and every column holding it cast across, which cannot carry a row still naming
 * the removed value. The state and the message on those rows survive; only the word for why is
 * lost, and `scan` is what an Unknown sensor with nothing measured has always carried.
 * `sensor_state` is a hypertable but not a compressed one, so the cast reaches every chunk.
 */
export const migration059: Migration = {
  id: 59,
  name: 'sensor-voucher',

  up: `
    ALTER TABLE sensor_config
      ADD COLUMN vouched_by text NOT NULL DEFAULT 'installation'
        CHECK (vouched_by IN ('account', 'installation')),
      ADD COLUMN vouched_by_user bigint REFERENCES user_account(id) ON DELETE SET NULL,
      ADD CONSTRAINT sensor_config_voucher_is_an_account
        CHECK (vouched_by = 'account' OR vouched_by_user IS NULL);

    -- Compared as text: actor_ref holds a component name for the system and an id for a person
    -- or a token, and a cast would fail on the first row that is neither. A revoked token still
    -- has its row, and its owner is who wrote through it.
    UPDATE sensor_config sc
    SET vouched_by = 'account', vouched_by_user = who.user_id
    FROM (
      SELECT DISTINCT ON (a.object_id) a.object_id, a.actor_kind, a.actor_ref
      FROM audit_log a
      WHERE a.object_kind = 'sensor'
        AND (a.action = 'object.created'
             OR (a.action = 'object.updated' AND a.summary ? 'paramsChanged'))
      ORDER BY a.object_id, a.at DESC, a.id DESC
    ) last
    JOIN (
      SELECT 'user' AS kind, id::text AS ref, id AS user_id FROM user_account
      UNION ALL
      SELECT 'token', id::text, user_id FROM api_token
    ) who ON who.kind = last.actor_kind AND who.ref = last.actor_ref
    WHERE sc.object_id = last.object_id;

    COMMENT ON COLUMN sensor_config.vouched_by IS
      'Who the core evaluates this sensor through, for a type that names what it reads (A-29).';
    COMMENT ON COLUMN sensor_config.vouched_by_user IS
      'The vouching account; NULL with vouched_by = account means it was deleted (A-29).';

    ALTER TYPE sensor_state_cause ADD VALUE IF NOT EXISTS 'access' BEFORE 'simulated';
  `,

  down: `
    -- The word for why is lost on these rows; see the comment above.
    UPDATE sensor_state SET cause = 'scan' WHERE cause = 'access';
    UPDATE sensor_runtime SET cause = 'scan' WHERE cause = 'access';
    UPDATE sensor_runtime SET channel_cause = 'scan' WHERE channel_cause = 'access';

    ALTER TYPE sensor_state_cause RENAME TO sensor_state_cause_old;
    CREATE TYPE sensor_state_cause AS ENUM (
      'scan', 'limit', 'lookup', 'user', 'schedule', 'dependency', 'parent', 'probe', 'simulated'
    );
    ALTER TABLE sensor_state
      ALTER COLUMN cause TYPE sensor_state_cause USING cause::text::sensor_state_cause;
    ALTER TABLE sensor_runtime ALTER COLUMN cause DROP DEFAULT;
    ALTER TABLE sensor_runtime
      ALTER COLUMN cause TYPE sensor_state_cause USING cause::text::sensor_state_cause,
      ALTER COLUMN channel_cause TYPE sensor_state_cause USING channel_cause::text::sensor_state_cause;
    ALTER TABLE sensor_runtime ALTER COLUMN cause SET DEFAULT 'scan';
    DROP TYPE sensor_state_cause_old;

    ALTER TABLE sensor_config
      DROP CONSTRAINT sensor_config_voucher_is_an_account,
      DROP COLUMN vouched_by_user,
      DROP COLUMN vouched_by;
  `,
};
