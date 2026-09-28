import type { Migration } from './types.js';

/**
 * What stopped a rediscovery rule the last time it fired (`A-28`).
 *
 * **A rule that is refused has to say so where somebody looks.** A rediscovery fires unattended,
 * so a refusal at that moment reaches nobody: before this it was a log line, and the rule simply
 * stopped producing runs while the discovery page went on showing it as enabled and due. `A-28`
 * made that refusal ordinary — a group moved under another probe, and its rule may no longer
 * sweep from the old one — so the reason is kept on the rule, in the sentence the refusal used,
 * and cleared by the next run that starts.
 *
 * Text rather than a code: what an operator acts on is the sentence, and the log already has the
 * structured form.
 */
export const migration055: Migration = {
  id: 55,
  name: 'rediscovery-problem',

  up: `
    ALTER TABLE discovery_schedule
      ADD COLUMN last_problem text NOT NULL DEFAULT '' CHECK (length(last_problem) <= 1000);
  `,

  down: `
    ALTER TABLE discovery_schedule DROP COLUMN IF EXISTS last_problem;
  `,
};
