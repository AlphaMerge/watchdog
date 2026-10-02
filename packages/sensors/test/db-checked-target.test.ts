import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import {
  connect as netConnect,
  createServer,
  type LookupFunction,
  type Server,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import { Duplex } from 'node:stream';
import { join } from 'node:path';
import * as tls from 'node:tls';
import { Worker } from 'node:worker_threads';
import type { TargetPolicy } from '@ms/shared';
import { SensorCatalogue } from '../src/catalogue.js';
import { TargetRefusedError } from '../src/support/checked-target.js';
import {
  DbEncryptionRefusedError,
  DbError,
  DbRedirectRefusedError,
  DbRoutedUnresolvedError,
  describeDbError,
  REDIRECT_OUTSIDE_TARGETS,
  type DbConnectOptions,
  type DbDriver,
} from '../src/support/db/driver.js';
import { mssqlDriver } from '../src/support/db/mssql.js';
import { mysqlDriver } from '../src/support/db/mysql.js';
import { postgresqlDriver } from '../src/support/db/postgresql.js';
import {
  connectBudgetMs,
  connectingSocket,
  preloginEncryption,
  tdsConnector,
  unconnectedSocket,
} from '../src/support/db/socket.js';
import {
  CredentialsWithheldError,
  isCredentialsWithheld,
  PIN_REFUSALS,
  type ResolvedAddress,
  type ResolveHost,
} from '../src/support/pinned-target.js';
import { runDbCheck } from '../src/types/db-shared.js';
import { dbMssql } from '../src/types/db-mssql.js';
import { dbMysql } from '../src/types/db-mysql.js';
import { dbPostgresql } from '../src/types/db-postgresql.js';
import type { CheckContext, CheckExecution, SensorType } from '../src/contract.js';

/**
 * The database sensors, held to the address that was checked (`A-62`).
 *
 * `pg`, `mysql2` and `tedious` resolve a device's name themselves and take no lookup, so until
 * this ticket the target policy read an address given as one and nothing else, and a credential
 * set bounded by addresses was withheld from a named database server. Each driver is now handed
 * its socket, and these tests are of the real drivers against a server on loopback.
 *
 * **The device is named by a name nothing resolves**, as in `target-policy-transports.test.ts`:
 * the only way a check reaches the server on 127.0.0.1 is by connecting to an address the
 * injected resolver answered with. A driver left to resolve the name itself would fail.
 *
 * **The servers are fakes of the wire, not of the engine.** `db-drivers.test.ts` is where the
 * three drivers meet real servers; what has to be shown here is where the connection goes and
 * what TLS names, and for that PostgreSQL and MySQL are spoken just far enough to answer one
 * query, and SQL Server far enough to see the TLS hello that `tedious` sends inside TDS.
 * **Nothing here is ever sent to a link-local address.**
 */

const NAME = 'database.policy.invalid';
const OTHER = 'replica.policy.invalid';
const METADATA = '169.254.169.254';
const INSIDE = ['127.0.0.0/8'];

interface Rebinding {
  readonly resolve: ResolveHost;
  readonly calls: { host: string; family: number }[];
}

const v4 = (...addresses: string[]): ResolvedAddress[] =>
  addresses.map((address) => ({ address, family: 4 }));

/** Answers `first` to the first lookup and `then` to every one after. */
function rebinding(
  first: readonly ResolvedAddress[] = v4('127.0.0.1'),
  then: readonly ResolvedAddress[] = v4(METADATA),
): Rebinding {
  const calls: { host: string; family: number }[] = [];
  return {
    calls,
    resolve: (host, family) => {
      const answer = calls.length === 0 ? first : then;
      calls.push({ host, family });
      return Promise.resolve(answer);
    },
  };
}

/** Answers 127.0.0.1, after `delayMs`. */
function slow(delayMs: number): Rebinding {
  const calls: { host: string; family: number }[] = [];
  return {
    calls,
    resolve: (host, family) => {
      calls.push({ host, family });
      return new Promise((resolve) => setTimeout(resolve, delayMs, v4('127.0.0.1')));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Certificates, made here as `pinned-transports.test.ts` makes its own.

let dir = '';
let forName: { key: string; cert: string } | undefined;
let forAnother: { key: string; cert: string } | undefined;
/** Lists both loopback addresses, as addresses (`A-70`). */
let forAddresses: { key: string; cert: string } | undefined;
/** Lists two addresses that are neither loopback one. */
let forOtherAddresses: { key: string; cert: string } | undefined;
/** For the name `localhost`, and no address: what Node checks when nobody names a host. */
let forLocalhost: { key: string; cert: string } | undefined;

/** Whether there is an `openssl` to make certificates with. Asked on its own: see `before`. */
const opensslAvailable = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

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
const setTrusted = (tls as { setDefaultCACertificates?: (certs: string[]) => void })
  .setDefaultCACertificates;
const getTrusted = (tls as { getCACertificates?: (type: string) => string[] }).getCACertificates;
let trustedBefore: string[] | undefined;

function certificate(
  file: string,
  name: string,
  names = `DNS:${name}`,
): { key: string; cert: string } {
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
      `/CN=${name}`,
      '-addext',
      `subjectAltName=${names}`,
    ],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8') };
}

before(() => {
  // **Only a missing `openssl` skips** (`A-67`'s rule, `A-70`). Anything else that goes wrong
  // here throws, and every case fails with it: the TLS cases are the proof that verification
  // was not weakened, and a certificate that could not be made must not turn them into skips
  // that read as green.
  if (!opensslAvailable) return;
  dir = mkdtempSync(join(tmpdir(), 'ms-db-checked-'));
  forName = certificate('name', NAME);
  forAnother = certificate('another', 'another.policy.invalid');
  forAddresses = certificate('addresses', 'ms-a70-test', 'IP:127.0.0.1,IP:::1');
  forOtherAddresses = certificate('others', 'ms-a70-test', 'IP:127.0.0.2,IP:::2');
  forLocalhost = certificate('localhost', 'localhost', 'DNS:localhost');
  // All trusted, so that what a verifying client refuses is *who the certificate is for*.
  if (setTrusted !== undefined && getTrusted !== undefined) {
    trustedBefore = getTrusted('default');
    setTrusted([
      ...trustedBefore,
      forName.cert,
      forAnother.cert,
      forAddresses.cert,
      forOtherAddresses.cert,
      forLocalhost.cert,
    ]);
  }
});

after(() => {
  if (trustedBefore !== undefined && setTrusted !== undefined) setTrusted(trustedBefore);
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

/** The certificate for the device's name, or a skip saying why there is none. */
function needsTrust(t: { skip(reason: string): void }): boolean {
  if (forName === undefined || forAnother === undefined) {
    t.skip('openssl is not on this machine');
    return false;
  }
  if (trustedBefore === undefined) {
    t.skip('this Node has no tls.setDefaultCACertificates to trust a test certificate with');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// The servers.

interface Fake {
  readonly port: number;
  /** Connections accepted. */
  connections: number;
  /** The server name each TLS hello asked for. */
  readonly serverNames: string[];
  /** The password or query each connection got as far as sending. */
  readonly said: string[];
  /** The remote address of each connection, as the server saw it. */
  close(): Promise<void>;
}

type Certificate = { key: string; cert: string } | undefined;

function listen(
  onConnection: (socket: Socket, fake: Fake) => void,
  address = '127.0.0.1',
): Promise<{ fake: Fake; server: Server }> {
  return new Promise((resolve) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      fake.connections += 1;
      onConnection(socket, fake);
    });
    const fake: Fake = {
      port: 0,
      connections: 0,
      serverNames: [],
      said: [],
      close: () =>
        new Promise<void>((closed) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => {
            closed();
          });
        }),
    };
    server.listen(0, address, () => {
      const address = server.address();
      (fake as { port: number }).port =
        typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ fake, server });
    });
  });
}

/**
 * Upgrades an accepted socket to TLS as a server, and notes the name the client asked for.
 *
 * Over a stream of its own and not the socket itself: a client that sends its TLS hello in the
 * same segment as the request to upgrade (`mysql2` does) has had the start of it read already,
 * and `leftover` is handed back in front of what follows.
 */
function secure(
  socket: Socket,
  leftover: Buffer,
  certificate: { key: string; cert: string },
  fake: Fake,
): tls.TLSSocket {
  const bridge = new Duplex({
    read: () => undefined,
    write: (chunk: Buffer, _encoding, done) => {
      socket.write(chunk, done);
    },
    final: (done) => {
      socket.end();
      done();
    },
  });
  if (leftover.length > 0) bridge.push(leftover);
  socket.on('data', (chunk: Buffer) => bridge.push(chunk));
  socket.on('close', () => bridge.destroy());
  const secured = new tls.TLSSocket(bridge, {
    isServer: true,
    secureContext: tls.createSecureContext(certificate),
    SNICallback: (name, done) => {
      fake.serverNames.push(name);
      done(null);
    },
  });
  secured.on('error', () => undefined);
  bridge.on('error', () => undefined);
  return secured;
}

const int32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
};

/** One PostgreSQL message: its type byte, its length, its body. */
const pgMessage = (type: string, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);

const cstring = (text: string): Buffer => Buffer.concat([Buffer.from(text), Buffer.from([0])]);

/**
 * PostgreSQL, far enough for `select 1`: the SSL request, the startup, one simple query.
 * Without a certificate it answers the SSL request `N`, as a server built without TLS does.
 */
async function postgresServer(certificate?: Certificate, address?: string): Promise<Fake> {
  const { fake } = await listen((raw, self) => {
    let stream: Socket | tls.TLSSocket = raw;
    let started = false;
    let pending = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (!started) {
          if (pending.length < 8) return;
          const length = pending.readInt32BE(0);
          if (pending.length < length) return;
          const code = pending.readInt32BE(4);
          pending = pending.subarray(length);
          if (code === 80877103) {
            // SSLRequest.
            if (certificate === undefined) {
              stream.write('N');
              continue;
            }
            raw.removeListener('data', onData);
            raw.write('S');
            stream = secure(raw, pending, certificate, self);
            pending = Buffer.alloc(0);
            stream.on('data', onData);
            return;
          }
          started = true;
          stream.write(Buffer.concat([pgMessage('R', int32(0)), pgMessage('Z', Buffer.from('I'))]));
          continue;
        }
        if (pending.length < 5) return;
        const length = pending.readInt32BE(1);
        if (pending.length < length + 1) return;
        const type = String.fromCharCode(pending[0] ?? 0);
        const body = pending.subarray(5, length + 1);
        pending = pending.subarray(length + 1);
        if (type === 'X') {
          stream.end();
          return;
        }
        if (type !== 'Q') continue;
        self.said.push(body.toString('utf8').replace(/\0$/, ''));
        const field = Buffer.concat([
          cstring('n'),
          int32(0),
          Buffer.from([0, 0]),
          int32(23),
          Buffer.from([0, 4]),
          int32(-1),
          Buffer.from([0, 0]),
        ]);
        stream.write(
          Buffer.concat([
            pgMessage('T', Buffer.concat([Buffer.from([0, 1]), field])),
            pgMessage('D', Buffer.concat([Buffer.from([0, 1]), int32(1), Buffer.from('1')])),
            pgMessage('C', cstring('SELECT 1')),
            pgMessage('Z', Buffer.from('I')),
          ]),
        );
      }
    };
    raw.on('data', onData);
  }, address);
  return fake;
}

/** One MySQL packet: three bytes of length, the sequence number, the payload. */
const myPacket = (sequence: number, payload: Buffer): Buffer => {
  const header = Buffer.alloc(4);
  header.writeUIntLE(payload.length, 0, 3);
  header.writeUInt8(sequence, 3);
  return Buffer.concat([header, payload]);
};

const lenenc = (text: string): Buffer =>
  Buffer.concat([Buffer.from([text.length]), Buffer.from(text)]);

const MY_OK = Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]);
const MY_EOF = Buffer.from([0xfe, 0x00, 0x00, 0x02, 0x00]);

/**
 * MySQL, far enough for `select 1`: the greeting, the TLS upgrade when it has a certificate,
 * a handshake response accepted whatever it says, `SET` answered OK and anything else one row.
 */
async function mysqlServer(certificate?: Certificate, address?: string): Promise<Fake> {
  const { fake } = await listen((raw, self) => {
    let stream: Socket | tls.TLSSocket = raw;
    let authorised = false;
    let pending = Buffer.alloc(0);
    // LONG_PASSWORD, CONNECT_WITH_DB, PROTOCOL_41, TRANSACTIONS, SECURE_CONNECTION, and SSL
    // where there is a certificate; PLUGIN_AUTH in the upper half.
    const lower =
      0x0001 | 0x0008 | 0x0200 | 0x2000 | 0x8000 | (certificate === undefined ? 0 : 0x0800);
    const upper = 0x0008;
    const greeting = Buffer.concat([
      Buffer.from([0x0a]),
      cstring('8.0.0-fake'),
      Buffer.from([1, 0, 0, 0]),
      Buffer.from('abcdefgh'),
      Buffer.from([0]),
      Buffer.from([lower & 0xff, lower >> 8]),
      Buffer.from([0x21]),
      Buffer.from([0x02, 0x00]),
      Buffer.from([upper & 0xff, upper >> 8]),
      Buffer.from([21]),
      Buffer.alloc(10),
      cstring('ijklmnopqrst'),
      cstring('mysql_native_password'),
    ]);
    raw.write(myPacket(0, greeting));
    const onData = (chunk: Buffer): void => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (pending.length < 4) return;
        const length = pending.readUIntLE(0, 3);
        if (pending.length < length + 4) return;
        const sequence = pending.readUInt8(3);
        const payload = pending.subarray(4, length + 4);
        pending = pending.subarray(length + 4);
        if (!authorised) {
          if (certificate !== undefined && stream === raw && payload.length === 32) {
            // The SSL request: the same first 32 bytes as a handshake response, and no more.
            raw.removeListener('data', onData);
            stream = secure(raw, pending, certificate, self);
            pending = Buffer.alloc(0);
            stream.on('data', onData);
            return;
          }
          authorised = true;
          stream.write(myPacket(sequence + 1, MY_OK));
          continue;
        }
        const command = payload[0];
        if (command === 0x01) {
          stream.end();
          return;
        }
        if (command !== 0x03) {
          stream.write(myPacket(1, MY_OK));
          continue;
        }
        const sql = payload.subarray(1).toString('utf8');
        if (/^set /i.test(sql)) {
          stream.write(myPacket(1, MY_OK));
          continue;
        }
        self.said.push(sql);
        const column = Buffer.concat([
          lenenc('def'),
          lenenc(''),
          lenenc(''),
          lenenc(''),
          lenenc('n'),
          lenenc(''),
          Buffer.from([0x0c, 0x21, 0x00, 1, 0, 0, 0, 0x08, 0, 0, 0, 0, 0]),
        ]);
        stream.write(
          Buffer.concat([
            myPacket(1, Buffer.from([1])),
            myPacket(2, column),
            myPacket(3, MY_EOF),
            myPacket(4, lenenc('1')),
            myPacket(5, MY_EOF),
          ]),
        );
      }
    };
    raw.on('data', onData);
  }, address);
  return fake;
}

/** One TDS packet from the server: a tabular result, complete in itself. */
const tdsReply = (body: Buffer): Buffer => {
  const header = Buffer.from([0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00]);
  header.writeUInt16BE(8 + body.length, 2);
  return Buffer.concat([header, body]);
};

const uint16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
};

/**
 * What SQL Server answers a login with when it hands it on: an ENVCHANGE of type 20 naming the
 * server and port, the LOGINACK, and DONE. `tedious` takes the routing only beside a LOGINACK.
 */
function routingReply(server: string, port: number): Buffer {
  const route = Buffer.concat([
    Buffer.from([0]),
    uint16(port),
    uint16(server.length),
    Buffer.from(server, 'ucs2'),
  ]);
  const change = Buffer.concat([Buffer.from([20]), uint16(route.length), route, uint16(0)]);
  const program = 'fake';
  const ack = Buffer.concat([
    Buffer.from([1]),
    // TDS 7.4.
    Buffer.from([0x74, 0x00, 0x00, 0x04]),
    Buffer.from([program.length]),
    Buffer.from(program, 'ucs2'),
    Buffer.from([15, 0, 0, 0]),
  ]);
  return tdsReply(
    Buffer.concat([
      Buffer.from([0xe3]),
      uint16(change.length),
      change,
      Buffer.from([0xad]),
      uint16(ack.length),
      ack,
      Buffer.from([0xfd]),
      Buffer.alloc(12),
    ]),
  );
}

/** A PRELOGIN answer: version 15.0.0.0, and whether the server encrypts (1) or cannot (2). */
const preloginReply = (encryption: number): Buffer =>
  // VERSION at 11 for 6 bytes, ENCRYPTION at 17 for 1, the terminator, then the data.
  tdsReply(
    Buffer.concat([
      Buffer.from([0x00, 0x00, 0x0b, 0x00, 0x06, 0x01, 0x00, 0x11, 0x00, 0x01, 0xff]),
      Buffer.from([0x0f, 0x00, 0x00, 0x00, 0x00, 0x00, encryption]),
    ]),
  );

/**
 * SQL Server, far enough to see where `tedious` connects, what its TLS names, and where it
 * goes when it is routed on.
 *
 * - **By default** it answers the PRELOGIN saying encryption is on, notes whether the TLS
 *   hello that follows (inside TDS packets) carries the device's name, and hangs up.
 * - **With `route`** it says it has no encryption, takes the LOGIN7 that follows, and answers
 *   it by routing the login to another server, as Azure SQL does from inside its network.
 * - **With `login`** it takes the LOGIN7 and hangs up: a server a login arrived at.
 *
 * - **With `secure`** it says encryption is on and then really negotiates it, as SQL Server
 *   does below TDS 8: the TLS handshake travels inside PRELOGIN packets in both directions, and
 *   once it is done the TLS records go on the socket bare, with TDS inside them. It takes the
 *   LOGIN7 that arrives through TLS and hangs up. A client that refuses the certificate never
 *   sends one.
 *
 * `said` has `login7` for each login a server was sent, which is where the password is.
 */
async function tdsServer(
  mode: {
    route?: { server: string; port: number };
    login?: true;
    address?: string;
    secure?: { key: string; cert: string };
    /** The encryption byte of the PRELOGIN answer, in place of the mode's own. */
    encryption?: number;
    /** The whole PRELOGIN answer, byte for byte, in place of one this would write. */
    answer?: Buffer;
    /** Bytes written the moment a connection is accepted, before the client has asked. */
    early?: Buffer;
  } = {},
): Promise<Fake> {
  const plain = mode.route !== undefined || mode.login === true;
  const { fake } = await listen((socket, self) => {
    let pending = Buffer.alloc(0);
    let packets = 0;
    if (mode.early !== undefined) socket.write(mode.early);
    /** The server's end of the TLS that runs inside TDS, once the PRELOGIN is answered. */
    let handshake: { bridge: Duplex } | undefined;
    const negotiate = (certificate: { key: string; cert: string }): { bridge: Duplex } => {
      // What the TLS layer writes in one turn is one flight of the handshake, and `tedious`
      // reads exactly one TDS message for each it sends: so a turn's writes go out together.
      let flight: Buffer[] = [];
      const bridge = new Duplex({
        read: () => undefined,
        write: (chunk: Buffer, _encoding, done) => {
          if (flight.length === 0) {
            setImmediate(() => {
              const body = Buffer.concat(flight);
              flight = [];
              if (!socket.destroyed) socket.write(tdsReply(body));
            });
          }
          flight.push(chunk);
          done();
        },
      });
      bridge.on('error', () => undefined);
      socket.on('close', () => bridge.destroy());
      const secured = new tls.TLSSocket(bridge, {
        isServer: true,
        secureContext: tls.createSecureContext(certificate),
        SNICallback: (name, done) => {
          self.serverNames.push(name);
          done(null);
        },
      });
      secured.on('error', () => undefined);
      secured.once('secure', () => {
        self.said.push('tls established');
      });
      secured.on('data', (clear: Buffer) => {
        // TDS again, inside TLS. 0x10 is LOGIN7: the user name and the password are in it.
        self.said.push(clear[0] === 0x10 ? 'login7' : `packet 0x${(clear[0] ?? 0).toString(16)}`);
        socket.destroy();
      });
      return { bridge };
    };
    socket.on('data', (chunk: Buffer) => {
      // After the handshake the client sends TLS records bare: a record never begins with
      // 0x12, which is what a PRELOGIN packet carrying handshake bytes begins with.
      if (handshake !== undefined && pending.length === 0 && chunk[0] !== 0x12) {
        handshake.bridge.push(chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (pending.length < 8) return;
        const length = pending.readUInt16BE(2);
        if (pending.length < length) return;
        const type = pending.readUInt8(0);
        const payload = pending.subarray(8, length);
        pending = pending.subarray(length);
        packets += 1;
        if (packets === 1) {
          self.said.push(`packet 0x${type.toString(16)}`);
          socket.write(mode.answer ?? preloginReply(mode.encryption ?? (plain ? 0x02 : 0x01)));
          if (mode.secure !== undefined) handshake = negotiate(mode.secure);
          continue;
        }
        if (handshake !== undefined) {
          handshake.bridge.push(Buffer.from(payload));
          continue;
        }
        if (plain) {
          // 0x10 is LOGIN7: the user name and the password are in it.
          self.said.push(type === 0x10 ? 'login7' : `packet 0x${type.toString(16)}`);
          if (mode.route !== undefined && type === 0x10) {
            socket.write(routingReply(mode.route.server, mode.route.port));
            continue;
          }
          socket.destroy();
          return;
        }
        // The TLS client hello, wrapped in a PRELOGIN packet. Its server name is in the clear.
        for (const name of [NAME, OTHER, '127.0.0.1']) {
          if (payload.includes(Buffer.from(name))) self.serverNames.push(name);
        }
        self.said.push('tls hello');
        socket.destroy();
        return;
      }
    });
  }, mode.address);
  return fake;
}

// ---------------------------------------------------------------------------------------------

interface Run {
  readonly port: number;
  readonly host?: string;
  readonly policy?: TargetPolicy;
  readonly params?: Record<string, unknown>;
  /** `allowedTargets` on the database set, which is what makes the catalogue pin the name. */
  readonly targets?: readonly string[];
  readonly ipVersion?: 'auto' | 'v4' | 'v6';
}

/** Through the catalogue, as a probe runs a check. */
function execute(type: SensorType, dns: Rebinding, run: Run): Promise<CheckExecution> {
  const catalogue = new SensorCatalogue({
    resolve: dns.resolve,
    targetPolicy: run.policy ?? 'link-local',
  })
    .register(type)
    .seal();
  const context: CheckContext = {
    sensorId: 62,
    target: { host: run.host ?? NAME, ipVersion: run.ipVersion ?? 'auto' },
    params: {
      port: run.port,
      query: 'select 1 as n',
      encrypt: 'disable',
      connectTimeoutMs: 4_000,
      ...run.params,
    },
    credentials: {
      database: {
        username: 'monitor',
        password: 'secret',
        ...(run.targets === undefined ? {} : { allowedTargets: run.targets }),
      },
    },
    signal: new AbortController().signal,
  };
  return catalogue.execute(type.id, context);
}

async function failure(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (error: unknown) {
    assert.ok(error instanceof Error, `threw ${String(error)}`);
    return error;
  }
  return assert.fail('the check ran');
}

/** The policy's refusal, or a failed assertion saying what happened in its place. */
async function refused(run: Promise<unknown>): Promise<TargetRefusedError> {
  const error = await failure(run);
  assert.ok(error instanceof TargetRefusedError, `threw ${String(error)}`);
  // An ordinary failed check: nothing a runner reads as a refusal over credentials.
  assert.equal((error as { code?: unknown }).code, undefined);
  return error;
}

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

interface Engine {
  readonly name: string;
  readonly type: SensorType;
  readonly driver: DbDriver;
  /** A server with no TLS. */
  readonly plain: () => Promise<Fake>;
  /** Whether the fake answers a query: SQL Server's hangs up after the TLS hello. */
  readonly answers: boolean;
  /** What a connection that arrived at the fake had said, when the check is over. */
  readonly arrived: (fake: Fake) => void;
}

const ENGINES: readonly Engine[] = [
  {
    name: 'db.postgresql',
    type: dbPostgresql,
    driver: postgresqlDriver,
    plain: () => postgresServer(),
    answers: true,
    arrived: (fake) => {
      assert.deepEqual(fake.said, ['select 1 as n']);
    },
  },
  {
    name: 'db.mysql',
    type: dbMysql,
    driver: mysqlDriver,
    plain: () => mysqlServer(),
    answers: true,
    arrived: (fake) => {
      assert.deepEqual(fake.said, ['select 1 as n']);
    },
  },
  {
    name: 'db.mssql',
    type: dbMssql,
    driver: mssqlDriver,
    plain: () => tdsServer(),
    answers: false,
    arrived: (fake) => {
      // The first packet of a TDS connection is the PRELOGIN, 0x12.
      assert.equal(fake.said[0], 'packet 0x12');
    },
  },
];

/** Runs the check and says it arrived: with a reading where the fake answers one. */
async function arrives(engine: Engine, dns: Rebinding, run: Run, fake: Fake): Promise<void> {
  if (engine.answers) {
    const execution = await execute(engine.type, dns, run);
    assert.equal(valueOf(execution, 'value'), 1);
    assert.equal(valueOf(execution, 'rows'), 1);
    assert.ok((valueOf(execution, 'connectTime') ?? -1) >= 0);
  } else {
    // The fake hangs up before a login: the check fails as a database that went away does,
    // and not as a refusal or a name that did not resolve.
    const error = await failure(execute(engine.type, dns, run));
    assert.ok(!(error instanceof TargetRefusedError), error.message);
    assert.ok(!isCredentialsWithheld(error), error.message);
    assert.doesNotMatch(error.message, /did not resolve|ENOTFOUND/);
  }
  assert.equal(fake.connections >= 1, true, 'the check reached the server');
  engine.arrived(fake);
}

for (const engine of ENGINES) {
  describe(`${engine.name} is held to the address that was checked`, () => {
    let fake: Fake;
    before(async () => {
      fake = await engine.plain();
    });
    after(async () => {
      await fake.close();
    });
    const reset = (): void => {
      fake.connections = 0;
      fake.said.length = 0;
      fake.serverNames.length = 0;
    };

    it('a name that resolves to a metadata address is refused on one lookup, with nothing sent', async () => {
      reset();
      // One address the server listens on and one the policy refuses: a driver that connected
      // before every answer was checked, or in spite of the refusal, would arrive.
      const dns = rebinding(v4('127.0.0.1', METADATA));
      const error = await refused(execute(engine.type, dns, { port: fake.port }));
      assert.match(
        error.message,
        /^refusing to connect to database\.policy\.invalid: it resolves to 169\.254\.169\.254, which is link-local/,
      );
      assert.match(error.message, /probe\.targetPolicy “none” refuses nothing/);
      assert.equal(error.address, METADATA);
      assert.equal(dns.calls.length, 1);
      assert.equal(fake.connections, 0);
    });

    it('a resolver that would answer differently the second time is asked once', async () => {
      reset();
      const dns = rebinding();
      await arrives(engine, dns, { port: fake.port }, fake);
      assert.deepEqual(dns.calls, [{ host: NAME, family: 0 }]);
    });

    it('a device given as an address connects as before, with no lookup', async () => {
      reset();
      const dns = rebinding(v4(METADATA));
      await arrives(engine, dns, { port: fake.port, host: '127.0.0.1' }, fake);
      assert.equal(dns.calls.length, 0);
    });

    it('a device given as a refused address connects to nothing', async () => {
      reset();
      const dns = rebinding();
      const error = await refused(execute(engine.type, dns, { port: fake.port, host: METADATA }));
      assert.match(
        error.message,
        /^refusing to connect to 169\.254\.169\.254, which is link-local/,
      );
      assert.equal(dns.calls.length, 0);
      assert.equal(fake.connections, 0);
    });

    it('under `none` nothing is checked and the driver resolves the name itself, as before', async () => {
      reset();
      const dns = rebinding();
      const error = await failure(execute(engine.type, dns, { port: fake.port, policy: 'none' }));
      // Nothing resolves `.invalid`: the driver was left to try, and was handed no socket.
      assert.ok(!(error instanceof TargetRefusedError));
      assert.equal(dns.calls.length, 0);
      assert.equal(fake.connections, 0);
    });

    it('a name facing a set bounded by addresses is pinned: one lookup, and the set arrives', async () => {
      reset();
      const dns = rebinding();
      await arrives(engine, dns, { port: fake.port, targets: INSIDE }, fake);
      // The pin's lookup, and no second one by the guard or the driver.
      assert.deepEqual(dns.calls, [{ host: NAME, family: 0 }]);
    });

    it('a name that resolves outside the set’s targets is withheld, with nothing sent', async () => {
      reset();
      const dns = rebinding(v4('127.0.0.1', '192.0.2.7'));
      const error = await failure(execute(engine.type, dns, { port: fake.port, targets: INSIDE }));
      assert.ok(error instanceof CredentialsWithheldError, error.message);
      assert.equal(error.message, PIN_REFUSALS.resolvedOutside(NAME, 'database', '192.0.2.7'));
      assert.equal(error.sensorId, 62);
      assert.equal(dns.calls.length, 1);
      assert.equal(fake.connections, 0);
    });

    it('a pinned address the policy refuses is refused as a failed check, with nothing sent', async () => {
      reset();
      // The set allows link-local; the probe's policy does not, and reads the pinned address.
      const dns = rebinding(v4(METADATA));
      const error = await refused(
        execute(engine.type, dns, { port: fake.port, targets: ['169.254.0.0/16'] }),
      );
      assert.equal(error.address, METADATA);
      assert.equal(dns.calls.length, 1);
      assert.equal(fake.connections, 0);
    });
  });
}

describe('TLS to a database by name is still about the name', () => {
  it('db.postgresql sends the name, and verifies the certificate against it', async (t) => {
    if (!needsTrust(t)) return;
    const fake = await postgresServer(forName);
    try {
      const dns = rebinding();
      const execution = await execute(dbPostgresql, dns, {
        port: fake.port,
        params: { encrypt: 'require', verifyTls: true },
      });
      assert.equal(valueOf(execution, 'value'), 1);
      assert.deepEqual(fake.serverNames, [NAME]);
      assert.equal(dns.calls.length, 1);
    } finally {
      await fake.close();
    }
  });

  it('db.postgresql refuses a trusted certificate that is for another name', async (t) => {
    if (!needsTrust(t)) return;
    const fake = await postgresServer(forAnother);
    try {
      const dns = rebinding();
      const error = await failure(
        execute(dbPostgresql, dns, {
          port: fake.port,
          params: { encrypt: 'require', verifyTls: true },
        }),
      );
      // Checked against the name the operator gave, and never against 127.0.0.1.
      assert.match(error.message, /database\.policy\.invalid/);
      assert.match(error.message, /does not match|altnames/i);
      assert.deepEqual(fake.said, [], 'no query was sent to a server that is not the one named');
      assert.equal(dns.calls.length, 1);
    } finally {
      await fake.close();
    }
  });

  it('db.postgresql pinned for a credential set names the device too', async (t) => {
    if (!needsTrust(t)) return;
    const fake = await postgresServer(forName);
    try {
      const dns = rebinding();
      const execution = await execute(dbPostgresql, dns, {
        port: fake.port,
        targets: INSIDE,
        params: { encrypt: 'require', verifyTls: true },
      });
      assert.equal(valueOf(execution, 'value'), 1);
      assert.deepEqual(fake.serverNames, [NAME]);
      assert.equal(dns.calls.length, 1);
    } finally {
      await fake.close();
    }
  });

  it('db.postgresql under `prefer` carries on in plain text on the same checked address', async () => {
    // A server with no TLS: `pg` is refused the upgrade and the driver connects again. The
    // second connection is the same check's, and makes no second lookup.
    const fake = await postgresServer();
    try {
      const dns = rebinding();
      const execution = await execute(dbPostgresql, dns, {
        port: fake.port,
        params: { encrypt: 'prefer' },
      });
      assert.equal(valueOf(execution, 'value'), 1);
      assert.equal(fake.connections, 2);
      assert.equal(dns.calls.length, 1);
    } finally {
      await fake.close();
    }
  });

  it('db.mysql sends the name in its TLS hello', async (t) => {
    if (!needsTrust(t)) return;
    const fake = await mysqlServer(forName);
    try {
      const dns = rebinding();
      const execution = await execute(dbMysql, dns, {
        port: fake.port,
        params: { encrypt: 'require', verifyTls: true },
      });
      assert.equal(valueOf(execution, 'value'), 1);
      assert.deepEqual(fake.serverNames, [NAME]);
      assert.equal(dns.calls.length, 1);
    } finally {
      await fake.close();
    }
  });

  it('db.mssql sends the name in the TLS hello it makes inside TDS', async () => {
    const fake = await tdsServer();
    try {
      const dns = rebinding();
      await failure(execute(dbMssql, dns, { port: fake.port, params: { encrypt: 'require' } }));
      assert.deepEqual(fake.said, ['packet 0x12', 'tls hello']);
      assert.deepEqual(fake.serverNames, [NAME]);
      assert.equal(dns.calls.length, 1);
    } finally {
      await fake.close();
    }
  });
});

describe('db.mysql verifies who the certificate is for, where it verifies at all (A-70)', () => {
  // `mysql2` checks the chain under `rejectUnauthorized` and the name only under
  // `verifyIdentity`, which this driver never set: "Verify the certificate" took any trusted
  // certificate, whoever it was for. The right name is the case above, which ran before too.
  it('refuses a trusted certificate that is for another name, and asks nothing of the server', async (t) => {
    if (!needsTrust(t)) return;
    const fake = await mysqlServer(forAnother);
    try {
      const dns = rebinding();
      const error = await failure(
        execute(dbMysql, dns, {
          port: fake.port,
          params: { encrypt: 'require', verifyTls: true },
        }),
      );
      // Checked against the name the operator gave, and never against 127.0.0.1.
      assert.match(error.message, /database\.policy\.invalid/);
      assert.match(error.message, /does not match|altnames/i);
      assert.equal(fake.connections, 1);
      assert.deepEqual(fake.serverNames, [NAME]);
      assert.deepEqual(fake.said, [], 'no query was sent to a server that is not the one named');
      assert.equal(dns.calls.length, 1);
    } finally {
      await fake.close();
    }
  });

  it('with verification off takes that certificate as it always did', async (t) => {
    if (!needsTrust(t)) return;
    const fake = await mysqlServer(forAnother);
    try {
      const execution = await execute(dbMysql, rebinding(), {
        port: fake.port,
        params: { encrypt: 'require', verifyTls: false },
      });
      assert.equal(valueOf(execution, 'value'), 1);
      assert.deepEqual(fake.said, ['select 1 as n']);
    } finally {
      await fake.close();
    }
  });

  it('refuses one for another name on a device pinned for a credential set too', async (t) => {
    if (!needsTrust(t)) return;
    const fake = await mysqlServer(forAnother);
    try {
      const error = await failure(
        execute(dbMysql, rebinding(), {
          port: fake.port,
          targets: INSIDE,
          params: { encrypt: 'require', verifyTls: true },
        }),
      );
      assert.match(error.message, /does not match|altnames/i);
      assert.ok(!isCredentialsWithheld(error), 'a failed check: the address was the pinned one');
      assert.deepEqual(fake.said, []);
    } finally {
      await fake.close();
    }
  });
});

/**
 * A database given as an address, under TLS with verification on (`A-70`, from `A-71`).
 *
 * `A-67` found that a mail server given by address was checked against the literal `localhost`
 * after `STARTTLS`, because Node is handed a connected socket and no host. The database
 * drivers upgrade a connected socket too, each in its own code, and none had been tried.
 *
 * What each does, read from the installed source and then run here:
 * - `pg` 8.23 (`lib/connection.js` `upgradeToSSL`) spreads our `ssl` object into
 *   `tls.connect`, so it takes a `checkServerIdentity`; it sets `servername` only for a name,
 *   so an address was checked against `localhost`. It is handed the shared `serverIdentity`,
 *   bound to the device's host: both families pass under a certificate that lists them.
 * - `mysql2` 3.24 (`lib/base/connection.js` `startTLS`) picks named fields out of `ssl` and
 *   hands Node `tls.checkServerIdentity` or nothing: no check of ours can be given. It names
 *   no server for an address, so that was `localhost` too. The socket it is handed says which
 *   address it went to: IPv4 passes, and IPv6 is refused by Node's own check (`A-60`).
 * - `tedious` 20 (`lib/message-io.js` `startTls`) calls `tls.connect` with `servername`, a
 *   secure context and `rejectUnauthorized`: no check of ours either. It names the address as
 *   the server name, so IPv4 is checked as an address and passes; IPv6 is refused by Node.
 *
 * **The two IPv6 refusals are pinned as refusals**, not skipped: they are what happens, they
 * fail on the side of refusing, and the day either driver or Node changes them these cases say.
 */
describe('TLS to a database given as an address is about the address (A-70)', () => {
  type Pair = { key: string; cert: string };
  interface Secured {
    readonly name: string;
    readonly type: SensorType;
    readonly server: (certificate: Pair, address: string) => Promise<Fake>;
    /** Whether a certificate that lists an IPv6 address can be verified through this driver. */
    readonly verifiesV6: boolean;
    /** The check, when the certificate was accepted and the login or the query went through. */
    readonly accepted: (run: Promise<CheckExecution>, fake: Fake) => Promise<void>;
    /** What the server had been sent when a check was refused before anything was said. */
    readonly nothingSaid: (fake: Fake) => void;
  }
  const answered = async (run: Promise<CheckExecution>, fake: Fake): Promise<void> => {
    assert.equal(valueOf(await run, 'value'), 1);
    assert.deepEqual(fake.said, ['select 1 as n']);
  };
  const SECURED: readonly Secured[] = [
    {
      name: 'db.postgresql',
      type: dbPostgresql,
      server: (certificate, address) => postgresServer(certificate, address),
      verifiesV6: true,
      accepted: answered,
      nothingSaid: (fake) => {
        assert.deepEqual(fake.said, []);
      },
    },
    {
      name: 'db.mysql',
      type: dbMysql,
      server: (certificate, address) => mysqlServer(certificate, address),
      verifiesV6: false,
      accepted: answered,
      nothingSaid: (fake) => {
        assert.deepEqual(fake.said, []);
      },
    },
    {
      name: 'db.mssql',
      type: dbMssql,
      server: (certificate, address) => tdsServer({ secure: certificate, address }),
      verifiesV6: false,
      accepted: async (run, fake) => {
        // The fake takes the login and hangs up: a database that went away, after a login
        // that was sent through TLS, which is the certificate accepted.
        const error = await failure(run);
        assert.doesNotMatch(error.message, /altnames|does not match|certificate/i);
        assert.deepEqual(fake.said, ['packet 0x12', 'tls established', 'login7']);
      },
      nothingSaid: (fake) => {
        assert.equal(fake.said.includes('login7'), false, 'no login was sent');
      },
    },
  ];
  const HOSTS = [
    { host: '127.0.0.1', family: 4 },
    { host: '::1', family: 6 },
  ] as const;
  const REFUSED = /altnames|does not match|is not in the cert|is not cert's/i;

  /** The certificates, or a skip saying why this case cannot run here. */
  function ready(
    t: { skip(reason: string): void },
    family: 4 | 6,
  ): { listed: Pair; others: Pair; localhost: Pair } | null {
    if (!needsTrust(t)) return null;
    if (family === 6 && !v6) {
      t.skip('::1 cannot be listened on here');
      return null;
    }
    if (
      forAddresses === undefined ||
      forOtherAddresses === undefined ||
      forLocalhost === undefined
    ) {
      return assert.fail('the certificates were not made');
    }
    return { listed: forAddresses, others: forOtherAddresses, localhost: forLocalhost };
  }

  const verified = (engine: Secured, host: string, fake: Fake, dns: Rebinding, verify = true) =>
    execute(engine.type, dns, {
      host,
      port: fake.port,
      params: { encrypt: 'require', verifyTls: verify },
    });

  for (const engine of SECURED) {
    for (const { host, family } of HOSTS) {
      const passes = family === 4 || engine.verifiesV6;

      it(
        passes
          ? `${engine.name} at ${host}: a certificate that lists the address is accepted`
          : `${engine.name} at ${host}: refused whatever the certificate lists, and says the driver cannot check it`,
        async (t) => {
          const pairs = ready(t, family);
          if (pairs === null) return;
          const fake = await engine.server(pairs.listed, host);
          try {
            const dns = rebinding();
            if (passes) {
              await engine.accepted(verified(engine, host, fake, dns), fake);
            } else {
              const error = await failure(verified(engine, host, fake, dns));
              assert.match(error.message, /could not be checked against an IPv6 address/);
              assert.match(error.message, /this driver cannot verify one/);
              engine.nothingSaid(fake);
            }
            assert.equal(fake.connections, 1);
            assert.equal(dns.calls.length, 0, 'an address resolves nothing');
          } finally {
            await fake.close();
          }
        },
      );

      it(`${engine.name} at ${host}: a trusted certificate that lists other addresses is refused`, async (t) => {
        const pairs = ready(t, family);
        if (pairs === null) return;
        const fake = await engine.server(pairs.others, host);
        try {
          const error = await failure(verified(engine, host, fake, rebinding()));
          assert.match(error.message, REFUSED);
          engine.nothingSaid(fake);
          assert.equal(fake.connections, 1);
        } finally {
          await fake.close();
        }
      });

      it(`${engine.name} at ${host}: a trusted certificate for \`localhost\` is refused`, async (t) => {
        // What Node checks a connected socket against when nobody names a host. Before this
        // ticket `pg` and `mysql2` accepted this one for any device given as an address.
        const pairs = ready(t, family);
        if (pairs === null) return;
        const fake = await engine.server(pairs.localhost, host);
        try {
          const error = await failure(verified(engine, host, fake, rebinding()));
          assert.match(error.message, REFUSED);
          engine.nothingSaid(fake);
        } finally {
          await fake.close();
        }
      });

      it(`${engine.name} at ${host}: with verification off, any certificate is taken as before`, async (t) => {
        const pairs = ready(t, family);
        if (pairs === null) return;
        const fake = await engine.server(pairs.others, host);
        try {
          await engine.accepted(verified(engine, host, fake, rebinding(), false), fake);
        } finally {
          await fake.close();
        }
      });
    }
  }

  it('db.postgresql by name is still checked against the name, by the same check', async (t) => {
    // The check `pg` is handed is bound to the device's host, whatever Node passes it: a
    // certificate that lists the address the name resolved to is not one for the name.
    if (!needsTrust(t)) return;
    if (forAddresses === undefined) return assert.fail('the certificates were not made');
    const fake = await postgresServer(forAddresses);
    try {
      const error = await failure(
        execute(dbPostgresql, rebinding(), {
          port: fake.port,
          params: { encrypt: 'require', verifyTls: true },
        }),
      );
      assert.match(error.message, /database\.policy\.invalid/);
      assert.match(error.message, REFUSED);
      assert.deepEqual(fake.said, []);
    } finally {
      await fake.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------

/**
 * A loopback port that takes a connection's first packet and never answers it, or null where
 * this machine will not make one. As in `target-policy-transports.test.ts`.
 */
async function blackhole(): Promise<{ port: number; close: () => Promise<void> } | null> {
  const worker = new Worker(
    `const { createServer } = require('node:net');
     const { parentPort } = require('node:worker_threads');
     const server = createServer();
     server.listen({ port: 0, host: '127.0.0.1', backlog: 1 }, () => {
       parentPort.postMessage(server.address().port);
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
     });`,
    { eval: true },
  );
  const port = await new Promise<number>((resolve) => worker.once('message', resolve));
  const filling: Socket[] = [];
  const close = async (): Promise<void> => {
    for (const socket of filling) socket.destroy();
    await worker.terminate();
  };
  for (let at = 0; at < 16; at += 1) {
    const socket = netConnect({ host: '127.0.0.1', port });
    socket.on('error', () => undefined);
    filling.push(socket);
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (socket.connecting) return { port, close };
  }
  await close();
  return null;
}

describe('the lookup and the connection share a database sensor’s connect timeout', () => {
  // A resolver that takes 900 ms of a 2,000 ms timeout, then an address that never answers.
  // Given the whole timeout again after the lookup, the check would end 900 ms later.
  let hole: Awaited<ReturnType<typeof blackhole>> = null;
  before(async () => {
    hole = await blackhole();
  });
  after(async () => {
    await hole?.close();
  });
  const TIMEOUT = 2_000;
  const LOOKUP = 900;

  for (const engine of ENGINES) {
    it(engine.name, async (t) => {
      if (hole === null) {
        t.skip('this machine answers a connection to a listener that never accepts');
        return;
      }
      const started = process.hrtime.bigint();
      const error = await failure(
        execute(engine.type, slow(LOOKUP), {
          port: hole.port,
          params: { connectTimeoutMs: TIMEOUT },
        }),
      );
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(error instanceof DbError, `threw ${String(error)}`);
      assert.ok(ms >= TIMEOUT - 150 && ms < TIMEOUT + 500, `took ${String(Math.round(ms))} ms`);
    });
  }

  for (const engine of ENGINES) {
    it(`${engine.name}: the driver’s own connect timer reads as the one sentence, in the connect phase (A-70)`, async (t) => {
      if (hole === null) {
        t.skip('this machine answers a connection to a listener that never accepts');
        return;
      }
      // An address under `none`: the driver is handed nothing, so the timer that ends the
      // connect is its own. `pg` says "timeout expired" with no code, `tedious` codes its
      // error ETIMEOUT, `mysql2` ETIMEDOUT: one sentence for the three.
      const error = await failure(
        execute(engine.type, rebinding(), {
          host: '127.0.0.1',
          port: hole.port,
          policy: 'none',
          params: { connectTimeoutMs: 600 },
        }),
      );
      assert.ok(error instanceof DbError, `threw ${String(error)}`);
      assert.equal(
        error.message,
        `127.0.0.1:${String(hole.port)} accepted no connection within 600 ms — a firewall ` +
          'dropping the packets looks exactly like this',
      );
      assert.equal(error.phase, 'connect');
    });
  }

  for (const policy of ['link-local', 'none'] as const) {
    it(`db.mssql routed to a server that never answers names that server and the redirect, under \`${policy}\` (A-70)`, async (t) => {
      if (hole === null) {
        t.skip('this machine answers a connection to a listener that never accepts');
        return;
      }
      // The device answers and routes the login to a port that takes it and says nothing.
      // Under `none` the timer is `tedious`'s own; otherwise the connector is in the way too.
      const device = await tdsServer({ route: { server: '127.0.0.1', port: hole.port } });
      try {
        const error = await failure(
          execute(dbMssql, rebinding(), {
            host: '127.0.0.1',
            port: device.port,
            policy,
            params: { connectTimeoutMs: 1_500 },
          }),
        );
        assert.deepEqual(device.said, ['packet 0x12', 'login7'], 'the device was reached');
        assert.ok(error instanceof DbError, `threw ${String(error)}`);
        assert.equal(
          error.message,
          `127.0.0.1:${String(device.port)} routed the login to 127.0.0.1:${String(hole.port)}, ` +
            'which accepted no connection within 1500 ms — a firewall dropping the packets ' +
            'looks exactly like this',
        );
        assert.equal(error.phase, 'connect');
      } finally {
        await device.close();
      }
    });
  }

  it('the connector says which server it was routed to when that one does not answer (A-70)', async (t) => {
    if (hole === null) {
      t.skip('this machine answers a connection to a listener that never accepts');
      return;
    }
    const base: DbConnectOptions = {
      host: '127.0.0.1',
      port: 1433,
      database: '',
      username: 'monitor',
      password: 'secret',
      encrypt: 'disable',
      verifyTls: false,
      connectTimeoutMs: 400,
      statementTimeoutMs: 5_000,
      redirect: () => Promise.resolve(undefined),
    };
    const connector = tdsConnector(base) ?? assert.fail('no connector');
    // The same host on another port is a server the login was routed to.
    const routed = await failure(connector({ host: '127.0.0.1', port: hole.port }));
    assert.equal((routed as { routedTo?: unknown }).routedTo, `127.0.0.1:${String(hole.port)}`);
    assert.equal((routed as NodeJS.ErrnoException).code, 'ETIMEDOUT');
    // The device itself carries none: it is the device that did not answer.
    const device = tdsConnector({ ...base, port: hole.port }) ?? assert.fail('no connector');
    const own = await failure(device());
    assert.equal((own as NodeJS.ErrnoException).code, 'ETIMEDOUT');
    assert.equal((own as { routedTo?: unknown }).routedTo, undefined);
  });

  it('the connector `tedious` waits on ends itself at what is left, with no signal to end it', async (t) => {
    if (hole === null) {
      t.skip('this machine answers a connection to a listener that never accepts');
      return;
    }
    // `tedious` awaits its connector with nothing raced against it, so the connector's own
    // clock is the only thing between a dropped SYN and the kernel's two minutes.
    const connector =
      tdsConnector({
        host: NAME,
        port: hole.port,
        database: '',
        username: 'monitor',
        password: 'secret',
        encrypt: 'disable',
        verifyTls: false,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 5_000,
        connectWithinMs: 400,
        lookup: (_name, options, done) => {
          if (options.all === true) done(null, [{ address: '127.0.0.1', family: 4 }]);
          else done(null, '127.0.0.1', 4);
        },
      }) ?? assert.fail('no connector');
    const started = process.hrtime.bigint();
    const error = await failure(connector());
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal((error as NodeJS.ErrnoException).code, 'ETIMEDOUT');
    assert.ok(ms >= 350 && ms < 1_500, `took ${String(Math.round(ms))} ms`);
  });

  it('the driver is told what is left, and quotes the timeout the sensor was given', async () => {
    const seen: DbConnectOptions[] = [];
    const driver = recording(seen);
    await runDbCheck(driver, contextOf(NAME, slow(300), { connectTimeoutMs: 1_000 }));
    const [options] = seen;
    assert.ok(options !== undefined);
    assert.equal(options.connectTimeoutMs, 1_000);
    const left = connectBudgetMs(options);
    assert.ok(left <= 705 && left > 400, `left ${String(left)} ms`);
    // A device given as an address has the whole of it, and no socket of the sensor's making.
    await runDbCheck(driver, contextOf('127.0.0.1', slow(300), { connectTimeoutMs: 1_000 }));
    assert.equal(seen[1]?.connectWithinMs, undefined);
    assert.equal(connectBudgetMs(seen[1] ?? assert.fail('no second connect')), 1_000);
  });
});

// ---------------------------------------------------------------------------------------------

/** A driver that connects to nothing and keeps what it was handed. */
function recording(seen: DbConnectOptions[]): DbDriver {
  return {
    id: 'postgresql',
    name: 'PostgreSQL',
    defaultPort: 5432,
    connect: (options) => {
      seen.push(options);
      return Promise.resolve({
        query: () => Promise.resolve({ rows: [{ n: '1' }], columns: ['n'] }),
        close: () => Promise.resolve(),
      });
    },
  };
}

function contextOf(
  host: string,
  dns: Rebinding,
  params: Record<string, unknown> = {},
  target: Partial<CheckContext['target']> = {},
): CheckContext {
  return {
    sensorId: 62,
    target: { host, ipVersion: 'auto', resolve: dns.resolve, ...target },
    params: { query: 'select 1', ...params },
    credentials: { database: { username: 'monitor', password: 'secret' } },
    signal: new AbortController().signal,
  };
}

/** What a socket would be told by a lookup, asked for every address. */
function ask(lookup: LookupFunction, name: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    lookup(name, { all: true }, (error, addresses) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(
        (Array.isArray(addresses) ? addresses : [{ address: addresses }]).map((one) => one.address),
      );
    });
  });
}

describe('what a database driver is handed', () => {
  it('a name: the name as its host, and a lookup that answers it with the checked addresses', async () => {
    const seen: DbConnectOptions[] = [];
    const dns = rebinding(v4('127.0.0.1', '127.0.0.2'));
    await runDbCheck(recording(seen), contextOf(NAME, dns));
    const [options] = seen;
    assert.ok(options?.lookup !== undefined);
    assert.equal(options.host, NAME, 'TLS names the host the driver holds');
    assert.equal(options.pinned, undefined);
    assert.deepEqual(await ask(options.lookup, NAME), ['127.0.0.1', '127.0.0.2']);
    await assert.rejects(ask(options.lookup, OTHER), /is not the name that was checked/);
    assert.equal(dns.calls.length, 1);
  });

  it('an address, or anything under `none`: no lookup, and nothing resolved', async () => {
    const seen: DbConnectOptions[] = [];
    const dns = rebinding(v4(METADATA));
    await runDbCheck(recording(seen), contextOf('127.0.0.1', dns));
    await runDbCheck(recording(seen), contextOf(NAME, dns, {}, { policy: 'none' }));
    await runDbCheck(recording(seen), contextOf('169.254.7.7', dns, {}, { policy: 'none' }));
    assert.deepEqual(
      seen.map((options) => [options.host, options.lookup, options.connectWithinMs]),
      [
        ['127.0.0.1', undefined, undefined],
        [NAME, undefined, undefined],
        ['169.254.7.7', undefined, undefined],
      ],
    );
    assert.equal(dns.calls.length, 0);
    // A redirect is asked about for an address too, wherever anything is checked: only under
    // `none`, with a set that has no bounds, is the driver left to follow one by itself.
    assert.deepEqual(
      seen.map((options) => typeof options.redirect),
      ['function', 'undefined', 'undefined'],
    );
  });

  it('a device given as an address: a redirect is checked against the policy all the same', async () => {
    const seen: DbConnectOptions[] = [];
    const dns = rebinding(v4('127.0.0.3'), v4('127.0.0.3', METADATA));
    await runDbCheck(recording(seen), contextOf('127.0.0.1', dns));
    const redirect = seen[0]?.redirect ?? assert.fail('no redirect was handed over');
    await assert.rejects(redirect(METADATA), TargetRefusedError);
    assert.equal(dns.calls.length, 0);
    const onward = (await redirect(OTHER)) ?? assert.fail('a name needs a lookup');
    assert.deepEqual(await ask(onward, OTHER), ['127.0.0.3']);
    await assert.rejects(redirect(OTHER), TargetRefusedError);
    assert.equal(dns.calls.length, 2);
  });

  describe('a set with bounds is not sent on to a server outside them', () => {
    const bounded = (host: string, targets: string[], policy?: TargetPolicy): CheckContext => {
      const context = contextOf(
        host,
        rebinding(v4('127.0.0.1'), v4('127.0.0.3')),
        {},
        policy === undefined ? {} : { policy },
      );
      return {
        ...context,
        credentials: {
          database: { username: 'monitor', password: 'secret', allowedTargets: targets },
        },
      };
    };
    const refusedTo = async (context: CheckContext, other: string): Promise<void> => {
      const seen: DbConnectOptions[] = [];
      await runDbCheck(recording(seen), context);
      const redirect = seen[0]?.redirect ?? assert.fail('no redirect was handed over');
      const error = await failure(redirect(other));
      // **A failed check, and not a refusal over credentials** (`A-70`): the core left this
      // device to nobody, so a mark on the result would be one it does not believe and counts
      // against the probe. Nothing a runner reads as withheld.
      assert.ok(error instanceof DbRedirectRefusedError, String(error));
      assert.ok(!isCredentialsWithheld(error));
      assert.equal((error as { code?: unknown }).code, undefined);
      assert.equal(error.message, REDIRECT_OUTSIDE_TARGETS(context.target.host, other));
      assert.deepEqual(
        [error.target, error.routedTo, error.phase],
        [context.target.host, other, 'connect'],
      );
    };

    it('a device given as an address inside the targets', async () => {
      const context = bounded('127.0.0.1', ['127.0.0.0/8']);
      // An address outside, and a name: the targets name addresses, and a name is not
      // resolved to find out whether it is inside them.
      await refusedTo(context, '192.0.2.9');
      await refusedTo(context, OTHER);
      await refusedTo(context, METADATA);
    });

    it('a device given as a name that a name entry covers', async () => {
      const context = bounded(NAME, [NAME]);
      await refusedTo(context, OTHER);
      await refusedTo(context, '127.0.0.3');
    });

    it('under `none` too: the bounds are the set’s, not the policy’s', async () => {
      await refusedTo(bounded('127.0.0.1', ['127.0.0.0/8'], 'none'), '192.0.2.9');
      await refusedTo(bounded(NAME, [NAME], 'none'), OTHER);
    });

    it('a server inside the bounds is followed, and still checked against the policy', async () => {
      const seen: DbConnectOptions[] = [];
      // An address the targets cover needs no lookup.
      await runDbCheck(recording(seen), bounded('127.0.0.1', ['127.0.0.0/8', '169.254.0.0/16']));
      const byAddress = seen[0]?.redirect ?? assert.fail('no redirect was handed over');
      assert.equal(await byAddress('127.0.0.3'), undefined);
      // Inside the set's targets and refused by the probe's policy: a failed check.
      await assert.rejects(byAddress(METADATA), TargetRefusedError);
      // A name a `*.domain` entry covers is resolved once and checked against the policy.
      const context = bounded(NAME, ['*.policy.invalid']);
      await runDbCheck(recording(seen), context);
      const byName = seen[1]?.redirect ?? assert.fail('no redirect was handed over');
      const onward = (await byName(OTHER)) ?? assert.fail('a name needs a lookup');
      assert.deepEqual(await ask(onward, OTHER), ['127.0.0.3']);
    });
  });

  it('a name that does not resolve fails in the guard, and the driver is not asked', async () => {
    const seen: DbConnectOptions[] = [];
    let lookups = 0;
    const context = contextOf('nowhere.policy.invalid', rebinding(), { port: 5433 });
    const error = await failure(
      runDbCheck(recording(seen), {
        ...context,
        target: {
          ...context.target,
          resolve: () => {
            lookups += 1;
            return Promise.reject(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
          },
        },
      }),
    );
    assert.equal(
      error.message,
      'the device’s host name did not resolve to an address, connecting to ' +
        'nowhere.policy.invalid:5433 (ENOTFOUND)',
    );
    assert.equal(lookups, 1);
    assert.deepEqual(seen, []);
  });

  describe('a PostgreSQL host that is a Unix socket directory is not a network target (A-70)', () => {
    const SOCKETS = '/var/run/postgresql';
    /** A resolver that fails the check if it is ever asked. */
    const never = (): { context: CheckContext; lookups: () => number } => {
      let lookups = 0;
      const context = contextOf(SOCKETS, rebinding(), { port: 5433 });
      return {
        lookups: () => lookups,
        context: {
          ...context,
          target: {
            ...context.target,
            resolve: () => {
              lookups += 1;
              return Promise.reject(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
            },
          },
        },
      };
    };

    it('where the policy allows loopback it goes to the driver as it stands: nothing resolved, no lookup, no redirect, the whole timeout', async () => {
      // `undefined` is a probe that says nothing, which is `link-local`.
      for (const policy of ['link-local', 'none', undefined] as const) {
        const seen: DbConnectOptions[] = [];
        const { context, lookups } = never();
        const execution = await runDbCheck(recording(seen), {
          ...context,
          target: { ...context.target, ...(policy === undefined ? {} : { policy }) },
        });
        assert.equal(valueOf(execution, 'value'), 1, policy);
        assert.equal(lookups(), 0, `${String(policy)}: a path is not a name`);
        assert.deepEqual(
          seen.map((options) => [
            options.host,
            options.port,
            options.lookup,
            options.connectWithinMs,
            options.redirect,
            options.pinned,
          ]),
          [[SOCKETS, 5433, undefined, undefined, undefined, undefined]],
          policy,
        );
      }
    });

    it('where the policy refuses loopback it is refused: a socket path is the probe’s own machine', async () => {
      // `private` refuses 127.0.0.1, which is an operator saying this probe is not to be
      // pointed at itself. The same server by its socket is the same server.
      const seen: DbConnectOptions[] = [];
      const { context, lookups } = never();
      const error = await failure(
        runDbCheck(recording(seen), {
          ...context,
          target: { ...context.target, policy: 'private' },
        }),
      );
      assert.ok(error instanceof TargetRefusedError, String(error));
      assert.ok(!isCredentialsWithheld(error));
      assert.deepEqual([error.target, error.address, error.policy], [SOCKETS, SOCKETS, 'private']);
      assert.equal(
        error.message,
        'refusing to connect to /var/run/postgresql, which is a socket on this probe’s own ' +
          'machine, as 127.0.0.1 is, and that is a private address; this probe’s target ' +
          'policy (private) refuses it, as it does every cloud instance-metadata address, and ' +
          'probe.targetPolicy “none” refuses nothing',
      );
      assert.equal(lookups(), 0);
      assert.deepEqual(seen, [], 'the driver was not asked');
    });

    it('is decided by what the policy says of 127.0.0.1, for every policy there is', async () => {
      for (const policy of ['link-local', 'private', 'none'] as const) {
        const loopback = await runDbCheck(recording([]), {
          ...contextOf('127.0.0.1', rebinding()),
          target: { host: '127.0.0.1', ipVersion: 'auto', policy },
        }).then(
          () => 'allowed',
          (error: unknown) => (error instanceof TargetRefusedError ? 'refused' : String(error)),
        );
        const { context } = never();
        const path = await runDbCheck(recording([]), {
          ...context,
          target: { ...context.target, policy },
        }).then(
          () => 'allowed',
          (error: unknown) => (error instanceof TargetRefusedError ? 'refused' : String(error)),
        );
        assert.equal(path, loopback, policy);
        assert.equal(path, policy === 'private' ? 'refused' : 'allowed', policy);
      }
    });

    it('the real `pg` is refused the path under `private`, and nothing is looked for', async () => {
      const dns = rebinding();
      const error = await failure(
        execute(dbPostgresql, dns, {
          host: join(tmpdir(), 'ms-a70-no-postgres-here'),
          port: 5433,
          policy: 'private',
        }),
      );
      assert.ok(error instanceof TargetRefusedError, String(error));
      assert.doesNotMatch(error.message, /ENOENT/);
      assert.equal(dns.calls.length, 0);
    });

    it('is PostgreSQL’s alone: the other two engines have no such host, and it is resolved as a name', async () => {
      for (const id of ['mysql', 'mssql'] as const) {
        const seen: DbConnectOptions[] = [];
        const { context, lookups } = never();
        const error = await failure(runDbCheck({ ...recording(seen), id }, context));
        assert.match(error.message, /did not resolve to an address/, id);
        assert.equal(lookups(), 1, id);
        assert.deepEqual(seen, [], id);
      }
    });

    it('a path that only contains a slash is a name like any other', async () => {
      const seen: DbConnectOptions[] = [];
      const { context, lookups } = never();
      await failure(
        runDbCheck(recording(seen), {
          ...context,
          target: { ...context.target, host: 'var/run/postgresql' },
        }),
      );
      assert.equal(lookups(), 1);
      assert.deepEqual(seen, []);
    });

    it('a target that was pinned is held to its pin, whatever its host looks like', async () => {
      // A path is never pinned by `pinTarget`: it does not resolve. Were a pin handed over
      // beside one all the same, the pin is what is checked, and not waved through as local.
      const seen: DbConnectOptions[] = [];
      const { context, lookups } = never();
      const error = await failure(
        runDbCheck(recording(seen), {
          ...context,
          target: { ...context.target, pinned: { address: METADATA, family: 4 } },
        }),
      );
      assert.ok(error instanceof TargetRefusedError, String(error));
      assert.equal(lookups(), 0);
      assert.deepEqual(seen, []);
    });

    it('the real `pg` is handed the path and looks for the socket inside it', async () => {
      // No server: what is shown is where `pg` went. It names the socket file in the
      // directory, by the port, and nothing was resolved on the way.
      const missing = join(tmpdir(), 'ms-a70-no-postgres-here');
      const dns = rebinding();
      const error = await failure(
        execute(dbPostgresql, dns, { host: missing, port: 5433, params: { encrypt: 'disable' } }),
      );
      assert.ok(!(error instanceof TargetRefusedError), error.message);
      assert.doesNotMatch(error.message, /did not resolve/);
      assert.match(error.message, /ENOENT/);
      assert.ok(error.message.includes(`${missing}/.s.PGSQL.5433`), error.message);
      assert.equal(dns.calls.length, 0);
    });
  });

  it('a pinned name: the pinned address, and only it', async () => {
    const seen: DbConnectOptions[] = [];
    const dns = rebinding(v4('127.0.0.9'));
    const pinned = { address: '127.0.0.1', family: 4 } as const;
    await runDbCheck(recording(seen), contextOf(NAME, dns, {}, { pinned }));
    const [options] = seen;
    assert.ok(options?.lookup !== undefined);
    assert.deepEqual(options.pinned, pinned);
    assert.deepEqual(await ask(options.lookup, NAME), ['127.0.0.1']);
    // Another name is the pin's own refusal, which a runner reads as Unknown.
    await assert.rejects(ask(options.lookup, OTHER), CredentialsWithheldError);
    assert.equal(dns.calls.length, 0, 'the pin already resolved it');
  });

  it('a server the device redirects to is checked as a device is, on a lookup of its own', async () => {
    const seen: DbConnectOptions[] = [];
    const dns = rebinding(v4('127.0.0.1'), v4('127.0.0.3'));
    await runDbCheck(recording(seen), contextOf(NAME, dns));
    const redirect = seen[0]?.redirect ?? assert.fail('no redirect was handed over');
    const onward = (await redirect(OTHER)) ?? assert.fail('a name needs a lookup');
    assert.deepEqual(await ask(onward, OTHER), ['127.0.0.3']);
    assert.deepEqual(dns.calls, [
      { host: NAME, family: 0 },
      { host: OTHER, family: 0 },
    ]);
    // An address the server names is checked as it stands.
    assert.equal(await redirect('127.0.0.5'), undefined);
    await assert.rejects(redirect(METADATA), TargetRefusedError);
    assert.equal(dns.calls.length, 2);
  });

  it('a redirect to a name that resolves to a refused address is refused', async () => {
    const seen: DbConnectOptions[] = [];
    const dns = rebinding(v4('127.0.0.1'), v4('127.0.0.3', METADATA));
    await runDbCheck(recording(seen), contextOf(NAME, dns));
    const redirect = seen[0]?.redirect ?? assert.fail('no redirect was handed over');
    const error = await failure(redirect(OTHER));
    assert.ok(error instanceof TargetRefusedError);
    assert.match(
      error.message,
      /^refusing to follow a redirect to replica\.policy\.invalid: it resolves to 169\.254\.169\.254/,
    );
  });

  it('a set that was pinned is not sent on to another server', async () => {
    const seen: DbConnectOptions[] = [];
    const dns = rebinding();
    const pinned = { address: '127.0.0.1', family: 4 } as const;
    await runDbCheck(recording(seen), contextOf(NAME, dns, {}, { pinned }));
    const redirect = seen[0]?.redirect ?? assert.fail('no redirect was handed over');
    const error = await failure(redirect(OTHER));
    assert.ok(error instanceof CredentialsWithheldError);
    assert.equal(error.message, PIN_REFUSALS.redirected(NAME, OTHER));
    assert.deepEqual(
      [error.sensorId, error.target, error.phase, error.kind],
      [62, NAME, 'connect', 'database'],
    );
    assert.equal(dns.calls.length, 0, 'nothing is resolved for a server the set may not reach');
  });
});

describe('a SQL Server that routes the login to another server', () => {
  // The real `tedious`, answered a login with a routing ENVCHANGE: it destroys its socket and
  // asks its connector for the server it was routed to. `onward` is that server, on 127.0.0.2,
  // which the device's own address is not: what arrives there arrived by the redirect.
  let onward: Fake;
  before(async () => {
    onward = await tdsServer({ login: true, address: '127.0.0.2' });
  });
  after(async () => {
    await onward.close();
  });
  const reset = (): void => {
    onward.connections = 0;
    onward.said.length = 0;
  };
  const routed = async (
    to: string,
    run: Omit<Run, 'port'>,
    dns: Rebinding,
  ): Promise<{ error: Error; device: Fake }> => {
    const device = await tdsServer({ route: { server: to, port: onward.port } });
    try {
      const error = await failure(execute(dbMssql, dns, { port: device.port, ...run }));
      return { error, device };
    } finally {
      await device.close();
    }
  };
  /** The device was logged in to, once, and routed the login on. */
  const loggedIn = (device: Fake): void => {
    assert.deepEqual(device.said, ['packet 0x12', 'login7']);
  };
  /** A database that went away, and neither kind of refusal. */
  const ordinary = (error: Error): void => {
    assert.ok(!(error instanceof TargetRefusedError), String(error));
    assert.ok(!isCredentialsWithheld(error), String(error));
  };

  it('an address-literal device routed to a metadata address is refused, with nothing sent there', async () => {
    reset();
    const dns = rebinding();
    const { error, device } = await routed(METADATA, { host: '127.0.0.1' }, dns);
    loggedIn(device);
    assert.ok(error instanceof TargetRefusedError, String(error));
    assert.match(
      error.message,
      /^refusing to follow a redirect to 169\.254\.169\.254, which is link-local/,
    );
    assert.equal(dns.calls.length, 0);
    assert.equal(onward.connections, 0);
  });

  it('an address-literal device routed to a name that resolves to one is refused on one lookup', async () => {
    reset();
    // One address the onward server listens on and one the policy refuses.
    const dns = rebinding(v4('127.0.0.2', METADATA));
    const { error, device } = await routed(OTHER, { host: '127.0.0.1' }, dns);
    loggedIn(device);
    assert.ok(error instanceof TargetRefusedError, String(error));
    assert.equal(error.address, METADATA);
    assert.deepEqual(dns.calls, [{ host: OTHER, family: 0 }]);
    assert.equal(onward.connections, 0);
  });

  it('an address-literal device, a set with no bounds: followed, on one lookup for the routed name', async () => {
    reset();
    const dns = rebinding(v4('127.0.0.2'));
    const { error, device } = await routed(OTHER, { host: '127.0.0.1' }, dns);
    loggedIn(device);
    // The onward server hangs up on the login.
    ordinary(error);
    assert.deepEqual(dns.calls, [{ host: OTHER, family: 0 }]);
    assert.equal(onward.connections, 1);
    assert.deepEqual(onward.said, ['packet 0x12', 'login7']);
  });

  it('a named device, a set with no bounds: followed, each name on one lookup', async () => {
    reset();
    const dns = rebinding(v4('127.0.0.1'), v4('127.0.0.2'));
    const { error, device } = await routed(OTHER, {}, dns);
    loggedIn(device);
    ordinary(error);
    assert.deepEqual(dns.calls, [
      { host: NAME, family: 0 },
      { host: OTHER, family: 0 },
    ]);
    assert.deepEqual(onward.said, ['packet 0x12', 'login7']);
  });

  it('a bounded set, a device given as an address inside it: the redirect is a failed check, with nothing sent on', async () => {
    reset();
    for (const to of [OTHER, '127.0.0.2']) {
      const dns = rebinding(v4('127.0.0.2'));
      const { error, device } = await routed(
        to,
        { host: '127.0.0.1', targets: ['127.0.0.1'] },
        dns,
      );
      loggedIn(device);
      // Through the real `tedious`, which wraps what its connector rejects with: the class
      // and the sentence come out as they went in, and it is not a refusal over credentials.
      assert.ok(error instanceof DbRedirectRefusedError, String(error));
      assert.ok(!isCredentialsWithheld(error));
      assert.equal(error.message, REDIRECT_OUTSIDE_TARGETS('127.0.0.1', to));
      assert.match(
        error.message,
        /^127\.0\.0\.1 routed the login to \S+, which is outside the allowed targets of the database credentials this sensor uses, so nothing was sent there\./,
      );
      assert.equal(dns.calls.length, 0, 'a server the set may not reach is not resolved');
    }
    assert.equal(onward.connections, 0);
  });

  it('a bounded set, a device a name entry covers: the redirect is a failed check, with nothing sent on', async () => {
    reset();
    const dns = rebinding(v4('127.0.0.1'), v4('127.0.0.2'));
    const { error, device } = await routed(OTHER, { targets: [NAME] }, dns);
    loggedIn(device);
    assert.ok(error instanceof DbRedirectRefusedError, String(error));
    assert.ok(!isCredentialsWithheld(error));
    assert.equal(error.message, REDIRECT_OUTSIDE_TARGETS(NAME, OTHER));
    assert.deepEqual(dns.calls, [{ host: NAME, family: 0 }]);
    assert.equal(onward.connections, 0);
  });

  it('a pinned set, which the core did leave to the probe: the redirect is withheld, with nothing sent on', async () => {
    reset();
    const dns = rebinding(v4('127.0.0.1'), v4('127.0.0.2'));
    const { error, device } = await routed('127.0.0.2', { targets: INSIDE }, dns);
    loggedIn(device);
    assert.ok(error instanceof CredentialsWithheldError, String(error));
    assert.equal(error.message, PIN_REFUSALS.redirected(NAME, '127.0.0.2'));
    assert.equal(dns.calls.length, 1);
    assert.equal(onward.connections, 0);
  });

  it('a bounded set under `none` is refused all the same', async () => {
    reset();
    const dns = rebinding();
    const { error, device } = await routed(
      '127.0.0.2',
      { host: '127.0.0.1', targets: ['127.0.0.1'], policy: 'none' },
      dns,
    );
    loggedIn(device);
    assert.ok(error instanceof DbRedirectRefusedError, String(error));
    assert.equal(onward.connections, 0);
  });

  it('a bounded set whose targets cover the routed server is sent on to it', async () => {
    reset();
    const dns = rebinding();
    const { error, device } = await routed(
      '127.0.0.2',
      { host: '127.0.0.1', targets: INSIDE },
      dns,
    );
    loggedIn(device);
    ordinary(error);
    assert.deepEqual(onward.said, ['packet 0x12', 'login7']);
    assert.equal(dns.calls.length, 0);
  });

  it('under `none`, a set with no bounds: followed as `tedious` always did, with nothing checked', async () => {
    reset();
    const dns = rebinding(v4(METADATA));
    const { error, device } = await routed('127.0.0.2', { host: '127.0.0.1', policy: 'none' }, dns);
    loggedIn(device);
    ordinary(error);
    assert.deepEqual(onward.said, ['packet 0x12', 'login7']);
    assert.equal(dns.calls.length, 0);
  });
});

describe('a routed server that fails is named, and not the device that routed to it (A-70)', () => {
  /** A loopback port nothing listens on: one that was listened on, and closed. */
  const closedPort = async (): Promise<number> => {
    const { fake } = await listen(() => undefined);
    await fake.close();
    return fake.port;
  };

  for (const policy of ['link-local', 'none'] as const) {
    it(`db.mssql routed to a port nothing listens on, under \`${policy}\``, async () => {
      // Under `none` the connect is `tedious`'s own; otherwise the connector's.
      const closed = await closedPort();
      const device = await tdsServer({ route: { server: '127.0.0.1', port: closed } });
      try {
        const error = await failure(
          execute(dbMssql, rebinding(), { host: '127.0.0.1', port: device.port, policy }),
        );
        assert.deepEqual(device.said, ['packet 0x12', 'login7'], 'the device was reached');
        assert.ok(error instanceof DbError, `threw ${String(error)}`);
        assert.equal(
          error.message,
          `127.0.0.1:${String(device.port)} routed the login to 127.0.0.1:${String(closed)}, ` +
            'where nothing is listening',
        );
      } finally {
        await device.close();
      }
    });
  }

  it('a device nothing listens at is still the device, under `none` too', async () => {
    const closed = await closedPort();
    for (const policy of ['link-local', 'none'] as const) {
      const error = await failure(
        execute(dbMssql, rebinding(), { host: '127.0.0.1', port: closed, policy }),
      );
      assert.equal(error.message, `nothing is listening at 127.0.0.1:${String(closed)}`, policy);
    }
  });

  it('db.mssql routed to a name that does not resolve', async () => {
    const device = await tdsServer({ route: { server: OTHER, port: 11_000 } });
    const calls: string[] = [];
    try {
      const error = await failure(
        execute(
          dbMssql,
          {
            calls: [],
            resolve: (host) => {
              calls.push(host);
              return Promise.reject(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
            },
          },
          { host: '127.0.0.1', port: device.port },
        ),
      );
      assert.deepEqual(device.said, ['packet 0x12', 'login7']);
      assert.ok(error instanceof DbRoutedUnresolvedError, `threw ${String(error)}`);
      assert.equal(
        error.message,
        `127.0.0.1:${String(device.port)} routed the login to replica.policy.invalid, a host ` +
          'name that did not resolve (ENOTFOUND)',
      );
      assert.equal(error.phase, 'connect');
      assert.deepEqual(calls, [OTHER], 'asked once, and only about the routed name');
    } finally {
      await device.close();
    }
  });

  it('the connector says which server it was routed to, whatever went wrong there', async () => {
    const closed = await closedPort();
    const base: DbConnectOptions = {
      host: '127.0.0.1',
      port: 1433,
      database: '',
      username: 'monitor',
      password: 'secret',
      encrypt: 'disable',
      verifyTls: false,
      connectTimeoutMs: 2_000,
      statementTimeoutMs: 2_000,
      redirect: () => Promise.resolve(undefined),
    };
    const connector = tdsConnector(base) ?? assert.fail('no connector');
    const routed = await failure(connector({ host: '127.0.0.1', port: closed }));
    assert.equal((routed as NodeJS.ErrnoException).code, 'ECONNREFUSED');
    assert.equal((routed as { routedTo?: unknown }).routedTo, `127.0.0.1:${String(closed)}`);
    // The device itself carries none.
    const device = tdsConnector({ ...base, port: closed }) ?? assert.fail('no connector');
    const own = await failure(device());
    assert.equal((own as NodeJS.ErrnoException).code, 'ECONNREFUSED');
    assert.equal((own as { routedTo?: unknown }).routedTo, undefined);
  });

  it('reads as the routed server from either source, and as the device where nothing was routed', () => {
    const options: DbConnectOptions = {
      host: NAME,
      port: 1433,
      database: '',
      username: 'monitor',
      password: 'secret',
      encrypt: 'prefer',
      verifyTls: false,
      connectTimeoutMs: 2_000,
      statementTimeoutMs: 2_000,
    };
    const ROUTED = 'replica.policy.invalid:11000';
    /** As the connector hands it over, inside `tedious`'s wrapper. */
    const carried = (code: string): Error =>
      Object.assign(
        new Error('Failed to connect', {
          cause: Object.assign(new Error('socket'), { code, routedTo: ROUTED }),
        }),
        { code: 'ESOCKET' },
      );
    /** As `tedious` words its own connect, with no field for where. */
    const worded = (code: string): Error =>
      Object.assign(
        new Error(
          `Failed to connect to ${ROUTED} (redirected from database.policy.invalid:1433) - x`,
          {
            cause: new AggregateError(
              [Object.assign(new Error('socket'), { code })],
              'Could not connect (sequence)',
            ),
          },
        ),
        { code: 'ESOCKET' },
      );
    const plain = (code: string): Error => Object.assign(new Error('socket'), { code });
    const read = (error: Error): string =>
      describeDbError(error, options, 'Microsoft SQL Server').message;
    const HERE = 'database.policy.invalid:1433';
    for (const from of [carried, worded]) {
      assert.equal(
        read(from('ECONNREFUSED')),
        `${HERE} routed the login to ${ROUTED}, where nothing is listening`,
      );
      for (const code of ['ENOTFOUND', 'EAI_AGAIN']) {
        assert.equal(
          read(from(code)),
          `${HERE} routed the login to ${ROUTED}, a host name that did not resolve`,
          code,
        );
      }
    }
    assert.equal(read(plain('ECONNREFUSED')), `nothing is listening at ${HERE}`);
    assert.equal(
      read(plain('ENOTFOUND')),
      `the device’s host name did not resolve, connecting to ${HERE}`,
    );
    // Once connected there is no redirect to speak of: the query phase names the device.
    assert.equal(
      describeDbError(carried('ECONNREFUSED'), options, 'Microsoft SQL Server', 'query').message,
      `nothing is listening at ${HERE}`,
    );
    const unresolved = new DbRoutedUnresolvedError(HERE, 'replica.policy.invalid', '');
    assert.equal(describeDbError(unresolved, options, 'Microsoft SQL Server'), unresolved);
    assert.equal(
      unresolved.message,
      `${HERE} routed the login to replica.policy.invalid, a host name that did not resolve`,
    );
  });
});

describe('`require` sends no login to a server that says it does not encrypt (A-70)', () => {
  // `tedious` 20 starts TLS only when the server's PRELOGIN answer says ON or REQ
  // (`lib/connection.js`, `performTlsNegotiation`); for anything else it starts none, raises
  // nothing and sends LOGIN7. That answer is clear text, so whoever is on the path chooses it.
  const RUNS = [
    { name: 'a device given as an address', run: { host: '127.0.0.1' } },
    { name: 'a named device', run: {} },
    {
      name: 'under `none`, where nothing else is checked',
      run: { host: '127.0.0.1', policy: 'none' },
    },
  ] as const;

  for (const { name, run } of RUNS) {
    for (const [said, encryption] of [
      ['NOT_SUP', 0x02],
      ['OFF', 0x00],
      // A value `tedious` has no name for, which it also logs in to in clear.
      ['a value that is none of the four', 0x04],
    ] as const) {
      it(`db.mssql, ${name}, answered ${said}: refused before LOGIN7, verification on or off`, async () => {
        for (const verifyTls of [true, false]) {
          const fake = await tdsServer({ login: true, encryption });
          try {
            const error = await failure(
              execute(dbMssql, rebinding(), {
                ...run,
                port: fake.port,
                params: { encrypt: 'require', verifyTls },
              }),
            );
            assert.deepEqual(fake.said, ['packet 0x12'], 'no login left the probe');
            assert.ok(error instanceof DbEncryptionRefusedError, String(error));
            assert.equal(error.phase, 'connect');
          } finally {
            await fake.close();
          }
        }
      });
    }

    it(`db.mssql, ${name}, under \`prefer\`: logs in without encryption, as it always did`, async () => {
      const fake = await tdsServer({ login: true });
      try {
        const error = await failure(
          execute(dbMssql, rebinding(), { ...run, port: fake.port, params: { encrypt: 'prefer' } }),
        );
        assert.ok(!(error instanceof DbEncryptionRefusedError), String(error));
        assert.deepEqual(fake.said, ['packet 0x12', 'login7']);
      } finally {
        await fake.close();
      }
    });
  }

  it('db.mssql under `require` and `none` still follows a redirect, as `tedious` would', async () => {
    // The connector is handed over for the encryption check alone here. It has no redirect to
    // ask about and no lookup, and connects where it is routed as the driver itself did.
    const connector =
      tdsConnector({
        host: '127.0.0.1',
        port: 1433,
        database: '',
        username: 'monitor',
        password: 'secret',
        encrypt: 'require',
        verifyTls: false,
        connectTimeoutMs: 2_000,
        statementTimeoutMs: 2_000,
      }) ?? assert.fail('no connector under `require`');
    const onward = await tdsServer({ login: true, address: '127.0.0.2' });
    try {
      const socket = await connector({ host: '127.0.0.2', port: onward.port });
      assert.equal(socket.remoteAddress, '127.0.0.2');
      socket.destroy();
    } finally {
      await onward.close();
    }
  });

  it('a server that never finishes its answer is refused at a bound, not read for ever', async () => {
    // Two packets of 40,000 bytes, neither the last of its message: more than any PRELOGIN
    // answer is, and still not one.
    const { fake } = await listen((socket) => {
      const packet = Buffer.alloc(40_000);
      packet.writeUInt8(0x04, 0);
      packet.writeUInt16BE(40_000, 2);
      socket.write(Buffer.concat([packet, packet]));
    });
    try {
      const connector =
        tdsConnector({
          host: '127.0.0.1',
          port: fake.port,
          database: '',
          username: 'monitor',
          password: 'secret',
          encrypt: 'require',
          verifyTls: true,
          connectTimeoutMs: 2_000,
          statementTimeoutMs: 2_000,
        }) ?? assert.fail('no connector under `require`');
      const socket = await connector();
      // Handed over paused, so that `tedious` and the guard read from the same first byte.
      assert.equal(socket.isPaused(), true, 'nothing is read before `tedious` reads it');
      // As `tedious` does when it pipes the socket into its reader.
      queueMicrotask(() => socket.resume());
      const ended = await Promise.race([
        new Promise<unknown>((resolve) => socket.once('error', resolve)),
        new Promise<unknown>((resolve) => setTimeout(resolve, 3_000, 'still reading')),
      ]);
      socket.destroy();
      assert.ok(ended instanceof DbEncryptionRefusedError, String(ended));
    } finally {
      await fake.close();
    }
  });

  it('the other two engines refuse it too: the sentence in the schema is true of all three', async () => {
    for (const [type, server] of [
      [dbPostgresql, postgresServer],
      [dbMysql, mysqlServer],
    ] as const) {
      const fake = await server();
      try {
        const error = await failure(
          execute(type, rebinding(), { port: fake.port, params: { encrypt: 'require' } }),
        );
        assert.match(error.message, /SSL|secure|encrypt/i, type.id);
        assert.deepEqual(fake.said, [], `${type.id}: no query was sent in clear text`);
      } finally {
        await fake.close();
      }
    }
  });

  describe('the guard and `tedious` read one answer alike, or the answer is refused', () => {
    /** A PRELOGIN payload: the option table, its terminator unless told otherwise, the data. */
    const payload = (
      options: readonly (readonly [token: number, offset: number, size: number])[],
      data: readonly number[],
      terminator = true,
    ): Buffer =>
      Buffer.concat([
        ...options.map(([token, offset, size]) => {
          const option = Buffer.alloc(5);
          option.writeUInt8(token, 0);
          option.writeUInt16BE(offset, 1);
          option.writeUInt16BE(size, 3);
          return option;
        }),
        Buffer.from(terminator ? [0xff] : []),
        Buffer.from(data),
      ]);
    const ON = 0x01;
    const NOT_SUP = 0x02;
    const OFF = 0x00;
    /** VERSION, then two ENCRYPTION options: `tedious` believes the second. */
    const twice = (first: number, second: number): Buffer =>
      tdsReply(
        payload(
          [
            [0x00, 16, 6],
            [0x01, 22, 1],
            [0x01, 23, 1],
          ],
          [0x0f, 0, 0, 0, 0, 0, first, second],
        ),
      );
    const required = (fake: Fake): Promise<Error> =>
      failure(
        execute(dbMssql, rebinding(), {
          host: '127.0.0.1',
          port: fake.port,
          params: { encrypt: 'require', verifyTls: true },
        }),
      );

    for (const [name, second] of [
      ['NOT_SUP', NOT_SUP],
      ['OFF', OFF],
    ] as const) {
      it(`an answer that says ON and then ${name}: \`tedious\` believes the second, and no login is sent`, async () => {
        const fake = await tdsServer({ login: true, answer: twice(ON, second) });
        try {
          const error = await required(fake);
          assert.deepEqual(fake.said, ['packet 0x12'], 'no login left the probe');
          assert.ok(error instanceof DbEncryptionRefusedError, String(error));
        } finally {
          await fake.close();
        }
      });
    }

    it('an answer that names encryption twice is refused whichever way round, and whatever both say', async () => {
      for (const [first, second] of [
        [NOT_SUP, ON],
        [ON, ON],
      ] as const) {
        assert.equal(preloginEncryption(twice(first, second)), undefined);
        const fake = await tdsServer({ login: true, answer: twice(first, second) });
        try {
          const error = await required(fake);
          assert.deepEqual(fake.said, ['packet 0x12']);
          assert.ok(error instanceof DbEncryptionRefusedError, String(error));
        } finally {
          await fake.close();
        }
      }
    });

    it('an answer sent before anything was asked is read by both, and the later one by neither', async () => {
      // ON the moment the connection is accepted, NOT_SUP when the PRELOGIN arrives. Were the
      // early bytes to reach the guard alone, it would pass on ON and `tedious` log in on
      // NOT_SUP. Both read ON: `tedious` starts TLS, and what follows is its hello.
      const fake = await tdsServer({ login: true, early: preloginReply(ON) });
      try {
        await required(fake);
        assert.equal(fake.said.includes('login7'), false, 'no login in clear');
        assert.deepEqual(fake.said, ['packet 0x12', 'packet 0x12'], 'a PRELOGIN, then a TLS hello');
      } finally {
        await fake.close();
      }
    });

    it('a second message behind the answer is not the answer, to either', async () => {
      const both = Buffer.concat([preloginReply(ON), preloginReply(NOT_SUP)]);
      assert.equal(preloginEncryption(both), ON);
      const fake = await tdsServer({ login: true, answer: both });
      try {
        await required(fake);
        // `tedious` starts TLS on the first, and takes the second for the handshake's answer.
        assert.equal(fake.said[0], 'packet 0x12');
        assert.deepEqual(
          fake.said.filter((one) => one !== 'packet 0x12'),
          [],
          'no login in clear',
        );
      } finally {
        await fake.close();
      }
    });

    it('refuses every answer the two readers could take differently', () => {
      const good = payload(
        [
          [0x00, 11, 6],
          [0x01, 17, 1],
        ],
        [0x0f, 0, 0, 0, 0, 0, ON],
      );
      assert.equal(preloginEncryption(tdsReply(good)), ON, 'the control');
      const refused: readonly (readonly [string, Buffer])[] = [
        ['no terminator: the table runs into the data', payload([[0x01, 5, 1]], [ON], false)],
        ['no terminator and no data', payload([[0x01, 5, 1]], [], false)],
        ['an empty payload', Buffer.alloc(0)],
        ['half an option', Buffer.from([0x01, 0x00])],
        ['no encryption named', payload([[0x00, 6, 6]], [0x0f, 0, 0, 0, 0, 0])],
        ['an encryption of no length', payload([[0x01, 6, 0]], [ON])],
        ['an encryption of two bytes', payload([[0x01, 6, 2]], [ON, ON])],
        ['an encryption that points into the option table', payload([[0x01, 0, 1]], [ON])],
        ['an encryption that points at the terminator', payload([[0x01, 5, 1]], [ON])],
        ['an encryption that points past the end', payload([[0x01, 7, 1]], [ON])],
        [
          'another option that points past the end',
          payload(
            [
              [0x01, 11, 1],
              [0x04, 40, 1],
            ],
            [ON],
          ),
        ],
        [
          'a version `tedious` reads six bytes of, with two there',
          payload(
            [
              [0x01, 11, 1],
              [0x00, 12, 1],
            ],
            [ON, 0x0f, 0],
          ),
        ],
        [
          'a thread id `tedious` reads four bytes of, with one there',
          payload(
            [
              [0x01, 11, 1],
              [0x03, 12, 1],
            ],
            [ON, 0x07],
          ),
        ],
        [
          'an option that declares more bytes than there are, where `tedious` would read one',
          payload(
            [
              [0x01, 11, 1],
              [0x04, 11, 200],
            ],
            [ON],
          ),
        ],
        [
          'an option of a kind nobody knows that points past the end',
          payload(
            [
              [0x01, 11, 1],
              [0x77, 90, 4],
            ],
            [ON],
          ),
        ],
      ];
      for (const [name, body] of refused) {
        assert.equal(preloginEncryption(tdsReply(body)), undefined, name);
      }
      // The packet's own type: anything but a tabular result.
      for (const type of [0x12, 0x10, 0x01, 0x00]) {
        const other = tdsReply(good);
        other.writeUInt8(type, 0);
        assert.equal(preloginEncryption(other), undefined, `type 0x${type.toString(16)}`);
      }
      // A packet shorter than its own header, which `tedious` ends the connection on: here
      // one of four bytes, with a whole answer saying ON four bytes in.
      const short = Buffer.concat([Buffer.from([0x04, 0x00, 0x00, 0x04]), tdsReply(good)]);
      assert.equal(preloginEncryption(short), undefined, 'a packet of four bytes');
      // And of a later packet of the same message.
      const first = tdsReply(good.subarray(0, 5));
      first.writeUInt8(0x00, 1);
      const second = tdsReply(good.subarray(5));
      assert.equal(preloginEncryption(Buffer.concat([first, second])), ON);
      second.writeUInt8(0x12, 0);
      assert.equal(preloginEncryption(Buffer.concat([first, second])), undefined);
    });

    it('whenever it accepts an answer, `tedious`’s own parser reads ON or REQ from the same bytes', () => {
      // The parser `tedious` runs, from the installed package: `lib/prelogin-payload.js`.
      const load = createRequire(import.meta.url);
      const PreloginPayload = load('tedious/lib/prelogin-payload.js') as new (data: Buffer) => {
        encryption?: number;
        encryptionString?: string;
      };
      // A fixed sequence, so that a failure is the same failure every run.
      let state = 0x2f6e2b1;
      const next = (below: number): number => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return Math.floor((state / 0x1_0000_0000) * below);
      };
      const pick = <T>(from: readonly T[]): T => from[next(from.length)] as T;
      const TOKENS = [0x00, 0x01, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x77];
      const need = (token: number): number => (token === 0x00 ? 6 : token === 0x03 ? 4 : 1);

      /** A table laid out as a server lays one out, then damaged in up to three places. */
      const generated = (): Buffer => {
        const tokens = Array.from({ length: next(5) }, () => pick(TOKENS));
        // Most have exactly one ENCRYPTION, which is the only kind that can be accepted.
        if (next(4) !== 0 && !tokens.includes(0x01))
          tokens.splice(next(tokens.length + 1), 0, 0x01);
        let at = tokens.length * 5 + 1;
        const options: [number, number, number][] = [];
        const data: number[] = [];
        for (const token of tokens) {
          const size = need(token);
          options.push([token, at, size]);
          for (let index = 0; index < size; index += 1)
            data.push(pick([0, 1, 1, 2, 3, 3, 4, 0xff]));
          at += size;
        }
        const body = payload(options, data, next(12) !== 0);
        for (let damage = next(4); damage > 0 && body.length > 0; damage -= 1) {
          body.writeUInt8(pick([0, 1, 2, 3, 5, 6, 11, 0xff, next(256)]), next(body.length));
        }
        return body;
      };

      let accepted = 0;
      let refusedCount = 0;
      const values = new Set<number>();
      for (let round = 0; round < 40_000; round += 1) {
        const body = generated();
        const verdict = preloginEncryption(tdsReply(body));
        assert.notEqual(verdict, 'incomplete');
        if (verdict !== 0x01 && verdict !== 0x03) {
          refusedCount += 1;
          continue;
        }
        accepted += 1;
        values.add(verdict);
        const hex = body.toString('hex');
        let read: { encryption?: number; encryptionString?: string };
        try {
          read = new PreloginPayload(body);
        } catch (error: unknown) {
          return assert.fail(`accepted ${hex}, which tedious cannot parse: ${String(error)}`);
        }
        assert.equal(read.encryption, verdict, hex);
        assert.ok(read.encryptionString === 'ON' || read.encryptionString === 'REQ', hex);
      }
      // Not vacuous: thousands of each, both values, and the damaged ones mostly refused.
      assert.ok(accepted > 2_000, `accepted ${String(accepted)}`);
      assert.ok(refusedCount > 2_000, `refused ${String(refusedCount)}`);
      assert.deepEqual([...values].sort(), [0x01, 0x03]);
    });
  });

  describe('reading the encryption a PRELOGIN answer names', () => {
    const answer = (encryption: number): Buffer => preloginReply(encryption);

    it('reads the byte the ENCRYPTION option points at', () => {
      for (const encryption of [0x00, 0x01, 0x02, 0x03]) {
        assert.equal(preloginEncryption(answer(encryption)), encryption);
      }
    });

    it('waits for the whole message, however it arrives', () => {
      const whole = answer(0x02);
      for (let cut = 0; cut < whole.length; cut += 1) {
        assert.equal(preloginEncryption(whole.subarray(0, cut)), 'incomplete', String(cut));
      }
    });

    it('reads a message sent in two packets, and one with the options in another order', () => {
      const whole = answer(0x03);
      const body = whole.subarray(8);
      const packet = (status: number, part: Buffer): Buffer => {
        const header = Buffer.from([0x04, status, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00]);
        header.writeUInt16BE(8 + part.length, 2);
        return Buffer.concat([header, part]);
      };
      const split = Buffer.concat([
        packet(0x00, body.subarray(0, 7)),
        packet(0x01, body.subarray(7)),
      ]);
      assert.equal(preloginEncryption(split), 0x03);
      assert.equal(preloginEncryption(split.subarray(0, 20)), 'incomplete');
      // ENCRYPTION first, at offset 11 for one byte; VERSION after it, at 12 for six.
      const reordered = packet(
        0x01,
        Buffer.concat([
          Buffer.from([0x01, 0x00, 0x0b, 0x00, 0x01, 0x00, 0x00, 0x0c, 0x00, 0x06, 0xff]),
          Buffer.from([0x02, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00]),
        ]),
      );
      assert.equal(preloginEncryption(reordered), 0x02);
    });

    it('says so when the answer names no encryption at all, or points outside itself', () => {
      const none = Buffer.from([
        0x04, 0x01, 0x00, 0x0f, 0, 0, 1, 0, 0x00, 0x00, 0x06, 0x00, 0x01, 0xff, 0x09,
      ]);
      assert.equal(preloginEncryption(none), undefined);
      const outside = Buffer.from([
        0x04, 0x01, 0x00, 0x0e, 0, 0, 1, 0, 0x01, 0x00, 0x40, 0x00, 0x01, 0xff,
      ]);
      assert.equal(preloginEncryption(outside), undefined);
    });
  });
});

describe('the connector `tedious` is handed', () => {
  let fake: Fake;
  before(async () => {
    fake = (await listen(() => undefined)).fake;
  });
  after(async () => {
    await fake.close();
  });

  const to =
    (address: string): LookupFunction =>
    (_name, options, done) => {
      if (options.all === true) done(null, [{ address, family: 4 }]);
      else done(null, address, 4);
    };
  const options = (over: Partial<DbConnectOptions> = {}): DbConnectOptions => ({
    host: NAME,
    port: fake.port,
    database: '',
    username: 'monitor',
    password: 'secret',
    encrypt: 'disable',
    verifyTls: false,
    connectTimeoutMs: 2_000,
    statementTimeoutMs: 2_000,
    lookup: to('127.0.0.1'),
    ...over,
  });

  it('is none only where nothing is checked: no lookup, no redirect to ask about, and no encryption to require', () => {
    const { lookup: _lookup, ...plain } = options();
    assert.equal(tdsConnector(plain), undefined);
    assert.equal(tdsConnector({ ...plain, encrypt: 'prefer' }), undefined);
    assert.notEqual(tdsConnector({ ...plain, encrypt: 'require' }), undefined);
  });

  it('for a device given as an address: connects to it as it stands, and asks about a redirect', async () => {
    const asked: string[] = [];
    const { lookup: _lookup, ...plain } = options({
      host: '127.0.0.1',
      redirect: (host) => {
        asked.push(host);
        return Promise.reject(new Error('not there'));
      },
    });
    const connector = tdsConnector(plain) ?? assert.fail('no connector for an address');
    fake.connections = 0;
    const socket = await connector({ host: '127.0.0.1', port: fake.port });
    assert.equal(socket.remotePort, fake.port);
    socket.destroy();
    assert.deepEqual(asked, []);
    await assert.rejects(connector({ host: OTHER, port: fake.port }), /not there/);
    assert.deepEqual(asked, [OTHER]);
    assert.equal(fake.connections, 1);
  });

  it('connects to the device through the checked lookup, however it is asked', async () => {
    const connector = tdsConnector(options()) ?? assert.fail('no connector');
    fake.connections = 0;
    // As its typings say it is called, and as `tedious` 20 calls it.
    const typed = await connector();
    const called = await connector({ host: NAME, port: fake.port }, () => undefined, undefined);
    for (const socket of [typed, called]) {
      assert.equal(socket.remoteAddress, '127.0.0.1');
      assert.equal(socket.remotePort, fake.port);
      socket.destroy();
    }
    assert.equal(fake.connections, 2);
  });

  it('asks before following a redirect, and connects where the answer says', async () => {
    const asked: string[] = [];
    const elsewhere = await listen(() => undefined);
    try {
      const connector =
        tdsConnector(
          options({
            redirect: (host) => {
              asked.push(host);
              return Promise.resolve(to('127.0.0.1'));
            },
          }),
        ) ?? assert.fail('no connector');
      const socket = await connector({ host: OTHER, port: elsewhere.fake.port });
      assert.deepEqual(asked, [OTHER]);
      assert.equal(socket.remotePort, elsewhere.fake.port);
      socket.destroy();
    } finally {
      await elsewhere.fake.close();
    }
  });

  it('does not follow a redirect that is refused, or one nobody can check', async () => {
    const refusal = new CredentialsWithheldError(PIN_REFUSALS.redirected(NAME, OTHER), {
      target: NAME,
      phase: 'connect',
    });
    fake.connections = 0;
    const refusing =
      tdsConnector(options({ redirect: () => Promise.reject(refusal) })) ??
      assert.fail('no connector');
    assert.equal(await failure(refusing({ host: OTHER, port: fake.port })), refusal);
    const unable = tdsConnector(options()) ?? assert.fail('no connector');
    await assert.rejects(
      unable({ host: OTHER, port: fake.port }),
      /redirected the connection to replica\.policy\.invalid, which nothing has checked/,
    );
    assert.equal(fake.connections, 0);
  });

  it('refuses a far end that is not the pinned address', async () => {
    const connector =
      tdsConnector(options({ pinned: { address: '127.0.0.2', family: 4 } })) ??
      assert.fail('no connector');
    const error = await failure(connector());
    assert.ok(error instanceof CredentialsWithheldError, error.message);
    assert.equal(error.message, PIN_REFUSALS.otherPeer(NAME, '127.0.0.2', '127.0.0.1'));
    const held =
      tdsConnector(options({ pinned: { address: '127.0.0.1', family: 4 } })) ??
      assert.fail('no connector');
    (await held()).destroy();
  });

  it('ends when the driver’s signal does, and says nothing is listening when nothing is', async () => {
    const connector = tdsConnector(options()) ?? assert.fail('no connector');
    const reason = new Error('the driver gave up');
    assert.equal(
      await failure(
        connector({ host: NAME, port: fake.port }, undefined, AbortSignal.abort(reason)),
      ),
      reason,
    );
    const closed = await listen(() => undefined);
    await closed.fake.close();
    const dead = tdsConnector(options({ port: closed.fake.port })) ?? assert.fail('no connector');
    const error = await failure(dead());
    assert.equal((error as NodeJS.ErrnoException).code, 'ECONNREFUSED');
  });
});

describe('the sockets `pg` and `mysql2` are handed', () => {
  let fake: Fake;
  before(async () => {
    fake = (await listen(() => undefined)).fake;
  });
  after(async () => {
    await fake.close();
  });
  const loopback: LookupFunction = (_name, options, done) => {
    if (options.all === true) done(null, [{ address: '127.0.0.1', family: 4 }]);
    else done(null, '127.0.0.1', 4);
  };
  const options = (over: Partial<DbConnectOptions> = {}): DbConnectOptions => ({
    host: NAME,
    port: fake.port,
    database: '',
    username: 'monitor',
    password: 'secret',
    encrypt: 'disable',
    verifyTls: false,
    connectTimeoutMs: 2_000,
    statementTimeoutMs: 2_000,
    lookup: loopback,
    ...over,
  });
  /** How a socket's connection ended: connected, or the error that ended it. */
  const outcome = (socket: Socket): Promise<Error | 'connected'> =>
    new Promise((resolve) => {
      socket.once('error', resolve);
      // After the listeners the socket was made with, which is where a refusal ends it.
      socket.once('connect', () => {
        setImmediate(() => {
          if (!socket.destroyed) resolve('connected');
        });
      });
    });

  it('are none for a device the driver connects to as it always has', () => {
    const { lookup: _lookup, ...plain } = options();
    assert.equal(unconnectedSocket(plain), undefined);
    assert.equal(connectingSocket(plain), undefined);
  });

  it('`pg`’s connects to the device when `pg` calls connect, wherever it says to', async () => {
    const socket = (unconnectedSocket(options()) ?? assert.fail('no socket'))();
    assert.equal(socket.connecting, false, 'not before the driver says');
    // `pg` calls `connect(port, host)`; a port and host that are not the device's are not
    // where it goes.
    (socket.connect as (port: number, host: string) => Socket)(1, '127.0.0.9');
    assert.equal(await outcome(socket), 'connected');
    assert.equal(socket.remotePort, fake.port);
    socket.destroy();
  });

  it('`mysql2`’s is already connecting to the device', async () => {
    const socket = (connectingSocket(options()) ?? assert.fail('no socket'))();
    assert.equal(socket.connecting, true);
    assert.equal(await outcome(socket), 'connected');
    assert.equal(socket.remotePort, fake.port);
    socket.destroy();
  });

  it('each ends a connection whose far end is not the pinned address, before the driver speaks', async () => {
    const elsewhere = options({ pinned: { address: '127.0.0.2', family: 4 } });
    const expected = PIN_REFUSALS.otherPeer(NAME, '127.0.0.2', '127.0.0.1');
    const forPg = (unconnectedSocket(elsewhere) ?? assert.fail('no socket'))();
    forPg.connect(fake.port, NAME);
    const forMysql = (connectingSocket(elsewhere) ?? assert.fail('no socket'))();
    for (const socket of [forPg, forMysql]) {
      const ended = await outcome(socket);
      assert.ok(ended instanceof CredentialsWithheldError, String(ended));
      assert.equal(ended.message, expected);
      assert.equal(socket.destroyed, true);
    }
    // And leaves one that is where the set was checked.
    const held = options({ pinned: { address: '127.0.0.1', family: 4 } });
    const kept = (connectingSocket(held) ?? assert.fail('no socket'))();
    assert.equal(await outcome(kept), 'connected');
    kept.destroy();
  });
});

describe('what a database failure reads as', () => {
  const options: DbConnectOptions = {
    host: NAME,
    port: 1433,
    database: '',
    username: 'monitor',
    password: 'secret',
    encrypt: 'prefer',
    verifyTls: false,
    connectTimeoutMs: 2_000,
    statementTimeoutMs: 2_000,
  };

  it('a refusal keeps its class through a driver that wraps it', () => {
    const withheld = new CredentialsWithheldError('Not scanned: …', {
      target: NAME,
      phase: 'connect',
    });
    const refusedTarget = new TargetRefusedError('refusing …', {
      target: NAME,
      address: METADATA,
      policy: 'link-local',
    });
    for (const refusal of [withheld, refusedTarget]) {
      assert.equal(describeDbError(refusal, options, 'PostgreSQL'), refusal);
      const wrapped = Object.assign(new Error('Failed to connect', { cause: refusal }), {
        code: 'ESOCKET',
      });
      assert.equal(describeDbError(wrapped, options, 'Microsoft SQL Server'), refusal);
    }
  });

  it('a socket’s error inside a driver’s is read for what it is', () => {
    const wrap = (code: string): Error =>
      Object.assign(
        new Error('Failed to connect', {
          cause: Object.assign(new Error('socket'), { code }),
        }),
        { code: 'ESOCKET' },
      );
    assert.match(
      describeDbError(wrap('ECONNREFUSED'), options, 'Microsoft SQL Server').message,
      /^nothing is listening at database\.policy\.invalid:1433$/,
    );
    assert.match(
      describeDbError(wrap('ETIMEDOUT'), options, 'Microsoft SQL Server').message,
      /accepted no connection within 2000 ms/,
    );
    // A code of the driver's own is still the driver's.
    assert.match(
      describeDbError(Object.assign(new Error('nope'), { code: '28P01' }), options, 'PostgreSQL')
        .message,
      /refused the credential for “monitor”/,
    );
  });

  it('a server that would not encrypt keeps its class through a driver (A-70)', () => {
    const refusal = new DbEncryptionRefusedError('database.policy.invalid:1433');
    assert.equal(describeDbError(refusal, options, 'Microsoft SQL Server'), refusal);
    const wrapped = Object.assign(new Error('Connection lost', { cause: refusal }), {
      code: 'ESOCKET',
    });
    assert.equal(describeDbError(wrapped, options, 'Microsoft SQL Server'), refusal);
    assert.equal(refusal.phase, 'connect');
    assert.match(
      refusal.message,
      /^database\.policy\.invalid:1433 answered that it does not encrypt, and this sensor requires encryption, so no login was sent\./,
    );
  });

  it('a redirect that was not followed keeps its class and its sentence through a driver (A-70)', () => {
    const redirect = new DbRedirectRefusedError(NAME, OTHER);
    assert.equal(describeDbError(redirect, options, 'Microsoft SQL Server'), redirect);
    const wrapped = Object.assign(new Error('Failed to connect', { cause: redirect }), {
      code: 'ESOCKET',
    });
    assert.equal(describeDbError(wrapped, options, 'Microsoft SQL Server'), redirect);
    // The sentence, written out: it names the device and then where the login was sent.
    assert.equal(
      redirect.message,
      'database.policy.invalid routed the login to replica.policy.invalid, which is outside ' +
        'the allowed targets of the database credentials this sensor uses, so nothing was ' +
        'sent there. Adding that server to the targets by its address, its name or *.domain, ' +
        'or giving the device the server that answers, lets the login through.',
    );
    assert.deepEqual([redirect.target, redirect.routedTo], [NAME, OTHER]);
    assert.equal(redirect.phase, 'connect');
    assert.ok(redirect instanceof DbError);
    assert.ok(!isCredentialsWithheld(redirect));
  });

  describe('every driver’s connect timeout is the one sentence, in the connect phase (A-70)', () => {
    const SENTENCE =
      'database.policy.invalid:1433 accepted no connection within 2000 ms — a firewall ' +
      'dropping the packets looks exactly like this';
    const timedOut = (error: unknown, engine: string): void => {
      const described = describeDbError(error, options, engine);
      assert.ok(described instanceof DbError, engine);
      assert.equal(described.message, SENTENCE, engine);
      assert.equal(described.phase, 'connect', engine);
    };

    it('a socket’s ETIMEDOUT, as before', () => {
      timedOut(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }), 'MySQL');
      timedOut(Object.assign(new Error('socket'), { code: 'ESOCKETTIMEDOUT' }), 'MySQL');
    });

    it('a socket that times out mid-query was connected: it says so, in the query phase', () => {
      for (const code of ['ETIMEDOUT', 'ESOCKETTIMEDOUT']) {
        const described = describeDbError(
          Object.assign(new Error('read ETIMEDOUT'), { code }),
          options,
          'MySQL',
          'query',
        );
        assert.ok(described instanceof DbError, code);
        assert.equal(
          described.message,
          'MySQL at database.policy.invalid:1433: the connection was made and the query got ' +
            'no answer before the socket timed out — the server stopped answering, or ' +
            'something between dropped the connection without closing it',
          code,
        );
        assert.equal(described.phase, 'query', code);
      }
    });

    it('names the server a login was routed to, and that it was routed, when that is the one that did not answer', () => {
      const ROUTED =
        'database.policy.invalid:1433 routed the login to replica.policy.invalid:11000, which ' +
        'accepted no connection within 2000 ms — a firewall dropping the packets looks exactly ' +
        'like this';
      // `tedious`'s own timer, which says it in words and has no field for it.
      const timer = Object.assign(
        new Error(
          'Failed to connect to replica.policy.invalid:11000 (redirected from ' +
            'database.policy.invalid:1433) in 2000ms',
        ),
        { code: 'ETIMEOUT' },
      );
      // And the connector's, wrapped by `tedious` as a socket error.
      const connector = Object.assign(
        new Error('Failed to connect', {
          cause: Object.assign(new Error('connect to replica.policy.invalid:11000 timed out'), {
            code: 'ETIMEDOUT',
            routedTo: 'replica.policy.invalid:11000',
          }),
        }),
        { code: 'ESOCKET' },
      );
      for (const error of [timer, connector]) {
        const described = describeDbError(error, options, 'Microsoft SQL Server');
        assert.ok(described instanceof DbError);
        assert.equal(described.message, ROUTED);
        assert.equal(described.phase, 'connect');
      }
      // Not routed: the device itself, in `tedious`'s words.
      timedOut(
        Object.assign(new Error('Failed to connect to database.policy.invalid:1433 in 2000ms'), {
          code: 'ETIMEOUT',
        }),
        'Microsoft SQL Server',
      );
    });

    it('`pg`’s “timeout expired”, which has no code', () => {
      timedOut(new Error('timeout expired'), 'PostgreSQL');
    });

    it('`tedious`’s ETIMEOUT, one letter short of the socket’s', () => {
      timedOut(
        Object.assign(new Error('Failed to connect to database.policy.invalid:1433 in 2000ms'), {
          code: 'ETIMEOUT',
        }),
        'Microsoft SQL Server',
      );
    });

    it('only those: another message with no code, and another code, are the driver’s own words', () => {
      assert.equal(
        describeDbError(new Error('timeout expired while idle'), options, 'PostgreSQL').message,
        'PostgreSQL at database.policy.invalid:1433: timeout expired while idle',
      );
      assert.equal(
        describeDbError(
          Object.assign(new Error('timeout expired'), { code: '57P01' }),
          options,
          'PostgreSQL',
        ).message,
        'PostgreSQL at database.policy.invalid:1433: timeout expired',
      );
    });

    it('and only while connecting: a request `tedious` timed out is not a connection refused', () => {
      const request = Object.assign(new Error('Timeout: Request failed to complete in 2000ms'), {
        code: 'ETIMEOUT',
      });
      const described = describeDbError(request, options, 'Microsoft SQL Server', 'query');
      assert.doesNotMatch(described.message, /accepted no connection/);
      assert.equal(
        describeDbError(new Error('timeout expired'), options, 'PostgreSQL', 'query').message,
        'PostgreSQL at database.policy.invalid:1433: timeout expired',
      );
    });
  });

  it('a driver that cannot check an IPv6 address says that, and not that the certificate is wrong (A-70)', () => {
    const altname = (): Error =>
      Object.assign(new Error('Hostname/IP does not match certificate’s altnames'), {
        code: 'ERR_TLS_CERT_ALTNAME_INVALID',
      });
    const at = (host: string): DbConnectOptions => ({ ...options, host });
    for (const engine of ['MySQL', 'Microsoft SQL Server']) {
      const described = describeDbError(altname(), at('::1'), engine);
      assert.match(described.message, /could not be checked against an IPv6 address/, engine);
      assert.match(described.message, /this driver cannot verify one/, engine);
      // An IPv4 address and a name are checked, so theirs is the certificate's own failure.
      for (const host of ['127.0.0.1', NAME]) {
        assert.doesNotMatch(
          describeDbError(altname(), at(host), engine).message,
          /could not be checked/,
          `${engine} ${host}`,
        );
      }
    }
    // PostgreSQL is handed the shared check, which reads an IPv6 address.
    assert.doesNotMatch(
      describeDbError(altname(), at('::1'), 'PostgreSQL').message,
      /could not be checked/,
    );
  });
});

describe('alarm volume: database sensors on a named device that resolves to a link-local address', () => {
  // The intended change, and what it costs: each such sensor fails its scan, once, as an
  // ordinary failed check. Not withheld, nothing sent, one lookup each, and `none` is the way
  // back.
  it('each reads Down once a scan, by the ordinary path, and `none` scans them again', async () => {
    const fake = await postgresServer();
    try {
      const types = [dbPostgresql, dbMysql, dbMssql];
      for (let scan = 0; scan < 2; scan += 1) {
        for (const type of types) {
          const dns = rebinding(v4('169.254.10.20'));
          const error = await refused(execute(type, dns, { port: fake.port }));
          assert.equal(error.address, '169.254.10.20');
          assert.equal(error.policy, 'link-local');
          assert.ok(!isCredentialsWithheld(error), 'a failed check, not a withheld one');
          assert.equal(dns.calls.length, 1);
        }
      }
      assert.equal(fake.connections, 0);
      // Under `none` the guard is out of the way: no lookup of its own, no refusal.
      const dns = rebinding(v4('169.254.10.20'));
      const error = await failure(execute(dbPostgresql, dns, { port: fake.port, policy: 'none' }));
      assert.ok(!(error instanceof TargetRefusedError));
      assert.equal(dns.calls.length, 0);
    } finally {
      await fake.close();
    }
  });
});
