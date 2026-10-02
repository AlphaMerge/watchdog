import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import { HttpSimulator, Mailbox, imapServer, smtpServer, type RunningServer } from '@ms/simulators';
import { httpRequest } from '../src/types/http.js';
import { mailImap } from '../src/types/mail-imap.js';
import { mailSmtp } from '../src/types/mail-smtp.js';
import { tlsCertificate } from '../src/types/tls-certificate.js';
import { tlsSecurity } from '../src/types/tls-security.js';
import type { CheckExecution, SensorType } from '../src/contract.js';

/**
 * A device given by address, over TLS, under a certificate that lists the address (`A-67`).
 *
 * `A-60` found that Node's own identity check reads an IPv6 address as a DNS name and so refuses
 * every certificate for one, and fixed webhook delivery. These are the sensor types that make
 * the same kind of connection: each is run against `::1` under a certificate whose subject
 * alternative names list `::1`, and against the certificates that must still be refused.
 *
 * The device is the address itself, so nothing is resolved and nothing is pinned: `Host`, the
 * server name and the certificate check are all the literal. (A device given by *name* is
 * connected to at a checked address while all three stay the name; `pinned-transports.test.ts`
 * has those.)
 *
 * Certificates are made here with `openssl`, as `tls.test.ts` makes its own, and trusted through
 * `tls.setDefaultCACertificates` as `pinned-transports.test.ts` does, so that what a verifying
 * client refuses is who the certificate is for and never who issued it.
 */

type Pair = { key: string; cert: string };

interface Pairs {
  /** Lists both loopback addresses, as addresses. */
  readonly forAddresses: Pair;
  /** Lists two addresses that are neither loopback one. */
  readonly forOtherAddresses: Pair;
  /** Has `::1` as its common name and as a DNS name, and lists no address. */
  readonly speltLikeAnAddress: Pair;
  /** For the name `localhost`, and no address. */
  readonly forLocalhost: Pair;
  /** For the name `device.a67.test`, and no address. */
  readonly forName: Pair;
}

const NAME = 'device.a67.test';

/** Whether there is an `openssl` to make certificates with. Asked on its own: see `before`. */
const opensslAvailable = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let dir = '';
let pairs: Pairs | undefined;
const setTrusted = (tls as { setDefaultCACertificates?: (certs: string[]) => void })
  .setDefaultCACertificates;
const getTrusted = (tls as { getCACertificates?: (type: string) => string[] }).getCACertificates;
let trustedBefore: string[] | undefined;

function certificate(file: string, commonName: string, names: string): Pair {
  const keyFile = join(dir, `${file}.key`);
  const certFile = join(dir, `${file}.crt`);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '30',
      '-subj',
      `/CN=${commonName}`,
      '-addext',
      `subjectAltName=${names}`,
    ],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8') };
}

/** Whether `::1` can be listened on here. Asked once, with a bound. */
const v6 = await new Promise<boolean>((resolve) => {
  const server = createTcpServer();
  const timer = setTimeout(() => {
    server.close();
    resolve(false);
  }, 2_000);
  server.once('error', () => {
    clearTimeout(timer);
    resolve(false);
  });
  server.listen(0, '::1', () => {
    clearTimeout(timer);
    server.close(() => {
      resolve(true);
    });
  });
});

const mailbox = new Mailbox();
const mailServers: RunningServer[] = [];
const httpServers: HttpSimulator[] = [];
const tlsServers: tls.Server[] = [];

before(() => {
  // **Only a missing `openssl` skips.** Anything else that goes wrong here throws, and every
  // case fails with it: these cases are the proof that verification was not weakened, and a
  // certificate that could not be made must not turn them into skips that read as green.
  if (!opensslAvailable) return;
  dir = mkdtempSync(join(tmpdir(), 'ms-a67-'));
  pairs = {
    forAddresses: certificate('addresses', 'ms-a67-test', 'IP:127.0.0.1,IP:::1'),
    forOtherAddresses: certificate('others', 'ms-a67-test', 'IP:127.0.0.2,IP:::2'),
    speltLikeAnAddress: certificate('spelt', '::1', 'DNS:::1'),
    forLocalhost: certificate('localhost', 'localhost', 'DNS:localhost'),
    forName: certificate('name', NAME, `DNS:${NAME}`),
  };
  if (setTrusted !== undefined && getTrusted !== undefined) {
    trustedBefore = getTrusted('default');
    setTrusted([...trustedBefore, ...Object.values(pairs).map((pair: Pair) => pair.cert)]);
  }
});

after(async () => {
  if (trustedBefore !== undefined && setTrusted !== undefined) setTrusted(trustedBefore);
  for (const server of mailServers) await server.close();
  for (const server of httpServers) await server.stop();
  for (const server of tlsServers) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

/** The certificates, or a skip that says why there are none. */
function ready(t: { skip(reason: string): void }, needsV6: boolean): Pairs | null {
  if (!opensslAvailable) {
    t.skip('openssl is not on this machine');
    return null;
  }
  assert.ok(pairs !== undefined, 'the certificates were not made, and openssl is here');
  if (trustedBefore === undefined) {
    t.skip('this Node has no tls.setDefaultCACertificates to trust a test certificate with');
    return null;
  }
  if (needsV6 && !v6) {
    t.skip('this machine has no IPv6 loopback (::1) to listen on');
    return null;
  }
  return pairs;
}

function run(
  type: SensorType,
  host: string,
  params: Record<string, unknown>,
  ipVersion: 'auto' | 'v4' = 'auto',
): Promise<CheckExecution> {
  return type.execute({
    sensorId: 67,
    target: { host, ipVersion },
    params: { timeoutMs: 5_000, ...params },
    credentials: { mail: { username: 'ops', password: 'hunter2' } },
    // A check that is still running after this is a hang, and says so instead of the file's
    // own timeout doing it.
    signal: AbortSignal.timeout(15_000),
  });
}

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

async function https(pair: Pair, listenHost: string): Promise<HttpSimulator> {
  const simulator = new HttpSimulator({
    tls: pair,
    listenHost,
    routes: { '/status': { status: 200, body: 'ok' } },
  });
  httpServers.push(simulator);
  await simulator.start();
  return simulator;
}

/**
 * A TLS server that completes a handshake and hangs up, and records each name it was asked for.
 * Recorded as the hello is read, so it is there before the client's handshake has completed;
 * a hello that names nobody records nothing.
 */
async function handshakes(
  pair: Pair,
  listenHost: string,
): Promise<{ port: number; named: string[] }> {
  const named: string[] = [];
  const server = tls.createServer(
    {
      key: pair.key,
      cert: pair.cert,
      SNICallback: (name, done) => {
        named.push(name);
        done(null);
      },
    },
    (socket) => {
      socket.end();
    },
  );
  server.on('tlsClientError', () => undefined);
  tlsServers.push(server);
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, listenHost, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  return { port, named };
}

async function mail(
  make: typeof smtpServer,
  options: Partial<Parameters<typeof smtpServer>[0]>,
): Promise<number> {
  const server = await make({ mailbox, username: 'ops', password: 'hunter2', ...options });
  mailServers.push(server);
  return server.port;
}

const HTTPS = { scheme: 'https', path: '/status', verifyTls: true };

describe('http.request to a device given by address, over HTTPS', () => {
  it('reaches https://[::1] under a certificate that lists ::1', async (t) => {
    const certificates = ready(t, true);
    if (certificates === null) return;
    const simulator = await https(certificates.forAddresses, '::1');
    const execution = await run(httpRequest, '::1', { ...HTTPS, port: simulator.port });
    assert.equal(valueOf(execution, 'statusCode'), 200);
    assert.equal(simulator.requests.length, 1);
    // What this sensor has always sent as the server name for a device given by address, and
    // still does: the check changed, and nothing about the hello.
    assert.equal(simulator.requests[0]?.servername, '::1');
  });

  it('refuses, for ::1, every certificate that does not list that address', async (t) => {
    const certificates = ready(t, true);
    if (certificates === null) return;
    for (const [label, pair] of [
      ['other addresses', certificates.forOtherAddresses],
      ['the address as a DNS name and a common name', certificates.speltLikeAnAddress],
      ['a name', certificates.forLocalhost],
    ] as const) {
      const simulator = await https(pair, '::1');
      await assert.rejects(
        () => run(httpRequest, '::1', { ...HTTPS, port: simulator.port }),
        /the certificate at .* is not valid for ::1/,
        label,
      );
      assert.deepEqual(simulator.requests, [], `${label}: a request was sent`);
    }
  });

  it('with verification off, reaches ::1 under any of them, as before', async (t) => {
    const certificates = ready(t, true);
    if (certificates === null) return;
    const simulator = await https(certificates.forOtherAddresses, '::1');
    const execution = await run(httpRequest, '::1', {
      ...HTTPS,
      verifyTls: false,
      port: simulator.port,
    });
    assert.equal(valueOf(execution, 'statusCode'), 200);
  });

  it('for 127.0.0.1 is as it was: the listed address reached, another refused', async (t) => {
    const certificates = ready(t, false);
    if (certificates === null) return;
    const listed = await https(certificates.forAddresses, '127.0.0.1');
    const execution = await run(httpRequest, '127.0.0.1', { ...HTTPS, port: listed.port });
    assert.equal(valueOf(execution, 'statusCode'), 200);
    const other = await https(certificates.forOtherAddresses, '127.0.0.1');
    await assert.rejects(
      () => run(httpRequest, '127.0.0.1', { ...HTTPS, port: other.port }),
      /is not valid for 127\.0\.0\.1/,
    );
  });
});

describe('tls.certificate and tls.security on a device given by address', () => {
  it('reads a trusted certificate that lists ::1 as trusted', async (t) => {
    // The sensor never refuses a certificate: it reports. What it reports as `trusted` is
    // Node's verdict on the connection, and that verdict includes who the certificate is for —
    // so a certificate for `::1` read 0 here for the reason webhook delivery failed.
    const certificates = ready(t, true);
    if (certificates === null) return;
    const server = await handshakes(certificates.forAddresses, '::1');
    const execution = await run(tlsCertificate, '::1', { port: server.port });
    assert.equal(valueOf(execution, 'trusted'), 1, execution.message);
    assert.ok((valueOf(execution, 'daysRemaining') ?? -1) >= 28);
    assert.deepEqual(server.named, ['::1'], 'the server name it sends for an address is unchanged');
    // `hostMatches` is the sensor's own reading, of names only (the common name and DNS
    // entries), for either address family. Not Node's check, and not changed here.
    assert.equal(valueOf(execution, 'hostMatches'), 0);
  });

  it('still reads a certificate for another address as not trusted, and still reads it', async (t) => {
    const certificates = ready(t, true);
    if (certificates === null) return;
    for (const pair of [certificates.forOtherAddresses, certificates.speltLikeAnAddress]) {
      const server = await handshakes(pair, '::1');
      const execution = await run(tlsCertificate, '::1', { port: server.port });
      assert.equal(valueOf(execution, 'trusted'), 0);
      assert.match(execution.message ?? '', /not trusted: ERR_TLS_CERT_ALTNAME_INVALID/);
      // A reading and not a failed check: the countdown is what the sensor is for.
      assert.ok((valueOf(execution, 'daysRemaining') ?? -1) >= 28);
    }
  });

  it('reads 127.0.0.1 as it did: trusted where listed, not where another is', async (t) => {
    const certificates = ready(t, false);
    if (certificates === null) return;
    const listed = await handshakes(certificates.forAddresses, '127.0.0.1');
    const good = await run(tlsCertificate, '127.0.0.1', { port: listed.port });
    assert.equal(valueOf(good, 'trusted'), 1, good.message);
    const other = await handshakes(certificates.forOtherAddresses, '127.0.0.1');
    const bad = await run(tlsCertificate, '127.0.0.1', { port: other.port });
    assert.equal(valueOf(bad, 'trusted'), 0);
  });

  it('with a server name declared, a device at ::1 is checked by that name, by Node', async (t) => {
    const certificates = ready(t, true);
    if (certificates === null) return;
    const named = await handshakes(certificates.forName, '::1');
    const good = await run(tlsCertificate, '::1', { port: named.port, servername: NAME });
    assert.equal(valueOf(good, 'trusted'), 1, good.message);
    assert.equal(valueOf(good, 'hostMatches'), 1);
    assert.deepEqual(named.named, [NAME]);
    // The address is not what was asked for, so a certificate that lists it is not for this.
    const addressed = await handshakes(certificates.forAddresses, '::1');
    const bad = await run(tlsCertificate, '::1', { port: addressed.port, servername: NAME });
    assert.equal(valueOf(bad, 'trusted'), 0);
    assert.equal(valueOf(bad, 'hostMatches'), 0);
  });

  it('tls.security probes ::1 and reads nothing of who the certificate is for', async (t) => {
    const certificates = ready(t, true);
    if (certificates === null) return;
    // The same reading under a certificate for the address and under one for another: this
    // sensor reports protocol versions, and identity is no part of it.
    const readings: (number | undefined)[] = [];
    for (const pair of [certificates.forAddresses, certificates.forOtherAddresses]) {
      const server = await handshakes(pair, '::1');
      const execution = await run(tlsSecurity, '::1', { port: server.port });
      const primary = execution.channels[0];
      assert.ok(primary !== undefined, 'no channel was reported');
      readings.push(primary.value);
    }
    assert.equal(readings[0], readings[1]);
  });
});

describe('mail sensors on a device given by address, verifying the certificate', () => {
  const VERIFIED = { verifyTls: true, requireAuth: true };

  it('mail.smtp over implicit TLS reaches ::1 under a certificate that lists ::1', async (t) => {
    const certificates = ready(t, true);
    if (certificates === null) return;
    const servernames: string[] = [];
    const port = await mail(smtpServer, {
      tls: certificates.forAddresses,
      implicitTls: true,
      listenHost: '::1',
      servernames,
    });
    const execution = await run(mailSmtp, '::1', { ...VERIFIED, port, security: 'tls' });
    assert.ok((valueOf(execution, 'totalTime') ?? -1) >= 0);
    // An address is not a server name, and none is sent for one (RFC 6066).
    assert.deepEqual(servernames, ['']);
  });

  it('mail.smtp after STARTTLS reaches ::1 under a certificate that lists ::1', async (t) => {
    const certificates = ready(t, true);
    if (certificates === null) return;
    const servernames: string[] = [];
    const port = await mail(smtpServer, {
      tls: certificates.forAddresses,
      offerStartTls: true,
      listenHost: '::1',
      servernames,
    });
    const execution = await run(mailSmtp, '::1', { ...VERIFIED, port, security: 'starttls' });
    assert.ok((valueOf(execution, 'totalTime') ?? -1) >= 0);
    assert.deepEqual(servernames, ['']);
  });

  it('mail.imap, on the same connection code, reaches ::1 both ways', async (t) => {
    const certificates = ready(t, true);
    if (certificates === null) return;
    const implicit = await mail(imapServer, {
      tls: certificates.forAddresses,
      implicitTls: true,
      listenHost: '::1',
    });
    await run(mailImap, '::1', { verifyTls: true, port: implicit, security: 'tls' });
    const upgraded = await mail(imapServer, {
      tls: certificates.forAddresses,
      offerStartTls: true,
      listenHost: '::1',
    });
    await run(mailImap, '::1', { verifyTls: true, port: upgraded, security: 'starttls' });
  });

  for (const security of ['tls', 'starttls'] as const) {
    it(`refuses, for ::1 (${security}), every certificate that does not list that address`, async (t) => {
      const certificates = ready(t, true);
      if (certificates === null) return;
      for (const [label, pair] of [
        ['other addresses', certificates.forOtherAddresses],
        ['the address as a DNS name and a common name', certificates.speltLikeAnAddress],
        // After STARTTLS this one was *accepted* before `A-67`, for any address: see below.
        ['the name localhost', certificates.forLocalhost],
      ] as const) {
        const port = await mail(smtpServer, {
          tls: pair,
          listenHost: '::1',
          ...(security === 'tls' ? { implicitTls: true } : { offerStartTls: true }),
        });
        await assert.rejects(
          () => run(mailSmtp, '::1', { ...VERIFIED, port, security }),
          /the certificate at .* is not valid for ::1/,
          label,
        );
      }
    });
  }

  it('after STARTTLS on 127.0.0.1, the certificate is checked against the address and not against "localhost"', async (t) => {
    // Found by `A-67` and not an IPv6 matter. The upgrade hands Node a connected socket and no
    // host; for a device given by address there is no server name either, and Node then checks
    // the certificate against the literal name `localhost`. So a relay at any address was
    // refused under a certificate that lists its address, and accepted under any trusted
    // certificate for `localhost`. Implicit TLS never had this: there the host is given.
    const certificates = ready(t, false);
    if (certificates === null) return;
    const listed = await mail(smtpServer, { tls: certificates.forAddresses, offerStartTls: true });
    const execution = await run(mailSmtp, '127.0.0.1', {
      ...VERIFIED,
      port: listed,
      security: 'starttls',
    });
    assert.ok((valueOf(execution, 'totalTime') ?? -1) >= 0);

    for (const pair of [certificates.forLocalhost, certificates.forOtherAddresses]) {
      const port = await mail(smtpServer, { tls: pair, offerStartTls: true });
      await assert.rejects(
        () => run(mailSmtp, '127.0.0.1', { ...VERIFIED, port, security: 'starttls' }),
        /the certificate at .* is not valid for 127\.0\.0\.1/,
      );
    }
  });

  it('over implicit TLS on 127.0.0.1 is as it was: the listed address reached, others refused', async (t) => {
    const certificates = ready(t, false);
    if (certificates === null) return;
    const listed = await mail(smtpServer, { tls: certificates.forAddresses, implicitTls: true });
    await run(mailSmtp, '127.0.0.1', { ...VERIFIED, port: listed, security: 'tls' });
    for (const pair of [certificates.forLocalhost, certificates.forOtherAddresses]) {
      const port = await mail(smtpServer, { tls: pair, implicitTls: true });
      await assert.rejects(
        () => run(mailSmtp, '127.0.0.1', { ...VERIFIED, port, security: 'tls' }),
        /the certificate at .* is not valid for 127\.0\.0\.1/,
      );
    }
  });

  it('a device given by name is still checked by its name after STARTTLS', async (t) => {
    // `localhost` resolves here without any help, and is a name: Node's own check, with the
    // name sent as the server name, as before.
    const certificates = ready(t, false);
    if (certificates === null) return;
    const servernames: string[] = [];
    const good = await mail(smtpServer, {
      tls: certificates.forLocalhost,
      offerStartTls: true,
      servernames,
    });
    // IPv4, because that is where these two servers listen.
    await run(mailSmtp, 'localhost', { ...VERIFIED, port: good, security: 'starttls' }, 'v4');
    assert.deepEqual(servernames, ['localhost']);
    const bad = await mail(smtpServer, { tls: certificates.forAddresses, offerStartTls: true });
    await assert.rejects(
      () => run(mailSmtp, 'localhost', { ...VERIFIED, port: bad, security: 'starttls' }, 'v4'),
      /is not valid for localhost/,
    );
  });
});
