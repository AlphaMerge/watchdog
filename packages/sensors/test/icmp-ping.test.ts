import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SensorCatalogue } from '../src/catalogue.js';
import type { CheckContext, CheckTarget } from '../src/contract.js';
import { PingError } from '../src/support/ping.js';
import { icmpJitter } from '../src/types/icmp-jitter.js';
import { icmpPing } from '../src/types/icmp-ping.js';
import { failedIn, rejectionOf } from './support/failed-in.js';

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
  return { sensorId: 1, target, params, credentials: {}, signal };
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

  it('defaults to the spacing P-07 measured, not to ping’s own', () => {
    // This default is the whole of what `P-07` bought. At ping's one second a four-packet check
    // holds a worker for three, and 5,000 of those do not fit in a minute at any pool size worth
    // having; at 0.2 s the same 64 workers move 99 targets a second instead of 20. Asserted
    // through the catalogue rather than off the schema literal, because the catalogue is what
    // fills a default in before a check ever runs — a default nothing applies is not a default.
    const result = new SensorCatalogue().register(icmpPing).seal().validate('icmp.ping', {});
    assert.ok(result.valid);
    assert.equal(result.params['intervalSeconds'], 0.2);
  });

  it('refuses a spacing below the floor an unprivileged ping allows', () => {
    // 0.2 s is where iputils stops allowing it without `CAP_NET_RAW`. Below that whether the
    // check works at all depends on how ping was installed on the operator's machine, so it is
    // refused at the form rather than discovered in production.
    const catalogue = new SensorCatalogue().register(icmpPing).seal();
    assert.equal(catalogue.validate('icmp.ping', { intervalSeconds: 0.1 }).valid, false);
  });

  it('spaces the packets it sends, which is the only place the default can be seen', async () => {
    // A default that never reaches `pingCommand` does nothing, and every other test in this file
    // would still pass — the readings are identical either way, only the clock knows. Four
    // loopback packets at 0.2 s take about 0.6 s; at ping's own second they take over three. The
    // budget below is 3x the expected and half the alternative, so this asserts the flag rather
    // than the speed of the machine it runs on.
    const started = process.hrtime.bigint();
    await icmpPing.execute(context({}));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(
      elapsedMs < 2_000,
      `four loopback packets took ${elapsedMs.toFixed(0)} ms — ping was not given -i`,
    );
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

describe('where a ping failed (P-406)', () => {
  // TEST-NET-1 (RFC 5737) answers nothing, deterministically, and loopback is always there.
  const silent: CheckTarget = { host: '192.0.2.1', ipVersion: 'v4' };

  it('names the echoes, and the device, when nothing replies', async () => {
    for (const type of [icmpPing, icmpJitter]) {
      const error = await rejectionOf(() =>
        type.execute(
          context({ count: 2, timeoutMs: 1_500, intervalSeconds: 0.2 }, undefined, silent),
        ),
      );
      assert.ok(error instanceof PingError, `${type.id}: ${String(error)}`);
      assert.deepEqual(failedIn(error), { phase: 'echo', target: '192.0.2.1' }, type.id);
    }
  });

  it('names the echoes when the check is cancelled while pinging', async () => {
    const controller = new AbortController();
    const running = rejectionOf(() =>
      icmpPing.execute(context({ count: 20, timeoutMs: 60_000 }, controller.signal)),
    );
    setTimeout(() => {
      controller.abort();
    }, 150);
    assert.deepEqual(failedIn(await running), { phase: 'echo', target: '127.0.0.1' });
  });

  it('names the lookup, and the device’s name, when ping’s resolver does not know it', async () => {
    // `.invalid` is reserved (RFC 6761): no resolver anywhere answers it with an address.
    const unknown: CheckTarget = { host: 'nosuch.invalid', ipVersion: 'auto' };
    for (const type of [icmpPing, icmpJitter]) {
      const error = await rejectionOf(() =>
        type.execute(
          context({ count: 2, timeoutMs: 5_000, intervalSeconds: 0.2 }, undefined, unknown),
        ),
      );
      assert.match(String(error), /could not resolve nosuch\.invalid/, type.id);
      assert.deepEqual(
        failedIn(error),
        { phase: 'resolve', target: 'nosuch.invalid' },
        `${type.id}: ${String(error)}`,
      );
    }
  });

  it('names ping, and no device, when it could not ping from this probe at all', async () => {
    // A `ping` that cannot open its socket, as in a container without `CAP_NET_RAW`: it says
    // so, prints no statistics and exits 2, having sent nothing.
    const dir = mkdtempSync(join(tmpdir(), 'ms-ping-'));
    writeFileSync(
      join(dir, 'ping'),
      "#!/bin/sh\necho 'ping: socket: Operation not permitted' >&2\nexit 2\n",
      { mode: 0o755 },
    );
    const path = process.env['PATH'];
    process.env['PATH'] = dir;
    try {
      for (const type of [icmpPing, icmpJitter]) {
        const error = await rejectionOf(() => type.execute(context({ count: 2 })));
        assert.match(String(error), /ping sent no echo to 127\.0\.0\.1: .*Operation not permitted/);
        assert.deepEqual(failedIn(error), { phase: 'exec', target: undefined }, type.id);
      }
    } finally {
      process.env['PATH'] = path;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the program, and no device, when this probe cannot run ping', async () => {
    const path = process.env['PATH'];
    process.env['PATH'] = '/nonexistent';
    try {
      const error = await rejectionOf(() => icmpPing.execute(context({ count: 1 })));
      assert.match(String(error), /binary is not available on this probe/);
      assert.deepEqual(failedIn(error), { phase: 'exec', target: undefined });
    } finally {
      process.env['PATH'] = path;
    }
  });
});
