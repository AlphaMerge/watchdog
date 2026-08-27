import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { pino } from 'pino';
import type { Fingerprint, IdentifyJob, OpenPort, SweepEnding } from '@ms/shared';
import {
  identify,
  printable,
  serverHeaderOf,
  type IdentifyDeps,
} from '../src/discovery/identify.js';
import { IdentifyRunner } from '../src/discovery/identify-runner.js';

/**
 * Collecting what a host is (`D-02`).
 *
 * The *conclusions* are drawn by `classify` in `@ms/shared`, which is pure and has its own file.
 * What is here is the collection: that a source which fails is a source that said nothing, that
 * twelve ports and a resolver query happen together rather than in series, and that the TCP probe
 * reads a banner without ever sending one. The last of those runs against a real socket, because
 * a mocked one would prove only that the mock was written to match.
 */

const silent = pino({ level: 'silent' });

const deps = (over: Partial<IdentifyDeps> = {}): IdentifyDeps => ({
  reverseLookup: () => Promise.resolve(null),
  snmpSystem: () => Promise.resolve(null),
  tcpProbe: () => Promise.resolve(null),
  httpServer: () => Promise.resolve(null),
  ...over,
});

describe('collecting', () => {
  it('puts every source into one fingerprint', async () => {
    const found = await identify(
      '10.0.0.5',
      { timeoutMs: 500, community: 'public' },
      deps({
        reverseLookup: () => Promise.resolve('sw-core-01.example.com'),
        snmpSystem: () =>
          Promise.resolve({
            sysDescr: 'Cisco IOS Software, Version 15.2(7)E3',
            sysObjectId: '1.3.6.1.4.1.9.1.1745',
            sysName: 'sw-core-01',
          }),
        tcpProbe: (_address, port) =>
          Promise.resolve(port === 22 || port === 443 ? { port, transport: 'tcp' } : null),
      }),
    );

    assert.equal(found.address, '10.0.0.5');
    assert.equal(found.kind, 'network');
    assert.equal(found.vendor, 'Cisco');
    assert.equal(found.reverseName, 'sw-core-01.example.com');
    assert.deepEqual(
      found.ports.map((one) => one.port).sort((a, b) => a - b),
      [22, 443],
    );
  });

  it('asks every source at once, not one after another', async () => {
    // Twelve ports plus a PTR plus an SNMP get, run in series at a one-second timeout, is
    // fourteen seconds a host — nearly an hour on a /24 for something a network answers in a
    // moment.
    let peak = 0;
    let inFlight = 0;
    const slow = async <T>(value: T): Promise<T> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return value;
    };
    await identify(
      '10.0.0.5',
      { timeoutMs: 500, community: 'public' },
      deps({
        reverseLookup: () => slow(null),
        snmpSystem: () => slow(null),
        tcpProbe: () => slow(null),
      }),
    );
    assert.ok(peak > 5, `only ${String(peak)} probes were ever in flight at once`);
  });

  it('treats a source that failed as a source that said nothing', async () => {
    // A refused connection, a resolver with no PTR zone and a host that ignores SNMP are all
    // ordinary. A run that failed a host because one of a dozen probes threw would report an
    // estate as unidentifiable on the strength of a firewall rule.
    const found = await identify(
      '10.0.0.5',
      { timeoutMs: 500, community: 'public' },
      deps({
        reverseLookup: () => Promise.reject(new Error('ESERVFAIL')),
        snmpSystem: () => Promise.reject(new Error('ETIMEDOUT')),
        tcpProbe: (_address, port) =>
          port === 22
            ? Promise.resolve({ port, transport: 'tcp' as const })
            : Promise.reject(new Error('EHOSTUNREACH')),
      }),
    );
    assert.equal(found.kind, 'linux', 'and still concluded what it could');
    assert.equal(found.reverseName, undefined);
  });

  it('skips SNMP entirely when there is no community to try', async () => {
    let asked = false;
    await identify(
      '10.0.0.5',
      { timeoutMs: 500, community: '' },
      deps({
        snmpSystem: () => {
          asked = true;
          return Promise.resolve(null);
        },
      }),
    );
    assert.equal(asked, false);
  });

  it('reads the HTTP server header only from a port already found open', async () => {
    let httpAsked = 0;
    const withPorts = (open: number[]): IdentifyDeps =>
      deps({
        tcpProbe: (_address, port) =>
          Promise.resolve(open.includes(port) ? { port, transport: 'tcp' as const } : null),
        httpServer: () => {
          httpAsked += 1;
          return Promise.resolve('nginx/1.24.0');
        },
      });

    const closed = await identify('10.0.0.5', { timeoutMs: 500, community: '' }, withPorts([22]));
    assert.equal(httpAsked, 0);
    assert.equal(closed.httpServer, undefined);

    const open = await identify('10.0.0.5', { timeoutMs: 500, community: '' }, withPorts([80]));
    assert.equal(httpAsked, 1);
    assert.equal(open.httpServer, 'nginx/1.24.0');
  });
});

describe('printable — a banner fit to store', () => {
  it('strips the NUL byte that PostgreSQL cannot hold at all', () => {
    // **Found live.** A service answering a TCP connect with a binary protocol put NUL bytes in
    // its first response; `jsonb` refuses `\u0000` with SQLSTATE 22P05, the whole batch of
    // fingerprints failed to write, and every other host in that batch was lost with it.
    assert.equal(printable('SSH-2.0\u0000\u0000-OpenSSH'), 'SSH-2.0-OpenSSH');
    assert.equal(printable('\u0000\u0001\u0002'), '');
  });

  it('strips every other control character too', () => {
    assert.equal(printable('hello\u001b[31mworld\u0007'), 'hello[31mworld');
    assert.equal(printable('  spaced  '), 'spaced');
  });

  it('keeps what a banner is actually for', () => {
    assert.equal(printable('SSH-2.0-OpenSSH_9.2p1 Debian-2'), 'SSH-2.0-OpenSSH_9.2p1 Debian-2');
    assert.equal(
      printable('220 mail.example.com ESMTP Postfix'),
      '220 mail.example.com ESMTP Postfix',
    );
  });

  it('bounds what it keeps', () => {
    assert.equal(printable('x'.repeat(500)).length, 200);
  });
});

describe('serverHeaderOf', () => {
  it('reads a header whose value contains colons', () => {
    // Splitting on every colon reports `nginx` for one of these and the whole string for the
    // other — the same field read two different ways.
    assert.equal(
      serverHeaderOf('HTTP/1.1 200 OK\r\nServer: Apache/2.4 (Unix) mod_ssl/2.4 OpenSSL/1.1\r\n'),
      'Apache/2.4 (Unix) mod_ssl/2.4 OpenSSL/1.1',
    );
    assert.equal(serverHeaderOf('HTTP/1.1 200 OK\r\nServer: nginx: custom\r\n'), 'nginx: custom');
  });

  it('is not fooled by a header that merely ends in "server"', () => {
    assert.equal(serverHeaderOf('HTTP/1.1 200 OK\r\nX-Powered-By-Server: thing\r\n'), null);
  });

  it('answers null when there is no header, or it is empty', () => {
    assert.equal(serverHeaderOf('HTTP/1.1 200 OK\r\nDate: now\r\n'), null);
    assert.equal(serverHeaderOf('HTTP/1.1 200 OK\r\nServer:  \r\n'), null);
    assert.equal(serverHeaderOf(''), null);
  });

  it('matches the header name case-insensitively, as HTTP is', () => {
    assert.equal(serverHeaderOf('HTTP/1.1 200 OK\r\nSERVER: lighttpd\r\n'), 'lighttpd');
  });
});

describe('the TCP probe, against a real socket', () => {
  let banner: Server;
  let silentPort: Server;
  let bannerPort = 0;
  let quietPort = 0;

  before(async () => {
    // A server that greets on connect, the way SSH and SMTP do.
    banner = createServer((socket) => {
      socket.write('SSH-2.0-OpenSSH_9.2p1 Debian-2\r\n');
    });
    // And one that says nothing at all, which is most of them.
    silentPort = createServer(() => undefined);
    await Promise.all(
      [banner, silentPort].map(
        (server) =>
          new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', () => {
              resolve();
            });
          }),
      ),
    );
    const a = banner.address();
    const b = silentPort.address();
    bannerPort = typeof a === 'object' && a !== null ? a.port : 0;
    quietPort = typeof b === 'object' && b !== null ? b.port : 0;
  });

  after(async () => {
    await Promise.all(
      [banner, silentPort].map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
  });

  it('reads a banner without ever sending one', async () => {
    // Nothing is sent, deliberately: a probe that spoke first would be guessing at a protocol,
    // and guessing wrong on a serial-console server or a printer is how a discovery run reboots
    // something.
    const found = await identify(
      '127.0.0.1',
      { timeoutMs: 2_000, community: '', ports: [bannerPort] },
      { reverseLookup: () => Promise.resolve(null), snmpSystem: () => Promise.resolve(null) },
    );
    const port: OpenPort | undefined = found.ports[0];
    assert.ok(port !== undefined, 'the listening port should have been found');
    assert.equal(port.port, bannerPort);
    assert.match(port.banner ?? '', /OpenSSH_9\.2p1/);
  });

  it('reports an open port that volunteers nothing', async () => {
    const found = await identify(
      '127.0.0.1',
      { timeoutMs: 2_000, community: '', ports: [quietPort] },
      { reverseLookup: () => Promise.resolve(null), snmpSystem: () => Promise.resolve(null) },
    );
    assert.equal(found.ports.length, 1);
    assert.equal(found.ports[0]?.banner, undefined);
  });

  it('reports a closed port as closed rather than as an error', async () => {
    const found = await identify(
      '127.0.0.1',
      // Port 1 is reserved and nothing listens there; a refused connection is the ordinary case.
      { timeoutMs: 2_000, community: '', ports: [1] },
      { reverseLookup: () => Promise.resolve(null), snmpSystem: () => Promise.resolve(null) },
    );
    assert.deepEqual(found.ports, []);
    assert.equal(found.kind, 'unknown');
  });
});

describe('the identification pass', () => {
  const JOB: IdentifyJob = {
    runId: 1,
    addresses: ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'],
    cursor: 0,
    timeoutMs: 500,
    concurrency: 2,
    community: 'public',
  };

  interface Harness {
    runner: IdentifyRunner;
    progress: { cursor: number; found: Fingerprint[] }[];
    finished: { ending: SweepEnding; cursor: number; message: string }[];
    asked: string[];
    queue: { depth: number };
    done: Promise<void>;
  }

  function harness(over: Partial<ConstructorParameters<typeof IdentifyRunner>[0]> = {}): Harness {
    const progress: Harness['progress'] = [];
    const finished: Harness['finished'] = [];
    const asked: string[] = [];
    const queue = { depth: 0 };
    let settle: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const runner = new IdentifyRunner({
      logger: silent,
      sources: {
        reverseLookup: (address) => {
          asked.push(address);
          return Promise.resolve(`host-${address.split('.')[3] ?? ''}.example.com`);
        },
        snmpSystem: () => Promise.resolve(null),
        tcpProbe: () => Promise.resolve(null),
        httpServer: () => Promise.resolve(null),
      },
      queueDepth: () => queue.depth,
      onProgress: (_runId, cursor, found) => {
        progress.push({ cursor, found });
      },
      onFinished: (_runId, ending, cursor, message) => {
        finished.push({ ending, cursor, message });
        settle();
      },
      sleep: () =>
        new Promise<void>((resolve) => {
          setImmediate(resolve);
        }),
      ...over,
    });
    return { runner, progress, finished, asked, queue, done };
  }

  const ended = (h: Harness) => {
    const one = h.finished[0];
    assert.ok(one !== undefined, 'the pass should have finished');
    return one;
  };

  it('identifies every host once and reports them', async () => {
    const h = harness();
    h.runner.start(JOB);
    await h.done;
    assert.equal(h.asked.length, 4);
    assert.equal(new Set(h.asked).size, 4);
    assert.equal(ended(h).ending, 'done');
    assert.equal(ended(h).cursor, 4);
    assert.equal(h.progress.flatMap((one) => one.found).length, 4);
  });

  it('resumes from a cursor', async () => {
    const h = harness();
    h.runner.start({ ...JOB, cursor: 2 });
    await h.done;
    assert.deepEqual(h.asked, ['10.0.0.3', '10.0.0.4']);
  });

  it('stands down while a check is queued', async () => {
    // The same rule the sweep follows, and it matters more here: a host costs a dozen sockets.
    const h = harness();
    h.queue.depth = 2;
    h.runner.start(JOB);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.asked.length, 0);
    h.queue.depth = 0;
    await h.done;
    assert.equal(h.asked.length, 4);
    assert.ok(h.runner.stats().yieldedMs >= 0);
  });

  it('never has more hosts in flight than it was told', async () => {
    let inFlight = 0;
    let peak = 0;
    const h = harness({
      sources: {
        reverseLookup: async (address) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise<void>((resolve) => setImmediate(resolve));
          inFlight -= 1;
          return address;
        },
        snmpSystem: () => Promise.resolve(null),
        tcpProbe: () => Promise.resolve(null),
        httpServer: () => Promise.resolve(null),
      },
    });
    h.runner.start({ ...JOB, concurrency: 2 });
    await h.done;
    assert.ok(peak <= 2, `peak was ${String(peak)}`);
  });

  it('cancels within one host-timeout, and keeps what it had already identified', async () => {
    // The sources take no AbortSignal — each carries its own deadline — so a cancel waits out
    // whatever is in flight and no longer. That bound is the reason it is acceptable: a second
    // or two, rather than the timeout times the whole remaining list.
    const h = harness({
      sources: {
        reverseLookup: (address, timeoutMs) =>
          new Promise<string | null>((resolve) => {
            setTimeout(() => {
              resolve(address);
            }, timeoutMs);
          }),
        snmpSystem: () => Promise.resolve(null),
        tcpProbe: () => Promise.resolve(null),
        httpServer: () => Promise.resolve(null),
      },
    });
    const startedAt = Date.now();
    h.runner.start({ ...JOB, addresses: ['10.0.0.1', '10.0.0.2'], concurrency: 1, timeoutMs: 200 });
    await new Promise((resolve) => setImmediate(resolve));
    h.runner.cancel(1);
    await h.done;

    assert.equal(ended(h).ending, 'cancelled');
    assert.ok(Date.now() - startedAt < 2_000, 'and it did not wait out the rest of the list');
    // The host already in flight when the cancel arrived is still reported: it was identified,
    // and dropping it would mean asking again on the next run.
    assert.equal(h.progress.flatMap((one) => one.found).length, 1);
  });

  it('supersedes rather than doubling when the same run is started twice', async () => {
    const h = harness();
    h.runner.start(JOB);
    h.runner.start({ ...JOB, cursor: 3 });
    await h.done;
    const endings = h.finished.map((one) => one.ending);
    assert.ok(endings.includes('superseded'), endings.join(', '));
  });

  it('answers a cancel for a pass it is not running', () => {
    const h = harness();
    h.runner.cancel(99);
    assert.equal(ended(h).ending, 'cancelled');
  });

  it('reports progress during a long pass, not only at its end', async () => {
    const h = harness({ progressIntervalMs: 0 });
    h.runner.start(JOB);
    await h.done;
    assert.ok(h.progress.length > 1, `progress arrived ${String(h.progress.length)} times`);
  });
});
