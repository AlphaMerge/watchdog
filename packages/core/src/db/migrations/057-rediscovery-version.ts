import type { Migration } from './types.js';

/**
 * A rediscovery rule's version, for an edit that says which one it was made against (`D-11`).
 *
 * **A rule could not be edited before this**, only deleted and made again, which split its audit
 * trail in two and lost its runs' link to it. An edit needs a version so that two people editing
 * one rule cannot have the second silently undo the first: `If-Match` carries it, and a stale one
 * is a 412, as an object's edit is.
 *
 * Counted by people's changes only. A firing books its next run and records its last one without
 * touching it, so an editor is never refused because the rule did what it was told.
 */
export const migration057: Migration = {
  id: 57,
  name: 'rediscovery-version',

  up: `
    ALTER TABLE discovery_schedule
      ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version >= 1);
  `,

  down: `
    ALTER TABLE discovery_schedule DROP COLUMN IF EXISTS version;
  `,
};
