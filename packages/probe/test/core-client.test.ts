import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type TLSSocket } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { before, describe, it } from 'node:test';
import { pino } from 'pino';
import {
  encodeFrame,
  FrameDecoder,
  loadConfig,
  probeConfigSchema,
  PROTOCOL_VERSION,
  type CoreToProbeMessage,
  type ProbeConfig,
  type ProbeToCoreMessage,
  type SensorAssignment,
} from '@ms/shared';
import { CoreClient, type ConfigUpdate } from '../src/transport/core-client.js';

const silentLogger = pino({ level: 'silent' });

/**
 * The probe's own side of the channel, against a real TLS core (`R-01`).
 *
 * **This file exists because a gap here is invisible everywhere else.** The core's endpoint
 * tests drive a hand-written probe stub, which agrees with whatever the core does by
 * construction; the smoke tests drive the real thing but only end to end, on a packaged box, in
 * minutes. What neither covered is the client's own reading of a message — and "the probe kept
 * scanning after it was refused" is exactly the kind of defect that hides in that gap: nothing
 * fails, nothing logs an error, and a machine somebody revoked carries on probing their network.
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
}

/** A minimal core: enough to drive the real client without pulling in the whole endpoint. */
class TestCore {
  readonly received: ProbeToCoreMessage[] = [];
  #server: Server | undefined;
  #socket: TLSSocket | undefined;
  #onMessage: (() => void) | undefined;
  #decoder = new FrameDecoder();

  static async start(dir: string): Promise<{ core: TestCore; port: number }> {
    const core = new TestCore();
    const { readFile } = await import('node:fs/promises');
    const server = createServer({
      cert: await readFile(join(dir, 'core.crt')),
      key: await readFile(join(dir, 'core.key')),
      ca: await readFile(join(dir, 'ca.crt')),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
    server.on('secureConnection', (socket) => {
      core.#socket = socket;
      // Per connection: a reconnect starts a new byte stream, and carrying a half-read frame
      // across would desynchronise the one thing this harness has to get right.
      core.#decoder = new FrameDecoder();
      socket.on('data', (chunk: Buffer) => {
        for (const value of core.#decoder.push(chunk)) {
          core.received.push(value as ProbeToCoreMessage);
          core.#onMessage?.();
        }
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    core.#server = server;
    return { core, port: (server.address() as AddressInfo).port };
  }

  send(message: CoreToProbeMessage): void {
    this.#socket?.write(encodeFrame(message));
  }

  /** What the endpoint does after refusing one: the message, then the socket. */
  closeLink(): void {
    this.#socket?.destroy();
    this.#socket = undefined;
  }

  /** Resolves when a message satisfying the predicate arrives, or rejects on timeout. */
  async waitFor(
    predicate: (message: ProbeToCoreMessage) => boolean,
    timeoutMs = 5_000,
  ): Promise<ProbeToCoreMessage> {
    const existing = this.received.find(predicate);
    if (existing !== undefined) return existing;
    return new Promise<ProbeToCoreMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#onMessage = undefined;
        reject(new Error(`timed out; saw ${JSON.stringify(this.received)}`));
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

  async stop(): Promise<void> {
    this.#socket?.destroy();
    const server = this.#server;
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

function probeConfig(dir: string, port: number): ProbeConfig {
  // Every default from the schema, then only what this test actually cares about. Hand-writing
  // the whole shape would go stale the first time a field was added.
  const { config } = loadConfig({ schema: probeConfigSchema, env: {}, argv: [] });
  config.probe.spoolDir = mkdtempSync(join(tmpdir(), 'ms-probe-spool-'));
  config.probe.displayName = 'test probe';
  config.core.host = '127.0.0.1';
  config.core.port = port;
  config.core.heartbeatIntervalMs = 60_000;
  // Short enough that a reconnect lands inside the test, long enough not to spin.
  config.core.reconnectMinDelayMs = 50;
  config.core.reconnectMaxDelayMs = 100;
  config.core.tls = {
    certFile: join(dir, 'probe.crt'),
    keyFile: join(dir, 'probe.key'),
    caFile: join(dir, 'ca.crt'),
  };
  return config;
}

const sensor = (id: number): SensorAssignment => ({
  sensorId: id,
  sensorType: 'icmp.ping',
  params: { count: 4 },
  target: { host: `192.0.2.${String(id)}`, ipVersion: 'auto' },
  intervalSeconds: 60,
  timeoutMs: 30_000,
});

const opensslAvailable = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe(
  'the probe’s core client, when the core refuses it',
  { skip: opensslAvailable ? false : 'openssl is not available' },
  () => {
    let dir: string;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'ms-probe-tls-'));
      generateCerts(dir);
    });

    /** Connects a real client to a stub core, hands it two sensors, then runs the body. */
    async function withScanningProbe(
      body: (ctx: { core: TestCore; client: CoreClient; applied: ConfigUpdate[] }) => Promise<void>,
    ): Promise<void> {
      const { core, port } = await TestCore.start(dir);
      const applied: ConfigUpdate[] = [];
      const client = new CoreClient({
        config: probeConfig(dir, port),
        logger: silentLogger,
        agentVersion: '0.1.0',
        onConfig: (update) => {
          applied.push(update);
          return update.kind === 'set' ? update.sensors.length : update.upserted.length;
        },
      });

      try {
        client.start();
        await core.waitFor((m) => m.type === 'hello');
        core.send({
          type: 'welcome',
          protocolVersion: PROTOCOL_VERSION,
          coreVersion: '9.9.9',
          gid: 'probe-live',
          heartbeatIntervalMs: 60_000,
          approved: true,
        });
        core.send({ type: 'config-set', version: 'v1', sensors: [sensor(1), sensor(2)] });
        await core.waitFor((m) => m.type === 'config-ack');
        assert.equal(applied.length, 1, 'the probe did not take its assignments');

        await body({ core, client, applied });
      } finally {
        await client.stop();
        await core.stop();
      }
    }

    it('stops scanning when it is told it has been revoked', async () => {
      // **The assertion this whole file exists for.** Losing the core is a condition the probe
      // survives by scanning on and spooling to disk, and applying that to a revocation leaves a
      // machine somebody just refused probing their network for as long as its process lives.
      await withScanningProbe(async ({ core, applied }) => {
        core.send({
          type: 'reject',
          code: 'revoked',
          message: 'decommissioned, replaced by web-dc4',
        });

        await waitUntil(() => applied.length === 2, 'the probe kept its assignments');
        const cleared = applied[1];
        assert.ok(cleared?.kind === 'set');
        assert.deepEqual(cleared.sensors, [], 'it must be left scanning nothing at all');
      });
    });

    it('forgets the fingerprint with them, or re-approval would scan nothing', async () => {
      // The load-bearing half, and the one that would have been silently wrong: the fingerprint
      // is what the next `hello` presents. Left set, a re-approved probe would claim to be
      // running a configuration it had just thrown away, and the core — agreeing — would answer
      // `config-unchanged` and send nothing. Connected, approved, scanning nothing.
      await withScanningProbe(async ({ core, applied }) => {
        const firstHello = core.received.find((m) => m.type === 'hello');
        assert.ok(firstHello?.type === 'hello');

        core.send({ type: 'reject', code: 'revoked', message: 'this probe has been revoked' });
        await waitUntil(() => applied.length === 2, 'the probe kept its assignments');

        // The core closes the link after refusing; the client reconnects on its own.
        core.closeLink();
        const hellos = () => core.received.filter((m) => m.type === 'hello');
        await waitUntil(() => hellos().length >= 2, 'the probe never came back');

        const second = hellos()[1];
        assert.ok(second?.type === 'hello');
        assert.equal(second.configVersion, '', 'it claimed to still hold what it had dropped');
      });
    });

    it('keeps scanning when the two ends merely cannot agree', async () => {
      // `internal-error` is the core saying it cannot check its own registry right now. Nobody
      // has said this machine must stop, so the spool is exactly right: keep checking, keep the
      // results, drain them when the core is back. Clearing here would turn a blip in the
      // core's database into a hole in everybody's graphs.
      await withScanningProbe(async ({ core, applied }) => {
        core.send({
          type: 'reject',
          code: 'internal-error',
          message: 'this core cannot check probe registrations right now',
        });

        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(applied.length, 1, 'a transient refusal stopped this probe scanning');
      });
    });
  },
);

/** Polls a condition, because the client acts on a message without answering it. */
async function waitUntil(
  condition: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
