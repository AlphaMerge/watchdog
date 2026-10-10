import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, connect as connectSocket, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  databaseAvailable,
  probeDatabase,
  probeOptions,
  testDatabaseConfig,
} from './support/database.js';
import { within } from './support/within.js';

/**
 * `P-397`. A full core run reported `tests 5213, skipped 0` where the one before had 5,242:
 * `credential-pinning.test.ts` had read a reachable PostgreSQL as absent on a single failed
 * connect, and its 29-test `describe` skipped without moving the summary's `skipped`.
 */

const available = await databaseAvailable();

const supportUrl = new URL('./support/database.js', import.meta.url).href;
const runSetup = fileURLToPath(new URL('./support/database-run.js', import.meta.url));

const quick = { attempts: 4, backoffMs: [1, 2, 3], attemptMs: 200 };

describe('probeDatabase', () => {
  it('reads a first connect that fails as a retry, not as an absent database', async () => {
    let calls = 0;
    const probe = await probeDatabase(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('sorry, too many clients already'))
        : Promise.resolve();
    }, quick);
    assert.equal(probe.reachable, true);
    assert.equal(calls, 2);
    assert.equal(probe.failures.length, 1);
    assert.match(
      probe.failures[0] ?? '',
      /^attempt 1 after \d+ ms: sorry, too many clients already$/,
    );
  });

  it('answers false after every attempt has failed, and says what each one heard', async () => {
    let calls = 0;
    const probe = await probeDatabase(() => {
      calls += 1;
      return Promise.reject(new Error(`refused ${String(calls)}`));
    }, quick);
    assert.equal(probe.reachable, false);
    assert.equal(calls, 4);
    assert.deepEqual(
      probe.failures.map((line) => line.replace(/after \d+ ms/, 'after N ms')),
      [1, 2, 3, 4].map((n) => `attempt ${String(n)} after N ms: refused ${String(n)}`),
    );
  });

  it('gives up on a connect that never settles at its bound, and tries again', async () => {
    let calls = 0;
    const probe = await within(
      5_000,
      'the probe to give up on a hung connect',
      probeDatabase(
        () => {
          calls += 1;
          return calls === 1 ? new Promise<void>(() => undefined) : Promise.resolve();
        },
        { attempts: 2, backoffMs: [1], attemptMs: 50 },
      ),
    );
    assert.equal(probe.reachable, true);
    assert.match(probe.failures[0] ?? '', /timed out after 50 ms/);
  });

  it('waits the backoff between attempts, repeating the last', async () => {
    const started = Date.now();
    await probeDatabase(() => Promise.reject(new Error('no')), {
      attempts: 4,
      backoffMs: [40, 80],
      attemptMs: 200,
    });
    // 40 + 80 + 80.
    assert.ok(Date.now() - started >= 195, `took ${String(Date.now() - started)} ms`);
  });
});

describe('probeOptions', () => {
  it('asks once in a run that found no database, and retries otherwise', () => {
    assert.equal(probeOptions('0').attempts, 1);
    assert.equal(probeOptions('1').attempts, 4);
    assert.equal(probeOptions(undefined).attempts, 4);
    for (const required of ['0', '1', undefined]) {
      assert.ok(probeOptions(required).attemptMs > testDatabaseConfig().connectTimeoutMs);
    }
  });
});

/**
 * A database file the way every one is written, run by `node --test` in a process of its own, so
 * what is read is the summary a person reads.
 */
describe('a database file in a run', () => {
  let dir = '';
  let fixture = '';

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ms-p395-'));
    fixture = join(dir, 'fixture.test.mjs');
    await writeFile(
      fixture,
      `import { describe, it } from 'node:test';\n` +
        `import { databaseAvailable } from ${JSON.stringify(supportUrl)};\n` +
        `const available = await databaseAvailable();\n` +
        `describe('a database suite', { skip: available ? false : 'no PostgreSQL reachable' }, () => {\n` +
        `  it('one', () => {});\n` +
        `  it('two', () => {});\n` +
        `});\n`,
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fails, not skips, when the run expects a database the file cannot reach', async () => {
    const port = await closedPort();
    const run = await nodeTest([fixture], {
      MS_TEST_DB_PORT: String(port),
      MS_TEST_DB_REQUIRED: '1',
    });
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, /^ℹ fail 1$/m);
    assert.match(run.output, /this run expects PostgreSQL \(MS_TEST_DB_REQUIRED=1\)/);
    // All four attempts, each named, so the failure says why.
    assert.match(run.output, /attempt 4 after \d+ ms/);
  });

  it('counts the skip in the summary when the run found no database', async () => {
    const port = await closedPort();
    const run = await nodeTest([fixture], {
      MS_TEST_DB_PORT: String(port),
      MS_TEST_DB_REQUIRED: '0',
    });
    assert.equal(run.code, 0, run.output);
    assert.match(
      run.output,
      /^ℹ skipped 1$/m,
      'a skipped database suite must not read as skipped 0',
    );
    assert.match(run.output, /no PostgreSQL reachable/);
  });

  it('decides once, before any file starts, from the run setup', async () => {
    const port = await closedPort();
    const run = await nodeTest([`--test-global-setup=${runSetup}`, fixture], {
      MS_TEST_DB_PORT: String(port),
      MS_TEST_DB_REQUIRED: undefined,
    });
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, /did not answer, so this run's database suites skip/);
    assert.match(run.output, /^ℹ skipped 1$/m);
  });

  /**
   * The incident itself: PostgreSQL is there, and the first connect to it fails. A proxy in front
   * of it drops the first connection it is handed and passes the rest through.
   */
  it(
    'runs the suite when the first connect to a reachable database fails',
    { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
    async () => {
      const config = testDatabaseConfig();
      let accepted = 0;
      const sockets = new Set<Socket>();
      const proxy = createServer((client) => {
        accepted += 1;
        sockets.add(client);
        if (accepted === 1) {
          client.destroy();
          return;
        }
        const upstream = connectSocket(config.port, config.host);
        sockets.add(upstream);
        client.pipe(upstream).pipe(client);
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
      });
      const port = await listen(proxy);
      try {
        const run = await nodeTest([fixture], {
          MS_TEST_DB_PORT: String(port),
          MS_TEST_DB_REQUIRED: '1',
        });
        assert.equal(run.code, 0, run.output);
        assert.match(run.output, /^ℹ pass 2$/m);
        assert.match(run.output, /^ℹ skipped 0$/m);
        assert.ok(accepted >= 2, `the proxy saw ${String(accepted)} connection(s)`);
      } finally {
        for (const socket of sockets) socket.destroy();
        await within(5_000, 'the proxy to close', new Promise((resolve) => proxy.close(resolve)));
      }
    },
  );
});

async function listen(server: Server): Promise<number> {
  await within(
    5_000,
    'a local port to listen on',
    new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)),
  );
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return address.port;
}

/** A port nothing listens on, so a connect to it is refused at once. */
async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await within(
    5_000,
    'the borrowed port to close',
    new Promise((resolve) => server.close(resolve)),
  );
  return port;
}

/** `node --test` on `args`, against 127.0.0.1, with its whole output; killed at its bound. */
async function nodeTest(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number | null; output: string }> {
  // Without `NODE_TEST_CONTEXT` the child is a run of its own, not a file of this one; an
  // `undefined` in `env` leaves that variable out.
  const merged: Record<string, string | undefined> = {
    ...process.env,
    MS_TEST_DB_HOST: '127.0.0.1',
    ...env,
  };
  const childEnv = Object.fromEntries(
    Object.entries(merged).filter(
      ([key, value]) => key !== 'NODE_TEST_CONTEXT' && value !== undefined,
    ),
  );
  const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...args], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  try {
    const code = await within(
      30_000,
      () => `node --test ${args.join(' ')} to finish; it printed:\n${output}`,
      new Promise<number | null>((resolve) => child.on('close', resolve)),
    );
    return { code, output };
  } finally {
    child.kill('SIGKILL');
  }
}
