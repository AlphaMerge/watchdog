/**
 * A hard ceiling on every recursive walk over the object tree.
 *
 * Cycles are prevented three ways over — a trigger, a pre-check and the tree lock — but a
 * recursive CTE over a cyclic tree does not return a wrong answer, it never returns at all. For a
 * monitoring system a hang is the worst failure mode there is, so every walk is bounded. Migration
 * 001's own cycle check uses the same 1,000-hop limit.
 *
 * **The bound is the defence for the day something else writes `parent_id`** (`A-12`). `S-03`'s
 * cycle prevention is why the walks terminate today; a restore from a hand-edited dump, or a
 * migration that re-parents in bulk with the trigger disabled, is the day it stops being true.
 */
export const MAX_WALK_DEPTH = 1000;
