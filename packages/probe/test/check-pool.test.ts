import { strict as assert } from 'node:assert';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { BroadcastChannel } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import { availableParallelism } from 'node:os';
import type { CheckResult, Logger } from '@ms/shared';
import {
  CheckPool,
  defaultPoolSize,
  SPAWN_CONCURRENCY,
  WORKER_YOUNG_GENERATION_MB,
  type ResultMeta,
} from '../src/runner/index.js';
import { typicalOf } from '../src/runner/pool.js';
import { STARTUP_TIMEOUT_MS } from '../src/runner/process-runner.js';
import { within } from './support/probe-process.js';
import { ICMP_PING_CHECK_MS, littleFloor, V1_TARGET_BURST } from '../src/measured.js';
import { poolDemand } from '../src/runner/demand.js';

const silent = pino({ level: 'silent' });

/** At runtime this file is dist/test/check-pool.test.js, beside the compiled fixtures. */
const FIXTURES = join(import.meta.dirname, 'support', 'check-fixtures.js');

interface Seen {
  result: CheckResult;
  meta: ResultMeta;
}

const pools: CheckPool[] = [];
const scratches: string[] = [];

async function poolOf(
  options: {
    size?: number;
    minSize?: number;
    idleShrinkMs?: number;
    durationWindowMs?: number;
    abortGraceMs?: number;
    queueMaxLength?: number;
  } = {},
) {
  const seen: Seen[] = [];
  const pool = new CheckPool({
    logger: silent,
    size: options.size ?? 2,
    // Fixed unless a test says otherwise, so the sizing loop (`P-18`) is exercised where it is
    // the subject and cannot quietly change the answer everywhere else.
    minSize: options.minSize ?? options.size ?? 2,
    registryModule: FIXTURES,
    ...(options.idleShrinkMs === undefined ? {} : { idleShrinkMs: options.idleShrinkMs }),
    ...(options.durationWindowMs === undefined
      ? {}
      : { durationWindowMs: options.durationWindowMs }),
    ...(options.abortGraceMs === undefined ? {} : { abortGraceMs: options.abortGraceMs }),
    ...(options.queueMaxLength === undefined ? {} : { queueMaxLength: options.queueMaxLength }),
    onResult: (result, meta) => seen.push({ result, meta }),
  });
  pools.push(pool);
  await pool.start();
  return { pool, seen };
}

/** Waits for a condition, or fails the test rather than hanging the suite. */
async function until(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const request = (sensorId: number, sensorType: string, extra: Record<string, unknown> = {}) => ({
  sensorId,
  sensorType,
  // Every check points somewhere; the fixtures ignore it, but the shape is the real one.
  target: { host: '192.0.2.1', ipVersion: 'auto' as const },
  params: extra,
  timeoutMs: Number(extra['timeoutMs'] ?? 1_000),
});

after(async () => {
  await Promise.all(pools.map((pool) => pool.stop()));
  for (const dir of scratches) await rm(dir, { recursive: true, force: true });
});

describe('check pool', () => {
  it('runs a check and reports its channels', async () => {
    const { pool, seen } = await poolOf();
    assert.equal(pool.submit(request(1, 'test.ok')), 'accepted');

    await until(() => seen.length === 1, 'the check to finish');
    const entry = seen[0];
    assert.ok(entry);
    assert.equal(entry.result.outcome, 'ok');
    assert.equal(entry.result.sensorId, 1);
    assert.deepEqual(entry.result.channels, [
      { key: 'value', value: 42, name: 'Value', unit: 'ms' },
    ]);
    assert.equal(entry.meta.phase, 'execute');
    assert.ok(entry.result.durationMs >= 0);
  });

  it('records no channel values for a failed check', async () => {
    const { pool, seen } = await poolOf();
    pool.submit(request(2, 'test.throw'));

    await until(() => seen.length === 1, 'the failure');
    const entry = seen[0];
    assert.ok(entry);
    assert.equal(entry.result.outcome, 'error');
    assert.match(entry.result.message, /on purpose/);
    // A Down sensor records no channel values (CLAUDE.md): the gap is the data.
    assert.deepEqual(entry.result.channels, []);
  });

  it('marks a check refused over its credentials’ targets, and no other failure', async () => {
    // The core holds such a sensor Unknown rather than counting a failed scan (`A-41c`), and the
    // mark is the only thing that tells it which this was.
    const { pool, seen } = await poolOf();
    pool.submit(request(3, 'test.withheld'));
    pool.submit(request(4, 'test.throw'));

    await until(() => seen.length === 2, 'both failures');
    const refused = seen.find((one) => one.result.sensorId === 3)?.result;
    const failed = seen.find((one) => one.result.sensorId === 4)?.result;
    assert.ok(refused !== undefined && failed !== undefined);
    assert.equal(refused.outcome, 'error');
    assert.equal(refused.withheld, true);
    assert.equal(refused.message, 'Not scanned: outside the allowed targets');
    assert.deepEqual(refused.channels, []);
    assert.equal('withheld' in failed, false, 'an ordinary failure carries no mark at all');
  });

  it('reports a resolver that hangs as a refusal, not as the check timing out', async () => {
    // `A-41c`. The pool settles a check that outlasts its timeout as a plain failure, and only
    // then tells the worker to stop: a refusal raised by that abort arrives for a job already
    // settled. So the resolution has its own, shorter bound, and its refusal gets here first.
    //
    // **One worker, given the module the fixture imports before the check that is timed**
    // (`P-258`). Loaded inside the check, the import sat between the check's timeout, armed at
    // dispatch, and the resolution's bound, armed after it: on a loaded machine it took up to
    // 5.7 s, the check's timeout won, and the test failed for a delay a probe does not have. A
    // probe's worker loads its catalogue before it says ready, so its two clocks start together,
    // as these now do. What is left between them is one thread's timer against another's and a
    // message between them: under 0.9 s at load 6 to 29, where the margin is 3 s.
    const { pool, seen } = await poolOf({ size: 1 });
    // Its own generous timeout: a load that outlasted it would leave the module half-loaded in a
    // worker the pool then replaces.
    pool.submit(request(6, 'test.load-resolver', { timeoutMs: 30_000 }));
    await until(() => seen.length === 1, 'the module to load', 35_000);
    const loaded = seen[0];
    assert.ok(loaded !== undefined);
    assert.equal(loaded.result.outcome, 'ok', loaded.result.message);

    pool.submit(request(5, 'test.resolve-hangs', { timeoutMs: 6_000 }));
    await until(() => seen.length === 2, 'the refusal', 10_000);
    const refused = seen[1];
    assert.ok(refused !== undefined);
    // The refusal first: a check the pool's timeout settled is emitted with worker 0, so asking
    // for the worker first would hide the failure this test is for behind a worker mismatch.
    const result = refused.result;
    assert.equal(result.outcome, 'error');
    assert.equal(result.withheld, true, result.message);
    assert.match(result.message, /^Not scanned: switch\.invalid did not resolve within 3000 ms/);
    assert.doesNotMatch(result.message, /did not finish within/);
    assert.deepEqual(result.channels, []);
    assert.equal(
      refused.meta.workerId,
      loaded.meta.workerId,
      `ran in the worker that loaded the module; settled in phase ${refused.meta.phase}: ` +
        result.message,
    );
  });

  it('reports an unknown sensor type rather than hanging on it', async () => {
    const { pool, seen } = await poolOf();
    pool.submit(request(3, 'nope.missing'));

    await until(() => seen.length === 1, 'the refusal');
    const entry = seen[0];
    assert.ok(entry);
    assert.equal(entry.result.outcome, 'error');
    assert.match(entry.result.message, /no such check type/);
  });

  // -----------------------------------------------------------------------------------------
  // The Phase 2 exit criteria.
  // -----------------------------------------------------------------------------------------

  it('lets other checks through while one is hung', async () => {
    // "A deliberately hung check does not delay any other check" (PLAN.md, Phase 2).
    const { pool, seen } = await poolOf({ size: 2, abortGraceMs: 10_000 });
    pool.submit({ ...request(10, 'test.hang'), timeoutMs: 60_000 });

    for (let id = 11; id <= 15; id += 1) pool.submit(request(id, 'test.ok'));

    await until(() => seen.length === 5, 'the healthy checks to finish');
    assert.ok(
      seen.every((entry) => entry.result.outcome === 'ok'),
      'all five ran while the hang was outstanding',
    );
    assert.ok(!seen.some((entry) => entry.result.sensorId === 10), 'and the hang is still hung');
  });

  it('reports a timeout when it happens, not when the check gives up', async () => {
    // A sensor stuck on a dead connection has to report Down on schedule, or the state machine
    // learns about the outage a minute late.
    const { pool, seen } = await poolOf({ abortGraceMs: 10_000 });
    const startedAt = Date.now();
    pool.submit({ ...request(20, 'test.hang'), timeoutMs: 150 });

    await until(() => seen.length === 1, 'the timeout');
    const elapsed = Date.now() - startedAt;
    const entry = seen[0];
    assert.ok(entry);
    assert.equal(entry.result.outcome, 'error');
    assert.equal(entry.meta.phase, 'timeout');
    // Against the alternative, the check giving up at `abortGraceMs` (10 s), and at half of it
    // rather than an absolute budget, so a loaded machine cannot fail it (`P-234`).
    assert.ok(elapsed < 5_000, `the result arrived after ${String(elapsed)} ms`);
    assert.equal(pool.stats().timedOut, 1);
  });

  it('reuses the worker when a check honours its abort', async () => {
    const { pool, seen } = await poolOf({ size: 1, abortGraceMs: 5_000 });
    pool.submit({ ...request(30, 'test.slow', { delayMs: 5_000 }), timeoutMs: 100 });
    await until(() => seen.length === 1, 'the timeout');

    // The cheap path: the check returned when asked, so the worker is available immediately and
    // nothing had to be terminated.
    pool.submit(request(31, 'test.ok'));
    await until(() => seen.length === 2, 'the next check on the same worker');
    assert.equal(seen[1]?.result.outcome, 'ok');
    assert.equal(pool.stats().workerCrashes, 0, 'no worker was harmed');
  });

  it('terminates and replaces a worker whose check ignores its abort', async () => {
    const { pool, seen } = await poolOf({ size: 1, abortGraceMs: 100 });
    pool.submit({ ...request(40, 'test.hang'), timeoutMs: 100 });
    await until(() => seen.length === 1, 'the timeout');

    // The worker cannot be reclaimed cooperatively, so it is terminated — and the pool comes
    // back to full strength on its own.
    pool.submit(request(41, 'test.ok'));
    await until(() => seen.length === 2, 'the pool to recover', 8_000);
    assert.equal(seen[1]?.result.outcome, 'ok');
    assert.equal(pool.stats().size, 1, 'and it is still one worker, not two');
  });

  it('loses exactly one result when a worker dies mid-check', async () => {
    // "Killing a worker mid-check loses exactly one result and recycles cleanly" (PLAN.md).
    const { pool, seen } = await poolOf({ size: 1 });
    pool.submit(request(50, 'test.crash'));

    await until(() => seen.length === 1, 'the crash to be reported');
    const crashed = seen[0];
    assert.ok(crashed);
    assert.equal(crashed.result.sensorId, 50);
    assert.equal(crashed.result.outcome, 'error');
    assert.equal(crashed.meta.phase, 'worker-crash');

    pool.submit(request(51, 'test.ok'));
    await until(() => seen.length === 2, 'the pool to recycle', 8_000);
    assert.equal(seen[1]?.result.outcome, 'ok');
    assert.ok(pool.stats().workerCrashes >= 1, 'and the crash is counted');
  });

  it('counts one dead worker once, however many events it fires', async () => {
    // `P-73`. An uncaught exception in a worker fires `error` **and then** `exit`, and
    // `#onWorkerGone` ran for both. One death counted two crashes, spent two of the
    // consecutive-start-failure budget — so the pool gave up after two failing workers rather
    // than the three its own comment describes — and spawned two replacements, leaving the pool
    // one worker over its bound. `test.crash` cannot see this: `process.exit` fires `exit` alone.
    const { pool, seen } = await poolOf({ size: 1 });
    pool.submit(request(60, 'test.uncaught'));

    await until(() => seen.length === 1, 'the crash to be reported', 8_000);
    assert.equal(seen[0]?.meta.phase, 'worker-crash');

    pool.submit(request(61, 'test.ok'));
    await until(() => seen.length === 2, 'the pool to recycle', 8_000);
    assert.equal(seen[1]?.result.outcome, 'ok');

    assert.equal(pool.stats().workerCrashes, 1, 'one worker died, so one crash');
    assert.equal(pool.stats().size, 1, 'and it was replaced once, not twice');
  });

  // -----------------------------------------------------------------------------------------
  // Backpressure.
  // -----------------------------------------------------------------------------------------

  it('skips a sensor whose previous scan has not finished', async () => {
    const { pool, seen } = await poolOf({ size: 2, abortGraceMs: 10_000 });
    assert.equal(pool.submit({ ...request(60, 'test.hang'), timeoutMs: 60_000 }), 'accepted');

    // The rule from WORKFLOW.MD §3: skipped, not stacked. It costs nothing to decide because
    // the wheel has already scheduled the next scan.
    assert.equal(pool.submit(request(60, 'test.ok')), 'already-running');
    assert.equal(pool.stats().deferred, 1);
    assert.equal(seen.length, 0);
  });

  it('accepts a sensor again once its check has finished', async () => {
    const { pool, seen } = await poolOf();
    pool.submit(request(70, 'test.ok'));
    await until(() => seen.length === 1, 'the first check');
    assert.equal(pool.submit(request(70, 'test.ok')), 'accepted');
    await until(() => seen.length === 2, 'the second check');
  });

  it('refuses work past the queue bound, and counts what it refused', async () => {
    const { pool } = await poolOf({ size: 1, queueMaxLength: 2, abortGraceMs: 10_000 });
    // One worker, busy for a minute; the queue takes two and no more.
    pool.submit({ ...request(80, 'test.hang'), timeoutMs: 60_000 });
    assert.equal(pool.submit(request(81, 'test.ok')), 'accepted');
    assert.equal(pool.submit(request(82, 'test.ok')), 'accepted');
    assert.equal(pool.submit(request(83, 'test.ok')), 'queue-full');
    assert.equal(pool.stats().refused, 1, 'never dropped without counting');
  });

  it('logs a refusal episode once, with the first check refused and the bound (P-216)', async () => {
    const lines: Record<string, unknown>[] = [];
    const pool = new CheckPool({
      logger: pino(
        { level: 'info' },
        { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
      ),
      size: 1,
      minSize: 1,
      queueMaxLength: 2,
      abortGraceMs: 10_000,
      registryModule: FIXTURES,
      onResult: () => undefined,
    });
    pools.push(pool);
    await pool.start();
    pool.submit({ ...request(90, 'test.hang'), timeoutMs: 60_000 });
    pool.submit(request(91, 'test.ok'));
    pool.submit(request(92, 'test.ok'));
    for (let sensor = 93; sensor < 593; sensor += 1) {
      assert.equal(pool.submit(request(sensor, 'test.ok')), 'queue-full');
    }
    assert.equal(pool.stats().refused, 500, 'every refusal counted');
    const refusals = lines.filter((line) => String(line['msg']).includes('refusing a check'));
    assert.equal(refusals.length, 1, 'and one line for all of them');
    const first = refusals[0] ?? {};
    assert.equal(first['sensorId'], 93);
    assert.equal(first['sensorType'], 'test.ok');
    assert.equal(first['queueMax'], 2);
  });

  it('answers every queued check when it stops, rather than dropping them', async () => {
    const seen: Seen[] = [];
    const pool = new CheckPool({
      logger: silent,
      size: 1,
      registryModule: FIXTURES,
      abortGraceMs: 10_000,
      onResult: (result, meta) => seen.push({ result, meta }),
    });
    await pool.start();
    pool.submit({ ...request(90, 'test.hang'), timeoutMs: 60_000 });
    pool.submit(request(91, 'test.ok'));

    await pool.stop();
    assert.equal(seen.length, 2, 'the running one and the queued one');
    assert.ok(seen.every((entry) => entry.meta.phase === 'pool-stopped'));
    assert.equal(pool.submit(request(92, 'test.ok')), 'stopped');
  });

  it('lets a running check finish inside the drain window when it stops', async () => {
    const { pool, seen } = await poolOf({ size: 1 });
    pool.submit(request(93, 'test.slow', { delayMs: 200 }));
    pool.submit(request(94, 'test.ok'));

    const startedAt = Date.now();
    // A bound far past the check, so returning early is told from waiting it out on any machine.
    await pool.stop({ drainMs: 60_000 });
    assert.ok(Date.now() - startedAt < 30_000, 'returned when the check did, not at the bound');
    const phases = Object.fromEntries(seen.map((one) => [one.result.sensorId, one.meta.phase]));
    assert.deepEqual(phases, { 93: 'execute', 94: 'pool-stopped' }, 'the queued one never started');
    assert.equal(seen.find((one) => one.result.sensorId === 93)?.result.outcome, 'ok');
    assert.equal(pool.submit(request(95, 'test.ok')), 'stopped');
  });

  it('abandons a check that outlives the drain window, rather than waiting on it', async () => {
    const { pool, seen } = await poolOf({ size: 1, abortGraceMs: 10_000 });
    pool.submit({ ...request(96, 'test.hang'), timeoutMs: 60_000 });

    const startedAt = Date.now();
    await pool.stop({ drainMs: 150 });
    const took = Date.now() - startedAt;
    // Under half the check's own 60 s, which is what waiting on it would cost (`P-234`).
    assert.ok(took >= 140 && took < 30_000, `bounded by the window: ${String(took)} ms`);
    assert.deepEqual(
      seen.map((one) => one.meta.phase),
      ['pool-stopped'],
      'answered exactly once',
    );
  });

  it('gives up rather than respawning for ever when workers cannot start', async () => {
    const seen: Seen[] = [];
    const pool = new CheckPool({
      logger: silent,
      size: 1,
      registryModule: join(import.meta.dirname, 'support', 'no-such-registry.js'),
      onResult: (result, meta) => seen.push({ result, meta }),
    });
    pools.push(pool);
    await pool.start();

    // A registry that cannot be imported kills every worker the moment it starts. Retrying at
    // the speed of the event loop would fill the log and bury the one line that mattered.
    await until(
      () => pool.submit(request(100, 'test.ok')) === 'disabled',
      'the pool to disable itself',
    );
    assert.ok(pool.stats().workerCrashes >= 1);

    // **The latch must answer what it already accepted** (`P-80`). This test reached the state and
    // asserted nothing about it: sensor 100's first submit returned `accepted` — the latch had not
    // fired yet — so a job went into `#queue` and a sensor into `#active`. A queued job carries no
    // timeout, because the timer is armed in `#dispatch` when it *leaves* the queue, so the latch
    // returning without draining left it permanently unsettled: no result, no timer, and counted
    // in none of completed/failed/timedOut/refused/discarded. `check-flow.ts` states the
    // guarantee this broke verbatim — 'a check accepted by a runner must settle'.
    assert.equal(pool.stats().queued, 0, 'the latch answered every check it had accepted');
    assert.ok(
      seen.some((entry) => entry.result.sensorId === 100),
      'and sensor 100 got a result rather than vanishing',
    );
  });

  it('does not give up while it still has workers that are working', async () => {
    // **`P-62`'s latch, over-triggering** (`P-80`). `#startFailures` is pool-wide and reset only
    // by a worker reaching `ready`, and was never weighed against how many workers the pool still
    // holds. `#grow` spawned the whole shortfall in one synchronous burst — 60 at once at the v1
    // target, each loading the ~35 MB sensor catalogue, and eight at a time since `P-206` — so on
    // a memory-tight host three
    // bootstrap failures among sixty land before any sibling reports ready, and the pool latches
    // off for good with 57 healthy workers in it. `#admission` returns `disabled` before it looks
    // at anything else, so a probe with a full complement of idle workers monitored nothing until
    // somebody restarted it.
    //
    // The latch exists for a pool that cannot run checks *at all* — `P-62`'s broken registry,
    // where every worker dies and the test above still latches. Holding ready workers is the
    // difference between the two, and it is what the condition asks now.
    const seen: Seen[] = [];
    const pool = new CheckPool({
      logger: silent,
      size: 8,
      minSize: 2,
      registryModule: join(import.meta.dirname, 'support', 'breakable-registry.js'),
      onResult: (result, meta) => seen.push({ result, meta }),
    });
    pools.push(pool);
    await pool.start();
    await until(() => pool.stats().size >= 2, 'the initial workers to come up');

    // Every worker spawned from here dies during bootstrap; the ones already up are untouched.
    const scratch = await mkdtemp(join(tmpdir(), 'ms-pool-'));
    scratches.push(scratch);
    const sentinel = join(scratch, 'break');
    await writeFile(sentinel, 'x');
    process.env['MS_TEST_BREAK_REGISTRY'] = sentinel;
    try {
      // Enough queued work to make the pool grow, so it spawns — and every spawn fails.
      for (let id = 1; id <= 8; id += 1) {
        pool.submit({ ...request(id, 'test.slow'), params: { delayMs: 40 } });
      }
      await until(() => pool.stats().workerCrashes >= 3, 'three failed starts');

      // **And it backs off while it keeps trying** (`P-227`). With ready workers the latch never
      // fires, so every failed start was replaced at once: a boot, a failed import and an error
      // line, eight chains at a time, for as long as the cause lasted. Hundreds a second here.
      const before = pool.stats().workerCrashes;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const retried = pool.stats().workerCrashes - before;
      assert.ok(retried < 20, `${String(retried)} failed starts in two seconds`);

      assert.notEqual(pool.submit(request(99, 'test.ok')), 'disabled', 'the pool still works');
      await until(() => seen.length >= 1, 'checks to keep coming back');
    } finally {
      delete process.env['MS_TEST_BREAK_REGISTRY'];
    }
  });

  it('says it has given up, rather than looking like an idle probe', async () => {
    // **The signal `P-62` added, and the reason it had to be a state.** A latched pool answers
    // nothing and reports `busy: 0`; every other channel on Probe Health reads exactly like a
    // quiet night. Meanwhile every sensor under that probe holds its last state indefinitely,
    // because the core re-evaluates on an arriving result and none arrive — an installation
    // reporting that everything is Up while nothing is being checked.
    const pool = new CheckPool({
      logger: silent,
      size: 1,
      registryModule: join(import.meta.dirname, 'support', 'no-such-registry.js'),
      onResult: () => undefined,
    });
    pools.push(pool);
    await pool.start();

    assert.equal(pool.stats().disabled, false, 'not before it has given up');
    await until(
      () => pool.submit(request(110, 'test.ok')) === 'disabled',
      'the pool to disable itself',
    );

    const stats = pool.stats();
    assert.equal(stats.disabled, true, 'the pool says it is dead');
    assert.ok(stats.discarded >= 1, `discards are counted, saw ${String(stats.discarded)}`);

    // Waited for rather than read once. The latch stops new spawns, but one already in flight has
    // pushed its slot and has not failed yet, so `size` is briefly 1 — which is a transient and
    // not the thing under test. What the leak fix guarantees is that a dead slot *leaves*: before
    // it, the latching slot stayed in `#slots` for the life of the process and this never reached
    // zero. Asserting the instant instead of the settled state is how the first version of this
    // passed alone and failed in the full run.
    await until(() => pool.stats().size === 0, 'the dead slots to leave the pool');
  });

  it('separates a pool that gave up from a probe that was stopped', async () => {
    // Collapsing the two is what hid this: stopping is something an operator did and the probe
    // stops heartbeating for, while giving up leaves it connected, answering, and running
    // nothing. Only one of them needs an alarm.
    const pool = new CheckPool({ logger: silent, size: 1, onResult: () => undefined });
    pools.push(pool);
    await pool.start();
    await pool.stop();

    assert.equal(pool.submit(request(111, 'test.ok')), 'stopped');
    assert.equal(pool.stats().disabled, false, 'a stopped pool has not failed');
    assert.equal(pool.stats().discarded, 0, 'and an orderly shutdown is not a discard');
  });

  it('reports an unregistered sensor type as its own phase, not as a failed check', async () => {
    // A missing sensor type fails identically for ever. Counting it with genuine check failures
    // buries a configuration error inside a rate that looks like a flapping target, and no
    // amount of retrying will change the outcome.
    const { pool, seen } = await poolOf();
    assert.equal(pool.submit(request(1, 'test.nonexistent')), 'accepted');

    await until(() => seen.length === 1, 'the check to be refused');
    const entry = seen[0];
    assert.ok(entry);
    assert.equal(entry.meta.phase, 'unknown-type');
    assert.equal(entry.result.outcome, 'error');
    assert.match(entry.result.message, /test\.nonexistent/, 'names the type it could not find');
    assert.deepEqual(entry.result.channels, [], 'a failed check records no channel values');
  });
});

/**
 * A worker whose registry never finishes loading (`P-263`).
 *
 * Until it says ready a worker holds one of `SPAWN_CONCURRENCY`'s loading turns, and the pool
 * waited for that with no timer. These run the stalled registry, whose first N loads hang for
 * ever and post a heartbeat while they do, so a test can see when each hang began and that the
 * pool ended it.
 *
 * **Every wall-clock assertion is a lower bound or a generous wait** (`P-258`, `P-261`). A timer
 * never fires much early, so "not before the bound and its delays" holds however loaded the machine
 * is; how *late* things happen is only ever waited for, never asserted.
 */
describe('a worker that hangs while loading (P-263)', () => {
  const STALLED = join(import.meta.dirname, 'support', 'stalled-registry.js');
  /** The 1 ms a Node timer may fire early, and some. */
  const EARLY = 20;

  interface Hangs {
    /** Each hanging load by ticket: when it began and when it last beat. */
    beats: Map<number, { first: number; last: number }>;
    /** Every hang has stopped beating for this long: its thread is gone. */
    quiet: (forMs: number) => boolean;
    /** How many of the scripted entries a load has claimed so far. */
    claimed: () => number;
    close: () => void;
  }

  /**
   * Scripts what the next registry loads in this process do, in the order they begin (`hang`,
   * `throw` or `load`), and listens to the hangs' heartbeats.
   *
   * The environment is copied into a worker when it is constructed, so it has to stay set while
   * the pool under test is starting workers, and `close` must run before the next test's.
   */
  async function scriptLoads(
    script: readonly ('hang' | 'throw' | 'load' | 'slow')[],
    options: { slowMs?: number } = {},
  ): Promise<Hangs> {
    const scratch = await mkdtemp(join(tmpdir(), 'ms-hang-'));
    scratches.push(scratch);
    const name = `ms-hang-${String(process.pid)}-${scratch}`;
    process.env['MS_TEST_REGISTRY_HANG_DIR'] = scratch;
    process.env['MS_TEST_REGISTRY_SCRIPT'] = script.join(',');
    process.env['MS_TEST_REGISTRY_CHANNEL'] = name;
    process.env['MS_TEST_REGISTRY_SLOW_MS'] = String(options.slowMs ?? 0);
    const beats = new Map<number, { first: number; last: number }>();
    const channel = new BroadcastChannel(name);
    channel.onmessage = (event: unknown) => {
      const { ticket, at } = (event as { data: { ticket: number; at: number } }).data;
      const seen = beats.get(ticket);
      if (seen === undefined) beats.set(ticket, { first: at, last: at });
      else seen.last = Math.max(seen.last, at);
    };
    return {
      beats,
      quiet: (forMs) => [...beats.values()].every((one) => Date.now() - one.last >= forMs),
      claimed: () => readdirSync(scratch).length,
      close: () => {
        delete process.env['MS_TEST_REGISTRY_HANG_DIR'];
        delete process.env['MS_TEST_REGISTRY_SCRIPT'];
        delete process.env['MS_TEST_REGISTRY_CHANNEL'];
        delete process.env['MS_TEST_REGISTRY_SLOW_MS'];
        channel.close();
      },
    };
  }

  /** The next `count` loads hang; the rest load as usual. */
  async function hangLoads(count: number): Promise<Hangs> {
    return scriptLoads(Array.from({ length: count }, () => 'hang' as const));
  }

  function stalledPool(
    options: { size: number; minSize?: number; startupTimeoutMs: number; logger?: Logger },
    seen: Seen[] = [],
  ): CheckPool {
    const pool = new CheckPool({
      logger: options.logger ?? silent,
      size: options.size,
      minSize: options.minSize ?? options.size,
      startupTimeoutMs: options.startupTimeoutMs,
      registryModule: STALLED,
      onResult: (result, meta) => seen.push({ result, meta }),
    });
    pools.push(pool);
    return pool;
  }

  it('uses the check process’s start-up bound, thirty seconds, unless told otherwise', () => {
    // `P-258`: 0.45–14.8 s to import the catalogue at load 6.5–29. See `STARTUP_TIMEOUT_MS`, and
    // `#start` for why the same number fits a worker. Read from the pool, which is the bound it
    // arms, and not only from the constant.
    assert.equal(STARTUP_TIMEOUT_MS, 30_000);
    const plain = new CheckPool({ logger: silent, onResult: () => undefined });
    assert.equal(plain.startupTimeoutMs, STARTUP_TIMEOUT_MS);
    const told = new CheckPool({
      logger: silent,
      startupTimeoutMs: 1_234,
      onResult: () => undefined,
    });
    assert.equal(told.startupTimeoutMs, 1_234);
  });

  it('terminates a worker still loading at its bound, counts it, and replaces it while the others run checks', async () => {
    const BOUND = 5_000;
    const hangs = await hangLoads(1);
    const seen: Seen[] = [];
    const pool = stalledPool({ size: 2, startupTimeoutMs: BOUND }, seen);
    try {
      const t0 = Date.now();
      const started = pool.start();

      // The other worker runs checks while this one hangs, and after. Submitted once the hang has
      // begun, so both of `start`'s workers are in the pool: a check offered before `start` has
      // placed them finds none, and the pool grows a third for it.
      await until(() => hangs.beats.has(0), 'the hanging load to begin', 60_000);
      assert.equal(pool.submit(request(700, 'test.ok')), 'accepted');
      await until(() => seen.length === 1, 'a check on the worker that loaded', 60_000);
      assert.equal(seen[0]?.result.outcome, 'ok');

      await until(() => pool.stats().startupFailed >= 1, 'the hang to be counted', BOUND + 60_000);
      assert.ok(
        Date.now() - t0 >= BOUND - EARLY,
        `counted ${String(Date.now() - t0)} ms in, before its ${String(BOUND)} ms bound`,
      );
      // `start` waited for the hung worker no longer than its bound, rather than for ever.
      await within(30_000, 'start to resolve after the bound', started);

      // Terminated: its heartbeat stops. A thread the pool only forgot would beat on.
      await until(() => hangs.quiet(2_000), 'the hung worker’s thread to end', 30_000);
      assert.equal(hangs.beats.size, 1, 'one load hung, and its replacement loaded');
      assert.equal(pool.stats().workerCrashes, 0, 'a hang the pool ended is not a crash');
      assert.equal(pool.stats().disabled, false);

      // Replaced: two checks at once until one runs on a worker started after the first two.
      let sensor = 710;
      await until(
        () => {
          if (seen.some((one) => one.meta.workerId > 2)) return true;
          if (pool.stats().busy === 0 && pool.stats().queued === 0) {
            for (let n = 0; n < 2; n += 1) {
              sensor += 1;
              pool.submit(request(sensor, 'test.slow', { delayMs: 200 }));
            }
          }
          return false;
        },
        'a check on the replacement worker',
        60_000,
      );
      assert.ok(seen.every((one) => one.result.outcome === 'ok'));
      // Waited for, because a worker slow enough under load to miss the bound as well is replaced
      // after a delay; settled, it is two, and a pool that replaced a hang twice stays at three.
      await until(() => pool.size === 2, 'the pool to be back at its size', 30_000);
      assert.equal(pool.stats().size, 2);
    } finally {
      // Stopped before the environment goes, so no retry of this pool's reads the next test's.
      await pool.stop();
      hangs.close();
    }
  });

  it('frees the loading turn a hung worker held, so a pool whose every turn hangs still starts', async () => {
    // Without the bound, SPAWN_CONCURRENCY hung loads hold every turn and nothing else ever loads.
    const hangs = await hangLoads(SPAWN_CONCURRENCY);
    const seen: Seen[] = [];
    const pool = stalledPool({ size: SPAWN_CONCURRENCY + 1, startupTimeoutMs: 5_000 }, seen);
    try {
      void pool.start();
      await until(
        () => hangs.beats.size === SPAWN_CONCURRENCY,
        'every turn to be held by a hang',
        60_000,
      );
      pool.submit(request(720, 'test.ok'));
      await until(() => seen.length === 1, 'a check, once a turn came free', 90_000);
      assert.equal(seen[0]?.result.outcome, 'ok');
      assert.ok(pool.stats().startupFailed >= SPAWN_CONCURRENCY);
    } finally {
      await pool.stop();
      hangs.close();
    }
  });

  it('backs off between the starts of a registry that always hangs, and never gives up on it', async () => {
    const BOUND = 1_000;
    const hangs = await hangLoads(1_000);
    const lines: Record<string, unknown>[] = [];
    const logger = pino(
      { level: 'debug' },
      { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
    );
    const pool = stalledPool({ size: 1, startupTimeoutMs: BOUND, logger });
    try {
      const t0 = Date.now();
      await within(60_000, 'start to resolve after the bound', pool.start());
      await until(() => hangs.beats.size >= 5, 'five starts', 120_000);

      // Each start waits out the bound before it and a delay doubling from 250 ms: the fifth
      // cannot begin before 4 x 1,000 + 250 + 500 + 1,000 + 2,000 ms. Without the delay it would
      // begin about four bounds in.
      const fifth = hangs.beats.get(4)?.first ?? 0;
      const floor = 4 * BOUND + 250 + 500 + 1_000 + 2_000;
      assert.ok(fifth - t0 >= floor - EARLY, `the fifth start ${String(fifth - t0)} ms in`);

      const stats = pool.stats();
      assert.ok(stats.startupFailed >= 4, `${String(stats.startupFailed)} counted`);
      assert.equal(stats.workerCrashes, 0);
      // A hang is retried for as long as it lasts: the latch is for a registry that cannot load.
      assert.equal(stats.disabled, false, 'a pool whose workers hang has not given up');
      assert.equal(pool.submit(request(730, 'test.ok')), 'accepted');

      // Only one at a time: every start but the newest has ended.
      await until(
        () =>
          [...hangs.beats.entries()].every(
            ([ticket, one]) =>
              ticket === Math.max(...hangs.beats.keys()) || Date.now() - one.last >= 2_000,
          ),
        'the earlier hangs to have ended',
        30_000,
      );

      // One line at warn for the streak, naming the bound, and the rest at debug (`P-227`).
      const said = lines.filter((line) => String(line['msg']).includes('start-up bound'));
      assert.ok(said.length >= 4, `${String(said.length)} lines`);
      assert.deepEqual(
        said.map((line) => line['level']),
        [40, ...said.slice(1).map(() => 20)],
      );
      const [first, second] = said;
      assert.ok(first !== undefined && second !== undefined);
      assert.equal(first['startupTimeoutMs'], BOUND);
      assert.equal(first['retryInMs'], 250);
      assert.equal(second['retryInMs'], 500);
    } finally {
      await pool.stop();
      hangs.close();
    }
  });

  it('gives a load thirty seconds by default, and ends a hanging one when it stops, uncounted', async () => {
    const hangs = await hangLoads(1);
    const pool = new CheckPool({
      logger: silent,
      size: 1,
      registryModule: STALLED,
      onResult: () => undefined,
    });
    pools.push(pool);
    try {
      const t0 = Date.now();
      const started = pool.start();
      await until(() => hangs.beats.has(0), 'the hanging load to begin', 60_000);
      // The bound runs from the worker's construction, which is after `t0`, so while less than the
      // bound has passed since `t0` a pool applying the default cannot have given up. Asserted only
      // inside that, with a margin, since a loaded machine can stretch this wait past it.
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      const failed = pool.stats().startupFailed;
      if (Date.now() - t0 < STARTUP_TIMEOUT_MS - 2_000) {
        assert.equal(failed, 0, 'not given up on inside the default bound');
      }
      await within(30_000, 'stop', pool.stop());
      await within(30_000, 'start to resolve once its worker is gone', started);
      await until(() => hangs.quiet(2_000), 'the hung worker’s thread to end', 30_000);
      assert.equal(pool.stats().startupFailed, 0, 'a stop is not a failed start');
    } finally {
      await pool.stop();
      hangs.close();
    }
  });

  it('latches on deaths alone: hangs neither count towards it nor reset it', async () => {
    // `P-80`'s latch is for a registry that cannot load: three deaths in a row with nothing ready.
    // A hang is no evidence either way, so it must not add to the three — hang, hang, death latched
    // the pool until a restart, and with eight hangs in flight one death did — and must not wipe
    // out the deaths before it. Only a worker that says ready ends the streak. One worker, so
    // nothing is ever ready while the script runs.
    //
    // Each row ends on a death, and the verdict is read once every entry has been claimed and every
    // scripted death seen. A load slow enough under load to miss the bound before it claims its
    // entry is one more hang, which changes no verdict, and the entry goes to the next load.
    const rows: { script: ('hang' | 'throw')[]; disabled: boolean }[] = [
      { script: ['hang', 'hang', 'throw'], disabled: false },
      { script: ['hang', 'hang', 'hang', 'throw', 'throw'], disabled: false },
      { script: ['throw', 'throw', 'throw'], disabled: true },
      { script: ['throw', 'hang', 'throw', 'throw'], disabled: true },
    ];
    for (const row of rows) {
      const what = row.script.join(', ');
      const hangs = await scriptLoads(row.script);
      const seen: Seen[] = [];
      const pool = stalledPool({ size: 1, startupTimeoutMs: 5_000 }, seen);
      const throws = row.script.filter((one) => one === 'throw').length;
      try {
        void pool.start();
        await until(
          () => hangs.claimed() === row.script.length && pool.stats().workerCrashes >= throws,
          `${what}: every scripted start to have happened`,
          180_000,
        );
        // The latch is decided at the failure itself, synchronously, so this reads its verdict.
        assert.equal(pool.stats().disabled, row.disabled, what);
        if (!row.disabled) {
          // And the next start, past the script, loads and runs checks.
          assert.equal(pool.submit(request(740, 'test.ok')), 'accepted', what);
          await until(() => seen.length === 1, `${what}: a check after the streak`, 60_000);
          assert.equal(seen[0]?.result.outcome, 'ok', what);
        }
      } finally {
        await pool.stop();
        hangs.close();
      }
    }
  });

  it('logs the latch once, however many loads were still in flight when it fired', async () => {
    // Three deaths latch the pool while two loads hang. Each of those reaches its bound later and
    // is a failed start, and each used to latch and log again: one error per straggler for the one
    // event (`P-227`). Counted, terminated, and nothing more.
    const hangs = await scriptLoads(['throw', 'throw', 'throw', 'hang', 'hang']);
    const lines: Record<string, unknown>[] = [];
    const logger = pino(
      { level: 'debug' },
      { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
    );
    const pool = stalledPool({ size: 5, startupTimeoutMs: 5_000, logger });
    try {
      void pool.start();
      // Every one of the five has failed one way or another, and nothing retries once latched.
      await until(
        () => pool.stats().disabled && pool.stats().startupFailed >= 5,
        'the latch, and the hangs after it',
        120_000,
      );
      await until(() => hangs.quiet(2_000), 'the hung workers’ threads to end', 30_000);
      const latched = lines.filter((line) =>
        String(line['msg']).includes('disabled until the probe restarts'),
      );
      assert.equal(latched.length, 1, `${String(latched.length)} latch lines`);
      assert.equal(latched[0]?.['level'], 50);
    } finally {
      await pool.stop();
      hangs.close();
    }
  });

  it('counts a replacement waiting out its delay as on its way, so nothing grows for the gap', async () => {
    // A failed start's replacement waits 250 ms doubling to 30 s before it spawns. Counted nowhere
    // in that time, a check queuing behind the busy workers made `#grow` start one for the gap and
    // the retry then started another: a pool over its size. Four hangs in a row on one slot leave
    // a 2 s delay before the fifth start, and the checks are queued inside it.
    const hangs = await scriptLoads(['load', 'hang', 'hang', 'hang', 'hang']);
    const seen: Seen[] = [];
    const pool = stalledPool({ size: 2, startupTimeoutMs: 2_500 }, seen);
    try {
      void pool.start();
      await until(() => pool.stats().startupFailed >= 4, 'four hangs', 120_000);
      for (const id of [750, 751])
        pool.submit({ ...request(id, 'test.slow', { delayMs: 3_000 }), timeoutMs: 30_000 });
      let most = 0;
      await until(
        () => {
          most = Math.max(most, pool.stats().size);
          return seen.length === 2;
        },
        'both checks, the second on the replacement',
        60_000,
      );
      assert.equal(pool.stats().grown, 0, 'nothing was grown for the gap a replacement fills');
      assert.ok(most <= 2, `the pool held ${String(most)} workers at its size of 2`);
      assert.ok(seen.every((one) => one.result.outcome === 'ok'));
    } finally {
      await pool.stop();
      hangs.close();
    }
  });

  it('counts a crashed worker’s replacement as on its way while it waits for a loading turn', async () => {
    // The same gap after a crash: a ready worker dies, and its replacement waits for a turn while
    // eight hangs hold them all. Two load, then eight hang, as the pool's first ten, so every turn
    // is held before the crash.
    //
    // **Room to grow, and nine checks, since `P-271`.** The hangs are `start`'s own spawns, and
    // those are now counted as on their way until they end, so each of the eight is in `#growing`
    // and in `#slots` at once. At a ceiling of ten that alone stops `#grow`, and the test passed
    // with the crash's count removed. At twenty, with the crash counted, the pool holds 9 and has
    // 9 on their way: nine queued checks are met. Without it, the ninth grows one.
    const hangs = await scriptLoads([
      'load',
      'load',
      ...Array.from({ length: 8 }, () => 'hang' as const),
    ]);
    const seen: Seen[] = [];
    const pool = stalledPool({ size: 20, minSize: 10, startupTimeoutMs: 120_000 }, seen);
    try {
      void pool.start();
      await until(
        () => hangs.beats.size === SPAWN_CONCURRENCY,
        'every turn held by a hang',
        60_000,
      );
      pool.submit({ ...request(760, 'test.slow', { delayMs: 60_000 }), timeoutMs: 120_000 });
      pool.submit(request(761, 'test.crash'));
      await until(() => seen.some((one) => one.result.sensorId === 761), 'the crash', 60_000);
      assert.equal(seen.find((one) => one.result.sensorId === 761)?.meta.phase, 'worker-crash');
      // One worker busy, one gone and waiting for a turn: checks queue, and must not grow one.
      for (let id = 762; id < 771; id += 1) pool.submit(request(id, 'test.ok'));
      assert.equal(pool.stats().queued, 9);
      assert.equal(pool.stats().grown, 0, 'nothing was grown for the gap the replacement fills');
    } finally {
      await pool.stop();
      hangs.close();
    }
  });

  it('counts start’s own workers as on their way while they wait for a loading turn (P-271)', async () => {
    // A fixed pool of ten starts ten, eight load at a time, and the other two wait for a turn
    // out of `#slots`. Uncounted, a check queued then had `#grow` see eight workers and buy a ninth
    // for a slot one of the two was about to fill: ten became eleven. Eight slow loads hold every
    // turn for long enough to queue a check inside the gap.
    const hangs = await scriptLoads(
      [...Array.from({ length: SPAWN_CONCURRENCY }, () => 'slow' as const), 'load', 'load', 'load'],
      { slowMs: 3_000 },
    );
    const seen: Seen[] = [];
    const pool = stalledPool({ size: 10, startupTimeoutMs: 120_000 }, seen);
    let most = 0;
    /** The size now, kept in `most` too: every read of the size is a sample. */
    const sample = (): number => {
      const size = pool.stats().size;
      most = Math.max(most, size);
      return size;
    };
    const sampler = setInterval(sample, 1);
    try {
      let started = false;
      const starting = pool.start().then(() => {
        started = true;
      });
      await until(() => sample() === SPAWN_CONCURRENCY, 'a full turn loading', 60_000);
      // Two of the ten are still waiting for a turn, so none is ready and the check queues.
      pool.submit(request(780, 'test.ok'));
      assert.equal(pool.stats().queued, 1, 'the check is queued inside the gap');
      assert.equal(pool.stats().grown, 0, 'nothing was grown for a slot start is filling');
      await within(60_000, 'the pool to start', starting);
      await until(
        () => sample() >= 0 && started && seen.some((one) => one.result.sensorId === 780),
        'the check to run',
        60_000,
      );
      // A while longer, sampled throughout: an eleventh worker would have had its turn by now.
      const settled = Date.now() + 1_000;
      await until(() => sample() >= 0 && Date.now() >= settled, 'a settled pool', 10_000);
      assert.ok(most <= 10, `the pool held ${String(most)} workers at its size of 10`);
      assert.equal(hangs.claimed(), 10, 'ten loads began, not eleven');
      assert.equal(pool.stats().grown, 0);
    } finally {
      clearInterval(sampler);
      await pool.stop();
      hangs.close();
    }
  });

  it('counts a recycled worker’s replacement as on its way through its terminate (P-271)', async () => {
    // A check that ignores its abort while its thread is in native code: the worker leaves the
    // pool at the end of the abort grace, and its terminate lasts until the native call returns.
    // Uncounted in that time, a check queued then had `#grow` buy a worker for the slot the
    // replacement was about to fill, and the replacement made a pool of two hold three.
    const scratch = await mkdtemp(join(tmpdir(), 'ms-recycle-'));
    scratches.push(scratch);
    const unblocked = join(scratch, 'unblocked');
    const { pool, seen } = await poolOf({ size: 2, abortGraceMs: 100 });
    let most = 0;
    /** The size now, kept in `most` too: every read of the size is a sample. */
    const sample = (): number => {
      const size = pool.stats().size;
      most = Math.max(most, size);
      return size;
    };
    const sampler = setInterval(sample, 1);
    try {
      pool.submit({ ...request(790, 'test.slow', { delayMs: 60_000 }), timeoutMs: 120_000 });
      pool.submit({
        ...request(791, 'test.block', { delayMs: 3_000, marker: unblocked }),
        timeoutMs: 100,
      });
      await until(() => sample() === 1, 'the blocked worker taken out', 20_000);
      // Inside the terminate: one worker, busy, and the replacement not yet in the pool.
      pool.submit(request(792, 'test.ok'));
      assert.equal(pool.stats().queued, 1, 'the check is queued inside the gap');
      assert.equal(pool.stats().grown, 0, 'nothing was grown for the slot the replacement fills');
      await until(
        () =>
          sample() >= 0 && existsSync(unblocked) && seen.some((one) => one.result.sensorId === 792),
        'the thread unblocked and the check run',
        60_000,
      );
      // A while longer, sampled throughout: the replacement follows the terminate at once.
      const settled = Date.now() + 1_000;
      await until(() => sample() >= 0 && Date.now() >= settled, 'a settled pool', 10_000);
      assert.ok(most <= 2, `the pool held ${String(most)} workers at its size of 2`);
      assert.equal(pool.stats().grown, 0);
      assert.equal(seen.find((one) => one.result.sensorId === 791)?.meta.phase, 'timeout');
    } finally {
      clearInterval(sampler);
      await pool.stop();
    }
  });

  it('counts a worker that dies while loading as a failed start, and a crash as before', async () => {
    const pool = new CheckPool({
      logger: silent,
      size: 1,
      registryModule: join(import.meta.dirname, 'support', 'no-such-registry.js'),
      onResult: () => undefined,
    });
    pools.push(pool);
    await pool.start();
    await until(() => pool.stats().disabled, 'the pool to give up');
    const stats = pool.stats();
    // Three, where the latch fires (`MAX_CONSECUTIVE_START_FAILURES`), in both.
    assert.equal(stats.startupFailed, 3);
    assert.equal(stats.workerCrashes, 3);
  });
});

/**
 * Sizing the pool to the work (`P-18`).
 *
 * **The asymmetry is the whole design and is what these pin.** `P-15` measured what an
 * undersized pool costs — 21% of checks refused and the rest delayed by a p95 of 15.8 seconds —
 * and what an oversized one costs is memory, about six megabytes a worker. So growth is
 * immediate and shrinking waits out a whole quiet interval: the first mistake loses
 * measurements, the second loses nothing but bytes.
 */
describe('growing and shrinking with the load', () => {
  it('starts at the minimum rather than at the ceiling', async () => {
    const { pool } = await poolOf({ size: 8, minSize: 2 });
    assert.equal(pool.size, 2);
    assert.equal(pool.maxSize, 8, 'and knows what it is allowed to reach');
  });

  it('grows the moment a check has nowhere to go', async () => {
    // The trigger is not a long queue: it is a queued check with every worker busy, which is the
    // only state in which another worker would have started something that is instead waiting.
    const { pool, seen } = await poolOf({ size: 8, minSize: 1 });
    for (let i = 0; i < 6; i += 1) {
      pool.submit(request(100 + i, 'test.slow', { delayMs: 300 }));
    }

    await until(() => pool.size > 1, 'the pool to grow');
    await until(() => seen.length === 6, 'every check to finish', 10_000);
    assert.ok(pool.size > 1, `pool stayed at ${String(pool.size)}`);
    assert.ok(pool.size <= 8, 'and never past its ceiling');
    assert.ok(pool.stats().grown > 0, 'and says that it grew');
  });

  it('never grows past the ceiling, however much is queued', async () => {
    const { pool, seen } = await poolOf({ size: 3, minSize: 1, queueMaxLength: 100 });
    for (let i = 0; i < 40; i += 1) {
      pool.submit(request(200 + i, 'test.slow', { delayMs: 100 }));
    }
    await until(() => seen.length === 40, 'every check to finish', 20_000);
    assert.equal(pool.size, 3);
  });

  it('caps every worker it starts at WORKER_YOUNG_GENERATION_MB of young generation', async () => {
    // **`P-207`.** Uncapped, V8 grew each worker's young generation to 123 MiB under heavy checks
    // and kept it. The cap is one option on the `Worker`, which is exactly the kind of line a
    // refactor of `#start` drops without a test failing — so the worker reports what it got.
    const { pool, seen } = await poolOf({ size: 2 });
    for (const id of [500, 501]) pool.submit(request(id, 'test.limits'));
    await until(() => seen.length === 2, 'both workers to answer');
    assert.deepEqual(
      seen.map((one) => one.result.channels[0]?.value),
      [WORKER_YOUNG_GENERATION_MB, WORKER_YOUNG_GENERATION_MB],
    );
  });

  it('loads at most SPAWN_CONCURRENCY workers at once, however large the shortfall', async () => {
    // **`P-206`.** A growth burst started the whole shortfall at once, and a worker loading its
    // registry beside sixty-three others commits about half as much heap again as one loading
    // beside seven — 4.3 GiB against 2.9 at a ceiling of 64, which on an 8 GB box was an OOM kill.
    // The registry here takes 400 ms to import, so for that long nothing the burst started can
    // have finished, and every worker the pool holds beyond its first is one still loading.
    const pool = new CheckPool({
      logger: silent,
      size: 24,
      minSize: 1,
      queueMaxLength: 100,
      registryModule: join(import.meta.dirname, 'support', 'slow-registry.js'),
      onResult: () => undefined,
    });
    pools.push(pool);
    await pool.start();

    for (let i = 0; i < 40; i += 1) pool.submit(request(400 + i, 'test.slow', { delayMs: 5_000 }));
    let most = 0;
    const window = Date.now() + 300;
    while (Date.now() < window) {
      most = Math.max(most, pool.size);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(most, 1 + SPAWN_CONCURRENCY, 'the first worker, and a full turn loading');

    await until(() => pool.size === 24, 'the rest to load in turn', 10_000);
    assert.equal(pool.stats().grown, 23, 'a spawn waiting its turn is not ordered a second time');
  });

  it('does not grow for work an idle worker is about to pick up', async () => {
    // A queue behind an idle worker is not a shortage. Growing here would buy a worker for a
    // check that was never going to wait, which over a day is a pool that only ever climbs —
    // and `#pump` runs first, so three checks against four workers leaves nothing queued.
    const { pool, seen } = await poolOf({ size: 8, minSize: 4 });
    for (const id of [300, 301, 302]) pool.submit(request(id, 'test.slow', { delayMs: 120 }));
    await until(() => seen.length === 3, 'the checks to finish', 8_000);
    assert.equal(pool.size, 4, 'the pool should not have grown');
    assert.equal(pool.stats().grown, 0);
  });

  /**
   * **This replaced a test that asserted the opposite, and the replacement is the point of
   * `P-26`.** The old one said a pool must not give a worker back "while work is still arriving",
   * because a shrink between a check queueing and a worker picking it up would take the worker
   * that was about to run it. The hazard is real; the measure was not. Timing "has anything been
   * submitted" makes a probe watching five thousand sensors — eighty-three checks a second —
   * permanently ineligible to shrink, so the pool that had grown large was the one that could
   * never give anything back. Measured: 48 workers held for twenty-four hours at 0–3% use.
   *
   * The hazard is answered by looking at the worker instead. A slot that is ready, holding no
   * job, and untouched for the whole interval is one that checks have been flowing *past*, and
   * `#pump` dispatches to a free worker before a check can queue behind it.
   */
  it('gives back the workers a lighter load stopped needing', async () => {
    // Six at once grows the pool; then one every 40 ms with 60 ms of work is 1.5 workers' worth,
    // so most of what the burst bought is spare from then on.
    const { pool, seen } = await poolOf({ size: 8, minSize: 1, idleShrinkMs: 200 });
    for (let i = 0; i < 6; i += 1) pool.submit(request(700 + i, 'test.slow', { delayMs: 60 }));
    await until(() => pool.size > 1, 'the pool to grow');

    // **The peak is the highest size actually seen, not a single early sample.** Growth is
    // asynchronous — workers are still spawning when `pool.size > 1` first becomes true — so
    // reading it once races the thing being measured.
    let peak = pool.size;
    const rounds = 30;
    for (let round = 0; round < rounds; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      pool.submit(request(800 + round, 'test.slow', { delayMs: 60 }));
      peak = Math.max(peak, pool.size);
    }

    // Asserted while the load is *still arriving*, which is the whole correction: the old policy
    // treated any submission as proof every worker was needed.
    assert.ok(
      pool.stats().shrunk > 0,
      `the pool gave nothing back in ${String(rounds * 40)} ms of a load needing ~2 workers`,
    );
    assert.ok(pool.size < peak, `the pool held ${String(pool.size)} of its peak ${String(peak)}`);

    // And it took only genuinely spare workers: every check still ran to completion.
    await until(() => seen.length === 6 + rounds, 'every check to finish', 15_000);
  });

  it('never takes a worker that is in the middle of a check', async () => {
    // The hazard the old test was written against, asserted directly rather than by proxy. The
    // interval is far shorter than the work, so a shrink policy that could not tell busy from
    // spare would have every opportunity to take one.
    const { pool, seen } = await poolOf({ size: 6, minSize: 1, idleShrinkMs: 30 });
    for (let i = 0; i < 5; i += 1) pool.submit(request(900 + i, 'test.slow', { delayMs: 400 }));
    await until(() => pool.size > 1, 'the pool to grow');

    await until(() => seen.length === 5, 'every check to finish', 15_000);
    assert.equal(
      seen.filter((one) => one.result.outcome === 'ok').length,
      5,
      'a check was lost, which means a working worker was retired underneath it',
    );
  });

  it('never shrinks below the minimum, however long it is quiet', async () => {
    const { pool } = await poolOf({ size: 8, minSize: 3, idleShrinkMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(pool.size, 3);
    assert.equal(pool.stats().shrunk, 0, 'and it should not even have tried');
  });

  it('holds its size when the minimum is the maximum, which is the old behaviour', async () => {
    // What a probe with a known steady workload should configure: the sizing loop buys nothing
    // there, and a re-spawn during a spike costs something.
    const { pool, seen } = await poolOf({ size: 2, minSize: 2, idleShrinkMs: 50 });
    for (let i = 0; i < 6; i += 1) pool.submit(request(500 + i, 'test.slow', { delayMs: 60 }));
    await until(() => seen.length === 6, 'every check to finish', 10_000);
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(pool.size, 2);
    assert.equal(pool.stats().grown, 0);
    assert.equal(pool.stats().shrunk, 0);
  });

  it('refuses a minimum above its own ceiling rather than starting more than it allows', async () => {
    // A configuration file saying two contradictory things. Starting six workers in a pool
    // bounded at two would make every later sizing decision arithmetic on a number already wrong
    // — so what is asserted is the workers it actually starts, not the number it stored.
    const pool = new CheckPool({
      logger: silent,
      size: 2,
      minSize: 6,
      registryModule: FIXTURES,
      onResult: () => undefined,
    });
    pools.push(pool);
    await pool.start();
    assert.equal(pool.maxSize, 2);
    assert.equal(pool.size, 2, 'it started more workers than its own ceiling allows');
  });
});

/**
 * The number `P-15` changed, and why.
 *
 * A value test alone would pass just as happily on the old default; what these pin is the
 * *reasoning* — that the pool is sized by checks in flight rather than by cores, which is the
 * thing the benchmark disproved and the thing a later refactor could quietly undo.
 */
describe('sizing the ceiling from the work (P-34)', () => {
  it('learns what a type costs, separately per type', async () => {
    const { pool, seen } = await poolOf({ size: 4, minSize: 4 });

    assert.equal(pool.typicalDurationMs('test.slow'), undefined, 'nothing measured yet');

    for (let i = 0; i < 5; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 300 }));
    for (let i = 10; i < 15; i += 1) pool.submit(request(i, 'test.ok'));
    await until(() => seen.length === 10, 'both types to finish');

    const slow = pool.typicalDurationMs('test.slow');
    const fast = pool.typicalDurationMs('test.ok');
    assert.ok(slow !== undefined && fast !== undefined, 'both types measured');

    // The numbers that matter are the *separation*, not the absolutes — a worker's own overhead
    // is in both. A pooled median would describe neither type, which is why this is per type.
    // **Only a lower bound on a sleep, and a comparison** (`P-234`): a timer never fires early,
    // so the first holds on any machine, and load slows both types rather than swapping them. An
    // absolute ceiling on the immediate one (`< 100`) was a statement about the machine.
    assert.ok(slow >= 290, `a 300 ms check measured ${String(slow)} ms`);
    assert.ok(
      fast < slow,
      `an immediate check measured ${String(fast)} ms, the slow one ${String(slow)}`,
    );
  });

  it('takes the median, so one timeout does not resize the pool', () => {
    // The reason this is a median and not a mean. A single check that ran to its timeout is in
    // the window too, and a mean would let it claim the workload is thirty times heavier than
    // it is — sizing the pool for a workload that does not exist.
    //
    // **Durations and a clock handed in, not measured** (`P-234`). Through a running pool this
    // compared real check durations, and on a loaded machine a 20 ms check measured 20 or 85 ms
    // by turns: the median of nine landed on the boundary and one outlier moved it from 21 to 85,
    // which is the input changing, not the median failing.
    const now = 1_000_000_000_000n;
    const at = (msAgo: number): bigint => now - BigInt(msAgo) * 1_000_000n;
    const ordinary = Array.from({ length: 9 }, (_, i) => ({ at: at(900 - i * 100), ms: 20 }));
    assert.equal(typicalOf(ordinary, now, 30_000), 20);

    const withTimeout = [...ordinary, { at: at(0), ms: 30_000 }];
    assert.equal(typicalOf(withTimeout, now, 30_000), 20, 'one timeout does not move it');
    const mean = withTimeout.reduce((sum, one) => sum + one.ms, 0) / withTimeout.length;
    assert.ok(mean > 3_000, 'where a mean would have sized for a check a hundred times heavier');
  });

  it('reads a workload of two speeds as the one most checks have', () => {
    // The shape the loaded machine produced: some checks at 20 ms and some at 85. The estimate is
    // one of the real durations, never an average of the two, and follows whichever is the most.
    const now = 1_000_000_000_000n;
    const samples = (fast: number, slow: number) => [
      ...Array.from({ length: fast }, (_, i) => ({ at: now - BigInt(i) * 1_000_000n, ms: 20 })),
      ...Array.from({ length: slow }, (_, i) => ({ at: now - BigInt(i) * 1_000_000n, ms: 85 })),
    ];
    assert.equal(typicalOf(samples(6, 3), now, 30_000), 20);
    assert.equal(typicalOf(samples(3, 6), now, 30_000), 85);
  });

  it('drops samples older than the window, but keeps the last eight', () => {
    const now = 1_000_000_000_000n;
    const ago = (ms: number): bigint => now - BigInt(ms) * 1_000_000n;
    const stale = Array.from({ length: 20 }, () => ({ at: ago(60_000), ms: 5 }));
    const fresh = Array.from({ length: 12 }, () => ({ at: ago(1_000), ms: 120 }));
    assert.equal(typicalOf([...stale, ...fresh], now, 30_000), 120, 'the stale ones age out');
    assert.equal(typicalOf(stale.slice(0, 3), now, 30_000), 5, 'a quiet type still answers');
    assert.equal(typicalOf([], now, 30_000), undefined, 'and a type never run does not');
  });

  it('raises the ceiling without allocating, and lets the pump use it', async () => {
    // Raising a ceiling must not spawn anything by itself — a probe that never needs the
    // headroom never pays for it. What it does is stop `#grow` being the constraint.
    const { pool, seen } = await poolOf({ size: 2, minSize: 1, idleShrinkMs: 0 });
    assert.equal(pool.maxSize, 2);

    pool.setMaxSize(6);
    assert.equal(pool.maxSize, 6, 'the ceiling moved');
    assert.ok(pool.size <= 2, `nothing was spawned by the raise alone, held ${String(pool.size)}`);

    for (let i = 0; i < 6; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 80 }));
    await until(() => pool.size > 2, 'the pool to use the new room');
    await until(() => seen.length === 6, 'the checks');
    assert.ok(pool.size <= 6, 'and never past the new ceiling');
  });

  it('comes down to a lowered ceiling now, not one worker a minute', async () => {
    // **An interaction between two changes, neither wrong alone.** `P-26` set the decay at one
    // worker per idle window, which is right while the ceiling never moves. `P-34` made it move,
    // and a pool above its ceiling is holding memory it has been told it may not have — 256 down
    // to 64 is 192 workers, over three hours at one a minute, about 6.6 GB in a real probe.
    //
    // A long idle window is what makes this test meaningful: at 60 s, the ordinary decay cannot
    // account for any of the shedding below, so what it measures is the ceiling pass alone.
    const { pool, seen } = await poolOf({ size: 8, minSize: 1, idleShrinkMs: 60_000 });

    // Slow enough that the queue outlives the spawning. With quick checks the burst drains
    // before `#grow` catches up and the pool never reaches its ceiling, so there is nothing
    // above it to shed and the test would pass without exercising anything.
    for (let i = 0; i < 8; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 400 }));
    await until(() => pool.size === 8, 'a full pool');
    await until(() => seen.length === 8, 'every worker idle again');

    pool.setMaxSize(2);
    // No waiting: lowering the ceiling acts immediately, so this is the state right after.
    await until(() => pool.size <= 2, 'the pool to obey its new ceiling');
    assert.ok(pool.size <= 2, `held ${String(pool.size)} against a ceiling of 2`);
  });

  it('reaches its ceiling even when the drop lands mid-check (P-45)', async () => {
    // The case above lowers the ceiling on an idle pool, which always worked. `P-44` measured the
    // one that did not: a wheel firing every second means a ceiling change usually lands while
    // slots hold jobs, the pass sheds whatever happens to be spare and stops, and before this the
    // next chance was the 60-second idle window. Measured there: 31 workers against a ceiling of
    // 9 for two full minutes, twice observed completely idle while it sat.
    const { pool, seen } = await poolOf({ size: 8, minSize: 1, idleShrinkMs: 60_000 });

    for (let i = 0; i < 8; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 400 }));
    await until(() => pool.size === 8, 'a full pool');
    await until(() => seen.length === 8, 'the first round to finish');

    // A second round, so the drop below lands on workers that are holding jobs.
    for (let i = 0; i < 8; i += 1) pool.submit(request(100 + i, 'test.slow', { delayMs: 400 }));
    await until(() => pool.stats().busy >= 6, 'workers holding jobs');

    pool.setMaxSize(2);
    assert.ok(
      pool.size > 2,
      `the opportunistic pass alone cannot finish the job; held ${String(pool.size)}`,
    );

    // At a 60-second idle window the ordinary decay cannot account for any of this, so whatever
    // converges the pool within five seconds is the retry and nothing else.
    await until(() => pool.size <= 2, 'the pool to reach its ceiling anyway');
  });

  it('still refuses to go under the configured floor, however low the ceiling goes', async () => {
    // The floor is somebody's deliberate setting and the ceiling pass must not step through it.
    // `setMaxSize` clamps, but the shedding loop is a second place that could get it wrong.
    const { pool, seen } = await poolOf({ size: 6, minSize: 4, idleShrinkMs: 60_000 });
    for (let i = 0; i < 6; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 40 }));
    await until(() => seen.length === 6, 'the checks');

    pool.setMaxSize(1);
    assert.equal(pool.maxSize, 4, 'clamped to the floor');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(pool.size >= 4, `held ${String(pool.size)}, which is under the floor of 4`);
  });

  it('never takes a worker out of a check when the ceiling drops', async () => {
    // Lowering the ceiling is a policy change, not a kill signal. The slots above the new line
    // are left to the shrink policy, which since `P-26` only retires a worker that is ready,
    // jobless and idle for the whole window.
    const { pool, seen } = await poolOf({ size: 4, minSize: 1, idleShrinkMs: 60_000 });
    for (let i = 0; i < 4; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 150 }));
    await until(() => pool.size === 4, 'a full pool');

    pool.setMaxSize(1);
    assert.equal(pool.maxSize, 1);

    await until(() => seen.length === 4, 'every check in flight to finish');
    assert.equal(
      seen.filter((entry) => entry.result.outcome === 'ok').length,
      4,
      'all four completed rather than being cut off',
    );
  });

  it('will not set a ceiling under the floor the operator configured', () => {
    // Two settings that contradict each other, and the floor is the one somebody chose
    // deliberately. Starting more workers than the ceiling allows would make every later
    // decision arithmetic on a number already known to be wrong.
    const pool = new CheckPool({
      logger: silent,
      size: 8,
      minSize: 4,
      registryModule: FIXTURES,
      onResult: () => undefined,
    });
    pools.push(pool);

    pool.setMaxSize(1);
    assert.equal(pool.maxSize, 4, 'clamped up to the configured minimum');
  });
});

describe('session-pool counters (P-36)', () => {
  const SESSION_FIXTURES = join(import.meta.dirname, 'support', 'session-fixtures.js');

  async function sessionPool(size: number, minSize = size, idleShrinkMs = 0) {
    const seen: Seen[] = [];
    const pool = new CheckPool({
      logger: silent,
      size,
      minSize,
      idleShrinkMs,
      registryModule: SESSION_FIXTURES,
      onResult: (result, meta) => seen.push({ result, meta }),
    });
    pools.push(pool);
    await pool.start();
    return { pool, seen };
  }

  it('reports nothing at all when the registry keeps no pools', async () => {
    // The case that must not become zeros. A build with no session pools has nothing to say
    // about them, and a channel reading 0 open sessions is a claim, not an absence.
    const { pool, seen } = await poolOf({ size: 2, minSize: 2 });
    pool.submit(request(1, 'test.ok'));
    await until(() => seen.length === 1, 'a check');

    assert.equal(pool.sessionCounters(), undefined);
    assert.equal(pool.stats().sessions, undefined, 'and it is absent from the stats too');
  });

  it('sums what every worker reports, because each thread holds its own pools', async () => {
    const { pool, seen } = await sessionPool(3);
    for (let i = 0; i < 3; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 60 }));
    await until(() => seen.length === 3, 'one check on each worker');

    const counters = pool.sessionCounters();
    assert.ok(counters !== undefined, 'the registry reported');
    // Every worker says `open: 2`, and three workers ran a check, so a sum is 6 and any single
    // worker's answer is 2. This is the assertion that would fail if the pool published one
    // worker's numbers as though they were the probe's.
    assert.equal(counters.open, 6, `summed across workers, got ${String(counters.open)}`);
    assert.ok(counters.opened > 0, 'and the cumulative counters came through');
  });

  it('never lets a cumulative counter fall when a worker goes away', async () => {
    // **The reason the retired baseline exists.** The published figure is a sum over live
    // workers, so shrinking the pool would otherwise lower a counter — and a counter that falls
    // is one an operator cannot put a trigger on.
    // A pool that *can* shrink: a floor of 1 and a short idle window, since `idleShrinkMs: 0`
    // means "never give a worker back" and would make this test assert nothing.
    const { pool, seen } = await sessionPool(3, 1, 50);

    // **Every worker must have reported before one is retired, or this proves nothing.** The
    // pool starts at its floor and grows, so a burst can finish on two workers while the third
    // is still spawning — retiring a worker that never ran a check loses no counters, and the
    // test would pass with the banking removed. An earlier version of it did exactly that.
    let submitted = 0;
    await until(() => {
      if (seen.length === submitted && submitted < 24) {
        for (let i = 0; i < 3; i += 1)
          pool.submit(request(submitted + i, 'test.slow', { delayMs: 40 }));
        submitted += 3;
      }
      return pool.sessionCounters()?.open === 6;
    }, 'all three workers to report');

    const before = pool.sessionCounters();
    assert.ok(before !== undefined);
    assert.equal(before.open, 6, 'three workers, two sessions each');

    // Take the ceiling down and let the shrink policy retire the spare workers.
    pool.setMaxSize(1);
    await until(() => pool.size < 3, 'the pool to give workers back');

    const after = pool.sessionCounters();
    assert.ok(after !== undefined, 'still reporting after the shrink');
    assert.ok(after.open < before.open, 'the gauge fell, so a reporting worker really did go');
    assert.ok(
      after.overflowed >= before.overflowed,
      `overflowed fell from ${String(before.overflowed)} to ${String(after.overflowed)}`,
    );
    assert.ok(
      after.opened >= before.opened,
      `opened fell from ${String(before.opened)} to ${String(after.opened)}`,
    );
    assert.ok(
      after.evicted >= before.evicted,
      `evicted fell from ${String(before.evicted)} to ${String(after.evicted)}`,
    );
  });
});

/**
 * The estimate the sizing loop reads, and why its window is counted in seconds (`P-46`).
 *
 * It used to be the last 1,024 samples. A median over N samples only moves once more than half of
 * them are new, so the time to notice a change was `512 ÷ completions per second` — and the
 * completion rate is set by the pool size. `P-44` measured it: about 12 s to notice at 66 workers,
 * 25 s at 31, 85 s at 9. A pool that was too small measured too slowly and stayed too small.
 *
 * These drive the estimate directly rather than through a running pool, because the property under
 * test is *how many old samples it takes to bury a change* — which a timing test would measure
 * badly and slowly.
 */
describe('the duration the sizing loop reads (P-46)', () => {
  /** Feeds durations straight into the pool's per-type window. */
  async function measured(old: number, oldCount: number, fresh: number, freshCount: number) {
    // A 150 ms window rather than the shipped 30 s, so the stale readings age out inside a test
    // instead of half a minute later. What is under test is the shape, not the constant.
    const { pool, seen } = await poolOf({
      size: 4,
      minSize: 4,
      idleShrinkMs: 0,
      durationWindowMs: 150,
    });
    for (let i = 0; i < oldCount; i += 1) pool.submit(request(i, 'test.slow', { delayMs: old }));
    await until(() => seen.length === oldCount, `${String(oldCount)} slow checks`, 20_000);
    // Long enough that every one of the old readings is outside the window.
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (let i = 0; i < freshCount; i += 1) {
      pool.submit(request(1_000 + i, 'test.slow', { delayMs: fresh }));
    }
    await until(() => seen.length === oldCount + freshCount, 'the fresh ones', 20_000);
    return pool;
  }

  it('is not outvoted by a long history of a duration that no longer applies', async () => {
    // Forty old samples against twelve new ones. On a count-counted window the old ones win and
    // the probe keeps sizing for a workload it no longer has; on a time-counted one they have
    // aged out and only the twelve are left.
    const pool = await measured(5, 40, 120, 12);
    const typical = pool.typicalDurationMs('test.slow');

    assert.ok(typical !== undefined);
    assert.ok(
      typical >= 100,
      `sized from the recent 120ms checks, not the stale 5ms ones; got ${String(typical)}`,
    );
  });

  it('still answers when a quiet probe has nothing recent at all', async () => {
    // A probe with three sensors on a five-minute interval measures nothing inside the window.
    // Stale but real beats fresh and absent: an undefined answer sends the sizer to its
    // assumption, which is the guess the measurement exists to replace.
    const { pool, seen } = await poolOf({
      size: 4,
      minSize: 4,
      idleShrinkMs: 0,
      durationWindowMs: 150,
    });
    for (let i = 0; i < 3; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 80 }));
    await until(() => seen.length === 3, 'three checks');
    await new Promise((resolve) => setTimeout(resolve, 200));

    const typical = pool.typicalDurationMs('test.slow');
    assert.ok(typical !== undefined, 'a stale answer rather than none');
    assert.ok(typical >= 60, `and it is the one that was measured; got ${String(typical)}`);
  });

  it('says nothing about a type it has never run', async () => {
    const { pool } = await poolOf({ size: 4, minSize: 4, idleShrinkMs: 0 });
    assert.equal(pool.typicalDurationMs('never.seen'), undefined);
  });
});

describe('a probe whose checks get slower (P-34)', () => {
  it('raises its ceiling from what it measured, before the backlog grows', async () => {
    // **The loop, rather than its parts.** The tests above prove that the pool learns a
    // duration, that the arithmetic is Little's law and that a ceiling can move. None of them
    // proves the three compose — that a probe whose network got slower notices and grows *in
    // time*, which is the whole promise and the only part an operator experiences.
    //
    // The same sensor type throughout, because that is the real case: `http.get` against an
    // endpoint that degrades is not a new type, it is the same one costing more.
    const { pool, seen } = await poolOf({ size: 4, minSize: 4, idleShrinkMs: 0 });

    const SENSORS = 3_000;
    const assignments = Array.from({ length: SENSORS }, () => ({
      sensorType: 'test.slow',
      intervalSeconds: 60,
    }));

    // What `main.ts` does on a config push and every thirty seconds, in miniature.
    const sizePool = (): number => {
      const demand = poolDemand(assignments, (type) => pool.typicalDurationMs(type), {
        fallbackMs: 20,
        min: 4,
        max: 64,
        margin: 1.3,
      });
      pool.setMaxSize(demand.ceiling);
      return demand.ceiling;
    };

    // A quiet network: 3,000 sensors a minute apart is 50 checks a second, and at 20 ms each
    // that is one worker's worth of work. The floor is under the minimum, so the minimum wins.
    for (let i = 0; i < 12; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 20 }));
    await until(() => seen.length === 12, 'the fast checks');
    const quiet = sizePool();
    assert.equal(quiet, 4, `a light workload derives the floor, got ${String(quiet)}`);

    // The same sensors, now answering ten times slower. 50 a second at 400 ms is 20 in flight.
    for (let i = 100; i < 112; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 400 }));
    await until(() => seen.length === 24, 'the slow checks');

    const busy = sizePool();
    assert.ok(
      busy > quiet,
      `the ceiling did not move when the work got slower: ${String(quiet)} -> ${String(busy)}`,
    );
    assert.ok(
      busy >= 20,
      `50 checks a second at 400 ms needs 20 in flight; derived ${String(busy)}`,
    );
    assert.equal(pool.maxSize, busy, 'and the pool took it');

    // **"Before the backlog grows" is the clause that matters**, and this is what makes it true:
    // the estimate comes from checks that have already *finished*, so a dozen of them is enough
    // to move the ceiling. Nothing had to queue up for the probe to find out.
    const stats = pool.stats();
    assert.equal(stats.deferred, 0, 'nothing was deferred while it learned');
    assert.equal(stats.refused, 0, 'and nothing refused');
    assert.ok(stats.queued <= 1, `the queue was still empty, held ${String(stats.queued)}`);
  });

  it('gives the room back when the network recovers', async () => {
    // The other direction, and the reason the ceiling is derived rather than latched: a probe
    // that grew for one bad afternoon should not hold the memory for ever. Lowering the ceiling
    // is safe by the test above — the shrink policy retires only idle, jobless workers.
    const { pool, seen } = await poolOf({ size: 4, minSize: 4, idleShrinkMs: 0 });
    const assignments = Array.from({ length: 3_000 }, () => ({
      sensorType: 'test.slow',
      intervalSeconds: 60,
    }));
    const sizePool = (): number => {
      const demand = poolDemand(assignments, (type) => pool.typicalDurationMs(type), {
        fallbackMs: 20,
        min: 4,
        max: 64,
        margin: 1.3,
      });
      pool.setMaxSize(demand.ceiling);
      return demand.ceiling;
    };

    for (let i = 0; i < 12; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 400 }));
    await until(() => seen.length === 12, 'the slow spell');
    const degraded = sizePool();
    assert.ok(degraded >= 20, `expected a raised ceiling, got ${String(degraded)}`);

    // Enough fast checks to carry the median back down — the window is bounded, so recovery is
    // a matter of running checks rather than of waiting.
    for (let i = 100; i < 130; i += 1) pool.submit(request(i, 'test.slow', { delayMs: 20 }));
    await until(() => seen.length === 42, 'the recovery');

    const recovered = sizePool();
    assert.ok(
      recovered < degraded,
      `the ceiling stayed high after the work got cheap: ${String(degraded)} -> ${String(recovered)}`,
    );
  });
});

describe('the default pool size', () => {
  it('is not derived from the core count', () => {
    // The thing `P-15` disproved. The old default was `cores - 1`, which is what a CPU-bound
    // pool wants; a check holds a slot while awaiting a packet and uses almost no CPU, so the
    // machine's width has nothing to do with how many packets are in the air.
    assert.notEqual(defaultPoolSize(), Math.max(1, availableParallelism() - 1));
    // Against `maxSize` since `P-18`, because `size` is now what the pool is holding rather than
    // what it is allowed to hold — and before it starts, that is nothing.
    assert.equal(
      defaultPoolSize(),
      new CheckPool({ logger: silent, onResult: () => undefined }).maxSize,
      'and the pool actually uses it',
    );
  });

  it('drains the v1 target’s dispatch batch in at most two tranches', () => {
    // The arithmetic the default exists to satisfy, and the shape the sweep measured. The wheel
    // hands over a whole second at once — 5,000 sensors on a 60-second interval is 83 — and the
    // wait a sensor sees is (tranches - 1) x check duration. Two tranches keeps a one-second
    // budget intact up to a check of about a second; three breaches it at about 500 ms, which
    // an ordinary HTTP check exceeds.
    const batch = Math.ceil(V1_TARGET_BURST);
    const tranches = Math.ceil(batch / defaultPoolSize());
    assert.ok(
      tranches <= 2,
      `${String(defaultPoolSize())} slots leaves ${String(tranches)} tranches for a batch of ` +
        String(batch),
    );
  });

  it('keeps up with the v1 target in the sensor type we ship', () => {
    // **The check that was missing, and its absence is `P-32`.** The tranche test above bounds
    // the wait for one batch and never asks whether that batch clears before the next arrives a
    // second later. A pool completes `slots / checkDuration` checks a second; below the arrival
    // rate the backlog grows for as long as the probe runs, and nothing is refused while the
    // queue still has room, so no counter says anything is wrong.
    //
    // `icmp.ping` is the case that bites, because it is the type this project ships and it is
    // not fast: four packets at `-i 0.2` is 600 ms (`P-07`). The old default of 48 was one
    // worker under this line and measured a p95 of 5,082 ms against a 1,000 ms budget.
    const floor = littleFloor(V1_TARGET_BURST, ICMP_PING_CHECK_MS);
    const served = defaultPoolSize() / (ICMP_PING_CHECK_MS / 1_000);

    assert.ok(
      defaultPoolSize() > floor,
      `${String(defaultPoolSize())} slots complete ${served.toFixed(1)} checks a second ` +
        `against ${V1_TARGET_BURST.toFixed(1)} arriving — the backlog would grow without bound`,
    );

    // And clear it by enough that the tranche model above actually holds. Measured at 600 ms:
    // 1.12x the floor predicted 600 ms and delivered 822; 1.28x delivered 614. The margin is
    // not decoration, it is the queueing the tranche model leaves out.
    assert.ok(
      defaultPoolSize() >= floor * 1.25,
      `${String(defaultPoolSize())} is only ${(defaultPoolSize() / floor).toFixed(2)}x the floor`,
    );
  });

  it('does not pay for slots the measurement showed were not worth it', () => {
    // At 600 ms checks, 96 slots take the v1 batch in one tranche and measure a p95 of 7 ms
    // against 64's 614 — but both are inside the 1,000 ms budget, and the 32 extra workers cost
    // about 1.1 GB in a real probe, where each carries the sensor catalogue. A default that
    // drifts upward without a measurement behind it is how a probe quietly starts needing a
    // gigabyte, so this is deliberately tight: raising it again means measuring again.
    assert.ok(defaultPoolSize() <= 64);
  });
});
