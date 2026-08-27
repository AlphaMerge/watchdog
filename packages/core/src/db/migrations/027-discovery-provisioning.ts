import type { Migration } from './types.js';

/**
 * What a discovery run created (D-04).
 *
 * **The counts are columns rather than a query over the tree**, because they are the answer to
 * "what did that run do", asked days later, when the tree has moved on. A device somebody has
 * since renamed or moved is still a device this run created, and counting the tree would say
 * otherwise — quietly, which is the worst way to be wrong about an audit trail.
 *
 * `provisioned` is a separate status from `done`, and the distinction earns its place: a run
 * that swept and identified but has not created anything is waiting for somebody to look at the
 * plan, which is exactly what an operator wants when they are trying discovery for the first
 * time. `D-06`'s levels choose between them.
 */
export const migration027: Migration = {
  id: 27,
  name: 'discovery-provisioning',

  up: `
    ALTER TABLE discovery_run
      ADD COLUMN devices_created integer NOT NULL DEFAULT 0 CHECK (devices_created >= 0),
      ADD COLUMN devices_matched integer NOT NULL DEFAULT 0 CHECK (devices_matched >= 0),
      ADD COLUMN sensors_created integer NOT NULL DEFAULT 0 CHECK (sensors_created >= 0),
      -- When somebody last asked this run to create things. Null means never, which is the
      -- state a run sits in while an operator is still reading its plan.
      ADD COLUMN provisioned_at timestamptz;

    -- Problems, one row each, rather than a text blob on the run: an operator's next question
    -- after "how many failed" is always "which ones", and a blob cannot answer it.
    CREATE TABLE discovery_problem (
      run_id   bigint NOT NULL REFERENCES discovery_run(id) ON DELETE CASCADE,
      address  inet NOT NULL,
      problem  text NOT NULL CHECK (length(problem) BETWEEN 1 AND 2000),
      at       timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (run_id, address)
    );
  `,

  down: `
    DROP TABLE IF EXISTS discovery_problem;
    ALTER TABLE discovery_run
      DROP COLUMN devices_created,
      DROP COLUMN devices_matched,
      DROP COLUMN sensors_created,
      DROP COLUMN provisioned_at;
  `,
};
