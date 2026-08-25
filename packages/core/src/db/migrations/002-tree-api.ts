import type { Migration } from './types.js';

/**
 * Everything the tree CRUD API (S-03) needs that the object model (S-02) did not ship.
 *
 * Three additions, each with a reason that is not "the API would like it":
 *
 * 1. **A device's address.** `CAPABILITIES.MD` §1 defines a device as "an IP address or DNS
 *    name + credentials", and `WORKFLOW.MD` §2 requires discovery to "match on IP/DNS name
 *    within the target group" to stay idempotent. S-02 shipped nowhere to put it.
 * 2. **An optimistic-concurrency version.** Two operators on one settings form, last write
 *    wins, and the second save silently reverts the first — on a channel limit that is a
 *    missed alarm.
 * 3. **Indexes for the two cursor orders** and for case-folded tag matching.
 */
export const migration002: Migration = {
  id: 2,
  name: 'tree-api',

  up: `
    -- ---------------------------------------------------------------------------------------
    -- 1. Device address.
    --
    -- Deliberately NOT an object_setting: a host is not inheritable, and a sparse inheritance
    -- row would let a device with no address of its own silently resolve to its parent's.
    -- ---------------------------------------------------------------------------------------
    CREATE TABLE device_config (
      object_id  bigint PRIMARY KEY REFERENCES object (id) ON DELETE CASCADE,
      host       text NOT NULL CHECK (length(host) BETWEEN 1 AND 255),
      -- PRTG's per-device IPv4/IPv6 selector; the Ping sensor (P-08) picks its family from it.
      ip_version text NOT NULL DEFAULT 'auto' CHECK (ip_version IN ('auto', 'v4', 'v6')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- Discovery matches on IP/DNS within a group, and DNS names are case-insensitive.
    CREATE INDEX device_config_host_idx ON device_config (lower(host));

    CREATE FUNCTION device_config_check_kind() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF (SELECT kind FROM object WHERE id = NEW.object_id) <> 'device' THEN
          RAISE EXCEPTION 'device_config may only describe an object of kind device'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$;

    CREATE TRIGGER device_config_kind_check
      BEFORE INSERT OR UPDATE OF object_id ON device_config
      FOR EACH ROW EXECUTE FUNCTION device_config_check_kind();

    CREATE TRIGGER device_config_set_updated_at
      BEFORE UPDATE ON device_config
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ---------------------------------------------------------------------------------------
    -- 2. Optimistic concurrency.
    --
    -- A counter, not updated_at: now() is transaction-start time, so two transactions that
    -- begin in the same microsecond produce identical validators and a lost update slips
    -- through the check that exists to catch it.
    -- ---------------------------------------------------------------------------------------
    ALTER TABLE object ADD COLUMN version integer NOT NULL DEFAULT 1;

    CREATE FUNCTION object_touch() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        NEW.updated_at := now();
        NEW.version := OLD.version + 1;
        RETURN NEW;
      END;
      $$;

    DROP TRIGGER object_set_updated_at ON object;

    CREATE TRIGGER object_touch_row
      BEFORE UPDATE ON object
      FOR EACH ROW EXECUTE FUNCTION object_touch();

    -- An ETag must mean "the state the form was rendered from". A settings form shows
    -- inherited values and channel limits, none of which live on the object row — and
    -- InheritanceResolver.set() writes object_setting directly and knows nothing about ETags.
    -- So the version bump belongs to the database, not to whichever code path happened to
    -- remember it.
    CREATE FUNCTION object_touch_owner() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        owner_id bigint;
      BEGIN
        -- A clone inserts thousands of rows into objects that are seconds old and whose ETag
        -- nobody holds. Suppressing the bump there turns O(rows) extra UPDATEs into zero.
        IF coalesce(current_setting('ms.bulk_load', true), 'off') = 'on' THEN
          RETURN NULL;
        END IF;

        -- Branch with IF, not a CASE expression: plpgsql hands the whole expression to the
        -- SQL executor, which resolves every field reference in it against the record it was
        -- given. A CASE mentioning both NEW.sensor_id and NEW.object_id therefore fails on
        -- sensor_config with 'record "new" has no field "sensor_id"'. Only the taken branch
        -- of an IF is ever evaluated.
        IF TG_TABLE_NAME = 'channel' THEN
          IF TG_OP = 'DELETE' THEN
            owner_id := OLD.sensor_id;
          ELSE
            owner_id := NEW.sensor_id;
          END IF;
        ELSE
          IF TG_OP = 'DELETE' THEN
            owner_id := OLD.object_id;
          ELSE
            owner_id := NEW.object_id;
          END IF;
        END IF;

        -- object_touch() does the increment; this statement only has to touch the row.
        UPDATE object SET updated_at = now() WHERE id = owner_id;
        RETURN NULL;
      END;
      $$;

    CREATE TRIGGER sensor_config_touch_owner
      AFTER INSERT OR UPDATE ON sensor_config
      FOR EACH ROW EXECUTE FUNCTION object_touch_owner();

    CREATE TRIGGER device_config_touch_owner
      AFTER INSERT OR UPDATE ON device_config
      FOR EACH ROW EXECUTE FUNCTION object_touch_owner();

    CREATE TRIGGER channel_touch_owner
      AFTER INSERT OR UPDATE ON channel
      FOR EACH ROW EXECUTE FUNCTION object_touch_owner();

    CREATE TRIGGER credential_set_touch_owner
      AFTER INSERT OR UPDATE ON credential_set
      FOR EACH ROW EXECUTE FUNCTION object_touch_owner();

    -- object_setting alone also fires on DELETE: reverting to inherit changes the effective
    -- state an operator is looking at, so it must invalidate the ETag.
    CREATE TRIGGER object_setting_touch_owner
      AFTER INSERT OR UPDATE OR DELETE ON object_setting
      FOR EACH ROW EXECUTE FUNCTION object_touch_owner();

    -- ---------------------------------------------------------------------------------------
    -- 3. Indexes.
    --
    -- Keyset pagination, not OFFSET: measured on 50,000 siblings, a deep OFFSET page costs
    -- 12.3 ms and 40,344 buffers against 0.2 ms and ~150 for the keyset equivalent. Sibling
    -- names are not unique, so 'id' is the tiebreaker and belongs in the index.
    -- ---------------------------------------------------------------------------------------
    CREATE INDEX object_parent_name_id_idx ON object (parent_id, name, id);
    DROP INDEX object_parent_name_idx;
    CREATE INDEX object_name_id_idx ON object (name, id);

    -- CAPABILITIES.MD §1: tags are case-insensitive. object_tags_idx is a GIN index on 'tags'
    -- as written, which a folded match cannot use.
    --
    -- The fold goes through an IMMUTABLE function rather than an inline expression because
    -- PostgreSQL rejects a subquery in an index expression outright:
    --   ERROR: cannot use subquery in index expression
    CREATE FUNCTION tags_folded(tags text[]) RETURNS text[]
      LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
      AS $$ SELECT coalesce(array_agg(lower(t)), '{}'::text[]) FROM unnest(tags) AS t $$;

    CREATE INDEX object_tags_folded_idx ON object USING gin (tags_folded(tags));
  `,

  down: `
    DROP INDEX IF EXISTS object_tags_folded_idx;
    DROP FUNCTION IF EXISTS tags_folded(text[]);
    DROP INDEX IF EXISTS object_name_id_idx;
    CREATE INDEX object_parent_name_idx ON object (parent_id, name);
    DROP INDEX IF EXISTS object_parent_name_id_idx;

    DROP TRIGGER IF EXISTS object_setting_touch_owner ON object_setting;
    DROP TRIGGER IF EXISTS credential_set_touch_owner ON credential_set;
    DROP TRIGGER IF EXISTS channel_touch_owner ON channel;
    DROP TRIGGER IF EXISTS device_config_touch_owner ON device_config;
    DROP TRIGGER IF EXISTS sensor_config_touch_owner ON sensor_config;
    DROP FUNCTION IF EXISTS object_touch_owner();

    DROP TRIGGER IF EXISTS object_touch_row ON object;
    DROP FUNCTION IF EXISTS object_touch();
    CREATE TRIGGER object_set_updated_at
      BEFORE UPDATE ON object
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    ALTER TABLE object DROP COLUMN version;

    DROP TABLE IF EXISTS device_config;
    DROP FUNCTION IF EXISTS device_config_check_kind();
  `,
};
