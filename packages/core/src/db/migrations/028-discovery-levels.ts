import type { Migration } from './types.js';

/**
 * Discovery levels (D-06).
 *
 * `D-02` left `level` as a two-value seam — sweep only, or sweep and identify — and said this
 * ticket would grow it. It grows to three, and the middle one is the old `identify` renamed:
 * "standard" is what CAPABILITIES.MD §7 calls it and what an operator picks without thinking.
 *
 * **The rename happens in the migration rather than in a compatibility branch in the code.**
 * There is exactly one place that has to know the old spelling, and it is this file — a reader
 * in the service would be a second one, live for ever, that nobody could safely delete.
 *
 * `templates` is the other half of the level idea: which templates a run may use, empty meaning
 * all of them. PRTG calls it a template-based discovery; here it is a filter rather than a
 * fourth level, because "detailed, but only these templates" is a thing somebody wants and a
 * fourth level could not express.
 */
export const migration028: Migration = {
  id: 28,
  name: 'discovery-levels',

  up: `
    ALTER TABLE discovery_run DROP CONSTRAINT IF EXISTS discovery_run_level_check;
    UPDATE discovery_run SET level = 'standard' WHERE level = 'identify';
    ALTER TABLE discovery_run ALTER COLUMN level SET DEFAULT 'standard';
    ALTER TABLE discovery_run
      ADD CONSTRAINT discovery_run_level_check
        CHECK (level IN ('ping', 'standard', 'detailed'));

    ALTER TABLE discovery_run
      -- Empty means every template the catalogue holds. An array rather than a join table: it
      -- is a short list of ids chosen once when the run is created and never edited, and a
      -- template id is a string this database has no other table for.
      ADD COLUMN templates text[] NOT NULL DEFAULT '{}';
  `,

  down: `
    ALTER TABLE discovery_run DROP COLUMN templates;
    ALTER TABLE discovery_run DROP CONSTRAINT IF EXISTS discovery_run_level_check;
    -- Detailed collapses into the level it is a more thorough version of; there is nowhere else
    -- for it to go, and the runs it names are finished by the time anybody rolls back.
    UPDATE discovery_run SET level = 'identify' WHERE level IN ('standard', 'detailed');
    ALTER TABLE discovery_run ALTER COLUMN level SET DEFAULT 'identify';
    ALTER TABLE discovery_run
      ADD CONSTRAINT discovery_run_level_check CHECK (level IN ('ping', 'identify'));
  `,
};
