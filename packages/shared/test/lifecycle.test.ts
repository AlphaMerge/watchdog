import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import { Lifecycle } from '../src/lifecycle/lifecycle.js';
import type { ServiceNotifier } from '../src/lifecycle/systemd.js';

const silentLogger = pino({ level: 'silent' });

function fakeNotifier(): ServiceNotifier & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    enabled: true,
    ready: () => calls.push('ready'),
    watchdog: () => calls.push('watchdog'),
    stopping: (_status?: string, extendMs?: number) =>
      calls.push(extendMs === undefined ? 'stopping' : `stopping ${String(extendMs)}`),
    status: () => calls.push('status'),
    extendTimeout: (ms: number, status?: string) =>
      calls.push(`extend ${String(ms)} ${status ?? ''}`.trimEnd()),
  };
}

/** Captures the exit code instead of killing the test runner. */
function harness(shutdownTimeoutMs = 1_000): {
  lifecycle: Lifecycle;
  notifier: ServiceNotifier & { calls: string[] };
  exitCodes: number[];
} {
  const notifier = fakeNotifier();
  const exitCodes: number[] = [];
  const lifecycle = new Lifecycle({
    logger: silentLogger,
    shutdownTimeoutMs,
    notifier,
    exit: (code: number): never => {
      exitCodes.push(code);
      return undefined as never;
    },
  });
  return { lifecycle, notifier, exitCodes };
}

describe('Lifecycle', () => {
  it('runs shutdown hooks in reverse registration order', async () => {
    const { lifecycle, exitCodes } = harness();
    const order: string[] = [];

    lifecycle.onShutdown({ name: 'first-started', run: () => void order.push('first-started') });
    lifecycle.onShutdown({ name: 'second-started', run: () => void order.push('second-started') });
    lifecycle.onShutdown({ name: 'third-started', run: () => void order.push('third-started') });

    await lifecycle.shutdown({ kind: 'requested', detail: 'test' });

    assert.deepEqual(order, ['third-started', 'second-started', 'first-started']);
    assert.deepEqual(exitCodes, [0]);
  });

  it('aborts its signal as soon as shutdown begins', async () => {
    const { lifecycle } = harness();
    assert.equal(lifecycle.signal.aborted, false);

    let signalledInsideHook: boolean | undefined;
    lifecycle.onShutdown({
      name: 'observe',
      run: (signal) => {
        signalledInsideHook = signal.aborted;
      },
    });

    await lifecycle.shutdown({ kind: 'requested', detail: 'test' });

    assert.equal(signalledInsideHook, true);
    assert.equal(lifecycle.signal.aborted, true);
  });

  it('continues past a hook that throws', async () => {
    const { lifecycle, exitCodes } = harness();
    const ran: string[] = [];

    lifecycle.onShutdown({ name: 'early', run: () => void ran.push('early') });
    lifecycle.onShutdown({
      name: 'broken',
      run: () => {
        throw new Error('flush failed');
      },
    });

    await lifecycle.shutdown({ kind: 'requested', detail: 'test' });

    assert.deepEqual(ran, ['early'], 'a failing hook must not strand the ones behind it');
    assert.deepEqual(exitCodes, [0]);
  });

  it('abandons a hook that overruns its own budget and keeps draining', async () => {
    const { lifecycle, exitCodes } = harness(5_000);
    const ran: string[] = [];

    lifecycle.onShutdown({ name: 'after', run: () => void ran.push('after') });
    lifecycle.onShutdown({
      name: 'stuck',
      timeoutMs: 50,
      run: () => new Promise<void>(() => undefined),
    });

    await lifecycle.shutdown({ kind: 'requested', detail: 'test' });

    assert.deepEqual(ran, ['after']);
    assert.deepEqual(exitCodes, [0]);
  });

  it('exits non-zero when the whole shutdown budget is exhausted', async () => {
    const { lifecycle, exitCodes } = harness(50);

    lifecycle.onShutdown({ name: 'stuck', run: () => new Promise<void>(() => undefined) });

    await lifecycle.shutdown({ kind: 'requested', detail: 'test' });

    assert.deepEqual(exitCodes, [1]);
  });

  it('exits 1 when shutdown was caused by an error', async () => {
    const { lifecycle, exitCodes } = harness();
    await lifecycle.shutdown({ kind: 'error', error: new Error('boom') });
    assert.deepEqual(exitCodes, [1]);
  });

  it('is idempotent — a second signal does not re-run the hooks', async () => {
    const { lifecycle, exitCodes } = harness();
    let runs = 0;
    lifecycle.onShutdown({ name: 'count', run: () => void (runs += 1) });

    await lifecycle.shutdown({ kind: 'signal', signal: 'SIGTERM' });
    await lifecycle.shutdown({ kind: 'signal', signal: 'SIGTERM' });

    assert.equal(runs, 1);
    assert.deepEqual(exitCodes, [0]);
  });

  it('notifies the supervisor on ready and on stop', async () => {
    const { lifecycle, notifier } = harness();

    lifecycle.ready('listening');
    await lifecycle.shutdown({ kind: 'requested', detail: 'test' });

    // The stop carries the budget and a margin (`P-227`), so `TimeoutStopSec` cannot cut short a
    // drain the configuration allows.
    assert.deepEqual(notifier.calls, ['ready', 'stopping 6000']);
  });

  it('asks for more start-up time with the reason in the same notification (P-215)', () => {
    const { lifecycle, notifier } = harness();

    lifecycle.starting('waiting for PostgreSQL', 17_000);

    // One call carrying both: two separate notifications are two spawns, and two spawns are not
    // ordered, so `systemctl status` could show one attempt's reason beside another's deadline.
    assert.deepEqual(notifier.calls, ['extend 17000 waiting for PostgreSQL']);
  });
});

describe('Lifecycle.waitForShutdown', () => {
  it('holds the process open until the drain finishes', async () => {
    const { lifecycle } = harness();
    const observed: string[] = [];

    lifecycle.onShutdown({
      name: 'slow-drain',
      run: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        observed.push('hook-done');
      },
    });

    const waiting = lifecycle.waitForShutdown().then(() => observed.push('wait-resolved'));
    setTimeout(() => void lifecycle.shutdown({ kind: 'signal', signal: 'SIGTERM' }), 5);
    await waiting;

    assert.deepEqual(
      observed,
      ['hook-done', 'wait-resolved'],
      'waitForShutdown must not resolve while hooks are still draining',
    );
  });
});
