import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { after, before, beforeEach, describe, it } from 'node:test';
import ssh2, { type Client, type ClientChannel } from 'ssh2';
import { TestSshServer } from '@ms/simulators';
import { within } from './support/within.js';

/**
 * What `P-259` takes from `ssh2` that is not its public API, each by name (`P-280`).
 *
 * Three things, and an upgrade could take any of them away or change what it means without a
 * compile error or a failing test that says why:
 *
 * - **`ClientChannel.incoming.state`** (`session.ts`): `'open'`, then `'eof'` or `'closed'` as the
 *   server's EOF and CLOSE are parsed. Read when the connection goes, to tell a command the server
 *   had finished from one it took with it.
 * - **`Protocol#channelEOF(recipient)` with the server channel's `outgoing.id`** (the simulator's
 *   `eof-then-exit`): an EOF the server channel's own state does not hear of, so it still sends an
 *   exit status after it, as Dropbear does.
 * - **`Protocol#disconnect(reason)`** (the simulator's `disconnect-lost`): a DISCONNECT with a
 *   reason other than "by application", which the client reports as an `error` carrying the reason.
 *
 * `ssh2`'s version is pinned (`1.17.0`); ADR-001's note on it says to run this on any change.
 */

const require = createRequire(import.meta.url);

let server: TestSshServer;

before(async () => {
  server = await TestSshServer.start();
});

after(async () => {
  await server.stop();
});

beforeEach(() => {
  server.reset();
});

/** A bare `ssh2` client, authenticated against the simulator, with no layer of ours in between. */
async function connected(): Promise<{ client: Client; errors: (Error & { code?: unknown })[] }> {
  const client = new ssh2.Client();
  const errors: (Error & { code?: unknown })[] = [];
  client.on('error', (error) => {
    errors.push(error);
  });
  await within(
    5_000,
    'the client to authenticate',
    new Promise<void>((resolve) => {
      client.on('ready', () => {
        resolve();
      });
      client.connect({
        host: server.host,
        port: server.port,
        username: 'monitor',
        password: 'monitor',
        hostVerifier: () => true,
        readyTimeout: 5_000,
      });
    }),
  );
  return { client, errors };
}

function exec(client: Client, command: string): Promise<ClientChannel> {
  return within(
    5_000,
    `a channel for ${command}`,
    new Promise<ClientChannel>((resolve, reject) => {
      client.exec(command, (error, channel) => {
        if (error) reject(error);
        else resolve(channel);
      });
    }),
  );
}

/**
 * Runs `command` and resolves on its channel's `event`, with the server's state as read then.
 * Listened for inside the callback: what the server sends can arrive in the same read as the
 * channel's confirmation, before an awaiting caller resumes.
 */
function stateAt(client: Client, command: string, event: 'end' | 'close'): Promise<string> {
  return within(
    5_000,
    `the ${event} of ${command}`,
    new Promise<string>((resolve, reject) => {
      client.exec(command, (error, channel) => {
        if (error) {
          reject(error);
          return;
        }
        channel.on(event, () => {
          resolve(channel.incoming.state);
        });
        channel.resume();
      });
    }),
  );
}

describe('the ssh2 internals P-259 relies on (P-280)', () => {
  it('ssh2 is the pinned version, in both packages that use it', () => {
    const version = (from: string): unknown =>
      (
        JSON.parse(readFileSync(createRequire(from).resolve('ssh2/package.json'), 'utf8')) as {
          version?: unknown;
        }
      ).version;
    assert.equal(version(import.meta.url), '1.17.0', 'the sensors package’s ssh2');
    assert.equal(
      version(require.resolve('@ms/simulators')),
      '1.17.0',
      'the simulators package’s ssh2',
    );
  });

  it('Protocol#channelEOF(recipient) and Protocol#disconnect(reason) still exist', () => {
    const exported: unknown = require('ssh2/lib/protocol/Protocol.js');
    assert.equal(typeof exported, 'function', 'lib/protocol/Protocol.js exports a class');
    const prototype = (exported as { prototype: Record<string, unknown> }).prototype;
    for (const name of ['channelEOF', 'disconnect']) {
      const method = prototype[name];
      assert.equal(typeof method, 'function', `Protocol#${name} is gone`);
      assert.equal(
        (method as (...args: unknown[]) => unknown).length,
        1,
        `Protocol#${name} takes one argument`,
      );
    }
  });

  it('ClientChannel.incoming.state reads open while the server is running the command', async () => {
    server.behave({ password: 'monitor', hang: true });
    const { client } = await connected();
    try {
      const channel = await exec(client, 'sleep 9999');
      assert.equal(channel.incoming.state, 'open');
    } finally {
      client.end();
    }
  });

  it('ClientChannel.incoming.state reads eof once the server sent EOF, and closed after CLOSE', async () => {
    server.answer('eof', { stdout: 'x\n', ending: 'eof' });
    server.answer('close', { stdout: 'x\n', ending: 'close' });
    const { client } = await connected();
    try {
      assert.equal(await stateAt(client, 'eof', 'end'), 'eof', 'EOF alone');
      assert.equal(await stateAt(client, 'close', 'close'), 'closed', 'EOF then CLOSE');
    } finally {
      client.end();
    }
  });

  it('Protocol#channelEOF with the server channel’s outgoing.id ends that channel, and the exit status still follows', async () => {
    // The simulator's `eof-then-exit`: what a server that sends its exit status after EOF looks
    // like. A wrong id would end another channel, or none, and the client would see no EOF here.
    server.answer('late', { stdout: 'x\n', code: 3, ending: 'eof-then-exit' });
    const { client } = await connected();
    try {
      // Listened for inside the callback: the status can arrive in the same read as the channel's
      // confirmation, and `ssh2` emits `exit` as it parses it, before an awaiting caller resumes.
      const exited = within(
        5_000,
        'the exit status',
        new Promise<{ code: number | null; state: string }>((resolve, reject) => {
          client.exec('late', (error, channel) => {
            if (error) {
              reject(error);
              return;
            }
            channel.on('exit', (code) => {
              resolve({ code, state: channel.incoming.state });
            });
            channel.resume();
          });
        }),
      );
      // `state` is the proof the EOF was this channel's and came first. The stream's `end` is no
      // proof: it may not have been emitted yet when the status is parsed.
      assert.deepEqual(
        await exited,
        { code: 3, state: 'eof' },
        'the status, after an EOF on this channel',
      );
    } finally {
      client.end();
    }
  });

  it('Protocol#disconnect(reason) reaches the client as an error carrying the reason', async () => {
    // The simulator's `disconnect-lost`, reason 10 (SSH_DISCONNECT_CONNECTION_LOST). `session.ts`
    // keeps that error as what the connection reported as it went.
    server.answer('lost', { stdout: 'x\n', then: 'disconnect-lost' });
    const { client, errors } = await connected();
    try {
      // Listened for before the command: the DISCONNECT follows its answer at once.
      const closed = within(
        5_000,
        'the client to close',
        new Promise<void>((resolve) => {
          client.on('close', () => {
            resolve();
          });
        }),
      );
      const channel = await exec(client, 'lost');
      channel.resume();
      await closed;
      const reported = errors.find((error) => error.code === 10);
      assert.ok(
        reported !== undefined,
        `an error with code 10; heard ${JSON.stringify(errors.map((one) => one.code))}`,
      );
      assert.equal(reported.message, 'CONNECTION_LOST');
    } finally {
      client.end();
    }
  });
});
