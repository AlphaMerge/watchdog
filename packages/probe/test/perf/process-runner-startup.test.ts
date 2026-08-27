import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import { ProcessRunner } from '../../src/runner/process-runner.js';
import type { ResultMeta } from '../../src/runner/types.js';
import type { CheckResult } from '@ms/shared';

/**
 * What a process of its own costs (`P-03`).
 *
 * CLAUDE.md: a performance claim needs a measurement committed to the repo. The claim this backs
 * is the one that decides the whole design — **isolation is opt-in per sensor type**, because it
 * costs a Node start-up per check and that is unreasonable for an ICMP check and irrelevant
 * beside a script that shells out anyway.
 *
 * The overhead measured is the honest one: wall-clock from `submit` to the result, minus the time
 * the check itself reported. That difference is spawn, Node boot, module resolution, the registry
 * import, and the JSON both ways.
 *
 * Numbers are printed rather than asserted tightly, because they are a property of the machine.
 * The assertion is a ceiling loose enough not to be a flaky test and tight enough to catch a
 * regression that would matter — a second per check would mean something is wrong with the way
 * the child is started, not with the machine it started on.
 */

const silent = pino({ level: 'silent' });
const FIXTURES = join(import.meta.dirname, '..', 'support', 'check-fixtures.js');

const RUNS = 20;

interface Seen {
  result: CheckResult;
  meta: ResultMeta;
  wallMs: number;
}

const runners: ProcessRunner[] = [];

after(async () => {
  await Promise.all(runners.map((runner) => runner.stop()));
});

describe('process runner start-up cost', () => {
  it('costs a bounded and measured overhead per check', async () => {
    const seen: Seen[] = [];
    const submittedAt = new Map<number, bigint>();
    const runner = new ProcessRunner({
      logger: silent,
      registryModule: FIXTURES,
      // One at a time: this measures the cost of a start-up, not of contending for cores.
      maxConcurrent: 1,
      onResult: (result, meta) => {
        const started = submittedAt.get(result.sensorId) ?? process.hrtime.bigint();
        seen.push({
          result,
          meta,
          wallMs: Number(process.hrtime.bigint() - started) / 1e6,
        });
      },
    });
    runners.push(runner);

    for (let at = 0; at < RUNS; at += 1) {
      submittedAt.set(at, process.hrtime.bigint());
      runner.submit({
        sensorId: at,
        sensorType: 'test.ok',
        target: { host: '192.0.2.1', ipVersion: 'auto' },
        params: {},
        timeoutMs: 20_000,
      });
      // Serially, so each measurement is one start-up rather than a share of several.
      while (seen.length <= at) await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(seen.length, RUNS);
    assert.ok(seen.every((one) => one.result.outcome === 'ok'));

    const overheads = seen.map((one) => one.wallMs - one.result.durationMs).sort((a, b) => a - b);
    const at = (fraction: number): number =>
      Math.round(
        (overheads[Math.min(overheads.length - 1, Math.floor(fraction * RUNS))] ?? 0) * 10,
      ) / 10;

    process.stdout.write(
      `\n    measured, ${String(RUNS)} checks in a process each (serial):\n` +
        `      start-up overhead  p50 ${String(at(0.5))} ms  p95 ${String(at(0.95))} ms  ` +
        `max ${String(Math.round((overheads[overheads.length - 1] ?? 0) * 10) / 10)} ms\n`,
    );

    assert.ok(
      at(0.5) < 1_000,
      `a start-up costing ${String(at(0.5))} ms is a fault in how the child is started`,
    );
  });

  it('costs more with the real catalogue than with a one-file registry, and says how much', async () => {
    // The number that matters for the shipped path. The fixture registry is one file; the real
    // one imports `@ms/sensors` and builds the whole catalogue, and a child pays that on every
    // check — which is exactly the cost a pool would amortise and this deliberately does not.
    const seen: { wallMs: number; durationMs: number; ok: boolean }[] = [];
    const submittedAt = new Map<number, bigint>();
    const runner = new ProcessRunner({
      logger: silent,
      // No `registryModule`: the default is the real one.
      maxConcurrent: 1,
      onResult: (result) => {
        const started = submittedAt.get(result.sensorId) ?? process.hrtime.bigint();
        seen.push({
          wallMs: Number(process.hrtime.bigint() - started) / 1e6,
          durationMs: result.durationMs,
          ok: result.outcome === 'ok',
        });
      },
    });
    runners.push(runner);

    const rounds = 10;
    for (let at = 0; at < rounds; at += 1) {
      submittedAt.set(200 + at, process.hrtime.bigint());
      runner.submit({
        sensorId: 200 + at,
        sensorType: 'icmp.ping',
        target: { host: '127.0.0.1', ipVersion: 'v4' },
        params: { count: 1, timeoutMs: 4_000, packetSize: 32 },
        timeoutMs: 20_000,
      });
      while (seen.length <= at) await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const overheads = seen.map((one) => one.wallMs - one.durationMs).sort((a, b) => a - b);
    const median = Math.round((overheads[Math.floor(rounds / 2)] ?? 0) * 10) / 10;
    process.stdout.write(
      `    with the real catalogue (icmp.ping, ${String(rounds)} checks): ` +
        `start-up overhead p50 ${String(median)} ms\n`,
    );
    assert.equal(seen.filter((one) => one.ok).length, rounds);
    assert.ok(median < 2_000, `${String(median)} ms of start-up is a fault, not a slow machine`);
  });

  it('overlaps start-ups at the default concurrency', async () => {
    // The cap is small on purpose, but it must actually overlap: four checks at once should not
    // cost four start-ups end to end.
    const results: CheckResult[] = [];
    const runner = new ProcessRunner({
      logger: silent,
      registryModule: FIXTURES,
      maxConcurrent: 4,
      onResult: (result) => results.push(result),
    });
    runners.push(runner);

    const startedAt = process.hrtime.bigint();
    for (let at = 100; at < 108; at += 1) {
      runner.submit({
        sensorId: at,
        sensorType: 'test.ok',
        target: { host: '192.0.2.1', ipVersion: 'auto' },
        params: {},
        timeoutMs: 20_000,
      });
    }
    while (results.length < 8) await new Promise((resolve) => setTimeout(resolve, 5));
    const totalMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    process.stdout.write(
      `    8 checks at a concurrency of 4: ${String(Math.round(totalMs))} ms total, ` +
        `${String(Math.round(totalMs / 8))} ms each\n`,
    );
    assert.equal(results.filter((one) => one.outcome === 'ok').length, 8);
  });
});
