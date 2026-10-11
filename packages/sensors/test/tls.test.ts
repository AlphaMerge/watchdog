import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tlsCertificate } from '../src/types/tls-certificate.js';
import { tlsSecurity } from '../src/types/tls-security.js';
import {
  chainOf,
  daysUntil,
  inspectCertificate,
  nameMatches,
  namesOf,
  addressesOf,
} from '../src/support/tls/handshake.js';
import type { CheckContext, CheckExecution, SensorType } from '../src/contract.js';

/**
 * Real TLS servers with real certificates, generated here.
 *
 * The live half needs a server, so the certificates are generated at test time with `openssl`
 * rather than committed — a fixture certificate expires, and turns a passing suite into a
 * failing one on a date nobody chose.
 *
 * The *expired* case is not here, and cannot be: `openssl req` gained `-not_before` in 3.2 and
 * this machine has 3.0, so there is no portable way to issue a certificate that has already run
 * out. That case lives in `inspectCertificate`'s own tests instead, against a fabricated
 * certificate — which is not a compromise, because the input is a plain object either way and
 * what is being tested is the arithmetic.
 */

let dir = '';
let good: Server;
let modern: Server;
const ports = { good: 0, modern: 0 };
let available = true;

/** A self-signed certificate for `cn`, valid for `days`. */
function certificate(name: string, cn: string, days: number): { key: string; cert: string } {
  const keyFile = join(dir, `${name}.key`);
  const certFile = join(dir, `${name}.crt`);
  execFileSync('openssl', [
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
    String(days),
    '-subj',
    `/CN=${cn}`,
    '-addext',
    `subjectAltName=DNS:${cn},DNS:*.wild.${cn}`,
  ]);
  return { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8') };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

before(async () => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
  } catch {
    available = false;
    return;
  }
  dir = mkdtempSync(join(tmpdir(), 'ms-tls-'));

  const valid = certificate('good', 'localhost', 90);

  good = createServer({ key: valid.key, cert: valid.cert }, (socket) => socket.end());
  // Pinned to 1.2 and above, so the weak-version probes fail against it and the strong ones do
  // not — which is what the score is computed from.
  modern = createServer({ key: valid.key, cert: valid.cert, minVersion: 'TLSv1.2' }, (socket) =>
    socket.end(),
  );

  ports.good = await listen(good);
  ports.modern = await listen(modern);
});

after(async () => {
  // `undefined` when `before` bailed out because openssl was missing, whatever the type says.
  for (const server of [good, modern] as (Server | undefined)[]) {
    if (server === undefined) continue;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

function run(
  type: SensorType,
  params: Record<string, unknown> = {},
  over: Partial<CheckContext> = {},
): Promise<CheckExecution> {
  return type.execute({
    sensorId: 1,
    target: { host: '127.0.0.1', ipVersion: 'v4' },
    params: { servername: 'localhost', timeoutMs: 8_000, ...params },
    credentials: {},
    signal: new AbortController().signal,
    ...over,
  });
}

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

describe('reading a certificate', () => {
  it('matches a wildcard against exactly one label', () => {
    // The rule browsers enforce, and the one a naive `startsWith` gets wrong in the direction
    // that accepts too much.
    assert.equal(nameMatches('*.example.com', 'a.example.com'), true);
    assert.equal(nameMatches('*.example.com', 'a.b.example.com'), false);
    assert.equal(nameMatches('*.example.com', 'example.com'), false);
    assert.equal(nameMatches('example.com', 'EXAMPLE.COM'), true);
    assert.equal(nameMatches('', 'example.com'), false);
  });

  it('collects the common name and every DNS SAN', () => {
    const names = namesOf({
      subject: { CN: 'example.com' },
      subjectaltname: 'DNS:example.com, DNS:www.example.com, IP Address:10.0.0.1',
    } as never);
    assert.deepEqual(names, ['example.com', 'www.example.com']);
  });

  it('collects every IP SAN apart from the names, for the mismatch note (A-75)', () => {
    const certificate = {
      subject: { CN: 'example.com' },
      subjectaltname: 'DNS:example.com, IP Address:10.0.0.1, IP Address:FD00:0:0:0:0:0:0:1',
    };
    assert.deepEqual(addressesOf(certificate as never), ['10.0.0.1', 'FD00:0:0:0:0:0:0:1']);
    assert.deepEqual(addressesOf({ subjectaltname: 'DNS:example.com' }), []);
    // Absent on a certificate with no SANs at all.
    assert.deepEqual(addressesOf({}), []);
  });

  it('stops walking a chain at a self-issued root rather than looping', () => {
    // A root is its own issuer, which is where an unguarded walk spins for ever.
    const root = { fingerprint256: 'aa', subject: { CN: 'Root' } } as Record<string, unknown>;
    root['issuerCertificate'] = root;
    assert.equal(chainOf(root as never).length, 1);
  });

  it('counts whole days, and goes negative once past', () => {
    const now = new Date('2026-08-27T00:00:00Z');
    assert.equal(daysUntil(new Date('2026-09-06T00:00:00Z'), now), 10);
    assert.equal(daysUntil(new Date('2026-08-17T00:00:00Z'), now), -10);
  });

  it('counts an expired certificate down past zero rather than refusing it', () => {
    // The whole design of the sensor, and the case a live server cannot produce here. A client
    // that verified would refuse the handshake and the sensor would report *nothing* — at
    // exactly the moment somebody needs the number.
    const verdict = inspectCertificate(
      leafCertificate({ valid_to: '2026-08-17T00:00:00Z' }),
      'example.com',
      new Date('2026-08-27T00:00:00Z'),
    );
    assert.equal(verdict.daysRemaining, -10);
  });

  it('takes the soonest expiry from the whole chain, and says whose it is', () => {
    // An expiring intermediate takes a site down exactly as an expiring leaf does, renews on
    // somebody else's schedule, and is the one nobody is watching.
    const intermediate = {
      subject: { CN: 'Some Intermediate CA' },
      issuer: { CN: 'Some Root' },
      valid_from: '2026-01-01T00:00:00Z',
      valid_to: '2026-09-01T00:00:00Z',
      fingerprint256: 'bb',
    } as Record<string, unknown>;
    const leaf = leafCertificate({ valid_to: '2027-01-01T00:00:00Z' }) as Record<string, unknown>;
    leaf['issuerCertificate'] = intermediate;
    intermediate['issuerCertificate'] = intermediate;

    const verdict = inspectCertificate(
      leaf as never,
      'example.com',
      new Date('2026-08-27T00:00:00Z'),
    );
    assert.equal(verdict.daysRemaining, 5, 'the intermediate expires first');
    assert.equal(verdict.soonestSubject, 'Some Intermediate CA');
    assert.equal(verdict.chainLength, 2);
  });

  it('reports a name it is not valid for without refusing to read it', () => {
    const verdict = inspectCertificate(leafCertificate({}), 'not-the-name.example');
    assert.equal(verdict.hostMatches, false);
    assert.deepEqual(verdict.names, ['example.com', 'www.example.com']);
  });

  it('names the issuer, falling back to the organisation', () => {
    assert.equal(inspectCertificate(leafCertificate({}), 'example.com').issuer, 'Some CA');
    const noCn = leafCertificate({}) as Record<string, unknown>;
    noCn['issuer'] = { O: 'An Organisation' };
    assert.equal(inspectCertificate(noCn as never, 'example.com').issuer, 'An Organisation');
  });
});

/** A certificate as `getPeerCertificate` returns one, with only the fields these read. */
function leafCertificate(over: Record<string, unknown>): never {
  return {
    subject: { CN: 'example.com' },
    issuer: { CN: 'Some CA' },
    subjectaltname: 'DNS:example.com, DNS:www.example.com',
    valid_from: '2026-08-01T00:00:00Z',
    valid_to: '2026-11-01T00:00:00Z',
    fingerprint256: 'aa',
    ...over,
  } as never;
}

describe('tls.certificate', () => {
  it('counts down the days and names the issuer', async (t) => {
    if (!available) {
      t.skip('openssl is not on this machine');
      return;
    }
    const execution = await run(tlsCertificate, { port: ports.good });
    const days = valueOf(execution, 'daysRemaining') ?? 0;
    assert.ok(days > 85 && days <= 90, `expected about 90 days, got ${String(days)}`);
    assert.equal(valueOf(execution, 'hostMatches'), 1);
    assert.equal(valueOf(execution, 'chainLength'), 1);
    assert.match(execution.message ?? '', /days left, issued by localhost/);
  });

  it('reports an untrusted chain as a channel, not as a failure', async (t) => {
    if (!available) {
      t.skip('openssl is not on this machine');
      return;
    }
    // Self-signed. A fact to alarm on with a limit — and failing the check would lose the
    // expiry countdown, which is the channel that matters most.
    const execution = await run(tlsCertificate, { port: ports.good });
    assert.equal(valueOf(execution, 'trusted'), 0);
    assert.match(execution.message ?? '', /chain is not trusted/);
  });

  it('reports a name mismatch as a channel, naming what the certificate is for', async (t) => {
    if (!available) {
      t.skip('openssl is not on this machine');
      return;
    }
    const execution = await run(tlsCertificate, {
      port: ports.good,
      servername: 'not-the-name.example',
    });
    assert.equal(valueOf(execution, 'hostMatches'), 0);
    assert.match(execution.message ?? '', /certificate is for localhost.*asked for not-the-name/s);
  });

  it('makes the countdown the channel it is judged by', () => {
    assert.deepEqual(
      tlsCertificate
        .channels({})
        .filter((c) => c.isPrimary === true)
        .map((c) => c.key),
      ['daysRemaining'],
    );
  });

  it('says nothing is listening rather than "handshake failed"', async () => {
    await assert.rejects(() => run(tlsCertificate, { port: 1 }), /nothing is listening at/);
  });

  it('returns promptly when the check is aborted', async (t) => {
    if (!available) {
      t.skip('openssl is not on this machine');
      return;
    }
    const controller = new AbortController();
    const started = Date.now();
    const pending = run(
      tlsCertificate,
      { port: 9, timeoutMs: 30_000 },
      { target: { host: '198.51.100.1', ipVersion: 'v4' }, signal: controller.signal },
    );
    setTimeout(() => {
      controller.abort();
    }, 100);
    await assert.rejects(() => pending, /cancelled/);
    assert.ok(Date.now() - started < 3_000);
  });
});

describe('tls.security', () => {
  it('scores by the weakest version still accepted', async (t) => {
    if (!available) {
      t.skip('openssl is not on this machine');
      return;
    }
    // An endpoint offering 1.3 *and* 1.0 is a 1.0 endpoint, because the attacker picks. This
    // server refuses anything below 1.2, so the score is 1.2's.
    const execution = await run(tlsSecurity, { port: ports.modern, timeoutMs: 4_000 });
    assert.equal(valueOf(execution, 'tls10'), 0);
    assert.equal(valueOf(execution, 'tls11'), 0);
    assert.equal(valueOf(execution, 'tls12'), 1);
    assert.equal(valueOf(execution, 'score'), 80, 'the weakest accepted is TLS 1.2');
    assert.match(execution.message ?? '', /accepts TLS 1\.2/);
  });

  it('counts how many versions are accepted', async (t) => {
    if (!available) {
      t.skip('openssl is not on this machine');
      return;
    }
    const execution = await run(tlsSecurity, { port: ports.modern, timeoutMs: 4_000 });
    const versions = valueOf(execution, 'versions') ?? 0;
    assert.ok(versions >= 1 && versions <= 2, `1.2 and possibly 1.3, got ${String(versions)}`);
  });

  it('fails only when no version at all was accepted', async () => {
    // A refused *version* is the reading; a refused connection is a broken check, and the two
    // have to look different or an unreachable host scores as a perfectly hardened one.
    await assert.rejects(
      () => run(tlsSecurity, { port: 1, timeoutMs: 1_000 }),
      /accepted no TLS version at all/,
    );
  });

  it('makes the weakest-accepted score the channel it is judged by', () => {
    assert.deepEqual(
      tlsSecurity
        .channels({})
        .filter((c) => c.isPrimary === true)
        .map((c) => c.key),
      ['score'],
    );
  });
});
