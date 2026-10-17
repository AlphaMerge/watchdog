import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import type { ResolvedAddress } from '@ms/sensors';
import type { CheckResult, QueryFailure } from '@ms/shared';
import { lookupsBesideThePool, ProbeHealthReporter } from '../src/health/report.js';
import { QueryRunner } from '../src/queries/runner.js';
import {
  NameResolver,
  type Family,
  type NameResolverOptions,
} from '../src/resolver/name-resolver.js';
import { CheckPool, type ResultMeta } from '../src/runner/index.js';
import { TimingWheel } from '../src/scheduler/wheel.js';
import { FAKE_ANSWER, fakeResolve } from './support/fake-names.js';
import { pollWithin } from './support/within.js';

/**
 * A pool's workers asking the probe's resolver (`P-426`): real workers running the real catalogue
 * and guard (`support/lookup-registry.ts`), each with the client its pool's `workerData` gives it,
 * and a `NameResolver` in this thread answering them from a `getaddrinfo` the test owns.
 */

const silent = pino({ level: 'silent' });
const LOOKUPS = join(import.meta.dirname, 'support', 'lookup-registry.js');

interface Seen {
  result: CheckResult;
  meta: ResultMeta;
}

const pools: CheckPool[] = [];
const queryRunners: QueryRunner[] = [];
const resolvers: NameResolver[] = [];

after(async () => {
  for (const resolver of resolvers) resolver.stop();
  await Promise.all([
    ...pools.map((pool) => pool.stop()),
    ...queryRunners.map((runner) => runner.stop()),
  ]);
});

/** A resolver over `fakeResolve`, or the test's own lookup, counting what it asks. */
function resolverOf(options: Partial<NameResolverOptions> = {}) {
  const asked: { host: string; family: Family }[] = [];
  const lookup = options.lookup ?? fakeResolve;
  const resolver = new NameResolver({
    logger: silent,
    watch: { files: [], everyMs: 60_000 },
    ...options,
    lookup: (host, family) => {
      asked.push({ host, family });
      return lookup(host, family);
    },
  });
  resolvers.push(resolver);
  return { resolver, asked };
}

async function poolOf(resolver: NameResolver | undefined, size = 1) {
  const seen: Seen[] = [];
  const pool = new CheckPool({
    logger: silent,
    size,
    minSize: size,
    idleShrinkMs: 0,
    registryModule: LOOKUPS,
    sessionReportMs: 20,
    ...(resolver === undefined ? {} : { resolver }),
    onResult: (result, meta) => seen.push({ result, meta }),
  });
  pools.push(pool);
  await pool.start();
  return { pool, seen };
}

function until(predicate: () => boolean, what: string | (() => string), timeoutMs = 5_000) {
  return pollWithin(timeoutMs, what, predicate, 5);
}

/** A check of `test.named`'s device `host`, with SNMP's timeout set to `snmpTimeoutMs`. */
const named = (sensorId: number, host: string, snmpTimeoutMs: number, poolTimeoutMs = 10_000) => ({
  sensorId,
  sensorType: 'test.named',
  target: { host, ipVersion: 'auto' as const },
  params: { timeoutMs: snmpTimeoutMs },
  timeoutMs: poolTimeoutMs,
});

/** Probe Health's reporter as the probe wires it, over a pool, a query runner and the resolver. */
function healthOf(
  pool: CheckPool,
  queries: QueryRunner,
  resolver: NameResolver,
): ProbeHealthReporter {
  const wheel = new TimingWheel({ logger: silent, onDue: () => undefined });
  return new ProbeHealthReporter({
    scheduler: () => wheel.stats(),
    pool: () => pool.stats(),
    lookups: lookupsBesideThePool(queries, resolver),
    memory: {
      machine: { lowest: () => null, takeLow: () => null },
      limit: { lowest: () => null, takeLow: () => null },
      start: () => undefined,
      stop: () => undefined,
    },
  });
}

function queryRunnerOf(resolver: NameResolver) {
  const answers: { queryId: string; result?: CheckResult; failure?: QueryFailure }[] = [];
  const queries = new QueryRunner({
    logger: silent,
    registryModule: LOOKUPS,
    resolver,
    answer: (message) => answers.push(message),
  });
  queryRunners.push(queries);
  return { queries, answers };
}

const query = (queries: QueryRunner, id: string, host: string) => {
  queries.run(
    id,
    {
      kind: 'check',
      assignment: {
        sensorId: 90,
        sensorType: 'test.named',
        params: { timeoutMs: 4_000 },
        target: { host, ipVersion: 'auto' },
        intervalSeconds: 60,
        timeoutMs: 10_000,
      },
    },
    10_000,
  );
};

describe('a pool’s workers ask the probe’s resolver (P-426)', () => {
  it('once for a name every worker’s checks resolve, kept between scans', async () => {
    const { resolver, asked } = resolverOf();
    const { pool, seen } = await poolOf(resolver, 2);
    for (let id = 1; id <= 4; id += 1) pool.submit(named(id, 'answers-shared.test', 4_000));
    await until(() => seen.length === 4, 'four checks');
    for (const { result } of seen) assert.equal(result.outcome, 'ok', result.message);
    assert.equal(new Set(seen.map(({ meta }) => meta.workerId)).size, 2, 'on both workers');
    assert.deepEqual(asked, [{ host: 'answers-shared.test', family: 4 }], 'asked once');
    assert.deepEqual(pool.stats().lookups, { inFlight: 0, givenUp: 0 });
  });

  it('fails a check at once for a name it holds, naming the resolver, given up', async () => {
    const { resolver, asked } = resolverOf();
    const { pool, seen } = await poolOf(resolver);
    pool.submit(named(1, 'again-down.test', 4_000));
    await until(() => seen.length === 1, 'the first check');
    pool.submit(named(2, 'again-down.test', 4_000));
    await until(() => seen.length === 2, 'the second check');
    for (const { result } of seen) {
      assert.equal(result.outcome, 'error');
      assert.match(result.message, /the probe’s resolver is not answering/u);
    }
    assert.match(seen[1]?.result.message ?? '', /again-down\.test is held for \d+ s more/u);
    assert.ok((seen[1]?.result.durationMs ?? Infinity) < 1_000, 'at once, not at its 2 s bound');
    assert.equal(asked.length, 1, 'held: asked once');
    await until(() => pool.stats().lookups?.givenUp === 2, 'both given up');
    assert.equal(pool.stats().lookups?.inFlight, 0, 'the resolver’s to count, not the worker’s');
  });

  it('counts a lookup a check stopped waiting for in flight until it answers, then not', async () => {
    // The check gives up at 100 ms; the lookup answers at 600. It is the resolver's, running,
    // from the moment it is asked: the worker forgets it at its bound and never counts it.
    const { resolver } = resolverOf({ stuckMs: 60_000 });
    const { pool, seen } = await poolOf(resolver);
    const { queries } = queryRunnerOf(resolver);
    const health = healthOf(pool, queries, resolver);
    const before = health.report();
    pool.submit(named(1, 'late-600.test', 200));
    await until(() => seen.length === 1, 'the check to give up');
    assert.match(seen[0]?.result.message ?? '', /did not resolve within 100 ms/u);
    const during = health.report();
    assert.equal((during.lookupsInFlight ?? 0) - (before.lookupsInFlight ?? 0), 1, 'in flight');
    await until(
      () => health.report().lookupsGivenUp === (before.lookupsGivenUp ?? 0) + 1,
      'the given-up to be reported',
    );
    await until(
      () => health.report().lookupsInFlight === before.lookupsInFlight,
      () => `the late answer to take it out of flight: ${JSON.stringify(resolver.stats())}`,
    );
    assert.equal(
      health.report().lookupsGivenUp,
      (before.lookupsGivenUp ?? 0) + 1,
      'still given up',
    );
  });

  it('says a main thread that did not take the lookup in time is the probe overloaded', async () => {
    const { resolver } = resolverOf();
    const { pool, seen } = await poolOf(resolver);
    // SNMP's 400 ms gives the lookup 200, all of which the main thread has to take it (`P-426`'s
    // review). This thread is held for longer than that, as a stalled event loop is, from the
    // moment the check is sent.
    pool.submit(named(1, 'answers-busy.test', 400));
    const until_ = performance.now() + 700;
    while (performance.now() < until_) {
      // A main thread that reads no message.
    }
    await until(() => seen.length === 1, 'the check');
    const result = seen[0]?.result;
    assert.ok(result !== undefined);
    assert.equal(result.outcome, 'error');
    assert.match(
      result.message,
      /could not be resolved, querying answers-busy\.test:161 over SNMP — the probe’s main thread did not take the lookup within 200 ms \(the probe is overloaded\)$/u,
    );
    assert.doesNotMatch(result.message, /resolver is not answering/u);
    assert.deepEqual(pool.stats().lookups, { inFlight: 0, givenUp: 0 }, 'not given up');
  });

  it('answers a worker whose lookup the resolver’s handler threw on, rather than leaving it waiting', async () => {
    const throwing = {
      handle: (): void => {
        throw new Error('the resolver broke');
      },
    };
    const seen: Seen[] = [];
    const pool = new CheckPool({
      logger: silent,
      size: 1,
      minSize: 1,
      registryModule: LOOKUPS,
      resolver: throwing,
      onResult: (result, meta) => seen.push({ result, meta }),
    });
    pools.push(pool);
    await pool.start();
    pool.submit(named(1, 'answers.test', 4_000));
    await until(() => seen.length === 1, 'the check');
    assert.match(
      seen[0]?.result.message ?? '',
      /could not be resolved, querying answers\.test:161 over SNMP — the probe’s resolver failed: the resolver broke$/u,
    );
    assert.ok((seen[0]?.result.durationMs ?? Infinity) < 1_000, 'at once');
  });
});

describe('“Check now” asks the probe’s resolver fresh (P-426)', () => {
  it('asks again for a name a scan has kept, and says when it used the kept answer instead', async () => {
    let silentNow = false;
    const { resolver, asked } = resolverOf({
      stuckMs: 100,
      lookup: (host, family) =>
        silentNow
          ? new Promise<readonly ResolvedAddress[]>(() => undefined)
          : fakeResolve(host, family),
    });
    const { pool, seen } = await poolOf(resolver);
    pool.submit(named(1, 'answers-fix.test', 4_000));
    await until(() => seen.length === 1, 'the scan');
    assert.equal(asked.length, 1);

    const { queries, answers } = queryRunnerOf(resolver);
    await queries.start();
    query(queries, 'q1', 'answers-fix.test');
    await until(() => answers.length === 1, 'the first query');
    const fresh = answers[0]?.result;
    assert.ok(fresh !== undefined);
    assert.equal(fresh.outcome, 'ok', fresh.message);
    assert.equal(fresh.message, 'answered', 'nothing to say: the resolver answered');
    assert.equal(asked.length, 2, 'asked again, though the scan’s answer was kept');

    silentNow = true;
    query(queries, 'q2', 'answers-fix.test');
    await until(() => answers.length === 2, 'the second query');
    const kept = answers[1]?.result;
    assert.ok(kept !== undefined);
    assert.equal(kept.outcome, 'ok');
    assert.match(
      kept.message,
      /^answered \(the probe’s resolver did not answer for answers-fix\.test \(a lookup for answers-fix\.test has run 0 s without an answer\), so this check used the address it answered \d+ s ago\)$/u,
    );
    assert.equal(asked.length, 3);
    assert.deepEqual(FAKE_ANSWER, [{ address: '192.0.2.10', family: 4 }]);
  });
});

describe('a check worker (P-426)', () => {
  it('runs only what it is told to run: the resolver’s replies on its port are not checks', async () => {
    const worker = new Worker(join(import.meta.dirname, '..', 'src', 'runner', 'check-worker.js'), {
      workerData: { registryModule: pathToFileURL(LOOKUPS).href, sessionReportMs: 60_000 },
    });
    try {
      const said: { type?: unknown }[] = [];
      worker.on('message', (message: { type?: unknown }) => said.push(message));
      await until(() => said.some(({ type }) => type === 'ready'), 'the worker to start');
      worker.postMessage({ type: 'resolve-ack', id: 1 });
      worker.postMessage({ type: 'resolved', id: 1, ok: true, addresses: FAKE_ANSWER });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(
        said.map(({ type }) => type),
        ['ready'],
        'no check ran, and no result was sent',
      );
    } finally {
      await worker.terminate();
    }
  });
});
