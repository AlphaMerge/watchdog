import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as tls from 'node:tls';
import type { DatabaseConfig } from '@ms/shared';
import { Database } from '../src/db/pool.js';
import { silent } from './support/tree.js';
import { within } from './support/within.js';

/**
 * Whose certificate the core's own database connection accepts, when the database is given as
 * an address with `ssl` on (`A-74`).
 *
 * `pg` names a TLS server only for a host that is not an address, so Node checked the
 * certificate of a database at `127.0.0.1` against `localhost`: a certificate for that name was
 * accepted, and one listing the address refused. `A-70` found it by reading, for the sensors,
 * and left the core's pool unmeasured. A PostgreSQL of this file's own answers the request for
 * TLS and counts the startup message that follows it, which names the user: what a refused
 * certificate must never be sent. Certificates are made at test time with `openssl` and
 * trusted through `tls.setDefaultCACertificates`, so what is refused is who a certificate is
 * for and never who issued it.
 */

type Pair = { key: string; cert: string };

const opensslAvailable = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const setTrusted = (tls as { setDefaultCACertificates?: (certs: string[]) => void })
  .setDefaultCACertificates;
const getTrusted = (tls as { getCACertificates?: (type: string) => string[] }).getCACertificates;

/** Whether `::1` can be listened on here. Asked once, with a bound. */
const v6 = await new Promise<boolean>((resolve) => {
  const server = createServer();
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

let dir = '';
let trustedBefore: string[] | undefined;
const pairs: Partial<Record<'addresses' | 'others' | 'localhost', Pair>> = {};

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

before(() => {
  // Only a missing `openssl` skips (`A-67`'s rule): a certificate that could not be made for
  // any other reason throws, and must not turn the refusals below into skips that read green.
  if (!opensslAvailable) return;
  dir = mkdtempSync(join(tmpdir(), 'ms-db-tls-'));
  pairs.addresses = certificate('addresses', 'ms-a74-test', 'IP:127.0.0.1,IP:::1');
  pairs.others = certificate('others', 'ms-a74-test', 'IP:127.0.0.2,IP:::2');
  pairs.localhost = certificate('localhost', 'localhost', 'DNS:localhost');
  if (setTrusted !== undefined && getTrusted !== undefined) {
    trustedBefore = getTrusted('default');
    setTrusted([...trustedBefore, pairs.addresses.cert, pairs.others.cert, pairs.localhost.cert]);
  }
});

after(() => {
  if (trustedBefore !== undefined && setTrusted !== undefined) setTrusted(trustedBefore);
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

interface Fake {
  readonly port: number;
  /** Startup messages received through TLS: each names the user, and asks to log in. */
  startups: number;
  close(): Promise<void>;
}

/** PostgreSQL's request for TLS: a length of eight, and the code 80877103. */
const SSL_REQUEST = 80_877_103;

/**
 * Answers the request for TLS with `S`, takes the handshake under `pair`, and counts the startup
 * message the client sends through it. Then hangs up: the query fails, and what matters is
 * whether the client got as far as logging in.
 */
function postgres(pair: Pair, address: string): Promise<Fake> {
  const sockets = new Set<Socket>();
  const fake = {
    port: 0,
    startups: 0,
    close: (): Promise<void> => Promise.resolve(),
  };
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.once('data', (request: Buffer) => {
      if (request.length < 8 || request.readInt32BE(4) !== SSL_REQUEST) {
        socket.destroy();
        return;
      }
      socket.write('S');
      const secured = new tls.TLSSocket(socket, {
        isServer: true,
        secureContext: tls.createSecureContext(pair),
      });
      secured.on('error', () => undefined);
      secured.once('data', () => {
        fake.startups += 1;
        secured.destroy();
      });
    });
  });
  fake.close = () =>
    new Promise<void>((closed) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => {
        closed();
      });
    });
  return new Promise((resolve) => {
    server.listen(0, address, () => {
      const bound = server.address();
      fake.port = typeof bound === 'object' && bound !== null ? bound.port : 0;
      resolve(fake);
    });
  });
}

const config = (host: string, port: number): DatabaseConfig => ({
  host,
  port,
  database: 'monitoring',
  user: 'monitor',
  password: 'secret',
  ssl: true,
  poolSize: 1,
  connectTimeoutMs: 2_000,
  statementTimeoutMs: 0,
  lockTimeoutMs: 0,
  idleInTransactionTimeoutMs: 0,
  autoMigrate: false,
});

/** The error the core's first query fails with, against `fake`. */
async function firstQuery(host: string, fake: Fake): Promise<Error> {
  const db = new Database({ config: config(host, fake.port), logger: silent });
  try {
    await within(5_000, `a query to ${host}`, db.query('SELECT 1'));
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    await within(5_000, 'closing the pool', db.close());
  }
  return assert.fail('the fake answers no query, so the query cannot succeed');
}

const REFUSED = /altnames|does not match|is not in the cert|is not cert's/i;

describe('the core’s database, given as an address with ssl on (A-74)', () => {
  /** The certificates, or a skip saying why this case cannot run here. */
  function ready(t: { skip(reason: string): void }, host: string): Required<typeof pairs> | null {
    if (!opensslAvailable) {
      t.skip('openssl is not on this machine');
      return null;
    }
    if (trustedBefore === undefined) {
      t.skip('this Node has no tls.setDefaultCACertificates to trust a test certificate with');
      return null;
    }
    if (host === '::1' && !v6) {
      t.skip('::1 cannot be listened on here');
      return null;
    }
    const { addresses, others, localhost } = pairs;
    if (addresses === undefined || others === undefined || localhost === undefined) {
      return assert.fail('the certificates were not made');
    }
    return { addresses, others, localhost };
  }

  for (const host of ['127.0.0.1', '::1']) {
    it(`at ${host}: logs in through a certificate that lists the address`, async (t) => {
      const made = ready(t, host);
      if (made === null) return;
      const fake = await postgres(made.addresses, host);
      try {
        const error = await firstQuery(host, fake);
        assert.doesNotMatch(error.message, REFUSED);
        assert.equal(fake.startups, 1, 'the certificate was refused');
      } finally {
        await fake.close();
      }
    });

    it(`at ${host}: refuses a trusted certificate for \`localhost\`, and sends no startup`, async (t) => {
      // What Node checked the certificate against before: this one was accepted.
      const made = ready(t, host);
      if (made === null) return;
      const fake = await postgres(made.localhost, host);
      try {
        const error = await firstQuery(host, fake);
        assert.match(error.message, REFUSED);
        assert.equal(fake.startups, 0, 'the startup went to a server the certificate is not for');
      } finally {
        await fake.close();
      }
    });

    it(`at ${host}: refuses a trusted certificate that lists other addresses`, async (t) => {
      const made = ready(t, host);
      if (made === null) return;
      const fake = await postgres(made.others, host);
      try {
        const error = await firstQuery(host, fake);
        assert.match(error.message, REFUSED);
        assert.equal(fake.startups, 0);
      } finally {
        await fake.close();
      }
    });
  }
});
