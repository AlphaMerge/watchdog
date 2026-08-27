import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server } from 'node:net';
import { icmpJitter } from '../src/types/icmp-jitter.js';
import { parsePorts, portRange } from '../src/types/port-range.js';
import type { CheckContext, CheckExecution, SensorType } from '../src/contract.js';

/**
 * The two halves of `T-22`, against the real binary and real sockets.
 *
 * The estimator itself is covered arithmetically in `ping.test.ts`; what is left here is what
 * cannot be faked — that a run of loopback pings produces a plausible figure, and that a set of
 * ports some of which are listening comes back counted correctly.
 */

/** Three listeners and one port with nothing on it. */
const open: number[] = [];
const servers: Server[] = [];
let closed = 0;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

before(async () => {
  for (let at = 0; at < 3; at += 1) {
    const server = createServer(() => undefined);
    servers.push(server);
    open.push(await listen(server));
  }
  open.sort((a, b) => a - b);

  const spare = createServer(() => undefined);
  closed = await listen(spare);
  await new Promise<void>((resolve) => {
    spare.close(() => {
      resolve();
    });
  });
});

after(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

function run(
  type: SensorType,
  params: Record<string, unknown> = {},
  over: Partial<CheckContext> = {},
): Promise<CheckExecution> {
  return type.execute({
    sensorId: 1,
    target: { host: '127.0.0.1', ipVersion: 'v4' },
    params,
    credentials: {},
    signal: new AbortController().signal,
    ...over,
  });
}

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

describe('parsePorts', () => {
  it('reads a list, a range, and both at once', () => {
    assert.deepEqual(parsePorts('22,80,443'), [22, 80, 443]);
    assert.deepEqual(parsePorts('8000-8003'), [8000, 8001, 8002, 8003]);
    assert.deepEqual(parsePorts('22, 8000-8002 , 443'), [22, 8000, 8001, 8002, 443]);
  });

  it('counts a port named twice once', () => {
    // Otherwise "80,8000-8010,80" is eleven ports reported as twelve, and the open percentage —
    // which is what the sensor is judged by — is quietly wrong.
    assert.deepEqual(parsePorts('80,80,80'), [80]);
    assert.deepEqual(parsePorts('8000-8002,8001'), [8000, 8001, 8002]);
  });

  it('refuses a range that runs backwards, rather than silently scanning nothing', () => {
    assert.throws(() => parsePorts('9000-8000'), /low first/);
  });

  it('refuses ports outside the range that exists', () => {
    assert.throws(() => parsePorts('0'), /1 to 65535/);
    assert.throws(() => parsePorts('70000'), /1 to 65535/);
    assert.throws(() => parsePorts('1-70000'), /1 to 65535/);
  });

  it('refuses what is not a port at all', () => {
    assert.throws(() => parsePorts('http'), /not a port or a range/);
    assert.throws(() => parsePorts('80-'), /not a port or a range/);
    assert.throws(() => parsePorts(''), /names no ports/);
    assert.throws(() => parsePorts(' , , '), /names no ports/);
  });

  it('refuses to become a port scanner', () => {
    // The bound is the point. A probe sweeping a thousand ports every sixty seconds is an
    // intrusion-detection alert somewhere, and a real scan is `nmap` run by a person, once.
    assert.deepEqual(parsePorts('1-64').length, 64);
    assert.throws(() => parsePorts('1-65'), /limit is 64/);
  });
});

describe('port.range', () => {
  it('counts what answered and what did not', async () => {
    const execution = await run(portRange, {
      ports: `${String(open[0])},${String(open[1])},${String(closed)}`,
      timeoutMs: 2_000,
    });
    assert.equal(valueOf(execution, 'open'), 2);
    assert.equal(valueOf(execution, 'closed'), 1);
    assert.equal(valueOf(execution, 'openPercent'), 66.67);
  });

  it('names the ports that are open, because the count alone does not tell you which', async () => {
    const execution = await run(portRange, {
      ports: `${String(closed)},${String(open[0])}`,
      timeoutMs: 2_000,
    });
    assert.match(execution.message ?? '', new RegExp(`1 of 2 open: ${String(open[0])}`));
  });

  it('is Up with nothing open, and leaves the judgement to a limit', async () => {
    // A firewall canary is a sensor that *wants* zero. The check succeeds and reports zero; a
    // trigger on the channel decides whether zero is good news or bad.
    const execution = await run(portRange, { ports: String(closed), timeoutMs: 2_000 });
    assert.equal(valueOf(execution, 'open'), 0);
    assert.equal(valueOf(execution, 'openPercent'), 0);
    assert.equal(execution.message, '0 of 1 open');
  });

  it('reports the channels it declares, and only those', async () => {
    const execution = await run(portRange, { ports: String(open[0]), timeoutMs: 2_000 });
    assert.deepEqual(
      execution.channels.map((channel) => channel.key),
      portRange.channels({}).map((channel) => channel.key),
    );
  });

  it('scans concurrently rather than one port at a time', async () => {
    // Eight dropped ports at a two-second timeout each is sixteen seconds serially and about two
    // in parallel. A sensor that took longer than its own scan interval would be a fault of its
    // own — and 198.51.100.x is TEST-NET-2, which by RFC 5737 nothing routes.
    const started = Date.now();
    const execution = await run(
      portRange,
      { ports: '9000-9007', timeoutMs: 1_500, concurrency: 8 },
      { target: { host: '198.51.100.1', ipVersion: 'v4' } },
    );
    assert.equal(valueOf(execution, 'open'), 0);
    assert.ok(
      Date.now() - started < 6_000,
      `eight ports took ${String(Date.now() - started)} ms, which is serial, not concurrent`,
    );
  });

  it('stops when the check is cancelled instead of finishing the range', async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 150);
    await assert.rejects(
      () =>
        run(
          portRange,
          { ports: '9000-9031', timeoutMs: 5_000, concurrency: 1 },
          { target: { host: '198.51.100.1', ipVersion: 'v4' }, signal: controller.signal },
        ),
      /cancelled while scanning/,
    );
  });

  it('refuses a bad port list before opening a single socket', async () => {
    await assert.rejects(() => run(portRange, { ports: '9000-8000' }), /low first/);
  });
});

describe('icmp.jitter', () => {
  it('measures a real run and reports the channels it declares', async () => {
    const execution = await run(icmpJitter, { count: 5, timeoutMs: 20_000 });
    assert.deepEqual(
      execution.channels.map((channel) => channel.key),
      icmpJitter.channels({}).map((channel) => channel.key),
    );
    const jitter = valueOf(execution, 'jitter');
    assert.ok(
      typeof jitter === 'number' && jitter >= 0 && jitter < 100,
      `implausible loopback jitter: ${String(jitter)}`,
    );
    assert.equal(valueOf(execution, 'loss'), 0);
    assert.match(execution.message ?? '', /ms jitter over 5 replies/);
  });

  it('fails rather than reporting a steady link that never answered', async () => {
    await assert.rejects(
      () =>
        run(
          icmpJitter,
          { count: 5, timeoutMs: 3_000 },
          { target: { host: '198.51.100.1', ipVersion: 'v4' } },
        ),
      /no round-trip time to measure|did not answer|jitter is the variation/,
    );
  });
});
