import {
  connectToTestDatabase,
  DATABASE_REQUIRED_ENV,
  probeDatabase,
  probeOptions,
  testDatabaseConfig,
} from './database.js';

/**
 * `node --test --test-global-setup`: asks once, before any file starts, whether this run has a
 * PostgreSQL, and tells every file through `MS_TEST_DB_REQUIRED` (`P-397`).
 *
 * **A database that answered when the run began is not absent half-way through it.** Each file
 * used to decide alone, and one of 200 files running at once failed its single connect and
 * skipped its database suites while every other file used the same server. With the answer taken
 * here, while the machine is quiet, a file that cannot reach a database the run already found
 * fails instead of skipping.
 *
 * A value already set is kept, so CI's `1` makes a database the job failed to start a failure
 * too. Unset and unreachable, the run still skips, as `npm test` is meant to with the stack down.
 */
export async function globalSetup(): Promise<void> {
  const config = testDatabaseConfig();
  const where = `${config.host}:${String(config.port)}`;
  const preset = process.env[DATABASE_REQUIRED_ENV];
  if (preset !== undefined) {
    process.stdout.write(
      `ℹ PostgreSQL at ${where}: ${DATABASE_REQUIRED_ENV}=${preset} from the environment\n`,
    );
    return;
  }
  const probe = await probeDatabase(connectToTestDatabase, probeOptions(undefined));
  process.env[DATABASE_REQUIRED_ENV] = probe.reachable ? '1' : '0';
  process.stdout.write(
    probe.reachable
      ? `ℹ PostgreSQL at ${where} answered, so every database suite in this run must reach it\n`
      : `ℹ PostgreSQL at ${where} did not answer, so this run's database suites skip — ` +
          `${probe.failures.join('; ')}\n`,
  );
}
