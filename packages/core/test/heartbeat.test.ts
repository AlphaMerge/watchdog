import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import * as tls from 'node:tls';
import { pino } from 'pino';
import { ConfigError, type HousekeepingConfig, type Logger } from '@ms/shared';
import type { Database } from '../src/db/pool.js';
import { Heartbeat, HEARTBEAT_TIMEOUT_MS, heartbeatFor } from '../src/health/heartbeat.js';
import { Housekeeper } from '../src/timeseries/housekeeper.js';
import { pollWithin } from './support/within.js';

/**
 * The core's outbound heartbeat (`H-18`).
 *
 * **Every receiver here is a server in this process, on loopback.** What has to be right is what
 * leaves the core, when it leaves, and what happens when nothing answers — none of which needs a
 * receiver anywhere else.
 *
 * The second half drives the real housekeeping loop over a database that is three lines of fake:
 * what is under test is that the loop is the only thing that sends, so a loop that has stopped
 * turning sends nothing.
 */

const TOKEN = 'ping/1f0c-s3cret-token';

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

interface Receiver {
  readonly origin: string;
  /** The URL an operator would configure: the origin, a path that is a token, and a query. */
  readonly url: string;
  readonly seen: Seen[];
  close(): Promise<void>;
}

const open: Receiver[] = [];

/** A receiver answering as `answer` says; one that never calls `response.end` hangs. */
async function receiver(
  answer: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) => {
    response.statusCode = 200;
    response.end('OK');
  },
): Promise<Receiver> {
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      answer(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const made: Receiver = {
    origin,
    url: `${origin}/${TOKEN}?site=north`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
  open.push(made);
  return made;
}

const hangs = (): void => undefined;

/** A logger whose lines a test can read. */
function capturing(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'debug' },
    { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  ) as unknown as Logger;
  return { logger, lines };
}

const silent = pino({ level: 'silent' }) as unknown as Logger;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for `met`, and fails by name rather than by the test's own timeout (rule 22). */
function until(ms: number, what: string, met: () => boolean): Promise<void> {
  return pollWithin(ms, what, met, 5);
}

afterEach(async () => {
  for (const one of open.splice(0)) await one.close();
});

describe('the heartbeat request (H-18)', () => {
  const beat = (
    url: string,
    overrides: Partial<ConstructorParameters<typeof Heartbeat>[0]> = {},
  ): Heartbeat =>
    new Heartbeat({
      url,
      intervalSeconds: 300,
      passSeconds: 300,
      version: '9.9.9',
      logger: silent,
      timeoutMs: 2_000,
      ...overrides,
    });

  it('asks for the URL exactly as written, and says nothing of the installation but its version', async () => {
    const target = await receiver();
    const heartbeat = beat(target.url);
    heartbeat.passed();
    await heartbeat.settled();

    assert.equal(target.seen.length, 1);
    const [request] = target.seen;
    assert.ok(request !== undefined);
    assert.equal(request.method, 'GET');
    assert.equal(request.url, `/${TOKEN}?site=north`, 'the path and query the operator wrote');
    assert.equal(request.body, '', 'no body');
    assert.equal(request.headers['user-agent'], 'ms-core/9.9.9');
    // Every header that left, by name: what HTTP needs and the version. A credential, a cookie, a
    // host name of ours or an id would be a new name in this list.
    assert.deepEqual(Object.keys(request.headers).sort(), [
      'accept',
      'accept-encoding',
      'accept-language',
      'connection',
      'host',
      'sec-fetch-mode',
      'user-agent',
    ]);
    // And by value, as `fetch` sent them before `A-71` moved this off it: a receiver, or what
    // stands in front of one, that answered those headers is sent the same ones. `connection`
    // is the one that moved, and says what is true: a connection is made for each heartbeat.
    assert.deepEqual(
      { ...request.headers, host: undefined, 'user-agent': undefined },
      {
        accept: '*/*',
        'accept-encoding': 'gzip, deflate',
        'accept-language': '*',
        connection: 'close',
        host: undefined,
        'sec-fetch-mode': 'cors',
        'user-agent': undefined,
      },
    );
    assert.equal(request.headers.host, new URL(target.origin).host, 'the receiver’s own name');
    assert.deepEqual(heartbeat.stats(), { sent: 1, failures: 0 });
  });

  it('counts any 2xx as arrived, and logs the receiver without the token in its path', async () => {
    const target = await receiver((_request, response) => {
      response.statusCode = 204;
      response.end();
    });
    const { logger, lines } = capturing();
    const heartbeat = beat(target.url, { logger });
    heartbeat.passed();
    await heartbeat.settled();

    assert.deepEqual(heartbeat.stats(), { sent: 1, failures: 0 });
    const line = lines.find((one) => one['msg'] === 'heartbeat sent');
    assert.ok(line !== undefined, 'a debug line for one that arrived');
    assert.equal(line['receiver'], target.origin);
    assert.equal(line['component'], 'heartbeat');
    assert.ok(!JSON.stringify(lines).includes('s3cret-token'), 'the token reached the log');
  });

  it('counts a refusal, and says which status from which receiver', async () => {
    for (const status of [500, 404, 300, 429]) {
      const target = await receiver((_request, response) => {
        response.statusCode = status;
        response.end('no');
      });
      const { logger, lines } = capturing();
      const heartbeat = beat(target.url, { logger });
      heartbeat.passed();
      await heartbeat.settled();

      assert.deepEqual(heartbeat.stats(), { sent: 0, failures: 1 }, String(status));
      const warned = lines.filter((one) => one['level'] === 40);
      assert.equal(warned.length, 1, String(status));
      const [line] = warned;
      assert.ok(line !== undefined);
      assert.equal(line['phase'], 'refused');
      assert.equal(line['status'], status);
      assert.equal(line['receiver'], target.origin);
      assert.equal(line['failures'], 1);
      assert.equal(line['intervalSeconds'], 300);
      assert.ok(!JSON.stringify(lines).includes('s3cret-token'), 'the token reached the log');
    }
  });

  it('does not follow a redirect to an address the operator did not name', async () => {
    const elsewhere = await receiver();
    const target = await receiver((_request, response) => {
      response.statusCode = 302;
      response.setHeader('location', `${elsewhere.origin}/taken`);
      response.end();
    });
    const { logger, lines } = capturing();
    const heartbeat = beat(target.url, { logger });
    heartbeat.passed();
    await heartbeat.settled();

    assert.equal(target.seen.length, 1);
    assert.equal(elsewhere.seen.length, 0, 'the request, with its token, went where it was sent');
    assert.deepEqual(heartbeat.stats(), { sent: 0, failures: 1 });
    assert.equal(lines.find((one) => one['level'] === 40)?.['status'], 302);
  });

  it('gives a receiver that says nothing its timeout and no longer, without being waited for', async () => {
    const target = await receiver(hangs);
    const { logger, lines } = capturing();
    const heartbeat = beat(target.url, { logger, timeoutMs: 150 });

    const started = process.hrtime.bigint();
    heartbeat.passed();
    const returnedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(returnedMs < 100, `passed() took ${String(returnedMs)} ms: it waited`);
    assert.deepEqual(heartbeat.stats(), { sent: 0, failures: 0 }, 'not failed yet: in flight');

    await until(5_000, 'the hanging request to be given up', () => heartbeat.stats().failures > 0);
    const waitedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(waitedMs >= 140, `given up after ${String(waitedMs)} ms, before its timeout`);
    await heartbeat.settled();
    assert.deepEqual(heartbeat.stats(), { sent: 0, failures: 1 });
    const line = lines.find((one) => one['level'] === 40);
    assert.equal(line?.['phase'], 'timeout');
    assert.equal(line['timeoutMs'], 150);
    assert.equal(target.seen.length, 1, 'the request did arrive; nothing answered it');
  });

  it('bounds a request at ten seconds unless told otherwise', () => {
    // The figure the runbook gives for the check from outside, and under the shortest interval.
    assert.equal(HEARTBEAT_TIMEOUT_MS, 10_000);
  });

  it('counts a receiver that is not there, with the reason and not "fetch failed"', async () => {
    const target = await receiver();
    await target.close();
    const { logger, lines } = capturing();
    const heartbeat = beat(target.url, { logger });
    heartbeat.passed();
    await heartbeat.settled();

    assert.deepEqual(heartbeat.stats(), { sent: 0, failures: 1 });
    const line = lines.find((one) => one['level'] === 40);
    assert.equal(line?.['phase'], 'request');
    const err = line['err'] as { code?: string; message: string };
    assert.equal(err.code, 'ECONNREFUSED', JSON.stringify(err));
    assert.ok(!JSON.stringify(lines).includes('s3cret-token'), 'the token reached the log');
  });

  it('sends one an interval, on the pass nearest to it', async () => {
    const target = await receiver();
    let now = 1_000_000;
    // Every minute a pass, every five a beat.
    const heartbeat = beat(target.url, {
      intervalSeconds: 300,
      passSeconds: 60,
      monotonicMs: () => now,
    });
    const passAt = async (ms: number): Promise<number> => {
      now = 1_000_000 + ms;
      heartbeat.passed();
      await heartbeat.settled();
      return target.seen.length;
    };

    assert.equal(await passAt(0), 1, 'the first pass after a start sends one');
    assert.equal(await passAt(60_000), 1);
    assert.equal(await passAt(120_000), 1);
    assert.equal(await passAt(240_000), 1);
    assert.equal(await passAt(269_900), 1, 'more than half a pass early');
    // A pass that ended a moment early is still the one nearest the interval.
    assert.equal(await passAt(299_900), 2);
    assert.equal(await passAt(360_000), 2, 'and the interval runs from the one that sent');
    assert.equal(await passAt(569_900), 3, 'half a pass early, to the millisecond, is due');
  });

  it('sends on every pass when the interval is the pass’s own, early or late', async () => {
    // The default: 300 and 300. An exact comparison skipped every pass that ended a millisecond
    // early, and the receiver heard half of what it was told to expect.
    const target = await receiver();
    let now = 0;
    const heartbeat = beat(target.url, { monotonicMs: () => now });
    for (const at of [0, 299_990, 600_004, 899_998, 1_200_000]) {
      now = at;
      heartbeat.passed();
      await heartbeat.settled();
    }
    assert.equal(target.seen.length, 5);
  });

  it('sends one at a time: a second pass does not add to a receiver already not answering', async () => {
    const target = await receiver(hangs);
    let now = 0;
    const heartbeat = beat(target.url, { timeoutMs: 400, monotonicMs: () => now });
    heartbeat.passed();
    now = 300_000;
    heartbeat.passed();
    await until(5_000, 'the first request to arrive', () => target.seen.length > 0);
    await heartbeat.settled();

    assert.equal(target.seen.length, 1);
    assert.deepEqual(heartbeat.stats(), { sent: 0, failures: 1 }, 'and it is one failure, not two');

    // The one in flight is over, so the next due pass sends again.
    now = 600_000;
    heartbeat.passed();
    await heartbeat.settled();
    assert.equal(target.seen.length, 2);
  });

  it('withholds for a pass that failed, counts it once an interval, and says why', async () => {
    const target = await receiver();
    const { logger, lines } = capturing();
    let now = 0;
    const heartbeat = beat(target.url, { logger, passSeconds: 60, monotonicMs: () => now });

    heartbeat.failed('connect ECONNREFUSED 127.0.0.1:5432');
    await heartbeat.settled();
    assert.equal(
      target.seen.length,
      0,
      'a core with no database is silent, so the receiver hears nothing',
    );
    assert.deepEqual(heartbeat.stats(), { sent: 0, failures: 1 });
    const line = lines.find((one) => one['level'] === 40);
    assert.equal(line?.['phase'], 'withheld');
    assert.equal(line['reason'], 'connect ECONNREFUSED 127.0.0.1:5432');
    assert.match(String(line['msg']), /^heartbeat withheld: the housekeeping pass failed/);

    // The passes between two heartbeats are not heartbeats that failed.
    now = 60_000;
    heartbeat.failed('still down');
    assert.equal(heartbeat.stats().failures, 1);
    now = 300_000;
    heartbeat.failed('still down');
    assert.equal(heartbeat.stats().failures, 2);

    // And the database coming back is a heartbeat on the next pass that is due.
    now = 600_000;
    heartbeat.passed();
    await heartbeat.settled();
    assert.equal(target.seen.length, 1);
    assert.deepEqual(heartbeat.stats(), { sent: 1, failures: 2 });
  });

  it('ends a request in flight at a stop, counts nothing for it, and sends no more', async () => {
    const target = await receiver(hangs);
    const { logger, lines } = capturing();
    let now = 0;
    const heartbeat = beat(target.url, { logger, timeoutMs: 30_000, monotonicMs: () => now });
    heartbeat.passed();
    await until(5_000, 'the request to arrive', () => target.seen.length > 0);

    const stopping = process.hrtime.bigint();
    heartbeat.stop();
    await heartbeat.settled();
    const stoppedMs = Number(process.hrtime.bigint() - stopping) / 1e6;
    assert.ok(stoppedMs < 2_000, `a stop waited ${String(stoppedMs)} ms on the receiver`);
    assert.deepEqual(heartbeat.stats(), { sent: 0, failures: 0 }, 'a stop is not a failure');
    assert.deepEqual(
      lines.filter((one) => one['level'] === 40),
      [],
    );

    now = 300_000;
    heartbeat.passed();
    await heartbeat.settled();
    // An interval later, so this one is due in its own right: the pass a stop cuts short fails
    // because the pool is closing, and that is not a heartbeat that failed. Found by a surviving
    // mutant, which the pass before it had hidden by taking the interval's one turn.
    now = 600_000;
    heartbeat.failed('the pool is closed');
    await heartbeat.settled();
    assert.equal(target.seen.length, 1, 'nothing after a stop');
    assert.deepEqual(heartbeat.stats(), { sent: 0, failures: 0 });
  });

  it('is built from the configuration, and is nothing where no URL is set', async () => {
    const off = { url: '', intervalSeconds: 300 };
    const passes = { intervalSeconds: 300 } as HousekeepingConfig;
    assert.equal(
      heartbeatFor({ heartbeat: off, housekeeping: passes }, '9.9.9', silent),
      undefined,
      'off by default: a core nobody gave a receiver sends nothing',
    );

    // Ten minutes apart on five-minute passes: every second pass, and the slack is half a pass.
    const target = await receiver();
    let now = 0;
    const heartbeat = heartbeatFor(
      { heartbeat: { url: target.url, intervalSeconds: 600 }, housekeeping: passes },
      '1.4.2',
      silent,
      () => now,
    );
    assert.ok(heartbeat !== undefined);
    const heard: number[] = [];
    for (const at of [0, 300_000, 449_000, 450_000, 750_000, 1_050_000]) {
      now = at;
      heartbeat.passed();
      await heartbeat.settled();
      heard.push(target.seen.length);
    }
    assert.deepEqual(heard, [1, 1, 1, 2, 2, 3]);
    assert.equal(target.seen[0]?.headers['user-agent'], 'ms-core/1.4.2');
  });

  it('refuses to be built on a URL the configuration would refuse', () => {
    for (const url of [
      '',
      'hc.example.org/ping',
      'ftp://hc.example.org/x',
      'https://a:b@hc.example.org/x',
    ]) {
      assert.throws(() => beat(url), ConfigError, url);
    }
  });
});

describe('the heartbeat rides the housekeeping loop (H-18)', () => {
  /** A period of 40 ms. The schema's floor is ten seconds; the class takes what it is given. */
  const PERIOD_SECONDS = 0.04;

  const housekeeping = (): HousekeepingConfig => ({
    enabled: true,
    intervalSeconds: PERIOD_SECONDS,
    rollupLagSeconds: 0,
    retention: {
      rawDays: 40,
      fiveMinuteDays: 365,
      hourlyDays: 730,
      dailyDays: 3_650,
      auditDays: 730,
      stateDays: 3_650,
      reportDays: 90,
      reportRunDays: 730,
    },
    compression: { rawAfterDays: 7, fiveMinuteAfterDays: 30 },
    disk: { path: '', evictBelowPercent: 10, recoverAbovePercent: 15, minimumRetainedHours: 48 },
  });

  /**
   * A database on which every pass finds the housekeeping lock held, so a pass is one round trip
   * and no work — and which a test can wedge, or break, between two passes.
   */
  function fakeDatabase(): {
    db: Database;
    passes: { started: number; finished: number };
    wedge: () => void;
    release: () => void;
    fail: (message: string | null) => void;
  } {
    const passes = { started: 0, finished: 0 };
    const state: { wedged: boolean; waiting: (() => void)[]; failing: string | null } = {
      wedged: false,
      waiting: [],
      failing: null,
    };
    const client = { query: () => Promise.resolve({ rows: [{ locked: false }] }) };
    const db = {
      withClient: async (run: (c: typeof client) => Promise<unknown>): Promise<unknown> => {
        passes.started += 1;
        if (state.failing !== null) throw new Error(state.failing);
        if (state.wedged) await new Promise<void>((resolve) => state.waiting.push(resolve));
        const result = await run(client);
        passes.finished += 1;
        return result;
      },
    } as unknown as Database;
    return {
      db,
      passes,
      wedge: () => {
        state.wedged = true;
      },
      release: () => {
        state.wedged = false;
        for (const resolve of state.waiting.splice(0)) resolve();
      },
      fail: (message) => {
        state.failing = message;
      },
    };
  }

  const riding = (
    url: string,
    overrides: { timeoutMs?: number; logger?: Logger } = {},
  ): Heartbeat =>
    new Heartbeat({
      url,
      intervalSeconds: PERIOD_SECONDS,
      passSeconds: PERIOD_SECONDS,
      version: '9.9.9',
      logger: overrides.logger ?? silent,
      timeoutMs: overrides.timeoutMs ?? 2_000,
    });

  it('sends while passes finish, stops when one wedges, and starts again when it returns', async () => {
    const target = await receiver();
    const fake = fakeDatabase();
    const heartbeat = riding(target.url);
    const housekeeper = new Housekeeper({
      db: fake.db,
      logger: silent,
      config: housekeeping(),
      witness: heartbeat,
    });
    housekeeper.start();
    try {
      // The control: a loop that turns is heard, again and again.
      await until(5_000, 'three heartbeats from a working loop', () => target.seen.length >= 3);

      fake.wedge();
      await until(5_000, 'a pass to wedge', () => fake.passes.started > fake.passes.finished);
      await heartbeat.settled();
      const heard = target.seen.length;
      const finished = fake.passes.finished;

      // Twelve periods of a process that is alive, whose timers fire and whose event loop turns:
      // a heartbeat on a timer of its own would have sent twelve.
      await sleep(PERIOD_SECONDS * 1_000 * 12);
      assert.equal(fake.passes.finished, finished, 'the control: no pass finished while wedged');
      assert.equal(
        target.seen.length,
        heard,
        'a heartbeat left a core whose housekeeping is wedged',
      );
      assert.equal(heartbeat.stats().failures, 0, 'and none is counted: nothing was attempted');

      fake.release();
      await until(5_000, 'heartbeats to resume', () => target.seen.length >= heard + 2);
    } finally {
      fake.release();
      heartbeat.stop();
      await housekeeper.stop();
    }
  });

  it('does not hold a pass up for a receiver that never answers', async () => {
    const target = await receiver(hangs);
    const fake = fakeDatabase();
    const TIMEOUT_MS = 1_500;
    const heartbeat = riding(target.url, { timeoutMs: TIMEOUT_MS });
    const housekeeper = new Housekeeper({
      db: fake.db,
      logger: silent,
      config: housekeeping(),
      witness: heartbeat,
    });
    const started = process.hrtime.bigint();
    const elapsedMs = (): number => Number(process.hrtime.bigint() - started) / 1e6;
    housekeeper.start();
    try {
      await until(5_000, 'the request to reach the receiver', () => target.seen.length > 0);
      // Passes go on finishing while the one request hangs: five more, inside its timeout.
      const before = fake.passes.finished;
      await until(TIMEOUT_MS - 300, 'five passes beside a hanging heartbeat', () => {
        return fake.passes.finished >= before + 5;
      });
      assert.equal(heartbeat.stats().failures, 0, 'the request is still in flight');
      assert.ok(elapsedMs() < TIMEOUT_MS, `the passes took ${String(elapsedMs())} ms`);
      assert.equal(target.seen.length, 1, 'and one request, not one a pass');

      // And the hanging request is given up at its timeout and counted.
      await until(
        5_000,
        'the hanging heartbeat to be counted',
        () => heartbeat.stats().failures > 0,
      );
      assert.ok(elapsedMs() >= TIMEOUT_MS - 20, `counted after ${String(elapsedMs())} ms`);
    } finally {
      heartbeat.stop();
      const stopping = process.hrtime.bigint();
      await housekeeper.stop();
      const stopMs = Number(process.hrtime.bigint() - stopping) / 1e6;
      assert.ok(stopMs < 1_000, `stopping housekeeping waited ${String(stopMs)} ms`);
    }
  });

  it('withholds the heartbeat of a pass that could not reach the database, and counts it', async () => {
    const target = await receiver();
    const fake = fakeDatabase();
    fake.fail('connect ECONNREFUSED 127.0.0.1:5432');
    const { logger, lines } = capturing();
    const heartbeat = riding(target.url, { logger });
    const housekeeper = new Housekeeper({
      db: fake.db,
      logger: silent,
      config: housekeeping(),
      witness: heartbeat,
    });
    housekeeper.start();
    try {
      await until(5_000, 'two failed passes to be counted', () => heartbeat.stats().failures >= 2);
      await heartbeat.settled();
      assert.equal(target.seen.length, 0, 'a heartbeat left a core that cannot reach its database');
      const line = lines.find((one) => one['phase'] === 'withheld');
      assert.equal(line?.['reason'], 'connect ECONNREFUSED 127.0.0.1:5432');

      fake.fail(null);
      await until(5_000, 'a heartbeat once the database is back', () => target.seen.length > 0);
    } finally {
      heartbeat.stop();
      await housekeeper.stop();
    }
  });

  it('sends nothing for a pass run by hand, or from a loop given no witness', async () => {
    const target = await receiver();
    const fake = fakeDatabase();
    const heartbeat = riding(target.url);
    const direct = new Housekeeper({
      db: fake.db,
      logger: silent,
      config: { ...housekeeping(), enabled: false },
      witness: heartbeat,
    });
    // Disabled, so `start` runs nothing; `runOnce` is the pass by itself.
    direct.start();
    await direct.runOnce();
    await sleep(PERIOD_SECONDS * 1_000 * 3);
    await heartbeat.settled();
    assert.equal(fake.passes.finished, 1);
    assert.equal(target.seen.length, 0);
    await direct.stop();
  });
});

/**
 * A receiver over HTTPS, by name and by address (`A-71`).
 *
 * `fetch` checked who a certificate was for with Node's own check and had nowhere to be handed
 * another, so `https://[::1]` was refused under a certificate that lists `::1` (`A-60`'s
 * defect). Certificates are made here with `openssl` and trusted through
 * `tls.setDefaultCACertificates`, as `tls-address-identity.test.ts` does, so that what is
 * refused is who the certificate is for and never who issued it — except the one left out of
 * that list on purpose.
 */
describe('the heartbeat over HTTPS, to a name and to an address (A-71)', () => {
  type Pair = { key: string; cert: string };
  interface Pairs {
    /** Lists both loopback addresses, as addresses. */
    readonly forAddresses: Pair;
    /** Lists two addresses that are neither loopback one. */
    readonly forOtherAddresses: Pair;
    /** Has `::1` as its common name and as a DNS name, and lists no address. */
    readonly speltLikeAnAddress: Pair;
    /** For the name `localhost`, and no address. */
    readonly forLocalhost: Pair;
    /** Lists both loopback addresses and `localhost`, and nothing here trusts it. */
    readonly untrusted: Pair;
  }

  /** Whether there is an `openssl` to make certificates with. */
  const opensslAvailable = (() => {
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  let dir = '';
  let pairs: Pairs | undefined;
  let v6 = false;
  const setTrusted = (tls as { setDefaultCACertificates?: (certs: string[]) => void })
    .setDefaultCACertificates;
  const getTrusted = (tls as { getCACertificates?: (type: string) => string[] }).getCACertificates;
  let trustedBefore: string[] | undefined;

  function certificate(file: string, commonName: string, names: string): Pair {
    const keyFile = join(dir, `${file}.key`);
    const certFile = join(dir, `${file}.crt`);
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyFile,
        '-out',
        certFile,
        '-days',
        '30',
        '-subj',
        `/CN=${commonName}`,
        '-addext',
        `subjectAltName=${names}`,
      ],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8') };
  }

  before(async () => {
    // Whether `::1` can be listened on here. Asked once, with a bound.
    v6 = await new Promise<boolean>((resolve) => {
      const server = createTcpServer();
      const timer = setTimeout(() => {
        server.close();
        resolve(false);
      }, 2_000);
      server.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      server.listen(0, '::1', () => {
        clearTimeout(timer);
        server.close(() => {
          resolve(true);
        });
      });
    });
    // **Only a missing `openssl` skips.** Anything else that goes wrong here throws, and every
    // case fails with it: a certificate that could not be made must not read as green.
    if (!opensslAvailable) return;
    dir = mkdtempSync(join(tmpdir(), 'ms-a71-'));
    const made: Pairs = {
      forAddresses: certificate('addresses', 'ms-a71-test', 'IP:127.0.0.1,IP:::1'),
      forOtherAddresses: certificate('others', 'ms-a71-test', 'IP:127.0.0.2,IP:::2'),
      speltLikeAnAddress: certificate('spelt', '::1', 'DNS:::1'),
      forLocalhost: certificate('localhost', 'localhost', 'DNS:localhost'),
      untrusted: certificate('untrusted', 'localhost', 'DNS:localhost,IP:127.0.0.1,IP:::1'),
    };
    pairs = made;
    if (setTrusted !== undefined && getTrusted !== undefined) {
      trustedBefore = getTrusted('default');
      setTrusted([
        ...trustedBefore,
        ...Object.values(made)
          .filter((pair: Pair) => pair !== made.untrusted)
          .map((pair: Pair) => pair.cert),
      ]);
    }
  });

  after(() => {
    if (trustedBefore !== undefined && setTrusted !== undefined) setTrusted(trustedBefore);
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  /** The certificates, or a skip that says why there are none. */
  function ready(t: { skip(reason: string): void }, needsV6: boolean): Pairs | null {
    if (!opensslAvailable) {
      t.skip('openssl is not on this machine');
      return null;
    }
    assert.ok(pairs !== undefined, 'the certificates were not made, and openssl is here');
    if (trustedBefore === undefined) {
      t.skip('this Node has no tls.setDefaultCACertificates to trust a test certificate with');
      return null;
    }
    if (needsV6 && !v6) {
      t.skip('this machine has no IPv6 loopback (::1) to listen on');
      return null;
    }
    return pairs;
  }

  interface Secure {
    readonly port: number;
    readonly seen: { url: string; host: unknown }[];
    /** Every name a client put in its hello (SNI). Nothing is added for a hello without one. */
    readonly named: string[];
  }

  /** An HTTPS receiver with one certificate. `listenHost` absent listens on every address. */
  async function secure(
    pair: Pair,
    listenHost: string | undefined,
    answer: (response: ServerResponse) => void = (response) => {
      response.writeHead(200).end('OK');
    },
  ): Promise<Secure> {
    const seen: Secure['seen'] = [];
    const named: string[] = [];
    const server = createSecureServer(
      {
        key: pair.key,
        cert: pair.cert,
        // Called only for a hello that carries a server name; with no context given back, the
        // handshake goes on with the certificate above.
        SNICallback: (servername, done) => {
          named.push(servername);
          done(null);
        },
      },
      (request, response) => {
        seen.push({ url: request.url ?? '', host: request.headers.host });
        answer(response);
      },
    );
    server.on('tlsClientError', () => undefined);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      if (listenHost === undefined) server.listen(0, resolve);
      else server.listen(0, listenHost, resolve);
    });
    open.push({
      origin: '',
      url: '',
      seen: [],
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    });
    return { port: (server.address() as AddressInfo).port, seen, named };
  }

  /** One heartbeat to `url`: what was counted, and the warning if there was one. */
  async function once(
    url: string,
    timeoutMs = 5_000,
  ): Promise<{
    stats: { sent: number; failures: number };
    warned: Record<string, unknown> | undefined;
    text: string;
  }> {
    const { logger, lines } = capturing();
    const heartbeat = new Heartbeat({
      url,
      intervalSeconds: 300,
      passSeconds: 300,
      version: '9.9.9',
      logger,
      timeoutMs,
    });
    heartbeat.passed();
    // Its own bound, and well inside the test's: the request has `timeoutMs` and no longer.
    await until(timeoutMs + 5_000, `the heartbeat to ${new URL(url).origin} to end`, () => {
      const { sent, failures } = heartbeat.stats();
      return sent + failures > 0;
    });
    await heartbeat.settled();
    return {
      stats: heartbeat.stats(),
      warned: lines.find((one) => one['level'] === 40),
      text: JSON.stringify(lines),
    };
  }

  const refusedFor = (warned: Record<string, unknown> | undefined): string => {
    assert.equal(warned?.['phase'], 'request', JSON.stringify(warned));
    const err = warned['err'] as { code?: string; message: string };
    return `${String(err.code)}: ${err.message}`;
  };

  it('reaches https://[::1] under a certificate that lists ::1, and names nobody in its hello', async (t) => {
    // The reproduction. With `fetch` this was one failure, "Host: ::1. is not cert's CN".
    const certificates = ready(t, true);
    if (certificates === null) return;
    const target = await secure(certificates.forAddresses, '::1');
    const result = await once(`https://[::1]:${String(target.port)}/${TOKEN}?site=north`);
    assert.deepEqual(result.stats, { sent: 1, failures: 0 }, JSON.stringify(result.warned));
    assert.deepEqual(target.seen, [
      { url: `/${TOKEN}?site=north`, host: `[::1]:${String(target.port)}` },
    ]);
    // An address is not a server name (RFC 6066), and none is sent for one.
    assert.deepEqual(target.named, []);
  });

  it('refuses, for https://[::1], every certificate that does not list that address', async (t) => {
    const certificates = ready(t, true);
    if (certificates === null) return;
    for (const [label, pair] of [
      ['other addresses', certificates.forOtherAddresses],
      ['the address as a DNS name and a common name', certificates.speltLikeAnAddress],
      ['a name', certificates.forLocalhost],
    ] as const) {
      const target = await secure(pair, '::1');
      const result = await once(`https://[::1]:${String(target.port)}/${TOKEN}`);
      assert.deepEqual(result.stats, { sent: 0, failures: 1 }, label);
      assert.match(
        refusedFor(result.warned),
        /^ERR_TLS_CERT_ALTNAME_INVALID: .*IP: ::1 is not in the cert's list/,
        label,
      );
      assert.equal(result.warned?.['receiver'], `https://[::1]:${String(target.port)}`);
      assert.deepEqual(target.seen, [], `${label}: the request, with its token, was sent`);
      assert.ok(!result.text.includes('s3cret-token'), 'the token reached the log');
    }
  });

  it('reaches https://127.0.0.1 under a certificate that lists it, and is refused under one that does not', async (t) => {
    const certificates = ready(t, false);
    if (certificates === null) return;
    const listed = await secure(certificates.forAddresses, '127.0.0.1');
    const good = await once(`https://127.0.0.1:${String(listed.port)}/${TOKEN}`);
    assert.deepEqual(good.stats, { sent: 1, failures: 0 }, JSON.stringify(good.warned));
    assert.deepEqual(listed.seen, [{ url: `/${TOKEN}`, host: `127.0.0.1:${String(listed.port)}` }]);
    assert.deepEqual(listed.named, []);

    for (const pair of [certificates.forOtherAddresses, certificates.forLocalhost]) {
      const other = await secure(pair, '127.0.0.1');
      const bad = await once(`https://127.0.0.1:${String(other.port)}/${TOKEN}`);
      assert.deepEqual(bad.stats, { sent: 0, failures: 1 });
      assert.match(
        refusedFor(bad.warned),
        /^ERR_TLS_CERT_ALTNAME_INVALID: .*IP: 127\.0\.0\.1 is not in the cert's list/,
      );
      assert.deepEqual(other.seen, []);
    }
  });

  it('by name is as it was: the name asked for in the hello, and the certificate checked against it', async (t) => {
    const certificates = ready(t, false);
    if (certificates === null) return;
    // On every address, because `localhost` may answer with either family here.
    const named = await secure(certificates.forLocalhost, undefined);
    const good = await once(`https://localhost:${String(named.port)}/${TOKEN}?site=north`);
    assert.deepEqual(good.stats, { sent: 1, failures: 0 }, JSON.stringify(good.warned));
    assert.deepEqual(named.seen, [
      { url: `/${TOKEN}?site=north`, host: `localhost:${String(named.port)}` },
    ]);
    assert.deepEqual(named.named, ['localhost']);

    // A certificate that lists the address the name resolves to is not one for the name.
    const addressed = await secure(certificates.forAddresses, undefined);
    const bad = await once(`https://localhost:${String(addressed.port)}/${TOKEN}`);
    assert.deepEqual(bad.stats, { sent: 0, failures: 1 });
    assert.match(refusedFor(bad.warned), /^ERR_TLS_CERT_ALTNAME_INVALID: .*localhost/);
    assert.deepEqual(addressed.seen, []);
  });

  it('still refuses a certificate nothing here trusts, whoever it says it is for', async (t) => {
    // The identity check is the only thing that changed. Who issued the certificate is asked
    // as before, of a name and of an address.
    const certificates = ready(t, false);
    if (certificates === null) return;
    const target = await secure(certificates.untrusted, undefined);
    for (const host of ['localhost', '127.0.0.1', ...(v6 ? ['[::1]'] : [])]) {
      const result = await once(`https://${host}:${String(target.port)}/${TOKEN}`);
      assert.deepEqual(result.stats, { sent: 0, failures: 1 }, host);
      assert.match(refusedFor(result.warned), /^DEPTH_ZERO_SELF_SIGNED_CERT: /, host);
    }
    assert.deepEqual(target.seen, []);
  });

  it('counts one failure for an HTTPS receiver that accepts and never answers', async (t) => {
    const certificates = ready(t, false);
    if (certificates === null) return;
    const target = await secure(certificates.forAddresses, '127.0.0.1', hangs);
    const started = process.hrtime.bigint();
    const result = await once(`https://127.0.0.1:${String(target.port)}/${TOKEN}`, 200);
    const waitedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.deepEqual(result.stats, { sent: 0, failures: 1 });
    assert.equal(result.warned?.['phase'], 'timeout');
    assert.equal(result.warned['timeoutMs'], 200);
    assert.ok(waitedMs >= 190, `given up after ${String(waitedMs)} ms, before its timeout`);
    assert.equal(target.seen.length, 1, 'the request did arrive; nothing answered it');
  });

  it('counts one failure for a listener that accepts and never finishes a handshake', async () => {
    // Nothing to do with a certificate: the timeout covers the connection and the handshake as
    // it covers the answer.
    const held: Socket[] = [];
    const server = createTcpServer((socket) => {
      socket.on('error', () => undefined);
      held.push(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    open.push({
      origin: '',
      url: '',
      seen: [],
      close: () =>
        new Promise<void>((resolve) => {
          for (const socket of held) socket.destroy();
          server.close(() => {
            resolve();
          });
        }),
    });
    const port = (server.address() as AddressInfo).port;
    const result = await once(`https://127.0.0.1:${String(port)}/${TOKEN}`, 200);
    assert.deepEqual(result.stats, { sent: 0, failures: 1 });
    assert.equal(result.warned?.['phase'], 'timeout');
  });

  it('counts a 2xx whose body never ends as arrived and hangs up on it, and a redirect over HTTPS as refused and not followed', async (t) => {
    const certificates = ready(t, false);
    if (certificates === null) return;
    // The status line is the heartbeat. A body that never ends is not waited on, and the
    // connection it would hold open is closed from this end, well inside the timeout.
    let hungUp = false;
    const endless = await secure(certificates.forAddresses, '127.0.0.1', (response) => {
      response.socket?.on('close', () => {
        hungUp = true;
      });
      response.writeHead(200, { 'content-length': '1000' });
      response.write('OK');
    });
    const arrived = await once(`https://127.0.0.1:${String(endless.port)}/${TOKEN}`, 30_000);
    assert.deepEqual(arrived.stats, { sent: 1, failures: 0 }, JSON.stringify(arrived.warned));
    await until(2_000, 'the heartbeat to hang up on a body it does not read', () => hungUp);

    const elsewhere = await secure(certificates.forAddresses, '127.0.0.1');
    const redirecting = await secure(certificates.forAddresses, '127.0.0.1', (response) => {
      response.writeHead(302, { location: `https://127.0.0.1:${String(elsewhere.port)}/taken` });
      response.end();
    });
    const refused = await once(`https://127.0.0.1:${String(redirecting.port)}/${TOKEN}`);
    assert.deepEqual(refused.stats, { sent: 0, failures: 1 });
    assert.equal(refused.warned?.['phase'], 'refused');
    assert.equal(refused.warned['status'], 302);
    assert.deepEqual(elsewhere.seen, [], 'the request, with its token, went where it was sent');
  });
});

/**
 * Every way a request can end is an end (`A-71`, found in its review).
 *
 * `fetch` answered for all of them. Node's own client tells of an answer with `response`, of a
 * failure with `error` — and of an answer it will not use (a `101`, with nobody listening for an
 * upgrade) with neither: it destroys the socket and says only `close`. A request waiting on the
 * first two never ended, the one-at-a-time rule then held every later heartbeat back behind it,
 * and nothing was counted or logged: a dead man's switch that had stopped without a word.
 *
 * The receivers here are bare TCP listeners that write the bytes themselves, because no HTTP
 * server will send most of these.
 */
describe('the heartbeat request always ends (A-71)', () => {
  /** A listener that reads one request and answers it as `answer` says. */
  async function raw(
    answer: (socket: Socket) => void,
  ): Promise<{ url: string; requests: () => number }> {
    let requests = 0;
    const held: Socket[] = [];
    const server = createTcpServer((socket) => {
      held.push(socket);
      socket.on('error', () => undefined);
      let read = '';
      socket.on('data', (chunk: Buffer) => {
        read += chunk.toString('latin1');
        if (!read.includes('\r\n\r\n')) return;
        read = '';
        requests += 1;
        answer(socket);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    open.push({
      origin: '',
      url: '',
      seen: [],
      close: () =>
        new Promise<void>((resolve) => {
          for (const socket of held) socket.destroy();
          server.close(() => {
            resolve();
          });
        }),
    });
    const port = (server.address() as AddressInfo).port;
    return { url: `http://127.0.0.1:${String(port)}/${TOKEN}`, requests: () => requests };
  }

  /**
   * Two passes an interval apart against one receiver: what each counted, and the warnings.
   * Every wait has its own bound, well inside the test's (rule 22): a request that never ends
   * fails here by name.
   */
  async function twoPasses(
    receiver: { url: string; requests: () => number },
    timeoutMs: number,
  ): Promise<{
    first: { sent: number; failures: number };
    second: { sent: number; failures: number };
    warned: Record<string, unknown>[];
    text: string;
  }> {
    const { logger, lines } = capturing();
    let now = 0;
    const heartbeat = new Heartbeat({
      url: receiver.url,
      intervalSeconds: 300,
      passSeconds: 300,
      version: '9.9.9',
      logger,
      timeoutMs,
      monotonicMs: () => now,
    });
    const ended = async (pass: string, count: number): Promise<void> => {
      await until(timeoutMs + 3_000, `the ${pass} heartbeat to end, one way or the other`, () => {
        const { sent, failures } = heartbeat.stats();
        return sent + failures >= count;
      });
    };
    try {
      heartbeat.passed();
      await ended('first', 1);
      const first = heartbeat.stats();
      // The next pass that is due sends the next one: nothing is left in flight to hold it back.
      now = 300_000;
      heartbeat.passed();
      await until(3_000, 'the second heartbeat to be sent at all', () => receiver.requests() >= 2);
      await ended('second', 2);
      await heartbeat.settled();
      return {
        first,
        second: heartbeat.stats(),
        warned: lines.filter((one) => one['level'] === 40),
        text: JSON.stringify(lines),
      };
    } finally {
      heartbeat.stop();
    }
  }

  it('counts a 101 nobody asked for as one failure, and the next pass sends again', async () => {
    const receiver = await raw((socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      );
    });
    // A long timeout, so that what ends the request is the answer and not the clock.
    const result = await twoPasses(receiver, 20_000);
    assert.deepEqual(result.first, { sent: 0, failures: 1 });
    assert.deepEqual(result.second, { sent: 0, failures: 2 });
    assert.equal(receiver.requests(), 2);
    assert.equal(result.warned.length, 2);
    const [line] = result.warned;
    assert.ok(line !== undefined);
    assert.equal(line['phase'], 'request');
    assert.equal(line['receiver'], new URL(receiver.url).origin);
    assert.match(
      (line['err'] as { message: string }).message,
      /closed .* with no answer this could use/,
    );
    assert.ok(!result.text.includes('s3cret-token'), 'the token reached the log');
  });

  it('counts a receiver that closes with no answer, either way of closing, and the next pass sends again', async () => {
    for (const [label, close] of [
      ['reset', (socket: Socket) => socket.destroy()],
      ['ended', (socket: Socket) => socket.end()],
      ['half an answer', (socket: Socket) => socket.end('HTTP/1.1 2')],
    ] as const) {
      const receiver = await raw(close);
      const result = await twoPasses(receiver, 20_000);
      assert.deepEqual(result.first, { sent: 0, failures: 1 }, label);
      assert.deepEqual(result.second, { sent: 0, failures: 2 }, label);
      assert.equal(receiver.requests(), 2, label);
      assert.equal(result.warned[0]?.['phase'], 'request', label);
    }
  });

  it('waits through an informational answer for the real one, and for its timeout and no longer when none follows', async () => {
    const hinted = await raw((socket) => {
      socket.write('HTTP/1.1 103 Early Hints\r\nLink: </x>; rel=preload\r\n\r\n');
      socket.write('HTTP/1.1 204 No Content\r\n\r\n');
    });
    const arrived = await twoPasses(hinted, 20_000);
    assert.deepEqual(arrived.second, { sent: 2, failures: 0 }, arrived.text);

    const stalled = await raw((socket) => {
      socket.write('HTTP/1.1 102 Processing\r\n\r\n');
    });
    const given = await twoPasses(stalled, 200);
    assert.deepEqual(given.second, { sent: 0, failures: 2 });
    assert.deepEqual(
      given.warned.map((line) => line['phase']),
      ['timeout', 'timeout'],
    );
  });
});
