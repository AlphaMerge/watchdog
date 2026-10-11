import type { Migration } from './types.js';

/**
 * What each rule-applying start-up pass last finished under (`P-333`).
 *
 * S-18's declared limits and P-323's declared primaries went over every sensor at every start, to
 * find nothing on every start but the first after a change. Each now stores the rules it applied,
 * as an opaque string it computes, and runs only when that string differs or was never recorded.
 * One row per pass, written only when the pass finished: one that stopped short is run again.
 *
 * The rollback drops the table; every pass then runs at the next start, as it did before this.
 */
export const migration077: Migration = {
  id: 77,
  name: 'startup-pass',

  up: `
    CREATE TABLE startup_pass (
      name text PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 64),
      rules text NOT NULL CHECK (length(rules) BETWEEN 1 AND 200),
      completed_at timestamptz NOT NULL DEFAULT now()
    );

    COMMENT ON TABLE startup_pass IS
      'The rules each start-up pass last finished under; it runs again only when they change (P-333).';
  `,

  down: `
    DROP TABLE startup_pass;
  `,
};
