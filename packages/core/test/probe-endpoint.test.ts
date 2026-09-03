import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type TLSSocket } from 'node:tls';
import { before, describe, it } from 'node:test';
import { pino } from 'pino';
import {
  encodeFrame,
  FrameDecoder,
  PROTOCOL_VERSION,
  type CoreConfig,
  type CoreToProbeMessage,
  type ProbeToCoreMessage,
  type SensorAssignment,
} from '@ms/shared';
import {
  ProbeEndpoint,
  type ProbeQuerySink,
  type ResultReceiver,
} from '../src/transport/probe-endpoint.js';
import { fingerprint, type ProbeAssignments } from '../src/probes/config.js';

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

  issue('core', 'ms-core', 'DNS:localhost,IP:127.0.0.1');
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
        this.received.push(value as CoreToProbeMessage);
        this.#onMessage?.();
      }
    });
    socket.on('error', () => undefined);
  }

  static async connect(dir: string, port: number, certName = 'probe'): Promise<TestProbe> {
    const socket = connect({
      host: '127.0.0.1',
      port,
      cert: await readIfPresent(join(dir, `${certName}.crt`)),
      key: await readIfPresent(join(dir, `${certName}.key`)),
      ca: await readIfPresent(join(dir, 'ca.crt')),
      servername: 'localhost',
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

  it('rejects a probe speaking an incompatible protocol version', async () => {
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir),
      logger: silentLogger,
      coreVersion: '0.1.0',
    });
    const address = await endpoint.start();

    try {
      const probe = await TestProbe.connect(dir, address.port);
      probe.send(hello({ protocolVersion: PROTOCOL_VERSION + 1 }));

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
    const endpoint = new ProbeEndpoint({
      config: endpointConfig(dir),
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

      await first.waitForClose();
      assert.equal(endpoint.connectedProbes.length, 1, 'a reconnect must not leave two sessions');

      second.close();
    } finally {
      await endpoint.stop();
    }
  });

  it('acknowledges a results batch', async () => {
    const received: string[] = [];
    const results: ResultReceiver = {
      acceptResults: (source, message) => {
        received.push(`${source}/${message.batchId}`);
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
      acceptResults: async (_source, message) => {
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

      probeObjectFor(): Promise<number | null> {
        return Promise.resolve(this.claimed);
      }
      assignmentsFor(): Promise<ProbeAssignments> {
        return Promise.resolve({
          version: fingerprint(this.sensors, this.stamps),
          sensors: [...this.sensors],
          stamps: new Map(this.stamps),
        });
      }
      touch(objectId: number): Promise<void> {
        this.touched.push(objectId);
        return Promise.resolve();
      }
    }

    async function withProbe(
      source: StubSource,
      body: (probe: TestProbe, endpoint: ProbeEndpoint) => Promise<void>,
      helloOverrides: Partial<Extract<ProbeToCoreMessage, { type: 'hello' }>> = {},
      queries?: ProbeQuerySink,
    ): Promise<void> {
      const endpoint = new ProbeEndpoint({
        config: endpointConfig(dir),
        logger: silentLogger,
        coreVersion: '9.9.9',
        probeConfig: source,
        ...(queries === undefined ? {} : { queries }),
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

/** Polls a condition rather than sleeping a fixed time, so a slow machine is not a failure. */
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
