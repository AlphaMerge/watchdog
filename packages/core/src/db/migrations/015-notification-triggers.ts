import type { Migration } from './types.js';

/**
 * Notification triggers (`N-01`).
 *
 * A trigger says *when* to notify; `N-05`'s template says what to send and how. They are
 * separate because one template serves many triggers — "page the on-call rota" is written once —
 * and because the two are edited by different people at different times.
 *
 * **Inherited by accumulation, not by nearest-ancestor.** Every other inheritable thing in this
 * system resolves to one value from the closest ancestor that defines it, which is why
 * `InheritanceResolver` exists and why `CLAUDE.md` insists everything go through it. A trigger
 * is not a setting with a value: `CAPABILITIES.MD §5.1` says a child's trigger tab shows "both
 * its own and every inherited trigger", so the effective set is the **union** along the chain. A
 * state trigger on the root and a threshold trigger on one device both apply to that device's
 * sensors, and neither displaces the other. That is a different rule, so it is a different
 * table and a different query — not a quiet reinterpretation of the resolver's.
 *
 * **Settings are jsonb behind a JSON Schema**, exactly as `sensor_config.params` are. The two
 * v1 kinds share almost no fields, `[V2]` adds three more, and the schema is what generates the
 * form and validates the API — one declaration rather than a column set per kind and a migration
 * every time one arrives.
 */
export const migration015: Migration = {
  id: 15,
  name: 'notification-triggers',

  up: `
    CREATE TABLE notification_trigger (
      id         bigserial PRIMARY KEY,
      -- Any object. A trigger on the root applies to every sensor in the installation, which is
      -- WORKFLOW.MD §6's own example of what inheritance is for.
      object_id  bigint NOT NULL REFERENCES object (id) ON DELETE CASCADE,
      kind       text NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),
      settings   jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
      -- Off without being deleted. An operator silencing a trigger for an afternoon should not
      -- have to rebuild it afterwards, and a deleted trigger takes its history with it.
      enabled    boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- The trigger tab, and the engine's "what applies to this sensor" walk: both start from an
    -- object id and both want every row for it.
    CREATE INDEX notification_trigger_object_idx ON notification_trigger (object_id);

    CREATE TRIGGER notification_trigger_set_updated_at
      BEFORE UPDATE ON notification_trigger
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Editing a trigger changes what leaves the building, which is a configuration change like
    -- any other: the same trigger that versions an object's side tables versions this, so R-04's
    -- push and the ETag both see it.
    CREATE TRIGGER notification_trigger_touch_owner
      AFTER INSERT OR UPDATE OR DELETE ON notification_trigger
      FOR EACH ROW EXECUTE FUNCTION object_touch_owner();
  `,

  down: `
    DROP TRIGGER IF EXISTS notification_trigger_touch_owner ON notification_trigger;
    DROP TRIGGER IF EXISTS notification_trigger_set_updated_at ON notification_trigger;
    DROP INDEX IF EXISTS notification_trigger_object_idx;
    DROP TABLE IF EXISTS notification_trigger;
  `,
};
