import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import type { Logger } from '@ms/shared';
import { DatabaseError } from '../src/db/pool.js';
import { classifyDatabaseFailure, DATABASE_WAIT_MS, waitForDatabase } from '../src/db/wait.js';

/** What `pg` throws, shaped as `Database` wraps it: a `DatabaseError` whose cause carries the code. */
function wrapped(code: string, message = `failure ${code}`): DatabaseError {
  const cause = Object.assign(new Error(message), { code });
  return new DatabaseError('cannot connect to the database', {
    context: { database: 'db.example.test:5432/monitoring' },
    cause,
  });
}

interface Run {
  readonly lines: Record<string, unknown>[];
  readonly slept: number[];
  readonly extended: { status: string; ms: number }[];
  readonly calls: () => number;
  readonly result: Promise<{ serverVersion: string }>;
}

/**
 * Drives `waitForDatabase` against a scripted sequence of outcomes, with a clock that advances by
 * exactly what the wait sleeps — so the bound is exercised in arithmetic, not in real minutes.
 */
function run(outcomes: readonly (Error | 'ok')[], maxWaitMs = DATABASE_WAIT_MS): Run {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'info' },
    { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  ) as unknown as Logger;
  const slept: number[] = [];
  const extended: { status: string; ms: number }[] = [];
  let clock = 0;
  let index = 0;

  const result = waitForDatabase({
    check: () => {
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      return outcome === 'ok' || outcome === undefined
        ? Promise.resolve({ serverVersion: 'PostgreSQL 17.5' })
        : Promise.reject(outcome);
    },
    logger,
    target: 'db.example.test:5432/monitoring',
    attemptTimeoutMs: 10_000,
    starting: (status, ms) => extended.push({ status, ms }),
    maxWaitMs,
    sleep: (ms) => {
      slept.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
  });
  return { lines, slept, extended, calls: () => index, result };
}

describe('classifyDatabaseFailure', () => {
  const cases: readonly [string, Error, boolean][] = [
    ['nothing listening yet', wrapped('ECONNREFUSED'), true],
    ['PostgreSQL in crash recovery', wrapped('57P03', 'the database system is starting up'), true],
    ['no connection slots', wrapped('53300'), true],
    ['resolver not up at boot', wrapped('EAI_AGAIN'), true],
    // P-209's own failure. Ambiguous — a typo or a name not yet published — so the bound decides.
    ['a name that does not resolve', wrapped('ENOTFOUND', 'getaddrinfo ENOTFOUND postgres'), true],
    ['network unreachable', wrapped('ENETUNREACH'), true],
    ['wrong password', wrapped('28P01', 'password authentication failed for user "ms"'), false],
    ['no such database', wrapped('3D000', 'database "monitoring" does not exist'), false],
    ['permission refused', wrapped('42501'), false],
    ['something nobody anticipated', new Error('the unexpected'), false],
  ];
  for (const [name, error, transient] of cases) {
    it(`${transient ? 'waits for' : 'does not wait for'} ${name}`, () => {
      assert.equal(classifyDatabaseFailure(error).transient, transient);
    });
  }

  it("reports the driver's code, not the wrapper's own label", () => {
    // `DatabaseError` carries `code: 'DATABASE_ERROR'` as an `AppError`. That is a label for the
    // kind of error, and a log line reading "code DATABASE_ERROR" for a wrong password is the
    // opposite of a diagnosis.
    const failure = classifyDatabaseFailure(wrapped('28P01', 'password authentication failed'));
    assert.equal(failure.code, '28P01');
  });

  it('finds the code on the driver error, not only the wrapper', () => {
    // `DatabaseError` copies a code into `sqlstate`, but a socket error wrapped twice is only
    // findable by walking the chain.
    const socket = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const driver = Object.assign(new Error('Connection terminated'), { cause: socket });
    const failure = classifyDatabaseFailure(
      new DatabaseError('cannot connect to the database', { cause: driver }),
    );
    assert.equal(failure.transient, true);
    assert.equal(failure.code, 'ECONNREFUSED');
  });

  it("treats pg-pool's code-less connect timeout as transient", () => {
    const failure = classifyDatabaseFailure(
      new DatabaseError('cannot connect to the database', {
        cause: new Error('timeout exceeded when trying to connect'),
      }),
    );
    assert.equal(failure.transient, true);
  });
});

describe('waitForDatabase (P-215)', () => {
  it('returns at once, and says nothing, when the database is already up', async () => {
    const r = run(['ok']);
    assert.deepEqual(await r.result, { serverVersion: 'PostgreSQL 17.5' });
    assert.equal(r.calls(), 1);
    assert.deepEqual(r.slept, []);
    assert.deepEqual(r.lines, []);
  });

  it('waits out a database in crash recovery, logging every attempt with its reason', async () => {
    const recovering = wrapped('57P03', 'the database system is starting up');
    const r = run([recovering, recovering, recovering, 'ok']);

    assert.deepEqual(await r.result, { serverVersion: 'PostgreSQL 17.5' });
    assert.equal(r.calls(), 4);
    // 1 s, doubling, capped at 5 s.
    assert.deepEqual(r.slept, [1_000, 2_000, 4_000]);

    const warnings = r.lines.filter((line) => line['level'] === 40);
    assert.equal(warnings.length, 3, 'one line per failed attempt, never silent');
    for (const line of warnings) {
      assert.equal(line['code'], '57P03');
      assert.match(String(line['msg']), /db\.example\.test:5432\/monitoring/);
      assert.match(String(line['msg']), /starting up or recovering/);
    }
    const recovered = r.lines.find((line) => line['level'] === 30);
    assert.equal(recovered?.['attempts'], 4);
  });

  it('keeps systemd waiting past TimeoutStartSec, one attempt ahead at a time', async () => {
    const refused = wrapped('ECONNREFUSED');
    const r = run([refused, refused, 'ok']);
    await r.result;

    // Each extension covers the sleep, the next attempt's own connect timeout and a margin — so
    // the deadline can never land between the sleep ending and the connection giving up.
    assert.deepEqual(
      r.extended.map((call) => call.ms),
      [1_000 + 10_000 + 5_000, 2_000 + 10_000 + 5_000],
    );
    assert.match(r.extended[0]?.status ?? '', /^waiting for PostgreSQL at db\.example\.test/);
    assert.match(r.extended[1]?.status ?? '', /attempt 2/);
  });

  it('fails at once on a failure waiting cannot fix, with the original error', async () => {
    const denied = wrapped('28P01', 'password authentication failed for user "ms"');
    const r = run([denied, 'ok']);

    await assert.rejects(r.result, (error) => error === denied);
    assert.equal(r.calls(), 1, 'a wrong password is not retried');
    assert.deepEqual(r.slept, []);
    assert.deepEqual(r.extended, []);
  });

  it('names the host it could not resolve, so a typo reads as one', async () => {
    const r = run([wrapped('ENOTFOUND', 'getaddrinfo ENOTFOUND postgress'), 'ok']);
    await r.result;
    const warning = r.lines.find((line) => line['level'] === 40);
    assert.ok(warning !== undefined, 'no warning was logged');
    assert.equal(warning['code'], 'ENOTFOUND');
    assert.match(String(warning['msg']), /db\.example\.test/);
    // The driver's own sentence, with the name it tried, travels in `err`.
    assert.match(JSON.stringify(warning['err']), /postgress/);
  });

  it('gives up at the bound and throws the last error, so the process exits and systemd restarts it', async () => {
    const refused = wrapped('ECONNREFUSED');
    const r = run([refused], 20_000);

    await assert.rejects(r.result, (error) => error === refused);
    // 1 + 2 + 4 + 5 + 5 = 17 s slept; the next 5 s would pass 20 s, so it stops after six tries.
    assert.deepEqual(r.slept, [1_000, 2_000, 4_000, 5_000, 5_000]);
    assert.equal(r.calls(), 6);
    const gaveUp = r.lines.find((line) => line['level'] === 50);
    assert.match(String(gaveUp?.['msg']), /gave up waiting for the database at db\.example\.test/);
  });

  /**
   * The property the start limit depends on, pinned in arithmetic rather than left to a comment.
   *
   * systemd refuses a start once `StartLimitBurst` starts have already happened inside
   * `StartLimitIntervalSec` — the sixth, for a burst of five, which takes five whole rounds inside
   * the window. The loop it must catch — a service killed at `MemoryMax` — was measured at 10–14 s
   * a round (`docs/findings/2026-09-28-start-exits.md`). The loop it must never catch is a
   * database that stays down, whose rounds last at least this bound plus `RestartSec`.
   *
   * An earlier version of this test said five starts span four rounds and pinned 75 s. That is
   * the arithmetic for a limit that trips *on* the fifth start, which is not what systemd does.
   */
  it('makes rounds against a database that stays down too slow for the start limit to count', () => {
    // As in deploy/systemd/ms-{core,probe}.service.
    const START_LIMIT_INTERVAL_MS = 600_000;
    const START_LIMIT_BURST = 5;
    const RESTART_SEC_MS = 5_000;

    const roundMs = DATABASE_WAIT_MS + RESTART_SEC_MS;
    // The most starts any one window can hold: one at its very start, and one per whole round.
    const mostStartsInAWindow = 1 + Math.floor(START_LIMIT_INTERVAL_MS / roundMs);
    assert.ok(
      mostStartsInAWindow <= START_LIMIT_BURST,
      `a database that stays down would put ${String(mostStartsInAWindow)} starts in a window, ` +
        `and the start after them would be refused`,
    );
    assert.equal(mostStartsInAWindow, 2);

    // And the slowest loop the same limit still stops: five whole rounds inside the window.
    const slowestStoppedRoundMs = START_LIMIT_INTERVAL_MS / START_LIMIT_BURST;
    assert.equal(slowestStoppedRoundMs, 120_000);
  });
});
