import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import { certificateListsAddress, serverIdentity } from '../src/net/server-identity.js';

/**
 * The one identity check every TLS client here passes (`A-60`, `A-67`), and the measurement it
 * rests on.
 *
 * Certificates are made here with `openssl`; none is committed, because a committed one expires
 * on a date nobody chose.
 */

let dir = '';
let made:
  Record<'addresses' | 'others' | 'spelt' | 'name' | 'linkLocal', PeerCertificate> | undefined;

/** Whether there is an `openssl` to make certificates with. Asked on its own: see `before`. */
const opensslAvailable = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

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
  // **Only a missing `openssl` skips.** Anything else that goes wrong here throws, and every
  // case fails with it: these cases are the proof that verification was not weakened, and a
  // certificate that could not be made must not turn them into skips that read as green.
  if (!opensslAvailable) return;
  dir = mkdtempSync(join(tmpdir(), 'ms-identity-'));
  made = {
    addresses: certificate('addresses', 'ms-identity-test', 'IP:127.0.0.1,IP:::1'),
    others: certificate('others', 'ms-identity-test', 'IP:127.0.0.2,IP:::2'),
    spelt: certificate('spelt', '::1', 'DNS:::1'),
    name: certificate('name', 'device.test', 'DNS:device.test,DNS:*.wild.test'),
    linkLocal: certificate('link-local', 'ms-identity-test', 'IP:fe80::1'),
  };
});

after(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

function certificates(t: { skip(reason: string): void }): NonNullable<typeof made> | null {
  if (!opensslAvailable) {
    t.skip('openssl is not on this machine');
    return null;
  }
  assert.ok(made !== undefined, 'the certificates were not made, and openssl is here');
  return made;
}

describe('who a certificate is for', () => {
  it('Node’s own check refuses ::1 under a certificate that lists ::1, which is why this exists', (t) => {
    // The measurement, taken directly (`A-60` reported it; `A-67` took it again before leaning
    // on it). The one test here meant to fail on the day Node learns to check an IPv6 address,
    // and the only one that does: every other case asks `serverIdentity`, whose own branch
    // goes on answering as it did.
    const pairs = certificates(t);
    if (pairs === null) return;
    assert.equal(new X509Certificate(pairs.addresses.raw).checkIP('::1'), '::1');
    const refused = checkServerIdentity('::1', pairs.addresses);
    assert.ok(
      refused instanceof Error,
      `Node ${process.version} now accepts an IPv6 host under a certificate that lists it, by ` +
        'itself. Nothing is broken: the IPv6 branch of serverIdentity ' +
        '(packages/shared/src/net/server-identity.ts) is no longer needed and can go, leaving ' +
        'it to return checkServerIdentity(host, certificate) for every host. Delete this test ' +
        '(packages/shared/test/server-identity.test.ts) with it.',
    );
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

  it('takes the zone off a link-local address before asking the certificate', (t) => {
    // `fe80::1%eth0` is the only way to reach `fe80::1`, and the certificate lists the address.
    const pairs = certificates(t);
    if (pairs === null) return;
    assert.equal(serverIdentity('fe80::1%eth0', pairs.linkLocal), undefined);
    assert.equal(serverIdentity('fe80::1', pairs.linkLocal), undefined);
    assert.equal(serverIdentity('::1%lo', pairs.addresses), undefined);
    // The zone buys nothing: another address's certificate is refused with it as without.
    for (const certificate of [pairs.others, pairs.addresses, pairs.name, pairs.spelt]) {
      const refused = serverIdentity('fe80::1%eth0', certificate);
      assert.ok(refused instanceof Error);
      assert.equal((refused as NodeJS.ErrnoException).code, 'ERR_TLS_CERT_ALTNAME_INVALID');
    }
    assert.ok(serverIdentity('fe80::2%eth0', pairs.linkLocal) instanceof Error);
  });

  it('refuses a host that is only a zone, or a zone with no address, and does not throw', (t) => {
    const pairs = certificates(t);
    if (pairs === null) return;
    for (const host of ['%eth0', '%', '%fe80::1', 'eth0%fe80::1']) {
      for (const certificate of Object.values(pairs)) {
        assert.ok(serverIdentity(host, certificate) instanceof Error, host);
      }
    }
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

  it('says whether a certificate lists an address, of either family, without refusing anything', (t) => {
    // The same question, for a caller that reports the answer (`A-71`: `hostMatches`).
    const pairs = certificates(t);
    if (pairs === null) return;
    assert.equal(certificateListsAddress('127.0.0.1', pairs.addresses), true);
    assert.equal(certificateListsAddress('::1', pairs.addresses), true);
    assert.equal(certificateListsAddress('0:0:0:0:0:0:0:1', pairs.addresses), true);
    assert.equal(certificateListsAddress('127.0.0.1', pairs.others), false);
    assert.equal(certificateListsAddress('::1', pairs.others), false);
    // Spelt like the address, as a name: not the address.
    assert.equal(certificateListsAddress('::1', pairs.spelt), false);
    assert.equal(certificateListsAddress('127.0.0.1', pairs.name), false);
    // A zone is taken off, and buys nothing.
    assert.equal(certificateListsAddress('fe80::1%eth0', pairs.linkLocal), true);
    assert.equal(certificateListsAddress('fe80::2%eth0', pairs.linkLocal), false);
    // A name is not an address, whatever the certificate says, and neither is half of one.
    for (const host of ['device.test', '', '%eth0', '127.0.0', 'localhost']) {
      for (const certificate of Object.values(pairs)) {
        assert.equal(certificateListsAddress(host, certificate), false, host);
      }
    }
    // Nothing to ask: false, and no throw.
    const claimed = { subjectaltname: 'IP Address:127.0.0.1' } as unknown as PeerCertificate;
    assert.equal(certificateListsAddress('127.0.0.1', claimed), false);
  });
});
