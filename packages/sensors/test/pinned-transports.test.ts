import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { globalAgent } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import {
  HttpSimulator,
  Mailbox,
  imapServer,
  smtpServer,
  TestSnmpAgent,
  TestSshServer,
  type RunningServer,
} from '@ms/simulators';
import { SensorCatalogue } from '../src/catalogue.js';
import { BUILT_IN_SENSOR_TYPES, snmpPool, sshPool } from '../src/index.js';
import {
  CredentialsWithheldError,
  type ResolvedAddress,
  type ResolveHost,
} from '../src/support/pinned-target.js';
import { fetchHttp, type HttpRequestOptions } from '../src/support/http/request.js';
import { httpAdvanced } from '../src/types/http-advanced.js';
import { httpTransaction } from '../src/types/http-transaction.js';
import { mailImap } from '../src/types/mail-imap.js';
import { mailSmtp } from '../src/types/mail-smtp.js';
import { snmpUptime } from '../src/types/snmp-uptime.js';
import { sshLoad } from '../src/types/ssh-load.js';
import type { CheckContext, CheckExecution, SensorType } from '../src/contract.js';

/**
 * Each transport that can be pinned, against its simulator, through the catalogue (`A-41c`).
 *
 * **The device is named by a name nothing resolves.** `.invalid` is reserved never to, so the
 * only way a check reaches the simulator on 127.0.0.1 is by connecting to the address the
 * injected resolver answered with. A transport that handed the name to its socket would fail to
 * resolve it, and the test with it.
 *
 * **And the resolver rebinds.** It answers 127.0.0.1 the first time it is asked and an address
 * outside the targets every time after, which is what a device writer's own DNS would do between
 * the check and the connection. Every test counts how often it was asked: one check, one lookup.
 */

const NAME = 'device.pinned.invalid';
const INSIDE = ['127.0.0.0/8'];
/** TEST-NET-1: outside `INSIDE`, and routed nowhere. */
const ELSEWHERE = '192.0.2.77';

interface Rebinding {
  readonly resolve: ResolveHost;
  readonly calls: { host: string; family: number }[];
}

/** Answers `first` to the first lookup and `then` to every one after. */
function rebinding(
  first: readonly ResolvedAddress[] = [{ address: '127.0.0.1', family: 4 }],
  then: readonly ResolvedAddress[] = [{ address: ELSEWHERE, family: 4 }],
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

function execute(
  type: SensorType,
  dns: Rebinding,
  context: Pick<CheckContext, 'params' | 'credentials'> & { host?: string },
): Promise<CheckExecution> {
  const catalogue = new SensorCatalogue({ resolve: dns.resolve }).register(type).seal();
  return catalogue.execute(type.id, {
    sensorId: 41,
    target: { host: context.host ?? NAME, ipVersion: 'auto' },
    params: context.params,
    credentials: context.credentials,
    signal: new AbortController().signal,
  });
}

async function withheld(run: Promise<CheckExecution>): Promise<CredentialsWithheldError> {
  try {
    await run;
  } catch (error: unknown) {
    assert.ok(error instanceof CredentialsWithheldError, `threw ${String(error)}`);
    return error;
  }
  return assert.fail('the check ran');
}

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

// ---------------------------------------------------------------------------------------------
// Certificates, made here as `tls.test.ts` makes its own: a committed one expires on a date
// nobody chose.

let dir = '';
let forName: { key: string; cert: string } | undefined;
let forAnother: { key: string; cert: string } | undefined;
/** Whether this Node can be told to trust a certificate from inside the process. */
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
    dir = mkdtempSync(join(tmpdir(), 'ms-pinned-'));
    forName = certificate('name', NAME);
    forAnother = certificate('another', 'another.pinned.invalid');
  } catch {
    forName = undefined;
    forAnother = undefined;
  }
  // Both certificates trusted, so that what a verifying client refuses is the *name* on one of
  // them and not its issuer.
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
  snmpPool.closeAll();
  sshPool.closeAll();
});

/** Skips, saying why, where the machine cannot make or trust a certificate. */
function needsTrust(t: { skip(reason: string): void }): boolean {
  if (forName === undefined) {
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

describe('which types pin', () => {
  it('every SNMP, SSH, HTTP and mail type pins the kind it uses, and nothing else does', () => {
    const pinnable = new Set(['snmp', 'ssh', 'http', 'mail']);
    const catalogue = new SensorCatalogue();
    for (const type of BUILT_IN_SENSOR_TYPES) catalogue.register(type);
    let credentialed = 0;
    for (const type of BUILT_IN_SENSOR_TYPES) {
      for (const kind of type.credentialKinds ?? []) {
        credentialed += 1;
        assert.equal(
          catalogue.pinsAddress(type.id, kind),
          pinnable.has(kind),
          `${type.id} and the ${kind} kind`,
        );
      }
    }
    assert.ok(credentialed >= 20, 'the built-in set uses credentials');
    // The withheld transports, by name: a driver or PowerShell resolves the name itself.
    for (const id of ['db.postgresql', 'db.mysql', 'db.mssql']) {
      assert.equal(catalogue.pinsAddress(id, 'database'), false, id);
    }
    for (const id of ['windows.cpu', 'windows.memory', 'windows.service', 'windows.volume']) {
      assert.equal(catalogue.pinsAddress(id, 'windows'), false, id);
    }
    assert.equal(catalogue.pinsAddress('snmp.uptime', 'ssh'), false);
    assert.equal(catalogue.pinsAddress('no.such.type', 'snmp'), false);
  });

  it('a type that says it pins a kind it is not sent is refused at registration', () => {
    assert.throws(
      () => new SensorCatalogue().register({ ...snmpUptime, id: 'x.stray', pinnedKinds: ['ssh'] }),
      /says it pins the "ssh" credential kind, which is not one of its `credentialKinds`/,
    );
  });

  it('a database sensor handed a set it cannot pin is refused, and resolves nothing', async () => {
    const database = BUILT_IN_SENSOR_TYPES.find((type) => type.id === 'db.postgresql');
    assert.ok(database !== undefined);
    const dns = rebinding();
    const error = await withheld(
      execute(database, dns, {
        params: { query: 'select 1' },
        credentials: { database: { username: 'ms', password: 'pw', allowedTargets: INSIDE } },
      }),
    );
    assert.match(error.message, /this kind of sensor cannot be held to an address/);
    assert.equal(error.sensorId, 41);
    assert.equal(dns.calls.length, 0);
  });
});

describe('SNMP', () => {
  let agent: TestSnmpAgent;
  const credentials = (targets?: string[]): CheckContext['credentials'] => ({
    snmp: {
      version: 'v2c',
      community: 'public',
      ...(targets === undefined ? {} : { allowedTargets: targets }),
    },
  });
  const params = (): Record<string, unknown> => ({
    port: agent.port,
    timeoutMs: 1_000,
    retries: 0,
  });

  before(async () => {
    agent = await TestSnmpAgent.start([
      { oid: '1.3.6.1.2.1.1.3.0', type: 'TimeTicks', value: 500 },
      { oid: '1.3.6.1.2.1.25.1.1.0', type: 'TimeTicks', value: 9_000 },
    ]);
  });
  after(async () => {
    snmpPool.closeAll();
    await agent.stop();
  });
  beforeEach(() => {
    snmpPool.closeAll();
    agent.resetCounters();
  });

  it('asks the address that was checked, and resolves the name once', async () => {
    const dns = rebinding();
    const execution = await execute(snmpUptime, dns, {
      params: params(),
      credentials: credentials(INSIDE),
    });
    assert.equal(valueOf(execution, 'uptime'), 90);
    assert.ok(agent.requests > 0);
    assert.deepEqual(dns.calls, [{ host: NAME, family: 0 }]);
  });

  it('sends nothing when the name resolves outside the targets', async () => {
    const dns = rebinding([{ address: ELSEWHERE, family: 4 }]);
    const error = await withheld(
      execute(snmpUptime, dns, { params: params(), credentials: credentials(INSIDE) }),
    );
    assert.match(error.message, new RegExp(`${NAME} resolves to 192\\.0\\.2\\.77`));
    assert.equal(error.sensorId, 41);
    assert.equal(error.target, NAME);
    assert.equal(agent.requests, 0);
  });

  it('checks again at the next scan, and a name that has moved outside is refused', async () => {
    const dns = rebinding();
    const catalogue = new SensorCatalogue({ resolve: dns.resolve }).register(snmpUptime).seal();
    const context = (): CheckContext => ({
      sensorId: 41,
      target: { host: NAME, ipVersion: 'auto' },
      params: params(),
      credentials: credentials(INSIDE),
      signal: new AbortController().signal,
    });
    await catalogue.execute('snmp.uptime', context());
    const asked = agent.requests;
    // The pooled session to 127.0.0.1 is still open. It is not used for a name that now
    // resolves elsewhere: the second scan is refused before anything is sent.
    await assert.rejects(
      () => catalogue.execute('snmp.uptime', context()),
      CredentialsWithheldError,
    );
    assert.equal(agent.requests, asked);
    assert.equal(dns.calls.length, 2);
  });

  it('a name that moves to another address inside the targets is asked there, not over the session it had', async () => {
    // 127.0.0.2 is inside the targets and nothing answers on it. The pooled session to
    // 127.0.0.1 would answer: reusing it would be using an address this scan did not check.
    const dns = rebinding(
      [{ address: '127.0.0.1', family: 4 }],
      [{ address: '127.0.0.2', family: 4 }],
    );
    const catalogue = new SensorCatalogue({ resolve: dns.resolve }).register(snmpUptime).seal();
    const context = (): CheckContext => ({
      sensorId: 41,
      target: { host: NAME, ipVersion: 'auto' },
      params: { port: agent.port, timeoutMs: 300, retries: 0 },
      credentials: credentials(INSIDE),
      signal: new AbortController().signal,
    });
    await catalogue.execute('snmp.uptime', context());
    const asked = agent.requests;
    await assert.rejects(
      () => catalogue.execute('snmp.uptime', context()),
      (error: unknown) => !(error instanceof CredentialsWithheldError),
    );
    assert.equal(agent.requests, asked, 'the agent on the first address was not asked again');
    assert.equal(dns.calls.length, 2);
  });

  it('an unrestricted set makes no lookup of its own, by address or by name', async () => {
    const dns = rebinding();
    await execute(snmpUptime, dns, {
      params: params(),
      credentials: credentials(),
      host: '127.0.0.1',
    });
    await execute(snmpUptime, dns, {
      params: params(),
      credentials: credentials(),
      host: 'localhost',
    });
    assert.equal(dns.calls.length, 0);
  });

  it('a device given as an address inside the targets makes none either', async () => {
    const dns = rebinding();
    const execution = await execute(snmpUptime, dns, {
      params: params(),
      credentials: credentials(INSIDE),
      host: '127.0.0.1',
    });
    assert.equal(valueOf(execution, 'uptime'), 90);
    assert.equal(dns.calls.length, 0);
  });
});

describe('SSH', () => {
  let server: TestSshServer;
  const LOAD =
    '(cat /proc/loadavg 2>/dev/null || uptime); (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo)';
  const credentials = (targets?: string[]): CheckContext['credentials'] => ({
    ssh: {
      username: 'monitor',
      password: 'monitor',
      hostKeyPolicy: 'accept-any',
      ...(targets === undefined ? {} : { allowedTargets: targets }),
    },
  });
  const params = (): Record<string, unknown> => ({
    port: server.port,
    connectTimeoutMs: 5_000,
    commandTimeoutMs: 5_000,
  });

  before(async () => {
    server = await TestSshServer.start();
  });
  after(async () => {
    sshPool.closeAll();
    await server.stop();
  });
  beforeEach(() => {
    sshPool.closeAll();
    server.reset();
    server.answer(LOAD, { stdout: '0.50 0.40 0.30 1/100 4242\n4\n' });
  });

  it('logs in at the address that was checked, and resolves the name once', async () => {
    const dns = rebinding();
    const execution = await execute(sshLoad, dns, {
      params: params(),
      credentials: credentials(INSIDE),
    });
    assert.equal(valueOf(execution, 'load1'), 0.5);
    assert.equal(server.connections, 1);
    assert.deepEqual(dns.calls, [{ host: NAME, family: 0 }]);
  });

  it('a name that moves to another address inside the targets is not served by the connection it had', async () => {
    const dns = rebinding(
      [{ address: '127.0.0.1', family: 4 }],
      [{ address: '127.0.0.2', family: 4 }],
    );
    const catalogue = new SensorCatalogue({ resolve: dns.resolve }).register(sshLoad).seal();
    const context = (): CheckContext => ({
      sensorId: 41,
      target: { host: NAME, ipVersion: 'auto' },
      params: { ...params(), connectTimeoutMs: 2_000 },
      credentials: credentials(INSIDE),
      signal: new AbortController().signal,
    });
    await catalogue.execute('ssh.load', context());
    assert.equal(server.connections, 1);
    const ran = server.seen.length;
    // Nothing listens on 127.0.0.2. The pooled connection to 127.0.0.1 would have answered.
    await assert.rejects(
      () => catalogue.execute('ssh.load', context()),
      (error: unknown) => !(error instanceof CredentialsWithheldError),
    );
    assert.equal(
      server.seen.length,
      ran,
      'no command ran over the connection to the first address',
    );
    assert.equal(server.connections, 1);
  });

  it('opens no connection when the name resolves outside the targets', async () => {
    const dns = rebinding([
      { address: '127.0.0.1', family: 4 },
      { address: ELSEWHERE, family: 4 },
    ]);
    const error = await withheld(
      execute(sshLoad, dns, { params: params(), credentials: credentials(INSIDE) }),
    );
    assert.match(error.message, /resolves to 192\.0\.2\.77/);
    assert.equal(server.connections, 0);
  });

  it('an unrestricted set, and an address inside the targets, make no lookup', async () => {
    const dns = rebinding();
    await execute(sshLoad, dns, {
      params: params(),
      credentials: credentials(),
      host: '127.0.0.1',
    });
    sshPool.closeAll();
    await execute(sshLoad, dns, {
      params: params(),
      credentials: credentials(INSIDE),
      host: '127.0.0.1',
    });
    assert.equal(dns.calls.length, 0);
    assert.equal(server.connections, 2);
  });
});

describe('HTTP', () => {
  const credentials = (targets?: string[]): CheckContext['credentials'] => ({
    http: {
      username: 'ops',
      password: 'hunter2-long-enough',
      ...(targets === undefined ? {} : { allowedTargets: targets }),
    },
  });
  const running: HttpSimulator[] = [];
  const start = async (
    options: ConstructorParameters<typeof HttpSimulator>[0],
  ): Promise<HttpSimulator> => {
    const simulator = new HttpSimulator(options);
    await simulator.start();
    running.push(simulator);
    return simulator;
  };
  after(async () => {
    for (const simulator of running) await simulator.stop();
  });

  it('connects to the checked address, and still asks for the device by name', async () => {
    const simulator = await start({ routes: { '/status': { status: 200, body: 'ok' } } });
    const dns = rebinding();
    await execute(httpAdvanced, dns, {
      params: { scheme: 'http', port: simulator.port, path: '/status' },
      credentials: credentials(INSIDE),
    });
    assert.equal(simulator.requests.length, 1);
    assert.equal(simulator.requests[0]?.headers.host, `${NAME}:${String(simulator.port)}`);
    assert.match(simulator.requests[0].headers.authorization ?? '', /^Basic /);
    assert.deepEqual(dns.calls, [{ host: NAME, family: 0 }]);
  });

  it('follows a redirect on the same device to the same address, with no second lookup', async () => {
    const simulator = await start({
      routes: { '/old': { redirectTo: '/new' }, '/new': { status: 200, body: 'ok' } },
    });
    const dns = rebinding();
    await execute(httpAdvanced, dns, {
      params: { scheme: 'http', port: simulator.port, path: '/old' },
      credentials: credentials(INSIDE),
    });
    assert.deepEqual(simulator.paths, ['/old', '/new']);
    assert.equal(dns.calls.length, 1);
  });

  it('sends no request when the name resolves outside the targets', async () => {
    const simulator = await start({ routes: { '/status': { status: 200, body: 'ok' } } });
    const dns = rebinding([{ address: ELSEWHERE, family: 4 }]);
    const error = await withheld(
      execute(httpAdvanced, dns, {
        params: { scheme: 'http', port: simulator.port, path: '/status' },
        credentials: credentials(INSIDE),
      }),
    );
    assert.match(error.message, /resolves to 192\.0\.2\.77/);
    assert.equal(simulator.requests.length, 0);
  });

  it('the metadata guard reads the checked address, not a lookup of its own', async () => {
    // Targets that allow link-local, and a name that resolves there. `A-09`'s guard still
    // refuses it, from the pinned address: the name itself resolves to nothing it could read.
    const dns = rebinding([{ address: '169.254.169.254', family: 4 }]);
    await assert.rejects(
      () =>
        execute(httpAdvanced, dns, {
          params: { scheme: 'http', port: 80, path: '/', timeoutMs: 2_000 },
          credentials: credentials(['169.254.0.0/16']),
        }),
      /refusing to request device\.pinned\.invalid: it resolves to 169\.254\.169\.254/,
    );
    assert.equal(dns.calls.length, 1);
  });

  it('over TLS, SNI and the certificate check stay on the name', async (t) => {
    if (!needsTrust(t) || forName === undefined) return;
    const simulator = await start({
      tls: forName,
      routes: { '/status': { status: 200, body: 'ok' } },
    });
    const dns = rebinding();
    await execute(httpAdvanced, dns, {
      params: { scheme: 'https', port: simulator.port, path: '/status', verifyTls: true },
      credentials: credentials(INSIDE),
    });
    assert.equal(simulator.requests.length, 1);
    assert.equal(simulator.requests[0]?.servername, NAME);
    assert.equal(simulator.requests[0].headers.host, `${NAME}:${String(simulator.port)}`);
    assert.equal(dns.calls.length, 1);
  });

  it('over TLS, a certificate for another name is refused though the address is right', async (t) => {
    if (!needsTrust(t) || forAnother === undefined) return;
    const simulator = await start({
      tls: forAnother,
      routes: { '/status': { status: 200, body: 'ok' } },
    });
    const dns = rebinding();
    await assert.rejects(
      () =>
        execute(httpAdvanced, dns, {
          params: { scheme: 'https', port: simulator.port, path: '/status', verifyTls: true },
          credentials: credentials(INSIDE),
        }),
      /is not valid for device\.pinned\.invalid/,
    );
    assert.equal(simulator.requests.length, 0);
  });

  it('over TLS without verification, SNI is still the name', async (t) => {
    if (forName === undefined) {
      t.skip('openssl is not on this machine');
      return;
    }
    const simulator = await start({
      tls: forName,
      routes: { '/status': { status: 200, body: 'ok' } },
    });
    const dns = rebinding();
    await execute(httpAdvanced, dns, {
      params: { scheme: 'https', port: simulator.port, path: '/status', verifyTls: false },
      credentials: credentials(INSIDE),
    });
    assert.equal(simulator.requests[0]?.servername, NAME);
  });

  it('a name no set bounds is resolved once, by the target policy; an address not at all', async () => {
    // `A-54`: the metadata guard's lookup is the only one, and it is this resolver's.
    const simulator = await start({ routes: { '/status': { status: 200, body: 'ok' } } });
    const dns = rebinding();
    await execute(httpAdvanced, dns, {
      params: { scheme: 'http', port: simulator.port, path: '/status' },
      credentials: credentials(),
      host: 'localhost',
    });
    assert.deepEqual(dns.calls, [{ host: 'localhost', family: 0 }]);
    await execute(httpAdvanced, dns, {
      params: { scheme: 'http', port: simulator.port, path: '/status' },
      credentials: credentials(INSIDE),
      host: '127.0.0.1',
    });
    assert.equal(simulator.requests.length, 2);
    assert.equal(dns.calls.length, 1);
  });

  it('a pinned request whose address is not where the device listens does not fall back to the name', async () => {
    // Straight at the transport: pinned to an address nothing listens on, for a name that does
    // resolve. A request that fell back to resolving the name would reach the simulator.
    const simulator = await start({ routes: { '/status': { status: 200, body: 'ok' } } });
    await assert.rejects(
      () =>
        fetchHttp(
          {
            host: 'localhost',
            port: simulator.port,
            scheme: 'http',
            path: '/status',
            method: 'GET',
            headers: {},
            body: '',
            timeoutMs: 2_000,
            verifyTls: true,
            followRedirects: false,
            maxRedirects: 0,
            maxBodyBytes: 0,
            pinned: { address: '127.0.0.9', family: 4 },
          },
          new AbortController().signal,
        ),
      /nothing is listening|failed/,
    );
    assert.equal(simulator.requests.length, 0);
  });
});

/**
 * The metadata guard on a request no credential set pins (`A-54`).
 *
 * `A-09`'s guard resolved the name, checked the answers, and handed the name to the socket,
 * which resolved it again. The resolver here is the attacker's: harmless when it is first asked
 * and the metadata address ever after. One lookup, and a connection to what it answered.
 */
describe('HTTP, held to the address the target policy checked', () => {
  const METADATA = '169.254.169.254';
  /** Loopback, and nothing listens on it: a connection there is refused at once. */
  const DEAD = '127.0.0.9';
  const running: HttpSimulator[] = [];
  const start = async (
    options: ConstructorParameters<typeof HttpSimulator>[0],
  ): Promise<HttpSimulator> => {
    const simulator = new HttpSimulator(options);
    await simulator.start();
    running.push(simulator);
    return simulator;
  };
  after(async () => {
    for (const simulator of running) await simulator.stop();
  });
  const ok = { routes: { '/status': { status: 200, body: 'ok' } } };
  const v4 = (...addresses: string[]): ResolvedAddress[] =>
    addresses.map((address) => ({ address, family: 4 }));

  /** Straight at the transport, with a resolver of the test's own. */
  const request = (
    port: number,
    dns: Rebinding,
    overrides: Partial<HttpRequestOptions> = {},
    signal: AbortSignal = new AbortController().signal,
  ): ReturnType<typeof fetchHttp> =>
    fetchHttp(
      {
        host: NAME,
        port,
        scheme: 'http',
        path: '/status',
        method: 'GET',
        headers: {},
        body: '',
        timeoutMs: 2_000,
        verifyTls: true,
        followRedirects: true,
        maxRedirects: 5,
        maxBodyBytes: 64,
        resolve: dns.resolve,
        ...overrides,
      },
      signal,
    );

  it('asks the resolver once, and connects to what it answered then', async () => {
    const simulator = await start(ok);
    const dns = rebinding(v4('127.0.0.1'), v4(METADATA));
    await execute(httpAdvanced, dns, {
      params: { scheme: 'http', port: simulator.port, path: '/status' },
      credentials: {},
    });
    // `.invalid` resolves nowhere, so the request arrived by the address that was checked.
    assert.equal(simulator.requests.length, 1);
    assert.equal(simulator.requests[0]?.headers.host, `${NAME}:${String(simulator.port)}`);
    assert.deepEqual(dns.calls, [{ host: NAME, family: 0 }]);
  });

  it('refuses a name whose first answer is the metadata address, whatever it would say next', async () => {
    const simulator = await start(ok);
    const dns = rebinding(v4(METADATA), v4('127.0.0.1'));
    await assert.rejects(
      () => request(simulator.port, dns),
      /refusing to request device\.pinned\.invalid: it resolves to 169\.254\.169\.254.*link-local/,
    );
    assert.equal(simulator.requests.length, 0);
    assert.equal(dns.calls.length, 1);
  });

  it('refuses the whole name when any one of its addresses is refused', async () => {
    const simulator = await start(ok);
    for (const answers of [
      v4('127.0.0.1', METADATA),
      v4(METADATA, '127.0.0.1'),
      [
        { address: '127.0.0.1', family: 4 },
        { address: 'fe80::1', family: 6 },
      ],
    ]) {
      const dns = rebinding(answers, answers);
      await assert.rejects(() => request(simulator.port, dns), /refusing to request/);
      assert.equal(dns.calls.length, 1);
    }
    assert.equal(simulator.requests.length, 0);
  });

  it('follows a redirect on the device to the same checked address, with no second lookup', async () => {
    const simulator = await start({
      routes: { '/old': { redirectTo: '/new' }, '/new': { status: 200, body: 'ok' } },
    });
    const dns = rebinding(v4('127.0.0.1'), v4(METADATA));
    const response = await request(simulator.port, dns, { path: '/old' });
    assert.equal(response.status, 200);
    assert.deepEqual(simulator.paths, ['/old', '/new']);
    assert.equal(dns.calls.length, 1);
  });

  it('does not follow a redirect to another name, and never resolves it', async () => {
    // The other name is the metadata service's. A redirect that leaves the device is reported
    // and not followed, so there is no second name to resolve, check or connect to.
    const simulator = await start({ routes: { '/old': { redirectTo: '/unset' } } });
    const elsewhere = `http://metadata.pinned.invalid:${String(simulator.port)}/latest/meta-data`;
    const hop = await start({ routes: { '/old': { redirectTo: elsewhere } } });
    const dns = rebinding(v4('127.0.0.1'), v4(METADATA));
    const response = await request(hop.port, dns, { path: '/old' });
    assert.equal(response.status, 302);
    assert.equal(response.unfollowedLocation, elsewhere);
    assert.deepEqual(dns.calls, [{ host: NAME, family: 0 }]);
    assert.equal(hop.requests.length, 1);
    assert.equal(simulator.requests.length, 0);
  });

  it('each step of a transaction resolves once, and a step whose answer is refused sends nothing', async () => {
    const simulator = await start({
      routes: { '/one': { status: 200, body: 'one' }, '/two': { status: 200, body: 'two' } },
    });
    const params = {
      scheme: 'http',
      port: simulator.port,
      steps: [
        { name: 'one', path: '/one' },
        { name: 'two', path: '/two' },
      ],
    };
    // A steady resolver: two steps, two lookups, both checked, both arrive.
    const steady = rebinding(v4('127.0.0.1'), v4('127.0.0.1'));
    await execute(httpTransaction, steady, { params, credentials: {} });
    assert.deepEqual(simulator.paths, ['/one', '/two']);
    assert.equal(steady.calls.length, 2);

    // One that moves between the steps: step two is checked on its own answer, and refused.
    const moving = rebinding(v4('127.0.0.1'), v4(METADATA));
    await assert.rejects(
      () => execute(httpTransaction, moving, { params, credentials: {} }),
      /step 2 of 2 \(two\) failed: refusing to request .* 169\.254\.169\.254/,
    );
    assert.deepEqual(simulator.paths, ['/one', '/two', '/one']);
    assert.equal(moving.calls.length, 2);
  });

  it('over TLS, SNI, Host and the certificate check stay on the name', async (t) => {
    if (!needsTrust(t) || forName === undefined) return;
    const simulator = await start({ tls: forName, ...ok });
    const dns = rebinding(v4('127.0.0.1'), v4(METADATA));
    await execute(httpAdvanced, dns, {
      params: { scheme: 'https', port: simulator.port, path: '/status', verifyTls: true },
      credentials: {},
    });
    assert.equal(simulator.requests.length, 1);
    assert.equal(simulator.requests[0]?.servername, NAME);
    assert.equal(simulator.requests[0].headers.host, `${NAME}:${String(simulator.port)}`);
    assert.equal(dns.calls.length, 1);
  });

  it('over TLS, a certificate for another name is refused though the address was checked', async (t) => {
    if (!needsTrust(t) || forAnother === undefined) return;
    const simulator = await start({ tls: forAnother, ...ok });
    const dns = rebinding(v4('127.0.0.1'), v4(METADATA));
    await assert.rejects(
      () =>
        execute(httpAdvanced, dns, {
          params: { scheme: 'https', port: simulator.port, path: '/status', verifyTls: true },
          credentials: {},
        }),
      /is not valid for device\.pinned\.invalid/,
    );
    assert.equal(simulator.requests.length, 0);
    assert.equal(dns.calls.length, 1);
  });

  it('tries the next checked address when the first refuses the connection', async () => {
    const simulator = await start(ok);
    const dns = rebinding(v4(DEAD, '127.0.0.1'), v4(METADATA));
    const response = await request(simulator.port, dns);
    assert.equal(response.status, 200);
    assert.equal(simulator.requests.length, 1);
    assert.equal(dns.calls.length, 1);
  });

  it('does not send a request again that a server took and dropped', async () => {
    // Only a connection that was never made moves on: this one was, and the request went.
    const simulator = await start({ routes: { '/status': { reset: true } } });
    const dns = rebinding(v4('127.0.0.1', '127.0.0.1'), v4(METADATA));
    await assert.rejects(() => request(simulator.port, dns), /requesting .* failed/);
    assert.equal(simulator.requests.length, 1);
  });

  it('never goes past the addresses it checked: with none left, the request fails', async () => {
    const simulator = await start(ok);
    // What a second lookup would say is where the simulator is. Nobody asks.
    const dns = rebinding(v4(DEAD), v4('127.0.0.1'));
    await assert.rejects(() => request(simulator.port, dns), /nothing is listening at/);
    assert.equal(simulator.requests.length, 0);
    assert.equal(dns.calls.length, 1);
  });

  it('a name that does not resolve fails there, and the socket is not left to try', async () => {
    // `localhost` does resolve, for a socket handed the name: the simulator would be reached.
    const simulator = await start(ok);
    for (const answer of [
      (): Promise<ResolvedAddress[]> =>
        Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })),
      (): Promise<ResolvedAddress[]> => Promise.resolve([]),
      (): Promise<ResolvedAddress[]> => Promise.resolve([{ address: 'localhost', family: 4 }]),
    ]) {
      let asked = 0;
      const dns: Rebinding = {
        calls: [],
        resolve: () => {
          asked += 1;
          return answer();
        },
      };
      await assert.rejects(
        () => request(simulator.port, dns, { host: 'localhost' }),
        /the device’s host name did not resolve, requesting http:\/\/localhost:\d+\/status/,
      );
      assert.equal(asked, 1);
    }
    assert.equal(simulator.requests.length, 0);
  });

  it('an answer that is not an address is never connected to, beside one that is', async () => {
    const simulator = await start(ok);
    const dns = rebinding(
      [
        { address: 'localhost', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      v4(METADATA),
    );
    assert.equal((await request(simulator.port, dns)).status, 200);
    assert.equal(dns.calls.length, 1);
  });

  it('a resolver that does not answer is given half the request’s time, and no more', async () => {
    const simulator = await start(ok);
    let asked = 0;
    const dns: Rebinding = {
      calls: [],
      resolve: () => {
        asked += 1;
        return new Promise<ResolvedAddress[]>(() => undefined);
      },
    };
    const started = Date.now();
    await assert.rejects(
      () => request(simulator.port, dns, { timeoutMs: 600 }),
      /did not resolve within 300 ms, requesting http:\/\/device\.pinned\.invalid/,
    );
    assert.ok(Date.now() - started < 590, `took ${String(Date.now() - started)} ms`);
    assert.equal(asked, 1);
    assert.equal(simulator.requests.length, 0);
  });

  it('a check cancelled while its name is resolving ends then', async () => {
    const simulator = await start(ok);
    const dns: Rebinding = {
      calls: [],
      resolve: () => new Promise<ResolvedAddress[]>(() => undefined),
    };
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => {
      controller.abort();
    }, 50);
    await assert.rejects(
      () => request(simulator.port, dns, { timeoutMs: 20_000 }, controller.signal),
      /the check was cancelled while requesting http:\/\/device\.pinned\.invalid/,
    );
    assert.ok(Date.now() - started < 2_000);
    assert.equal(simulator.requests.length, 0);
  });

  it('an address, and any host under the `none` policy, make no lookup', async () => {
    const simulator = await start(ok);
    const dns = rebinding(v4(METADATA), v4(METADATA));
    assert.equal((await request(simulator.port, dns, { host: '127.0.0.1' })).status, 200);
    await assert.rejects(
      () => request(simulator.port, dns, { host: '169.254.1.1' }),
      /refusing to request 169\.254\.1\.1/,
    );
    const open = await request(simulator.port, dns, { host: 'localhost', targetPolicy: 'none' });
    assert.equal(open.status, 200);
    assert.equal(dns.calls.length, 0);
    assert.equal(simulator.requests.length, 2);
  });

  it('a stricter policy is applied to the same one answer', async () => {
    const simulator = await start(ok);
    const dns = rebinding(v4('127.0.0.1'), v4('127.0.0.1'));
    await assert.rejects(
      () => request(simulator.port, dns, { targetPolicy: 'private' }),
      /refusing to request device\.pinned\.invalid: it resolves to 127\.0\.0\.1, which is a private/,
    );
    assert.equal(dns.calls.length, 1);
    assert.equal(simulator.requests.length, 0);
  });

  it('no request goes through the shared agent, so none rides another check’s connection', async () => {
    const simulator = await start(ok);
    const agent = globalAgent as unknown as { createConnection: (...args: unknown[]) => unknown };
    const original = agent.createConnection;
    let pooled = 0;
    agent.createConnection = function (this: unknown, ...args: unknown[]): unknown {
      pooled += 1;
      return original.apply(this, args);
    };
    try {
      const dns = rebinding(v4('127.0.0.1'), v4(METADATA));
      await request(simulator.port, dns);
      await request(simulator.port, dns, { host: '127.0.0.1' });
      await request(simulator.port, dns, { host: 'localhost', targetPolicy: 'none' });
    } finally {
      agent.createConnection = original;
    }
    assert.equal(simulator.requests.length, 3);
    assert.equal(pooled, 0);
  });
});

describe('mail', () => {
  const mailbox = new Mailbox();
  const running: RunningServer[] = [];
  const credentials = (targets?: string[]): CheckContext['credentials'] => ({
    mail: {
      username: 'ops',
      password: 'hunter2',
      ...(targets === undefined ? {} : { allowedTargets: targets }),
    },
  });
  const start = async (
    make: typeof smtpServer,
    options: Partial<Parameters<typeof smtpServer>[0]> = {},
  ): Promise<number> => {
    const server = await make({ mailbox, username: 'ops', password: 'hunter2', ...options });
    running.push(server);
    return server.port;
  };
  after(async () => {
    for (const server of running) await server.close();
  });

  it('SMTP logs in at the checked address, and resolves the name once', async () => {
    const port = await start(smtpServer);
    const dns = rebinding();
    const execution = await execute(mailSmtp, dns, {
      params: { port, security: 'none', timeoutMs: 5_000, requireAuth: true },
      credentials: credentials(INSIDE),
    });
    assert.ok((valueOf(execution, 'totalTime') ?? -1) >= 0);
    assert.deepEqual(dns.calls, [{ host: NAME, family: 0 }]);
  });

  it('IMAP logs in at the checked address', async () => {
    const port = await start(imapServer);
    const dns = rebinding();
    await execute(mailImap, dns, {
      params: { port, security: 'none', timeoutMs: 5_000 },
      credentials: credentials(INSIDE),
    });
    assert.equal(dns.calls.length, 1);
  });

  it('says nothing to a server when the name resolves outside the targets', async () => {
    const servernames: string[] = [];
    const port = await start(smtpServer, { servernames });
    const dns = rebinding([{ address: ELSEWHERE, family: 4 }]);
    const error = await withheld(
      execute(mailSmtp, dns, {
        params: { port, security: 'none', timeoutMs: 5_000, requireAuth: true },
        credentials: credentials(INSIDE),
      }),
    );
    assert.match(error.message, /outside the allowed targets of the mail credentials/);
  });

  it('after STARTTLS, SNI and the certificate check stay on the name', async (t) => {
    if (!needsTrust(t) || forName === undefined) return;
    const servernames: string[] = [];
    const port = await start(smtpServer, { offerStartTls: true, tls: forName, servernames });
    const dns = rebinding();
    await execute(mailSmtp, dns, {
      params: { port, security: 'starttls', verifyTls: true, timeoutMs: 5_000, requireAuth: true },
      credentials: credentials(INSIDE),
    });
    assert.deepEqual(servernames, [NAME]);
    assert.equal(dns.calls.length, 1);
  });

  it('after STARTTLS, a certificate for another name is refused though the address is right', async (t) => {
    if (!needsTrust(t) || forAnother === undefined) return;
    const port = await start(smtpServer, { offerStartTls: true, tls: forAnother });
    const dns = rebinding();
    await assert.rejects(
      () =>
        execute(mailSmtp, dns, {
          params: {
            port,
            security: 'starttls',
            verifyTls: true,
            timeoutMs: 5_000,
            requireAuth: true,
          },
          credentials: credentials(INSIDE),
        }),
      /is not valid for device\.pinned\.invalid/,
    );
  });

  it('an unrestricted set, and an address inside the targets, make no lookup', async () => {
    const port = await start(smtpServer);
    const dns = rebinding();
    const params = { port, security: 'none', timeoutMs: 5_000, requireAuth: true };
    await execute(mailSmtp, dns, { params, credentials: credentials(), host: 'localhost' });
    await execute(mailSmtp, dns, { params, credentials: credentials(INSIDE), host: '127.0.0.1' });
    assert.equal(dns.calls.length, 0);
  });
});
