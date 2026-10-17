import type { Migration } from './types.js';

/**
 * What `sensor_runtime.failure_phase` holds, said again now that a hold keeps one (`P-407`).
 *
 * Migration 081 described the column as NULL "when the state is not the scan's to explain". Since
 * `P-407` a sensor held for a check its probe refused (`A-41c`) or could not start (`P-265`)
 * carries that check's place beside its words, and neither state is the scan's: the comment told
 * whoever reads the schema the opposite of what those rows hold. The words of 081's own comment
 * stay in 081, since a database that ran it would never see an edit, so this sets them again.
 * `sensor_state.failure_phase`'s comment is still true and is left alone.
 *
 * Only a comment: nothing is read or written, and the rollback puts 081's words back.
 */
export const migration082: Migration = {
  id: 82,
  name: 'held-failure-comment',

  up: `
    COMMENT ON COLUMN sensor_runtime.failure_phase IS
      'The phase the check whose words explain this state failed in (connect, exec, walk, '
      'timeout), a refused or unstarted check''s while it holds the sensor (resolve, startup; '
      'P-407), or NULL when it was not named or the words are not a check''s (P-285).';
  `,

  down: `
    COMMENT ON COLUMN sensor_runtime.failure_phase IS
      'The phase the check that explains this state failed in (connect, exec, walk, timeout), '
      'or NULL when it was not named or the state is not the scan''s to explain (P-285).';
  `,
};
