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
import { loopbackV6Available } from './support/probe-process.js';
import { pollWithin } from './support/within.js';

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
  // A core reached by its IPv6 address (`A-67`), and one whose certificate is for elsewhere.
  issue('core-v6', 'ms-core', 'IP:::1');
  issue('core-elsewhere', '::1', 'DNS:::1,IP:::2,IP:127.0.0.2');
  issue('probe', 'ms-probe', null);
}

/** A minimal core: enough to drive the real client without pulling in the whole endpoint. */
class TestCore {
  readonly received: ProbeToCoreMessage[] = [];
  /** Handshakes completed: a probe that presented a certificate this core's CA signed. */
  secured = 0;
  #server: Server | undefined;
  #socket: TLSSocket | undefined;
  #onMessage: (() => void) | undefined;
  #decoder = new FrameDecoder();

  static async start(
    dir: string,
    listen: { host: string; certificate: string } = { host: '127.0.0.1', certificate: 'core' },
  ): Promise<{ core: TestCore; port: number }> {
    const core = new TestCore();
    const { readFile } = await import('node:fs/promises');
    const server = createServer({
      cert: await readFile(join(dir, `${listen.certificate}.crt`)),
      key: await readFile(join(dir, `${listen.certificate}.key`)),
      ca: await readFile(join(dir, 'ca.crt')),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
    // A probe that refuses this core's certificate ends the handshake; that is the probe's
    // verdict, read from its own log, and nothing for the server to throw.
    server.on('tlsClientError', () => undefined);
    server.on('secureConnection', (socket) => {
      core.secured += 1;
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
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, listen.host, () => {
        server.removeListener('error', reject);
        resolve();
      });
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

function probeConfig(dir: string, port: number, host = '127.0.0.1'): ProbeConfig {
  // Every default from the schema, then only what this test actually cares about. Hand-writing
  // the whole shape would go stale the first time a field was added.
  const { config } = loadConfig({ schema: probeConfigSchema, env: {}, argv: [] });
  config.probe.spoolDir = mkdtempSync(join(tmpdir(), 'ms-probe-spool-'));
  config.probe.displayName = 'test probe';
  config.core.host = host;
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

        await waitUntil(() => applied.length === 2, 'the probe to keep its assignments');
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
        await waitUntil(() => applied.length === 2, 'the probe to keep its assignments');

        // The core closes the link after refusing; the client reconnects on its own.
        core.closeLink();
        const hellos = () => core.received.filter((m) => m.type === 'hello');
        await waitUntil(() => hellos().length >= 2, 'the probe to come back');

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

describe(
  'the probe’s core client, at the heartbeat',
  { skip: opensslAvailable ? false : 'openssl is not available' },
  () => {
    let dir: string;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'ms-probe-tls-'));
      generateCerts(dir);
    });

    /** A client whose health report records what it was asked with, welcomed at `version`. */
    async function heartbeating(
      version: number,
      body: (
        core: TestCore,
        asked: { seq: number; peerVersion: number }[],
        acked: number[],
      ) => Promise<void>,
    ): Promise<void> {
      const { core, port } = await TestCore.start(dir);
      const asked: { seq: number; peerVersion: number }[] = [];
      const acked: number[] = [];
      const client = new CoreClient({
        config: probeConfig(dir, port),
        logger: silentLogger,
        agentVersion: '0.1.0',
        onConfig: () => 0,
        health: {
          report: (heartbeat) => {
            asked.push(heartbeat);
            return { memoryMb: 1 };
          },
          acknowledged: (seq) => {
            acked.push(seq);
          },
        },
      });
      try {
        client.start();
        await core.waitFor((m) => m.type === 'hello');
        core.send({
          type: 'welcome',
          protocolVersion: version,
          coreVersion: '9.9.9',
          gid: 'probe-live',
          heartbeatIntervalMs: 1_000,
          approved: true,
        });
        await body(core, asked, acked);
      } finally {
        await client.stop();
        await core.stop();
      }
    }

    it('tells the report which heartbeat it is for, and when the core has it (P-219)', async () => {
      // From protocol 20 a report covers exactly the time since the last heartbeat the core
      // acknowledged, so the reporter has to know both.
      await heartbeating(PROTOCOL_VERSION, async (core, asked, acked) => {
        const beat = await core.waitFor((m) => m.type === 'heartbeat');
        assert.ok(beat.type === 'heartbeat');
        assert.deepEqual(beat.health, { memoryMb: 1 });
        assert.deepEqual(asked[0], { seq: beat.seq, peerVersion: PROTOCOL_VERSION });
        assert.deepEqual(acked, [], 'nothing is delivered until the core says so');
        core.send({ type: 'heartbeat-ack', seq: beat.seq });
        await waitUntil(() => acked.length === 1, 'the acknowledgement to be passed on');
        assert.deepEqual(acked, [beat.seq]);
      });
    });

    it('sends a heartbeat the moment it is welcomed, before anything can see it connected (`P-283` review)', async () => {
      // The core takes a probe it meets for the first time as a baseline from the first report of
      // the session. The drain sends once the client is `connected`, so a report made before that
      // holds nothing the drain has discarded on this link, and what it discards next is counted.
      // A heartbeat interval of a minute, so the one that arrives is the one sent at the welcome.
      const { core, port } = await TestCore.start(dir);
      const connectedWhenReported: boolean[] = [];
      const client: CoreClient = new CoreClient({
        config: probeConfig(dir, port),
        logger: silentLogger,
        agentVersion: '0.1.0',
        onConfig: () => 0,
        health: {
          report: () => {
            connectedWhenReported.push(client.connected);
            return { memoryMb: 1 };
          },
          acknowledged: () => undefined,
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
        const beat = await core.waitFor((m) => m.type === 'heartbeat');
        assert.ok(beat.type === 'heartbeat');
        assert.equal(beat.seq, 1);
        assert.deepEqual(connectedWhenReported, [false], 'reported before the drain could send');
        await waitUntil(() => client.connected, 'the client to say it was connected');
      } finally {
        await client.stop();
        await core.stop();
      }
    });

    it('reports at the version the two ends speak, so a 19 core gets what it records (P-219)', async () => {
      await heartbeating(19, async (core, asked) => {
        await core.waitFor((m) => m.type === 'heartbeat');
        assert.equal(asked[0]?.peerVersion, 19);
      });
    });
  },
);

/** Whether `::1` can be bound here. Asked once, before the cases are declared. */
const v6 = await loopbackV6Available();
const needsV6 = { skip: v6 ? false : 'this machine has no IPv6 loopback (::1) to listen on' };

describe(
  'the probe’s core client, proving the core is the one it was pointed at (A-67)',
  { skip: opensslAvailable ? false : 'openssl is not available' },
  () => {
    let dir: string;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'ms-probe-tls-'));
      generateCerts(dir);
    });

    /**
     * A real client pointed at `host`, against a core listening on `listen.host` under
     * `listen.certificate`. `lines` is everything the client logged at `warn` and above.
     */
    async function pointedAt(
      host: string,
      listen: { host: string; certificate: string },
      body: (ctx: { core: TestCore; client: CoreClient; lines: string[] }) => Promise<void>,
    ): Promise<void> {
      const { core, port } = await TestCore.start(dir, listen);
      const lines: string[] = [];
      const client = new CoreClient({
        config: probeConfig(dir, port, host),
        logger: pino(
          { level: 'warn' },
          {
            write: (line: string) => {
              lines.push(line);
            },
          },
        ),
        agentVersion: '0.1.0',
        onConfig: () => 0,
      });
      try {
        client.start();
        await body({ core, client, lines });
      } finally {
        await client.stop();
        await core.stop();
      }
    }

    /**
     * Waits, with a bound, for the client to log a failed connection that says `what`, and
     * returns the line. On a timeout the error carries what it did log.
     */
    async function failure(lines: string[], what: RegExp): Promise<string> {
      const failed = (): string | undefined =>
        lines.find((line) => line.includes('connection to core failed') && what.test(line));
      try {
        await waitUntil(
          () => failed() !== undefined,
          `a failed connection that says ${String(what)}`,
        );
      } catch (error: unknown) {
        throw new Error(`${String(error)}; logged ${JSON.stringify(lines)}`);
      }
      return failed() ?? '';
    }

    it('connects to a core given as ::1 whose certificate lists ::1', needsV6, async () => {
      // Before `A-67` this never said hello: Node read `::1` as a name, no certificate has that
      // name, and the probe retried for ever against a core that was exactly right.
      await pointedAt('::1', { host: '::1', certificate: 'core-v6' }, async ({ core, lines }) => {
        const hello = await core.waitFor((m) => m.type === 'hello');
        assert.equal(hello.type, 'hello');
        // Mutual: the core saw a certificate its own CA signed, by its own rule.
        assert.equal(core.secured, 1);
        assert.deepEqual(lines, [], 'the client complained on the way');
      });
    });

    it(
      'refuses a core at ::1 whose certificate does not list ::1, and says nothing to it',
      needsV6,
      async () => {
        // The same CA, so the chain is trusted and only who the certificate is for can refuse
        // it: one for 127.0.0.1 and `localhost`, and one that has `::1` only as a name and lists
        // other addresses.
        for (const certificate of ['core', 'core-elsewhere']) {
          await pointedAt('::1', { host: '::1', certificate }, async ({ core, client, lines }) => {
            const line = await failure(lines, /IP: ::1 is not in the cert's list/);
            assert.match(line, /ERR_TLS_CERT_ALTNAME_INVALID/, certificate);
            assert.deepEqual(core.received, [], `${certificate}: the probe spoke to it`);
            assert.notEqual(client.state, 'connected');
            assert.notEqual(client.state, 'handshaking');
          });
        }
      },
    );

    it('still refuses a core at 127.0.0.1 whose certificate is for another address', async () => {
      await pointedAt(
        '127.0.0.1',
        { host: '127.0.0.1', certificate: 'core-v6' },
        async ({ core, lines }) => {
          await failure(lines, /IP: 127\.0\.0\.1 is not in the cert's list/);
          assert.deepEqual(core.received, []);
        },
      );
    });

    it('checks a core given by name against the name, as Node does', async () => {
      // `localhost` is in the first certificate and not in the second, which lists only an
      // address: refused in Node's own words for a name, not in the shared check's for an address. Whichever loopback the name resolves to first, the core is on 127.0.0.1 and
      // Node tries both.
      const listen = { host: '127.0.0.1', certificate: 'core' };
      await pointedAt('localhost', listen, async ({ core }) => {
        await core.waitFor((m) => m.type === 'hello');
      });
      await pointedAt(
        'localhost',
        { host: '127.0.0.1', certificate: 'core-v6' },
        async ({ core, lines }) => {
          // No name at all in that certificate but its common name, which is what Node says.
          await failure(lines, /Host: localhost\. is not cert's CN: ms-core/);
          assert.deepEqual(core.received, []);
        },
      );
    });
  },
);

/** Polls a condition, because the client acts on a message without answering it. */
function waitUntil(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  return pollWithin(timeoutMs, what, condition, 10);
}
