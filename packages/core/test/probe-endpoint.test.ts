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
} from '@ms/shared';
import { ProbeEndpoint, type ResultReceiver } from '../src/transport/probe-endpoint.js';

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
