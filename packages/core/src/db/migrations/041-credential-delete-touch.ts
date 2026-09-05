import type { Migration } from './types.js';

/**
 * Revoking a credential must invalidate the ETag (`P-92`).
 *
 * `credential_set_touch_owner` fired `AFTER INSERT OR UPDATE` only. Every sibling trigger that
 * guards inherited content — `object_setting_touch_owner`, `object_pause_touch_owner`,
 * `probe_config_touch_owner`, `notification_trigger_touch_owner` — includes DELETE, and
 * `object_setting`'s carries a comment saying why: reverting to inherit changes the effective
 * state an operator is looking at, so it must invalidate the ETag.
 *
 * A revocation is the same shape and a worse consequence. `CredentialVault.clear` is a plain
 * `DELETE FROM credential_set` and nothing else writes to `object`, so no version moved;
 * `chainValidator` is an md5 of `(id, version)` up the ancestor chain, so the digest for
 * `GET /objects/:id?include=credentials` was unchanged by the revocation. A client holding the
 * previous ETag got a 304 and went on rendering — and acting on — a credential set that no
 * longer exists. That is precisely what the route's own comment says the chain digest exists to
 * prevent: "a 304 there would hide a revoked credential".
 *
 * `object_touch_owner` already handles `TG_OP = 'DELETE'` through `OLD.object_id`, so this is
 * the trigger definition and nothing else.
 */
export const migration041: Migration = {
  id: 41,
  name: 'credential-delete-touch',

  up: `
    DROP TRIGGER IF EXISTS credential_set_touch_owner ON credential_set;

    CREATE TRIGGER credential_set_touch_owner
      AFTER INSERT OR UPDATE OR DELETE ON credential_set
      FOR EACH ROW EXECUTE FUNCTION object_touch_owner();
  `,

  down: `
    DROP TRIGGER IF EXISTS credential_set_touch_owner ON credential_set;

    CREATE TRIGGER credential_set_touch_owner
      AFTER INSERT OR UPDATE ON credential_set
      FOR EACH ROW EXECUTE FUNCTION object_touch_owner();
  `,
};
