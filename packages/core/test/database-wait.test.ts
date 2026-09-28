import { strict as assert } from 'node:assert';
import { createServer, type Server, type Socket } from 'node:net';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import { ConfigError, type Logger } from '@ms/shared';
import { Database, DatabaseError } from '../src/db/pool.js';
import {
  AFTER_DATABASE_MS,
  classifyDatabaseFailure,
  DATABASE_WAIT_MS,
  waitForDatabase,
  type DatabaseFailureKind,
} from '../src/db/wait.js';
import { databaseAvailable, silentLogger, testDatabaseConfig } from './support/database.js';
import { shippedUnit, startLimitOf } from './support/units.js';

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
  // The codes. The code-less failures are provoked from the real driver below, not built here.
  const cases: readonly [string, Error, DatabaseFailureKind][] = [
    ['nothing listening yet', wrapped('ECONNREFUSED'), 'transient'],
    [
      'PostgreSQL in crash recovery',
      wrapped('57P03', 'the database system is starting up'),
      'transient',
    ],
    ['PostgreSQL shut down under the check', wrapped('57P01'), 'transient'],
    ['PostgreSQL crashed under the check', wrapped('57P02'), 'transient'],
    ['no connection slots', wrapped('53300'), 'transient'],
    ['resolver not up at boot', wrapped('EAI_AGAIN'), 'transient'],
    // P-209's own failure. Ambiguous — a typo or a name not yet published — so the bound decides.
    [
      'a name that does not resolve',
      wrapped('ENOTFOUND', 'getaddrinfo ENOTFOUND postgres'),
      'transient',
    ],
    ['network unreachable', wrapped('ENETUNREACH'), 'transient'],
    ['a socket file not there yet', wrapped('ENOENT'), 'transient'],
    ['a clock not yet set at boot', wrapped('CERT_NOT_YET_VALID'), 'transient'],
    [
      'wrong password',
      wrapped('28P01', 'password authentication failed for user "ms"'),
      'configuration',
    ],
    ['a user pg_hba.conf refuses', wrapped('28000'), 'configuration'],
    ['no such database', wrapped('3D000', 'database "monitoring" does not exist'), 'configuration'],
    ['permission refused', wrapped('42501'), 'configuration'],
    ['an untrusted certificate', wrapped('DEPTH_ZERO_SELF_SIGNED_CERT'), 'configuration'],
    ['something nobody anticipated', new Error('the unexpected'), 'unknown'],
  ];
  for (const [name, error, kind] of cases) {
    it(`classes ${name} as ${kind}`, () => {
      assert.equal(classifyDatabaseFailure(error).kind, kind);
      assert.equal(classifyDatabaseFailure(error).transient, kind === 'transient');
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
});

describe('waitForDatabase (P-215)', () => {
  it('returns at once, and logs nothing, when the database is already up', async () => {
    const r = run(['ok']);
    assert.deepEqual(await r.result, { serverVersion: 'PostgreSQL 17.5' });
    assert.equal(r.calls(), 1);
    assert.deepEqual(r.slept, []);
    assert.deepEqual(r.lines, []);
  });

  it('covers the first attempt, and the rest of start-up after the last, with an extension (P-222)', async () => {
    const r = run(['ok']);
    await r.result;
    // Before the first attempt: its own worst case and a margin, so a connectTimeoutMs longer
    // than TimeoutStartSec is not killed before it can fail. After it: a fresh budget for
    // everything that follows, which the last attempt's extension alone did not leave.
    assert.deepEqual(
      r.extended.map((call) => call.ms),
      [10_000 + 5_000, AFTER_DATABASE_MS],
    );
    assert.match(r.extended[0]?.status ?? '', /^connecting to PostgreSQL at db\.example\.test/);
    assert.match(r.extended[1]?.status ?? '', /is reachable/);
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
      [10_000 + 5_000, 1_000 + 10_000 + 5_000, 2_000 + 10_000 + 5_000, AFTER_DATABASE_MS],
    );
    assert.match(r.extended[1]?.status ?? '', /^waiting for PostgreSQL at db\.example\.test/);
    assert.match(r.extended[2]?.status ?? '', /attempt 2/);
  });

  it('refuses a configuration the database refused, as a ConfigError, so the core exits 78 (P-222)', async () => {
    const denied = wrapped('28P01', 'password authentication failed for user "ms"');
    const r = run([denied, 'ok']);

    await assert.rejects(r.result, (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.cause, denied);
      assert.match(
        error.message,
        /db\.example\.test:5432\/monitoring refused the password \(28P01\)/,
      );
      assert.match(error.message, /password authentication failed for user "ms"/);
      return true;
    });
    assert.equal(r.calls(), 1, 'a wrong password is not retried');
    assert.deepEqual(r.slept, []);
  });

  it('fails at once, with the original error, on a failure nobody has classified', async () => {
    const odd = new Error('the unexpected');
    const r = run([odd, 'ok']);
    await assert.rejects(r.result, (error) => error === odd);
    assert.equal(r.calls(), 1);
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
  for (const name of ['ms-core', 'ms-probe'] as const) {
    it(`makes rounds against a database that stays down too slow for ${name}'s start limit to count`, () => {
      // Read from the shipped unit (`P-222`): a copy here let the unit change and every test pass.
      const { intervalMs, burst, restartMs } = startLimitOf(shippedUnit(name));

      const roundMs = DATABASE_WAIT_MS + restartMs;
      // The most starts any one window can hold: one at its very start, and one per whole round.
      const mostStartsInAWindow = 1 + Math.floor(intervalMs / roundMs);
      assert.ok(
        mostStartsInAWindow <= burst,
        `a database that stays down would put ${String(mostStartsInAWindow)} starts in a window, ` +
          `and the start after them would be refused`,
      );

      // And the loop the limit exists for, killed at MemoryMax 10–14 s a round, is still stopped:
      // five whole rounds must fit inside the window, with room for a two-minute round.
      const slowestStoppedRoundMs = intervalMs / burst;
      assert.ok(
        slowestStoppedRoundMs >= 60_000,
        `the start limit would stop only loops faster than ${String(slowestStoppedRoundMs / 1000)} s a round`,
      );
    });
  }
});

/**
 * The failures start-up actually meets, provoked from the real driver and pool (`P-222`).
 *
 * The first version of the classifier was tested against errors built by hand, one of which carried
 * the message of a pg-pool branch start-up never takes; it passed, and a database behind a
 * firewall that drops packets left the core `failed`. Every case here goes through
 * `Database.check()`, so the error is whatever `pg` and `pg-pool` really throw.
 */
describe('classifyDatabaseFailure, against the real driver (P-222)', () => {
  async function listening(
    onSocket: (socket: Socket) => void,
  ): Promise<{ server: Server; port: number }> {
    const server = createServer(onSocket);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');
    return { server, port: address.port };
  }

  async function failureFrom(
    host: string,
    port: number,
    overrides: { password?: string; connectTimeoutMs?: number } = {},
  ) {
    const db = new Database({
      config: {
        ...testDatabaseConfig(),
        host,
        port,
        connectTimeoutMs: 400,
        poolSize: 2,
        ...overrides,
      },
      logger: silentLogger,
    });
    try {
      const error: unknown = await db.check().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      assert.ok(error !== undefined, 'the check succeeded');
      return classifyDatabaseFailure(error);
    } finally {
      await db.close();
    }
  }

  /** A PostgreSQL ErrorResponse, sent in answer to the startup message. */
  function errorResponse(code: string, message: string): Buffer {
    const fields = Buffer.from(`SFATAL\0VFATAL\0C${code}\0M${message}\0\0`, 'utf8');
    const header = Buffer.alloc(5);
    header.write('E', 0, 'ascii');
    header.writeInt32BE(fields.length + 4, 1);
    return Buffer.concat([header, fields]);
  }

  it('waits for a host that accepts the connection and never answers, as a packet-dropping firewall looks', async () => {
    const held: Socket[] = [];
    const { server, port } = await listening((socket) => held.push(socket));
    try {
      const failure = await failureFrom('127.0.0.1', port);
      assert.equal(failure.kind, 'transient', failure.reason);
    } finally {
      for (const socket of held) socket.destroy();
      server.close();
    }
  });

  it('waits for a host that closes the connection before answering', async () => {
    const { server, port } = await listening((socket) => socket.destroy());
    try {
      const failure = await failureFrom('127.0.0.1', port);
      assert.equal(failure.kind, 'transient', failure.reason);
    } finally {
      server.close();
    }
  });

  it('waits for a port with nothing listening', async () => {
    const { server, port } = await listening(() => undefined);
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    const failure = await failureFrom('127.0.0.1', port);
    assert.equal(failure.kind, 'transient');
    assert.equal(failure.code, 'ECONNREFUSED');
  });

  it('waits for a unix-socket directory whose socket is not there', async () => {
    const failure = await failureFrom('/nonexistent-ms-p222-socket-dir', 5432);
    assert.equal(failure.kind, 'transient', failure.reason);
    assert.equal(failure.code, 'ENOENT');
  });

  for (const [code, kind] of [
    ['57P03', 'transient'],
    ['57P01', 'transient'],
    ['53300', 'transient'],
    ['28P01', 'configuration'],
    ['3D000', 'configuration'],
  ] as const) {
    it(`classes a server answering ${code} as ${kind}`, async () => {
      const { server, port } = await listening((socket) => {
        socket.once('data', () => socket.end(errorResponse(code, `the server said ${code}`)));
      });
      try {
        const failure = await failureFrom('127.0.0.1', port);
        assert.equal(failure.kind, kind, failure.reason);
        assert.equal(failure.code, code);
      } finally {
        server.close();
      }
    });
  }

  it("refuses an empty password against the test PostgreSQL, the way a fresh install's is", async (t) => {
    if (!(await databaseAvailable())) {
      t.skip('no PostgreSQL');
      return;
    }
    const config = testDatabaseConfig();
    const failure = await failureFrom(config.host, config.port, {
      password: '',
      connectTimeoutMs: 5_000,
    }).catch((error: unknown) => {
      // A server that trusts every local connection lets the check through.
      if (error instanceof assert.AssertionError) return null;
      throw error;
    });
    if (failure === null) {
      t.skip('the test PostgreSQL does not ask for a password');
      return;
    }
    assert.equal(failure.kind, 'configuration', failure.reason);
  });

  it('refuses a wrong password against the test PostgreSQL', async (t) => {
    if (!(await databaseAvailable())) {
      t.skip('no PostgreSQL');
      return;
    }
    const config = testDatabaseConfig();
    const failure = await failureFrom(config.host, config.port, {
      password: 'certainly-not-the-password',
      connectTimeoutMs: 5_000,
    }).catch((error: unknown) => {
      if (error instanceof assert.AssertionError) return null;
      throw error;
    });
    if (failure === null) {
      t.skip('the test PostgreSQL does not ask for a password');
      return;
    }
    assert.equal(failure.kind, 'configuration', failure.reason);
    assert.equal(failure.code, '28P01');
  });
});

describe('the shipped units (P-222)', () => {
  for (const name of ['ms-core', 'ms-probe'] as const) {
    it(`${name} sets its start limit in [Unit], where systemd reads it, and stops at exit 78`, () => {
      const unit = shippedUnit(name);
      // In [Service], systemd warns "Unknown key" and ignores it, and the restart loop never ends.
      assert.equal(unit.get('Service')?.get('StartLimitIntervalSec'), undefined);
      assert.equal(unit.get('Service')?.get('StartLimitBurst'), undefined);
      assert.ok(unit.get('Unit')?.get('StartLimitIntervalSec') !== undefined);
      assert.ok(unit.get('Unit')?.get('StartLimitBurst') !== undefined);
      assert.equal(unit.get('Service')?.get('RestartPreventExitStatus'), '78');
    });
  }
});
