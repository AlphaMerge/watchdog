import type { Migration } from './types.js';

/**
 * At most one probe object is the local probe (`P-382`).
 *
 * `probe_config.is_local` is said by whoever approves a probe (`R-01`), and an approval only ever
 * raised it: approving a second probe as local, or approving the machine that replaced the core's
 * own onto a new probe object, left two rows saying so. Four readers took it as one probe: Core
 * Health's local-probe log line took whichever row the plan gave first, and Probe Health, the
 * clock comparison and the delete guard each took both. The old object kept a guard against
 * deletion for a machine that is gone, and nothing could clear it.
 *
 * So the database holds one, by a unique index over the flag where it is set. `ProbeRegistry`
 * moves the flag when the object holding it has no probe bound any more, and refuses while one
 * is, so the index is never the thing an operator meets.
 *
 * **An installation that already has two keeps one.** The one with a probe still approved onto
 * it, then the one seen most recently, then the lowest id; the others are set back to not local,
 * which makes them deletable again. That is the probe the core is talking to wherever one is: a
 * row with no approved identity has no machine behind it to be beside the core.
 *
 * The rollback drops the index. The flags cleared on the way up stay cleared: the build before
 * reads one local row as it read two, and which of the two had been is not recorded anywhere.
 */
export const migration075: Migration = {
  id: 75,
  name: 'one-local-probe',

  up: `
    UPDATE probe_config SET is_local = false
    WHERE is_local AND object_id <> (
      SELECT pc.object_id
      FROM probe_config pc
      LEFT JOIN probe_registration pr ON pr.gid = pc.gid AND pr.status = 'approved'
      WHERE pc.is_local
      ORDER BY (pr.gid IS NOT NULL) DESC, pc.last_seen_at DESC NULLS LAST, pc.object_id
      LIMIT 1
    );

    CREATE UNIQUE INDEX probe_config_one_local ON probe_config (is_local) WHERE is_local;

    COMMENT ON INDEX probe_config_one_local IS
      'At most one probe object is the local probe (P-382).';
  `,

  down: `
    DROP INDEX probe_config_one_local;
  `,
};
