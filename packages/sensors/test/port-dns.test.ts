import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server } from 'node:net';
import { portTcp } from '../src/types/port-tcp.js';
import { dnsRecord } from '../src/types/dns-record.js';
import type { CheckContext, CheckExecution, SensorType } from '../src/contract.js';

/**
 * Real sockets and the real system resolver.
 *
 * A TCP connect is three lines of `node:net`, so a mocked one would test the mock. What is worth
 * asserting is what happens at the edges — a port nothing listens on, a port that accepts and
 * says nothing, a peer that never stops talking — and each of those is a real server behaving a
 * particular way.
 */

/** Speaks first, like SSH and SMTP do. */
let banner: Server;
/** Accepts and says nothing, like HTTP. */
let silent: Server;
/** Talks for ever, which is what the output bound is for. */
let flood: Server;

const ports = { banner: 0, silent: 0, flood: 0, closed: 0 };

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

before(async () => {
  banner = createServer((socket) => {
    socket.write('SSH-2.0-OpenSSH_9.6\r\n');
  });
  silent = createServer(() => undefined);
  flood = createServer((socket) => {
    const pump = (): void => {
      if (socket.destroyed) return;
      socket.write('x'.repeat(4_096));
      setTimeout(pump, 1);
    };
    pump();
  });

  ports.banner = await listen(banner);
  ports.silent = await listen(silent);
  ports.flood = await listen(flood);

  // A port with nothing on it: bind one, note it, and give it straight back.
  const spare = createServer(() => undefined);
  ports.closed = await listen(spare);
  await new Promise<void>((resolve) => {
    spare.close(() => {
      resolve();
    });
  });
});

after(async () => {
  for (const server of [banner, silent, flood]) {
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

describe('port.tcp', () => {
  it('connects and reports how long the handshake took', async () => {
    const execution = await run(portTcp, { port: ports.silent, timeoutMs: 2_000 });
    const connectTime = valueOf(execution, 'connectTime');
    assert.ok(typeof connectTime === 'number' && connectTime >= 0 && connectTime < 2_000);
    assert.match(execution.message ?? '', /connected in [\d.]+ ms/);
  });

  it('declares a banner channel only when a banner was asked for', () => {
    // A channel that is always 1 is a line on a graph that never says anything.
    assert.deepEqual(
      portTcp.channels({ port: 22 }).map((channel) => channel.key),
      ['connectTime'],
    );
    assert.deepEqual(
      portTcp.channels({ port: 22, banner: 'OpenSSH' }).map((channel) => channel.key),
      ['connectTime', 'bannerMatched'],
    );
  });

  it('matches a banner the service sent, ignoring case', async () => {
    const execution = await run(portTcp, { port: ports.banner, banner: 'openssh' });
    assert.equal(valueOf(execution, 'bannerMatched'), 1);
    assert.match(execution.message ?? '', /banner contains "openssh"/);
  });

  it('reports a banner that changed rather than failing the check', async () => {
    // The service is up and answering; what it says has changed. That is a reading to alarm on
    // with a limit, not a failed check — and the message carries what it actually said.
    const execution = await run(portTcp, { port: ports.banner, banner: 'Dropbear' });
    assert.equal(valueOf(execution, 'bannerMatched'), 0);
    assert.match(
      execution.message ?? '',
      /does not contain "Dropbear" — it said "SSH-2\.0-OpenSSH_9\.6"/,
    );
  });

  it('says a silent protocol is silent rather than calling it a mismatch', async () => {
    // A misconfigured sensor, not a fault: HTTP never announces itself, so a banner check
    // against it can never pass and the fix is to remove the banner rather than to look at
    // the server.
    await assert.rejects(
      () => run(portTcp, { port: ports.silent, banner: 'anything', bannerTimeoutMs: 300 }),
      /accepted a connection in [\d.]+ ms but said nothing within 300 ms/,
    );
  });

  it('says nothing is listening rather than "connection failed"', async () => {
    await assert.rejects(
      () => run(portTcp, { port: ports.closed, timeoutMs: 2_000 }),
      /nothing is listening on that port/,
    );
  });

  it('distinguishes a filtered port from a closed one in its message', async () => {
    // 198.51.100.0/24 is TEST-NET-2 and is not routed, so a connection to it hangs the way a
    // dropped packet does rather than being refused.
    await assert.rejects(
      () =>
        run(
          portTcp,
          { port: 9, timeoutMs: 400 },
          { target: { host: '198.51.100.1', ipVersion: 'v4' } },
        ),
      /did not accept a connection within 400 ms.*firewall drops/s,
    );
  });

  it('stops a peer that never stops talking', async () => {
    // The bound that keeps one broken service from filling a worker shared by hundreds of
    // sensors. It resolves rather than fails: a banner arrived, and that is the reading.
    const execution = await run(portTcp, {
      port: ports.flood,
      banner: 'xxx',
      bannerTimeoutMs: 10_000,
    });
    assert.equal(valueOf(execution, 'bannerMatched'), 1);
  });

  it('refuses a sensor with no port before opening a socket', async () => {
    await assert.rejects(() => run(portTcp, {}), /names no port/);
  });

  it('returns promptly when the check is aborted', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = run(
      portTcp,
      { port: 9, timeoutMs: 30_000 },
      { target: { host: '198.51.100.1', ipVersion: 'v4' }, signal: controller.signal },
    );
    setTimeout(() => {
      controller.abort();
    }, 100);
    await assert.rejects(() => pending, /cancelled/);
    assert.ok(Date.now() - started < 3_000);
  });
});

describe('dns.record', () => {
  it('resolves the device’s own host when no name is given', async () => {
    // What makes this sensor answer "can this probe still resolve this device", which is the
    // dependency every other sensor on it has.
    const execution = await run(
      dnsRecord,
      { recordType: 'A' },
      {
        target: { host: 'localhost', ipVersion: 'v4' },
      },
    );
    assert.equal(valueOf(execution, 'records'), 1);
    assert.match(execution.message ?? '', /A localhost → 127\.0\.0\.1/);
  });

  it('times the query', async () => {
    const execution = await run(dnsRecord, { name: 'localhost' });
    const responseTime = valueOf(execution, 'responseTime');
    assert.ok(typeof responseTime === 'number' && responseTime >= 0);
  });

  it('accepts a value that matches any record, not just the first', async () => {
    // A name with two addresses answers in either order, and a check reading records[0] would
    // flap between them for ever with nothing wrong.
    const execution = await run(dnsRecord, { name: 'localhost', expected: '127.0.0.1' });
    assert.equal(valueOf(execution, 'records'), 1);
  });

  it('fails naming what it got when the value is not what was expected', async () => {
    await assert.rejects(
      () => run(dnsRecord, { name: 'localhost', expected: '10.0.0.1' }),
      /is 127\.0\.0\.1, and this sensor expects 10\.0\.0\.1/,
    );
  });

  it('separates "no such record" from "the lookup failed"', async () => {
    // Different faults with different fixes: one is a name that resolves to nothing of that
    // type, the other is a resolver that did not answer.
    await assert.rejects(
      () => run(dnsRecord, { name: 'no-such-name.invalid', timeoutMs: 3_000 }),
      /(has no A record|failed)/,
    );
  });

  it('refuses a resolver that is not an address', async () => {
    // A resolver is an IP address. Accepting a name here would mean resolving a resolver, which
    // is the problem this sensor exists to detect.
    await assert.rejects(
      () => run(dnsRecord, { name: 'localhost', resolver: 'ns.example.com' }),
      /not an address this resolver can be pointed at/,
    );
  });

  it('refuses a sensor that names nothing to look up', async () => {
    await assert.rejects(
      () => run(dnsRecord, {}, { target: { host: '', ipVersion: 'v4' } }),
      /names nothing to look up/,
    );
  });

  it('declares response time as the channel it is judged by', () => {
    const defs = dnsRecord.channels({});
    assert.deepEqual(
      defs.filter((def) => def.isPrimary === true).map((def) => def.key),
      ['responseTime'],
    );
    assert.deepEqual(
      defs.map((def) => def.key),
      ['responseTime', 'records'],
    );
  });
});
