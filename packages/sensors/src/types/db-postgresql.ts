import { databaseSensor } from './db-shared.js';

/**
 * A query against PostgreSQL (`T-18`).
 *
 * **The engine this system already runs on**, so a PostgreSQL sensor adds nothing an operator has
 * to install — `pg` is already here for the configuration and metrics database.
 *
 * The obvious first query is `SELECT count(*) FROM pg_stat_activity`, and the better one is
 * whatever your application's health actually depends on: the age of the oldest unprocessed row,
 * the replication lag from `pg_last_xact_replay_timestamp()`, how many connections are left
 * before `max_connections`. `statement_timeout` is set on the session, so a query this sensor
 * gives up on is stopped by the server rather than left running.
 */
export const dbPostgresql = databaseSensor(
  'db.postgresql',
  async () => (await import('../support/db/postgresql.js')).postgresqlDriver,
  'Zero uses 5432.',
);
