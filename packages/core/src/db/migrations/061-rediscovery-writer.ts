import type { Migration } from './types.js';

/**
 * Who stands behind a rediscovery rule's range (`A-41`).
 *
 * **A rule chooses the hosts its runs provision**, and a provisioned device receives the
 * credential sets of the group it lands in. So the account that last wrote the rule vouches for
 * what its runs create, the way a person starting a run by hand vouches as `created_by`. A NULL
 * user with `account` is an account since deleted, and vouches for nothing.
 *
 * **The backfill asks the audit log**, as `059` did: the account that last created or edited each
 * rule, directly or through one of its tokens. A rule nobody on record wrote — the system, an
 * account since deleted — vouches as the installation, which is what every rule did before this.
 */
export const migration061: Migration = {
  id: 61,
  name: 'rediscovery-writer',

  up: `
    ALTER TABLE discovery_schedule
      ADD COLUMN written_by text NOT NULL DEFAULT 'installation'
        CHECK (written_by IN ('account', 'installation')),
      ADD COLUMN written_by_user bigint REFERENCES user_account (id) ON DELETE SET NULL,
      ADD CONSTRAINT discovery_schedule_writer_is_an_account
        CHECK (written_by = 'account' OR written_by_user IS NULL);

    UPDATE discovery_schedule ds
    SET written_by = 'account', written_by_user = who.user_id
    FROM (
      SELECT DISTINCT ON ((a.summary->>'scheduleId')::bigint)
             (a.summary->>'scheduleId')::bigint AS rule_id, a.actor_kind, a.actor_ref
      FROM audit_log a
      WHERE a.action IN ('discovery.schedule.created', 'discovery.schedule.updated')
        AND a.summary ? 'scheduleId'
      ORDER BY (a.summary->>'scheduleId')::bigint, a.at DESC, a.id DESC
    ) last
    JOIN (
      SELECT 'user' AS kind, id::text AS ref, id AS user_id FROM user_account
      UNION ALL
      SELECT 'token', id::text, user_id FROM api_token
    ) who ON who.kind = last.actor_kind AND who.ref = last.actor_ref
    WHERE ds.id = last.rule_id;

    COMMENT ON COLUMN discovery_schedule.written_by IS
      'Who vouches for what this rule''s runs provision (A-41).';
  `,

  down: `
    ALTER TABLE discovery_schedule
      DROP CONSTRAINT discovery_schedule_writer_is_an_account,
      DROP COLUMN written_by_user,
      DROP COLUMN written_by;
  `,
};
