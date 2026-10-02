import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as tls from 'node:tls';
import type { SmtpConfig, SmtpRelay } from '@ms/shared';
import { EmailTransport } from '../src/notifications/delivery/email.js';
import type { OutgoingMessage } from '../src/notifications/delivery/transport.js';
import { messageContext } from './support/messages.js';
import { addressesOnly } from './support/recipients.js';
import { silent } from './support/tree.js';

/**
 * Email delivery to a relay given by address, with its certificate verified (`A-67`).
 *
 * `A-60` found that Node's identity check reads an IPv6 address as a name and refuses every
 * certificate for one. The SMTP transport makes the same kind of connection, twice over —
 * implicit TLS and STARTTLS — and `email-delivery.test.ts` reaches neither: MailHog speaks no
 * TLS. So the relay here is a small one of this file's own, on a loopback address, under
 * certificates made at test time with `openssl` (none is committed) and trusted through
 * `tls.setDefaultCACertificates`, so that what is refused is who a certificate is for and
 * never who issued it.
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
}

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

interface Relay {
  readonly port: number;
  /** Messages taken to the end of `DATA`. */
  readonly delivered: string[];
  /** The server name of each TLS handshake that completed; empty for a hello that named none. */
  readonly named: string[];
}

const relays: { server: Server; sockets: Set<Socket> }[] = [];

/**
 * An SMTP relay: enough to take one message, over implicit TLS or after `STARTTLS`.
 * Null where the address cannot be listened on.
 */
async function relayOn(
  listenHost: string,
  pair: Pair,
  security: 'tls' | 'starttls',
): Promise<Relay | null> {
  const delivered: string[] = [];
  const named: string[] = [];
  const sockets = new Set<Socket>();
  const context = tls.createSecureContext({ key: pair.key, cert: pair.cert });

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
    let current: Socket | tls.TLSSocket = socket;
    let secured = false;
    let buffer = '';
    let inData = false;
    let body = '';

    const send = (line: string): void => {
      current.write(`${line}\r\n`);
    };
    const secure = (): void => {
      current.removeAllListeners('data');
      buffer = '';
      const upgraded = new tls.TLSSocket(current, { isServer: true, secureContext: context });
      upgraded.once('secure', () => {
        const asked = (upgraded as { servername?: unknown }).servername;
        named.push(typeof asked === 'string' ? asked : '');
      });
      secured = true;
      current = upgraded;
      bind(upgraded);
    };
    const onLine = (line: string): void => {
      if (inData) {
        if (line === '.') {
          inData = false;
          delivered.push(body);
          send('250 2.0.0 Ok: queued');
          return;
        }
        body += `${line}\n`;
        return;
      }
      const verb = (line.split(' ')[0] ?? '').toUpperCase();
      switch (verb) {
        case 'EHLO':
          send('250-relay.a67.test');
          if (security === 'starttls' && !secured) send('250-STARTTLS');
          send('250 SIZE 10485760');
          return;
        case 'HELO':
          send('250 relay.a67.test');
          return;
        case 'STARTTLS':
          send('220 2.0.0 ready to start TLS');
          secure();
          return;
        case 'MAIL':
        case 'RCPT':
        case 'RSET':
          send('250 2.1.0 Ok');
          return;
        case 'DATA':
          inData = true;
          body = '';
          send('354 End data with <CR><LF>.<CR><LF>');
          return;
        case 'QUIT':
          send('221 2.0.0 Bye');
          current.end();
          return;
        default:
          send('500 5.5.2 unrecognised command');
      }
    };
    const bind = (target: Socket | tls.TLSSocket): void => {
      target.setEncoding('utf8');
      target.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const at = buffer.indexOf('\r\n');
          if (at < 0) break;
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          onLine(line);
        }
      });
      // A client that refuses the certificate ends the handshake; that is the client's verdict.
      target.on('error', () => undefined);
    };
    bind(socket);
    if (security === 'tls') secure();
    send('220 relay.a67.test ESMTP');
  });

  const port = await new Promise<number | null>((resolve) => {
    server.once('error', () => {
      resolve(null);
    });
    server.listen(0, listenHost, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : null);
    });
  });
  if (port === null) return null;
  relays.push({ server, sockets });
  return { port, delivered, named };
}

before(() => {
  try {
    dir = mkdtempSync(join(tmpdir(), 'ms-email-identity-'));
    pairs = {
      forAddresses: certificate('addresses', 'ms-relay-test', 'IP:127.0.0.1,IP:::1'),
      forOtherAddresses: certificate('others', 'ms-relay-test', 'IP:127.0.0.2,IP:::2'),
      speltLikeAnAddress: certificate('spelt', '::1', 'DNS:::1'),
      forLocalhost: certificate('localhost', 'localhost', 'DNS:localhost'),
    };
  } catch {
    pairs = undefined;
  }
  if (pairs !== undefined && setTrusted !== undefined && getTrusted !== undefined) {
    trustedBefore = getTrusted('default');
    setTrusted([...trustedBefore, ...Object.values(pairs).map((pair: Pair) => pair.cert)]);
  }
});

after(async () => {
  if (trustedBefore !== undefined && setTrusted !== undefined) setTrusted(trustedBefore);
  for (const { server, sockets } of relays) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

/** The certificates, or a skip that says why there are none. */
function ready(t: { skip(reason: string): void }): Pairs | null {
  if (pairs === undefined) {
    t.skip('openssl is not on this machine');
    return null;
  }
  if (trustedBefore === undefined) {
    t.skip('this Node has no tls.setDefaultCACertificates to trust a test certificate with');
    return null;
  }
  return pairs;
}

function transportTo(host: string, port: number, security: 'tls' | 'starttls'): EmailTransport {
  const relay: SmtpRelay = {
    host,
    port,
    security,
    verifyCertificate: true,
    auth: 'none',
    user: '',
    password: '',
    heloName: 'ms-core.test',
    // The bound on every wait this makes on the relay: connecting, the greeting, each reply.
    timeoutMs: 5_000,
  };
  const config: SmtpConfig = {
    sender: 'monitoring@example.test',
    primary: relay,
    fallback: { ...relay, host: '' },
  };
  return new EmailTransport({ config, logger: silent, recipients: addressesOnly });
}

const MESSAGE: OutgoingMessage = {
  requestId: 1,
  sensorId: 2,
  subject: 'Ping on edge-router is down',
  body: 'no ICMP reply from 192.0.2.7',
  recipients: [{ kind: 'address', value: 'ops@example.test' }],
  about: [2],
  priority: 3,
  settings: { format: 'plain', senderOverride: null },
  context: messageContext(),
};

const SECURITIES = ['tls', 'starttls'] as const;

describe('email to a relay given by address, verifying its certificate', () => {
  for (const security of SECURITIES) {
    it(`delivers to ::1 (${security}) under a certificate that lists ::1`, async (t) => {
      const certificates = ready(t);
      if (certificates === null) return;
      const relay = await relayOn('::1', certificates.forAddresses, security);
      if (relay === null) {
        t.skip('this machine has no IPv6 loopback (::1) to listen on');
        return;
      }
      const result = await transportTo('::1', relay.port, security).send(MESSAGE);
      assert.ok(result.ok, result.ok ? '' : result.error);
      assert.equal(relay.delivered.length, 1);
      assert.match(relay.delivered[0] ?? '', /no ICMP reply from 192\.0\.2\.7/);
      // An address is not a server name, and none is sent for one.
      assert.deepEqual(relay.named, ['']);
    });

    it(`refuses, for ::1 (${security}), every certificate that does not list that address`, async (t) => {
      const certificates = ready(t);
      if (certificates === null) return;
      for (const [label, pair] of [
        ['other addresses', certificates.forOtherAddresses],
        ['the address as a DNS name and a common name', certificates.speltLikeAnAddress],
        ['the name localhost', certificates.forLocalhost],
      ] as const) {
        const relay = await relayOn('::1', pair, security);
        if (relay === null) {
          t.skip('this machine has no IPv6 loopback (::1) to listen on');
          return;
        }
        const result = await transportTo('::1', relay.port, security).send(MESSAGE);
        assert.ok(!result.ok, `${label}: taken for ::1`);
        assert.match(result.error, /IP: ::1 is not in the cert's list/, label);
        assert.deepEqual(relay.delivered, [], `${label}: the message was handed over`);
      }
    });

    it(`for 127.0.0.1 (${security}) is as it was: the listed address delivered to, others refused`, async (t) => {
      const certificates = ready(t);
      if (certificates === null) return;
      const listed = await relayOn('127.0.0.1', certificates.forAddresses, security);
      assert.ok(listed !== null, '127.0.0.1 could not be listened on');
      const result = await transportTo('127.0.0.1', listed.port, security).send(MESSAGE);
      assert.ok(result.ok, result.ok ? '' : result.error);
      assert.equal(listed.delivered.length, 1);
      assert.deepEqual(listed.named, ['']);

      for (const pair of [certificates.forOtherAddresses, certificates.forLocalhost]) {
        const relay = await relayOn('127.0.0.1', pair, security);
        assert.ok(relay !== null, '127.0.0.1 could not be listened on');
        const refused = await transportTo('127.0.0.1', relay.port, security).send(MESSAGE);
        assert.ok(!refused.ok, 'a certificate for elsewhere was taken for 127.0.0.1');
        assert.match(refused.error, /IP: 127\.0\.0\.1 is not in the cert's list/);
        assert.deepEqual(relay.delivered, []);
      }
    });
  }
});
