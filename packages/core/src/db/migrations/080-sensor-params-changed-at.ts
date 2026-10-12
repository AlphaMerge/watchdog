import type { Migration } from './types.js';

/**
 * When a sensor's parameters last changed, apart from every other write of its row (`P-340`).
 *
 * `P-322` dated a sensor's last configuration change by `sensor_config.updated_at`: a channel its
 * type no longer declares is retired unless a reading came after that, and ingestion takes the
 * same time as the start of `P-321`'s settling minute. But `updated_at` moves on every write of
 * the row, and recording who vouched for a sensor (`A-29`'s `recordVoucher`) is one that changes
 * no parameter. Each moved the boundary past the readings already taken: a channel a newer probe
 * reads was called retired again until its next reading, and a key a promising type does not
 * declare waited another minute to be counted.
 *
 * `params_changed_at` moves only when `params` or `type` does, by a trigger, so every writer —
 * an edit, a discovery, a data migration that rewrites stored parameters — is covered without
 * one of them remembering, as `updated_at`'s own trigger covers them. A write that leaves both as
 * they were keeps the stored time, whatever it sets the column to: the column means what it
 * says. jsonb compares by value, so parameters written again unchanged, in any key order, are
 * not a change.
 *
 * Backfilled from `updated_at`, which is the best date there is, with the row's own triggers held
 * off for the statement: `set_updated_at` would stamp every row with the migration's time, and
 * `sensor_config_touch_owner` would move every sensor's version and refuse every open form. For a
 * row whose last write was a voucher, that is later than its parameters' change, so it behaves as
 * it did before 080 until its parameters next change: no worse, and nothing records the earlier
 * time.
 *
 * The rollback drops the trigger, its function and the column; the readers go back to
 * `updated_at`, as they were.
 */
export const migration080: Migration = {
  id: 80,
  name: 'sensor-params-changed-at',

  up: `
    ALTER TABLE sensor_config ADD COLUMN params_changed_at timestamptz;

    ALTER TABLE sensor_config DISABLE TRIGGER sensor_config_set_updated_at;
    ALTER TABLE sensor_config DISABLE TRIGGER sensor_config_touch_owner;
    UPDATE sensor_config SET params_changed_at = updated_at;
    ALTER TABLE sensor_config ENABLE TRIGGER sensor_config_touch_owner;
    ALTER TABLE sensor_config ENABLE TRIGGER sensor_config_set_updated_at;

    ALTER TABLE sensor_config
      ALTER COLUMN params_changed_at SET DEFAULT now(),
      ALTER COLUMN params_changed_at SET NOT NULL;

    CREATE FUNCTION sensor_config_params_changed() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.params IS DISTINCT FROM OLD.params OR NEW.type IS DISTINCT FROM OLD.type THEN
          NEW.params_changed_at := now();
        ELSE
          NEW.params_changed_at := OLD.params_changed_at;
        END IF;
        RETURN NEW;
      END;
      $$;

    CREATE TRIGGER sensor_config_params_changed
      BEFORE UPDATE ON sensor_config
      FOR EACH ROW EXECUTE FUNCTION sensor_config_params_changed();

    COMMENT ON COLUMN sensor_config.params_changed_at IS
      'When params or type last changed; no other write moves it. A row from before 080 holds its last write of any kind (P-340).';
  `,

  down: `
    DROP TRIGGER sensor_config_params_changed ON sensor_config;
    DROP FUNCTION sensor_config_params_changed();
    ALTER TABLE sensor_config DROP COLUMN params_changed_at;
  `,
};
