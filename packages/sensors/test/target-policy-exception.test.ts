import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createServer as createTcpServer, type Server, type Socket } from 'node:net';
import type { TargetPolicy } from '@ms/shared';
import {
  HttpSimulator,
  Mailbox,
  smtpServer,
  TestSshServer,
  type RunningServer,
} from '@ms/simulators';
import { SensorCatalogue } from '../src/catalogue.js';
import { sshPool } from '../src/index.js';
import {
  checkedTarget,
  guardOf,
  refuseBlockedAddress,
  refuseLocalSocket,
  TargetRefusedError,
  type TargetCheck,
} from '../src/support/checked-target.js';
import type { ResolvedAddress, ResolveHost } from '../src/support/pinned-target.js';
import { windowsOptions } from '../src/support/windows/schema.js';
import type { DbDriver } from '../src/support/db/driver.js';
import { runDbCheck } from '../src/types/db-shared.js';
import { httpRequest } from '../src/types/http.js';
import { mailSmtp } from '../src/types/mail-smtp.js';
import { portTcp } from '../src/types/port-tcp.js';
import { sshLoad } from '../src/types/ssh-load.js';
import type { CheckContext, CheckExecution, SensorType } from '../src/contract.js';
import { pollWithin } from './support/within.js';

/**
 * One device's exception to its probe's target policy (`A-64`).
 *
 * **The judgement is `checkedTarget`'s, and it is driven here as a table**: every policy, against
 * every exception, against every way a device's host can come out: an address given as it stands,
 * a name whose every answer the exception names, and a name with one answer it does not. What is
 * expected is written by hand from what each address is, not computed by the code under test.
 *
 * **Nothing here is ever sent to a link-local address**, as in `target-policy-transports`: the
 * transports are driven under `private`, which refuses loopback, so the simulators on 127.0.0.1
 * are what an exception lets a check reach, and what a check without one never reaches.
 */

const NAME = 'device.exception.invalid';
const METADATA = '169.254.169.254';

/** What a fake resolver was asked, and what it answers. */
interface Lookups {
  readonly resolve: ResolveHost;
  readonly calls: string[];
}

function answering(...addresses: string[]): Lookups {
  const calls: string[] = [];
  const answers: ResolvedAddress[] = addresses.map((address) => ({
    address,
    family: address.includes(':') ? 6 : 4,
  }));
  return {
    calls,
    resolve: (host) => {
      calls.push(host);
      return Promise.resolve(answers);
    },
  };
}

const check = (dns: Lookups, over: Partial<TargetCheck>): TargetCheck => ({
  host: NAME,
  resolve: dns.resolve,
  timeoutMs: 2_000,
  signal: new AbortController().signal,
  verb: 'connect to',
  doing: `connecting to ${NAME}:22`,
  ...over,
});

// ---------------------------------------------------------------------------------------------
// The table.

/**
 * What each address is, by hand: which policies refuse it. Loopback and RFC 1918 under `private`;
 * link-local and the metadata address under both; nothing under `none`.
 */
const REFUSED_BY: Readonly<Record<string, readonly TargetPolicy[]>> = {
  '169.254.10.5': ['link-local', 'private'],
  '169.254.10.6': ['link-local', 'private'],
  '::ffff:169.254.10.5': ['link-local', 'private'],
  'fe80::5': ['link-local', 'private'],
  '10.0.0.5': ['private'],
  '127.0.0.1': ['private'],
  [METADATA]: ['link-local', 'private'],
  '::ffff:a9fe:a9fe': ['link-local', 'private'],
  '93.184.216.34': [],
};

/**
 * Each exception, and the addresses it lets through, by hand. The metadata address is in none of
 * them, whatever the list says; a range and a zone except nothing; a mapped spelling is the IPv4
 * address it carries.
 */
const EXCEPTIONS: readonly {
  readonly name: string;
  readonly list?: string[];
  readonly names: string[];
}[] = [
  { name: 'no exception', names: [] },
  { name: 'an empty one', list: [], names: [] },
  {
    name: 'one link-local address',
    list: ['169.254.10.5'],
    names: ['169.254.10.5', '::ffff:169.254.10.5'],
  },
  {
    name: 'its mapped spelling',
    list: ['::ffff:a9fe:a05'],
    names: ['169.254.10.5', '::ffff:169.254.10.5'],
  },
  {
    name: 'a link-local, an IPv6 and a private address',
    list: ['169.254.10.5', 'FE80::5', '10.0.0.5'],
    names: ['169.254.10.5', '::ffff:169.254.10.5', 'fe80::5', '10.0.0.5'],
  },
  { name: 'loopback', list: ['127.0.0.1'], names: ['127.0.0.1'] },
  {
    name: 'the metadata address, which no exception reaches',
    list: [METADATA, '::ffff:a9fe:a9fe'],
    names: [],
  },
  {
    name: 'a range and a zone, which except nothing',
    list: ['169.254.10.0/24', 'fe80::5%eth0'],
    names: [],
  },
];

/** How a device's host comes out: an address as it stands, or a name and what it answers. */
const HOSTS: readonly {
  readonly name: string;
  readonly host: string;
  readonly answers?: string[];
}[] = [
  { name: 'the address it names', host: '169.254.10.5' },
  { name: 'an address beside it', host: '169.254.10.6' },
  { name: 'a mapped address', host: '::ffff:169.254.10.5' },
  { name: 'an IPv6 link-local address', host: 'fe80::5' },
  { name: 'a private address', host: '10.0.0.5' },
  { name: 'loopback', host: '127.0.0.1' },
  { name: 'the metadata address', host: METADATA },
  { name: 'a public address', host: '93.184.216.34' },
  { name: 'a name resolving inside the list', host: NAME, answers: ['169.254.10.5'] },
  {
    name: 'a name resolving inside the list, twice over',
    host: NAME,
    answers: ['169.254.10.5', '::ffff:169.254.10.5'],
  },
  {
    name: 'a name resolving in and out of the list',
    host: NAME,
    answers: ['169.254.10.5', '169.254.10.6'],
  },
  {
    name: 'a name resolving out and then in',
    host: NAME,
    answers: ['169.254.10.6', '169.254.10.5'],
  },
  { name: 'a name resolving to the metadata address', host: NAME, answers: [METADATA] },
  {
    name: 'a name resolving to a listed address and the metadata one',
    host: NAME,
    answers: ['169.254.10.5', '::ffff:a9fe:a9fe'],
  },
  {
    name: 'a name resolving to private and public',
    host: NAME,
    answers: ['10.0.0.5', '93.184.216.34'],
  },
  { name: 'a name resolving to loopback', host: NAME, answers: ['127.0.0.1'] },
];

const POLICIES: readonly TargetPolicy[] = ['link-local', 'private', 'none'];

describe('checkedTarget with one device’s exception: policy × exception × what was answered', () => {
  for (const policy of POLICIES) {
    for (const exception of EXCEPTIONS) {
      for (const host of HOSTS) {
        it(`${policy}, ${exception.name}, ${host.name}`, async () => {
          const addresses = host.answers ?? [host.host];
          // The first address the policy refuses and the exception does not name, or none.
          const blocked = addresses.find(
            (address) =>
              (REFUSED_BY[address] ?? assert.fail(`no row for ${address}`)).includes(policy) &&
              !exception.names.includes(address),
          );
          const dns = answering(...addresses);
          const run = checkedTarget(
            check(dns, {
              host: host.host,
              policy,
              ...(exception.list === undefined ? {} : { exception: exception.list }),
            }),
          );
          if (blocked !== undefined) {
            const error = await run.then(
              () => assert.fail('the check was let through'),
              (thrown: unknown) => thrown,
            );
            assert.ok(error instanceof TargetRefusedError, String(error));
            assert.equal(error.address, blocked);
            assert.equal(error.policy, policy);
            // A device with an exception is told why it did not cover the address.
            if ((exception.list ?? []).length > 0) {
              assert.match(error.message, /this device’s exception \(.*\) does not cover/);
            } else {
              assert.doesNotMatch(error.message, /device’s exception/);
            }
          } else {
            const checked = await run;
            if (policy === 'none' || host.answers === undefined) {
              // An address is checked as it stands, and `none` checks nothing: the transport is
              // handed the host.
              assert.equal(checked, null);
            } else {
              assert.ok(checked !== null, 'a name the policy reads is resolved');
              assert.deepEqual(
                checked.addresses.map((one) => one.address),
                addresses,
                'every answer, and only those',
              );
              assert.equal(checked.byGuard, true);
            }
          }
          // One lookup for a name the policy reads, and none for an address or under `none`.
          assert.equal(dns.calls.length, host.answers !== undefined && policy !== 'none' ? 1 : 0);
        });
      }
    }
  }
});

describe('the exception everywhere else the policy is judged', () => {
  it('reads a pinned address with the exception, and still never the metadata one', async () => {
    const dns = answering();
    const pinned = { address: '169.254.10.5', family: 4 as const };
    assert.deepEqual(await checkedTarget(check(dns, { pinned, exception: ['169.254.10.5'] })), {
      addresses: [pinned],
      byGuard: false,
    });
    await assert.rejects(checkedTarget(check(dns, { pinned })), TargetRefusedError);
    await assert.rejects(
      checkedTarget(
        check(dns, { pinned: { address: METADATA, family: 4 }, exception: [METADATA] }),
      ),
      TargetRefusedError,
    );
    assert.equal(dns.calls.length, 0);
  });

  it('never lets through a zoned address: another link’s fe80::5 is another machine', async () => {
    const exception = ['fe80::5'];
    assert.equal(await checkedTarget(check(answering(), { host: 'fe80::5', exception })), null);
    for (const host of ['fe80::5%eth1', 'fe80::5%2']) {
      const error = await checkedTarget(check(answering(), { host, exception })).then(
        () => assert.fail(`${host} was let through`),
        (thrown: unknown) => thrown,
      );
      assert.ok(error instanceof TargetRefusedError, String(error));
      assert.equal(error.address, host);
    }
    // Nor as an answer a name was given, nor as the address the probe pinned and re-checks
    // before it connects, nor where a Windows sensor names one.
    await assert.rejects(
      checkedTarget(check(answering('fe80::5%eth1'), { exception })),
      TargetRefusedError,
    );
    await assert.rejects(
      checkedTarget(
        check(answering(), { pinned: { address: 'fe80::5%eth1', family: 6 }, exception }),
      ),
      TargetRefusedError,
    );
    assert.deepEqual(
      await checkedTarget(
        check(answering(), { pinned: { address: 'fe80::5', family: 6 }, exception }),
      ),
      { addresses: [{ address: 'fe80::5', family: 6 }], byGuard: false },
    );
    assert.throws(() => {
      refuseBlockedAddress('fe80::5%eth1', 'link-local', 'connect to', exception);
    }, TargetRefusedError);
  });

  it('refuseBlockedAddress lets through the address named and no other', () => {
    refuseBlockedAddress('169.254.10.5', 'link-local', 'connect to', ['169.254.10.5']);
    refuseBlockedAddress('10.0.0.5', 'private', 'connect to', ['10.0.0.5']);
    assert.throws(() => {
      refuseBlockedAddress('169.254.10.6', 'link-local', 'connect to', ['169.254.10.5']);
    }, /169\.254\.10\.6, which is link-local .* this device’s exception \(169\.254\.10\.5\) does not cover 169\.254\.10\.6/);
    assert.throws(() => {
      refuseBlockedAddress(METADATA, 'link-local', 'connect to', [METADATA]);
    }, TargetRefusedError);
    assert.throws(() => {
      refuseBlockedAddress('169.254.10.5', 'link-local', 'connect to');
    }, TargetRefusedError);
  });

  it('refuseLocalSocket reads a path as 127.0.0.1, exception and all', () => {
    refuseLocalSocket('/var/run/postgresql', 'private', 'connect to', ['127.0.0.1']);
    assert.throws(() => {
      refuseLocalSocket('/var/run/postgresql', 'private', 'connect to', ['127.0.0.2']);
    }, /socket on this probe’s own machine.* this device’s exception \(127\.0\.0\.2\)/);
    assert.throws(() => {
      refuseLocalSocket('/var/run/postgresql', 'private', 'connect to');
    }, TargetRefusedError);
  });

  it('guardOf carries the exception with the host, and no exception where there is none', () => {
    const target = {
      host: NAME,
      ipVersion: 'auto' as const,
      policy: 'private' as const,
      policyException: ['10.0.0.5'],
    };
    assert.deepEqual(guardOf(target).exception, ['10.0.0.5']);
    assert.equal('exception' in guardOf({ host: NAME, ipVersion: 'auto' }), false);
  });

  it('a Windows sensor’s address is read with the device’s exception', () => {
    const windows = (host: string, params: Record<string, unknown>, policyException?: string[]) =>
      windowsOptions({
        sensorId: 64,
        target: {
          host,
          ipVersion: 'auto',
          policy: 'private',
          ...(policyException === undefined ? {} : { policyException }),
        },
        params,
        credentials: {},
        signal: new AbortController().signal,
      });
    assert.equal(windows('10.1.2.3', {}, ['10.1.2.3']).host, '10.1.2.3');
    assert.equal(windows('server01', { host: '10.1.2.3' }, ['10.1.2.3']).host, '10.1.2.3');
    assert.throws(() => windows('10.1.2.3', {}), TargetRefusedError);
    assert.throws(() => windows('10.1.2.3', {}, ['10.1.2.4']), TargetRefusedError);
  });

  it('a PostgreSQL socket path is let through only where the exception names loopback', async () => {
    const connects: string[] = [];
    const driver: DbDriver = {
      id: 'postgresql',
      name: 'PostgreSQL',
      defaultPort: 5432,
      connect: (options) => {
        connects.push(options.host);
        return Promise.resolve({
          query: () => Promise.resolve({ rows: [{ count: '1' }], columns: ['count'] }),
          close: () => Promise.resolve(),
        });
      },
    };
    const context = (policyException?: string[]): CheckContext => ({
      sensorId: 64,
      target: {
        host: '/var/run/postgresql',
        ipVersion: 'auto',
        policy: 'private',
        ...(policyException === undefined ? {} : { policyException }),
      },
      params: { query: 'select 1' },
      credentials: { database: { username: 'monitor', password: 'secret' } },
      signal: new AbortController().signal,
    });
    await assert.rejects(runDbCheck(driver, context()), TargetRefusedError);
    await assert.rejects(runDbCheck(driver, context(['10.0.0.5'])), TargetRefusedError);
    assert.deepEqual(connects, []);
    await runDbCheck(driver, context(['127.0.0.1']));
    assert.deepEqual(connects, ['/var/run/postgresql']);
  });
});

// ---------------------------------------------------------------------------------------------
// Through the catalogue and a real transport, under `private`, at loopback simulators.

interface Run {
  readonly params: Record<string, unknown>;
  readonly credentials?: CheckContext['credentials'];
  readonly host?: string;
  readonly exception?: string[];
}

function contextOf(run: Run): CheckContext {
  return {
    sensorId: 64,
    target: {
      host: run.host ?? NAME,
      ipVersion: 'auto',
      // What arrives with the assignment. A `policy` arriving beside it would be dropped.
      policy: 'none',
      ...(run.exception === undefined ? {} : { policyException: run.exception }),
    },
    params: run.params,
    credentials: run.credentials ?? {},
    signal: new AbortController().signal,
  };
}

function execute(type: SensorType, dns: Lookups, run: Run): Promise<CheckExecution> {
  return new SensorCatalogue({ resolve: dns.resolve, targetPolicy: 'private' })
    .register(type)
    .seal()
    .execute(type.id, contextOf(run));
}

async function refused(run: Promise<unknown>): Promise<TargetRefusedError> {
  const error = await run.then(
    () => assert.fail('the check ran'),
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof TargetRefusedError, String(error));
  return error;
}

/** A listener on loopback that counts who connected and says nothing. */
async function counting(): Promise<{
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}> {
  let connections = 0;
  const sockets = new Set<Socket>();
  const server: Server = createTcpServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        for (const socket of sockets) socket.destroy();
      }),
  };
}

describe('the catalogue hands a check the exception it arrived with', () => {
  const seen: (readonly string[] | undefined)[] = [];
  const witness: SensorType = {
    id: 'test.exception-witness',
    category: 'Test',
    costHint: 'light',
    declaresEveryChannel: true,
    paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
    channels: () => [{ key: 'ok', name: 'Ok', isPrimary: true }],
    execute: (context) => {
      seen.push(context.target.policyException);
      return Promise.resolve({ channels: [{ key: 'ok', value: 1 }] });
    },
  };

  it('as it is, beside the probe’s own policy, and nothing where none arrived', async () => {
    seen.length = 0;
    const dns = answering();
    await execute(witness, dns, { params: {}, host: '127.0.0.1', exception: ['169.254.10.5'] });
    await execute(witness, dns, { params: {}, host: '127.0.0.1' });
    assert.deepEqual(seen, [['169.254.10.5'], undefined]);
  });
});

describe('TCP port, under `private`', () => {
  let listener: Awaited<ReturnType<typeof counting>>;
  before(async () => {
    listener = await counting();
  });
  after(async () => {
    await listener.close();
  });
  const params = (): Record<string, unknown> => ({ port: listener.port, timeoutMs: 2_000 });

  it('connects to loopback where the device’s exception names it, and nowhere else', async () => {
    await refused(execute(portTcp, answering('127.0.0.1'), { params: params() }));
    await refused(
      execute(portTcp, answering('127.0.0.1'), { params: params(), exception: ['127.0.0.2'] }),
    );
    // A name answering a listed address and one beside it is refused on the second.
    await refused(
      execute(portTcp, answering('127.0.0.1', '127.0.0.2'), {
        params: params(),
        exception: ['127.0.0.1'],
      }),
    );
    assert.equal(listener.connections(), 0, 'nothing refused was sent anything');

    const dns = answering('127.0.0.1');
    const execution = await execute(portTcp, dns, { params: params(), exception: ['127.0.0.1'] });
    assert.ok((execution.channels.find((one) => one.key === 'connectTime')?.value ?? -1) >= 0);
    assert.deepEqual(dns.calls, [NAME]);
    await pollWithin(3_000, 'the listener’s accept', () => listener.connections() === 1);
    await execute(portTcp, answering(), {
      params: params(),
      host: '127.0.0.1',
      exception: ['127.0.0.1'],
    });
    await pollWithin(3_000, 'the second accept', () => listener.connections() === 2);
  });
});

describe('HTTP, under `private`', () => {
  let simulator: HttpSimulator;
  before(async () => {
    simulator = new HttpSimulator({ routes: { '/status': { status: 200, body: 'ok' } } });
    await simulator.start();
  });
  after(async () => {
    await simulator.stop();
  });
  const params = (): Record<string, unknown> => ({
    scheme: 'http',
    port: simulator.port,
    path: '/status',
  });

  it('requests loopback where the device’s exception names it, and nowhere else', async () => {
    await refused(execute(httpRequest, answering('127.0.0.1'), { params: params() }));
    await refused(
      execute(httpRequest, answering('127.0.0.1'), { params: params(), exception: ['10.0.0.1'] }),
    );
    assert.equal(simulator.requests.length, 0);
    await execute(httpRequest, answering('127.0.0.1'), {
      params: params(),
      exception: ['127.0.0.1'],
    });
    assert.equal(simulator.requests.length, 1);
  });
});

describe('mail, under `private`', () => {
  const mailbox = new Mailbox();
  let server: RunningServer;
  before(async () => {
    server = await smtpServer({ mailbox, username: 'ops', password: 'hunter2' });
  });
  after(async () => {
    await server.close();
  });
  const run = (exception?: string[]): Run => ({
    params: { port: server.port, security: 'none', timeoutMs: 5_000, requireAuth: true },
    credentials: { mail: { username: 'ops', password: 'hunter2' } },
    ...(exception === undefined ? {} : { exception }),
  });

  it('logs in at loopback where the device’s exception names it, and nowhere else', async () => {
    await refused(execute(mailSmtp, answering('127.0.0.1'), run()));
    await refused(execute(mailSmtp, answering('127.0.0.1'), run(['127.0.0.2'])));
    const execution = await execute(mailSmtp, answering('127.0.0.1'), run(['127.0.0.1']));
    assert.ok(execution.channels.length > 0);
  });
});

describe('SSH, under `private`', () => {
  let server: TestSshServer;
  const LOAD =
    '(cat /proc/loadavg 2>/dev/null || uptime); (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo)';
  const run = (exception?: string[]): Run => ({
    params: { port: server.port, connectTimeoutMs: 5_000, commandTimeoutMs: 5_000 },
    credentials: {
      ssh: { username: 'monitor', password: 'monitor', hostKeyPolicy: 'accept-any' },
    },
    ...(exception === undefined ? {} : { exception }),
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

  it('logs in where the exception names the address, and a held connection does not outlive it', async () => {
    await refused(execute(sshLoad, answering('127.0.0.1'), run()));
    assert.equal(server.connections, 0);

    await execute(sshLoad, answering('127.0.0.1'), run(['127.0.0.1']));
    assert.equal(server.connections, 1);
    // Held, and used again while the exception stands, with no second lookup.
    const again = answering('127.0.0.1');
    await execute(sshLoad, again, run(['127.0.0.1']));
    assert.equal(server.connections, 1);
    assert.equal(again.calls.length, 0);

    // **Withdrawn, the connection it allowed is not handed to the next check**: the pool never
    // asks the guard about one it holds, so the exception is in its key.
    await refused(execute(sshLoad, answering('127.0.0.1'), run()));
    await refused(execute(sshLoad, answering('127.0.0.1'), run(['127.0.0.2'])));
    assert.equal(server.connections, 1);
  });
});
