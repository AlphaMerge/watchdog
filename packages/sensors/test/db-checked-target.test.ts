import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
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
  DbError,
  describeDbError,
  type DbConnectOptions,
  type DbDriver,
} from '../src/support/db/driver.js';
import { mssqlDriver } from '../src/support/db/mssql.js';
import { mysqlDriver } from '../src/support/db/mysql.js';
import { postgresqlDriver } from '../src/support/db/postgresql.js';
import {
  connectBudgetMs,
  connectingSocket,
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
const setTrusted = (tls as { setDefaultCACertificates?: (certs: string[]) => void })
  .setDefaultCACertificates;
const getTrusted = (tls as { getCACertificates?: (type: string) => string[] }).getCACertificates;
let trustedBefore: string[] | undefined;

function certificate(file: string, name: string): { key: string; cert: string } {
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
      `subjectAltName=DNS:${name}`,
    ],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8') };
}

before(() => {
  try {
    dir = mkdtempSync(join(tmpdir(), 'ms-db-checked-'));
    forName = certificate('name', NAME);
    forAnother = certificate('another', 'another.policy.invalid');
  } catch {
    forName = undefined;
    forAnother = undefined;
  }
  // Both trusted, so that what a verifying client refuses is the *name* on one of them.
  if (
    forName !== undefined &&
    forAnother !== undefined &&
    setTrusted !== undefined &&
    getTrusted !== undefined
  ) {
    trustedBefore = getTrusted('default');
    setTrusted([...trustedBefore, forName.cert, forAnother.cert]);
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
async function postgresServer(certificate?: Certificate): Promise<Fake> {
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
  });
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
async function mysqlServer(certificate?: Certificate): Promise<Fake> {
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
  });
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
 * `said` has `login7` for each login a server was sent, which is where the password is.
 */
async function tdsServer(
  mode: { route?: { server: string; port: number }; login?: true; address?: string } = {},
): Promise<Fake> {
  const plain = mode.route !== undefined || mode.login === true;
  const { fake } = await listen((socket, self) => {
    let pending = Buffer.alloc(0);
    let packets = 0;
    socket.on('data', (chunk: Buffer) => {
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
          socket.write(preloginReply(plain ? 0x02 : 0x01));
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
      assert.ok(error instanceof CredentialsWithheldError, String(error));
      assert.equal(error.message, PIN_REFUSALS.redirectedOutside(context.target.host, other));
      assert.deepEqual(
        [error.sensorId, error.target, error.phase, error.kind],
        [62, context.target.host, 'connect', 'database'],
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
    const context = contextOf('/var/run/postgresql', rebinding(), { port: 5433 });
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
        '/var/run/postgresql:5433 (ENOTFOUND)',
    );
    assert.equal(lookups, 1);
    assert.deepEqual(seen, []);
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

  it('a bounded set, a device given as an address inside it: the redirect is withheld, with nothing sent on', async () => {
    reset();
    for (const to of [OTHER, '127.0.0.2']) {
      const dns = rebinding(v4('127.0.0.2'));
      const { error, device } = await routed(
        to,
        { host: '127.0.0.1', targets: ['127.0.0.1'] },
        dns,
      );
      loggedIn(device);
      assert.ok(error instanceof CredentialsWithheldError, String(error));
      assert.equal(error.message, PIN_REFUSALS.redirectedOutside('127.0.0.1', to));
      assert.equal(dns.calls.length, 0, 'a server the set may not reach is not resolved');
    }
    assert.equal(onward.connections, 0);
  });

  it('a bounded set, a device a name entry covers: the redirect is withheld, with nothing sent on', async () => {
    reset();
    const dns = rebinding(v4('127.0.0.1'), v4('127.0.0.2'));
    const { error, device } = await routed(OTHER, { targets: [NAME] }, dns);
    loggedIn(device);
    assert.ok(error instanceof CredentialsWithheldError, String(error));
    assert.equal(error.message, PIN_REFUSALS.redirectedOutside(NAME, OTHER));
    assert.deepEqual(dns.calls, [{ host: NAME, family: 0 }]);
    assert.equal(onward.connections, 0);
  });

  it('a pinned set: the redirect is withheld, with nothing sent on', async () => {
    reset();
    const dns = rebinding(v4('127.0.0.1'), v4('127.0.0.2'));
    const { error, device } = await routed('127.0.0.2', { targets: INSIDE }, dns);
    loggedIn(device);
    assert.ok(error instanceof CredentialsWithheldError, String(error));
    assert.equal(error.message, PIN_REFUSALS.redirected(NAME, '127.0.0.2'));
    assert.equal(dns.calls.length, 1);
    assert.equal(onward.connections, 0);
  });

  it('a bounded set under `none` is withheld all the same', async () => {
    reset();
    const dns = rebinding();
    const { error, device } = await routed(
      '127.0.0.2',
      { host: '127.0.0.1', targets: ['127.0.0.1'], policy: 'none' },
      dns,
    );
    loggedIn(device);
    assert.ok(error instanceof CredentialsWithheldError, String(error));
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

  it('is none only where nothing is checked: no lookup, and no redirect to ask about', () => {
    const { lookup: _lookup, ...plain } = options();
    assert.equal(tdsConnector(plain), undefined);
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
