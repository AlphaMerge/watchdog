import assert from 'node:assert/strict';
import systemDns, { type LookupAddress } from 'node:dns';
import { createServer, type Server, type Socket } from 'node:net';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { TargetPolicy } from '@ms/shared';
import { TestSshServer } from '@ms/simulators';
import { SensorCatalogue } from '../src/catalogue.js';
import { resolvedUnchecked, TargetRefusedError } from '../src/support/checked-target.js';
import { CredentialsWithheldError } from '../src/support/pinned-target.js';
import {
  DbRoutedUnresolvedError,
  describeDbError,
  type DbConnectOptions,
  type DbDriver,
} from '../src/support/db/driver.js';
import { tdsConnector } from '../src/support/db/socket.js';
import type { ResolvedAddress, ResolveHost } from '../src/support/pinned-target.js';
import { readCredentials } from '../src/support/ssh/credentials.js';
import { SshSessionPool, sshPool } from '../src/support/ssh/pool.js';
import { runDbCheck } from '../src/types/db-shared.js';
import { dbMssql } from '../src/types/db-mssql.js';
import { dbMysql } from '../src/types/db-mysql.js';
import { dbPostgresql } from '../src/types/db-postgresql.js';
import { httpAdvanced } from '../src/types/http-advanced.js';
import { httpContent } from '../src/types/http-content.js';
import { httpTransaction } from '../src/types/http-transaction.js';
import { httpRequest } from '../src/types/http.js';
import { mailSmtp } from '../src/types/mail-smtp.js';
import { portRange } from '../src/types/port-range.js';
import { portTcp } from '../src/types/port-tcp.js';
import { restCustom } from '../src/types/rest-custom.js';
import { sshLoad } from '../src/types/ssh-load.js';
import { tlsCertificate } from '../src/types/tls-certificate.js';
import { tlsSecurity } from '../src/types/tls-security.js';
import type { CheckContext, SensorType } from '../src/contract.js';
import { failedIn, rejectionOf } from './support/failed-in.js';
import { within } from './support/within.js';

/**
 * The device's IP version, on every transport that connects to a device (`A-85`): TLS, HTTP,
 * SSH and the three database drivers, which did not hold to it, and `port.*` and `mail.*`,
 * which did and tried only the first address of it.
 *
 * **Every server here is two listeners at one port**, one on `127.0.0.1` and one on `::1`, each
 * writing down that something reached it and hanging up. What a case asserts is which of the two
 * a check's connections reached. The check then fails, on a connection closed under it, and that
 * failure is not what any case is about, except that it is never the target policy's refusal.
 *
 * **The device is named by a name nothing resolves**, so the only way a check reaches either
 * listener is through an answer this file gave. Under the guarded policies that is the check's
 * own resolver (`CheckTarget.resolve`), which answers as `getaddrinfo` does: the family asked
 * for, or both for 0, in the order given. **Under `none` nothing resolves through it**, since
 * the socket resolves the name itself, so there it is the system's lookup, `dns.lookup`, that
 * this file answers for the one name, for the length of one case. No case asks real DNS.
 *
 * **Each name puts the family the device rules out first**, so that a check that ignored the
 * device's setting would reach the wrong listener, not merely also the right one. An `auto`
 * device keeps what it always did: the first answer.
 *
 * **Nothing here is sent to a link-local, private or metadata address.** Each one a name answers
 * with is of the family the device rules out: the check either ignores it, which is the point,
 * or is refused on it before any socket exists, which is what the code did before `A-85`.
 */

const NAME = 'device.ipversion.invalid';
const OTHER = 'replica.ipversion.invalid';
/** Loopback, and nothing listens on it: a connection there is refused at once. */
const DEAD = '127.0.0.9';
const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });
const v6 = (address: string): ResolvedAddress => ({ address, family: 6 });

/** Whether `::1` can be listened on here. Asked once, with a bound. */
const loopback6Listens = await new Promise<boolean>((resolve) => {
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

/** Whether a case that listens on `::1` can run here, skipping it, and saying why, where not. */
function loopback6(t: TestContext): boolean {
  if (loopback6Listens) return true;
  t.skip('::1 cannot be listened on here');
  return false;
}

// ---------------------------------------------------------------------------------------------
// The two listeners.

interface Recorder {
  readonly port: number;
  /** The listener each connection reached, in the order they arrived. */
  readonly reached: string[];
  close(): Promise<void>;
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const at = server.address();
      resolve(typeof at === 'object' && at !== null ? at.port : 0);
    });
  });
}

function shut(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/** A port held on both loopback addresses: one handed out on `::1`, then taken on `127.0.0.1`. */
async function recorder(): Promise<Recorder> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const reached: string[] = [];
    const sockets = new Set<Socket>();
    const listener = (address: string): Server =>
      createServer((socket) => {
        reached.push(address);
        sockets.add(socket);
        socket.destroy();
      });
    const six = listener('::1');
    const port = await listen(six, '::1', 0);
    const four = listener('127.0.0.1');
    try {
      await listen(four, '127.0.0.1', port);
    } catch (error: unknown) {
      await shut(six);
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
      throw error;
    }
    return {
      port,
      reached,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await Promise.all([shut(six), shut(four)]);
      },
    };
  }
  throw new Error('no port was free on both 127.0.0.1 and ::1 in twenty tries');
}

/** A port nothing listens on, on either loopback address: taken, read and given back. */
async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server, '127.0.0.1', 0);
  await shut(server);
  return port;
}

// ---------------------------------------------------------------------------------------------
// The two ways a name is answered.

/** The check's own resolver: the family asked for, or every answer for 0. */
function resolverAnswering(answers: readonly ResolvedAddress[]): {
  readonly resolve: ResolveHost;
  readonly asked: { host: string; family: number }[];
} {
  const asked: { host: string; family: number }[] = [];
  return {
    asked,
    resolve: (host, family) => {
      asked.push({ host, family });
      const fitting = answers.filter((one) => family === 0 || one.family === family);
      if ((host !== NAME && host !== OTHER) || fitting.length === 0) {
        return Promise.reject(
          Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }),
        );
      }
      return Promise.resolve(fitting);
    },
  };
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * The system's lookup, answering `NAME` for the rest of this test, as `getaddrinfo` does; every
 * other name is the real lookup's. Returns the family each lookup of `NAME` asked for, and, in
 * `all`, whether each asked for every address. A name with no answer of the family asked for
 * fails with `code`: `ENOTFOUND`, or `EAI_AGAIN` for a resolver that is not answering.
 */
function systemAnswering(
  t: TestContext,
  answers: readonly ResolvedAddress[],
  code = 'ENOTFOUND',
  /** How long it takes to answer: a slow resolver's round trip. */
  delayMs = 0,
): number[] & { readonly all: boolean[]; readonly hints: unknown[] } {
  const asked = Object.assign([] as number[], { all: [] as boolean[], hints: [] as unknown[] });
  const original = systemDns.lookup as (...args: unknown[]) => void;
  t.mock.method(systemDns, 'lookup', (hostname: string, ...rest: unknown[]): void => {
    if (hostname !== NAME) {
      original.apply(systemDns, [hostname, ...rest]);
      return;
    }
    const callback = rest[rest.length - 1] as LookupCallback;
    const options = rest.length > 1 ? rest[0] : undefined;
    const family =
      typeof options === 'number'
        ? options
        : Number((options as { family?: unknown } | undefined)?.family ?? 0);
    const all = (options as { all?: unknown } | undefined)?.all === true;
    asked.push(family);
    asked.all.push(all);
    asked.hints.push((options as { hints?: unknown } | undefined)?.hints);
    const fitting = answers.filter((one) => family === 0 || one.family === family);
    const answer = (fn: () => void): void => {
      if (delayMs > 0) setTimeout(fn, delayMs);
      else process.nextTick(fn);
    };
    answer(() => {
      const [first] = fitting;
      if (first === undefined) {
        callback(
          Object.assign(new Error(`getaddrinfo ${code} ${hostname}`), { code, hostname }),
          '',
        );
        return;
      }
      if (all) {
        callback(
          null,
          fitting.map((one) => ({ address: one.address, family: one.family })),
        );
        return;
      }
      callback(null, first.address, first.family);
    });
  });
  return asked;
}

// ---------------------------------------------------------------------------------------------
// The transports.

interface Transport {
  readonly name: string;
  readonly type: SensorType;
  readonly params: (port: number) => Record<string, unknown>;
  readonly credentials?: CheckContext['credentials'];
}

const SSH_CREDENTIALS = {
  ssh: { username: 'monitor', password: 'monitor', hostKeyPolicy: 'accept-any' },
};
const DB_CREDENTIALS = { database: { username: 'monitor', password: 'secret' } };
const dbParams = (port: number): Record<string, unknown> => ({
  port,
  query: 'select 1',
  encrypt: 'disable',
  connectTimeoutMs: 4_000,
});

/** One sensor type for each way of connecting. Every HTTP type is also run below. */
const TRANSPORTS: readonly Transport[] = [
  {
    name: 'TLS, tls.certificate',
    type: tlsCertificate,
    params: (port) => ({ port, timeoutMs: 4_000 }),
  },
  { name: 'TLS, tls.security', type: tlsSecurity, params: (port) => ({ port, timeoutMs: 4_000 }) },
  {
    name: 'HTTP, http.request',
    type: httpRequest,
    params: (port) => ({ scheme: 'http', port, timeoutMs: 4_000 }),
  },
  {
    name: 'SSH, ssh.load',
    type: sshLoad,
    params: (port) => ({ port, connectTimeoutMs: 4_000, commandTimeoutMs: 4_000 }),
    credentials: SSH_CREDENTIALS,
  },
  {
    name: 'PostgreSQL, db.postgresql',
    type: dbPostgresql,
    params: dbParams,
    credentials: DB_CREDENTIALS,
  },
  { name: 'MySQL, db.mysql', type: dbMysql, params: dbParams, credentials: DB_CREDENTIALS },
  { name: 'SQL Server, db.mssql', type: dbMssql, params: dbParams, credentials: DB_CREDENTIALS },
  // Held to the family before `A-85`, and to its first address alone (`A-85`'s review).
  { name: 'TCP, port.tcp', type: portTcp, params: (port) => ({ port, timeoutMs: 4_000 }) },
  {
    name: 'mail, mail.smtp',
    type: mailSmtp,
    params: (port) => ({ port, security: 'none', timeoutMs: 4_000 }),
  },
];

interface Ran {
  /** What the check failed with, or undefined when it did not. */
  readonly error: unknown;
  readonly reached: readonly string[];
}

/** One check, through the catalogue as a probe runs it, against a fresh pair of listeners. */
async function check(
  transport: Transport,
  run: {
    readonly ipVersion: 'auto' | 'v4' | 'v6';
    readonly policy: TargetPolicy;
    readonly resolve: ResolveHost;
    readonly exception?: readonly string[];
    /** The port the check is given, in place of the listeners': one nothing listens on. */
    readonly port?: number;
  },
): Promise<Ran> {
  const listeners = await recorder();
  const controller = new AbortController();
  try {
    const catalogue = new SensorCatalogue({ resolve: run.resolve, targetPolicy: run.policy })
      .register(transport.type)
      .seal();
    let error: unknown;
    try {
      await within(
        12_000,
        `${transport.name} to settle`,
        catalogue.execute(transport.type.id, {
          sensorId: 85,
          target: {
            host: NAME,
            ipVersion: run.ipVersion,
            ...(run.exception === undefined ? {} : { policyException: run.exception }),
          },
          params: transport.params(run.port ?? listeners.port),
          credentials: transport.credentials ?? {},
          signal: controller.signal,
        }),
      );
    } catch (thrown: unknown) {
      error = thrown;
    }
    // A connection a check made as it failed has reached its listener by now.
    await new Promise((resolve) => setImmediate(resolve));
    return { error, reached: [...listeners.reached] };
  } finally {
    controller.abort();
    await listeners.close();
  }
}

const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** It reached this listener and no other, and was not refused on the way. */
function reachedOnly(ran: Ran, listener: string, transport: Transport): void {
  assert.ok(
    !(ran.error instanceof TargetRefusedError),
    `${transport.name} was refused: ${said(ran.error)}`,
  );
  assert.ok(
    ran.reached.length > 0,
    `${transport.name} reached neither listener; it said: ${said(ran.error)}`,
  );
  assert.deepEqual(
    [...new Set(ran.reached)],
    [listener],
    `${transport.name} reached ${ran.reached.join(', ')}; it said: ${said(ran.error)}`,
  );
}

/**
 * What comes before the guard's sentence: nothing, or a transaction's step, which names itself
 * first (`step 1 of 1 (open) failed: `). Anything else, such as `tls.security`'s "accepted no TLS
 * version at all", is a diagnosis in front of the one that is true.
 */
const LEAD = '^(step \\d+ of \\d+ \\([^)]*\\) failed: )?';

/** What a check says it was doing when the name did not resolve, as the guard says it. */
function doing(transport: Transport): RegExp {
  if (transport.type.id.startsWith('ssh.')) return /connecting to \S+:\d+ over SSH/u;
  if (transport.type.id.startsWith('http.') || transport.type.id === 'rest.custom') {
    return /requesting http:\/\/\S+/u;
  }
  return /connecting to \S+:\d+/u;
}

/**
 * It reached nothing, and said the name had no address of the device's family, in the guard's
 * sentence and its phase, under every policy (`A-85`).
 */
function unresolved(ran: Ran, family: 'IPv4' | 'IPv6' | 'auto', transport: Transport): void {
  assert.deepEqual(ran.reached, [], `${transport.name} reached ${ran.reached.join(', ')}`);
  assert.ok(ran.error instanceof Error, `${transport.name} did not fail`);
  assert.match(
    ran.error.message,
    // The guard's sentence and nothing in front of it but a transaction's step. The guard's own
    // adds the resolver's code. An `auto` device's names no family, as each transport's did.
    new RegExp(
      `${LEAD}the device’s host name did not resolve` +
        `${family === 'auto' ? '' : ` to an ${family} address`}, ` +
        `${doing(transport).source}( \\(ENOTFOUND\\))?$`,
      'u',
    ),
    transport.name,
  );
  assert.deepEqual(failedIn(ran.error), { phase: 'resolve', target: NAME }, ran.error.message);
}

/**
 * It failed connecting, at the device, saying why and naming each address it tried (`A-85`'s
 * second check): a walk that fails on every address ends in an error that says nothing.
 */
function triedEach(ran: Ran, transport: Transport): void {
  assert.ok(ran.error instanceof Error, `${transport.name} did not fail`);
  const message = ran.error.message;
  assert.match(message, /nothing is listening|ECONNREFUSED/u, `${transport.name}: ${message}`);
  assert.match(message, /127\.0\.0\.9 ECONNREFUSED/u, `${transport.name}: ${message}`);
  assert.match(message, /127\.0\.0\.1 ECONNREFUSED/u, `${transport.name}: ${message}`);
  assert.deepEqual(failedIn(ran.error), { phase: 'connect', target: NAME }, message);
}

/** It reached nothing, and said the probe's resolver is not answering, not that a record is missing. */
function notAnswering(ran: Ran, transport: Transport): void {
  assert.deepEqual(ran.reached, [], `${transport.name} reached ${ran.reached.join(', ')}`);
  assert.ok(ran.error instanceof Error, `${transport.name} did not fail`);
  assert.match(
    ran.error.message,
    new RegExp(
      `${LEAD}the device’s host name did not resolve, ${doing(transport).source} — the probe’s ` +
        'resolver is not answering \\(EAI_AGAIN\\)$',
      'u',
    ),
    transport.name,
  );
  assert.deepEqual(failedIn(ran.error), { phase: 'resolve', target: NAME }, ran.error.message);
}

after(() => {
  sshPool.closeAll();
});

// ---------------------------------------------------------------------------------------------

for (const transport of TRANSPORTS) {
  describe(`${transport.name} reaches a device only over its IP version (A-85)`, () => {
    describe('under the default policy, link-local', () => {
      it('a v4 device whose name answers ::1 first reaches 127.0.0.1 alone, and asks only for IPv4', async (t) => {
        if (!loopback6(t)) return;
        const resolver = resolverAnswering([v6('::1'), v4('127.0.0.1')]);
        const ran = await check(transport, { ipVersion: 'v4', policy: 'link-local', ...resolver });
        reachedOnly(ran, '127.0.0.1', transport);
        assert.deepEqual(resolver.asked, [{ host: NAME, family: 4 }]);
      });

      it('a v6 device whose name answers 127.0.0.1 first reaches ::1 alone, and asks only for IPv6', async (t) => {
        if (!loopback6(t)) return;
        const resolver = resolverAnswering([v4('127.0.0.1'), v6('::1')]);
        const ran = await check(transport, { ipVersion: 'v6', policy: 'link-local', ...resolver });
        reachedOnly(ran, '::1', transport);
        assert.deepEqual(resolver.asked, [{ host: NAME, family: 6 }]);
      });

      it('an auto device asks for both and reaches the first answer, as it always did', async (t) => {
        if (!loopback6(t)) return;
        const resolver = resolverAnswering([v6('::1'), v4('127.0.0.1')]);
        const ran = await check(transport, {
          ipVersion: 'auto',
          policy: 'link-local',
          ...resolver,
        });
        reachedOnly(ran, '::1', transport);
        assert.deepEqual(resolver.asked, [{ host: NAME, family: 0 }]);
      });

      it('a v4 device whose name also has a link-local AAAA is not refused over it', async (t) => {
        if (!loopback6(t)) return;
        const resolver = resolverAnswering([v6('fe80::1'), v4('127.0.0.1')]);
        const ran = await check(transport, { ipVersion: 'v4', policy: 'link-local', ...resolver });
        reachedOnly(ran, '127.0.0.1', transport);
      });

      it('a v6 device whose name also has a link-local A is not refused over it', async (t) => {
        if (!loopback6(t)) return;
        const resolver = resolverAnswering([v4('169.254.10.1'), v6('::1')]);
        const ran = await check(transport, { ipVersion: 'v6', policy: 'link-local', ...resolver });
        reachedOnly(ran, '::1', transport);
      });

      it('a v6 device whose name has only an A record fails as one with no IPv6 address', async () => {
        const resolver = resolverAnswering([v4('127.0.0.1')]);
        const ran = await check(transport, { ipVersion: 'v6', policy: 'link-local', ...resolver });
        unresolved(ran, 'IPv6', transport);
      });

      it('a v4 device whose name has only an AAAA record fails as one with no IPv4 address', async () => {
        const resolver = resolverAnswering([v6('::1')]);
        const ran = await check(transport, { ipVersion: 'v4', policy: 'link-local', ...resolver });
        unresolved(ran, 'IPv4', transport);
      });

      it('a v4 device whose first IPv4 address is dead passes it for the next', async (t) => {
        if (!loopback6(t)) return;
        const resolver = resolverAnswering([v6('::1'), v4(DEAD), v4('127.0.0.1')]);
        const ran = await check(transport, { ipVersion: 'v4', policy: 'link-local', ...resolver });
        reachedOnly(ran, '127.0.0.1', transport);
      });

      it('a v6 device whose name answers only an IPv4-mapped address fails as one with no IPv6 address', async () => {
        // What macOS answers a lookup for IPv6 alone with, for a name with only A records: a
        // socket connecting to it goes over IPv4 (`A-85`'s second check).
        const resolver = resolverAnswering([v6('::ffff:127.0.0.1')]);
        const ran = await check(transport, { ipVersion: 'v6', policy: 'link-local', ...resolver });
        unresolved(ran, 'IPv6', transport);
      });

      it('an auto device whose name answers an IPv4-mapped address reaches 127.0.0.1 over it', async (t) => {
        if (!loopback6(t)) return;
        const resolver = resolverAnswering([v6('::ffff:127.0.0.1')]);
        const ran = await check(transport, {
          ipVersion: 'auto',
          policy: 'link-local',
          ...resolver,
        });
        reachedOnly(ran, '127.0.0.1', transport);
      });

      it('a name whose every address refuses says why, and names each address it tried', async () => {
        const resolver = resolverAnswering([v4(DEAD), v4('127.0.0.1')]);
        const port = await closedPort();
        const ran = await check(transport, {
          ipVersion: 'v4',
          policy: 'link-local',
          port,
          ...resolver,
        });
        triedEach(ran, transport);
      });
    });

    describe('under private, with both loopback addresses excepted', () => {
      const exception = ['127.0.0.1', '::1'];

      it('a v4 device whose name also has a ULA reaches 127.0.0.1 alone, not refused over it', async (t) => {
        if (!loopback6(t)) return;
        const resolver = resolverAnswering([v6('fd00::1'), v6('::1'), v4('127.0.0.1')]);
        const ran = await check(transport, {
          ipVersion: 'v4',
          policy: 'private',
          exception,
          ...resolver,
        });
        reachedOnly(ran, '127.0.0.1', transport);
        assert.deepEqual(resolver.asked, [{ host: NAME, family: 4 }]);
      });

      it('a v6 device whose name also has an RFC 1918 address reaches ::1 alone, not refused over it', async (t) => {
        if (!loopback6(t)) return;
        const resolver = resolverAnswering([v4('10.0.0.1'), v4('127.0.0.1'), v6('::1')]);
        const ran = await check(transport, {
          ipVersion: 'v6',
          policy: 'private',
          exception,
          ...resolver,
        });
        reachedOnly(ran, '::1', transport);
        assert.deepEqual(resolver.asked, [{ host: NAME, family: 6 }]);
      });

      it('an auto device reaches the first answer, as it always did', async (t) => {
        if (!loopback6(t)) return;
        const resolver = resolverAnswering([v6('::1'), v4('127.0.0.1')]);
        const ran = await check(transport, {
          ipVersion: 'auto',
          policy: 'private',
          exception,
          ...resolver,
        });
        reachedOnly(ran, '::1', transport);
      });
    });

    describe('under none, where the socket resolves the name itself', () => {
      // The check's own resolver is handed in, and must not be asked: under `none` nothing is.
      const unasked = (): ReturnType<typeof resolverAnswering> => resolverAnswering([]);

      it('a v4 device whose name answers ::1 first reaches 127.0.0.1 alone', async (t) => {
        if (!loopback6(t)) return;
        const asked = systemAnswering(t, [v6('::1'), v4('127.0.0.1')]);
        const resolver = unasked();
        const ran = await check(transport, { ipVersion: 'v4', policy: 'none', ...resolver });
        reachedOnly(ran, '127.0.0.1', transport);
        assert.ok(asked.length > 0 && asked.every((family) => family === 4), String(asked));
        assert.deepEqual(resolver.asked, []);
      });

      it('a v6 device whose name answers 127.0.0.1 first reaches ::1 alone', async (t) => {
        if (!loopback6(t)) return;
        const asked = systemAnswering(t, [v4('127.0.0.1'), v6('::1')]);
        const resolver = unasked();
        const ran = await check(transport, { ipVersion: 'v6', policy: 'none', ...resolver });
        reachedOnly(ran, '::1', transport);
        assert.ok(asked.length > 0 && asked.every((family) => family === 6), String(asked));
        assert.deepEqual(resolver.asked, []);
      });

      it('an auto device reaches the first answer, as it always did', async (t) => {
        if (!loopback6(t)) return;
        const asked = systemAnswering(t, [v6('::1'), v4('127.0.0.1')]);
        const resolver = unasked();
        const ran = await check(transport, { ipVersion: 'auto', policy: 'none', ...resolver });
        reachedOnly(ran, '::1', transport);
        assert.ok(asked.length > 0 && asked.every((family) => family === 0), String(asked));
      });

      it('a v4 device whose first IPv4 address is dead passes it for the next, asking for all', async (t) => {
        if (!loopback6(t)) return;
        // A socket told the family would ask for one address and connect to that alone.
        const asked = systemAnswering(t, [v6('::1'), v4(DEAD), v4('127.0.0.1')]);
        const ran = await check(transport, { ipVersion: 'v4', policy: 'none', ...unasked() });
        reachedOnly(ran, '127.0.0.1', transport);
        assert.ok(asked.length > 0 && asked.every((family) => family === 4), String(asked));
        assert.ok(asked.all.every(Boolean), `asked for one address: ${String(asked.all)}`);
      });

      it('a v6 device whose name has only an A record fails as one with no IPv6 address', async (t) => {
        systemAnswering(t, [v4('127.0.0.1')]);
        const ran = await check(transport, { ipVersion: 'v6', policy: 'none', ...unasked() });
        unresolved(ran, 'IPv6', transport);
      });

      it('a v4 device whose name has only an AAAA record fails as one with no IPv4 address', async (t) => {
        systemAnswering(t, [v6('::1')]);
        const ran = await check(transport, { ipVersion: 'v4', policy: 'none', ...unasked() });
        unresolved(ran, 'IPv4', transport);
      });

      it('a resolver that does not answer is said to be not answering, not to lack a record', async (t) => {
        systemAnswering(t, [], 'EAI_AGAIN');
        const ran = await check(transport, { ipVersion: 'v6', policy: 'none', ...unasked() });
        notAnswering(ran, transport);
      });

      it('a v6 device whose name answers only an IPv4-mapped address fails as one with no IPv6 address', async (t) => {
        systemAnswering(t, [v6('::ffff:127.0.0.1')]);
        const ran = await check(transport, { ipVersion: 'v6', policy: 'none', ...unasked() });
        unresolved(ran, 'IPv6', transport);
      });

      it('an auto device whose name does not resolve fails in the resolve phase, naming no family', async (t) => {
        // Resolved by the transport's own socket, SSH's by `ssh2`'s and each driver's by the
        // driver's: the words and the phase A-85 gave them.
        systemAnswering(t, []);
        const ran = await check(transport, { ipVersion: 'auto', policy: 'none', ...unasked() });
        unresolved(ran, 'auto', transport);
      });

      it('an auto device whose resolver does not answer is said to be not answering', async (t) => {
        systemAnswering(t, [], 'EAI_AGAIN');
        const ran = await check(transport, { ipVersion: 'auto', policy: 'none', ...unasked() });
        notAnswering(ran, transport);
      });

      it('a name whose every address refuses says why, and names each address it tried', async (t) => {
        systemAnswering(t, [v4(DEAD), v4('127.0.0.1')]);
        const port = await closedPort();
        const ran = await check(transport, { ipVersion: 'v4', policy: 'none', port, ...unasked() });
        triedEach(ran, transport);
      });
    });
  });
}

// ---------------------------------------------------------------------------------------------

/** Every HTTP type reads its target through `readCommon`, and so every one is held to it. */
const HTTP_TYPES: readonly { type: SensorType; params: Record<string, unknown> }[] = [
  { type: httpRequest, params: {} },
  { type: httpAdvanced, params: {} },
  { type: httpContent, params: {} },
  { type: httpTransaction, params: { steps: [{ name: 'open', path: '/' }] } },
  { type: restCustom, params: { extract: [{ key: 'value', path: '$.value' }] } },
];

describe('every HTTP type reaches a device only over its IP version (A-85)', () => {
  for (const { type, params } of HTTP_TYPES) {
    const transport: Transport = {
      name: type.id,
      type,
      params: (port) => ({ scheme: 'http', port, timeoutMs: 4_000, ...params }),
    };

    it(`${type.id}: a v4 device reaches 127.0.0.1 alone, under link-local and under none`, async (t) => {
      if (!loopback6(t)) return;
      const resolver = resolverAnswering([v6('::1'), v4('127.0.0.1')]);
      reachedOnly(
        await check(transport, { ipVersion: 'v4', policy: 'link-local', ...resolver }),
        '127.0.0.1',
        transport,
      );
      systemAnswering(t, [v6('::1'), v4('127.0.0.1')]);
      reachedOnly(
        await check(transport, { ipVersion: 'v4', policy: 'none', ...resolverAnswering([]) }),
        '127.0.0.1',
        transport,
      );
    });

    it(`${type.id}: a v6 device whose name has only an A record fails as one with no IPv6 address`, async (t) => {
      const resolver = resolverAnswering([v4('127.0.0.1')]);
      unresolved(
        await check(transport, { ipVersion: 'v6', policy: 'link-local', ...resolver }),
        'IPv6',
        transport,
      );
      systemAnswering(t, [v4('127.0.0.1')]);
      unresolved(
        await check(transport, { ipVersion: 'v6', policy: 'none', ...resolverAnswering([]) }),
        'IPv6',
        transport,
      );
    });

    it(`${type.id}: a v4 device whose first IPv4 address is dead passes it, under none`, async (t) => {
      if (!loopback6(t)) return;
      systemAnswering(t, [v6('::1'), v4(DEAD), v4('127.0.0.1')]);
      reachedOnly(
        await check(transport, { ipVersion: 'v4', policy: 'none', ...resolverAnswering([]) }),
        '127.0.0.1',
        transport,
      );
    });
  }
});

// ---------------------------------------------------------------------------------------------

/**
 * `port.range` reads no failure: a port it cannot connect to is closed. What it reads is how
 * many it found open, so a scan held to the family reads one open, and one that was not, or
 * that tried only the first address, reads none.
 */
describe('port.range scans a device only over its IP version, every address of it (A-85)', () => {
  const scan = async (
    run: Parameters<typeof check>[1],
  ): Promise<{ open: number | undefined; reached: readonly string[] }> => {
    const listeners = await recorder();
    try {
      const catalogue = new SensorCatalogue({ resolve: run.resolve, targetPolicy: run.policy })
        .register(portRange)
        .seal();
      const execution = await within(
        12_000,
        'port.range to settle',
        catalogue.execute(portRange.id, {
          sensorId: 85,
          target: { host: NAME, ipVersion: run.ipVersion },
          params: { ports: String(listeners.port), timeoutMs: 4_000 },
          credentials: {},
          signal: new AbortController().signal,
        }),
      );
      await new Promise((resolve) => setImmediate(resolve));
      return {
        open: execution.channels.find((one) => one.key === 'open')?.value ?? undefined,
        reached: [...listeners.reached],
      };
    } finally {
      await listeners.close();
    }
  };

  /** A scan that failed, and the lookups the system was asked for. */
  const failedScan = async (
    t: TestContext,
    ipVersion: 'auto' | 'v4' | 'v6',
    answers: readonly ResolvedAddress[],
    code = 'ENOTFOUND',
  ): Promise<{ error: unknown; asked: readonly number[] }> => {
    const asked = systemAnswering(t, answers, code);
    const catalogue = new SensorCatalogue({
      resolve: resolverAnswering([]).resolve,
      targetPolicy: 'none',
    })
      .register(portRange)
      .seal();
    const error = await rejectionOf(() =>
      within(
        12_000,
        'port.range to settle',
        catalogue.execute(portRange.id, {
          sensorId: 85,
          target: { host: NAME, ipVersion },
          // Three ports: the name is resolved once for all of them, not once for each.
          params: { ports: '1-3', timeoutMs: 4_000 },
          credentials: {},
          signal: new AbortController().signal,
        }),
      ),
    );
    return { error, asked: [...asked] };
  };

  /** It failed as a name that did not resolve, in the guard's words, and asked once. */
  const scanUnresolved = (
    ran: { error: unknown; asked: readonly number[] },
    sentence: RegExp,
  ): void => {
    assert.ok(ran.error instanceof Error, `it did not fail: ${String(ran.error)}`);
    assert.match(ran.error.message, sentence);
    assert.deepEqual(failedIn(ran.error), { phase: 'resolve', target: NAME }, ran.error.message);
    assert.equal(ran.asked.length, 1, `the name was resolved ${String(ran.asked.length)} times`);
  };

  // Under `none` each port's socket resolved the name, and a port whose lookup failed was
  // closed: a name with no address of the family read as "0 of 3 open" (`A-85`'s second check).
  it('under none, a v6 device whose name has only an A record fails, and reads no ports', async (t) => {
    scanUnresolved(
      await failedScan(t, 'v6', [v4('127.0.0.1')]),
      /^the device’s host name did not resolve to an IPv6 address, scanning device\.ipversion\.invalid$/u,
    );
  });

  it('under none, a v4 device whose name has only an AAAA record fails, and reads no ports', async (t) => {
    scanUnresolved(
      await failedScan(t, 'v4', [v6('::1')]),
      /^the device’s host name did not resolve to an IPv4 address, scanning device\.ipversion\.invalid$/u,
    );
  });

  it('under none, a v6 device whose name answers only an IPv4-mapped address fails', async (t) => {
    scanUnresolved(
      await failedScan(t, 'v6', [v6('::ffff:127.0.0.1')]),
      /^the device’s host name did not resolve to an IPv6 address, scanning device\.ipversion\.invalid$/u,
    );
  });

  it('under none, an auto device whose name does not resolve fails, naming no family', async (t) => {
    scanUnresolved(
      await failedScan(t, 'auto', []),
      /^the device’s host name did not resolve, scanning device\.ipversion\.invalid$/u,
    );
  });

  it('under none, a resolver that does not answer fails the scan as not answering', async (t) => {
    scanUnresolved(
      await failedScan(t, 'v6', [], 'EAI_AGAIN'),
      /^the device’s host name did not resolve, scanning device\.ipversion\.invalid — the probe’s resolver is not answering \(EAI_AGAIN\)$/u,
    );
  });

  it('under none, a resolver slower than half a port’s timeout still answers the scan in time', async (t) => {
    if (!loopback6(t)) return;
    // Each port's socket had all of its timeout for its own lookup, and the one lookup has it
    // too (`A-85`'s third check). Half of it, the guard's bound, failed every scan here as a
    // resolver that does not answer.
    const asked = systemAnswering(t, [v4('127.0.0.1')], 'ENOTFOUND', 650);
    const listeners = await recorder();
    try {
      const catalogue = new SensorCatalogue({
        resolve: resolverAnswering([]).resolve,
        targetPolicy: 'none',
      })
        .register(portRange)
        .seal();
      const execution = await within(
        12_000,
        'port.range to settle',
        catalogue.execute(portRange.id, {
          sensorId: 85,
          target: { host: NAME, ipVersion: 'v4' },
          params: { ports: String(listeners.port), timeoutMs: 1_000 },
          credentials: {},
          signal: new AbortController().signal,
        }),
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        execution.channels.find((one) => one.key === 'open')?.value,
        1,
        execution.message,
      );
      assert.deepEqual([...listeners.reached], ['127.0.0.1']);
      assert.equal(asked.length, 1);
    } finally {
      await listeners.close();
    }
  });

  it('under none, asks with ADDRCONFIG for either family as Node’s sockets do, and not on Windows', async (t) => {
    const asked = systemAnswering(t, [v4('127.0.0.1')]);
    const resolve = (platform: NodeJS.Platform): ReturnType<typeof resolvedUnchecked> =>
      resolvedUnchecked({
        host: NAME,
        family: 0,
        withinMs: 1_000,
        signal: new AbortController().signal,
        doing: `scanning ${NAME}`,
        platform,
      });
    await resolve('linux');
    await resolve('win32');
    assert.deepEqual(asked.hints, [systemDns.ADDRCONFIG, undefined]);
  });

  for (const policy of ['link-local', 'none'] as const) {
    it(`under ${policy}, a v4 device whose first IPv4 address is dead reaches 127.0.0.1 alone`, async (t) => {
      if (!loopback6(t)) return;
      const answers = [v6('::1'), v4(DEAD), v4('127.0.0.1')];
      if (policy === 'none') systemAnswering(t, answers);
      const resolver = resolverAnswering(policy === 'none' ? [] : answers);
      const ran = await scan({ ipVersion: 'v4', policy, ...resolver });
      assert.equal(ran.open, 1, `reached ${ran.reached.join(', ')}`);
      assert.deepEqual([...new Set(ran.reached)], ['127.0.0.1']);
    });
  }
});

// ---------------------------------------------------------------------------------------------

describe('an SSH target a credential set pinned is connected to at the pin, not by family (A-85)', () => {
  const ssh = TRANSPORTS.find((one) => one.type === sshLoad) ?? assert.fail('no SSH transport');
  for (const [ipVersion, listener, answers] of [
    ['v4', '127.0.0.1', [v6('::1'), v4('127.0.0.1')]],
    ['v6', '::1', [v4('127.0.0.1'), v6('::1')]],
  ] as const) {
    it(`a ${ipVersion} device whose set’s targets pin ${listener} reaches it alone, resolving it once`, async (t) => {
      if (!loopback6(t)) return;
      // A set whose targets name only an address pins the name to one of its answers of the
      // device's family (`A-41c`), with the check's resolver. The system's lookup answers the
      // name with a dead address of the family: a connection that resolved the name again for
      // the family, in place of using the pin, would be seen asking, and would reach nothing.
      const asked = systemAnswering(t, [v6('::1'), v4(DEAD)]);
      const resolver = resolverAnswering(answers);
      const pinned: Transport = {
        ...ssh,
        credentials: { ssh: { ...SSH_CREDENTIALS.ssh, allowedTargets: [listener] } },
      };
      const ran = await check(pinned, { ipVersion, policy: 'link-local', ...resolver });
      reachedOnly(ran, listener, pinned);
      assert.deepEqual([...asked], [], 'the system lookup was asked for the name');
      assert.deepEqual(
        resolver.asked,
        [{ host: NAME, family: ipVersion === 'v4' ? 4 : 6 }],
        'the name was resolved for the pin, and only for it',
      );
    });
  }

  it('a v6 device whose name answers only an IPv4-mapped address is not pinned to it', async (t) => {
    if (!loopback6(t)) return;
    // Mapped, it is 127.0.0.1, inside the targets, and of the family the device rules out.
    const resolver = resolverAnswering([v6('::ffff:127.0.0.1')]);
    const pinned: Transport = {
      ...ssh,
      credentials: { ssh: { ...SSH_CREDENTIALS.ssh, allowedTargets: ['127.0.0.1'] } },
    };
    const ran = await check(pinned, { ipVersion: 'v6', policy: 'link-local', ...resolver });
    assert.deepEqual(ran.reached, [], `reached ${ran.reached.join(', ')}`);
    assert.ok(ran.error instanceof CredentialsWithheldError, `threw ${String(ran.error)}`);
    assert.equal(ran.error.phase, 'resolve');
    assert.match(ran.error.message, /did not resolve to any IPv6 address/u);
  });
});

// ---------------------------------------------------------------------------------------------

describe('an SSH connection is kept for one IP version (A-85)', () => {
  let server: TestSshServer;
  before(async () => {
    server = await TestSshServer.start();
  });
  after(async () => {
    await server.stop();
  });

  it('a v4 device and an auto device of the same host and credentials do not share one', async () => {
    const pool = new SshSessionPool();
    const credentials = readCredentials(SSH_CREDENTIALS.ssh);
    const at = { host: server.host, port: server.port };
    try {
      const first = await pool.acquire({ ...at, ipVersion: 'v4' }, credentials, {
        connectTimeoutMs: 4_000,
      });
      first.release();
      const second = await pool.acquire({ ...at, ipVersion: 'auto' }, credentials, {
        connectTimeoutMs: 4_000,
      });
      second.release();
      const again = await pool.acquire({ ...at, ipVersion: 'v4' }, credentials, {
        connectTimeoutMs: 4_000,
      });
      again.release();
      assert.equal(pool.stats().opened, 2, 'one connection for each IP version');
      assert.equal(server.connections, 2);
      assert.equal(again.session, first.session, 'the v4 device’s own connection is kept for it');
    } finally {
      pool.closeAll();
    }
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

describe('what a database driver is handed for a device set to an IP version (A-85)', () => {
  const context = (
    host: string,
    ipVersion: 'auto' | 'v4' | 'v6',
    resolve: ResolveHost,
    policy?: TargetPolicy,
  ): CheckContext => ({
    sensorId: 85,
    target: { host, ipVersion, resolve, ...(policy === undefined ? {} : { policy }) },
    params: { query: 'select 1' },
    credentials: DB_CREDENTIALS,
    signal: new AbortController().signal,
  });

  it('the family for a name or an address, and none for a socket path or an auto device', async () => {
    const seen: DbConnectOptions[] = [];
    const resolver = resolverAnswering([v6('::1'), v4('127.0.0.1')]);
    await runDbCheck(recording(seen), context(NAME, 'v6', resolver.resolve, 'none'));
    await runDbCheck(recording(seen), context(NAME, 'v4', resolver.resolve));
    await runDbCheck(recording(seen), context(NAME, 'auto', resolver.resolve, 'none'));
    await runDbCheck(recording(seen), context('127.0.0.1', 'v6', resolver.resolve, 'none'));
    await runDbCheck(
      recording(seen),
      context('/var/run/postgresql', 'v4', resolver.resolve),
      'linux',
    );
    assert.deepEqual(
      seen.map((options) => options.family),
      // An address keeps it for the server SQL Server may route the login to.
      [6, 4, undefined, 6, undefined],
    );
  });

  it('a server the device redirects to is asked for, and judged in, the device’s family', async () => {
    const seen: DbConnectOptions[] = [];
    const resolver = resolverAnswering([v6('fe80::1'), v4('127.0.0.1')]);
    await runDbCheck(recording(seen), context(NAME, 'v4', resolver.resolve));
    const redirect = seen[0]?.redirect ?? assert.fail('no redirect was handed over');
    // The routed server's link-local AAAA is of the family the device rules out: not refused.
    assert.ok((await redirect(OTHER)) !== undefined, 'a name needs a lookup');
    assert.deepEqual(resolver.asked, [
      { host: NAME, family: 4 },
      { host: OTHER, family: 4 },
    ]);
  });

  it('a server it redirects to with no address of the family says so, naming the family', async () => {
    const seen: DbConnectOptions[] = [];
    // The device has an AAAA; the server it routes to has only an A.
    const resolve: ResolveHost = (host, family) => {
      const answers = (host === NAME ? [v6('::1')] : [v4('127.0.0.1')]).filter(
        (one) => family === 0 || one.family === family,
      );
      return answers.length === 0
        ? Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }))
        : Promise.resolve(answers);
    };
    await runDbCheck(recording(seen), context(NAME, 'v6', resolve));
    const redirect = seen[0]?.redirect ?? assert.fail('no redirect was handed over');
    const error = await rejectionOf(() => redirect(OTHER));
    assert.ok(error instanceof DbRoutedUnresolvedError, `threw ${String(error)}`);
    assert.equal(
      error.message,
      `${NAME}:5432 routed the login to ${OTHER}, a host name that did not resolve to an IPv6 ` +
        'address — the device is set to IPv6, and the login goes on over it (ENOTFOUND)',
    );
    assert.deepEqual(failedIn(error), { phase: 'connect', target: NAME });
  });
});

// ---------------------------------------------------------------------------------------------

/**
 * SQL Server's routed server where nothing checks it (`A-85`'s review): under `none`, from a
 * device given as an address, the connector `tedious` is handed resolves the routed name for the
 * device's family alone. Straight at the connector, which `tedious` asks again for the routed
 * server with its host and port (`support/db/socket.ts`).
 */
describe('a server SQL Server routes the login to, under none, from a device given as an address (A-85)', () => {
  const options = (family?: 4 | 6): DbConnectOptions => ({
    host: '127.0.0.1',
    port: 1433,
    database: '',
    username: 'monitor',
    password: 'secret',
    encrypt: 'disable',
    verifyTls: false,
    connectTimeoutMs: 4_000,
    statementTimeoutMs: 4_000,
    ...(family === undefined ? {} : { family }),
  });

  it('is handed over only for the family: an auto device’s driver connects by itself', () => {
    assert.equal(tdsConnector(options()), undefined);
    assert.notEqual(tdsConnector(options(6)), undefined);
  });

  it('is reached over the device’s family, asking for every address of it', async (t) => {
    if (!loopback6(t)) return;
    const listeners = await recorder();
    try {
      const asked = systemAnswering(t, [v4('127.0.0.1'), v6('::1')]);
      const connector = tdsConnector(options(6)) ?? assert.fail('no connector was handed over');
      const socket = await within(
        5_000,
        'the routed connect',
        connector({ host: NAME, port: listeners.port }),
      );
      socket.destroy();
      for (let turn = 0; turn < 100 && listeners.reached.length === 0; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.deepEqual([...new Set(listeners.reached)], ['::1']);
      assert.ok(asked.length > 0 && asked.every((family) => family === 6), String(asked));
      assert.ok(asked.all.every(Boolean), `asked for one address: ${String(asked.all)}`);
    } finally {
      await listeners.close();
    }
  });

  it('one with no address of the family says so, naming the family, as the device’s connect', async (t) => {
    systemAnswering(t, [v4('127.0.0.1')]);
    const connector = tdsConnector(options(6)) ?? assert.fail('no connector was handed over');
    const error = await rejectionOf(() => connector({ host: NAME, port: 11_000 }));
    const described = describeDbError(error, options(6), 'Microsoft SQL Server');
    assert.ok(described instanceof DbRoutedUnresolvedError, `described ${String(described)}`);
    assert.equal(
      described.message,
      `127.0.0.1:1433 routed the login to ${NAME}:11000, a host name that did not resolve to ` +
        'an IPv6 address — the device is set to IPv6, and the login goes on over it',
    );
    assert.deepEqual(failedIn(described), { phase: 'connect', target: '127.0.0.1' });
  });

  it('one whose resolver does not answer says the resolver is not answering', async (t) => {
    systemAnswering(t, [], 'EAI_AGAIN');
    const connector = tdsConnector(options(6)) ?? assert.fail('no connector was handed over');
    const error = await rejectionOf(() => connector({ host: NAME, port: 11_000 }));
    assert.equal(
      describeDbError(error, options(6), 'Microsoft SQL Server').message,
      `127.0.0.1:1433 routed the login to ${NAME}:11000, a host name that did not resolve — ` +
        'the probe’s resolver is not answering (EAI_AGAIN)',
    );
  });
});
