import { strict as assert } from 'node:assert';
import { connect, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MuteSshServer, TestSshServer } from '../src/ssh-server.js';

/**
 * The SSH simulator's silent mode (`A-73`).
 *
 * **What every test on it leans on is the silence.** A "mute" server that wrote one byte would
 * turn a test of the connect timeout into a test of a handshake that failed for another reason,
 * and it would still be green. So the claims are held here: it accepts, it says nothing, it hears
 * the client go, it hands a test the connection it asked for, and it stops with a client still
 * attached. That a real SSH client waits out its connect timeout against it is `A-65`'s cases in
 * `packages/sensors/test/ssh-session.test.ts`, which run on this.
 */

/** `promise`, or a failure naming `what` once `ms` have passed. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what} did not happen within ${String(ms)} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('the SSH simulator that accepts and never speaks', () => {
  let mute: MuteSshServer;
  const clients: Socket[] = [];

  beforeEach(async () => {
    mute = await MuteSshServer.start();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    await within(mute.stop(), 2_000, 'the simulator stopping');
  });

  /** A TCP client, connected, with everything it is sent collected. */
  async function dial(): Promise<{ socket: Socket; heard: Buffer[] }> {
    const heard: Buffer[] = [];
    const socket = connect(mute.port, mute.host);
    clients.push(socket);
    socket.on('data', (chunk: Buffer) => heard.push(chunk));
    socket.on('error', () => undefined);
    await within(
      new Promise<void>((resolve) => {
        socket.once('connect', () => {
          resolve();
        });
      }),
      2_000,
      'connecting',
    );
    return { socket, heard };
  }

  it('accepts a connection, counts it, and sends it nothing', async () => {
    assert.equal(mute.host, '127.0.0.1');
    assert.ok(mute.port > 0);
    const arriving = mute.next();
    const { socket, heard } = await dial();
    await within(arriving, 2_000, 'the simulator accepting');
    assert.equal(mute.connections, 1);
    assert.equal(mute.open, 1);

    // An SSH client speaks first or at once; this never answers, whatever it is sent.
    socket.write('SSH-2.0-test\r\n');
    await sleep(300);
    assert.deepEqual(heard, [], 'the mute server spoke');
    assert.equal(socket.destroyed, false, 'and it did not hang up either');
  });

  it('hears the client go, and hands over the connection that was asked for', async () => {
    const first = mute.next();
    const one = await dial();
    const accepted = await within(first, 2_000, 'the first connection');
    // Asked for after the first was accepted: this is the second, not the first again.
    const second = mute.next();
    const two = await dial();
    const other = await within(second, 2_000, 'the second connection');
    assert.notEqual(other.socket, accepted.socket);
    assert.equal(mute.connections, 2);

    // Sent something first, so there is unread data in front of the end: a listener that does
    // not read never sees the end behind it.
    one.socket.write('x'.repeat(4_096));
    one.socket.end();
    await within(accepted.closed, 2_000, 'the simulator hearing the first client go');
    assert.equal(mute.open, 1);
    assert.equal(two.socket.destroyed, false, 'the other connection is untouched');
  });

  it('stops with a client still attached, and the port stops answering', async () => {
    const arriving = mute.next();
    const { socket } = await dial();
    const { closed } = await within(arriving, 2_000, 'the simulator accepting');
    const gone = new Promise<void>((resolve) => {
      socket.once('close', () => {
        resolve();
      });
    });
    const { port, host } = mute;

    await within(mute.stop(), 2_000, 'stopping with a client attached');
    await within(closed, 2_000, 'the connection closing at the simulator');
    await within(gone, 2_000, 'the client being hung up on');
    assert.equal(mute.open, 0);

    const refused = await within(
      new Promise<string>((resolve) => {
        const again = connect(port, host);
        again.once('connect', () => {
          again.destroy();
          resolve('connected');
        });
        again.once('error', (error: NodeJS.ErrnoException) => {
          resolve(error.code ?? 'error');
        });
      }),
      2_000,
      'the port refusing',
    );
    assert.equal(refused, 'ECONNREFUSED');
    // Stopped twice is the afterEach's business, and must not hang or throw.
    mute = await MuteSshServer.start();
  });
});

describe('the SSH simulator, stopped after its client has gone (P-257)', () => {
  /**
   * What `ssh-shared-open`'s `after` hook did one run in five: a probe worker holding an SSH
   * session is terminated, and the simulator is stopped at once. Stopping ends each connection,
   * which writes a DISCONNECT to a client that is no longer there. Made certain here rather than
   * left to timing: the client resets the connection, and the event loop is held until the reset
   * has landed and before the simulator has read it, so `stop()` is the first to touch the dead
   * socket, which is the window the worker's termination left open.
   */
  it('hears the failed write on the connection rather than throwing it in the test process', async () => {
    const server = await TestSshServer.start();
    let stopped = false;
    try {
      const socket = connect(server.port, server.host);
      socket.on('error', () => undefined);
      const heard: Buffer[] = [];
      const pastHeader = within(
        new Promise<void>((resolve) => {
          socket.on('data', (chunk: Buffer) => {
            heard.push(chunk);
            // The server sends its KEXINIT after its identification line only once it has read
            // ours, and that is when `ssh2` stops silencing the connection's errors itself.
            const all = Buffer.concat(heard);
            const lineEnd = all.indexOf('\r\n');
            if (lineEnd >= 0 && all.length > lineEnd + 2) resolve();
          });
        }),
        2_000,
        'the server reading the client identification',
      );
      socket.write('SSH-2.0-p257\r\n');
      await pastHeader;
      assert.equal(server.connections, 1);

      socket.resetAndDestroy();
      const until = Date.now() + 50;
      while (Date.now() < until) {
        // Held on purpose: the reset lands, and nothing here has read it yet.
      }
      // Nothing heard yet: the simulator has not read the reset, so whatever is recorded from
      // here on started in `stop()`.
      // A length, not `deepEqual(…, [])`: that asserts the type too, and the list stays `never[]`.
      assert.equal(
        server.connectionErrors.length,
        0,
        `the simulator heard the reset before stop(): ${JSON.stringify(server.connectionErrors)}`,
      );
      stopped = true;
      await within(server.stop(), 2_000, 'stopping after the client reset');
      await sleep(50);

      // **A failed write, and the first thing heard.** `ssh2` re-emits a failed read the same
      // way, so a run where the simulator merely read the reset would also record ECONNRESET;
      // `syscall` is what tells the DISCONNECT that `stop()` wrote apart from that, and a run
      // that missed the window fails here rather than passing for the wrong reason.
      const first = server.connectionErrors[0];
      assert.ok(first !== undefined, 'the connection recorded nothing');
      assert.equal(first.syscall, 'write', JSON.stringify(server.connectionErrors));
      assert.ok(
        first.code === 'ECONNRESET' || first.code === 'EPIPE',
        JSON.stringify(server.connectionErrors),
      );
    } finally {
      if (!stopped) await within(server.stop(), 2_000, 'stopping');
    }
  });

  it('reset() forgets what the connections reported', async () => {
    const server = await TestSshServer.start();
    try {
      server.connectionErrors.push({ code: 'EPIPE', syscall: 'write', message: 'write EPIPE' });
      server.reset();
      assert.deepEqual(server.connectionErrors, []);
    } finally {
      await within(server.stop(), 2_000, 'stopping');
    }
  });
});
