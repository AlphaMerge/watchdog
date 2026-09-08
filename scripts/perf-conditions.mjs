#!/usr/bin/env node
// Print the conditions the performance budgets are about to be measured under.
//
// The budgets run inside the toolchain container, so the numbers that govern them are the
// container's, not the host's. Read by hand from the host they disagree badly: measured
// 2026-09-08, macOS reported a load average of 25.50 while the VM the tests run in reported
// 1.29 on the same eight CPUs (P-192).
//
// This never fails the run. A findings file that records a busy machine is worth having; a
// gate that refuses to measure is a gate people route around.
import os from 'node:os';
import process from 'node:process';

/** Above this, the machine has work of its own and the budgets are not measuring only us. */
const BUSY_PER_CPU = 0.5;

/**
 * A fixed CPU-bound loop, because a load average cannot see the thing that bit us hardest.
 *
 * The container reports the load of tasks *runnable inside it*. When the host is starving the
 * VM, nothing inside is runnable-and-waiting, so the load average stays near zero while the
 * work takes half again as long: measured 2026-09-08, the VM read 1.29 while macOS read 25.50.
 * This loop measures what actually arrives -- delivered CPU rather than offered load.
 *
 * The reference is this project's development machine with the host quiet; other hardware will
 * read differently, which is why nothing warns until it is twice as slow. The number is worth
 * recording even when it is fine, because two findings files are only comparable if the machine
 * was giving them the same thing.
 */
const CALIBRATION_REFERENCE_MS = 267;

const w = (line) => process.stdout.write(`${line}\n`);

function load() {
  const cpus = os.cpus().length;
  const [one, five, fifteen] = os.loadavg();
  // Docker Desktop's VM reports a load average; a container on a Linux host reports the host's.
  // Either way it is the kernel the tests run on, which is the one that matters.
  return { cpus, one, five, fifteen, perCpu: cpus > 0 ? one / cpus : 0 };
}

/**
 * Who else is on the shared database. This is the precondition CLAUDE.md states in prose --
 * stop `ms-server` first -- and nothing has ever checked. It also catches what prose cannot: a
 * second developer, or a parallel session, against the same PostgreSQL.
 *
 * Cluster-wide on purpose, not filtered to our database: the perf suites build scratch databases,
 * and a backend on `monitoring` competes with them for the same CPU, I/O and shared buffers.
 */
async function competitors() {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    host: process.env['MS_TEST_DB_HOST'] ?? '127.0.0.1',
    port: Number(process.env['MS_TEST_DB_PORT'] ?? '5432'),
    database: process.env['MS_TEST_DB_NAME'] ?? 'monitoring',
    user: process.env['MS_TEST_DB_USER'] ?? 'monitoring',
    password: process.env['MS_TEST_DB_PASSWORD'] ?? 'monitoring',
    connectionTimeoutMillis: 3_000,
  });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT coalesce(nullif(application_name, ''), '(unnamed)') AS who,
              count(*)::int AS total,
              count(*) FILTER (WHERE state = 'active')::int AS active
         FROM pg_stat_activity
        WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
        GROUP BY 1 ORDER BY total DESC`,
    );
    return rows;
  } finally {
    await client.end();
  }
}

/** Fixed work, no allocation, no I/O: whatever this costs is what the CPU is giving us. */
function calibrate() {
  const spin = () => {
    const startedAt = process.hrtime.bigint();
    let x = 0;
    for (let i = 0; i < 3e8; i += 1) x += i % 7;
    // Returned so the loop cannot be optimised away, and ignored by the caller.
    return { ms: Number(process.hrtime.bigint() - startedAt) / 1e6, x };
  };
  spin();
  return Math.min(spin().ms, spin().ms);
}

const warnings = [];

w('');
w('  perf run conditions');
w(`  ${'-'.repeat(64)}`);

const { cpus, one, five, fifteen, perCpu } = load();
w(
  `  load average   ${one.toFixed(2)} / ${five.toFixed(2)} / ${fifteen.toFixed(2)}` +
    `  over ${String(cpus)} CPUs  (${perCpu.toFixed(2)} per CPU)`,
);
w('                 as the container sees it, which is the kernel running the tests');
if (perCpu > BUSY_PER_CPU) {
  warnings.push(
    `the machine has work of its own: ${perCpu.toFixed(2)} per CPU against ` +
      `${String(BUSY_PER_CPU)}. The budgets below measure it as well as us.`,
  );
}

const calibrationMs = calibrate();
w(
  `  delivered CPU  ${calibrationMs.toFixed(0)} ms for a fixed loop` +
    `  (${(calibrationMs / CALIBRATION_REFERENCE_MS).toFixed(2)}x the reference machine's ` +
    `${String(CALIBRATION_REFERENCE_MS)} ms)`,
);
w('                 a load average cannot see a host starving this VM; this can');
if (calibrationMs > CALIBRATION_REFERENCE_MS * 2) {
  warnings.push(
    `fixed work took ${calibrationMs.toFixed(0)} ms against a reference ` +
      `${String(CALIBRATION_REFERENCE_MS)} ms. Either this is different hardware, or something\n` +
      '     outside this container is taking the CPU. Check the host, not just the container.',
  );
}

try {
  const rows = await competitors();
  if (rows.length === 0) {
    w('  database       nothing else is connected');
  } else {
    w('  database       other client connections:');
    for (const row of rows) {
      w(
        `                   ${String(row.who).padEnd(24)} ${String(row.total)} (${String(row.active)} active)`,
      );
    }
    warnings.push(
      'something else is on the shared database. CLAUDE.md asks for `ms-server` stopped\n' +
        '     (`scripts/dev-services.sh stop`); a second session counts too.',
    );
  }
} catch (error) {
  // The suites skip themselves when no database is reachable, so this is not news here.
  w(`  database       not reachable (${error instanceof Error ? error.message : String(error)})`);
}

if (warnings.length > 0) {
  w('');
  for (const warning of warnings) w(`  !! ${warning}`);
  w('');
  w('  Recording this, not refusing it. A run under known conditions is worth having --');
  w('  file it under a name that says so, and do not move a budget on the strength of it.');
}
w(`  ${'-'.repeat(64)}`);
w('');
