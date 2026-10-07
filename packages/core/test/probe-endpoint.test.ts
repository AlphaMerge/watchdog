import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTcpServer, Socket } from 'node:net';
import { connect, type TLSSocket } from 'node:tls';
import { before, describe, it } from 'node:test';
import { pino } from 'pino';
import {
  encodeFrame,
  FrameDecoder,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type CoreConfig,
  parseCoreToProbe,
  serverIdentity,
  type CoreToProbeMessage,
  type ProbeToCoreMessage,
  type SensorAssignment,
} from '@ms/shared';
import {
  ProbeEndpoint,
  reportShape,
  type ProbeQuerySink,
  type ResultReceiver,
} from '../src/transport/probe-endpoint.js';
import { HostAllowList } from '../src/api/hardening.js';
import { fingerprint, type ProbeAssignments } from '../src/probes/config.js';
import { within } from './support/within.js';

const silentLogger = pino({ level: 'silent' });

/**
 * Real certificates against a real TLS server. Mocking the transport here would test the mock:
 * mutual TLS, certificate rejection and framing over a socket are exactly what F-09 delivers.
 */
function generateCerts(dir: string): void {
  const run = (args: string[]): void => {
    execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  };

  run([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-days',
    '2',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.crt',
    '-subj',
    '/CN=test-ca',
  ]);

  const issue = (name: string, cn: string, san: string | null): void => {
    run([
      'req',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.csr`,
      '-subj',
      `/CN=${cn}`,
    ]);
    // `openssl x509 -req` takes extensions from a file; -addext belongs to `req`.
    const extArgs: string[] = [];
    if (san !== null) {
      writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\n`, 'utf8');
      extArgs.push('-extfile', `${name}.ext`);
    }
    run([
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      'ca.crt',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      `${name}.crt`,
      '-days',
      '2',
      '-sha256',
      ...extArgs,
    ]);
  };

  // `ms-core.unlisted.example`: a name the core's API has not been told it answers to (`A-47`).
  issue('core', 'ms-core', 'DNS:localhost,DNS:ms-core.unlisted.example,IP:127.0.0.1');
  // A core that probes reach by its IPv6 address (`A-67`).
  issue('core-v6', 'ms-core', 'IP:::1');
  issue('probe', 'ms-probe', null);
  // A second CA, to prove an untrusted client certificate is refused.
  run([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-days',
    '2',
    '-nodes',
    '-keyout',
    'rogue-ca.key',
    '-out',
    'rogue-ca.crt',
    '-subj',
    '/CN=rogue-ca',
  ]);
  run([
    'req',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-keyout',
    'rogue.key',
    '-out',
    'rogue.csr',
    '-subj',
    '/CN=rogue-probe',
  ]);
  run([
    'x509',
    '-req',
    '-in',
    'rogue.csr',
    '-CA',
    'rogue-ca.crt',
    '-CAkey',
    'rogue-ca.key',
    '-CAcreateserial',
    '-out',
    'rogue.crt',
    '-days',
    '2',
    '-sha256',
  ]);
}

function endpointConfig(dir: string, overrides: Partial<CoreConfig['probeEndpoint']> = {}) {
  return {
    host: '127.0.0.1',
    port: 0,
    tls: {
      certFile: join(dir, 'core.crt'),
      keyFile: join(dir, 'core.key'),
      caFile: join(dir, 'ca.crt'),
    },
    accessKeys: [],
    handshakeTimeoutMs: 2_000,
    heartbeatIntervalMs: 1_000,
    ...overrides,
  } satisfies CoreConfig['probeEndpoint'];
}

/** A minimal probe: enough to drive the endpoint without pulling in the whole CoreClient. */
class TestProbe {
  readonly received: CoreToProbeMessage[] = [];
  readonly #socket: TLSSocket;
  readonly #decoder = new FrameDecoder();
  #onMessage: (() => void) | undefined;

  private constructor(socket: TLSSocket) {
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => {
      for (const value of this.#decoder.push(chunk)) {
        // **Through the real parser, not a cast** (`R18`). A cast accepts anything the core
        // sends; the probe runs `parseCoreToProbe`, whose schemas are `additionalProperties:
        // false`, and closes the connection on a protocol violation. Adding a field to the
        // TypeScript union and not to the schema therefore passed every test here and wedged the
        // dev stack on the first real handshake — the probe refused every configuration message,
        // reconnected, refused it again. Parsing here makes this fake probe as strict as the one
        // it stands in for.
        this.received.push(parseCoreToProbe(value));
        this.#onMessage?.();
      }
    });
    socket.on('error', () => undefined);
  }

  static async connect(
    dir: string,
    port: number,
    certName = 'probe',
    options: { wedged?: boolean; servername?: string; address?: string } = {},
  ): Promise<TestProbe> {
    // **By address, as the probe's own client connects** (`A-67`): the host, no server name,
    // and the identity check that client passes. Everything else here dials 127.0.0.1 and asks
    // for `localhost`, which is a different certificate check from the one a probe configured
    // with an address makes.
    if (options.address !== undefined) {
      const byAddress = connect({
        host: options.address,
        port,
        cert: await readIfPresent(join(dir, `${certName}.crt`)),
        key: await readIfPresent(join(dir, `${certName}.key`)),
        ca: await readIfPresent(join(dir, 'ca.crt')),
        rejectUnauthorized: true,
        checkServerIdentity: serverIdentity,
        minVersion: 'TLSv1.2',
      });
      await new Promise<void>((resolve, reject) => {
        byAddress.once('secureConnect', resolve);
        byAddress.once('error', reject);
      });
      return new TestProbe(byAddress);
    }
    // A wedged peer is one that never answers our FIN. `allowHalfOpen` is a `net.Socket` option
    // rather than a TLS one, so the socket is built first and handed to `connect` — which is also
    // the only honest way to model a probe that has stopped reading (`P-67`).
    const underlying =
      options.wedged === true
        ? new Socket({ allowHalfOpen: true }).connect(port, '127.0.0.1')
        : undefined;
    const socket = connect({
      ...(underlying === undefined ? { host: '127.0.0.1', port } : { socket: underlying }),
      cert: await readIfPresent(join(dir, `${certName}.crt`)),
      key: await readIfPresent(join(dir, `${certName}.key`)),
      ca: await readIfPresent(join(dir, 'ca.crt')),
      servername: options.servername ?? 'localhost',
      rejectUnauthorized: true,
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    });

    return new TestProbe(socket);
  }

  send(message: ProbeToCoreMessage): void {
    this.#socket.write(encodeFrame(message));
  }

  /** Resolves when a message satisfying the predicate arrives, or rejects on timeout. */
  async waitFor(
    predicate: (message: CoreToProbeMessage) => boolean,
    timeoutMs = 3_000,
  ): Promise<CoreToProbeMessage> {
    const existing = this.received.find(predicate);
    if (existing !== undefined) return existing;

    return new Promise<CoreToProbeMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#onMessage = undefined;
        reject(new Error(`timed out waiting for a message; saw ${JSON.stringify(this.received)}`));
      }, timeoutMs);

      this.#onMessage = () => {
        const match = this.received.find(predicate);
        if (match !== undefined) {
          clearTimeout(timer);
          this.#onMessage = undefined;
          resolve(match);
        }
      };
    });
  }

  async waitForClose(timeoutMs = 3_000): Promise<void> {
    if (this.#socket.destroyed) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('socket did not close'));
      }, timeoutMs);
      this.#socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close(): void {
    this.#socket.destroy();
  }
}

async function readIfPresent(path: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path);
}

const hello = (overrides: Partial<Extract<ProbeToCoreMessage, { type: 'hello' }>> = {}) =>
  ({
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    gid: '',
    displayName: 'Test probe',
    agentVersion: '0.1.0',
    accessKey: '',
    ...overrides,
  }) satisfies ProbeToCoreMessage;

const opensslAvailable = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

/** Whether `::1` can be listened on here. Asked once, with a bound, before the cases are declared. */
const v6 = await new Promise<boolean>((resolve) => {
  const server = createTcpServer();
  const timer = setTimeout(() => {
    server.close();
    resolve(false);
  }, 2_000);
  server.once('error', () => {
    clearTimeout(timer);
    resolve(false);
  });
  server.listen(0, '::1', () => {
    clearTimeout(timer);
    server.close(() => {
      resolve(true);
    });
  });
});

describe('ProbeEndpoint', { skip: opensslAvailable ? false : 'openssl is not available' }, () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ms-tls-'));
    generateCerts(dir);
    assert.ok(existsSync(join(dir, 'core.crt')));
  });

  it('completes the handshake and assigns an identity to a new probe', async () => {
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir),
      logger: silentLogger,
      coreVersion: '9.9.9',
    });
    const address = await endpoint.start();

    try {
      const probe = await TestProbe.connect(dir, address.port);
      probe.send(hello());

      const welcome = await probe.waitFor((m) => m.type === 'welcome');
      assert.equal(welcome.type, 'welcome');
      assert.equal(welcome.protocolVersion, PROTOCOL_VERSION);
      assert.equal(welcome.coreVersion, '9.9.9');
      assert.notEqual(welcome.gid, '', 'a probe with no identity is issued one');

      assert.equal(endpoint.connectedProbes.length, 1);
      assert.equal(endpoint.connectedProbes[0]?.displayName, 'Test probe');

      probe.close();
    } finally {
      await endpoint.stop();
    }
  });

  it('welcomes a probe that dialled the core by a name its API does not answer to (A-47)', async () => {
    // The Host allow-list is the API listener's. A probe speaks TLS here, with no `Host` to
    // check, and a probe configured with the core's name must go on connecting whatever the API's
    // `allowedHosts` says — the name below is one it would refuse.
    const name = 'ms-core.unlisted.example';
    assert.equal(new HostAllowList({}).allows(`${name}:8080`), false);
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir),
      logger: silentLogger,
      coreVersion: '9.9.9',
    });
    const address = await endpoint.start();
    try {
      const probe = await TestProbe.connect(dir, address.port, 'probe', { servername: name });
      probe.send(hello());
      const welcome = await probe.waitFor((m) => m.type === 'welcome');
      assert.equal(welcome.type, 'welcome');
      assert.equal(endpoint.connectedProbes.length, 1);
      probe.close();
    } finally {
      await endpoint.stop();
    }
  });

  it(
    'accepts a probe that dialled it at ::1, under a certificate that lists ::1 (A-67)',
    { skip: v6 ? false : 'this machine has no IPv6 loopback (::1) to listen on' },
    async () => {
      // The core's half of a core given to its probes by IPv6 address: it listens there, the
      // probe's check of who it is passes on a certificate that lists the address, and the
      // probe's own certificate is judged as it always was — by this endpoint's CA.
      const v6Tls = {
        certFile: join(dir, 'core-v6.crt'),
        keyFile: join(dir, 'core-v6.key'),
        caFile: join(dir, 'ca.crt'),
      };
      const endpoint = new ProbeEndpoint({
        config: endpointConfig(dir, { host: '::1', tls: v6Tls }),
        logger: silentLogger,
        coreVersion: '9.9.9',
      });
      const address = await endpoint.start();
      try {
        const probe = await TestProbe.connect(dir, address.port, 'probe', { address: '::1' });
        probe.send(hello());
        const welcome = await probe.waitFor((m) => m.type === 'welcome');
        assert.equal(welcome.type, 'welcome');
        assert.equal(endpoint.connectedProbes.length, 1);
        assert.equal(endpoint.remoteAddressOf(welcome.gid), '::1');
        probe.close();

        // A certificate no CA of this endpoint signed is refused at ::1 as anywhere: by the
        // endpoint's own rule, which who the *core* is has no part in. Under TLS 1.3 the client
        // can reach 'secureConnect' before it is judged, so what is asserted is no welcome.
        let rogue: TestProbe | undefined;
        try {
          rogue = await TestProbe.connect(dir, address.port, 'rogue', { address: '::1' });
        } catch {
          // Refused during the handshake, which is also correct.
        }
        if (rogue !== undefined) {
          rogue.send(hello());
          await rogue.waitForClose();
          assert.deepEqual(rogue.received, [], 'an unknown CA’s certificate was answered');
        }
      } finally {
        await endpoint.stop();
      }
    },
  );

  it(
    'is refused by a probe that dialled it at ::1 when its certificate does not list ::1 (A-67)',
    { skip: v6 ? false : 'this machine has no IPv6 loopback (::1) to listen on' },
    async () => {
      // The ordinary certificate: `localhost` and 127.0.0.1. Trusted, and for somewhere else.
      const endpoint = new ProbeEndpoint({
        config: endpointConfig(dir, { host: '::1' }),
        logger: silentLogger,
        coreVersion: '9.9.9',
      });
      const address = await endpoint.start();
      try {
        await assert.rejects(
          TestProbe.connect(dir, address.port, 'probe', { address: '::1' }),
          /IP: ::1 is not in the cert's list/,
        );
        assert.equal(endpoint.connectedProbes.length, 0);
      } finally {
        await endpoint.stop();
      }
    },
  );

  it('answers heartbeats and records the last one seen', async () => {
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir),
      logger: silentLogger,
      coreVersion: '0.1.0',
    });
    const address = await endpoint.start();

    try {
      const probe = await TestProbe.connect(dir, address.port);
      probe.send(hello({ gid: 'probe-a' }));
      await probe.waitFor((m) => m.type === 'welcome');

      probe.send({ type: 'heartbeat', seq: 1, sentAt: new Date().toISOString() });
      const ack = await probe.waitFor((m) => m.type === 'heartbeat-ack');

      assert.equal(ack.type === 'heartbeat-ack' ? ack.seq : -1, 1);
      assert.notEqual(endpoint.connectedProbes[0]?.lastHeartbeatAt, null);

      probe.close();
    } finally {
      await endpoint.stop();
    }
  });

  it('rejects a probe below the protocol floor, which is the only version that is refused', async () => {
    // **`P-178` narrowed this to the floor.** It used to refuse a probe *above* this build too,
    // on the reasoning that the newer end knows messages this one has never seen — which made
    // every `PROTOCOL_VERSION` bump a lockstep fleet upgrade, with the un-upgraded end
    // reconnecting for ever. Every feature is capability-gated on the negotiated version now, so
    // a newer peer is served what this build speaks. Below `MIN_PROTOCOL_VERSION` there is no
    // shared language to negotiate down to, and that is still a refusal.
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir),
      logger: silentLogger,
      coreVersion: '0.1.0',
    });
    const address = await endpoint.start();

    try {
      const probe = await TestProbe.connect(dir, address.port);
      probe.send(hello({ protocolVersion: MIN_PROTOCOL_VERSION - 1 }));

      const reject = await probe.waitFor((m) => m.type === 'reject');
      assert.equal(reject.type === 'reject' ? reject.code : '', 'protocol-version');
      assert.equal(endpoint.connectedProbes.length, 0);
    } finally {
      await endpoint.stop();
    }
  });

  it('rejects a wrong access key when keys are configured', async () => {
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir, { accessKeys: ['correct-horse'] }),
      logger: silentLogger,
      coreVersion: '0.1.0',
    });
    const address = await endpoint.start();

    try {
      const probe = await TestProbe.connect(dir, address.port);
      probe.send(hello({ accessKey: 'battery-staple' }));

      const reject = await probe.waitFor((m) => m.type === 'reject');
      assert.equal(reject.type === 'reject' ? reject.code : '', 'bad-access-key');

      const accepted = await TestProbe.connect(dir, address.port);
      accepted.send(hello({ accessKey: 'correct-horse' }));
      await accepted.waitFor((m) => m.type === 'welcome');
      accepted.close();
    } finally {
      await endpoint.stop();
    }
  });

  it('refuses a client certificate this core does not trust', async () => {
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir),
      logger: silentLogger,
      coreVersion: '0.1.0',
    });
    const address = await endpoint.start();

    try {
      // Under TLS 1.3 the client's certificate travels after the server's Finished, so the
      // client reaches 'secureConnect' before the server has judged it. The guarantee that
      // matters is the one on this side: no session is ever established, and the peer is cut.
      let probe: TestProbe | undefined;
      try {
        probe = await TestProbe.connect(dir, address.port, 'rogue');
      } catch {
        // TLS 1.2, or an early alert — rejected during the handshake, which is also correct.
      }

      if (probe !== undefined) {
        probe.send(hello());
        await probe.waitForClose();
      }

      assert.equal(
        endpoint.connectedProbes.length,
        0,
        'a certificate signed by an unknown CA must never yield a session',
      );
    } finally {
      await endpoint.stop();
    }
  });

  it('disconnects a peer that never says hello', async () => {
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir, { handshakeTimeoutMs: 200 }),
      logger: silentLogger,
      coreVersion: '0.1.0',
    });
    const address = await endpoint.start();

    try {
      const probe = await TestProbe.connect(dir, address.port);
      await probe.waitForClose();
      assert.equal(endpoint.connectedProbes.length, 0);
    } finally {
      await endpoint.stop();
    }
  });

  it('drops a peer that sends a message before the handshake', async () => {
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir),
      logger: silentLogger,
      coreVersion: '0.1.0',
    });
    const address = await endpoint.start();

    try {
      const probe = await TestProbe.connect(dir, address.port);
      probe.send({ type: 'heartbeat', seq: 1, sentAt: new Date().toISOString() });
      await probe.waitForClose();
      assert.equal(endpoint.connectedProbes.length, 0);
    } finally {
      await endpoint.stop();
    }
  });

  it('replaces a stale session when the same probe reconnects', async () => {
    // **The idle timer must not be able to pass this test** (`P-65`). It used to: the default
    // config makes the idle timeout three heartbeats — exactly the 3,000 ms `waitForClose` waits
    // — so the old socket died of idleness at the same instant the test gave up, and which of the
    // two won was luck. It lost about one run in six. Worse, it was never observing a replacement
    // at all: the log said `connection idle, closing`, never `replacing an existing session`,
    // because this endpoint is built without a registry and that branch had no replacement in it.
    //
    // A heartbeat interval of 30 s puts the idle timeout at 90 s, so nothing but the replacement
    // can close `first` inside the second below.
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir, { heartbeatIntervalMs: 30_000 }),
      logger: silentLogger,
      coreVersion: '0.1.0',
    });
    const address = await endpoint.start();

    try {
      const first = await TestProbe.connect(dir, address.port);
      first.send(hello({ gid: 'probe-b' }));
      await first.waitFor((m) => m.type === 'welcome');

      const second = await TestProbe.connect(dir, address.port);
      second.send(hello({ gid: 'probe-b' }));
      await second.waitFor((m) => m.type === 'welcome');

      const startedAt = process.hrtime.bigint();
      await first.waitForClose(1_000);
      const closedAfterMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      assert.ok(
        closedAfterMs < 500,
        `the supersede must close the old socket at once, took ${closedAfterMs.toFixed(0)} ms`,
      );
      assert.equal(endpoint.connectedProbes.length, 1, 'a reconnect must not leave two sessions');

      second.close();
    } finally {
      await endpoint.stop();
    }
  });

  it('tells the configuration source what the probe advertised, and whether a build is still for the probe’s session (A-72)', async () => {
    // A build is chained behind its session's other work, so one for a session superseded
    // meanwhile can end after its successor's. The source records nothing for a build whose
    // session is not live, and this is where it learns which that is: here the first session's
    // build is held until the second's has been asked and answered.
    const calls: {
      peerVersion: number | undefined;
      building: { readonly advertisedVersion: number; readonly live: () => boolean } | undefined;
    }[] = [];
    const asked: (() => void)[] = [];
    const askedTwice = [0, 1].map(
      (index) =>
        new Promise<void>((resolve) => {
          asked[index] = resolve;
        }),
    );
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir, { heartbeatIntervalMs: 30_000 }),
      logger: silentLogger,
      coreVersion: '9.9.9',
      probeConfig: {
        probeObjectFor: () => Promise.resolve(7),
        assignmentsFor: async (_probeObjectId, peerVersion, building) => {
          calls.push({ peerVersion, building });
          asked[calls.length - 1]?.();
          if (calls.length === 1) await firstHeld;
          return { version: 'v1', sensors: [], stamps: new Map<number, string>() };
        },
        touch: () => Promise.resolve(),
      },
    });
    /** The `index`th build the source was asked for, and who it was told it is for. */
    const call = (
      index: number,
    ): {
      peerVersion: number | undefined;
      building: { readonly advertisedVersion: number; readonly live: () => boolean };
    } => {
      const one = calls.at(index);
      if (one?.building === undefined) return assert.fail(`build ${String(index)} said nothing`);
      return { peerVersion: one.peerVersion, building: one.building };
    };
    const address = await endpoint.start();
    try {
      // An older probe: negotiated and advertised are the same.
      const first = await TestProbe.connect(dir, address.port);
      first.send(hello({ gid: 'probe-a72', protocolVersion: PROTOCOL_VERSION - 1 }));
      await within(2_000, 'the first session’s build', askedTwice[0] ?? assert.fail());
      assert.equal(call(0).peerVersion, PROTOCOL_VERSION - 1);
      assert.equal(call(0).building.advertisedVersion, PROTOCOL_VERSION - 1);
      assert.equal(call(0).building.live(), true);

      // A newer one under the same identity: negotiated down to the core's, advertised as said.
      const second = await TestProbe.connect(dir, address.port);
      second.send(hello({ gid: 'probe-a72', protocolVersion: PROTOCOL_VERSION + 1 }));
      await within(2_000, 'the second session’s build', askedTwice[1] ?? assert.fail());
      assert.equal(call(1).peerVersion, PROTOCOL_VERSION);
      assert.equal(call(1).building.advertisedVersion, PROTOCOL_VERSION + 1);
      assert.equal(call(1).building.live(), true);
      assert.equal(call(0).building.live(), false, 'the superseded session’s build is not live');

      releaseFirst();
      await within(2_000, 'the superseded socket to close', first.waitForClose(1_000));
      assert.equal(call(0).building.live(), false);
      assert.equal(call(1).building.live(), true, 'and does not unseat its successor');

      second.close();
      // The core sees the close a moment later; two seconds at most.
      for (let tries = 0; tries < 100 && call(1).building.live(); tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(call(1).building.live(), false, 'a closed session is not live either');
    } finally {
      releaseFirst();
      await endpoint.stop();
    }
  });

  it('does not install a session whose socket died while it was being admitted', async () => {
    // **`P-80`, and the whole registry path was uncovered — every other test here drives the
    // registry-less branch.** `admit` is three database round trips, and
    // `MessageConnection.destroy` runs `onClose` synchronously, so a socket that dies mid-admit
    // fires `#handleClose` while `probeObjectId` is still null and the session is not yet in
    // `#sessions`: it removes nothing and tells reachability nothing. Installing the dead session
    // afterwards left it reported `connected: true` for ever, with `found()` putting its sensors
    // back to Up for a probe with no socket, and `#handleClose` never running again for it —
    // `R-05`'s one promise broken permanently for that probe.
    let release: (() => void) | undefined;
    const admitted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const found: number[] = [];
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir),
      logger: silentLogger,
      coreVersion: '9.9.9',
      probeConfig: {
        probeObjectFor: () => Promise.resolve(7),
        assignmentsFor: () =>
          Promise.resolve({ version: 'v1', sensors: [], stamps: new Map<number, string>() }),
        touch: () => Promise.resolve(),
      },
      registry: {
        admit: async () => {
          await admitted;
          return { kind: 'approved' as const, gid: 'probe-gid', objectId: 7 };
        },
      },
      reachability: {
        found: (id: number) => {
          found.push(id);
          return Promise.resolve(1);
        },
        lost: () => Promise.resolve(0),
      },
    });
    const address = await endpoint.start();
    try {
      const probe = await TestProbe.connect(dir, address.port);
      probe.send(hello({ gid: 'probe-gid' }));
      // The socket goes while `admit` is still in flight, then the decision lands.
      await new Promise((resolve) => setTimeout(resolve, 50));
      probe.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      release?.();
      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.equal(endpoint.linkFor(7).connected, false, 'a dead socket is not a connected probe');
      assert.deepEqual(found, [], 'and its sensors were not declared healthy on its behalf');
    } finally {
      await endpoint.stop();
    }
  });

  it('lets a decision reach a probe that connected before anybody made one', async () => {
    // **`P-189`.** `session.approved` is fixed at admission and `#sessions` holds approved
    // sessions only, so a probe that connected while pending was a live socket nothing pointed
    // at: approving it wrote two rows, logged, and told that connection nothing. The probe sat
    // there scanning nothing until something else made it reconnect — which on a fresh install
    // is the very first thing an operator does.
    //
    // The endpoint closes it instead, and the probe comes back on its own retry through the
    // handshake that issues both its key and its configuration. What is asserted here is only
    // that the connection can be found and closed; that a reconnect then scans is the ordinary
    // approved path every other test in this file drives.
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir),
      logger: silentLogger,
      coreVersion: '9.9.9',
      probeConfig: {
        probeObjectFor: () => Promise.resolve(null),
        assignmentsFor: () =>
          Promise.resolve({ version: 'v1', sensors: [], stamps: new Map<number, string>() }),
        touch: () => Promise.resolve(),
      },
      registry: { admit: () => Promise.resolve({ kind: 'pending' as const, gid: 'waiting' }) },
    });
    const address = await endpoint.start();
    try {
      const probe = await TestProbe.connect(dir, address.port);
      probe.send(hello({ gid: 'waiting' }));
      await probe.waitFor((m) => m.type === 'welcome');
      assert.deepEqual(
        probe.received.filter((m) => m.type.startsWith('config-')),
        [],
        'an unapproved probe is sent nothing, which is what approval is for',
      );

      assert.equal(
        endpoint.disconnect('waiting', 'approved'),
        true,
        'the pending connection is reachable by gid',
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(
        endpoint.disconnect('waiting', 'again'),
        false,
        'and it is not left behind in the index once it has gone',
      );
    } finally {
      await endpoint.stop();
    }
  });

  it('tells a withdrawn probe why, so it stops rather than treating it as a blip', async () => {
    // **The difference from `disconnect`, and the reason both exist.** That one is for approval,
    // where a bare close is right because the reconnect is the mechanism. This is the opposite:
    // a probe that merely loses the core keeps checking and spools to disk, so a bare close
    // would leave a machine somebody just refused probing their network. The `reject` carries
    // the code the probe acts on, and it has to leave the socket before the FIN.
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir),
      logger: silentLogger,
      coreVersion: '9.9.9',
      probeConfig: {
        probeObjectFor: () => Promise.resolve(null),
        assignmentsFor: () =>
          Promise.resolve({ version: 'v1', sensors: [], stamps: new Map<number, string>() }),
        touch: () => Promise.resolve(),
      },
      registry: { admit: () => Promise.resolve({ kind: 'pending' as const, gid: 'waiting' }) },
    });
    const address = await endpoint.start();
    try {
      const probe = await TestProbe.connect(dir, address.port);
      probe.send(hello({ gid: 'waiting' }));
      await probe.waitFor((m) => m.type === 'welcome');

      assert.equal(
        endpoint.withdraw('waiting', 'revoked', 'decommissioned, replaced by web-dc4'),
        true,
      );

      const rejected = await probe.waitFor((m) => m.type === 'reject');
      assert.ok(rejected.type === 'reject');
      assert.equal(rejected.code, 'revoked');
      assert.equal(
        rejected.message,
        'decommissioned, replaced by web-dc4',
        'the operator’s own sentence is what the probe’s journal should carry',
      );
      await probe.waitForClose();
    } finally {
      await endpoint.stop();
    }
  });

  it('answers where a probe is connected from, for the registry to judge', async () => {
    // The registry decides whether an address filter still covers a probe — the same decision
    // the handshake makes — and holds no sockets to ask. `null` has to mean "not connected"
    // rather than an error, because narrowing a filter on a machine that is switched off is the
    // ordinary case. A *pending* session counts: it is exactly the one an operator is looking at.
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir),
      logger: silentLogger,
      coreVersion: '9.9.9',
      registry: { admit: () => Promise.resolve({ kind: 'pending' as const, gid: 'waiting' }) },
    });
    const address = await endpoint.start();
    try {
      const probe = await TestProbe.connect(dir, address.port);
      probe.send(hello({ gid: 'waiting' }));
      await probe.waitFor((m) => m.type === 'welcome');

      assert.equal(endpoint.remoteAddressOf('waiting'), '127.0.0.1');
      assert.equal(endpoint.remoteAddressOf('somewhere-else'), null);
    } finally {
      await endpoint.stop();
    }
  });

  it('says so when a decision is about a probe that is not connected', async () => {
    // Approving a machine that is switched off is an ordinary thing to do, and the registry uses
    // the answer to tell "we closed a connection" from "there was nothing to close".
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir),
      logger: silentLogger,
      coreVersion: '9.9.9',
      probeConfig: {
        probeObjectFor: () => Promise.resolve(null),
        assignmentsFor: () =>
          Promise.resolve({ version: 'v1', sensors: [], stamps: new Map<number, string>() }),
        touch: () => Promise.resolve(),
      },
    });
    await endpoint.start();
    try {
      assert.equal(endpoint.disconnect('nobody-here', 'approved'), false);
    } finally {
      await endpoint.stop();
    }
  });

  it('shuts down while a probe is wedged, rather than waiting for a FIN that never comes', async () => {
    // **`Server.close()` waits for every open connection, and `stop()` only *asks* them to go.**
    // A session is `end()`ed, not destroyed, so a probe that has stopped reading keeps its half
    // of the socket open and the shutdown never completes — a core that has to be SIGKILLed, on
    // exactly the restart most likely to be happening *because* a probe is wedged (`P-67`).
    //
    // This was suspected while fixing `P-65`, tested with an ordinary client, and wrongly written
    // off: an ordinary client answers the FIN automatically, so `stop()` returned at once and the
    // hang looked imaginary. `allowHalfOpen` is what makes the peer actually wedged.
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir, { heartbeatIntervalMs: 30_000 }),
      logger: silentLogger,
      coreVersion: '0.1.0',
    });
    const address = await endpoint.start();
    const probe = await TestProbe.connect(dir, address.port, 'probe', { wedged: true });
    probe.send(hello({ gid: 'probe-wedged' }));
    await probe.waitFor((m) => m.type === 'welcome');

    const startedAt = process.hrtime.bigint();
    const outcome = await Promise.race([
      endpoint.stop().then(() => 'stopped'),
      new Promise((resolve) => {
        setTimeout(() => {
          resolve('still waiting');
        }, 8_000).unref();
      }),
    ]);
    const tookMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    probe.close();

    assert.equal(outcome, 'stopped', `stop() did not finish, took ${tookMs.toFixed(0)} ms`);
    assert.ok(
      tookMs < 5_000,
      `the grace is one second, so this must not approach the idle timeout; took ${tookMs.toFixed(0)} ms`,
    );
  });

  it('shuts down with a socket that never started a TLS handshake', async () => {
    // **The door `P-67` left open** (`P-70`). It tracked sockets at `secureConnection`, so a peer
    // that opens TCP and says nothing is handed to nothing, is in no set, and `server.close()`
    // waits on it for ever — the same hang, through the one connection state the fix skipped.
    // The handshake timer does not save it: that fires on a socket the endpoint knows about.
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir, { heartbeatIntervalMs: 30_000 }),
      logger: silentLogger,
      coreVersion: '0.1.0',
    });
    const address = await endpoint.start();
    const silent = new Socket();
    await new Promise<void>((resolve, reject) => {
      silent.once('connect', resolve);
      silent.once('error', reject);
      silent.connect(address.port, '127.0.0.1');
    });

    const outcome = await Promise.race([
      endpoint.stop().then(() => 'stopped'),
      new Promise((resolve) => {
        setTimeout(() => {
          resolve('still waiting');
        }, 8_000).unref();
      }),
    ]);
    silent.destroy();
    assert.equal(outcome, 'stopped');
  });

  it('acknowledges a results batch', async () => {
    const received: string[] = [];
    const results: ResultReceiver = {
      acceptProbeResults: (origin, message) => {
        received.push(`${origin.gid}/${message.batchId}`);
        return Promise.resolve({
          type: 'results-ack',
          batchId: message.batchId,
          storedSamples: message.results.length,
          retryAfterMs: 0,
        });
      },
    };
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir),
      logger: silentLogger,
      coreVersion: '9.9.9',
      results,
    });
    const address = await endpoint.start();

    try {
      const probe = await TestProbe.connect(dir, address.port);
      probe.send(hello());
      const welcome = await probe.waitFor((m) => m.type === 'welcome');
      assert.equal(welcome.type, 'welcome');
      const gid = welcome.gid;

      probe.send({
        type: 'results',
        batchId: 'batch-1',
        results: [
          {
            sensorId: 42,
            at: '2026-08-20T10:00:00.000Z',
            outcome: 'ok',
            message: '',
            durationMs: 3,
            channels: [{ key: 'rtt', value: 12 }],
          },
        ],
      });

      const ack = await probe.waitFor((m) => m.type === 'results-ack');
      assert.equal(ack.type, 'results-ack');
      assert.equal(ack.batchId, 'batch-1');
      assert.equal(ack.storedSamples, 1);
      assert.deepEqual(received, [`${gid}/batch-1`], 'and ingestion was told which probe sent it');

      probe.close();
    } finally {
      await endpoint.stop();
    }
  });

  it('ages a batch from when it arrived, not from when the probe stamped it', async () => {
    // **The trap `P-74`'s whole design turns on, tested where it can actually fail** (`P-83`).
    //
    // A probe replaying an hour of spool ships results *stamped* an hour ago that *arrive* now.
    // A watchdog keyed off `result.at` stays an hour behind for the whole catch-up and fires
    // hardest on the probe that is recovering correctly — one of the two designs `P-74` rejected.
    //
    // The rule's own test could not see this: `DeliveryFacts` has no field carrying the probe's
    // clock, so no implementation of `verdict` could fail it, and the forty iterations it spent
    // on the case were forty copies of one assertion about a 30 s gap in a 240 s window. The
    // property lives *here*, in the one line that stamps arrival, and nothing pinned it.
    const results: ResultReceiver = {
      acceptProbeResults: (_origin, message) =>
        Promise.resolve({
          type: 'results-ack',
          batchId: message.batchId,
          storedSamples: message.results.length,
          retryAfterMs: 0,
        }),
    };
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir),
      logger: silentLogger,
      coreVersion: '9.9.9',
      results,
      probeConfig: {
        probeObjectFor: () => Promise.resolve(7),
        assignmentsFor: () =>
          Promise.resolve({ version: 'v1', sensors: [], stamps: new Map<number, string>() }),
        touch: () => Promise.resolve(),
      },
    });
    const address = await endpoint.start();

    try {
      const probe = await TestProbe.connect(dir, address.port);
      probe.send(hello());
      await probe.waitFor((m) => m.type === 'welcome');
      await waitUntil(() => endpoint.linkFor(7).connected);

      probe.send({
        type: 'results',
        batchId: 'replay-1',
        results: [
          {
            // An hour before this test runs, which is what a spool replay looks like.
            sensorId: 42,
            at: new Date(Date.now() - 3_600_000).toISOString(),
            outcome: 'ok',
            message: '',
            durationMs: 3,
            channels: [{ key: 'rtt', value: 12 }],
          },
        ],
      });
      await probe.waitFor((m) => m.type === 'results-ack');

      const link = endpoint.linkFor(7);
      assert.ok(link.connected);
      assert.ok(
        link.sinceResultsMs !== null && link.sinceResultsMs < 5_000,
        `the batch landed now, however old its contents: ${String(link.sinceResultsMs)} ms`,
      );
      probe.close();
    } finally {
      await endpoint.stop();
    }
  });

  it('reads the probe clock from what it sends, and a delayed batch cannot make it look behind', async () => {
    // **`P-232`.** Arrival less `sentAt`, the smallest over five minutes: whatever delays a
    // message only ever adds to the reading. A probe an hour behind reads an hour; a batch that
    // sat ninety seconds in a send buffer reads an hour and a half and changes nothing; the clock
    // put right reads right at once. An unreadable `sentAt` is no reading.
    const results: ResultReceiver = {
      acceptProbeResults: (_origin, message) =>
        Promise.resolve({
          type: 'results-ack',
          batchId: message.batchId,
          storedSamples: message.results.length,
          retryAfterMs: 0,
        }),
    };
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir),
      logger: silentLogger,
      coreVersion: '9.9.9',
      results,
      probeConfig: {
        probeObjectFor: () => Promise.resolve(7),
        assignmentsFor: () =>
          Promise.resolve({ version: 'v1', sensors: [], stamps: new Map<number, string>() }),
        touch: () => Promise.resolve(),
      },
    });
    const address = await endpoint.start();
    const offset = (): number | null => {
      const link = endpoint.linkFor(7);
      assert.ok(link.connected);
      return link.clockOffsetMs;
    };
    const HOUR = 3_600_000;
    const near = (actual: number | null, expected: number, what: string): void => {
      assert.ok(
        actual !== null && Math.abs(actual - expected) < 5_000,
        `${what}: ${String(actual)} ms, expected about ${String(expected)}`,
      );
    };

    try {
      const probe = await TestProbe.connect(dir, address.port);
      probe.send(hello());
      await probe.waitFor((m) => m.type === 'welcome');
      await waitUntil(() => endpoint.linkFor(7).connected);
      assert.equal(offset(), null, 'nothing sent yet, so nothing known');

      probe.send({ type: 'heartbeat', seq: 1, sentAt: 'not a time' });
      await probe.waitFor((m) => m.type === 'heartbeat-ack');
      assert.equal(offset(), null, 'an unreadable sentAt is no reading');

      // The first message of a session is usually the spool's first batch, before any heartbeat.
      probe.send({
        type: 'results',
        batchId: 'first',
        sentAt: new Date(Date.now() - HOUR).toISOString(),
        results: [
          {
            sensorId: 42,
            at: new Date(Date.now() - HOUR - 5_000).toISOString(),
            outcome: 'ok',
            message: '',
            durationMs: 3,
            channels: [{ key: 'rtt', value: 12 }],
          },
        ],
      });
      await probe.waitFor((m) => m.type === 'results-ack');
      near(offset(), HOUR, 'a probe an hour behind, from its first batch');

      probe.send({
        type: 'heartbeat',
        seq: 2,
        sentAt: new Date(Date.now() - HOUR - 90_000).toISOString(),
      });
      await probe.waitFor((m) => m.type === 'heartbeat-ack' && m.seq === 2);
      near(offset(), HOUR, 'a message ninety seconds late changes nothing');

      probe.send({ type: 'heartbeat', seq: 3, sentAt: new Date().toISOString() });
      await probe.waitFor((m) => m.type === 'heartbeat-ack' && m.seq === 3);
      near(offset(), 0, 'the clock put right reads right at once');
      probe.close();
    } finally {
      await endpoint.stop();
    }
  });

  it('refuses results when nothing is there to store them', async () => {
    // The transport is usable without ingestion wired up — the handshake tests rely on it — so
    // the probe has to be told, rather than left waiting for an acknowledgement forever.
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir),
      logger: silentLogger,
      coreVersion: '9.9.9',
    });
    const address = await endpoint.start();

    try {
      const probe = await TestProbe.connect(dir, address.port);
      probe.send(hello());
      await probe.waitFor((m) => m.type === 'welcome');
      probe.send({ type: 'results', batchId: 'orphan', results: [] });

      const nack = await probe.waitFor((m) => m.type === 'results-nack');
      assert.equal(nack.type, 'results-nack');
      assert.equal(nack.reason, 'unavailable');
      assert.ok(nack.retryAfterMs > 0, 'and when to try again');

      probe.close();
    } finally {
      await endpoint.stop();
    }
  });

  it('handles a probe\u2019s batches in the order they arrived', async () => {
    // A replaying probe streams its spool oldest-first and trims it by the acknowledgements
    // (R-03). Acknowledging a later batch while an earlier one is still in flight would let it
    // trim past a gap.
    const order: string[] = [];
    const results: ResultReceiver = {
      acceptProbeResults: async (_origin, message) => {
        // The first batch takes its time; without serialisation the second would overtake it.
        await new Promise((resolve) => setTimeout(resolve, message.batchId === 'slow' ? 120 : 0));
        order.push(message.batchId);
        return {
          type: 'results-ack',
          batchId: message.batchId,
          storedSamples: 0,
          retryAfterMs: 0,
        };
      },
    };
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir),
      logger: silentLogger,
      coreVersion: '9.9.9',
      results,
    });
    const address = await endpoint.start();

    try {
      const probe = await TestProbe.connect(dir, address.port);
      probe.send(hello());
      await probe.waitFor((m) => m.type === 'welcome');

      probe.send({ type: 'results', batchId: 'slow', results: [] });
      probe.send({ type: 'results', batchId: 'quick', results: [] });

      await probe.waitFor((m) => m.type === 'results-ack' && m.batchId === 'quick');
      assert.deepEqual(order, ['slow', 'quick']);

      const acks = probe.received.filter((m) => m.type === 'results-ack');
      assert.deepEqual(
        acks.map((m) => m.batchId),
        ['slow', 'quick'],
        'and the acknowledgements went out in the same order',
      );

      probe.close();
    } finally {
      await endpoint.stop();
    }
  });

  it('closes every connection when the endpoint stops', async () => {
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir),
      logger: silentLogger,
      coreVersion: '0.1.0',
    });
    const address = await endpoint.start();
    const probe = await TestProbe.connect(dir, address.port);
    probe.send(hello({ gid: 'probe-c' }));
    await probe.waitFor((m) => m.type === 'welcome');

    await endpoint.stop();

    await probe.waitForClose();
    assert.equal(endpoint.connectedProbes.length, 0);
  });
});

/**
 * The configuration push (R-04), over a real mutual-TLS connection.
 *
 * The source is a stub rather than the database: `probe-config.test.ts` proves the query and the
 * fingerprint against real rows, and what is left to prove here is the conversation — which
 * message a probe gets, and when.
 */
describe(
  'ProbeEndpoint configuration push',
  { skip: opensslAvailable ? false : 'openssl is not available' },
  () => {
    let dir: string;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'ms-tls-cfg-'));
      generateCerts(dir);
    });

    const sensor = (id: number, over: Partial<SensorAssignment> = {}): SensorAssignment => ({
      sensorId: id,
      sensorType: 'icmp.ping',
      params: { count: 4 },
      target: { host: `192.0.2.${String(id)}`, ipVersion: 'auto' },
      intervalSeconds: 60,
      timeoutMs: 30_000,
      ...over,
    });

    /** A source whose answer the test can change between pushes. */
    class StubSource {
      claimed: number | null = 7;
      sensors: SensorAssignment[] = [];
      /** Credential rotation stamps, so a test can rotate one without touching a sensor. */
      stamps = new Map<number, string>();
      touched: number[] = [];
      /** Recomputes served, so a test can wait on a push having been *processed*. */
      recomputes = 0;

      probeObjectFor(): Promise<number | null> {
        return Promise.resolve(this.claimed);
      }
      assignmentsFor(): Promise<ProbeAssignments> {
        this.recomputes += 1;
        return Promise.resolve({
          version: fingerprint(this.sensors, this.stamps),
          sensors: [...this.sensors],
          stamps: new Map(this.stamps),
        });
      }
      /** `P-80`: a rejection here used to cost the probe its `found()` for the whole session. */
      touchFails = false;
      touch(objectId: number): Promise<void> {
        this.touched.push(objectId);
        return this.touchFails
          ? Promise.reject(new Error('deadlock on probe_config'))
          : Promise.resolve();
      }
    }

    async function withProbe(
      source: StubSource,
      body: (probe: TestProbe, endpoint: ProbeEndpoint) => Promise<void>,
      helloOverrides: Partial<Extract<ProbeToCoreMessage, { type: 'hello' }>> = {},
      queries?: ProbeQuerySink,
      reachability?: { found: (id: number) => Promise<number>; lost: () => Promise<number> },
    ): Promise<void> {
      const endpoint = new ProbeEndpoint({
        config: endpointConfig(dir),
        logger: silentLogger,
        coreVersion: '9.9.9',
        probeConfig: source,
        ...(queries === undefined ? {} : { queries }),
        ...(reachability === undefined ? {} : { reachability }),
      });
      const address = await endpoint.start();
      try {
        const probe = await TestProbe.connect(dir, address.port);
        probe.send(hello(helloOverrides));
        await probe.waitFor((m) => m.type === 'welcome');
        await body(probe, endpoint);
        probe.close();
      } finally {
        await endpoint.stop();
      }
    }

    it('sends the whole assignment set on connect', async () => {
      const source = new StubSource();
      source.sensors = [sensor(1), sensor(2)];

      await withProbe(source, async (probe) => {
        const message = await probe.waitFor((m) => m.type === 'config-set');
        assert.ok(message.type === 'config-set');
        assert.deepEqual(
          message.sensors.map((s) => s.sensorId),
          [1, 2],
        );
        assert.equal(message.version, fingerprint(source.sensors));
        assert.deepEqual(source.touched, [7], 'and records that the probe was seen');
      });
    });

    /**
     * The v1 target, in one message, is a message the probe refuses.
     *
     * `config-set` caps `sensors` at 5,000 and the frame decoder refuses anything over 4 MB,
     * while `CAPABILITIES.MD` §13 puts the v1 target at 5,000 sensors — so an installation at its
     * own documented size produced a configuration its probe rejected as a protocol violation and
     * closed the link on. It reconnected, got the same message, and closed again: 426 times in
     * three minutes on the dev stack, with no way out. Only a probe *restart* shows it, which is
     * why a 24-hour soak carrying the same 5,047 sensors never did — they had arrived as deltas
     * while the tree was being built.
     */
    it('splits a set too large for one message rather than sending one the probe refuses', async () => {
      const source = new StubSource();
      source.sensors = Array.from({ length: 5_047 }, (_, at) => sensor(at + 1));

      await withProbe(source, async (probe) => {
        const set = await probe.waitFor((m) => m.type === 'config-set');
        assert.ok(set.type === 'config-set');
        assert.ok(
          set.sensors.length <= 5_000,
          `config-set carried ${String(set.sensors.length)} sensors, which the schema refuses`,
        );

        // The deltas that carry the rest, all under the same version so the probe's fingerprint
        // matches what the core believes it sent.
        await probe.waitFor(
          (m) =>
            m.type === 'config-delta' &&
            [
              ...set.sensors,
              ...probe.received.flatMap((r) => (r.type === 'config-delta' ? r.upserted : [])),
            ].length === 5_047,
        );

        const delivered = [
          ...set.sensors,
          ...probe.received.flatMap((m) => (m.type === 'config-delta' ? m.upserted : [])),
        ];
        assert.equal(delivered.length, 5_047, 'every sensor arrived, across the chunks');
        assert.equal(
          new Set(delivered.map((one) => one.sensorId)).size,
          5_047,
          'and none of them twice',
        );
        for (const message of probe.received) {
          if (message.type === 'config-delta') {
            assert.equal(message.version, set.version, 'the chunks share one version');
            assert.deepEqual(message.removed, [], 'a chunk of a full set removes nothing');
          }
        }
      });
    });

    it('splits a delta too large for one message, which a large pause produces', async () => {
      // **`P-148`.** `config-delta` caps *both* `upserted` and `removed` at 5,000, and the delta
      // branch had no chunking at all. `assignmentsFor` filters out every paused sensor, so
      // pausing a probe object — or any group above it — on a probe carrying more than that
      // produced one message whose `removed` array the probe's own decoder rejects, and a
      // protocol violation destroys the socket. The pause an operator is told takes effect
      // immediately instead took a reconnect cycle, every time, in both directions.
      // `worthADelta` never saved it: it weighs the *upserts* against a resend and has no
      // opinion about removals.
      const source = new StubSource();
      source.sensors = Array.from({ length: 5_047 }, (_, at) => sensor(at + 1));

      await withProbe(source, async (probe, endpoint) => {
        await probe.waitFor(
          (m) =>
            m.type === 'config-delta' &&
            probe.received.filter((r) => r.type === 'config-delta').length >= 5,
        );
        probe.received.length = 0;

        // Everything paused: the assignment set goes to empty, and the delta is 5,047 removals.
        source.sensors = [];
        assert.ok(source.claimed !== null);
        endpoint.pushConfig(source.claimed);

        await probe.waitFor((m) => {
          const removed = probe.received.flatMap((r) =>
            r.type === 'config-delta' ? r.removed : [],
          );
          return m.type === 'config-delta' && removed.length === 5_047;
        });

        for (const message of probe.received) {
          if (message.type !== 'config-delta') continue;
          assert.ok(
            message.removed.length <= 5_000,
            `a delta carried ${String(message.removed.length)} removals, which the schema refuses`,
          );
          assert.ok(message.upserted.length <= 5_000);
        }
      });
    });

    it('does not re-push on the partial acks a chunked push produces', async () => {
      // **`P-150`, and `P-149` caused it.** A push is several messages and the probe applies and
      // acknowledges *each one*: the acks for a chunked set arrive carrying 1,000, then 2,000,
      // then 3,000 — every one of them a truthful report of a push still in progress. `P-149`
      // compared the first of those against the total and re-pushed, which produced six more
      // messages, another partial ack, and another re-push. An unbounded loop, and it announced
      // itself the moment a real probe with 5,047 sensors connected to the dev stack: the core
      // re-sent the whole configuration continuously, and every in-flight ack also logged
      // "a configuration version the core did not send", because the re-push nulled `sentVersion`.
      //
      // The count is only judged when the last message of the push has been acknowledged.
      const source = new StubSource();
      source.sensors = Array.from({ length: 5_047 }, (_, at) => sensor(at + 1));

      await withProbe(source, async (probe) => {
        const set = await probe.waitFor((m) => m.type === 'config-set');
        assert.ok(set.type === 'config-set');
        await probe.waitFor(
          () => probe.received.filter((m) => m.type === 'config-delta').length === 5,
        );
        const pushed = probe.received.filter(
          (m) => m.type === 'config-set' || m.type === 'config-delta',
        ).length;
        assert.equal(pushed, 6, 'one set and five deltas');
        probe.received.length = 0;

        // Exactly what the probe really sends: one ack per message, each reporting the total it
        // has applied so far.
        for (const scheduled of [1_000, 2_000, 3_000, 4_000, 5_000, 5_047]) {
          probe.send({ type: 'config-ack', version: set.version, scheduled });
        }

        // Nothing may come back. Asserted after a round trip through the connection — a
        // heartbeat the core must answer — so this is not merely a race the test wins.
        probe.send({ type: 'heartbeat', seq: 99, sentAt: new Date().toISOString() });
        await probe.waitFor((m) => m.type === 'heartbeat-ack');
        const configAfter = probe.received.filter(
          (m) => m.type === 'config-set' || m.type === 'config-delta',
        );
        assert.deepEqual(
          configAfter.map((m) => m.type),
          [],
          'the partial acks describe a push in progress, not a probe that is short',
        );
      });
    });

    it('marks only the last message of a push as the one that carries the version', async () => {
      // **`R18`.** `P-148` chunked the *delta* path, and a delta was one message before that —
      // so it arrived whole or not at all. Chunked, and with the probe stamping its
      // `#configVersion` on the first message it applies, a link that drops between chunks
      // leaves it holding part of the change under a fingerprint that says it is current: it
      // reconnects, the fingerprint matches, the core answers `config-unchanged`, and the rest
      // is never sent. An operator's pause of three thousand sensors half-lands, the probe goes
      // on scanning the ones it was told to stop scanning, and nothing anywhere disagrees.
      // `P-149`'s ack check cannot rescue it — the acks for the missing chunks never arrive,
      // because the connection is what broke.
      //
      // So the core says which message ends the push, and the probe claims the version only on
      // that one. Absent means final, so an older core is unaffected.
      const source = new StubSource();
      source.sensors = Array.from({ length: 3_500 }, (_, at) => sensor(at + 1));

      await withProbe(source, async (probe) => {
        await probe.waitFor(
          () =>
            probe.received.filter((m) => m.type === 'config-set' || m.type === 'config-delta')
              .length === 4,
        );
        const push = probe.received.filter(
          (m): m is Extract<CoreToProbeMessage, { type: 'config-set' | 'config-delta' }> =>
            m.type === 'config-set' || m.type === 'config-delta',
        );
        assert.deepEqual(
          push.map((m) => m.final),
          [false, false, false, true],
          'only the message that completes the push may let the probe claim the version',
        );
      });
    });

    it('serves a probe whose build is newer than this core, at this core-s version', async () => {
      // **`P-178`.** Version negotiation runs at both ends, so a peer ahead of this build is
      // served rather than refused — and every capability gate reads the negotiated number, so
      // this core never sends a field it cannot produce and the newer probe never sends one this
      // core cannot parse. Before this, `describeSkew` called it `incompatible` and the
      // handshake was refused, which made every bump a lockstep fleet upgrade.
      const source = new StubSource();
      source.sensors = [sensor(1), sensor(2)];

      await withProbe(
        source,
        async (probe) => {
          const set = await probe.waitFor((m) => m.type === 'config-set');
          assert.ok(set.type === 'config-set');
          assert.equal(set.sensors.length, 2, 'it is configured like any other probe');
          // Negotiated to this core's version, so the field it knows about is still sent.
          assert.equal(set.final, true, 'and gated on the pair, not on the probe alone');
        },
        { protocolVersion: PROTOCOL_VERSION + 4 },
      );
    });

    it('sends no final flag at all to a probe too old to know the field', async () => {
      // **`P-168`.** Every core→probe schema carries `additionalProperties: false`, so an
      // unknown field is not ignored by an older probe — `parseCoreToProbe` throws, the
      // connection is destroyed on a protocol violation, and the probe reconnects into the same
      // message. `P-166` added `final` without bumping `PROTOCOL_VERSION`, which wedged every
      // probe not upgraded in lockstep: the `P-148` failure it was itself postmortem-ing.
      //
      // The field is gated on the capability now, so an older probe gets exactly the bytes it
      // got before — and `P-153`'s heartbeat reconciliation is what covers the case `final`
      // would have covered for it.
      const source = new StubSource();
      source.sensors = Array.from({ length: 3_500 }, (_, at) => sensor(at + 1));

      await withProbe(
        source,
        async (probe) => {
          await probe.waitFor(
            () =>
              probe.received.filter((m) => m.type === 'config-set' || m.type === 'config-delta')
                .length === 4,
          );
          const push = probe.received.filter(
            (m) => m.type === 'config-set' || m.type === 'config-delta',
          );
          assert.deepEqual(
            push.map((m) => 'final' in m),
            [false, false, false, false],
            'an older probe must not be sent a field its schema will reject',
          );
        },
        { protocolVersion: 15 },
      );
    });

    it('sends the whole set again to a probe that never saw the end of the last push', async () => {
      // **`R18`, end to end.** The rule the `final` flag encodes, stated as the fake probe's
      // behaviour and then exercised: a probe claims a version only on the message that
      // completes the push, so one that lost the rest still presents the *old* fingerprint. The
      // core compares, finds a mismatch, and sends a snapshot — which is the recovery that did
      // not exist while the version was stamped on the first chunk.
      const source = new StubSource();
      source.sensors = Array.from({ length: 3_500 }, (_, at) => sensor(at + 1));

      const endpoint = new ProbeEndpoint({
        config: endpointConfig(dir),
        logger: silentLogger,
        coreVersion: '9.9.9',
        probeConfig: source,
      });
      const address = await endpoint.start();
      try {
        let heldVersion = '';
        const first = await TestProbe.connect(dir, address.port);
        first.send(hello());
        await first.waitFor((m) => m.type === 'welcome');
        const set = await first.waitFor((m) => m.type === 'config-set');
        assert.ok(set.type === 'config-set');
        // What the real client does: stamp only on a message the core marked final. Read before
        // the assertion below, so this is the rule applied rather than a constant restated.
        if (set.final !== false) heldVersion = set.version;
        assert.equal(set.final, false, 'the first chunk of four does not complete the push');
        first.close();

        // It comes back presenting what it actually holds.
        const again = await TestProbe.connect(dir, address.port);
        again.send(hello({ configVersion: heldVersion }));
        await again.waitFor((m) => m.type === 'welcome');
        const resent = await again.waitFor((m) => m.type === 'config-set');
        assert.ok(resent.type === 'config-set');
        assert.equal(
          resent.version,
          set.version,
          'the same configuration, sent again in full rather than declared unchanged',
        );
        again.close();
      } finally {
        await endpoint.stop();
      }
    });

    it('re-pushes to a probe that reconnected holding a version it never finished applying', async () => {
      // **`P-153`, and it is the case `P-149` was written for and could not reach.** A link that
      // drops mid-push leaves the probe with chunk one and a `#configVersion` it stamped on that
      // first message. It reconnects, presents that version, the fingerprint matches, and the
      // core answers `config-unchanged` — so the sensors outside chunk one are never scanned
      // again, while the probe keeps delivering results for the ones it kept and every health
      // signal reads green. `P-149`'s ack comparison cannot see it: the acks for the messages
      // that were lost never arrive.
      //
      // The heartbeat can. `ProbeHealthReport.scheduled` is the wheel's own count and its
      // declaration in the protocol says it is "compared against what the core assigned".
      const source = new StubSource();
      source.sensors = Array.from({ length: 3_000 }, (_, at) => sensor(at + 1));

      await withProbe(source, async (probe) => {
        await probe.waitFor(
          () => probe.received.filter((m) => m.type === 'config-delta').length === 2,
        );
        // Every message acked, so nothing is outstanding — the state a probe is in once a push
        // has completed, and the state it *claims* to be in after a partial one.
        const set = probe.received.find((m) => m.type === 'config-set');
        assert.ok(set?.type === 'config-set');
        for (const scheduled of [1_000, 2_000, 3_000]) {
          probe.send({ type: 'config-ack', version: set.version, scheduled });
        }
        probe.send({ type: 'heartbeat', seq: 1, sentAt: new Date().toISOString() });
        await probe.waitFor((m) => m.type === 'heartbeat-ack');
        probe.received.length = 0;

        // Now it reports what a probe that lost most of a push really has.
        probe.send({
          type: 'heartbeat',
          seq: 2,
          sentAt: new Date().toISOString(),
          health: { scheduled: 1_000 },
        });

        const again = await probe.waitFor((m) => m.type === 'config-set');
        assert.ok(again.type === 'config-set');
        assert.equal(
          probe.received.filter((m) => m.type === 'config-set' || m.type === 'config-delta')
            .length >= 1,
          true,
          'the whole set is sent again rather than a delta against a state it does not have',
        );
      });
    });

    it('sends nothing, and logs no credential, when the probe goes while its configuration is read (A-50)', async () => {
      // At debug, which is what an operator turns on to diagnose a link that flaps. The push
      // awaited the read, which decrypts every credential, and then sent to the closed connection,
      // which logged the whole message.
      const lines: string[] = [];
      const logger = pino(
        { level: 'debug' },
        {
          write: (chunk: string) => {
            lines.push(chunk);
          },
        },
      );
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reading = false;
      const source = new StubSource();
      source.sensors = [
        sensor(1, {
          params: { count: 4, token: 's3cret-token' },
          credentials: { snmp: { community: 's3cret-community' } },
        }),
      ];
      const read = source.assignmentsFor.bind(source);
      source.assignmentsFor = async (): Promise<ProbeAssignments> => {
        reading = true;
        await gate;
        return read();
      };
      const endpoint = new ProbeEndpoint({
        config: endpointConfig(dir),
        logger,
        coreVersion: '9.9.9',
        probeConfig: source,
      });
      const address = await endpoint.start();
      try {
        const probe = await TestProbe.connect(dir, address.port);
        probe.send(hello());
        await waitUntil(() => reading);
        probe.close();
        await waitUntil(() => !endpoint.linkFor(7).connected);
        await new Promise((resolve) => setTimeout(resolve, 50));
        release?.();
        await new Promise((resolve) => setTimeout(resolve, 100));

        const logged = lines.join('');
        assert.match(logged, /probe connection closed/u, 'the control: it closed mid-read');
        assert.doesNotMatch(logged, /s3cret/u);
        assert.doesNotMatch(
          logged,
          /"type":"config-(set|delta)"/u,
          'the push stopped rather than sending to a closed connection',
        );
      } finally {
        await endpoint.stop();
      }
    });

    it('keeps the link when a heartbeat carries a health reading out of range (P-224)', async () => {
      // A probe in a container whose `/proc/meminfo` claimed more available than total sent
      // 100.3%, on every heartbeat — it sends the worst of thirty seconds each time. The core
      // refused the frame and closed the link, the probe reconnected into the same refusal, and
      // the lot turned on one optional number that should have been one empty channel.
      const lines: Record<string, unknown>[] = [];
      const logger = pino(
        { level: 'warn' },
        {
          write: (chunk: string) => {
            lines.push(JSON.parse(chunk) as Record<string, unknown>);
          },
        },
      );
      const source = new StubSource();
      const endpoint = new ProbeEndpoint({
        config: endpointConfig(dir),
        logger,
        coreVersion: '9.9.9',
        probeConfig: source,
      });
      const address = await endpoint.start();
      try {
        const probe = await TestProbe.connect(dir, address.port);
        probe.send(hello());
        await probe.waitFor((m) => m.type === 'welcome');
        await waitUntil(() => endpoint.linkFor(7).connected);
        for (const seq of [1, 2, 3]) {
          probe.send({
            type: 'heartbeat',
            seq,
            sentAt: new Date().toISOString(),
            health: { memoryAvailablePercent: 100.3, memoryAvailableMb: 7_950, scheduled: 0 },
          });
          await probe.waitFor((m) => m.type === 'heartbeat-ack' && m.seq === seq);
        }

        const link = endpoint.linkFor(7);
        assert.ok(link.connected, 'the link survives every one of them');
        assert.deepEqual(
          link.health,
          { memoryAvailableMb: 7_950, scheduled: 0 },
          'the one reading is a gap, and the rest of the report arrives',
        );
        const said = lines.filter((line) =>
          String(line['msg']).startsWith('probe sent health readings the core cannot use'),
        );
        assert.equal(said.length, 1, 'said once for the connection, not once a heartbeat');
        assert.deepEqual(said[0]?.['fields'], [
          {
            field: 'memoryAvailablePercent',
            value: 100.3,
            reason: '/health/memoryAvailablePercent: must be <= 100',
          },
        ]);
        assert.equal(
          lines.some((line) => line['msg'] === 'closing connection on protocol violation'),
          false,
        );
        probe.close();
      } finally {
        await endpoint.stop();
      }
    });

    it('keeps the first report of a session beside the latest, for Probe Health’s baselines (`P-284` review)', async () => {
      // A probe met for the first time is baselined from the report it sends at the welcome,
      // before its drain sends anything, so what it discards after is counted. A new session
      // keeps its own first report.
      const source = new StubSource();
      const endpoint = new ProbeEndpoint({
        config: endpointConfig(dir),
        logger: silentLogger,
        coreVersion: '9.9.9',
        probeConfig: source,
      });
      const address = await endpoint.start();
      try {
        for (const session of [0, 1]) {
          const probe = await TestProbe.connect(dir, address.port);
          probe.send(hello());
          await probe.waitFor((m) => m.type === 'welcome');
          await waitUntil(() => endpoint.linkFor(7).connected);
          for (const seq of [1, 2, 3]) {
            probe.send({
              type: 'heartbeat',
              seq,
              sentAt: new Date().toISOString(),
              health: { spoolOversized: 10 * session + seq, scheduled: 0 },
            });
            await probe.waitFor((m) => m.type === 'heartbeat-ack' && m.seq === seq);
          }
          const link = endpoint.linkFor(7);
          assert.ok(link.connected);
          assert.equal(link.firstHealth?.spoolOversized, 10 * session + 1, 'the first');
          assert.equal(link.health?.spoolOversized, 10 * session + 3, 'and the latest');
          probe.close();
          await waitUntil(() => !endpoint.linkFor(7).connected);
        }
      } finally {
        await endpoint.stop();
      }
    });

    describe('what it tells a watcher of the link (U-24)', () => {
      /** An endpoint that records each time it said a probe changed, and what `linkFor` said then. */
      async function watched(
        source: StubSource,
        body: (
          probe: TestProbe,
          told: { probe: number; connected: boolean; reported: boolean }[],
        ) => Promise<void>,
      ): Promise<void> {
        const told: { probe: number; connected: boolean; reported: boolean }[] = [];
        const endpoint: ProbeEndpoint = new ProbeEndpoint({
          config: endpointConfig(dir),
          logger: silentLogger,
          coreVersion: '9.9.9',
          probeConfig: source,
          links: {
            changed: (probeObjectId) => {
              // Read at the edge, as a watcher's request would be: the link has already changed.
              const link = endpoint.linkFor(probeObjectId);
              told.push({
                probe: probeObjectId,
                connected: link.connected,
                reported: link.connected && link.health !== undefined,
              });
            },
          },
        });
        const address = await endpoint.start();
        try {
          const probe = await TestProbe.connect(dir, address.port);
          probe.send(hello());
          await probe.waitFor((m) => m.type === 'welcome');
          await body(probe, told);
          probe.close();
        } finally {
          await endpoint.stop();
        }
      }

      const beat = async (
        probe: TestProbe,
        seq: number,
        health?: Record<string, number>,
      ): Promise<void> => {
        probe.send({
          type: 'heartbeat',
          seq,
          sentAt: new Date().toISOString(),
          ...(health === undefined ? {} : { health }),
        });
        await probe.waitFor((m) => m.type === 'heartbeat-ack' && m.seq === seq);
      };

      it('says so when a probe claims its branch, when its report changes shape, and when it goes', async () => {
        await watched(new StubSource(), async (probe, told) => {
          await waitUntil(() => told.length === 1);
          assert.deepEqual(told[0], { probe: 7, connected: true, reported: false });

          // Its first report: what the add-sensor form could not be prompted for.
          await beat(probe, 1, { scheduled: 0 });
          assert.deepEqual(told.slice(1), [{ probe: 7, connected: true, reported: true }]);
          // The numbers moving is not news — a frame per heartbeat would be a poll.
          await beat(probe, 2, { scheduled: 5 });
          assert.equal(told.length, 2);
          // The flow collector comes on.
          await beat(probe, 3, { scheduled: 5, flowReceived: 0 });
          assert.equal(told.length, 3);
          await beat(probe, 4, { scheduled: 5, flowReceived: 17 });
          assert.equal(told.length, 3);
          // A heartbeat with no report is not a report that left everything out.
          await beat(probe, 5);
          assert.equal(told.length, 3);
          // The syslog and trap listeners, each on its own.
          await beat(probe, 6, { scheduled: 5, flowReceived: 17, syslogReceived: 0 });
          assert.equal(told.length, 4);
          await beat(probe, 7, {
            scheduled: 5,
            flowReceived: 17,
            syslogReceived: 0,
            trapReceived: 0,
          });
          assert.equal(told.length, 5);
          // And the collector goes off again.
          await beat(probe, 8, { scheduled: 5, syslogReceived: 0, trapReceived: 0 });
          assert.equal(told.length, 6);

          probe.close();
          await waitUntil(() => told.length === 7);
          assert.deepEqual(
            told[6],
            { probe: 7, connected: false, reported: false },
            'told before the link read as gone',
          );
        });
      });

      it('says nothing for a probe no branch has claimed', async () => {
        const source = new StubSource();
        source.claimed = null;
        await watched(source, async (probe, told) => {
          await probe.waitFor((m) => m.type === 'config-set');
          await beat(probe, 1, { scheduled: 0, flowReceived: 0 });
          probe.close();
          await new Promise((resolve) => setTimeout(resolve, 100));
          assert.deepEqual(told, []);
        });
      });

      it('reads a report’s shape from the listeners it names and whether it reported at all', () => {
        assert.equal(reportShape(undefined), null);
        assert.notEqual(reportShape({}), null, 'an empty report is a report');
        const shapes = [
          reportShape({}),
          reportShape({ scheduled: 3 }),
          reportShape({ scheduled: 3, flowReceived: 0 }),
          reportShape({ scheduled: 3, syslogReceived: 0 }),
          reportShape({ scheduled: 3, trapReceived: 0 }),
          reportShape({ scheduled: 3, flowReceived: 0, syslogReceived: 0, trapReceived: 0 }),
        ];
        assert.equal(new Set(shapes).size, shapes.length, 'two different shapes read alike');
        // A zero is a value: a collector that has received nothing is running.
        assert.equal(
          reportShape({ scheduled: 0, flowReceived: 0 }),
          reportShape({ scheduled: 12, flowReceived: 900 }),
        );
        // What the form does not read does not make a frame.
        assert.equal(
          reportShape({ scheduled: 3, poolBusy: 2, cpuPercent: 40 }),
          reportShape({ scheduled: 3 }),
        );
      });
    });

    describe('the memory lows it folds for Probe Health (P-219)', () => {
      const beat = async (
        probe: TestProbe,
        seq: number,
        health: NonNullable<Extract<ProbeToCoreMessage, { type: 'heartbeat' }>['health']>,
      ): Promise<void> => {
        probe.send({ type: 'heartbeat', seq, sentAt: new Date().toISOString(), health });
        await probe.waitFor((m) => m.type === 'heartbeat-ack' && m.seq === seq);
      };

      it('folds every report of a protocol-20 probe until the sweep drains them, then starts again', async () => {
        await withProbe(new StubSource(), async (probe, endpoint) => {
          await waitUntil(() => endpoint.linkFor(7).connected);
          await beat(probe, 1, {
            memoryAvailablePercent: 50,
            memoryAvailableMb: 4_000,
            memoryLimitUsagePercent: 30,
            memoryLimitMb: 4_096,
          });
          await beat(probe, 2, {
            memoryAvailablePercent: 12,
            memoryAvailableMb: 960,
            memoryLimitUsagePercent: 70,
          });
          await beat(probe, 3, {
            memoryAvailablePercent: 40,
            memoryAvailableMb: 3_200,
            memoryLimitUsagePercent: 50,
            memoryLimitMb: 2_048,
          });
          assert.deepEqual(
            endpoint.drainMemory(),
            new Map([
              [
                7,
                {
                  memoryAvailablePercent: 12,
                  memoryAvailableMb: 960,
                  memoryLimitUsagePercent: 70,
                  // A size, not a low: the ceiling as last reported.
                  memoryLimitMb: 2_048,
                },
              ],
            ]),
          );
          assert.equal(endpoint.drainMemory().size, 0, 'drained once, and then nothing since');
          const link = endpoint.linkFor(7);
          assert.ok(link.connected);
          assert.equal(
            link.health?.memoryAvailablePercent,
            40,
            'the link still reads the latest report, for a scrape',
          );
        });
      });

      it('keeps what arrived before a dropped link for the first sweep after it', async () => {
        // The probe let go of these lows when the core acknowledged them.
        const source = new StubSource();
        await withProbe(source, async (probe, endpoint) => {
          await waitUntil(() => endpoint.linkFor(7).connected);
          await beat(probe, 1, { memoryAvailablePercent: 8.5 });
          probe.close();
          await waitUntil(() => !endpoint.linkFor(7).connected);
          assert.deepEqual(endpoint.drainMemory().get(7), { memoryAvailablePercent: 8.5 });
        });
      });

      it('folds nothing from a probe below 20, whose report is its last thirty seconds', async () => {
        await withProbe(
          new StubSource(),
          async (probe, endpoint) => {
            await waitUntil(() => endpoint.linkFor(7).connected);
            await beat(probe, 1, { memoryAvailablePercent: 12 });
            assert.equal(endpoint.drainMemory().size, 0);
          },
          { protocolVersion: 19 },
        );
      });
    });

    it('pushes again when the probe acknowledges a different number of sensors', async () => {
      // **`P-149`.** A full push is one `config-set` plus N-1 deltas at the same version, and the
      // probe stamps itself as holding that version on the *first* one — so a link that drops
      // mid-push leaves it with a fraction of its sensors and a version that says it is current.
      // It reconnects, presents that version, the fingerprint matches, and the core answers
      // `config-unchanged`. Nothing ever re-pushes: `pushAllConfigs` short-circuits on an
      // unchanged fingerprint, and the probe keeps delivering results for the sensors it did
      // keep, so the delivery watch reads it as healthy. The rest are never scanned again.
      //
      // The disagreement was already on the wire and already discarded: `config-ack` carries the
      // count the probe actually scheduled, and the core logged it. Acting on it needs no
      // protocol change — the probe asked for the push by telling us a number that cannot be
      // right.
      const source = new StubSource();
      source.sensors = [sensor(1), sensor(2), sensor(3)];

      await withProbe(source, async (probe) => {
        const set = await probe.waitFor((m) => m.type === 'config-set');
        assert.ok(set.type === 'config-set');
        probe.received.length = 0;

        // What a probe that lost the rest of a push reports: current version, fewer sensors.
        probe.send({ type: 'config-ack', version: set.version, scheduled: 1 });

        const again = await probe.waitFor((m) => m.type === 'config-set');
        assert.ok(again.type === 'config-set');
        assert.equal(again.sensors.length, 3, 'the whole set, again');
      });
    });

    it('sends nothing but a confirmation when the probe is already current', async () => {
      // The reconnect-after-a-blip case, and the whole reason the handshake carries a
      // fingerprint: re-sending five thousand unchanged assignments is pure waste.
      const source = new StubSource();
      source.sensors = [sensor(1), sensor(2)];

      await withProbe(
        source,
        async (probe) => {
          const message = await probe.waitFor((m) => m.type === 'config-unchanged');
          assert.ok(message.type === 'config-unchanged');
          assert.equal(
            probe.received.some((m) => m.type === 'config-set'),
            false,
            'a snapshot was sent to a probe that did not need one',
          );
        },
        { configVersion: fingerprint([sensor(1), sensor(2)]) },
      );
    });

    it('starts no delivery clock for a probe it sent no configuration to', async () => {
      // `configSentAt` answers one question for `P-74`: when did this probe last get work it has
      // not yet reported on. A probe that arrived already current was sent nothing, so there is
      // no such moment, and claiming one would postpone the silence window for a probe that
      // should be delivering from the first tick.
      const source = new StubSource();
      source.sensors = [sensor(1), sensor(2)];

      await withProbe(
        source,
        async (probe, endpoint) => {
          await probe.waitFor((m) => m.type === 'config-unchanged');
          const link = endpoint.linkFor(7);
          assert.ok(link.connected);
          assert.equal(link.configSentAt, null, 'nothing was sent, so nothing was stamped');
          // The control: the rest of `#noteAssignments` plainly did run on this branch, so the
          // null above is a decision and not an untaken code path.
          assert.equal(link.assignedSensors, 2);
          assert.equal(link.cadenceSeconds, 60);
        },
        { configVersion: fingerprint([sensor(1), sensor(2)]) },
      );
    });

    it('does not restart the delivery clock when a recompute changes nothing', async () => {
      // **`P-77`.** The stamp was written on both branches, so any change anywhere in the tree —
      // one sensor edited in an installation of five thousand — recomputed every connected probe
      // and pushed `P-74`'s window out by a full cycle on all of them. A genuinely silent probe
      // would then never be caught on a busy system, which is precisely the system that needs it.
      const source = new StubSource();
      source.sensors = [sensor(1)];

      await withProbe(source, async (probe, endpoint) => {
        await probe.waitFor((m) => m.type === 'config-set');
        const first = endpoint.linkFor(7);
        assert.ok(first.connected && first.configSentAt !== null);
        const stamped = first.configSentAt.getTime();

        // `Date` has millisecond resolution: without a gap a re-stamp would land on the same
        // value and this would pass against the defect it is here to catch.
        await new Promise((resolve) => setTimeout(resolve, 25));

        const before = source.recomputes;
        endpoint.pushConfig(7);
        await waitUntil(() => source.recomputes > before);

        const after = endpoint.linkFor(7);
        assert.ok(after.connected);
        assert.equal(after.configSentAt?.getTime(), stamped, 'the clock was restarted by churn');
      });
    });

    it('brings a probe’s sensors back even when recording its last-seen time fails', async () => {
      // **`P-80`.** `touch` is one `UPDATE ... last_seen_at`, documented as unable to fail a
      // handshake — but its rejection landed in the outer catch, skipping `reachability.found()`.
      // The guard that re-runs that block is `probeObjectId === null` and the field is already
      // set by then, so `found()` was never called again for the life of the session: the probe's
      // sensors stayed Unknown with reason 'link' while it delivered normally, every arriving
      // result re-decided against an overlay saying its probe was unreachable. The delivery sweep
      // cannot rescue it either — it reads 'link' and correctly leaves `R-05`'s probes alone.
      const source = new StubSource();
      source.sensors = [sensor(1)];
      source.touchFails = true;
      const found: number[] = [];

      await withProbe(
        source,
        async (probe) => {
          await probe.waitFor((m) => m.type === 'config-set');
          assert.deepEqual(source.touched, [7], 'it was attempted');
          assert.deepEqual(found, [7], 'and the sensors came back anyway');
        },
        {},
        undefined,
        {
          found: (id: number) => {
            found.push(id);
            return Promise.resolve(1);
          },
          lost: () => Promise.resolve(0),
        },
      );
    });

    it('sends an empty configuration to a probe no branch has claimed', async () => {
      // A freshly installed probe, before R-01 enrols it. Not an error, and not silence: a
      // probe that is told nothing cannot tell "no sensors" from "the core did not answer".
      const source = new StubSource();
      source.claimed = null;
      source.sensors = [sensor(1)];

      await withProbe(source, async (probe) => {
        const message = await probe.waitFor((m) => m.type === 'config-set');
        assert.ok(message.type === 'config-set');
        assert.deepEqual(message.sensors, []);
        assert.deepEqual(source.touched, [], 'nothing to touch');
      });
    });

    it('sends a delta when the configuration changes under a live connection', async () => {
      const source = new StubSource();
      source.sensors = [sensor(1), sensor(2), sensor(3)];

      await withProbe(source, async (probe, endpoint) => {
        await probe.waitFor((m) => m.type === 'config-set');

        source.sensors = [sensor(1), sensor(2, { intervalSeconds: 30 }), sensor(4)];
        endpoint.pushConfig(7);

        const message = await probe.waitFor((m) => m.type === 'config-delta');
        assert.ok(message.type === 'config-delta');
        assert.deepEqual(
          message.upserted.map((s) => s.sensorId).sort(),
          [2, 4],
          'sensor 1 did not change and must not be re-sent',
        );
        assert.deepEqual(message.removed, [3]);
      });
    });

    it('resends in full when the delta would be no smaller', async () => {
      // A change that touches everything is cheaper to state as a snapshot than as a list of
      // upserts covering the same rows.
      const source = new StubSource();
      source.sensors = [sensor(1), sensor(2)];

      await withProbe(source, async (probe, endpoint) => {
        await probe.waitFor((m) => m.type === 'config-set');
        probe.received.length = 0;

        source.sensors = [sensor(1, { intervalSeconds: 10 }), sensor(2, { intervalSeconds: 10 })];
        endpoint.pushConfig(7);

        const message = await probe.waitFor((m) => m.type === 'config-set');
        assert.ok(message.type === 'config-set');
        assert.equal(message.sensors.length, 2);
      });
    });

    it('says nothing when a push finds nothing changed', async () => {
      const source = new StubSource();
      source.sensors = [sensor(1)];

      await withProbe(source, async (probe, endpoint) => {
        await probe.waitFor((m) => m.type === 'config-set');
        probe.received.length = 0;

        endpoint.pushConfig(7);
        // A change elsewhere in the tree recomputes every connected probe; the ones whose
        // fingerprint did not move must not be told anything at all.
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.deepEqual(
          probe.received.filter((m) => m.type.startsWith('config-')),
          [],
        );
      });
    });

    it('reaches a probe that was enrolled after it had already connected', async () => {
      // The ordinary enrolment sequence (R-01): a probe installs itself, connects, and waits to
      // be approved. If the session only resolved its branch at the handshake, approving it
      // would do nothing until someone restarted the probe.
      const source = new StubSource();
      source.claimed = null;
      source.sensors = [sensor(1), sensor(2)];

      await withProbe(source, async (probe, endpoint) => {
        const empty = await probe.waitFor((m) => m.type === 'config-set');
        assert.ok(empty.type === 'config-set');
        assert.deepEqual(empty.sensors, [], 'nothing to scan until a branch claims it');
        probe.received.length = 0;

        source.claimed = 7;
        endpoint.pushAllConfigs();

        const message = await probe.waitFor((m) => m.type.startsWith('config-'));
        assert.ok(message.type === 'config-set' || message.type === 'config-delta');
        const scheduled = message.type === 'config-set' ? message.sensors : message.upserted;
        assert.deepEqual(scheduled.map((s) => s.sensorId).sort(), [1, 2]);
        assert.deepEqual(source.touched, [7], 'and the claim was recorded when it appeared');
      });
    });

    it('sends no configuration at all to a probe too old to understand it', async () => {
      const source = new StubSource();
      source.sensors = [sensor(1)];

      await withProbe(
        source,
        async (probe) => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          assert.deepEqual(
            probe.received.filter((m) => m.type.startsWith('config-')),
            [],
            'a version-2 probe would fail to parse it',
          );
        },
        { protocolVersion: 2 },
      );
    });

    /**
     * Sweep delivery (`R-06`).
     *
     * `sendSweep` used to answer `false` for two unrelated situations. A caller that cannot tell
     * "not now" from "never" has to guess, and it guessed wait — so a discovery run assigned to
     * a probe too old for it sat queued for as long as anybody left it.
     */
    it('tells a caller that a probe is too old, not merely absent', async () => {
      const source = new StubSource();

      await withProbe(
        source,
        async (_probe, endpoint) => {
          await Promise.resolve();
          const delivery = endpoint.sendSweep(7, { kind: 'cancel', runId: 1 });
          assert.equal(delivery.kind, 'too-old');
          assert.equal(delivery.protocolVersion, 3);
          assert.equal(delivery.needs, 4);
        },
        { protocolVersion: 3 },
      );
    });

    it('distinguishes the two discovery stages, which arrived in different versions', async () => {
      // A protocol-4 probe sweeps and cannot identify. Answering `too-old` to both, or to
      // neither, loses half the capability an operator paid for by upgrading.
      const source = new StubSource();

      await withProbe(
        source,
        async (_probe, endpoint) => {
          await Promise.resolve();
          assert.equal(endpoint.sendSweep(7, { kind: 'cancel', runId: 1 }).kind, 'sent');
          const identify = endpoint.sendSweep(7, { kind: 'identify-cancel', runId: 1 });
          assert.equal(identify.kind, 'too-old');
          assert.equal(identify.needs, 5);
        },
        { protocolVersion: 4 },
      );
    });

    it('answers offline for a probe that is simply not there', async () => {
      const source = new StubSource();

      await withProbe(source, async (_probe, endpoint) => {
        // 999 is nobody's branch, which is what an offline probe looks like from here.
        assert.equal(endpoint.sendSweep(999, { kind: 'cancel', runId: 1 }).kind, 'offline');
        await Promise.resolve();
      });
    });

    /**
     * On-demand queries over the real socket (`R-09`).
     *
     * The service's own logic is covered without a socket in `probe-queries.test.ts`. What is
     * here is the half that only a wire can prove: that the message survives framing and
     * validation in both directions, that the capability gate is applied by the thing holding
     * the connection, and that a dropped socket reaches the sink that settles the callers.
     */
    describe('on-demand queries', () => {
      const query = {
        kind: 'check' as const,
        assignment: sensor(1),
      };

      it('speaks for the probe on the line, whatever a refused hello claimed (A-41c)', async () => {
        // "Check now" decides whether a set bounded by its targets may be sent against this, and
        // hands the version back with the query. The registration row was what it read: a hello
        // refused for its key wrote 24 there while a probe at 23 held the connection.
        const endpoint = new ProbeEndpoint({
          config: endpointConfig(dir),
          logger: silentLogger,
          coreVersion: '9.9.9',
          probeConfig: {
            probeObjectFor: () => Promise.resolve(7),
            assignmentsFor: () =>
              Promise.resolve({ version: 'v1', sensors: [], stamps: new Map<number, string>() }),
            touch: () => Promise.resolve(),
          },
          registry: {
            admit: (said) =>
              Promise.resolve(
                said.protocolVersion === 23
                  ? { kind: 'approved' as const, gid: 'probe-gid', objectId: 7 }
                  : {
                      kind: 'refused' as const,
                      code: 'bad-access-key' as const,
                      detail: 'the access key was not accepted',
                    },
              ),
          },
        });
        const address = await endpoint.start();
        try {
          assert.equal(endpoint.protocolVersionOf(7), 0, 'nobody on the line');

          const probe = await TestProbe.connect(dir, address.port);
          probe.send(hello({ gid: 'probe-gid', protocolVersion: 23 }));
          await probe.waitFor((m) => m.type === 'welcome');
          assert.equal(endpoint.protocolVersionOf(7), 23);

          const beside = await TestProbe.connect(dir, address.port);
          beside.send(hello({ gid: 'probe-gid', protocolVersion: 24 }));
          await beside.waitFor((m) => m.type === 'reject');
          assert.equal(endpoint.protocolVersionOf(7), 23, 'the refused hello changed nothing');
          assert.equal(endpoint.protocolVersionOf(8), 0, 'and another probe is nobody');

          // A query decided for a probe at 24 is not sent to the one at 23.
          const forNewer = endpoint.sendQuery(7, {
            kind: 'ask',
            queryId: 'q24',
            query,
            timeoutMs: 5_000,
            peerVersion: 24,
          });
          assert.equal(forNewer.kind, 'offline');
          const forThisOne = endpoint.sendQuery(7, {
            kind: 'ask',
            queryId: 'q23',
            query,
            timeoutMs: 5_000,
            peerVersion: 23,
          });
          assert.equal(forThisOne.kind, 'sent');
          const sent = await probe.waitFor((m) => m.type === 'query');
          assert.ok(sent.type === 'query');
          assert.equal(sent.queryId, 'q23', 'only the one decided for it arrived');
          probe.close();
          beside.close();
        } finally {
          await endpoint.stop();
        }
      });

      it('carries a query out and its answer back', async () => {
        const source = new StubSource();
        const answered: { queryId: string; result?: unknown }[] = [];

        await withProbe(
          source,
          async (probe, endpoint) => {
            const delivery = endpoint.sendQuery(7, {
              kind: 'ask',
              queryId: 'q1',
              query,
              timeoutMs: 5_000,
            });
            assert.equal(delivery.kind, 'sent');

            const sent = await probe.waitFor((m) => m.type === 'query');
            assert.ok(sent.type === 'query');
            assert.equal(sent.queryId, 'q1');
            assert.equal(sent.timeoutMs, 5_000);
            assert.equal(sent.query.assignment.sensorId, 1);

            probe.send({
              type: 'query-result',
              queryId: 'q1',
              result: {
                sensorId: 1,
                at: '2026-08-29T10:00:00.000Z',
                outcome: 'ok',
                message: '4/4 replies',
                durationMs: 612,
                channels: [{ key: 'rtt', value: 1.2 }],
              },
            });
            await waitUntil(() => answered.length === 1);
            assert.equal(answered[0]?.queryId, 'q1');
          },
          {},
          { deliver: (m) => answered.push(m), probeDisconnected: () => undefined },
        );
      });

      it('cancels through the same channel', async () => {
        const source = new StubSource();
        await withProbe(source, async (probe, endpoint) => {
          endpoint.sendQuery(7, { kind: 'cancel', queryId: 'q9' });
          const sent = await probe.waitFor((m) => m.type === 'query-cancel');
          assert.ok(sent.type === 'query-cancel');
          assert.equal(sent.queryId, 'q9');
        });
      });

      it('refuses a probe too old to be asked, rather than sending into silence', async () => {
        // The reason the gate lives here: a person is watching a spinner, and a probe that will
        // never answer must be reported now rather than at the deadline, where it would look
        // exactly like a device that will not reply.
        const source = new StubSource();
        await withProbe(
          source,
          async (_probe, endpoint) => {
            await Promise.resolve();
            const delivery = endpoint.sendQuery(7, {
              kind: 'ask',
              queryId: 'q1',
              query,
              timeoutMs: 5_000,
            });
            assert.equal(delivery.kind, 'too-old');
            assert.equal(delivery.protocolVersion, 7);
          },
          { protocolVersion: 7 },
        );
      });

      it('tells the query sink when a probe’s connection goes', async () => {
        const source = new StubSource();
        const gone: number[] = [];

        await withProbe(
          source,
          async (probe) => {
            await Promise.resolve();
            probe.close();
            await waitUntil(() => gone.length === 1);
          },
          {},
          { deliver: () => undefined, probeDisconnected: (id) => gone.push(id) },
        );
        assert.deepEqual(gone, [7]);
      });
    });
  },
);

describe(
  'ProbeEndpoint: who sent it (`P-228`)',
  { skip: opensslAvailable ? false : 'openssl is not available' },
  () => {
    // Every message a probe sends about work — a result, a query's answer, a discovery run's
    // progress — used to reach its sink with nothing but the ids it named, so nothing downstream
    // could ask whether this probe had been given that work. These pin that each now carries
    // the probe object the sending GID owns; the refusals themselves are tested where they are
    // made.
    const gidA = 'gid-probe-a';
    const gidB = 'gid-probe-b';
    const gidUnclaimed = 'gid-nobody-claimed';
    const objectOf = new Map<string, number>([
      [gidA, 7],
      [gidB, 8],
    ]);
    const assignment = (id: number): SensorAssignment => ({
      sensorId: id,
      sensorType: 'icmp.ping',
      params: { count: 4 },
      target: { host: `192.0.2.${String(id)}`, ipVersion: 'auto' },
      intervalSeconds: 60,
      timeoutMs: 30_000,
    });
    const checkResult = (sensorId: number) => ({
      sensorId,
      at: '2026-09-29T10:00:00.000Z',
      outcome: 'ok' as const,
      message: '4/4 replies',
      durationMs: 12,
      channels: [{ key: 'rtt', value: 1.5 }],
    });

    let dir: string;
    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'ms-tls-origin-'));
      generateCerts(dir);
    });

    interface Heard {
      results: { gid: string; probeObjectId: number | null; sensorIds: number[] }[];
      answers: { queryId: string; from: number | null }[];
      progress: { from: number | null; runId: number }[];
      finished: { from: number | null; runId: number }[];
    }

    async function withTwoProbes(
      body: (
        probes: { a: TestProbe; b: TestProbe; port: number },
        endpoint: ProbeEndpoint,
        heard: Heard,
      ) => Promise<void>,
    ): Promise<void> {
      const heard: Heard = { results: [], answers: [], progress: [], finished: [] };
      const endpoint = new ProbeEndpoint({
        config: endpointConfig(dir),
        logger: silentLogger,
        coreVersion: '9.9.9',
        probeConfig: {
          probeObjectFor: (gid) => Promise.resolve(objectOf.get(gid) ?? null),
          assignmentsFor: (id) => {
            const sensors = [assignment(id)];
            return Promise.resolve({ version: fingerprint(sensors), sensors, stamps: new Map() });
          },
          touch: () => Promise.resolve(),
        },
        results: {
          acceptProbeResults: (origin, message) => {
            heard.results.push({ ...origin, sensorIds: message.results.map((r) => r.sensorId) });
            return Promise.resolve({
              type: 'results-ack',
              batchId: message.batchId,
              storedSamples: 0,
              retryAfterMs: 0,
            });
          },
        },
        queries: {
          deliver: (message, from) => heard.answers.push({ queryId: message.queryId, from }),
          probeDisconnected: () => undefined,
        },
        discovery: {
          pump: () => Promise.resolve(),
          progress: (from, runId) => {
            heard.progress.push({ from, runId });
            return Promise.resolve();
          },
          identified: () => Promise.resolve(),
          identifyFinished: () => Promise.resolve(),
          finished: (from, runId) => {
            heard.finished.push({ from, runId });
            return Promise.resolve();
          },
          probeDisconnected: () => Promise.resolve(),
        },
      });
      const address = await endpoint.start();
      const a = await TestProbe.connect(dir, address.port);
      const b = await TestProbe.connect(dir, address.port);
      try {
        a.send(hello({ gid: gidA }));
        await a.waitFor((m) => m.type === 'config-set');
        b.send(hello({ gid: gidB }));
        await b.waitFor((m) => m.type === 'config-set');
        await body({ a, b, port: address.port }, endpoint, heard);
      } finally {
        a.close();
        b.close();
        await endpoint.stop();
      }
    }

    it('tells ingestion which probe object a batch came from', async () => {
      await withTwoProbes(async ({ b }, _endpoint, heard) => {
        b.send({ type: 'results', batchId: 'b-1', results: [checkResult(7)] });
        await b.waitFor((m) => m.type === 'results-ack');
        assert.deepEqual(heard.results, [{ gid: gidB, probeObjectId: 8, sensorIds: [7] }]);
      });
    });

    it('hands a query’s answer over with the probe that sent it, not the one asked', async () => {
      await withTwoProbes(async ({ a, b }, endpoint, heard) => {
        const delivery = endpoint.sendQuery(7, {
          kind: 'ask',
          queryId: 'q-for-a',
          query: { kind: 'check', assignment: assignment(7) },
          timeoutMs: 5_000,
        });
        assert.equal(delivery.kind, 'sent');
        await a.waitFor((m) => m.type === 'query');
        b.send({ type: 'query-result', queryId: 'q-for-a', result: checkResult(7) });
        await waitUntil(() => heard.answers.length === 1);
        assert.deepEqual(heard.answers, [{ queryId: 'q-for-a', from: 8 }]);
      });
    });

    it('hands every discovery message over with the probe that sent it', async () => {
      await withTwoProbes(async ({ b }, _endpoint, heard) => {
        b.send({ type: 'sweep-progress', runId: 5, cursor: 10, found: [], failed: 0 });
        b.send({ type: 'sweep-finished', runId: 5, ending: 'done', cursor: 10, message: '' });
        await waitUntil(() => heard.finished.length === 1);
        assert.deepEqual(heard.progress, [{ from: 8, runId: 5 }]);
        assert.deepEqual(heard.finished, [{ from: 8, runId: 5 }]);
      });
    });

    it('says so when the GID owns no probe object, rather than inventing one', async () => {
      await withTwoProbes(async ({ port }, _endpoint, heard) => {
        const nobody = await TestProbe.connect(dir, port);
        try {
          nobody.send(hello({ gid: gidUnclaimed }));
          await nobody.waitFor((m) => m.type === 'welcome');
          nobody.send({ type: 'results', batchId: 'n-1', results: [checkResult(7)] });
          await nobody.waitFor((m) => m.type === 'results-ack');
          assert.deepEqual(heard.results, [
            { gid: gidUnclaimed, probeObjectId: null, sensorIds: [7] },
          ]);
        } finally {
          nobody.close();
        }
      });
    });
  },
);

/** Polls a condition rather than sleeping a fixed time, so a slow machine is not a failure. */
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
