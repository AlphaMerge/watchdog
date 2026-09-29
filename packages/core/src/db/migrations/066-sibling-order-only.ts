import type { Migration } from './types.js';

/**
 * A hidden sibling's place, written without touching it (`A-46`).
 *
 * A reorder moves an object among the siblings its caller can see, and every sibling the caller
 * cannot see keeps its index. On a parent nobody has arranged every `sort_order` is NULL and the
 * order is by name, and a NULL sorts after every value, so keeping a hidden sibling where it is
 * means writing the index it already has into its row. Nothing about that object has changed,
 * and its owners hold validators for it: a bump would answer their next `If-Match` write 412 for
 * a change made by somebody who may not touch it, and one they cannot see.
 *
 * **Asked for, and for the one column.** The bump is skipped only while the transaction has set
 * `ms.sibling_order_only` and `sort_order` is the only column that differs. Anything else in the
 * same statement bumps as before, and the repository clears the setting straight after the one
 * statement it is for, so a later write in the same transaction bumps too.
 *
 * The rollback puts back 002's body, the bump on every update, byte for byte.
 */
export const migration066: Migration = {
  id: 66,
  name: 'sibling-order-only',

  up: `
    CREATE OR REPLACE FUNCTION object_touch() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF coalesce(current_setting('ms.sibling_order_only', true), 'off') = 'on'
           AND NEW.sort_order IS DISTINCT FROM OLD.sort_order
           AND to_jsonb(NEW) - 'sort_order' = to_jsonb(OLD) - 'sort_order' THEN
          RETURN NEW;
        END IF;
        NEW.updated_at := now();
        NEW.version := OLD.version + 1;
        RETURN NEW;
      END;
      $$;
  `,

  down: `
    CREATE OR REPLACE FUNCTION object_touch() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        NEW.updated_at := now();
        NEW.version := OLD.version + 1;
        RETURN NEW;
      END;
      $$;
  `,
};
