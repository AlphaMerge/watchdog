import { describeDrift, type MigrationStatus } from './migrator.js';

/**
 * Whether this build may run against the schema it found (`H-03`).
 *
 * **Three ways the schema can be wrong, and only one of them is "behind".** Counting pending
 * migrations catches an installation that has not been migrated yet, and that is what start-up
 * checked before this — which left the two cases an *upgrade* actually produces:
 *
 * - **Behind.** Migrations this build knows and the database has not applied. Refuse: running
 *   against a schema written for an older build is how a query silently reads a column that
 *   means something else now.
 * - **Ahead.** Migrations the database has applied and this build has never heard of. There is
 *   nothing pending — the schema is past us, not before us — so a pending count says everything
 *   is fine while this process runs against tables it was never written for. This is what a
 *   *downgrade* looks like, and it is the likeliest of the three: an operator rolling back a bad
 *   upgrade, or a pair of cores where the newer one started first.
 * - **Drifted.** Applied migrations whose text no longer matches this build's. The schema was
 *   changed out from under the record of it, so what is in the database is not what any build
 *   applied and neither direction is safe.
 *
 * Returns the reason to refuse, or null. A function rather than a throw so it can be tested
 * against every shape without standing up a server, and so the caller decides how loud to be.
 */
export function refuseSchema(status: MigrationStatus): string | null {
  // **Ahead is reported before behind, and the order is a decision.** A build can be both — some
  // migrations shared with the database and some not, which is a mismatched pair mid-upgrade.
  // "Run migrate up" is the first thing anybody would try and is the wrong advice there;
  // `migrate up` would refuse it anyway, so the operator would end up here twice. The diagnosis
  // goes first.
  if (status.unknown.length > 0) {
    const newest = status.unknown[status.unknown.length - 1];
    return (
      `the database has ${String(status.unknown.length)} migration(s) this build does not know` +
      (newest === undefined ? '' : ` (newest: ${String(newest.id)} ${newest.name})`) +
      '; it was migrated by a newer ms-core. Upgrade this one, or restore a backup taken before ' +
      'that upgrade'
    );
  }

  if (status.pending.length > 0) {
    const next = status.pending[0];
    return (
      `${String(status.pending.length)} schema migration(s) are pending and autoMigrate is off; ` +
      `run "ms-core migrate up"` +
      (next === undefined ? '' : ` (next: ${String(next.id)} ${next.name})`)
    );
  }

  if (status.drifted.length > 0) {
    return (
      `${String(status.drifted.length)} applied migration(s) no longer match this build: ` +
      describeDrift(status.drifted) +
      '. The schema and the record of it disagree, so neither applying nor rolling back is safe'
    );
  }

  return null;
}
