import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import { checkedTarget, nameLookups, type ResolveHost } from '@ms/sensors';
import type { CheckResult, QueryFailure } from '@ms/shared';
import { lookupsBesideThePool, ProbeHealthReporter } from '../src/health/report.js';
import { QueryRunner } from '../src/queries/runner.js';
import { CheckPool, type ResultMeta } from '../src/runner/index.js';
import { TimingWheel } from '../src/scheduler/wheel.js';
import { loaded, LOAD_BOUND_MS, watchedWorkers } from './support/watched-workers.js';
import { pollWithin, within } from './support/within.js';

/**
 * The name lookups a pool's workers report, as Probe Health reads them (`A-66`).
 *
 * Through real workers running the real catalogue and guard (`support/lookup-registry.ts`), so
 * what is counted is what `resolveWithin` counted in a worker thread and the worker told the
 * pool: with a result, and on its own timer when a lookup settles with no check waiting for it.
 */

const silent = pino({ level: 'silent' });
const LOOKUPS = join(import.meta.dirname, 'support', 'lookup-registry.js');
const FIXTURES = join(import.meta.dirname, 'support', 'check-fixtures.js');

interface Seen {
  result: CheckResult;
  meta: ResultMeta;
}

const pools: CheckPool[] = [];
const queryRunners: QueryRunner[] = [];

after(async () => {
  await Promise.all([
    ...pools.map((pool) => pool.stop()),
    ...queryRunners.map((runner) => runner.stop()),
  ]);
});

async function poolOf(
  options: {
    size?: number;
    minSize?: number;
    idleShrinkMs?: number;
    registryModule?: string;
    sessionReportMs?: number;
  } = {},
) {
  const seen: Seen[] = [];
  const workers = watchedWorkers();
  const minSize = options.minSize ?? options.size ?? 1;
  const pool = new CheckPool({
    logger: silent,
    size: options.size ?? 1,
    minSize,
    idleShrinkMs: options.idleShrinkMs ?? 0,
    registryModule: options.registryModule ?? LOOKUPS,
    ...(options.sessionReportMs === undefined ? {} : { sessionReportMs: options.sessionReportMs }),
    createWorker: workers.createWorker,
    onResult: (result, meta) => seen.push({ result, meta }),
  });
  pools.push(pool);
  // **The workers load under a bound of their own, before any test times a check** (`P-446`).
  // `start` resolves once each has said ready or missed its start-up bound, and a loaded host has
  // taken the second: the five-second wait for a check then timed a replacement's load, and a
  // slow start read as the lookup counted wrong.
  await within(LOAD_BOUND_MS, 'the pool to start', pool.start());
  await loaded(workers, minSize, pool);
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

describe('name lookups on Probe Health (A-66)', () => {
  it('reports nothing at all when the registry counts no lookups', async () => {
    // A build that does not count them has nothing to say, and two zeros would be a claim.
    const { pool, seen } = await poolOf({ registryModule: FIXTURES });
    pool.submit({
      sensorId: 1,
      sensorType: 'test.ok',
      target: { host: '192.0.2.1', ipVersion: 'auto' },
      params: {},
      timeoutMs: 1_000,
    });
    await until(() => seen.length === 1, 'a check');
    assert.equal(pool.lookupCounters(), undefined);
    assert.equal(pool.stats().lookups, undefined, 'and it is absent from the stats too');
  });

  it('counts a lookup that answered in time as neither in flight nor given up', async () => {
    const { pool, seen } = await poolOf();
    pool.submit(named(1, 'answers.test', 5_000));
    await until(() => seen.length === 1, 'the check');
    assert.equal(seen[0]?.result.outcome, 'ok', seen[0]?.result.message);
    assert.deepEqual(pool.stats().lookups, { inFlight: 0, givenUp: 0 });
  });

  it('counts a device given as an address as no lookup at all', async () => {
    const { pool, seen } = await poolOf();
    pool.submit(named(1, '192.0.2.20', 5_000));
    await until(() => seen.length === 1, 'the check');
    assert.equal(seen[0]?.result.outcome, 'ok', seen[0]?.result.message);
    assert.deepEqual(pool.stats().lookups, { inFlight: 0, givenUp: 0 });
  });

  it('counts a name that does not resolve as answered: the resolver said so', async () => {
    const { pool, seen } = await poolOf();
    pool.submit(named(1, 'fails.test', 5_000));
    await until(() => seen.length === 1, 'the check');
    assert.equal(seen[0]?.result.outcome, 'error');
    assert.match(seen[0].result.message, /did not resolve to an IPv4 address/);
    assert.deepEqual(pool.stats().lookups, { inFlight: 0, givenUp: 0 });
  });

  it('sums every worker’s lookups given up and still in flight, after their checks failed', async () => {
    // Three resolvers that never answer, one check on each of three workers. Each check gives up
    // at its bound, half SNMP's 400 ms, and fails; each lookup stays on the thread pool, where
    // `getaddrinfo` cannot be cancelled. A pool reporting one worker's numbers says 1.
    const { pool, seen } = await poolOf({ size: 3 });
    for (let id = 1; id <= 3; id += 1) pool.submit(named(id, `hangs-${String(id)}.test`, 400));
    await until(() => seen.length === 3, 'three checks to give up');
    assert.equal(new Set(seen.map((one) => one.meta.workerId)).size, 3, 'one on each worker');
    for (const { result } of seen) {
      assert.equal(result.outcome, 'error');
      assert.match(result.message, /did not resolve within 200 ms/);
    }
    assert.deepEqual(pool.stats().lookups, { inFlight: 3, givenUp: 3 });
  });

  it('hears an idle worker say a lookup its check gave up on has been answered', async () => {
    // The answer comes 600 ms after the check gave up at 100: with no check running, so only the
    // worker's own report can say it. Before it, the lookup is in flight.
    const { pool, seen } = await poolOf({ sessionReportMs: 20 });
    pool.submit(named(1, 'late-600.test', 200));
    await until(() => seen.length === 1, 'the check to give up');
    assert.match(seen[0]?.result.message ?? '', /did not resolve within 100 ms/);
    assert.deepEqual(pool.stats().lookups, { inFlight: 1, givenUp: 1 });
    await until(
      () => pool.stats().lookups?.inFlight === 0,
      () => `the late answer to be reported; the pool says ${JSON.stringify(pool.stats().lookups)}`,
    );
    assert.deepEqual(pool.stats().lookups, { inFlight: 0, givenUp: 1 }, 'still given up');
  });

  it('counts a lookup a check is still waiting for as in flight before the check has finished', async () => {
    // A resolver taking 1.5 s, inside a 2.5 s bound: the check has no result yet, and it is the
    // worker's timer, running while the check waits, that puts the lookup on Probe Health.
    const { pool, seen } = await poolOf({ sessionReportMs: 20 });
    pool.submit(named(1, 'late-1500.test', 5_000));
    await until(
      () => pool.stats().lookups?.inFlight === 1,
      () =>
        `the waiting lookup to be reported; the pool says ${JSON.stringify(pool.stats().lookups)}`,
    );
    assert.equal(seen.length, 0, 'while the check was still waiting');
    assert.equal(pool.stats().lookups?.givenUp, 0);
    await until(() => seen.length === 1, 'the check', 5_000);
    assert.equal(seen[0]?.result.outcome, 'ok', seen[0]?.result.message);
    assert.deepEqual(pool.stats().lookups, { inFlight: 0, givenUp: 0 });
  });

  it('keeps the lookups a check the pool timed out gave up on, from its late result', async () => {
    // The pool's own timeout, 300 ms, comes before the lookup's bound, half of SNMP's 60 s: the
    // pool settles the check and aborts it, and the check gives the lookup up on its signal. The
    // worker sends that on the result the pool has already settled, and not again, since it has
    // not changed. The idle report is 5 s away, so it is not what is read here.
    const { pool, seen } = await poolOf();
    pool.submit(named(1, 'hangs.test', 60_000, 300));
    await until(() => seen.length === 1, 'the pool to time the check out');
    assert.equal(seen[0]?.meta.phase, 'timeout');
    await until(() => pool.stats().busy === 0, 'the worker to answer after its abort');
    assert.deepEqual(pool.stats().lookups, { inFlight: 1, givenUp: 1 });
  });

  it('never lets the given-up count fall when a worker goes away', async () => {
    // The retired baseline, as for the sessions (`P-36`). What the retired worker had in flight
    // goes with it, as a session it held does: nothing is left to say when the resolver answers.
    //
    // **No worker goes until the ceiling comes down.** The idle window is a minute, so the three
    // workers the bursts reach are the three the shrink chooses from: with a short window the pool
    // can retire and respawn workers between bursts, and three workers seen need not be three
    // held. Lowering the ceiling then retires two of the three, each of which has given a lookup
    // up, and the in-flight assertion at the end proves a reporting worker really went.
    //
    // Each check holds its worker for its 500 ms bound, so two of a burst of three wait in the
    // queue long enough for the workers that queue grows to take them, rather than the first
    // worker running all three one after another while the others load.
    const { pool, seen } = await poolOf({ size: 3, minSize: 1, idleShrinkMs: 60_000 });
    let submitted = 0;
    await until(
      () => {
        if (seen.length !== submitted) return false;
        // Every check so far has answered: done if three workers ran them, or send three more.
        if (new Set(seen.map((one) => one.meta.workerId)).size >= 3) return true;
        for (let i = 0; i < 3; i += 1) {
          submitted += 1;
          pool.submit(named(submitted, `hangs-${String(submitted)}.test`, 1_000));
        }
        return false;
      },
      () => {
        const { size, grown, shrunk, completed, failed } = pool.stats();
        const workers = new Set(seen.map((one) => one.meta.workerId)).size;
        return (
          `all three workers to have given a lookup up; ${String(seen.length)} checks on ` +
          `${String(workers)} workers, the pool ${JSON.stringify({ size, grown, shrunk, completed, failed })}`
        );
      },
      30_000,
    );
    assert.equal(pool.size, 3, 'and all three are still there');
    const before = pool.stats().lookups;
    assert.ok(before !== undefined);
    assert.equal(before.givenUp, submitted);

    pool.setMaxSize(1);
    await until(() => pool.size < 3, 'the pool to give workers back');
    const after = pool.stats().lookups;
    assert.ok(after !== undefined, 'still reporting after the shrink');
    assert.equal(after.givenUp, before.givenUp, 'the given-up count did not fall');
    assert.ok(after.inFlight < before.inFlight, 'and a retired worker’s in-flight went with it');
  });
});

describe('the name lookups beside the scheduled pool, on Probe Health (A-66)', () => {
  const never: ResolveHost = () => new Promise(() => undefined);

  /** Probe Health's own reporter, as the probe wires it, over a real pool and query runner. */
  function healthOf(pool: CheckPool, queries: QueryRunner): ProbeHealthReporter {
    const wheel = new TimingWheel({ logger: silent, onDue: () => undefined });
    return new ProbeHealthReporter({
      scheduler: () => wheel.stats(),
      pool: () => pool.stats(),
      lookups: lookupsBesideThePool(queries),
      memory: {
        machine: { lowest: () => null, takeLow: () => null },
        limit: { lowest: () => null, takeLow: () => null },
        start: () => undefined,
        stop: () => undefined,
      },
    });
  }

  it('counts a “Check now” lookup given up at its bound, beside a scan’s and this thread’s', async () => {
    // The query runner's worker loads the registry the scheduled pool's do, so a query of a
    // named device resolves as a scan does, is given up at the same bound, and leaves its lookup
    // on the same libuv thread pool. One of each here, three in all: a reporter that leaves any
    // of the three out says two.
    const before = nameLookups.stats();

    // This thread's, as discovery's identification makes one.
    await assert.rejects(
      checkedTarget({
        host: 'switch.example.test',
        resolve: never,
        family: 4,
        timeoutMs: 100,
        signal: new AbortController().signal,
        verb: 'query',
        doing: 'identifying switch.example.test',
      }),
      /did not resolve within 50 ms/,
    );

    // A scan's.
    const { pool, seen } = await poolOf();
    pool.submit(named(1, 'hangs-scan.test', 400));

    // A query's.
    const answers: { queryId: string; result?: CheckResult; failure?: QueryFailure }[] = [];
    const queries = new QueryRunner({
      logger: silent,
      registryModule: LOOKUPS,
      answer: (message) => answers.push(message),
    });
    queryRunners.push(queries);
    assert.equal(queries.lookupCounters(), undefined, 'nothing to say before its worker has run');
    await queries.start();
    queries.run(
      'q1',
      {
        kind: 'check',
        assignment: {
          sensorId: 2,
          sensorType: 'test.named',
          params: { timeoutMs: 400 },
          target: { host: 'hangs-query.test', ipVersion: 'auto' },
          intervalSeconds: 60,
          timeoutMs: 5_000,
        },
      },
      5_000,
    );

    await until(() => answers.length === 1 && seen.length === 1, 'the query and the scan');
    assert.equal(answers[0]?.failure, undefined);
    assert.match(answers[0]?.result?.message ?? '', /did not resolve within 200 ms/);
    assert.deepEqual(queries.lookupCounters(), { inFlight: 1, givenUp: 1 });
    assert.deepEqual(pool.stats().lookups, { inFlight: 1, givenUp: 1 });

    const report = healthOf(pool, queries).report();
    assert.equal(report.lookupsInFlight, before.inFlight + 3, 'in flight: all three');
    assert.equal(report.lookupsGivenUp, before.givenUp + 3, 'given up: all three');
  });

  it('is this thread’s own while the query runner’s worker has said nothing', () => {
    const beside = lookupsBesideThePool({ lookupCounters: () => undefined });
    assert.deepEqual(beside(), nameLookups.stats());
  });
});
