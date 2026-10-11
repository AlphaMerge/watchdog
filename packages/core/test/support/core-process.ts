import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { DatabaseConfig } from '@ms/shared';
import { within } from './within.js';

/**
 * The core as a process (`P-331`).
 *
 * **Every other test in this package constructs a part**, and `main.ts` is what wires them: a
 * pass started unawaited, the shutdown hook that waits for it, the handler that logs its failure.
 * None of that is reached by constructing the part, so this starts `dist/src/main.js serve` the
 * way a service manager does — a configuration file, a real database, real certificates, and
 * nothing injected. The probe's `probe-process.ts` is the same idea for the other side.
 */

/** At runtime this file is `dist/test/support/core-process.js`. */
const MAIN = join(import.meta.dirname, '..', '..', 'src', 'main.js');

export const opensslAvailable = ((): boolean => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

/** A CA and a core certificate for 127.0.0.1, in `dir`: what the probe endpoint listens with. */
export function generateCoreCerts(dir: string): void {
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
  run(['req', ...key, '-keyout', 'core.key', '-out', 'core.csr', '-subj', '/CN=ms-core']);
  writeFileSync(join(dir, 'core.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n', 'utf8');
  run([
    'x509',
    '-req',
    '-in',
    'core.csr',
    '-CA',
    'ca.crt',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'core.crt',
    '-days',
    '2',
    '-sha256',
    '-extfile',
    'core.ext',
  ]);
}

/** A TCP port nothing holds now. Asked by taking one and giving it back. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

export interface RunningCore {
  /** Every line the core has logged so far, parsed. */
  readonly logs: () => readonly Record<string, unknown>[];
  /** Where its API listens. */
  readonly apiPort: number;
  /** Sends SIGTERM, as a service manager does, and resolves with the exit code. */
  readonly stop: () => Promise<number | null>;
  /** Its exit code, once it has exited and both pipes have ended, however it came to. */
  readonly exited: Promise<number | null>;
}

/**
 * Starts `ms-core serve` against `database`, with `dir` holding the certificates and its data.
 *
 * The environment is the caller's with every `MS_*` variable removed, as the probe harness does:
 * the development container sets some, and a core that read its database from one of them would
 * be testing the container. `env` adds the overrides a test wants, in the same `MS_*` form an
 * operator uses.
 */
export async function startCore(options: {
  dir: string;
  database: DatabaseConfig;
  logLevel?: string;
  env?: Readonly<Record<string, string>>;
}): Promise<RunningCore> {
  const { dir, database } = options;
  const apiPort = await freePort();
  const probePort = await freePort();
  const dataDir = join(dir, `data-${String(process.hrtime.bigint())}`);
  const programs = join(dir, 'notifications');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(programs, { recursive: true });
  const file = join(dir, `core-${String(process.hrtime.bigint())}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      service: {
        name: 'ms-core',
        dataDir,
        logLevel: options.logLevel ?? 'info',
        logPretty: false,
        shutdownTimeoutMs: 15_000,
      },
      api: {
        host: '127.0.0.1',
        port: apiPort,
        webRoot: '',
        allowedOrigins: [],
        requireAuthentication: true,
      },
      database: {
        host: database.host,
        port: database.port,
        database: database.database,
        user: database.user,
        password: database.password,
        ssl: false,
        poolSize: 5,
        connectTimeoutMs: 5_000,
        autoMigrate: false,
      },
      probeEndpoint: {
        host: '127.0.0.1',
        port: probePort,
        tls: {
          certFile: join(dir, 'core.crt'),
          keyFile: join(dir, 'core.key'),
          caFile: join(dir, 'ca.crt'),
        },
        accessKeys: ['test-access-key'],
        handshakeTimeoutMs: 10_000,
        heartbeatIntervalMs: 2_000,
      },
      notifications: {
        publicUrl: `http://127.0.0.1:${String(apiPort)}`,
        siteName: 'Core under test',
        program: { directory: programs },
      },
    }),
    'utf8',
  );

  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('MS_') && name !== 'NOTIFY_SOCKET') env[name] = value;
  }
  Object.assign(env, options.env);

  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    [MAIN, 'serve', '--config', file],
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
    // `close`, not `exit`: it comes after both pipes have ended, so every line the core logged
    // on its way out has been read by the time a test looks.
    child.once('close', (code) => {
      resolve(code);
    });
  });

  return {
    logs: () => lines,
    apiPort,
    exited,
    stop: async () => {
      if (child.exitCode !== null) return child.exitCode;
      child.kill('SIGTERM');
      try {
        return await within(30_000, 'the core to stop', exited);
      } catch (error) {
        child.kill('SIGKILL');
        throw error;
      }
    },
  };
}
