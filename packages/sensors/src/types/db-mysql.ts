import { databaseSensor } from './db-shared.js';

/**
 * A query against MySQL or MariaDB (`T-18`).
 *
 * `max_execution_time` is set on the session, which is MySQL's only server-side statement limit
 * and applies to read-only `SELECT` statements alone. A monitoring query should be one of those
 * anyway; anything else has only the client's deadline behind it, which is worth knowing when a
 * check times out and the work carries on.
 */
export const dbMysql = databaseSensor(
  'db.mysql',
  async () => (await import('../support/db/mysql.js')).mysqlDriver,
  'Zero uses 3306.',
);
