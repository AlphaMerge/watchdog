import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { createServer, type Server, type TLSSocket } from 'node:tls';
import {
  encodeFrame,
  FrameDecoder,
  parseProbeToCore,
  PROTOCOL_VERSION,
  type CoreToProbeMessage,
  type ProbeToCoreMessage,
  type SensorAssignment,
} from '@ms/shared';

/**
 * The probe as a process, with a core on the other end of its link (`B-07`).
 *
 * **Every other test in this package constructs a part.** The listener tests construct a
 * listener, the health tests construct a reporter, the dispatch tests construct a dispatcher —
 * and each was green while `main.ts` constructed no flow collector at all, because none of them
 * had to start the probe. `P-61` and `P-64` were the same shape: numbers computed and read by
 * nobody. What catches that shape is the composition root running, so this starts
 * `dist/src/main.js` the way a service manager does: a configuration file, a real TLS link, and
 * nothing injected.
 */

/** At runtime this file is `dist/test/support/probe-process.js`. */
const MAIN = join(import.meta.dirname, '..', '..', 'src', 'main.js');

export const opensslAvailable = ((): boolean => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

/** A CA, a core certificate for 127.0.0.1 and a probe certificate, in `dir`. */
export function generateCerts(dir: string): void {
  const run = (args: string[]): void => {
    execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  };
  const key = ['-newkey', 'rsa:2048', '-sha256', '-nodes'];
  run([
    'req',
    '-x509',
    ...key,
    '-days',
    '2',
    '-keyout',
    'ca.key',
    '-out',
    'ca.crt',
    '-subj',
    '/CN=test-ca',
  ]);
  const issue = (name: string, cn: string, san: string | null): void => {
    run(['req', ...key, '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${cn}`]);
    const extension: string[] = [];
    if (san !== null) {
      writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\n`, 'utf8');
      extension.push('-extfile', `${name}.ext`);
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
      ...extension,
    ]);
  };
  issue('core', 'ms-core', 'DNS:localhost,IP:127.0.0.1');
  issue('probe', 'ms-probe', null);
}

/** Rejects after `ms`, naming what was being waited for: a test's own timeout does not stop it. */
export async function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${String(ms)} ms waiting for ${what}`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A core that welcomes one probe, hands it its sensors and acknowledges what it sends.
 *
 * Enough of the protocol for the probe to behave as it does against a real one — it is welcomed
 * at a version, takes a configuration, has its batches and heartbeats acknowledged — and nothing
 * that decides anything, so what the test reads is what the probe sent.
 */
export class FakeCore {
  readonly received: ProbeToCoreMessage[] = [];
  /** Every TCP connection accepted, handshake or not: what a refused probe must not have made. */
  connections = 0;
  /** Why each message the core's own validator turned away was refused. Empty, if all is well. */
  readonly refused: string[] = [];
  /** What the next `welcome` says this core speaks. An older core is this, lowered. */
  protocolVersion = PROTOCOL_VERSION;
  /**
   * Welcome the probe and hand it nothing until `sendConfig` (`P-254`): a probe that restarted and
   * has its listeners up, before it knows which sensors it holds.
   */
  holdConfig = false;
  readonly #sensors: readonly SensorAssignment[];
  #server: Server | undefined;
  #socket: TLSSocket | undefined;
  #waiting: (() => void)[] = [];

  private constructor(sensors: readonly SensorAssignment[]) {
    this.#sensors = sensors;
  }

  static async start(
    dir: string,
    sensors: readonly SensorAssignment[],
  ): Promise<{ core: FakeCore; port: number }> {
    const core = new FakeCore(sensors);
    const server = createServer({
      cert: readFileSync(join(dir, 'core.crt')),
      key: readFileSync(join(dir, 'core.key')),
      ca: readFileSync(join(dir, 'ca.crt')),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
    server.on('connection', () => {
      core.connections += 1;
    });
    server.on('secureConnection', (socket) => {
      core.#socket = socket;
      // Per connection: a reconnect is a new byte stream.
      const decoder = new FrameDecoder();
      socket.on('data', (chunk: Buffer) => {
        for (const value of decoder.push(chunk)) {
          // Through the validator the real endpoint uses, so a message this build's own core
          // would refuse is a failure here rather than something a lenient stub let past.
          try {
            core.#take(
              parseProbeToCore(value, {
                // The real core fits a result itself and refuses alone one it cannot (`P-281`).
                // A probe since `P-277` sends none it has to, so here one is a refusal too.
                onUnfitResults: (unfit) => {
                  core.refused.push(`results did not fit as sent: ${JSON.stringify(unfit)}`);
                },
              }),
            );
          } catch (error) {
            core.refused.push(error instanceof Error ? error.message : String(error));
          }
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

  #take(message: ProbeToCoreMessage): void {
    this.received.push(message);
    switch (message.type) {
      case 'hello':
        this.#send({
          type: 'welcome',
          protocolVersion: this.protocolVersion,
          coreVersion: '9.9.9',
          gid: 'probe-under-test',
          heartbeatIntervalMs: 1_000,
          approved: true,
        });
        if (!this.holdConfig) this.sendConfig();
        break;
      case 'heartbeat':
        this.#send({ type: 'heartbeat-ack', seq: message.seq });
        break;
      case 'results':
        this.#send({
          type: 'results-ack',
          batchId: message.batchId,
          storedSamples: message.results.length,
          retryAfterMs: 0,
        });
        break;
      default:
        break;
    }
    for (const wake of this.#waiting) wake();
  }

  #send(message: CoreToProbeMessage): void {
    this.#socket?.write(encodeFrame(message));
  }

  /** Hands the probe its sensors, as a whole set: the ones it was started with, unless given. */
  sendConfig(sensors: readonly SensorAssignment[] = this.#sensors): void {
    this.#send({ type: 'config-set', version: 'v1', sensors: [...sensors] });
  }

  /**
   * The first chunk of a split push and nothing after it (`R18`, `P-254`): a set marked not final,
   * as a core sends when a push is above the message cap, before a link that drops.
   */
  sendFirstChunk(sensors: readonly SensorAssignment[]): void {
    this.#send({ type: 'config-set', version: 'v1', sensors: [...sensors], final: false });
  }

  /** Closes the link the way a core restart does. The probe dials again by itself. */
  dropLink(): void {
    this.#socket?.destroy();
    this.#socket = undefined;
  }

  /**
   * The first message at or after `from` that the picker accepts, waited for up to `ms`.
   *
   * `from` is an index into `received`, so a caller can ask for "a heartbeat sent after this
   * point" rather than be handed one from before the thing it just did.
   */
  async waitFor<T>(
    what: string,
    pick: (message: ProbeToCoreMessage) => T | undefined,
    { from = 0, ms = 60_000 }: { from?: number; ms?: number } = {},
  ): Promise<T> {
    const find = (): T | undefined => {
      for (const message of this.received.slice(from)) {
        const picked = pick(message);
        if (picked !== undefined) return picked;
      }
      return undefined;
    };
    let wake: (() => void) | undefined;
    try {
      return await within(
        ms,
        what,
        new Promise<T>((resolve) => {
          wake = (): void => {
            const found = find();
            if (found !== undefined) resolve(found);
          };
          this.#waiting.push(wake);
          wake();
        }),
      );
    } finally {
      this.#waiting = this.#waiting.filter((one) => one !== wake);
    }
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

/** Which loopback a helper below binds: IPv4's, unless a test is about the other family. */
export interface Loopback {
  readonly type: 'udp4' | 'udp6';
  readonly address: string;
}
const LOOPBACK_V4: Loopback = { type: 'udp4', address: '127.0.0.1' };
export const LOOPBACK_V6: Loopback = { type: 'udp6', address: '::1' };

/** A UDP port on a loopback address that was free a moment ago. */
export async function freeUdpPort(on: Loopback = LOOPBACK_V4): Promise<number> {
  const socket = createSocket(on.type);
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, on.address, resolve);
  });
  const { port } = socket.address();
  await new Promise<void>((resolve) => {
    socket.close(() => {
      resolve();
    });
  });
  return port;
}

/**
 * Whether this machine has an IPv6 loopback to bind at all. A container may have none, and a
 * probe told to listen on `::1` there fails for a reason that is not the probe's.
 */
export async function loopbackV6Available(): Promise<boolean> {
  try {
    await freeUdpPort(LOOPBACK_V6);
    return true;
  } catch {
    return false;
  }
}

/** Whether something already holds this UDP port on a loopback — asked by trying to take it. */
export async function udpPortTaken(port: number, on: Loopback = LOOPBACK_V4): Promise<boolean> {
  const socket = createSocket(on.type);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(port, on.address, resolve);
    });
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return true;
    throw error;
  } finally {
    await new Promise<void>((resolve) => {
      try {
        socket.close(() => {
          resolve();
        });
      } catch {
        // Never bound, so there is nothing to close.
        resolve();
      }
    });
  }
}

/** Sends one datagram from a chosen local address, so a test can be a second exporter. */
export async function sendUdp(
  datagram: Buffer,
  to: { host: string; port: number },
  fromAddress?: string,
): Promise<void> {
  const socket = createSocket('udp4');
  try {
    if (fromAddress !== undefined) {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(0, fromAddress, resolve);
      });
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(datagram, to.port, to.host, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } finally {
    socket.close();
  }
}

export interface RunningProbe {
  /** Every line the probe has logged so far, parsed. */
  readonly logs: () => readonly Record<string, unknown>[];
  /** Stops it the way a service manager does, and resolves with its exit code. */
  readonly stop: () => Promise<number | null>;
  /** Its exit code, once it has exited and both pipes have ended, however it came to. */
  readonly exited: Promise<number | null>;
}

/**
 * Starts `ms-probe` against a configuration file.
 *
 * `dir` holds the certificates and takes the spool. The environment is the caller's with every
 * `MS_*` variable removed: the development container sets some, and a probe that read its core's
 * address from one of them would be testing the container.
 */
export function startProbe(options: {
  dir: string;
  corePort: number;
  config: Record<string, unknown>;
  profile?: 'v1' | 'full';
}): RunningProbe {
  const { dir, corePort, config, profile } = options;
  const file = join(dir, `probe-${String(process.hrtime.bigint())}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      service: { dataDir: join(dir, 'data'), logLevel: 'info', logPretty: false },
      probe: {
        displayName: 'probe under test',
        spoolDir: join(dir, `spool-${String(process.hrtime.bigint())}`),
        // Two workers: enough to run a check, and no more start-up than the test needs.
        workerPoolSize: 2,
        workerPoolMinSize: 1,
      },
      core: {
        host: '127.0.0.1',
        port: corePort,
        heartbeatIntervalMs: 1_000,
        reconnectMinDelayMs: 100,
        reconnectMaxDelayMs: 200,
        tls: {
          certFile: join(dir, 'probe.crt'),
          keyFile: join(dir, 'probe.key'),
          caFile: join(dir, 'ca.crt'),
        },
      },
      ...config,
    }),
    'utf8',
  );

  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('MS_') && name !== 'NOTIFY_SOCKET') env[name] = value;
  }
  if (profile !== undefined) env['MS_BUILD_PROFILE'] = profile;

  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    [MAIN, '--config', file],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const lines: Record<string, unknown>[] = [];
  let partial = '';
  const take = (chunk: Buffer): void => {
    partial += chunk.toString('utf8');
    const complete = partial.split('\n');
    partial = complete.pop() ?? '';
    for (const line of complete) {
      if (line.trim() === '') continue;
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Not a log line — a stack trace on stderr, say. Kept, so a failure can show it.
        lines.push({ msg: line });
      }
    }
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);

  const exited = new Promise<number | null>((resolve) => {
    // `close`, not `exit`: it comes after both pipes have ended, so every line the probe logged
    // on its way out has been read by the time a test looks.
    child.once('close', (code) => {
      resolve(code);
    });
  });

  return {
    logs: () => lines,
    exited,
    stop: async () => {
      if (child.exitCode !== null) return child.exitCode;
      child.kill('SIGTERM');
      try {
        return await within(20_000, 'the probe to stop', exited);
      } catch (error) {
        child.kill('SIGKILL');
        throw error;
      }
    },
  };
}
