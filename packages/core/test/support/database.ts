import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { pino } from 'pino';
import type { DatabaseConfig } from '@ms/shared';
import { Database } from '../../src/db/pool.js';

export const silentLogger = pino({ level: 'silent' });

/**
 * Connection details for the development PostgreSQL (docker-compose.dev.yml), overridable so
 * CI and a local run can point somewhere else.
 */
export function testDatabaseConfig(): DatabaseConfig {
  return {
    host: process.env['MS_TEST_DB_HOST'] ?? '127.0.0.1',
    port: Number(process.env['MS_TEST_DB_PORT'] ?? '5432'),
    database: process.env['MS_TEST_DB_NAME'] ?? 'monitoring',
    user: process.env['MS_TEST_DB_USER'] ?? 'monitoring',
    password: process.env['MS_TEST_DB_PASSWORD'] ?? 'monitoring',
    ssl: false,
    poolSize: 5,
    connectTimeoutMs: 3_000,
    // Off (`P-229`). The perf harnesses build 5,000 objects in one request and fill a database
    // for an hour, which a 60 s statement limit would cut. A test of the limits sets its own.
    statementTimeoutMs: 0,
    lockTimeoutMs: 0,
    idleInTransactionTimeoutMs: 0,
    // Tests drive the migrator explicitly; nothing should migrate behind their back.
    autoMigrate: false,
  };
}

/** True when a database is reachable, so the suite can skip instead of failing on a laptop. */
export async function databaseAvailable(): Promise<boolean> {
  const config = testDatabaseConfig();
  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: config.connectTimeoutMs,
  });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

export interface ScratchDatabase {
  db: Database;
  name: string;
  drop: () => Promise<void>;
}

/**
 * Creates a throwaway database for one test file.
 *
 * Migrations are destructive by nature and the rollback tests deliberately drop everything, so
 * they get their own database rather than sharing — a failing test must not take the developer's
 * dev data with it.
 */
export async function createScratchDatabase(prefix: string): Promise<ScratchDatabase> {
  const config = testDatabaseConfig();
  const name = `ms_test_${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  // Checked before anything is opened. Doing it at the point of use left the admin client
  // connected when the throw happened, and an open socket keeps the loop alive for ever — so a
  // prefix with a hyphen in it produced a test run that hung instead of one that failed.
  const quoted = quoteIdentifier(name);

  const admin = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${quoted}`);
  await admin.end();

  const db = new Database({ config, logger: silentLogger, databaseOverride: name });

  return {
    db,
    name,
    drop: async () => {
      await db.close();
      const cleanup = new Client({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
      });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

function quoteIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(
      `refusing to use an unsafe database identifier: ${name} — ` +
        'a scratch prefix must be lower-case letters, digits and underscores',
    );
  }
  return `"${name}"`;
}
