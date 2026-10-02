import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import {
  connect as netConnect,
  createServer as createTcpServer,
  type LookupFunction,
  type Server,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';
import type { TargetPolicy } from '@ms/shared';
import {
  HttpSimulator,
  Mailbox,
  smtpServer,
  TestSnmpAgent,
  TestSshServer,
  type RunningServer,
} from '@ms/simulators';
import { SensorCatalogue } from '../src/catalogue.js';
import { snmpPool, sshPool } from '../src/index.js';
import {
  checkedLookup,
  checkedTarget,
  guardOf,
  lookupFor,
  refuseBlockedAddress,
  TARGET_POLICY_ENV,
  targetPolicyFrom,
  TargetRefusedError,
  type TargetCheck,
} from '../src/support/checked-target.js';
import {
  CredentialsWithheldError,
  type ResolvedAddress,
  type ResolveHost,
} from '../src/support/pinned-target.js';
import { pingCommand } from '../src/support/ping.js';
import { readCredentials as readSnmpCredentials } from '../src/support/snmp/credentials.js';
import { SnmpSessionPool } from '../src/support/snmp/pool.js';
import { windowsOptions } from '../src/support/windows/schema.js';
import type { DbDriver } from '../src/support/db/driver.js';
import { runDbCheck } from '../src/types/db-shared.js';
import { httpRequest } from '../src/types/http.js';
import { icmpJitter } from '../src/types/icmp-jitter.js';
import { icmpPing } from '../src/types/icmp-ping.js';
import { mailSmtp } from '../src/types/mail-smtp.js';
import { portRange } from '../src/types/port-range.js';
import { portTcp } from '../src/types/port-tcp.js';
import { snmpUptime } from '../src/types/snmp-uptime.js';
import { sshLoad } from '../src/types/ssh-load.js';
import { tlsCertificate } from '../src/types/tls-certificate.js';
import { tlsSecurity } from '../src/types/tls-security.js';
import type { CheckContext, CheckExecution, SensorType } from '../src/contract.js';

/**
 * The probe's target policy on every transport that connects to a device (`A-57`).
 *
 * **The device is named by a name nothing resolves**, as in `pinned-transports.test.ts`: the only
 * way a check reaches the simulator on 127.0.0.1 is by connecting to an address the injected
 * resolver answered with. A transport that handed the name on would fail to resolve it.
 *
 * **Nothing here is ever sent to a link-local address.** Every case that names one is a case
 * that must be refused before a socket exists, and on a cloud machine 169.254.169.254 answers.
 * "Nothing was sent" is shown with a name that has one address a simulator listens on and one
 * the policy refuses: a transport that connected before every answer was checked, or in spite
 * of the refusal, would arrive at the simulator, and its counters stay at zero.
 */

const NAME = 'device.policy.invalid';
const METADATA = '169.254.169.254';
/** 169.254.169.254 inside an IPv6 address, in both spellings. */
const MAPPED = ['::ffff:169.254.169.254', '::ffff:a9fe:a9fe'];
/** Loopback, and nothing listens on it: a connection there is refused at once. */
const DEAD = '127.0.0.9';
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

interface Run {
  readonly params: Record<string, unknown>;
  readonly credentials?: CheckContext['credentials'];
  readonly host?: string;
  readonly ipVersion?: 'auto' | 'v4' | 'v6';
  readonly policy?: TargetPolicy;
}

function catalogueOf(type: SensorType, dns: Rebinding, policy?: TargetPolicy): SensorCatalogue {
  return new SensorCatalogue({ resolve: dns.resolve, targetPolicy: policy ?? 'link-local' })
    .register(type)
    .seal();
}

const contextOf = (run: Run): CheckContext => ({
  sensorId: 57,
  target: { host: run.host ?? NAME, ipVersion: run.ipVersion ?? 'auto' },
  params: run.params,
  credentials: run.credentials ?? {},
  signal: new AbortController().signal,
});

/** Through the catalogue, as a probe runs a check. */
function execute(type: SensorType, dns: Rebinding, run: Run): Promise<CheckExecution> {
  return catalogueOf(type, dns, run.policy).execute(type.id, contextOf(run));
}

/** The policy's refusal, or a failed assertion saying what happened in its place. */
async function refused(run: Promise<unknown>): Promise<TargetRefusedError> {
  try {
    await run;
  } catch (error: unknown) {
    assert.ok(error instanceof TargetRefusedError, `threw ${String(error)}`);
    // An ordinary failed check: nothing a runner reads as a refusal over credentials.
    assert.equal(error instanceof CredentialsWithheldError, false);
    assert.equal((error as { code?: unknown }).code, undefined);
    return error;
  }
  return assert.fail('the check ran');
}

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

/** A check as a transport asks for it, with a resolver of the test's own. */
const check = (dns: Rebinding, over: Partial<TargetCheck> = {}): TargetCheck => ({
  host: NAME,
  resolve: dns.resolve,
  timeoutMs: 2_000,
  signal: new AbortController().signal,
  verb: 'connect to',
  doing: `connecting to ${NAME}:22`,
  ...over,
});

/** A listener on loopback that counts who connected and says nothing. */
async function counting(): Promise<{ port: number; connections: () => number; server: Server }> {
  let connections = 0;
  const server = tracked(
    createTcpServer((socket) => {
      connections += 1;
      socket.on('error', () => undefined);
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    connections: () => connections,
    server,
  };
}

/** Closed, with whatever is still connected to it: `close` alone waits for those. */
const closed = (server: Server): Promise<void> =>
  new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
    for (const socket of live.get(server) ?? []) socket.destroy();
  });

const live = new WeakMap<Server, Set<Socket>>();

/** Remembers a server's connections, so that `closed` can end them. */
function tracked<T extends Server>(server: T): T {
  const sockets = new Set<Socket>();
  live.set(server, sockets);
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return server;
}

/** Waits for something the far end does on its own time, with a bound of its own. */
async function until(done: () => boolean, what: string, withinMs = 3_000): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`${what} did not happen within ${String(withinMs)} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Answers `answers` once `delayMs` has passed, and counts how often it was asked. */
function slow(delayMs: number, answers: readonly ResolvedAddress[] = v4('127.0.0.1')): Rebinding {
  const calls: { host: string; family: number }[] = [];
  return {
    calls,
    resolve: (host, family) => {
      calls.push({ host, family });
      return new Promise((resolve) => setTimeout(resolve, delayMs, answers));
    },
  };
}

/**
 * A loopback port that takes a connection's first packet and never answers it, or null where
 * this machine will not make one.
 *
 * A listener in a thread that then stops running: nothing accepts, so once the kernel's queue
 * for it is full a new connection gets no answer at all. That is the one thing a timeout on
 * the *connect* can be shown against without sending a packet off this machine.
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
  // Connections are taken by the kernel until its queue is full; the first that is still
  // connecting after a while is the proof that the next one will hang too.
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

/** What a socket would be told, by either of the two shapes Node asks in. */
function ask(
  lookup: LookupFunction,
  hostname: string,
  options: { all?: boolean; family?: number },
): Promise<{ error: Error | null; answer: unknown; family: number | undefined }> {
  return new Promise((resolve) => {
    lookup(hostname, options, (error, answer, family) => {
      resolve({ error, answer, family });
    });
  });
}

// ---------------------------------------------------------------------------------------------

describe('checkedTarget: one lookup, every answer checked', () => {
  it('resolves a name once, for the family asked, and hands back what it checked', async () => {
    const dns = rebinding([
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ]);
    const checked = await checkedTarget(check(dns));
    assert.deepEqual(checked, {
      addresses: [
        { address: '127.0.0.1', family: 4 },
        { address: '::1', family: 6 },
      ],
      byGuard: true,
    });
    assert.deepEqual(dns.calls, [{ host: NAME, family: 0 }]);

    const six = rebinding([
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ]);
    // A resolver that answers with more than it was asked for is not believed about the rest.
    assert.deepEqual((await checkedTarget(check(six, { family: 6 })))?.addresses, [
      { address: '::1', family: 6 },
    ]);
    assert.deepEqual(six.calls, [{ host: NAME, family: 6 }]);
  });

  it('refuses the whole name when any one answer is refused, wherever it is in the list', async () => {
    for (const answers of [v4(METADATA, '127.0.0.1'), v4('127.0.0.1', METADATA)]) {
      const dns = rebinding(answers);
      const error = await refused(checkedTarget(check(dns)));
      assert.equal(error.address, METADATA);
      assert.equal(dns.calls.length, 1);
    }
  });

  it('says the device, the address and the policy, and how to turn it off', async () => {
    const error = await refused(checkedTarget(check(rebinding(v4(METADATA)))));
    assert.equal(error.target, NAME);
    assert.equal(error.address, METADATA);
    assert.equal(error.policy, 'link-local');
    assert.equal(error.phase, 'check');
    assert.equal(
      error.message,
      `refusing to connect to ${NAME}: it resolves to ${METADATA}, which is link-local — this ` +
        'is where cloud instance metadata lives; this probe’s target policy (link-local) ' +
        'refuses it, as it does every cloud instance-metadata address, and probe.targetPolicy ' +
        '“none” refuses nothing',
    );
    // A device given as the address is not said to resolve to itself.
    const literal = await refused(checkedTarget(check(rebinding(), { host: '169.254.7.7' })));
    assert.match(literal.message, /^refusing to connect to 169\.254\.7\.7, which is link-local/);
    assert.equal(literal.address, '169.254.7.7');
  });

  it('checks an address as it stands and resolves nothing', async () => {
    const dns = rebinding();
    assert.equal(await checkedTarget(check(dns, { host: '127.0.0.1' })), null);
    assert.equal(await checkedTarget(check(dns, { host: '::1' })), null);
    for (const host of [METADATA, 'fe80::1', 'fd00:ec2::254', ...MAPPED]) {
      await refused(checkedTarget(check(dns, { host })));
    }
    assert.equal(dns.calls.length, 0);
  });

  it('refuses an IPv4-mapped spelling of the metadata address as an answer too', async () => {
    for (const address of MAPPED) {
      const dns = rebinding([
        { address: '127.0.0.1', family: 4 },
        { address, family: 6 },
      ]);
      const error = await refused(checkedTarget(check(dns)));
      assert.equal(error.address, address);
      assert.match(error.message, /which is link-local/);
    }
  });

  it('under `none` checks nothing and resolves nothing, and `private` refuses more', async () => {
    const dns = rebinding();
    assert.equal(await checkedTarget(check(dns, { policy: 'none' })), null);
    // Not sent anywhere: this asks only what the guard says about it.
    assert.equal(await checkedTarget(check(dns, { policy: 'none', host: '169.254.7.7' })), null);
    assert.equal(dns.calls.length, 0);

    const error = await refused(checkedTarget(check(rebinding(), { policy: 'private' })));
    assert.equal(error.policy, 'private');
    assert.match(
      error.message,
      /it resolves to 127\.0\.0\.1, which is a private address; .*\(private\)/,
    );
  });

  it('checks the address a credential set pinned, and never resolves beside it', async () => {
    const dns = rebinding();
    const pinned = { address: '127.0.0.1', family: 4 } as const;
    assert.deepEqual(await checkedTarget(check(dns, { pinned })), {
      addresses: [pinned],
      byGuard: false,
    });
    const error = await refused(
      checkedTarget(check(dns, { pinned: { address: METADATA, family: 4 } })),
    );
    assert.match(error.message, new RegExp(`${NAME}: it resolves to 169\\.254\\.169\\.254`));
    // Under `none` the pin is still where the check goes.
    assert.deepEqual(await checkedTarget(check(dns, { pinned, policy: 'none' })), {
      addresses: [pinned],
      byGuard: false,
    });
    assert.equal(dns.calls.length, 0);
  });

  it('fails a name that does not resolve, and never leaves it to the socket', async () => {
    const failing: ResolveHost = () =>
      Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    await assert.rejects(
      () => checkedTarget(check(rebinding(), { resolve: failing })),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof TargetRefusedError) &&
        error.message ===
          `the device’s host name did not resolve to an address, connecting to ${NAME}:22 (ENOTFOUND)`,
    );
    // No answer the transport would use: nothing, a name where an address belongs, or only
    // the other family.
    for (const [answers, family, words] of [
      [[], 0, 'an address'],
      [[{ address: 'not-an-address', family: 4 }], 0, 'an address'],
      [v4('127.0.0.1'), 6, 'an IPv6 address'],
      [[{ address: '::1', family: 6 }], 4, 'an IPv4 address'],
    ] as const) {
      await assert.rejects(
        () => checkedTarget(check(rebinding(answers), { family })),
        new RegExp(`^Error: the device’s host name did not resolve to ${words}, connecting to`),
      );
    }
    // The transport's own words, where it has them, for both ways of not resolving.
    const said: unknown[] = [];
    const unresolved = (error: unknown): Error => {
      said.push(error);
      return new Error('in the transport’s words');
    };
    await assert.rejects(
      () => checkedTarget(check(rebinding(), { resolve: failing, unresolved })),
      /^Error: in the transport’s words$/,
    );
    await assert.rejects(
      () => checkedTarget(check(rebinding([]), { unresolved })),
      /^Error: in the transport’s words$/,
    );
    assert.equal((said[0] as { code?: string }).code, 'ENOTFOUND');
    assert.equal(said[1], undefined);
  });

  it('gives a resolver that does not answer half the check’s time, and ends with the check', async () => {
    const hanging: ResolveHost = () => new Promise(() => undefined);
    const started = process.hrtime.bigint();
    await assert.rejects(
      () => checkedTarget(check(rebinding(), { resolve: hanging, timeoutMs: 600 })),
      new RegExp(
        `^Error: the device’s host name did not resolve within 300 ms, connecting to ${NAME}:22 — ` +
          'the probe’s resolver is not answering$',
      ),
    );
    const tookMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(tookMs >= 250 && tookMs < 5_000, `took ${String(tookMs)} ms`);

    const controller = new AbortController();
    const pending = checkedTarget(
      check(rebinding(), { resolve: hanging, timeoutMs: 60_000, signal: controller.signal }),
    );
    setTimeout(() => {
      controller.abort();
    }, 30);
    await assert.rejects(
      () => pending,
      new RegExp(`^Error: the check was cancelled while connecting to ${NAME}:22$`),
    );
  });

  it('guardOf carries the pin, the policy and the resolver with the host', () => {
    const resolve: ResolveHost = () => Promise.resolve([]);
    const pinned = { address: '127.0.0.1', family: 4 } as const;
    assert.deepEqual(guardOf({ host: NAME, ipVersion: 'auto' }), { host: NAME });
    assert.deepEqual(guardOf({ host: NAME, ipVersion: 'v6', pinned, resolve, policy: 'private' }), {
      host: NAME,
      pinned,
      resolve,
      policy: 'private',
    });
  });
});

describe('checkedLookup: what a socket is told', () => {
  const both = [
    { address: '127.0.0.9', family: 4 },
    { address: '::1', family: 6 },
    { address: '127.0.0.1', family: 4 },
  ] as const;

  it('answers the name with every checked address, or the first, as the socket asks', async () => {
    const lookup = checkedLookup(NAME, both);
    const all = await ask(lookup, NAME, { all: true });
    assert.equal(all.error, null);
    assert.deepEqual(all.answer, [
      { address: '127.0.0.9', family: 4 },
      { address: '::1', family: 6 },
      { address: '127.0.0.1', family: 4 },
    ]);
    const one = await ask(lookup, NAME, {});
    assert.deepEqual([one.error, one.answer, one.family], [null, '127.0.0.9', 4]);
  });

  it('keeps to the family the socket asks for', async () => {
    const lookup = checkedLookup(NAME, both);
    const six = await ask(lookup, NAME, { family: 6 });
    assert.deepEqual([six.answer, six.family], ['::1', 6]);
    const four = await ask(lookup, NAME, { family: 4, all: true });
    assert.deepEqual(four.answer, [
      { address: '127.0.0.9', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    const none = await ask(checkedLookup(NAME, [{ address: '127.0.0.1', family: 4 }]), NAME, {
      family: 6,
    });
    assert.equal((none.error as { code?: string } | null)?.code, 'ENOTFOUND');
  });

  it('answers no other name, and reads the device’s own whatever its case or final dot', async () => {
    const lookup = checkedLookup(NAME, both);
    const other = await ask(lookup, 'elsewhere.invalid', { all: true });
    assert.match(
      other.error?.message ?? '',
      /asked to resolve elsewhere\.invalid, which is not the name that was checked against the target policy/,
    );
    assert.equal(other.error instanceof CredentialsWithheldError, false);
    const same = await ask(lookup, `${NAME.toUpperCase()}.`, {});
    assert.equal(same.answer, '127.0.0.9');
  });

  it('lookupFor hooks a socket only for addresses the guard resolved', () => {
    const addresses = [{ address: '127.0.0.1', family: 4 }] as const;
    assert.deepEqual(lookupFor(NAME, null), {});
    // A credential set's pin is its transport's to answer, with `pinnedLookup`.
    assert.deepEqual(lookupFor(NAME, { addresses, byGuard: false }), {});
    assert.equal(typeof lookupFor(NAME, { addresses, byGuard: true }).lookup, 'function');
  });
});

describe('the probe’s setting', () => {
  it('is read from the environment the probe set, and a typo is the default', () => {
    assert.equal(TARGET_POLICY_ENV, 'MS_TARGET_POLICY');
    assert.equal(targetPolicyFrom({}), 'link-local');
    assert.equal(targetPolicyFrom({ MS_TARGET_POLICY: 'none' }), 'none');
    assert.equal(targetPolicyFrom({ MS_TARGET_POLICY: ' private ' }), 'private');
    assert.equal(targetPolicyFrom({ MS_TARGET_POLICY: 'link-local' }), 'link-local');
    for (const typo of ['None', 'off', '', 'no']) {
      assert.equal(targetPolicyFrom({ MS_TARGET_POLICY: typo }), 'link-local', typo);
    }
  });

  /** A type that only says what policy it was handed. */
  const seen: (TargetPolicy | undefined)[] = [];
  const witness: SensorType = {
    id: 'test.witness',
    category: 'Test',
    costHint: 'light',
    paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
    channels: () => [{ key: 'ok', name: 'Ok', isPrimary: true }],
    execute: (context) => {
      seen.push(context.target.policy);
      return Promise.resolve({ channels: [{ key: 'ok', value: 1 }] });
    },
  };
  const context = (policy?: TargetPolicy): CheckContext => ({
    sensorId: 57,
    target: { host: '127.0.0.1', ipVersion: 'auto', ...(policy === undefined ? {} : { policy }) },
    params: {},
    credentials: {},
    signal: new AbortController().signal,
  });

  it('the catalogue hands every check the policy it was built with, whatever the check arrived with', async () => {
    seen.length = 0;
    const strict = new SensorCatalogue({ targetPolicy: 'private' }).register(witness).seal();
    await strict.execute('test.witness', context());
    // A check does not choose its own.
    await strict.execute('test.witness', context('none'));
    assert.deepEqual(seen, ['private', 'private']);
  });

  it('a catalogue built with no options, as a worker builds it, reads the probe’s environment', async () => {
    seen.length = 0;
    const saved = process.env[TARGET_POLICY_ENV];
    try {
      Reflect.deleteProperty(process.env, TARGET_POLICY_ENV);
      await new SensorCatalogue().register(witness).seal().execute('test.witness', context());
      process.env[TARGET_POLICY_ENV] = 'none';
      await new SensorCatalogue().register(witness).seal().execute('test.witness', context());
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, TARGET_POLICY_ENV);
      else process.env[TARGET_POLICY_ENV] = saved;
    }
    assert.deepEqual(seen, ['link-local', 'none']);
  });
});

// ---------------------------------------------------------------------------------------------

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

  it('refuses a name that answers the metadata address, with one lookup and nothing sent', async () => {
    const dns = rebinding(v4(METADATA));
    const error = await refused(
      execute(snmpUptime, dns, { params: params(), credentials: credentials() }),
    );
    assert.match(
      error.message,
      new RegExp(
        `^refusing to query ${NAME}: it resolves to 169\\.254\\.169\\.254, .*\\(link-local\\)`,
      ),
    );
    assert.equal(error.target, NAME);
    // Over IPv4, which is the transport a name has always been asked over.
    assert.deepEqual(dns.calls, [{ host: NAME, family: 4 }]);

    // One address the agent answers on and one refused: nothing is asked of either.
    const mixed = rebinding(v4('127.0.0.1', METADATA));
    await refused(execute(snmpUptime, mixed, { params: params(), credentials: credentials() }));
    assert.equal(mixed.calls.length, 1);
    assert.equal(agent.requests, 0);
  });

  it('asks a resolver that would answer differently the second time once, at what it answered then', async () => {
    const dns = rebinding();
    const execution = await execute(snmpUptime, dns, {
      params: params(),
      credentials: credentials(),
    });
    assert.equal(valueOf(execution, 'uptime'), 90);
    assert.ok(agent.requests > 0);
    assert.equal(dns.calls.length, 1);
  });

  it('checks again at the next scan, and the session it had is not used for a name that has moved', async () => {
    const dns = rebinding();
    const catalogue = catalogueOf(snmpUptime, dns);
    const context = (): CheckContext => contextOf({ params: params(), credentials: credentials() });
    await catalogue.execute('snmp.uptime', context());
    const asked = agent.requests;
    // The pooled session to 127.0.0.1 is still open, and would answer.
    await refused(catalogue.execute('snmp.uptime', context()));
    assert.equal(agent.requests, asked);
    assert.equal(dns.calls.length, 2);
  });

  it('keeps its one session while the name’s answers only rotate', async () => {
    const both = v4('127.0.0.1', '127.0.0.2');
    const dns = rebinding(both, [...both].reverse());
    const catalogue = catalogueOf(snmpUptime, dns);
    const context = (): CheckContext => contextOf({ params: params(), credentials: credentials() });
    const opened = snmpPool.stats().opened;
    for (let scan = 0; scan < 3; scan += 1) {
      assert.equal(valueOf(await catalogue.execute('snmp.uptime', context()), 'uptime'), 90);
    }
    // One lookup a scan, as there was one a datagram before; and one session throughout.
    assert.equal(dns.calls.length, 3);
    assert.equal(snmpPool.stats().opened, opened + 1);
    assert.equal(snmpPool.stats().sessions, 1);
  });

  it('moves to the new address when the name really has moved, and closes the session it had', async () => {
    // Nothing answers on 127.0.0.2. The session to 127.0.0.1 would: using it would be asking
    // an address this scan's lookup did not answer with.
    const dns = rebinding(v4('127.0.0.1'), v4('127.0.0.2'));
    const catalogue = catalogueOf(snmpUptime, dns);
    const context = (): CheckContext =>
      contextOf({
        params: { port: agent.port, timeoutMs: 300, retries: 0 },
        credentials: credentials(),
      });
    const before = snmpPool.stats();
    await catalogue.execute('snmp.uptime', context());
    const asked = agent.requests;
    await assert.rejects(
      () => catalogue.execute('snmp.uptime', context()),
      (error: unknown) => !(error instanceof TargetRefusedError),
    );
    assert.equal(agent.requests, asked, 'the agent on the first address was not asked again');
    const after = snmpPool.stats();
    assert.equal(after.opened, before.opened + 2);
    assert.equal(after.closed, before.closed + 1);
    assert.equal(after.sessions, 1);
  });

  it('does not close a session under the check still using it when the name moves', () => {
    const pool = new SnmpSessionPool();
    const credential = readSnmpCredentials({ version: 'v2c', community: 'public' });
    const target = (address: string) => ({
      host: NAME,
      port: agent.port,
      checked: [{ address, family: 4 as const }],
    });
    try {
      const first = pool.acquire(target('127.0.0.1'), credential);
      // The name has moved while the first check is still running on the session it was given.
      const second = pool.acquire(target('127.0.0.2'), credential);
      assert.notEqual(second.session, first.session);
      assert.equal(first.session.closed, false, 'the session in use is left to its check');
      assert.equal(pool.stats().sessions, 1);
      first.release();
      assert.equal(first.session.closed, true, 'and closed when that check is done');
      assert.equal(second.session.closed, false);
      // The same address again is the session the pool holds, not a third.
      second.release();
      const third = pool.acquire(target('127.0.0.2'), credential);
      assert.equal(third.session, second.session);
      third.release();
      assert.equal(pool.stats().opened, 2);
    } finally {
      pool.closeAll();
    }
  });

  it('refuses an IPv4-mapped spelling, and asks an ordinary address with no lookup', async () => {
    const dns = rebinding();
    for (const host of MAPPED) {
      const error = await refused(
        execute(snmpUptime, dns, {
          params: params(),
          credentials: credentials(),
          host,
          ipVersion: 'v6',
        }),
      );
      assert.match(error.message, /^refusing to query ::ffff:[0-9a-f.:]+, which is link-local/);
    }
    assert.equal(agent.requests, 0);
    const execution = await execute(snmpUptime, dns, {
      params: params(),
      credentials: credentials(),
      host: '127.0.0.1',
    });
    assert.equal(valueOf(execution, 'uptime'), 90);
    assert.equal(dns.calls.length, 0);
  });

  it('a device set to IPv6 is resolved for IPv6', async () => {
    const dns = rebinding([{ address: '::ffff:a9fe:a9fe', family: 6 }]);
    await refused(
      execute(snmpUptime, dns, {
        params: params(),
        credentials: credentials(),
        ipVersion: 'v6',
      }),
    );
    assert.deepEqual(dns.calls, [{ host: NAME, family: 6 }]);
  });

  it('under `none` hands the name on as it always did, with no lookup of its own', async () => {
    const dns = rebinding();
    const execution = await execute(snmpUptime, dns, {
      params: params(),
      credentials: credentials(),
      host: 'localhost',
      policy: 'none',
    });
    assert.equal(valueOf(execution, 'uptime'), 90);
    assert.equal(dns.calls.length, 0);
  });

  it('a target a credential set pinned is as it was: one lookup, the pin’s, and its own refusal', async () => {
    const dns = rebinding();
    const execution = await execute(snmpUptime, dns, {
      params: params(),
      credentials: credentials(INSIDE),
    });
    assert.equal(valueOf(execution, 'uptime'), 90);
    assert.deepEqual(dns.calls, [{ host: NAME, family: 0 }]);

    snmpPool.closeAll();
    agent.resetCounters();
    const outside = rebinding(v4('192.0.2.77'));
    await assert.rejects(
      () => execute(snmpUptime, outside, { params: params(), credentials: credentials(INSIDE) }),
      (error: unknown) =>
        error instanceof CredentialsWithheldError &&
        /resolves to 192\.0\.2\.77, which is outside the allowed targets/.test(error.message),
    );
    assert.equal(outside.calls.length, 1);
    assert.equal(agent.requests, 0);
  });

  it('a pinned address the policy refuses is a failed check, not a withheld one', async () => {
    const dns = rebinding(v4(METADATA));
    const error = await refused(
      execute(snmpUptime, dns, {
        params: params(),
        credentials: credentials(['169.254.0.0/16']),
      }),
    );
    assert.equal(error.address, METADATA);
    assert.deepEqual(dns.calls, [{ host: NAME, family: 0 }]);
    assert.equal(agent.requests, 0);
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
  /** One SSH sensor of several on the same named device. */
  const sensor = (sensorId: number): CheckContext => ({
    ...contextOf({ params: params(), credentials: credentials() }),
    sensorId,
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

  it('refuses a name that answers the metadata address, with one lookup and no connection', async () => {
    const dns = rebinding(v4(METADATA));
    const error = await refused(
      execute(sshLoad, dns, { params: params(), credentials: credentials() }),
    );
    assert.match(
      error.message,
      new RegExp(`^refusing to connect to ${NAME}: it resolves to 169\\.254\\.169\\.254`),
    );
    assert.deepEqual(dns.calls, [{ host: NAME, family: 0 }]);

    const mixed = rebinding(v4('127.0.0.1', METADATA));
    await refused(execute(sshLoad, mixed, { params: params(), credentials: credentials() }));
    for (const address of MAPPED) {
      const mapped = rebinding([
        { address: '127.0.0.1', family: 4 },
        { address, family: 6 },
      ]);
      await refused(execute(sshLoad, mapped, { params: params(), credentials: credentials() }));
    }
    assert.equal(server.connections, 0);
  });

  it('logs in at the address the one lookup answered, whatever it would answer next', async () => {
    const dns = rebinding();
    const execution = await execute(sshLoad, dns, {
      params: params(),
      credentials: credentials(),
    });
    assert.equal(valueOf(execution, 'load1'), 0.5);
    assert.equal(server.connections, 1);
    assert.equal(dns.calls.length, 1);
  });

  it('passes a first address that refuses the connection, as the socket did with the name', async () => {
    const dns = rebinding(v4(DEAD, '127.0.0.1'));
    const execution = await execute(sshLoad, dns, {
      params: params(),
      credentials: credentials(),
    });
    assert.equal(valueOf(execution, 'load1'), 0.5);
    assert.equal(dns.calls.length, 1);
  });

  it('several sensors coming due together share one connection and its one lookup', async () => {
    const dns = rebinding();
    const catalogue = catalogueOf(sshLoad, dns);
    const executions = await Promise.all(
      [1, 2, 3, 4].map((id) => catalogue.execute('ssh.load', sensor(id))),
    );
    for (const execution of executions) assert.equal(valueOf(execution, 'load1'), 0.5);
    assert.equal(server.connections, 1);
    assert.equal(dns.calls.length, 1);
  });

  it('a sensor cancelled during the shared lookup ends at once, and the others get their connection (A-69)', async () => {
    // The lookup belongs to the open, not to the check that happened to start it: it runs
    // under the pool's signal. Under the first check's own, cancelling that check would end
    // the lookup, and every sensor that joined would fail with it.
    const dns = slow(1_000);
    const catalogue = catalogueOf(sshLoad, dns);
    const first = new AbortController();
    const startedAt = performance.now();
    const cancelled = catalogue.execute('ssh.load', { ...sensor(1), signal: first.signal });
    const outcome: { error?: unknown; at: number } = { at: 0 };
    cancelled.catch((error: unknown) => {
      outcome.error = error;
      outcome.at = performance.now();
    });
    const others = [2, 3].map((id) => catalogue.execute('ssh.load', sensor(id)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    first.abort();
    await assert.rejects(
      cancelled,
      /the check was cancelled while connecting to device\.policy\.invalid/,
    );
    assert.ok(outcome.at - startedAt < 800, 'told before the lookup had answered');
    for (const execution of await Promise.all(others)) {
      assert.equal(valueOf(execution, 'load1'), 0.5);
    }
    assert.equal(server.connections, 1);
    assert.equal(dns.calls.length, 1, 'one lookup, not one begun again');
  });

  it('a resolver outage is not an alarm for each SSH sensor on a device whose connection is held', async () => {
    // One outage, one alarm. The connection was checked when it was opened; every sensor on
    // the device uses it without asking the resolver anything, as before `A-57`. Were a
    // lookup made each scan, a resolver that failed, or hung, would read every one of them
    // Down, for a device that is answering.
    let mode: 'answer' | 'fail' | 'hang' = 'answer';
    const calls: string[] = [];
    const dns: Rebinding = {
      calls: [],
      resolve: (host) => {
        calls.push(mode);
        if (mode === 'answer') return Promise.resolve(v4('127.0.0.1'));
        if (mode === 'fail') {
          return Promise.reject(Object.assign(new Error('SERVFAIL'), { code: 'EAI_AGAIN', host }));
        }
        return new Promise(() => undefined);
      },
    };
    const catalogue = catalogueOf(sshLoad, dns);
    await catalogue.execute('ssh.load', sensor(1));
    assert.deepEqual(calls, ['answer']);

    for (const outage of ['fail', 'hang'] as const) {
      mode = outage;
      const executions = await Promise.all(
        [1, 2, 3, 4, 5, 6].map((id) => catalogue.execute('ssh.load', sensor(id))),
      );
      for (const execution of executions) {
        assert.equal(valueOf(execution, 'load1'), 0.5, `Up while the resolver would ${outage}`);
      }
    }
    assert.deepEqual(calls, ['answer'], 'no sensor asked the resolver during the outage');
    assert.equal(server.connections, 1);
  });

  it('a name whose answers change every scan is still one connection, and no lookup after the first', async () => {
    const answers = [v4('127.0.0.1'), v4('127.0.0.1', DEAD), v4(DEAD), v4(METADATA)];
    const calls: { host: string; family: number }[] = [];
    const dns: Rebinding = {
      calls,
      resolve: (host, family) => {
        const answer = answers[Math.min(calls.length, answers.length - 1)] ?? [];
        calls.push({ host, family });
        return Promise.resolve(answer);
      },
    };
    const catalogue = catalogueOf(sshLoad, dns);
    for (let scan = 0; scan < 4; scan += 1) {
      assert.equal(valueOf(await catalogue.execute('ssh.load', sensor(1)), 'load1'), 0.5);
    }
    assert.equal(server.connections, 1);
    assert.equal(calls.length, 1);
    assert.equal(sshPool.stats().connections, 1);
  });

  it('checks again when a connection has to be opened, and a name that now answers the metadata address is refused', async () => {
    const dns = rebinding();
    const catalogue = catalogueOf(sshLoad, dns);
    await catalogue.execute('ssh.load', sensor(1));
    // Gone, as an idle connection goes, or as every one does when the probe restarts.
    sshPool.closeAll();
    await refused(catalogue.execute('ssh.load', sensor(1)));
    assert.equal(dns.calls.length, 2);
    assert.equal(server.connections, 1);
  });

  it('an ordinary address makes no lookup, and neither does any host under `none`', async () => {
    const dns = rebinding();
    await execute(sshLoad, dns, {
      params: params(),
      credentials: credentials(),
      host: '127.0.0.1',
    });
    sshPool.closeAll();
    await execute(sshLoad, dns, {
      params: params(),
      credentials: credentials(),
      host: 'localhost',
      policy: 'none',
    });
    assert.equal(dns.calls.length, 0);
    assert.equal(server.connections, 2);
    for (const host of MAPPED) {
      await refused(execute(sshLoad, dns, { params: params(), credentials: credentials(), host }));
    }
    assert.equal(server.connections, 2);
  });

  it('a target a credential set pinned is as it was: one lookup, the pin’s, and its own refusal', async () => {
    const dns = rebinding();
    await execute(sshLoad, dns, { params: params(), credentials: credentials(INSIDE) });
    assert.deepEqual(dns.calls, [{ host: NAME, family: 0 }]);
    assert.equal(server.connections, 1);

    const outside = rebinding(v4('192.0.2.77'));
    await assert.rejects(
      () => execute(sshLoad, outside, { params: params(), credentials: credentials(INSIDE) }),
      CredentialsWithheldError,
    );
    assert.equal(outside.calls.length, 1);
    assert.equal(server.connections, 1);
  });
});

describe('mail', () => {
  const mailbox = new Mailbox();
  const running: RunningServer[] = [];
  const listeners: Server[] = [];
  const credentials = (targets?: string[]): CheckContext['credentials'] => ({
    mail: {
      username: 'ops',
      password: 'hunter2',
      ...(targets === undefined ? {} : { allowedTargets: targets }),
    },
  });
  const params = (port: number): Record<string, unknown> => ({
    port,
    security: 'none',
    timeoutMs: 5_000,
    requireAuth: true,
  });
  const smtp = async (): Promise<number> => {
    const server = await smtpServer({ mailbox, username: 'ops', password: 'hunter2' });
    running.push(server);
    return server.port;
  };
  after(async () => {
    for (const server of running) await server.close();
    for (const listener of listeners) await closed(listener);
  });

  it('refuses a name that answers the metadata address, with one lookup and no connection', async () => {
    const listener = await counting();
    listeners.push(listener.server);
    const dns = rebinding(v4(METADATA));
    const error = await refused(
      execute(mailSmtp, dns, { params: params(listener.port), credentials: credentials() }),
    );
    assert.match(
      error.message,
      new RegExp(`^refusing to connect to ${NAME}: it resolves to 169\\.254\\.169\\.254`),
    );
    assert.deepEqual(dns.calls, [{ host: NAME, family: 0 }]);

    const mixed = rebinding(v4('127.0.0.1', METADATA));
    await refused(
      execute(mailSmtp, mixed, { params: params(listener.port), credentials: credentials() }),
    );
    for (const address of MAPPED) {
      const mapped = rebinding([
        { address: '127.0.0.1', family: 4 },
        { address, family: 6 },
      ]);
      await refused(
        execute(mailSmtp, mapped, { params: params(listener.port), credentials: credentials() }),
      );
      await refused(
        execute(mailSmtp, mapped, {
          params: params(listener.port),
          credentials: credentials(),
          host: address,
        }),
      );
    }
    assert.equal(listener.connections(), 0);
  });

  it('logs in at the address the one lookup answered, whatever it would answer next', async () => {
    const port = await smtp();
    const dns = rebinding();
    const execution = await execute(mailSmtp, dns, {
      params: params(port),
      credentials: credentials(),
    });
    assert.ok((valueOf(execution, 'totalTime') ?? -1) >= 0);
    assert.equal(dns.calls.length, 1);
  });

  it('passes a first address that refuses the connection', async () => {
    const port = await smtp();
    const dns = rebinding(v4(DEAD, '127.0.0.1'));
    const execution = await execute(mailSmtp, dns, {
      params: params(port),
      credentials: credentials(),
    });
    assert.ok((valueOf(execution, 'totalTime') ?? -1) >= 0);
    assert.equal(dns.calls.length, 1);
  });

  it('a device set to IPv4 is resolved for IPv4', async () => {
    const port = await smtp();
    const dns = rebinding();
    await execute(mailSmtp, dns, {
      params: params(port),
      credentials: credentials(),
      ipVersion: 'v4',
    });
    assert.deepEqual(dns.calls, [{ host: NAME, family: 4 }]);
  });

  it('an ordinary address makes no lookup, and neither does any host under `none`', async () => {
    const port = await smtp();
    const dns = rebinding();
    await execute(mailSmtp, dns, {
      params: params(port),
      credentials: credentials(),
      host: '127.0.0.1',
    });
    await execute(mailSmtp, dns, {
      params: params(port),
      credentials: credentials(),
      host: 'localhost',
      policy: 'none',
    });
    assert.equal(dns.calls.length, 0);
  });

  it('a target a credential set pinned is as it was: one lookup, the pin’s, and its own refusal', async () => {
    const port = await smtp();
    const dns = rebinding();
    await execute(mailSmtp, dns, { params: params(port), credentials: credentials(INSIDE) });
    assert.deepEqual(dns.calls, [{ host: NAME, family: 0 }]);

    const outside = rebinding(v4('192.0.2.77'));
    await assert.rejects(
      () => execute(mailSmtp, outside, { params: params(port), credentials: credentials(INSIDE) }),
      CredentialsWithheldError,
    );
    assert.equal(outside.calls.length, 1);
  });
});

describe('TCP port', () => {
  let listener: Awaited<ReturnType<typeof counting>>;
  let others: Awaited<ReturnType<typeof counting>>[] = [];
  before(async () => {
    listener = await counting();
    others = [await counting(), await counting()];
  });
  after(async () => {
    for (const one of [listener, ...others]) await closed(one.server);
  });
  const params = (): Record<string, unknown> => ({ port: listener.port, timeoutMs: 2_000 });

  it('refuses a name that answers the metadata address, with one lookup and no connection', async () => {
    const earlier = listener.connections();
    const dns = rebinding(v4(METADATA));
    const error = await refused(execute(portTcp, dns, { params: params() }));
    assert.match(
      error.message,
      new RegExp(`^refusing to connect to ${NAME}: it resolves to 169\\.254\\.169\\.254`),
    );
    assert.deepEqual(dns.calls, [{ host: NAME, family: 0 }]);

    await refused(execute(portTcp, rebinding(v4('127.0.0.1', METADATA)), { params: params() }));
    for (const address of MAPPED) {
      const mapped = rebinding([
        { address: '127.0.0.1', family: 4 },
        { address, family: 6 },
      ]);
      await refused(execute(portTcp, mapped, { params: params() }));
      await refused(execute(portTcp, mapped, { params: params(), host: address }));
    }
    assert.equal(listener.connections(), earlier);
  });

  it('connects at the address the one lookup answered, whatever it would answer next', async () => {
    const earlier = listener.connections();
    const dns = rebinding();
    const execution = await execute(portTcp, dns, { params: params() });
    assert.ok((valueOf(execution, 'connectTime') ?? -1) >= 0);
    assert.equal(dns.calls.length, 1);
    // The far end counts a connection when it accepts it, which is after the near end has it.
    await until(() => listener.connections() === earlier + 1, 'the listener’s accept');
  });

  it('passes a first address that refuses the connection', async () => {
    const dns = rebinding(v4(DEAD, '127.0.0.1'));
    const execution = await execute(portTcp, dns, { params: params() });
    assert.ok((valueOf(execution, 'connectTime') ?? -1) >= 0);
    assert.equal(dns.calls.length, 1);
  });

  it('a device set to IPv4 is resolved for IPv4, and connected to over it', async () => {
    const dns = rebinding();
    await execute(portTcp, dns, { params: params(), ipVersion: 'v4' });
    assert.deepEqual(dns.calls, [{ host: NAME, family: 4 }]);
  });

  it('says a name did not resolve in the words it always has, from the one lookup', async () => {
    const failing: Rebinding = {
      calls: [],
      resolve: (host, family) => {
        failing.calls.push({ host, family });
        return Promise.reject(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
      },
    };
    await assert.rejects(
      () => execute(portTcp, failing, { params: params() }),
      new RegExp(
        `^Error: could not connect to ${NAME}:\\d+ — the device’s host name did not resolve$`,
      ),
    );
    assert.equal(failing.calls.length, 1);
  });

  it('an ordinary address makes no lookup, and neither does any host under `none`', async () => {
    const dns = rebinding();
    await execute(portTcp, dns, { params: params(), host: '127.0.0.1' });
    await execute(portTcp, dns, { params: params(), host: 'localhost', policy: 'none' });
    assert.equal(dns.calls.length, 0);
  });

  it('a range is resolved once for all its ports, and refused before any is tried', async () => {
    const ports = [listener, ...others].map((one) => one.port);
    const earlier = [listener, ...others].map((one) => one.connections());
    const refusedDns = rebinding(v4('127.0.0.1', METADATA));
    const error = await refused(
      execute(portRange, refusedDns, { params: { ports: ports.join(','), timeoutMs: 2_000 } }),
    );
    assert.match(error.message, new RegExp(`^refusing to scan ${NAME}: it resolves to`));
    assert.equal(refusedDns.calls.length, 1);
    assert.deepEqual(
      [listener, ...others].map((one) => one.connections()),
      earlier,
    );

    const dns = rebinding();
    const execution = await execute(portRange, dns, {
      params: { ports: ports.join(','), timeoutMs: 2_000, concurrency: 1 },
    });
    assert.equal(valueOf(execution, 'open'), 3);
    assert.equal(dns.calls.length, 1);
  });
});

describe('TLS', () => {
  let dir = '';
  let server: ReturnType<typeof createTlsServer> | undefined;
  let port = 0;
  let handshakes = 0;

  before(async () => {
    // Skipped for one reason only, a machine with no openssl. Anything else that goes wrong
    // making the certificate or the server fails the suite, where a skip would hide it.
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code === 'ENOENT') return;
      throw error;
    }
    dir = mkdtempSync(join(tmpdir(), 'ms-policy-'));
    const keyFile = join(dir, 'name.key');
    const certFile = join(dir, 'name.crt');
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
        `/CN=${NAME}`,
        '-addext',
        `subjectAltName=DNS:${NAME}`,
      ],
      { stdio: 'ignore' },
    );
    const made = tracked(
      createTlsServer(
        { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8') },
        (socket) => socket.end(),
      ),
    );
    made.on('connection', () => {
      handshakes += 1;
    });
    made.on('tlsClientError', () => undefined);
    await new Promise<void>((resolve) => made.listen(0, '127.0.0.1', resolve));
    const address = made.address();
    port = typeof address === 'object' && address !== null ? address.port : 0;
    server = made;
  });
  after(async () => {
    if (server !== undefined) await closed(server);
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });
  const params = (): Record<string, unknown> => ({ port, timeoutMs: 4_000 });
  const needsOpenssl = (t: { skip(reason: string): void }): boolean => {
    if (server !== undefined) return true;
    t.skip('openssl is not on this machine');
    return false;
  };

  it('refuses a name that answers the metadata address, with one lookup and no connection', async (t) => {
    if (!needsOpenssl(t)) return;
    const earlier = handshakes;
    for (const type of [tlsCertificate, tlsSecurity]) {
      const dns = rebinding(v4(METADATA));
      const error = await refused(execute(type, dns, { params: params() }));
      assert.match(
        error.message,
        new RegExp(`^refusing to connect to ${NAME}: it resolves to 169\\.254\\.169\\.254`),
      );
      assert.deepEqual(dns.calls, [{ host: NAME, family: 0 }]);
      await refused(execute(type, rebinding(v4('127.0.0.1', METADATA)), { params: params() }));
      for (const address of MAPPED) {
        const mapped = rebinding([
          { address: '127.0.0.1', family: 4 },
          { address, family: 6 },
        ]);
        await refused(execute(type, mapped, { params: params() }));
        await refused(execute(type, mapped, { params: params(), host: address }));
      }
    }
    assert.equal(handshakes, earlier);
  });

  it('reads the certificate at the address the one lookup answered, by the device’s name', async (t) => {
    if (!needsOpenssl(t)) return;
    const dns = rebinding();
    const execution = await execute(tlsCertificate, dns, { params: params() });
    // SNI and the name the certificate is read against stay the device's name.
    assert.equal(valueOf(execution, 'hostMatches'), 1);
    assert.ok((valueOf(execution, 'daysRemaining') ?? 0) > 20);
    assert.ok((valueOf(execution, 'handshakeTime') ?? -1) >= 0);
    assert.equal(dns.calls.length, 1);
  });

  it('passes a first address that refuses the connection', async (t) => {
    if (!needsOpenssl(t)) return;
    const dns = rebinding(v4(DEAD, '127.0.0.1'));
    const execution = await execute(tlsCertificate, dns, { params: params() });
    assert.equal(valueOf(execution, 'hostMatches'), 1);
    assert.equal(dns.calls.length, 1);
  });

  it('every handshake of a security check goes to the one lookup’s answer', async (t) => {
    if (!needsOpenssl(t)) return;
    const earlier = handshakes;
    const dns = rebinding();
    const execution = await execute(tlsSecurity, dns, { params: params() });
    assert.equal(valueOf(execution, 'tls13'), 1);
    // Several connections, one for each version this Node will offer, and one lookup.
    assert.equal(dns.calls.length, 1);
    assert.ok(handshakes >= earlier + 2, `${String(handshakes - earlier)} connections`);
  });

  it('an ordinary address makes no lookup, and neither does any host under `none`', async (t) => {
    if (!needsOpenssl(t)) return;
    const dns = rebinding();
    await execute(tlsCertificate, dns, { params: params(), host: '127.0.0.1' });
    await execute(tlsCertificate, dns, { params: params(), host: 'localhost', policy: 'none' });
    assert.equal(dns.calls.length, 0);
  });
});

describe('ICMP ping is not held to the policy', () => {
  // An echo carries no credential and brings back no content, so the guard would buy nothing;
  // and `ping` resolves a name in its own process, which a lookup made here would move onto
  // the probe's shared thread pool for the largest sensor population there is.
  const contextFor = (host: string): CheckContext =>
    contextOf({ params: { count: 2, timeoutMs: 4_000 }, host, ipVersion: 'v4' });

  it('pings an address the policy would refuse a connection to', async () => {
    // Loopback under `private`: refused for every transport that is held to the policy.
    const dns = rebinding();
    await refused(
      execute(portTcp, dns, { params: { port: 9 }, host: '127.0.0.1', policy: 'private' }),
    );
    for (const type of [icmpPing, icmpJitter]) {
      const execution = await catalogueOf(type, dns, 'private').execute(
        type.id,
        contextFor('127.0.0.1'),
      );
      assert.equal(valueOf(execution, 'loss'), 0, type.id);
    }
    assert.equal(dns.calls.length, 0);
  });

  it('makes no lookup in the probe: ping is handed the name, and resolves it itself', async () => {
    const dns = rebinding();
    // A name nothing resolves: the failure is ping's own, not a refusal and not the guard's.
    await assert.rejects(
      () => catalogueOf(icmpPing, dns).execute('icmp.ping', contextFor(NAME)),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof TargetRefusedError) &&
        /no ICMP reply from device\.policy\.invalid/.test(error.message),
    );
    assert.equal(dns.calls.length, 0);
    const { args } = pingCommand(
      'linux',
      { host: NAME, ipVersion: 'auto', resolve: dns.resolve, policy: 'link-local' },
      { count: 1, packetSize: 32, timeoutMs: 2_000 },
    );
    assert.equal(args.at(-1), NAME);
  });
});

describe('the lookup and the connection share the sensor’s timeout', () => {
  // A resolver that takes 900 ms of a 2,000 ms timeout, then an address that never answers.
  // The check ends at the timeout. Given the whole timeout again after the lookup, it would
  // end 900 ms later, and a sensor could run half as long again as it was told to.
  let hole: Awaited<ReturnType<typeof blackhole>> = null;
  before(async () => {
    hole = await blackhole();
  });
  after(async () => {
    await hole?.close();
  });
  const TIMEOUT = 2_000;
  const LOOKUP = 900;
  const timed = async (run: () => Promise<unknown>): Promise<{ ms: number; error: Error }> => {
    const started = process.hrtime.bigint();
    try {
      await run();
    } catch (error: unknown) {
      assert.ok(error instanceof Error);
      return { ms: Number(process.hrtime.bigint() - started) / 1e6, error };
    }
    return assert.fail('the check connected to a port that answers nothing');
  };
  const within = (ms: number): void => {
    assert.ok(ms >= TIMEOUT - 150 && ms < TIMEOUT + 500, `took ${String(Math.round(ms))} ms`);
  };
  const needsHole = (t: { skip(reason: string): void }): number | null => {
    if (hole !== null) return hole.port;
    t.skip('this machine answers a connection to a listener that never accepts');
    return null;
  };

  it('port.tcp', async (t) => {
    const port = needsHole(t);
    if (port === null) return;
    const { ms, error } = await timed(() =>
      execute(portTcp, slow(LOOKUP), { params: { port, timeoutMs: TIMEOUT } }),
    );
    assert.match(error.message, /did not accept a connection within 2000 ms/);
    within(ms);
  });

  it('port.range, on the ports its first connections go to', async (t) => {
    const port = needsHole(t);
    if (port === null) return;
    const started = process.hrtime.bigint();
    const execution = await execute(portRange, slow(LOOKUP), {
      params: { ports: String(port), timeoutMs: TIMEOUT },
    });
    assert.equal(valueOf(execution, 'open'), 0);
    within(Number(process.hrtime.bigint() - started) / 1e6);
  });

  it('tls.certificate', async (t) => {
    const port = needsHole(t);
    if (port === null) return;
    const { ms, error } = await timed(() =>
      execute(tlsCertificate, slow(LOOKUP), { params: { port, timeoutMs: TIMEOUT } }),
    );
    assert.match(error.message, /did not complete a TLS handshake within 2000 ms/);
    within(ms);
  });

  it('tls.security, on its first handshake and no other', async (t) => {
    const port = needsHole(t);
    if (port === null) return;
    // Every version tried has the timeout a handshake of its own always had, and the lookup is
    // taken from the first: a slow lookup does not make the whole check any longer.
    const took = async (lookupMs: number): Promise<number> => {
      const started = process.hrtime.bigint();
      await assert.rejects(
        () => execute(tlsSecurity, slow(lookupMs), { params: { port, timeoutMs: 1_000 } }),
        /accepted no TLS version at all/,
      );
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    const quick = await took(0);
    const slowed = await took(450);
    assert.ok(quick >= 850, `took ${String(Math.round(quick))} ms with no wait for the lookup`);
    assert.ok(
      Math.abs(slowed - quick) < 250,
      `${String(Math.round(quick))} ms, and ${String(Math.round(slowed))} ms behind a slow lookup`,
    );
  });

  it('mail', async (t) => {
    const port = needsHole(t);
    if (port === null) return;
    const { ms, error } = await timed(() =>
      execute(mailSmtp, slow(LOOKUP), {
        params: { port, security: 'none', timeoutMs: TIMEOUT, requireAuth: true },
        credentials: { mail: { username: 'ops', password: 'hunter2' } },
      }),
    );
    assert.match(error.message, /did not accept a connection within 2000 ms/);
    within(ms);
  });
});

describe('HTTP is held to the same setting', () => {
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

  it('refuses under the default, resolves nothing under `none`, and refuses loopback under `private`', async () => {
    const dns = rebinding(v4('127.0.0.1', METADATA));
    const error = await refused(execute(httpRequest, dns, { params: params() }));
    assert.match(error.message, new RegExp(`^refusing to request ${NAME}: it resolves to`));
    assert.equal(simulator.requests.length, 0);

    const open = rebinding();
    await execute(httpRequest, open, { params: params(), host: 'localhost', policy: 'none' });
    assert.equal(open.calls.length, 0);
    assert.equal(simulator.requests.length, 1);

    const strict = await refused(
      execute(httpRequest, rebinding(), { params: params(), policy: 'private' }),
    );
    assert.equal(strict.policy, 'private');
    assert.equal(simulator.requests.length, 1);
  });
});

describe('the database sensors through a driver that connects to nothing, and the transport that cannot be held to an address', () => {
  const driver = (connects: string[]): DbDriver => ({
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
  });
  const database = (host: string, dns: Rebinding, policy?: TargetPolicy): CheckContext => ({
    sensorId: 57,
    target: {
      host,
      ipVersion: 'auto',
      resolve: dns.resolve,
      ...(policy === undefined ? {} : { policy }),
    },
    params: { query: 'select 1' },
    credentials: { database: { username: 'monitor', password: 'secret' } },
    signal: new AbortController().signal,
  });

  it('a database sensor on a refused address connects to nothing', async () => {
    const connects: string[] = [];
    const dns = rebinding();
    for (const host of [METADATA, 'fe80::1', ...MAPPED]) {
      const error = await refused(runDbCheck(driver(connects), database(host, dns)));
      assert.match(error.message, /^refusing to connect to .*, which is link-local/);
    }
    assert.deepEqual(connects, []);
    assert.equal(dns.calls.length, 0);
  });

  it('a database sensor on an ordinary address, or under `none`, connects as it did', async () => {
    const connects: string[] = [];
    const dns = rebinding(v4(METADATA));
    await runDbCheck(driver(connects), database('127.0.0.1', dns));
    // The fake driver connects to nothing: this is what the check hands it.
    await runDbCheck(driver(connects), database('169.254.7.7', dns, 'none'));
    await runDbCheck(driver(connects), database(NAME, dns, 'none'));
    assert.deepEqual(connects, ['127.0.0.1', '169.254.7.7', NAME]);
    assert.equal(dns.calls.length, 0);
  });

  it('a database sensor on a name is resolved once and checked, where it was not (A-62)', async () => {
    // The real drivers, against servers on loopback, are in `db-checked-target.test.ts`.
    const connects: string[] = [];
    const inside = rebinding();
    await runDbCheck(driver(connects), database(NAME, inside));
    assert.deepEqual(connects, [NAME], 'the driver still holds the name, which TLS names');
    assert.equal(inside.calls.length, 1);
    const dns = rebinding(v4('127.0.0.1', METADATA));
    const error = await refused(runDbCheck(driver(connects), database(NAME, dns)));
    assert.match(error.message, /it resolves to 169\.254\.169\.254, which is link-local/);
    assert.deepEqual(connects, [NAME]);
    assert.equal(dns.calls.length, 1);
  });

  const windows = (host: string, params: Record<string, unknown> = {}, policy?: TargetPolicy) =>
    windowsOptions({
      sensorId: 57,
      target: { host, ipVersion: 'auto', ...(policy === undefined ? {} : { policy }) },
      params,
      credentials: {},
      signal: new AbortController().signal,
    });

  it('a Windows sensor refuses an address, the device’s or the one its `host` names', () => {
    assert.throws(() => windows(METADATA), TargetRefusedError);
    assert.throws(() => windows('server01', { host: MAPPED[1] }), TargetRefusedError);
    assert.throws(() => windows('10.1.2.3', {}, 'private'), /which is a private address/);
    assert.equal(windows('server01').host, 'server01');
    assert.equal(windows('10.1.2.3').host, '10.1.2.3');
    assert.equal(windows('169.254.7.7', {}, 'none').host, '169.254.7.7');
    // This probe's own machine is not a connection, under any policy.
    assert.equal(windows('127.0.0.1', {}, 'private').host, '');
  });

  it('refuseBlockedAddress passes a name and anything under `none`', () => {
    refuseBlockedAddress(NAME, undefined, 'connect to');
    refuseBlockedAddress('127.0.0.1', undefined, 'connect to');
    refuseBlockedAddress(METADATA, 'none', 'connect to');
    assert.throws(
      () => {
        refuseBlockedAddress(METADATA, undefined, 'connect to');
      },
      (error: unknown) =>
        error instanceof TargetRefusedError &&
        error.target === METADATA &&
        error.address === METADATA &&
        error.policy === 'link-local',
    );
  });
});

describe('a device on a link-local address (the alarm this change makes)', () => {
  it('each of its sensors fails once, as a failed check, with nothing resolved and nothing withheld', async () => {
    // What reads Down after the upgrade and was Up before it: one failed check for each sensor
    // on the device, by the ordinary path, so the state machine and its notifications treat it
    // as any device that stopped answering. No refusal is marked `withheld`, which would read
    // Unknown, and no sensor fails more than once a scan.
    const host = '169.254.10.20';
    const dns = rebinding();
    const sensors: [SensorType, Record<string, unknown>, CheckContext['credentials']][] = [
      [portTcp, { port: 80, timeoutMs: 1_000 }, {}],
      [portRange, { ports: '80,443', timeoutMs: 1_000 }, {}],
      [tlsCertificate, { port: 443, timeoutMs: 1_000 }, {}],
      [tlsSecurity, { port: 443, timeoutMs: 1_000 }, {}],
      [httpRequest, { scheme: 'http', port: 80, path: '/' }, {}],
      [snmpUptime, { port: 161, timeoutMs: 500 }, { snmp: { version: 'v2c', community: 'c' } }],
      [
        sshLoad,
        { port: 22, connectTimeoutMs: 1_000 },
        { ssh: { username: 'u', password: 'p', hostKeyPolicy: 'accept-any' } },
      ],
      [
        mailSmtp,
        { port: 25, security: 'none', timeoutMs: 1_000 },
        { mail: { username: 'u', password: 'p' } },
      ],
    ];
    for (const [type, params, credentials] of sensors) {
      const error = await refused(execute(type, dns, { params, credentials, host }));
      assert.equal(error.target, host, type.id);
      assert.equal(error.address, host, type.id);
      assert.match(
        error.message,
        /^refusing to \S+( to)? 169\.254\.10\.20, which is link-local .*probe\.targetPolicy “none” refuses nothing$/,
        type.id,
      );
    }
    assert.equal(dns.calls.length, 0);
  });
});
