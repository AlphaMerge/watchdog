import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';
import { pino } from 'pino';
import type { DatabaseConfig } from '@ms/shared';
import { Database } from '../../src/db/pool.js';
import { within } from './within.js';

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

/**
 * What a run says about its PostgreSQL (`P-397`). `1`: one is expected, so a file that cannot reach
 * it fails rather than skipping. `0`: the run looked before it started and found none, so a file
 * skips after one attempt. Unset — a file run on its own — retries and then skips.
 *
 * `database-run.ts` sets it for `npm test` and `npm run test:perf`, from one probe taken before
 * any file starts. CI sets `1` itself, so a database the job failed to start is a failure too.
 */
export const DATABASE_REQUIRED_ENV = 'MS_TEST_DB_REQUIRED';

export interface DatabaseProbe {
  reachable: boolean;
  /** One line per failed attempt: how long it took and what the connect said. */
  failures: string[];
}

export interface ProbeOptions {
  attempts: number;
  /** The wait after each failed attempt but the last; the last entry repeats. */
  backoffMs: readonly number[];
  /** The bound on one attempt, connect and close together. */
  attemptMs: number;
}

/**
 * Asks `connect` up to `attempts` times. Each attempt has its own bound, since `connect` is a wait
 * on the far end of a socket.
 *
 * **One failed connect is not an absent database** (`P-397`). The single attempt this replaced
 * read a reachable PostgreSQL as missing while 200 test files shared the machine, and
 * `credential-pinning.test.ts` skipped 29 tests in a run whose summary said `skipped 0`.
 */
export async function probeDatabase(
  connect: () => Promise<void>,
  options: ProbeOptions,
): Promise<DatabaseProbe> {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const started = Date.now();
    try {
      await within(options.attemptMs, `PostgreSQL to accept a connection`, connect());
      return { reachable: true, failures };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(
        `attempt ${String(attempt)} after ${String(Date.now() - started)} ms: ${message}`,
      );
    }
    if (attempt < options.attempts) {
      const backoff = options.backoffMs[Math.min(attempt - 1, options.backoffMs.length - 1)] ?? 0;
      await sleep(backoff);
    }
  }
  return { reachable: false, failures };
}

/** One connect and close against the test database, for `probeDatabase`. */
export async function connectToTestDatabase(): Promise<void> {
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
  } catch (error) {
    // A connect that failed or was given up on can still hold a socket, and an open socket keeps
    // the file's process alive. Not awaited: a close that hangs must not hang the probe.
    client.end().catch(() => undefined);
    throw error;
  }
  await client.end();
}

/** Retried for a run that expects a database or does not know; once for one that found none. */
export function probeOptions(required: string | undefined): ProbeOptions {
  const attemptMs = testDatabaseConfig().connectTimeoutMs + 2_000;
  return required === '0'
    ? { attempts: 1, backoffMs: [], attemptMs }
    : { attempts: 4, backoffMs: [250, 750, 1_500], attemptMs };
}

let answer: Promise<boolean> | undefined;

/**
 * True when a database is reachable, so the suite can skip instead of failing on a laptop.
 *
 * **Call it at a file's top level**, the way every database test file does: an answer of false
 * registers a test of its own, which says the file's database suites did not run. A skipped
 * `describe` counts as nothing in `node:test`'s summary, so without it a run that skipped a
 * whole suite read `skipped 0` (`P-397`). Where the run expects a database
 * (`MS_TEST_DB_REQUIRED=1`), that test fails instead.
 *
 * Asked once per process; a second call has the first's answer.
 */
export async function databaseAvailable(): Promise<boolean> {
  answer ??= (async (): Promise<boolean> => {
    const required = process.env[DATABASE_REQUIRED_ENV];
    const probe = await probeDatabase(connectToTestDatabase, probeOptions(required));
    if (probe.reachable) return true;
    const config = testDatabaseConfig();
    const where = `${config.host}:${String(config.port)}`;
    if (required === '1') {
      test(`PostgreSQL at ${where} is reachable`, () => {
        throw new Error(
          `this run expects PostgreSQL (${DATABASE_REQUIRED_ENV}=1) and this file could not reach ` +
            `it, so its database suites were skipped. ${probe.failures.join('; ')}`,
        );
      });
    } else {
      test(`PostgreSQL at ${where} is reachable`, {
        skip: `no PostgreSQL reachable (start docker-compose.dev.yml); this file's database suites did not run`,
      });
    }
    return false;
  })();
  return answer;
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
