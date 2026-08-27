import { databaseSensor } from './db-shared.js';

/**
 * A query against Microsoft SQL Server (`T-18`).
 *
 * SQL Server has no statement timeout, so this sets `LOCK_TIMEOUT` and relies on the driver's
 * own request cancellation — which `tedious` performs at the protocol level rather than by
 * dropping the socket. The lock timeout is the one that matters in practice: the usual reason a
 * monitoring query hangs here is waiting behind somebody else's transaction, not doing work.
 */
export const dbMssql = databaseSensor(
  'db.mssql',
  async () => (await import('../support/db/mssql.js')).mssqlDriver,
  'Zero uses 1433.',
);
