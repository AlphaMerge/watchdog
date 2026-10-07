import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { SshError, SshSession } from '../src/support/ssh/session.js';
import { SshSessionPool, withSsh } from '../src/support/ssh/pool.js';
import { sshCheck } from '../src/support/ssh/check.js';
import {
  readCredentials,
  SshCredentialError,
  credentialFingerprint,
  type SshCredentials,
} from '../src/support/ssh/credentials.js';
import { fingerprintOf, matchesFingerprint, verifyHostKey } from '../src/support/ssh/host-key.js';
import { keyPair, MuteSshServer, TestSshServer } from '@ms/simulators';

let server: TestSshServer;
/** Learned from the first connection, so the strict-policy tests have something real to match. */
let hostKeyFingerprint = '';

before(async () => {
  server = await TestSshServer.start();
  // Discovered the way an operator discovers it: connect once with checking off and read what
  // the server presented.
  const session = await SshSession.open(target(), credentials({ hostKeyPolicy: 'accept-any' }));
  const verdict = session.hostKey;
  hostKeyFingerprint = verdict.kind === 'unchecked' ? verdict.presented : '';
  session.close();
});

after(async () => {
  await server.stop();
});

beforeEach(() => {
  server.reset();
});

const target = () => ({ host: server.host, port: server.port });

function credentials(over: Partial<Record<string, unknown>> = {}): SshCredentials {
  return readCredentials({
    username: 'monitor',
    password: 'monitor',
    hostKeyPolicy: 'strict',
    hostKeyFingerprint,
    ...over,
  });
}

const signal = (): AbortSignal => new AbortController().signal;

/** Resolves once `ready` holds, looking every 10 ms. Bounded by the `within` around it. */
async function waitFor(ready: () => boolean): Promise<void> {
  while (!ready()) await new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * A wait of this file's own, so a case that hangs fails here and not at the suite's end — and
 * the bound every wait on the server is given in place of a wall-clock assert (`P-268`).
 */
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

describe('reading a stored SSH credential', () => {
  it('refuses one with no user name', () => {
    assert.throws(() => readCredentials({ password: 'x' }), SshCredentialError);
  });

  it('refuses one with neither a password nor a key', () => {
    assert.throws(
      () => readCredentials({ username: 'monitor' }),
      /neither a password nor a private key/,
    );
  });

  it('prefers a key when both are set, so moving to keys is the easy change', () => {
    // Failing here would make the safer configuration the harder one to reach: an operator
    // filling in a key expects it to be used, not to have to clear the password first.
    const parsed = readCredentials({
      username: 'monitor',
      password: 'old',
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----',
    });
    assert.equal(parsed.method, 'key');
  });

  it('defaults the host key policy to strict rather than to whatever is easiest', () => {
    assert.equal(readCredentials({ username: 'a', password: 'b' }).hostKeyPolicy, 'strict');
    assert.equal(
      readCredentials({ username: 'a', password: 'b', hostKeyPolicy: 'accept-any' }).hostKeyPolicy,
      'accept-any',
    );
  });

  it('keeps a private key’s newlines, which are load-bearing', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----';
    const parsed = readCredentials({ username: 'a', privateKey: key });
    assert.equal(parsed.method === 'key' && parsed.privateKey, key);
  });

  it('fingerprints by identity, not by chance, and never carries the secret', () => {
    const one = credentialFingerprint(readCredentials({ username: 'a', password: 'hunter2' }));
    const same = credentialFingerprint(readCredentials({ username: 'a', password: 'hunter2' }));
    const rotated = credentialFingerprint(readCredentials({ username: 'a', password: 'hunter3' }));
    assert.equal(one, same);
    assert.notEqual(one, rotated, 'a rotated password must not reuse the old connection');
    assert.ok(!one.includes('hunter2'));
  });
});

describe('the host key', () => {
  it('is fingerprinted the way OpenSSH prints it, so a paste matches', () => {
    // `ssh-keygen -lf` shows SHA256: and unpadded base64. Producing a padded form would mean
    // the string we show never equals the one they have.
    const key = Buffer.from('a host key');
    const expected = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
    assert.equal(fingerprintOf(key), `SHA256:${expected}`);
    assert.ok(!fingerprintOf(key).endsWith('='));
  });

  it('forgives how a person pasted it, but not a different key', () => {
    const key = fingerprintOf(Buffer.from('a host key'));
    const bare = key.replace('SHA256:', '');
    assert.equal(matchesFingerprint(bare, key), true);
    assert.equal(matchesFingerprint(`  ${key}  `, key), true);
    assert.equal(matchesFingerprint(`${bare}==`, key), true);
    // Base64 is case-significant: two fingerprints differing only in case are two keys.
    assert.equal(matchesFingerprint(bare.toLowerCase(), key), false);
  });

  it('reports an unknown key rather than trusting it', () => {
    const verdict = verifyHostKey('strict', [], Buffer.from('k'));
    assert.equal(verdict.kind, 'unknown');
  });

  it('connects when the fingerprint matches', async () => {
    const session = await SshSession.open(target(), credentials());
    assert.equal(session.hostKey.kind, 'trusted');
    session.close();
  });

  it('refuses to log in when nothing is recorded, and says what to record', async () => {
    // The whole design of the policy: no write-back channel exists, so the operator is told the
    // fingerprint and pastes it in. A failed check that contains the answer is the mechanism.
    await assert.rejects(
      () => SshSession.open(target(), credentials({ hostKeyFingerprint: '' })),
      (error: unknown) =>
        error instanceof SshError &&
        error.phase === 'host-key' &&
        /presented host key SHA256:.*has no expected fingerprint/s.test(error.message),
    );
  });

  it('connects to a server whose key is any of the set’s host keys (A-41b)', async () => {
    const session = await SshSession.open(
      target(),
      credentials({
        hostKeyFingerprint: 'SHA256:another',
        hostKeys: ['SHA256:third', hostKeyFingerprint],
      }),
    );
    assert.equal(session.hostKey.kind, 'trusted');
    session.close();
  });

  it('refuses a server whose key is none of them, naming every one it would accept (A-41b)', async () => {
    server.behave({ password: 'monitor' });
    await assert.rejects(
      () =>
        SshSession.open(
          target(),
          credentials({ hostKeyFingerprint: 'SHA256:another', hostKeys: ['SHA256:third', ' '] }),
        ),
      /presented host key SHA256:.*expects one of SHA256:another, SHA256:third\. /s,
    );
    assert.deepEqual(server.seen, []);
  });

  it('refuses a key that is not the one recorded, and names both', async () => {
    await assert.rejects(
      () => SshSession.open(target(), credentials({ hostKeyFingerprint: 'SHA256:notthisone' })),
      /presented host key SHA256:.*expects SHA256:notthisone/s,
    );
  });

  it('never sends the password to a host that failed its key check', async () => {
    // `hostVerifier` runs during key exchange, before authentication. This is the assertion
    // that makes strict checking worth anything: the credential is not merely unused, it is
    // never transmitted.
    server.behave({ password: 'monitor' });
    await assert.rejects(() =>
      SshSession.open(target(), credentials({ hostKeyFingerprint: 'SHA256:wrong' })),
    );
    // A server that had reached authentication would have recorded the attempt; it did not get
    // that far, so no command was ever run and no session opened.
    assert.deepEqual(server.seen, []);
  });

  it('connects to anything when told to, and still reports what it saw', async () => {
    const session = await SshSession.open(target(), credentials({ hostKeyPolicy: 'accept-any' }));
    const verdict = session.hostKey;
    assert.ok(verdict.kind === 'unchecked');
    // Reported rather than silent: a connection that authenticates the server not at all is a
    // standing decision, and the sensor message is where somebody might revisit it.
    assert.ok(verdict.presented.startsWith('SHA256:'));
    session.close();
  });
});

describe('authenticating', () => {
  it('logs in with a password', async () => {
    const session = await SshSession.open(target(), credentials());
    assert.equal(session.closed, false);
    session.close();
  });

  it('logs in with a private key', async () => {
    server.behave({ acceptAnyKey: true });
    const pair = keyPair();
    const session = await SshSession.open(
      target(),
      credentials({ password: '', privateKey: pair.private }),
    );
    assert.equal(session.closed, false);
    session.close();
  });

  it('says the credentials were refused rather than "connection failed"', async () => {
    server.behave({ password: 'something-else' });
    await assert.rejects(
      () => SshSession.open(target(), credentials()),
      (error: unknown) =>
        error instanceof SshError &&
        error.phase === 'authenticate' &&
        /refused the credentials for monitor with a password/.test(error.message),
    );
  });

  it('never puts the password in the error', async () => {
    server.behave({ refuseAuth: true });
    const failure = await SshSession.open(target(), credentials()).catch((e: unknown) => e);
    assert.ok(failure instanceof Error);
    assert.ok(!failure.message.includes('monitor with a password: monitor'));
    assert.ok(!JSON.stringify(failure.message).includes('"monitor","monitor"'));
  });

  it('fails with the host named when nothing is listening', async () => {
    await assert.rejects(
      () => SshSession.open({ host: '127.0.0.1', port: 1 }, credentials()),
      (error: unknown) =>
        error instanceof SshError && /could not connect to 127\.0\.0\.1/.test(error.message),
    );
  });

  it('refuses a device with no host before opening anything', async () => {
    await assert.rejects(
      () => SshSession.open({ host: '  ' }, credentials()),
      /no host to connect to/,
    );
  });
});

describe('running a command', () => {
  it('returns what it wrote and the code it exited with', async () => {
    server.answer('uptime', { stdout: ' 11:04:33 up 8 days\n', code: 0 });
    const session = await SshSession.open(target(), credentials());
    const result = await session.exec('uptime', signal());
    assert.equal(result.stdout, ' 11:04:33 up 8 days\n');
    assert.equal(result.code, 0);
    session.close();
  });

  it('treats a non-zero exit as a result, not an error', async () => {
    // `df` returning 1 and a script reporting a problem are readings a sensor type interprets.
    // Throwing would make every caller catch in order to read an exit code.
    server.answer('check', { stdout: 'WARN\n', stderr: 'disk nearly full\n', code: 1 });
    const session = await SshSession.open(target(), credentials());
    const result = await session.exec('check', signal());
    assert.equal(result.code, 1);
    assert.equal(result.stdout, 'WARN\n');
    assert.equal(result.stderr, 'disk nearly full\n');
    session.close();
  });

  it('keeps stderr apart from stdout, as the wire does', async () => {
    server.answer('noisy', { stdout: 'value=7\n', stderr: 'warning: deprecated\n', code: 0 });
    const session = await SshSession.open(target(), credentials());
    const result = await session.exec('noisy', signal());
    // A sensor parsing `value=7` must not have to strip a warning out of it first.
    assert.equal(result.stdout, 'value=7\n');
    assert.equal(result.stderr, 'warning: deprecated\n');
    session.close();
  });

  it('gives up on a command that never finishes, naming it', async () => {
    server.behave({ password: 'monitor', hang: true });
    const session = await SshSession.open(target(), credentials(), { commandTimeoutMs: 300 });
    // The message is the proof it was the command timeout that ended it; `within` only stops a
    // case that hangs from waiting out the suite (`P-268`).
    await assert.rejects(
      within(session.exec('sleep 9999', signal()), 5_000, 'the command timeout'),
      /sleep 9999 did not finish on 127\.0\.0\.1 within 300 ms/,
    );
    session.close();
  });

  it('fails rather than truncating when a command floods', async () => {
    // Truncating would be worse than failing: `T-08` parses these, and half an answer parses
    // into a number that is wrong rather than absent.
    server.answer('cat /var/log/syslog', { bulkBytes: 200_000 });
    const session = await SshSession.open(target(), credentials(), { maxOutputBytes: 50_000 });
    await assert.rejects(
      () => session.exec('cat /var/log/syslog', signal()),
      /produced more than 50000 bytes.*was stopped/s,
    );
    session.close();
  });

  it('returns promptly when the check is aborted, and leaves the connection usable', async () => {
    // The rule the SNMP session follows too: abort closes the *channel*. The connection belongs
    // to every sensor on the device, and tearing it down would fail the others in flight.
    server.behave({ password: 'monitor', hang: true });
    const session = await SshSession.open(target(), credentials(), { commandTimeoutMs: 30_000 });
    const controller = new AbortController();
    const pending = session.exec('sleep 9999', controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 50);
    // Promptly: the command timeout is thirty seconds, and the message says it was the abort.
    await assert.rejects(
      within(pending, 5_000, 'the abort ending the command'),
      /cancelled while running a command/,
    );

    server.behave({ password: 'monitor' });
    server.answer('echo ok', { stdout: 'ok\n' });
    const after = await session.exec('echo ok', signal());
    assert.equal(after.stdout, 'ok\n', 'the connection should have survived the abort');
    session.close();
  });

  it('refuses to run on a closed connection rather than hanging', async () => {
    const session = await SshSession.open(target(), credentials());
    session.close();
    await assert.rejects(() => session.exec('uptime', signal()), /connection to .* is closed/);
  });
});

describe('a device that resets the connection mid-command (P-259)', () => {
  // The simulator writes part of an answer and then resets the TCP connection under the
  // command, before any exit status: a device rebooting, or a firewall dropping the session.
  // `ssh2` closes the channel with no exit code when its socket goes, which used to resolve as
  // `code: null` and reach a sensor as an empty answer, or as half of one.
  const lost = (command: string) => (error: unknown) =>
    error instanceof SshError &&
    error.phase === 'exec' &&
    error.host === '127.0.0.1' &&
    error.command === command &&
    error.message.startsWith(
      `the connection to 127.0.0.1 was lost while running ${command}, before the command ` +
        'reported an exit status',
    ) &&
    // The reset itself, as the socket reported it: the underlying error, not only ours.
    /ECONNRESET/.test(error.message);

  it('fails the command, naming the host, the command and the phase', async () => {
    server.answer('cat /proc/loadavg', {
      stdout: '0.50 0.40 0.30 1/123 4567\n',
      reset: 'before-exit-status',
    });
    const session = await SshSession.open(target(), credentials());
    try {
      await assert.rejects(
        within(session.exec('cat /proc/loadavg', signal()), 5_000, 'the command ending'),
        lost('cat /proc/loadavg'),
      );
      assert.equal(session.closed, true, 'the session knows its connection is gone');
      // And says so to the next command, rather than hanging on a dead connection.
      await assert.rejects(
        within(session.exec('uptime', signal()), 5_000, 'the next command'),
        /connection to 127\.0\.0\.1 is closed/,
      );
    } finally {
      session.close();
    }
  });

  it('leaves the probe healthy: nothing thrown elsewhere, the lease given back, the next check reconnects', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on('uncaughtExceptionMonitor', onUncaught);
    const pool = new SshSessionPool();
    server.answer('./check.sh', { stdout: 'value:1\n', reset: 'before-exit-status' });
    server.answer('uptime', { stdout: 'up\n' });
    try {
      await assert.rejects(
        within(
          withSsh(target(), credentials(), {}, (s) => s.exec('./check.sh', signal()), pool),
          5_000,
          'the check ending',
        ),
        lost('./check.sh'),
      );
      // The lease came back though the check threw: a connection held for ever would be counted
      // busy for ever and never evicted.
      assert.equal(pool.stats().inUse, 0);

      const out = await within(
        withSsh(target(), credentials(), {}, (s) => s.exec('uptime', signal()), pool),
        5_000,
        'the next check',
      );
      assert.equal(out.stdout, 'up\n');
      const stats = pool.stats();
      assert.equal(stats.stale, 1, 'the dead connection was found and replaced');
      assert.equal(stats.opened, 2);
      assert.equal(stats.connections, 1);
      assert.equal(stats.inUse, 0);
      assert.equal(server.connections, 2);

      // A turn for anything the reset left behind to surface.
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(uncaught, [], 'the reset escaped as an uncaught exception');
    } finally {
      process.off('uncaughtExceptionMonitor', onUncaught);
      pool.closeAll();
    }
  });

  it('fails a command whose exit status arrived before the rest of its output', async () => {
    // RFC 4254 does not order the two, and OpenSSH sends the status as soon as the command is
    // reaped. `ssh2` keeps the code and hands it to the channel's close when the socket goes,
    // so this used to resolve as `code: 0` with the first half of a `df`.
    server.answer('df -P -k /', {
      code: 0,
      stdout: 'Filesystem     1024-blocks      Used Available Capacity Mounted on\n',
      reset: 'after-exit-status',
    });
    const session = await SshSession.open(target(), credentials());
    try {
      await assert.rejects(
        within(session.exec('df -P -k /', signal()), 5_000, 'the command ending'),
        lost('df -P -k /'),
      );
    } finally {
      session.close();
    }
  });

  /**
   * Channels the server finished, on connections that went straight after (`P-259`). Each is a
   * whole answer, and was one before the connection went, so each is a result: with no exit
   * status, as some appliances send none, and with the connection's end in the same turn —
   * in the same read, where the loopback delivers it so.
   *
   * Not a reset in the same turn: an RST can overtake what was written just before it, and
   * then the client never hears the server finish — which is the failure above, correctly.
   */
  const finished: {
    readonly name: string;
    readonly ending: 'close' | 'eof';
    readonly then: 'disconnect' | 'disconnect-lost' | 'fin' | undefined;
  }[] = [
    { name: 'EOF and CLOSE, on a connection that stays up', ending: 'close', then: undefined },
    { name: 'EOF and CLOSE, then a DISCONNECT', ending: 'close', then: 'disconnect' },
    {
      name: 'EOF and CLOSE, then a DISCONNECT for a lost connection',
      ending: 'close',
      then: 'disconnect-lost',
    },
    { name: 'EOF and no CLOSE, then a FIN', ending: 'eof', then: 'fin' },
  ];
  for (const { name, ending, then } of finished) {
    it(`answers a command the server finished with no exit status: ${name}`, async () => {
      server.answer('quiet', {
        stdout: 'ok\n',
        ending,
        ...(then === undefined ? {} : { then }),
      });
      const session = await SshSession.open(target(), credentials());
      try {
        const result = await within(session.exec('quiet', signal()), 5_000, 'the command');
        assert.deepEqual(result, { stdout: 'ok\n', stderr: '', code: null, signal: null });
        if (then === undefined) assert.equal(session.closed, false);
      } finally {
        session.close();
      }
    });
  }

  /** A command still running when the probe itself closes the connection. */
  const closedByProbe = (error: unknown): boolean =>
    error instanceof SshError &&
    error.phase === 'exec' &&
    error.command === 'sleep 9999' &&
    error.message.startsWith(
      'the connection to 127.0.0.1 was lost while running sleep 9999, before the command',
    ) &&
    error.message.endsWith('this probe closed the connection') &&
    !/server closed|ECONNRESET/.test(error.message);

  it('says the probe closed the connection when it did, not the server', async () => {
    server.behave({ password: 'monitor', hang: true });
    const session = await SshSession.open(target(), credentials(), { commandTimeoutMs: 30_000 });
    const running = session.exec('sleep 9999', signal());
    await within(
      waitFor(() => server.seen.includes('sleep 9999')),
      5_000,
      'the command',
    );
    session.close();
    await assert.rejects(within(running, 5_000, 'the command ending'), closedByProbe);
  });

  it('says so for a command cut off by closeAll as well', async () => {
    server.behave({ password: 'monitor', hang: true });
    const pool = new SshSessionPool();
    const lease = await within(
      pool.acquire(target(), credentials(), { commandTimeoutMs: 30_000 }),
      5_000,
      'the connection',
    );
    const running = lease.session.exec('sleep 9999', signal());
    try {
      await within(
        waitFor(() => server.seen.includes('sleep 9999')),
        5_000,
        'the command',
      );
      pool.closeAll();
      await assert.rejects(within(running, 5_000, 'the command ending'), closedByProbe);
    } finally {
      lease.release();
      pool.closeAll();
    }
  });
});

describe('reusing connections', () => {
  it('opens one connection for many checks on the same host', async () => {
    // The whole point: a handshake is TCP, key exchange and authentication, where a channel on
    // an established connection is nearly free.
    const pool = new SshSessionPool();
    server.answer('uptime', { stdout: 'up\n' });
    try {
      for (let at = 0; at < 5; at += 1) {
        await withSsh(target(), credentials(), {}, (s) => s.exec('uptime', signal()), pool);
      }
      assert.equal(server.connections, 1, 'five checks should have shared one handshake');
      assert.equal(pool.stats().reused, 4);
    } finally {
      pool.closeAll();
    }
  });

  it('shares one handshake between checks that start together', async () => {
    // Two sensors on a device come due on the same tick. Without in-flight sharing both would
    // find nothing cached and both would authenticate.
    const pool = new SshSessionPool();
    server.answer('uptime', { stdout: 'up\n' });
    try {
      await Promise.all(
        Array.from({ length: 4 }, () =>
          withSsh(target(), credentials(), {}, (s) => s.exec('uptime', signal()), pool),
        ),
      );
      assert.equal(server.connections, 1, 'concurrent checks should share one handshake');
      assert.equal(pool.stats().joined, 3);
    } finally {
      pool.closeAll();
    }
  });

  it('opens a new connection when the credentials have been rotated', async () => {
    // Reusing a connection authenticated as the old identity would keep working after a
    // password was changed, which is the opposite of what changing it is for.
    const pool = new SshSessionPool();
    server.answer('uptime', { stdout: 'up\n' });
    try {
      await withSsh(target(), credentials(), {}, (s) => s.exec('uptime', signal()), pool);
      server.behave({ password: 'rotated' });
      await withSsh(
        target(),
        credentials({ password: 'rotated' }),
        {},
        (s) => s.exec('uptime', signal()),
        pool,
      );
      assert.equal(server.connections, 2);
    } finally {
      pool.closeAll();
    }
  });

  describe('opening behind the target policy’s lookup (A-65)', () => {
    // A server that accepts and never speaks: the handshake waits out its whole timeout. The
    // simulator's own (`A-73`), where this file used to stand up a bare listener.
    let mute: MuteSshServer;

    before(async () => {
      mute = await MuteSshServer.start();
    });

    after(async () => {
      await mute.stop();
    });

    /**
     * An open that cannot succeed, behind a guard that takes `guardMs` of a clock the test moves
     * (`P-268`): the connect timeout the handshake was handed, and how long the open took.
     *
     * The lookup's time is fake and the handshake's is real. Measuring both on the wall clock
     * left these cases under a second of slack against an upper bound, which a loaded VM can
     * spend; what the pool hands `SshSession.open` is the claim, and it is exact on a fake clock.
     */
    async function failedOpen(
      t: TestContext,
      guardMs: number | null,
      connectTimeoutMs: number,
    ): Promise<{ handedMs: number | undefined; tookMs: number }> {
      let now = 0n;
      const pool = new SshSessionPool({ monotonic: () => now });
      const open = t.mock.method(SshSession, 'open');
      const startedAt = performance.now();
      try {
        await assert.rejects(
          within(
            pool.acquire(
              {
                host: '127.0.0.1',
                port: mute.port,
                ...(guardMs === null
                  ? {}
                  : {
                      guard: () => {
                        now += BigInt(guardMs) * 1_000_000n;
                        return Promise.resolve(undefined);
                      },
                    }),
              },
              credentials({ hostKeyPolicy: 'accept-any' }),
              { connectTimeoutMs },
            ),
            connectTimeoutMs + 5_000,
            'the handshake timing out',
          ),
          /could not connect to 127\.0\.0\.1/,
        );
        assert.equal(open.mock.callCount(), 1, 'one handshake');
        return {
          handedMs: open.mock.calls[0]?.arguments[2]?.connectTimeoutMs,
          tookMs: performance.now() - startedAt,
        };
      } finally {
        pool.closeAll();
      }
    }

    it('gives the lookup and the handshake one connect timeout between them', async (t) => {
      // 1,200 ms of lookup and a 2,000 ms timeout. Started after the lookup, the handshake's
      // clock ran to 3,200 ms; shared, the handshake has the 800 left.
      const { handedMs } = await failedOpen(t, 1_200, 2_000);
      assert.equal(handedMs, 800, 'the lookup was not counted');
    });

    it('still gives a handshake with no lookup before it the whole timeout', async (t) => {
      const { handedMs, tookMs } = await failedOpen(t, null, 1_000);
      assert.equal(handedMs, 1_000);
      // A lower bound only, which load cannot break: the handshake really was given the time.
      assert.ok(tookMs >= 950, `ended early, at ${String(Math.round(tookMs))} ms`);
    });

    it('leaves a handshake no time when the lookup used it all', async (t) => {
      // The least `ssh2` is handed is a millisecond: none would read as no timeout at all.
      const { handedMs } = await failedOpen(t, 900, 600);
      assert.equal(handedMs, 1, 'the handshake was given time again');
    });

    it('opens a connection as before when the lookup is quick', async () => {
      const pool = new SshSessionPool();
      server.answer('uptime', { stdout: 'up\n' });
      try {
        const out = await withSsh(
          { ...target(), guard: () => Promise.resolve(undefined) },
          credentials(),
          { connectTimeoutMs: 5_000 },
          (s) => s.exec('uptime', signal()),
          pool,
        );
        assert.equal(out.stdout, 'up\n');
      } finally {
        pool.closeAll();
      }
    });

    /**
     * A check cancelled while its connection is being opened (`A-69`).
     *
     * `SshSession.open` took no signal, so a check cancelled in the handshake held its socket
     * until the connect timeout. Against the same listener: it accepts, never speaks, and
     * every case here gives the handshake ten seconds it must not use.
     */
    describe('cancelled while the connection is being opened (A-69)', () => {
      const LONG_MS = 10_000;
      const mutely = () => ({ host: '127.0.0.1', port: mute.port });
      const anyKey = () => credentials({ hostKeyPolicy: 'accept-any' });
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

      /** The connection the listener accepts next, and a promise of its closing. */
      const nextAccepted = (): Promise<{ socket: Socket; closed: Promise<void> }> => mute.next();

      /** How a promise ended and when, without waiting for it here. */
      function watched(promise: Promise<unknown>): { error?: unknown; ended: boolean; at: number } {
        const seen: { error?: unknown; ended: boolean; at: number } = { ended: false, at: 0 };
        promise.then(
          () => {
            seen.ended = true;
            seen.at = performance.now();
          },
          (error: unknown) => {
            seen.error = error;
            seen.ended = true;
            seen.at = performance.now();
          },
        );
        return seen;
      }

      const cancelled = (error: unknown): boolean =>
        error instanceof SshError &&
        error.phase === 'connect' &&
        error.message === 'the check was cancelled while connecting to 127.0.0.1';

      it('SshSession.open ends when its signal does, and the far end sees it go', async () => {
        const controller = new AbortController();
        const arriving = nextAccepted();
        const opening = SshSession.open(
          mutely(),
          anyKey(),
          { connectTimeoutMs: LONG_MS },
          controller.signal,
        );
        watched(opening);
        const { closed } = await within(arriving, 5_000, 'the listener accepting');
        controller.abort();
        // Long before the ten-second connect timeout: `cancelled` is the abort's own message,
        // which the timeout's (`could not connect`) is not (`P-268`).
        await assert.rejects(within(opening, 2_000, 'the open ending'), cancelled);
        await within(closed, 2_000, 'the socket closing at the listener');
      });

      it('destroys the socket, where ending it would wait for a listener that never closes', async () => {
        // A listener of this case's own, which neither reads nor closes: asked to end, a
        // connection to it stays half open until the connect timeout. Whether the socket is
        // gone is found out from the far end, by writing to it. A destroyed socket answers a
        // write with a reset; one that was only ended takes the byte and goes on waiting.
        const held: Socket[] = [];
        const deaf = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => {
          held.push(socket);
          socket.on('error', () => undefined);
        });
        await new Promise<void>((resolve) => {
          deaf.listen(0, '127.0.0.1', () => {
            resolve();
          });
        });
        const at = deaf.address();
        const port = typeof at === 'object' && at !== null ? at.port : 0;
        const controller = new AbortController();
        let poke: NodeJS.Timeout | undefined;
        try {
          const arriving = new Promise<Socket>((resolve) => {
            deaf.once('connection', resolve);
          });
          const opening = SshSession.open(
            { host: '127.0.0.1', port },
            anyKey(),
            { connectTimeoutMs: LONG_MS },
            controller.signal,
          );
          watched(opening);
          const socket = await within(arriving, 5_000, 'the listener accepting');
          controller.abort();
          await assert.rejects(within(opening, 2_000, 'the open ending'), cancelled);
          const reset = new Promise<void>((resolve) => {
            socket.once('close', () => {
              resolve();
            });
          });
          poke = setInterval(() => {
            if (!socket.destroyed) socket.write('\n');
          }, 100);
          await within(reset, 3_000, 'a write to the abandoned connection being refused');
        } finally {
          clearInterval(poke);
          for (const socket of held) socket.destroy();
          await new Promise<void>((resolve) => {
            deaf.close(() => {
              resolve();
            });
          });
        }
      });

      it('SshSession.open connects to nothing for a signal that is already aborted', async () => {
        const before = mute.connections;
        await assert.rejects(
          within(
            SshSession.open(mutely(), anyKey(), { connectTimeoutMs: LONG_MS }, AbortSignal.abort()),
            2_000,
            'the open ending',
          ),
          cancelled,
        );
        await sleep(150);
        assert.equal(mute.connections, before, 'no connection was made');
      });

      it('a signal that never aborts changes nothing: the handshake has its timeout', async () => {
        const startedAt = performance.now();
        await assert.rejects(
          SshSession.open(
            mutely(),
            anyKey(),
            { connectTimeoutMs: 700 },
            new AbortController().signal,
          ),
          /could not connect to 127\.0\.0\.1/,
        );
        assert.ok(performance.now() - startedAt >= 650);
      });

      it('the pool ends a cancelled caller’s open at once, and the next one starts afresh', async () => {
        const pool = new SshSessionPool();
        const controller = new AbortController();
        try {
          const arriving = nextAccepted();
          const lease = pool.acquire(
            mutely(),
            anyKey(),
            { connectTimeoutMs: LONG_MS },
            controller.signal,
          );
          const { closed } = await within(arriving, 5_000, 'the listener accepting');
          controller.abort();
          await assert.rejects(within(lease, 2_000, 'the acquire ending'), cancelled);
          await within(closed, 2_000, 'the socket closing at the listener');
          await sleep(20);
          assert.deepEqual(
            { ...pool.stats(), acquired: 0 },
            { ...new SshSessionPool().stats(), acquired: 0 },
            'nothing was opened, kept or leased',
          );

          // Not left waiting on the open that was abandoned: this one makes its own connection
          // and has its own timeout.
          const again = nextAccepted();
          const second = pool.acquire(mutely(), anyKey(), { connectTimeoutMs: 400 });
          watched(second);
          await within(again, 5_000, 'a second connection');
          await assert.rejects(
            within(second, 3_000, 'the second open'),
            /could not connect to 127\.0\.0\.1/,
          );
          assert.equal(pool.stats().joined, 0);
        } finally {
          pool.closeAll();
        }
      });

      it('opens nothing for a caller cancelled before it asked', async () => {
        const pool = new SshSessionPool();
        const before = mute.connections;
        let asked = 0;
        try {
          await assert.rejects(
            within(
              pool.acquire(
                {
                  ...mutely(),
                  guard: () => {
                    asked += 1;
                    return Promise.resolve(undefined);
                  },
                },
                anyKey(),
                { connectTimeoutMs: LONG_MS },
                AbortSignal.abort(),
              ),
              2_000,
              'the acquire ending',
            ),
            cancelled,
          );
          await sleep(150);
          assert.equal(asked, 0, 'the target policy was not asked');
          assert.equal(mute.connections, before, 'and no connection was made');
        } finally {
          pool.closeAll();
        }
      });

      it('one caller’s cancellation does not fail another waiting for the same connection', async () => {
        const pool = new SshSessionPool();
        const first = new AbortController();
        const second = new AbortController();
        try {
          const arriving = nextAccepted();
          const options = { connectTimeoutMs: 1_500 };
          const startedAt = performance.now();
          const one = watched(pool.acquire(mutely(), anyKey(), options, first.signal));
          const two = watched(pool.acquire(mutely(), anyKey(), options, second.signal));
          assert.equal(pool.stats().joined, 1, 'the control: the second joined the first’s open');
          const { socket } = await within(arriving, 5_000, 'the listener accepting');

          first.abort();
          await sleep(300);
          assert.ok(one.ended && cancelled(one.error), 'the cancelled caller was told at once');
          assert.equal(two.ended, false, 'and the other is still waiting');
          assert.equal(socket.destroyed, false, 'for a handshake that is still going');

          // It ends as an open nobody cancelled ends: at the connect timeout, saying so.
          await within(
            (async () => {
              while (!two.ended) await sleep(25);
            })(),
            5_000,
            'the second caller’s open ending',
          );
          assert.match(String(two.error), /could not connect to 127\.0\.0\.1/);
          assert.ok(two.at - startedAt >= 1_400, 'not early');
        } finally {
          pool.closeAll();
        }
      });

      it('the open ends when the last caller waiting for it is cancelled, and not before', async () => {
        const pool = new SshSessionPool();
        const first = new AbortController();
        const second = new AbortController();
        // The lookup and the handshake run under one signal, the pool's: this guard sees it.
        const seen: { lookup?: AbortSignal } = {};
        try {
          const arriving = nextAccepted();
          const target = {
            ...mutely(),
            guard: (signal?: AbortSignal) => {
              if (signal !== undefined) seen.lookup = signal;
              return Promise.resolve(undefined);
            },
          };
          const options = { connectTimeoutMs: LONG_MS };
          const one = watched(pool.acquire(target, anyKey(), options, first.signal));
          const two = watched(pool.acquire(target, anyKey(), options, second.signal));
          const { socket, closed } = await within(arriving, 5_000, 'the listener accepting');
          const lookup = seen.lookup;
          assert.ok(lookup !== undefined, 'the guard is handed a signal');
          assert.notEqual(lookup, first.signal, 'and it is not the first caller’s');

          second.abort();
          await sleep(200);
          assert.ok(two.ended && cancelled(two.error));
          assert.equal(lookup.aborted, false);
          assert.equal(socket.destroyed, false);
          assert.deepEqual({ ended: one.ended }, { ended: false }, 'the first is still waiting');

          first.abort();
          await within(closed, 2_000, 'the socket closing at the listener');
          await sleep(20);
          assert.ok(one.ended && cancelled(one.error));
          assert.equal(lookup.aborted, true);
        } finally {
          pool.closeAll();
        }
      });

      it('a lookup that is still going ends with the last caller too', async () => {
        const pool = new SshSessionPool();
        const controller = new AbortController();
        const before = mute.connections;
        let abandoned = false;
        try {
          const lease = pool.acquire(
            {
              ...mutely(),
              // A resolver that answers only when it is told to stop.
              guard: (signal?: AbortSignal) =>
                new Promise((_, reject) => {
                  signal?.addEventListener('abort', () => {
                    abandoned = true;
                    reject(new Error('the lookup was abandoned'));
                  });
                }),
            },
            anyKey(),
            { connectTimeoutMs: LONG_MS },
            controller.signal,
          );
          const seen = watched(lease);
          await sleep(100);
          assert.equal(seen.ended, false);
          controller.abort();
          await assert.rejects(within(lease, 2_000, 'the acquire ending'), cancelled);
          assert.equal(abandoned, true);
          await sleep(100);
          assert.equal(mute.connections, before, 'no connection was made');
        } finally {
          pool.closeAll();
        }
      });

      it('a caller cancelled while another’s handshake succeeds leaves no lease behind', async () => {
        // Against the real server, behind a lookup that holds the open in the air for a moment.
        const pool = new SshSessionPool({ idleMs: 60_000 });
        const first = new AbortController();
        server.answer('uptime', { stdout: 'up\n' });
        const connectionsBefore = server.connections;
        try {
          const guarded = {
            ...target(),
            guard: async () => {
              await sleep(250);
              return undefined;
            },
          };
          const options = { connectTimeoutMs: 5_000 };
          const one = watched(pool.acquire(guarded, credentials(), options, first.signal));
          const two = pool.acquire(guarded, credentials(), options, new AbortController().signal);
          await sleep(50);
          first.abort();
          const lease = await within(two, 5_000, 'the other caller’s lease');
          assert.ok(one.ended && cancelled(one.error));
          assert.equal((await lease.session.exec('uptime', signal())).stdout, 'up\n');
          assert.equal(server.connections - connectionsBefore, 1);
          assert.deepEqual(
            { opened: pool.stats().opened, joined: pool.stats().joined, inUse: pool.stats().inUse },
            { opened: 1, joined: 1, inUse: 1 },
          );
          // One lease, the survivor's: given back, the connection is idle and can be evicted.
          assert.equal(pool.sweep(Date.now() + 120_000), 0, 'in use');
          lease.release();
          assert.equal(pool.stats().inUse, 0);
          assert.equal(pool.sweep(Date.now() + 120_000), 1);
        } finally {
          pool.closeAll();
        }
      });

      it('closes a connection that opened as its only caller was cancelled', async () => {
        // The handshake finishes, and in the same turn nobody is waiting: the connection is
        // closed, not kept for a check that will never use it.
        const pool = new SshSessionPool();
        const controller = new AbortController();
        const connectionsBefore = server.connections;
        const real = SshSession.open.bind(SshSession);
        try {
          const opened = new Promise<void>((resolve) => {
            // The pool's own open, with the caller cancelled between the server being ready
            // and the pool hearing of it.
            SshSession.open = async (...args: Parameters<typeof SshSession.open>) => {
              const session = await real(args[0], args[1], args[2]);
              controller.abort();
              resolve();
              return session;
            };
          });
          const lease = pool.acquire(target(), credentials(), {}, controller.signal);
          await assert.rejects(within(lease, 5_000, 'the acquire ending'), cancelled);
          await within(opened, 5_000, 'the handshake');
          await sleep(50);
          assert.equal(server.connections - connectionsBefore, 1, 'the control: it did connect');
          const stats = pool.stats();
          assert.deepEqual(
            { connections: stats.connections, opened: stats.opened, closed: stats.closed },
            { connections: 0, opened: 1, closed: 1 },
          );
        } finally {
          SshSession.open = real;
          pool.closeAll();
        }
      });

      for (const order of ['the first', 'the second'] as const) {
        it(`keeps a shared connection while ${order} of two joined callers still holds it`, async () => {
          // Two callers that joined one open hold one entry between them. Counted on two, the
          // connection looked idle as soon as one let go, and could be closed under the other.
          const pool = new SshSessionPool({ idleMs: 60_000 });
          try {
            const [one, two] = await Promise.all([
              pool.acquire(target(), credentials()),
              pool.acquire(target(), credentials()),
            ]);
            assert.equal(pool.stats().joined, 1);
            const [kept, given] = order === 'the first' ? [one, two] : [two, one];
            given.release();
            assert.equal(pool.sweep(Date.now() + 120_000), 0, 'still in use');
            assert.equal(kept.session.closed, false);
            kept.release();
            assert.equal(pool.sweep(Date.now() + 120_000), 1);
          } finally {
            pool.closeAll();
          }
        });
      }

      it('an SSH check passes its own signal, so a cancelled check ends in the handshake', async () => {
        const controller = new AbortController();
        const arriving = nextAccepted();
        const check = sshCheck(
          {
            sensorId: 69,
            target: { host: '127.0.0.1', ipVersion: 'auto' },
            params: { port: mute.port, connectTimeoutMs: LONG_MS },
            credentials: { ssh: { username: 'u', password: 'p', hostKeyPolicy: 'accept-any' } },
            signal: controller.signal,
          },
          (session) => session.exec('uptime', controller.signal),
        );
        watched(check);
        const { closed } = await within(arriving, 5_000, 'the listener accepting');
        controller.abort();
        await assert.rejects(within(check, 2_000, 'the check ending'), cancelled);
        await within(closed, 2_000, 'the socket closing at the listener');
      });

      it('a caller arriving as an open is abandoned starts its own, and is not told it was cancelled (A-73)', async () => {
        // The last waiter's abort ends the handshake a few turns later. Until then the open was
        // still there to be joined, and whoever joined it was told its own check was cancelled.
        const pool = new SshSessionPool();
        const first = new AbortController();
        const options = { connectTimeoutMs: 1_200 };
        const before = mute.connections;
        try {
          const arriving = nextAccepted();
          const one = watched(pool.acquire(mutely(), anyKey(), options, first.signal));
          const { closed } = await within(arriving, 5_000, 'the listener accepting');

          const again = nextAccepted();
          first.abort();
          // The same turn: the abandoned handshake has not ended yet.
          const startedAt = performance.now();
          const second = pool.acquire(mutely(), anyKey(), options);
          const two = watched(second);
          assert.equal(pool.stats().joined, 0, 'it joined an open nobody was waiting for');
          await within(again, 5_000, 'a connection of its own');
          await within(closed, 2_000, 'the abandoned connection closing');
          assert.ok(one.ended && cancelled(one.error));

          // **The abandoned open's ending touches only itself.** It has ended by now, and the
          // open that replaced it is still the one a third caller finds and joins.
          await sleep(150);
          assert.equal(two.ended, false, 'ended with the open it did not join');
          const three = watched(pool.acquire(mutely(), anyKey(), options));
          assert.equal(pool.stats().joined, 1, 'the open that replaced it was forgotten');

          // Its own handshake, to its own timeout, saying what happened to it.
          await assert.rejects(
            within(second, 5_000, 'the second caller’s open'),
            /could not connect to 127\.0\.0\.1/,
          );
          assert.ok(two.at - startedAt >= 1_100, 'not early');
          await sleep(20);
          assert.match(String(three.error), /could not connect to 127\.0\.0\.1/);
          assert.equal(mute.connections - before, 2, 'one connection for each open, and no third');
        } finally {
          pool.closeAll();
        }
      });

      it('closeAll ends an open in flight: its caller is told, the socket goes, nothing is kept (A-73)', async () => {
        const pool = new SshSessionPool();
        const before = mute.connections;
        const arriving = nextAccepted();
        const options = { connectTimeoutMs: LONG_MS };
        const lease = pool.acquire(mutely(), anyKey(), options);
        const joined = pool.acquire(mutely(), anyKey(), options, new AbortController().signal);
        watched(lease);
        watched(joined);
        const { closed } = await within(arriving, 5_000, 'the listener accepting');

        pool.closeAll();
        // Long before the timeout: both are told they were cancelled, which a connect timeout
        // does not say (`P-268`).
        await assert.rejects(within(lease, 2_000, 'the acquire ending'), cancelled);
        await assert.rejects(within(joined, 2_000, 'the joined acquire ending'), cancelled);
        await within(closed, 2_000, 'the socket closing at the listener');
        await sleep(50);
        const stats = pool.stats();
        assert.deepEqual(
          { connections: stats.connections, opened: stats.opened, inUse: stats.inUse },
          { connections: 0, opened: 0, inUse: 0 },
        );

        // The pool is not left holding the open: the next caller makes a connection of its own.
        const again = nextAccepted();
        const next = pool.acquire(mutely(), anyKey(), { connectTimeoutMs: 300 });
        watched(next);
        await within(again, 5_000, 'a new connection');
        await assert.rejects(within(next, 3_000, 'the new open'), /could not connect/);
        assert.equal(pool.stats().joined, 1, 'only the one that joined before the close');
        assert.equal(mute.connections - before, 2);
        pool.closeAll();
      });

      it('closeAll during the lookup leaves no connection behind in a pool nobody will close (A-73)', async () => {
        // Against the real server: the lookup ignores its signal and answers after the pool
        // was closed. The handshake that followed used to succeed and be recorded.
        const pool = new SshSessionPool({ idleMs: 60_000 });
        const connectionsBefore = server.connections;
        const lease = pool.acquire(
          {
            ...target(),
            guard: async () => {
              await sleep(250);
              return undefined;
            },
          },
          credentials(),
          { connectTimeoutMs: 5_000 },
        );
        watched(lease);
        await sleep(50);
        pool.closeAll();
        await assert.rejects(within(lease, 2_000, 'the acquire ending'), cancelled);
        await sleep(500);
        assert.equal(server.connections - connectionsBefore, 0, 'a handshake was made after all');
        const stats = pool.stats();
        assert.deepEqual(
          { connections: stats.connections, opened: stats.opened },
          { connections: 0, opened: 0 },
        );
      });
    });
  });

  it('releases the lease even when the check threw', async () => {
    const pool = new SshSessionPool();
    server.behave({ password: 'monitor', hang: true });
    try {
      await assert.rejects(() =>
        withSsh(
          target(),
          credentials(),
          { commandTimeoutMs: 200 },
          (s) => s.exec('sleep 9', signal()),
          pool,
        ),
      );
      // A leaked lease would leave this connection counted as busy for ever: never evicted, and
      // occupying the pool's bound.
      assert.equal(pool.stats().inUse, 0);
    } finally {
      pool.closeAll();
    }
  });

  it('closes a connection nothing has used for a while', async () => {
    // A pool with no eviction is a leak: a device deleted at midnight would hold its connection
    // and its authenticated session on the far end until the probe restarted. Driven by a
    // supplied clock rather than by waiting — the pool's own sweeper is on a timer, and a test
    // that raced it would assert on whichever fired first.
    const pool = new SshSessionPool({ idleMs: 60_000 });
    server.answer('uptime', { stdout: 'up\n' });
    try {
      await withSsh(target(), credentials(), {}, (s) => s.exec('uptime', signal()), pool);
      assert.equal(pool.stats().connections, 1);

      assert.equal(pool.sweep(Date.now() + 1_000), 0, 'not idle long enough yet');
      assert.equal(pool.sweep(Date.now() + 120_000), 1);
      assert.equal(pool.stats().connections, 0);
      assert.equal(pool.stats().evicted, 1);
    } finally {
      pool.closeAll();
    }
  });

  it('never evicts a connection a check is still using', async () => {
    // The lease count is what stands between eviction and a check whose connection vanished
    // mid-command.
    const pool = new SshSessionPool({ idleMs: 1 });
    try {
      const lease = await pool.acquire(target(), credentials());
      assert.equal(pool.sweep(Date.now() + 120_000), 0);
      lease.release();
      assert.equal(pool.sweep(Date.now() + 120_000), 1);
    } finally {
      pool.closeAll();
    }
  });

  it('replaces a connection the server closed underneath it', async () => {
    const pool = new SshSessionPool();
    server.answer('uptime', { stdout: 'up\n' });
    try {
      const lease = await pool.acquire(target(), credentials());
      lease.session.close();
      lease.release();

      await withSsh(target(), credentials(), {}, (s) => s.exec('uptime', signal()), pool);
      assert.equal(pool.stats().stale, 1, 'the dead connection should have been noticed');
      assert.equal(server.connections, 2);
    } finally {
      pool.closeAll();
    }
  });
});
