import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { CheckContext, CheckTarget } from '../src/contract.js';
import { icmpPing } from '../src/types/icmp-ping.js';

/**
 * The ping sensor against the real binary.
 *
 * The target is loopback: always present, always fast, and not a live network target — which is
 * what CLAUDE.md forbids tests from depending on. The parsing itself is covered exhaustively in
 * `ping.test.ts` against captured output from three platforms; what this file proves is the part
 * that cannot be faked — that the process is spawned, cancelled and read correctly.
 */
function context(
  params: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
  target: CheckTarget = { host: '127.0.0.1', ipVersion: 'v4' },
): CheckContext {
  return { sensorId: 1, target, params, signal };
}

describe('icmp.ping', () => {
  it('reports the channels it declares, and only those', async () => {
    const execution = await icmpPing.execute(context({ count: 2, timeoutMs: 4_000 }));

    assert.deepEqual(
      execution.channels.map((channel) => channel.key),
      ['rtt', 'loss'],
      'the readings must match the declared channels or the core creates a channel per scan',
    );
    const rtt = execution.channels.find((channel) => channel.key === 'rtt');
    const loss = execution.channels.find((channel) => channel.key === 'loss');
    assert.ok(rtt !== undefined && loss !== undefined);
    assert.ok(
      rtt.value >= 0 && rtt.value < 1_000,
      `implausible loopback rtt: ${String(rtt.value)}`,
    );
    assert.equal(loss.value, 0, 'loopback does not drop packets');
    assert.match(execution.message ?? '', /2\/2 replies/);
  });

  it('honours the defaults its own schema declares', async () => {
    // An operator who submits an empty form gets count 4; the check must work with no params.
    const execution = await icmpPing.execute(context({}));
    assert.match(execution.message ?? '', /4\/4 replies/);
  });

  it('fails, rather than reporting zero, when nothing replies', async () => {
    // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): reserved for documentation and guaranteed not to
    // be a real host, so this is deterministic without touching the network.
    await assert.rejects(
      () =>
        icmpPing.execute(
          context({ count: 1, timeoutMs: 1_000 }, undefined, {
            host: '192.0.2.1',
            ipVersion: 'v4',
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // A Down sensor records no channel values (CLAUDE.md), so this must throw rather than
        // return rtt 0 — which a graph could not tell from a very fast reply.
        assert.match(error.message, /no ICMP reply from 192\.0\.2\.1/);
        assert.match(error.message, /1 sent, 0 replies/);
        return true;
      },
    );
  });

  it('returns promptly when its signal is aborted', async () => {
    // Twenty packets is about nineteen seconds of pinging. CLAUDE.md requires every check to
    // honour the signal; one that does not gets its worker terminated instead.
    const controller = new AbortController();
    const started = Date.now();
    const running = icmpPing.execute(context({ count: 20, timeoutMs: 60_000 }, controller.signal));

    setTimeout(() => {
      controller.abort();
    }, 150);

    await assert.rejects(() => running);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5_000, `took ${String(elapsed)} ms to notice the abort`);
  });

  it('says which binary is missing rather than failing anonymously', async () => {
    // The case P-16 was filed for: node:24-bookworm ships no `ping`, so a probe in a minimal
    // container fails every check identically until someone installs it.
    const path = process.env['PATH'];
    process.env['PATH'] = '/nonexistent';
    try {
      await assert.rejects(
        () => icmpPing.execute(context({ count: 1 })),
        /the "ping" binary is not available on this probe/,
      );
    } finally {
      process.env['PATH'] = path;
    }
  });

  it('refuses a device with no host', async () => {
    await assert.rejects(
      () => icmpPing.execute(context({}, undefined, { host: '', ipVersion: 'auto' })),
      /no host to ping/,
    );
  });
});
