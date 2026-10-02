import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import { serverIdentity } from '../src/net/server-identity.js';

/**
 * The one identity check every TLS client here passes (`A-60`, `A-67`), and the measurement it
 * rests on.
 *
 * Certificates are made here with `openssl`; none is committed, because a committed one expires
 * on a date nobody chose.
 */

let dir = '';
let made: Record<'addresses' | 'others' | 'spelt' | 'name', PeerCertificate> | undefined;

/** A certificate as Node hands one to `checkServerIdentity`: the parsed fields and the DER. */
function certificate(file: string, commonName: string, names: string): PeerCertificate {
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
      join(dir, `${file}.key`),
      '-out',
      certFile,
      '-days',
      '2',
      '-subj',
      `/CN=${commonName}`,
      '-addext',
      `subjectAltName=${names}`,
    ],
    { stdio: 'ignore' },
  );
  const parsed = new X509Certificate(readFileSync(certFile));
  return { ...parsed.toLegacyObject(), raw: parsed.raw };
}

before(() => {
  try {
    dir = mkdtempSync(join(tmpdir(), 'ms-identity-'));
    made = {
      addresses: certificate('addresses', 'ms-identity-test', 'IP:127.0.0.1,IP:::1'),
      others: certificate('others', 'ms-identity-test', 'IP:127.0.0.2,IP:::2'),
      spelt: certificate('spelt', '::1', 'DNS:::1'),
      name: certificate('name', 'device.test', 'DNS:device.test,DNS:*.wild.test'),
    };
  } catch {
    made = undefined;
  }
});

after(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

function certificates(t: { skip(reason: string): void }): NonNullable<typeof made> | null {
  if (made === undefined) t.skip('openssl is not on this machine');
  return made ?? null;
}

describe('who a certificate is for', () => {
  it('Node’s own check refuses ::1 under a certificate that lists ::1, which is why this exists', (t) => {
    // The measurement, taken directly (`A-60` reported it; `A-67` took it again before leaning
    // on it). If this fails, Node has learned to check an IPv6 address: `serverIdentity` can
    // then hand everything to Node, and this file says so before anybody wonders.
    const pairs = certificates(t);
    if (pairs === null) return;
    assert.equal(new X509Certificate(pairs.addresses.raw).checkIP('::1'), '::1');
    const refused = checkServerIdentity('::1', pairs.addresses);
    assert.ok(refused instanceof Error, `Node ${process.version} accepted ::1 by itself`);
    // Read as a name: the complaint is about a host and a common name, not about an address.
    assert.match(refused.message, /Host: ::1\. is not cert's CN/);
    // And the same certificate is accepted for the IPv4 address it lists.
    assert.equal(checkServerIdentity('127.0.0.1', pairs.addresses), undefined);
  });

  it('accepts an IPv6 address the certificate lists, however it is spelt', (t) => {
    const pairs = certificates(t);
    if (pairs === null) return;
    assert.equal(serverIdentity('::1', pairs.addresses), undefined);
    assert.equal(serverIdentity('0:0:0:0:0:0:0:1', pairs.addresses), undefined);
  });

  it('refuses an IPv6 address the certificate does not list as an address', (t) => {
    const pairs = certificates(t);
    if (pairs === null) return;
    for (const [label, certificate] of [
      ['other addresses', pairs.others],
      ['the address as a DNS name and a common name', pairs.spelt],
      ['a name', pairs.name],
    ] as const) {
      const refused = serverIdentity('::1', certificate);
      assert.ok(refused instanceof Error, label);
      assert.equal((refused as NodeJS.ErrnoException).code, 'ERR_TLS_CERT_ALTNAME_INVALID');
      assert.match(refused.message, /IP: ::1 is not in the cert's list/);
    }
    assert.ok(serverIdentity('::2', pairs.addresses) instanceof Error);
  });

  it('refuses a certificate with nothing to ask, whatever its fields say', () => {
    // No DER: only the string a second parser would have had to trust.
    const claimed = { subject: { CN: '::1' }, subjectaltname: 'IP Address:0:0:0:0:0:0:0:1' };
    assert.ok(serverIdentity('::1', claimed as unknown as PeerCertificate) instanceof Error);
  });

  it('leaves a name and an IPv4 address to Node, verdict for verdict', (t) => {
    const pairs = certificates(t);
    if (pairs === null) return;
    for (const host of ['127.0.0.1', '127.0.0.2', '127.0.0.3', 'device.test', 'a.wild.test']) {
      for (const certificate of Object.values(pairs)) {
        const ours = serverIdentity(host, certificate);
        const nodes = checkServerIdentity(host, certificate);
        assert.equal(ours?.message, nodes?.message, host);
      }
    }
    assert.equal(serverIdentity('device.test', pairs.name), undefined);
    assert.equal(serverIdentity('a.wild.test', pairs.name), undefined);
    assert.ok(serverIdentity('other.test', pairs.name) instanceof Error);
    assert.equal(serverIdentity('127.0.0.1', pairs.addresses), undefined);
    assert.ok(serverIdentity('127.0.0.1', pairs.others) instanceof Error);
    assert.ok(serverIdentity('127.0.0.1', pairs.name) instanceof Error);
  });
});
