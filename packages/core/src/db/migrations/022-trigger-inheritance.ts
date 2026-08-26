import type { Migration } from './types.js';

/**
 * Opting a subtree out of its ancestors' notification triggers (`N-16`).
 *
 * **The gap this closes: "keep monitoring this, but do not notify about it."** A lab, a staging
 * rack, a customer still being onboarded — things that are expected to be broken and whose
 * graphs and uptime an operator still wants. Nothing else in the system says that. A pause and a
 * schedule both stop the *monitoring*, which throws the data away; switching a trigger off where
 * it is defined switches it off for everybody; and a trigger defined lower down cannot help,
 * because trigger inheritance **accumulates** (`N-01`) rather than choosing the nearest — a
 * child's trigger adds to its ancestors' instead of replacing them, so there is no way to write
 * "and nothing from above".
 *
 * **A column on `object`, deliberately not an inheritable setting.** `CLAUDE.md` says inheritable
 * settings go through one resolver, and this is not one: a setting resolves to the nearest
 * ancestor that defines it, so a group set to "do not inherit" would make every descendant
 * resolve "do not inherit" — and each of them would then also ignore *the group's own* triggers,
 * which is the opposite of what was asked for. What is wanted is a fence at one object, and a
 * fence is a property of the object it stands on.
 *
 * The object's own triggers always apply. The flag says nothing about them; it says where the
 * walk stops climbing.
 */
export const migration022: Migration = {
  id: 22,
  name: 'trigger-inheritance',

  up: `
    -- False fences this object off from its ancestors' notification triggers. Its own still
    -- apply, and so do those of everything beneath it that has not fenced itself off in turn.
    ALTER TABLE object
      ADD COLUMN inherits_triggers boolean NOT NULL DEFAULT true;

    -- What both trigger walks ask for: which of these objects stop the descent. Partial, because
    -- an installation fences off a handful of subtrees at most and the default is the answer for
    -- everything else.
    CREATE INDEX object_trigger_fence_idx
      ON object (id)
      WHERE NOT inherits_triggers;
  `,

  down: `
    DROP INDEX IF EXISTS object_trigger_fence_idx;
    ALTER TABLE object DROP COLUMN IF EXISTS inherits_triggers;
  `,
};
