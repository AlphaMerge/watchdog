import type { Migration } from './types.js';

/**
 * The object tree: Root → Probe → Group → Device → Sensor → Channel (CAPABILITIES.MD §1).
 *
 * One `object` table for probe/group/device/sensor rather than a table per kind. The tree is
 * walked constantly — inheritance resolution, access rights, status rollup, subtree queries —
 * and every one of those becomes a union across four tables if the kinds are split. Kind-specific
 * columns live in `sensor_config` and `channel`.
 *
 * Naming follows the object model exactly (CLAUDE.md): probe / group / device / sensor /
 * channel. No synonyms.
 */
export const migration001: Migration = {
  id: 1,
  name: 'object-model',

  up: `
    -- ---------------------------------------------------------------------------------------
    -- Object kinds. Root is a single implicit row so that inheritable settings have somewhere
    -- to live at the top of the tree.
    -- ---------------------------------------------------------------------------------------
    CREATE TYPE object_kind AS ENUM ('root', 'probe', 'group', 'device', 'sensor');

    CREATE TABLE object (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      parent_id   bigint REFERENCES object (id) ON DELETE CASCADE,
      kind        object_kind NOT NULL,
      name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
      -- Tags are matched case-insensitively (CAPABILITIES.MD §1); stored as written, compared
      -- folded. Inherited tags are resolved at query time, never denormalised onto children.
      tags        text[] NOT NULL DEFAULT '{}',
      priority    smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
      comments    text NOT NULL DEFAULT '',
      -- Pause and dependency state live here in Phase 3 (M-08…M-12); the columns arrive with
      -- the logic that maintains them.
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),

      -- Exactly one root, and only the root has no parent.
      CONSTRAINT object_root_has_no_parent
        CHECK ((kind = 'root') = (parent_id IS NULL))
    );

    CREATE UNIQUE INDEX object_single_root ON object ((kind)) WHERE kind = 'root';

    -- The hot path is "children of X" and "walk to the root", so index the parent edge.
    CREATE INDEX object_parent_idx ON object (parent_id);
    CREATE INDEX object_kind_idx ON object (kind);
    -- Tag filtering across the whole tree (CAPABILITIES.MD §1) wants an inverted index.
    CREATE INDEX object_tags_idx ON object USING gin (tags);
    -- Name search within a parent, and the sort order the device tree renders in.
    CREATE INDEX object_parent_name_idx ON object (parent_id, name);

    -- ---------------------------------------------------------------------------------------
    -- Which kinds may contain which. Enforced in the database because a malformed tree breaks
    -- inheritance, rollup and access control simultaneously.
    -- ---------------------------------------------------------------------------------------
    CREATE FUNCTION object_parent_kind_is_valid(child object_kind, parent object_kind)
      RETURNS boolean
      LANGUAGE sql IMMUTABLE
      AS $$
        SELECT CASE child
          WHEN 'probe'  THEN parent = 'root'
          WHEN 'group'  THEN parent IN ('probe', 'group')
          WHEN 'device' THEN parent IN ('probe', 'group')
          WHEN 'sensor' THEN parent = 'device'
          ELSE false
        END
      $$;

    CREATE FUNCTION object_check_hierarchy() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        parent_kind object_kind;
      BEGIN
        IF NEW.kind = 'root' THEN
          RETURN NEW;
        END IF;

        IF NEW.parent_id IS NULL THEN
          RAISE EXCEPTION 'a % must have a parent; only the root has none', NEW.kind
            USING ERRCODE = 'check_violation';
        END IF;

        SELECT kind INTO parent_kind FROM object WHERE id = NEW.parent_id;
        IF parent_kind IS NULL THEN
          RAISE EXCEPTION 'parent object % does not exist', NEW.parent_id
            USING ERRCODE = 'foreign_key_violation';
        END IF;

        IF NOT object_parent_kind_is_valid(NEW.kind, parent_kind) THEN
          RAISE EXCEPTION 'a % may not be a child of a %', NEW.kind, parent_kind
            USING ERRCODE = 'check_violation';
        END IF;

        RETURN NEW;
      END;
      $$;

    CREATE TRIGGER object_hierarchy_check
      BEFORE INSERT OR UPDATE OF parent_id, kind ON object
      FOR EACH ROW EXECUTE FUNCTION object_check_hierarchy();

    -- ---------------------------------------------------------------------------------------
    -- Cycle prevention. ON DELETE CASCADE plus a self-reference means a cycle is not merely
    -- wrong, it is unrecoverable: the subtree becomes unreachable and undeletable.
    -- ---------------------------------------------------------------------------------------
    CREATE FUNCTION object_check_no_cycle() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        ancestor bigint := NEW.parent_id;
        hops int := 0;
      BEGIN
        WHILE ancestor IS NOT NULL LOOP
          IF ancestor = NEW.id THEN
            RAISE EXCEPTION 'moving object % under % would create a cycle', NEW.id, NEW.parent_id
              USING ERRCODE = 'check_violation';
          END IF;
          hops := hops + 1;
          IF hops > 1000 THEN
            RAISE EXCEPTION 'object tree is deeper than 1000 levels, refusing to walk further'
              USING ERRCODE = 'check_violation';
          END IF;
          SELECT parent_id INTO ancestor FROM object WHERE id = ancestor;
        END LOOP;
        RETURN NEW;
      END;
      $$;

    CREATE TRIGGER object_no_cycle_check
      BEFORE UPDATE OF parent_id ON object
      FOR EACH ROW WHEN (NEW.parent_id IS DISTINCT FROM OLD.parent_id)
      EXECUTE FUNCTION object_check_no_cycle();

    -- ---------------------------------------------------------------------------------------
    -- updated_at maintenance, so callers cannot forget it.
    -- ---------------------------------------------------------------------------------------
    CREATE FUNCTION set_updated_at() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        NEW.updated_at := now();
        RETURN NEW;
      END;
      $$;

    CREATE TRIGGER object_set_updated_at
      BEFORE UPDATE ON object
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ---------------------------------------------------------------------------------------
    -- Sensor configuration. One row per sensor object.
    --
    -- NULL means "inherit from the nearest ancestor that defines it" (CAPABILITIES.MD §1,
    -- S-04). That is why every inheritable column is nullable and has no default: a default
    -- would silently become an explicit local value and break revert-to-inherit.
    -- ---------------------------------------------------------------------------------------
    CREATE TABLE sensor_config (
      object_id      bigint PRIMARY KEY REFERENCES object (id) ON DELETE CASCADE,
      -- The sensor type id from the plugin registry, e.g. 'snmp.traffic' (ADR-001 Decision 7).
      type           text NOT NULL CHECK (length(type) BETWEEN 1 AND 100),
      -- Validated against the type's paramsSchema at the API boundary, not here.
      params         jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    );

    -- Scan interval, timeout and retry policy are *inheritable* and therefore live in
    -- object_setting below, not here. A group setting the interval for everything beneath it is
    -- the normal case; columns on sensor_config could not express it.

    CREATE INDEX sensor_config_type_idx ON sensor_config (type);

    CREATE TRIGGER sensor_config_set_updated_at
      BEFORE UPDATE ON sensor_config
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE FUNCTION sensor_config_check_kind() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF (SELECT kind FROM object WHERE id = NEW.object_id) <> 'sensor' THEN
          RAISE EXCEPTION 'sensor_config may only describe an object of kind sensor'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$;

    CREATE TRIGGER sensor_config_kind_check
      BEFORE INSERT OR UPDATE OF object_id ON sensor_config
      FOR EACH ROW EXECUTE FUNCTION sensor_config_check_kind();

    -- ---------------------------------------------------------------------------------------
    -- Inheritable settings (CAPABILITIES.MD §1, S-04).
    --
    -- Sparse by design: a row exists only where an object *explicitly* defines a setting.
    -- Absence means "inherit from the nearest ancestor that does", and reverting to inherit is
    -- a DELETE — which is what makes it discard the local value rather than remember it.
    --
    -- One generic table rather than a column per setting. PRTG has dozens of inheritable
    -- settings and they all behave identically; a column each would mean a migration per
    -- setting and a resolver that grows a branch per column. Values are validated against the
    -- setting registry at the API boundary.
    -- ---------------------------------------------------------------------------------------
    CREATE TABLE object_setting (
      object_id  bigint NOT NULL REFERENCES object (id) ON DELETE CASCADE,
      key        text NOT NULL CHECK (length(key) BETWEEN 1 AND 100),
      value      jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (object_id, key)
    );

    -- Resolution walks up the ancestor chain and takes the first row per key, so the lookup is
    -- always (object_id, key). The reverse index answers "who overrides this setting?".
    CREATE INDEX object_setting_key_idx ON object_setting (key);

    CREATE TRIGGER object_setting_set_updated_at
      BEFORE UPDATE ON object_setting
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ---------------------------------------------------------------------------------------
    -- Channels: the series a sensor produces (CAPABILITIES.MD §1.1).
    -- ---------------------------------------------------------------------------------------
    CREATE TABLE channel (
      id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      sensor_id     bigint NOT NULL REFERENCES object (id) ON DELETE CASCADE,
      -- Stable within the sensor and assigned by the sensor type, so a channel keeps its
      -- history across a rename.
      key           text NOT NULL CHECK (length(key) BETWEEN 1 AND 100),
      name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
      unit          text NOT NULL DEFAULT '',
      -- Exactly one primary channel per sensor: the one shown in lists and mini-graphs.
      is_primary    boolean NOT NULL DEFAULT false,
      scale_mul     numeric NOT NULL DEFAULT 1 CHECK (scale_mul <> 0),
      scale_div     numeric NOT NULL DEFAULT 1 CHECK (scale_div <> 0),
      decimals      smallint CHECK (decimals BETWEEN 0 AND 10),
      -- Error and warning limits, upper and lower, with the custom messages that get appended
      -- to the sensor message. NULL means the limit is not set.
      limits        jsonb NOT NULL DEFAULT '{}'::jsonb,
      -- Readings outside [spike_min, spike_max] are discarded (CAPABILITIES.MD §1.1).
      spike_min     double precision,
      spike_max     double precision,
      show_in_graph boolean NOT NULL DEFAULT true,
      show_in_table boolean NOT NULL DEFAULT true,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT channel_key_unique_per_sensor UNIQUE (sensor_id, key),
      CONSTRAINT channel_spike_range CHECK (
        spike_min IS NULL OR spike_max IS NULL OR spike_min <= spike_max
      )
    );

    CREATE UNIQUE INDEX channel_one_primary_per_sensor
      ON channel (sensor_id) WHERE is_primary;

    CREATE INDEX channel_sensor_idx ON channel (sensor_id);

    CREATE TRIGGER channel_set_updated_at
      BEFORE UPDATE ON channel
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ---------------------------------------------------------------------------------------
    -- Credential sets, attached to any object and inherited downward (CAPABILITIES.MD §10).
    --
    -- Secrets are encrypted at rest and never returned by any API route, to anyone, including
    -- administrators (CLAUDE.md). The ciphertext lives in "secret"; "public_params" holds the
    -- parts that are safe to display, such as an SNMP version or a username.
    -- ---------------------------------------------------------------------------------------
    CREATE TYPE credential_kind AS ENUM ('snmp', 'windows', 'ssh', 'vmware', 'database', 'http');

    CREATE TABLE credential_set (
      id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      object_id      bigint NOT NULL REFERENCES object (id) ON DELETE CASCADE,
      kind           credential_kind NOT NULL,
      public_params  jsonb NOT NULL DEFAULT '{}'::jsonb,
      secret         bytea NOT NULL,
      -- Which key encrypted "secret", so the key can be rotated without decrypting everything
      -- up front.
      key_id         text NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),

      -- One credential set per kind per object; a child overrides by defining its own.
      CONSTRAINT credential_set_one_per_kind UNIQUE (object_id, kind)
    );

    CREATE INDEX credential_set_object_idx ON credential_set (object_id);

    CREATE TRIGGER credential_set_set_updated_at
      BEFORE UPDATE ON credential_set
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ---------------------------------------------------------------------------------------
    -- The root object. Created here so the tree is never empty and inheritance always
    -- terminates somewhere.
    -- ---------------------------------------------------------------------------------------
    INSERT INTO object (parent_id, kind, name, comments)
    VALUES (NULL, 'root', 'Root', 'The top of the object tree. Settings defined here are inherited by everything.');
  `,

  down: `
    DROP TABLE IF EXISTS credential_set;
    DROP TABLE IF EXISTS object_setting;
    DROP TYPE IF EXISTS credential_kind;
    DROP TABLE IF EXISTS channel;
    DROP TABLE IF EXISTS sensor_config;
    DROP FUNCTION IF EXISTS sensor_config_check_kind();
    DROP TABLE IF EXISTS object;
    DROP FUNCTION IF EXISTS object_check_no_cycle();
    DROP FUNCTION IF EXISTS object_check_hierarchy();
    DROP FUNCTION IF EXISTS object_parent_kind_is_valid(object_kind, object_kind);
    DROP FUNCTION IF EXISTS set_updated_at();
    DROP TYPE IF EXISTS object_kind;
  `,
};
