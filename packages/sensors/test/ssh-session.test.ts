import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { SshError, SshSession } from '../src/support/ssh/session.js';
import { SshSessionPool, withSsh } from '../src/support/ssh/pool.js';
import {
  readCredentials,
  SshCredentialError,
  credentialFingerprint,
  type SshCredentials,
} from '../src/support/ssh/credentials.js';
import { fingerprintOf, matchesFingerprint, verifyHostKey } from '../src/support/ssh/host-key.js';
import { keyPair, TestSshServer } from './support/ssh-server.js';

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
    const verdict = verifyHostKey('strict', '', Buffer.from('k'));
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
    const started = Date.now();
    await assert.rejects(
      () => session.exec('sleep 9999', signal()),
      /sleep 9999 did not finish on 127\.0\.0\.1 within 300 ms/,
    );
    assert.ok(Date.now() - started < 3_000);
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
    const started = Date.now();
    const pending = session.exec('sleep 9999', controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 50);
    await assert.rejects(() => pending, /cancelled while running a command/);
    assert.ok(Date.now() - started < 2_000);

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
