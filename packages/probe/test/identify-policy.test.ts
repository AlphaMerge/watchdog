import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pino } from 'pino';
import type { Fingerprint, IdentifyJob, SweepHost, TargetPolicy } from '@ms/shared';
import { TARGET_POLICY_ENV, type ResolveHost } from '@ms/sensors';
import { TestSnmpAgent } from '@ms/simulators';
import { identify, type IdentifyDeps } from '../src/discovery/identify.js';
import { IdentifyRunner } from '../src/discovery/identify-runner.js';
import { snmpSystem } from '../src/discovery/sources.js';
import { SweepRunner } from '../src/discovery/sweep.js';

/**
 * Identification is held to the probe's target policy (`A-63`).
 *
 * The sweep's ping is not, on purpose, and the first test here pins that too: a link-local
 * address in a range is pinged like any other. What the policy stops is what follows the ping,
 * which opens TCP connections and sends an SNMP community.
 *
 * **"Nothing was sent" is read off the far end**, an SNMP agent and a listening socket that
 * count what reached them, wherever an address a test can listen on will do. Nothing in a test
 * can listen on 169.254.169.254, so for that address the sources are counted instead, and a
 * name that resolves to the simulators' address stands in for it under `private`, where the
 * simulators' own address is one the policy refuses.
 */

const silent = pino({ level: 'silent' });
const METADATA = '169.254.169.254';

/** Sources that record what they were asked and reach nothing. */
function counted(): { deps: IdentifyDeps; asked: string[] } {
  const asked: string[] = [];
  const note =
    <T>(what: string, value: T) =>
    (address: string): Promise<T> => {
      asked.push(`${what} ${address}`);
      return Promise.resolve(value);
    };
  return {
    asked,
    deps: {
      reverseLookup: note('ptr', 'gw.example.com'),
      snmpSystem: note('snmp', { sysDescr: 'Linux 6.1' }),
      tcpProbe: (address, port) => {
        asked.push(`tcp ${address}:${String(port)}`);
        return Promise.resolve(port === 22 ? { port, transport: 'tcp' as const } : null);
      },
      httpServer: note('http', null),
    },
  };
}

function assertRefused(found: Fingerprint, address: string, policy: TargetPolicy): void {
  assert.ok(found.refused !== undefined, 'the fingerprint says it was refused');
  assert.match(found.refused, /^not identified: refusing to identify /);
  assert.ok(found.refused.includes(address), found.refused);
  assert.ok(found.refused.includes(`target policy (${policy})`), found.refused);
  // How to allow it, for somebody who swept the range on purpose.
  assert.match(found.refused, /probe\.targetPolicy “none” refuses nothing/);
  // And where a core that has never heard of the field shows it.
  assert.deepEqual(found.evidence, [found.refused]);
  assert.equal(found.kind, 'unknown');
  assert.equal(found.confidence, 0);
  assert.deepEqual(found.ports, []);
  assert.equal(found.reverseName, undefined);
  assert.equal(found.sysDescr, undefined);
}

describe('the sweep is not held to the policy', () => {
  it('pings a metadata address in a range like any other', async () => {
    const pinged: string[] = [];
    const found: SweepHost[] = [];
    await new Promise<void>((resolve) => {
      const sweep = new SweepRunner({
        logger: silent,
        probe: (address) => {
          pinged.push(address);
          return Promise.resolve(1);
        },
        queueDepth: () => 0,
        onProgress: (_runId, _cursor, hosts) => {
          found.push(...hosts);
        },
        onFinished: () => {
          resolve();
        },
      });
      sweep.start({
        runId: 1,
        range: '169.254.169.252/30',
        cursor: 0,
        timeoutMs: 200,
        concurrency: 2,
        ratePerSecond: 0,
      });
    });
    assert.ok(pinged.includes(METADATA), pinged.join(', '));
    assert.ok(found.some((one) => one.address === METADATA));
  });
});

describe('an address the policy refuses is sent nothing, and says so', () => {
  for (const spelling of [METADATA, `::ffff:${METADATA}`, '::ffff:a9fe:a9fe', 'fe80::1']) {
    it(`refuses ${spelling} under the default policy, before any source is asked`, async () => {
      const sources = counted();
      const found = await identify(spelling, { timeoutMs: 500, community: 'public' }, sources.deps);
      assert.deepEqual(sources.asked, [], 'no PTR query, no SNMP get, no TCP connect');
      assert.equal(found.address, spelling);
      assertRefused(found, spelling, 'link-local');
    });
  }

  it('identifies an ordinary address as before, and does not call it refused', async () => {
    const sources = counted();
    const found = await identify(
      '10.0.0.5',
      { timeoutMs: 500, community: 'public', ports: [22, 80] },
      sources.deps,
    );
    assert.equal(found.refused, undefined);
    assert.equal(found.kind, 'linux');
    assert.equal(found.reverseName, 'gw.example.com');
    assert.deepEqual(sources.asked.sort(), [
      'ptr 10.0.0.5',
      'snmp 10.0.0.5',
      'tcp 10.0.0.5:22',
      'tcp 10.0.0.5:80',
    ]);
  });

  it('refuses a private address only under `private`', async () => {
    for (const [policy, refused] of [
      ['link-local', false],
      ['private', true],
      ['none', false],
    ] as const) {
      const sources = counted();
      const found = await identify(
        '10.0.0.5',
        { timeoutMs: 500, community: 'public', ports: [22], policy },
        sources.deps,
      );
      assert.equal(found.refused !== undefined, refused, policy);
      assert.equal(sources.asked.length === 0, refused, policy);
    }
  });

  it('identifies everything under `none`, the metadata address included', async () => {
    for (const spelling of [METADATA, 'fe80::1']) {
      const sources = counted();
      const found = await identify(
        spelling,
        { timeoutMs: 500, community: 'public', ports: [22], policy: 'none' },
        sources.deps,
      );
      assert.equal(found.refused, undefined);
      assert.equal(found.sysDescr, 'Linux 6.1');
      assert.deepEqual(sources.asked.sort(), [
        `ptr ${spelling}`,
        `snmp ${spelling}`,
        `tcp ${spelling}:22`,
      ]);
    }
  });
});

describe('against the simulators', () => {
  let agent: TestSnmpAgent;
  let banner: Server;
  let bannerPort = 0;
  let connections = 0;
  let lookups: string[] = [];
  /** What a name answers with. A name that is not here does not resolve. */
  const NAMES: Record<string, string[]> = {
    'switch.test': ['127.0.0.1'],
    'metadata.test': [METADATA],
    // One record inside the network and one pointing at metadata: refused on the second.
    'both.test': ['127.0.0.1', METADATA],
  };

  const live = (): IdentifyDeps & { resolve: ResolveHost } => ({
    reverseLookup: () => Promise.resolve(null),
    snmpSystem: (address, community, timeoutMs) =>
      snmpSystem(address, community, timeoutMs, agent.port),
    resolve: (host, family) => {
      lookups.push(`${host}/${String(family)}`);
      const answers = NAMES[host];
      if (answers === undefined) {
        return Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
      }
      return Promise.resolve(answers.map((address) => ({ address, family: 4 })));
    },
  });
  const options = (policy?: TargetPolicy) => ({
    timeoutMs: 2_000,
    community: 'public',
    ports: [bannerPort],
    ...(policy === undefined ? {} : { policy }),
  });

  before(async () => {
    agent = await TestSnmpAgent.start([
      { oid: '1.3.6.1.2.1.1.1.0', type: 'OctetString', value: 'Cisco IOS Software, Version 15.2' },
      { oid: '1.3.6.1.2.1.1.2.0', type: 'OID', value: '1.3.6.1.4.1.9.1.1745' },
      { oid: '1.3.6.1.2.1.1.5.0', type: 'OctetString', value: 'sw-core-01' },
    ]);
    banner = createServer((socket) => {
      connections += 1;
      socket.on('error', () => undefined);
      socket.write('SSH-2.0-OpenSSH_9.2p1 Debian-2\r\n');
    });
    await new Promise<void>((resolve) => {
      banner.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const at = banner.address();
    bannerPort = typeof at === 'object' && at !== null ? at.port : 0;
  });

  after(async () => {
    await agent.stop();
    await new Promise<void>((resolve) => {
      banner.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    agent.resetCounters();
    connections = 0;
    lookups = [];
  });

  it('identifies an address the policy allows over SNMP and TCP, with no lookup', async () => {
    const found = await identify('127.0.0.1', options(), live());
    assert.equal(found.refused, undefined);
    assert.equal(found.sysName, 'sw-core-01');
    assert.equal(found.vendor, 'Cisco');
    assert.equal(found.ports[0]?.port, bannerPort);
    assert.match(found.ports[0].banner ?? '', /OpenSSH/);
    assert.equal(agent.requests, 1);
    assert.equal(connections, 1);
    assert.deepEqual(lookups, [], 'an address is checked as it stands and resolved by nobody');
  });

  for (const spelling of ['127.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    it(`sends nothing to ${spelling} when the policy refuses it`, async () => {
      const found = await identify(spelling, options('private'), live());
      assertRefused(found, spelling, 'private');
      assert.equal(agent.requests, 0, 'no SNMP request reached the agent');
      assert.equal(connections, 0, 'no TCP connection reached the listener');
      assert.deepEqual(lookups, []);
    });
  }

  it('reaches the same address under `none`', async () => {
    const found = await identify('127.0.0.1', options('none'), live());
    assert.equal(found.refused, undefined);
    assert.equal(found.sysName, 'sw-core-01');
    assert.equal(agent.requests, 1);
    assert.equal(connections, 1);
  });

  it('resolves a name once, and connects every source to the address it checked', async () => {
    const found = await identify('switch.test', options(), live());
    assert.deepEqual(lookups, ['switch.test/4'], 'one lookup, for the family the sources use');
    assert.equal(found.address, 'switch.test', 'the fingerprint is about what was asked');
    assert.equal(found.sysName, 'sw-core-01');
    assert.equal(found.ports[0]?.port, bannerPort);
    assert.equal(agent.requests, 1);
    assert.equal(connections, 1);
  });

  for (const name of ['metadata.test', 'both.test']) {
    it(`refuses ${name}, which resolves to a metadata address, and sends nothing`, async () => {
      const found = await identify(name, options(), live());
      assert.deepEqual(lookups, [`${name}/4`]);
      assertRefused(found, name, 'link-local');
      assert.ok(found.refused?.includes(`resolves to ${METADATA}`), found.refused);
      assert.equal(agent.requests, 0);
      assert.equal(connections, 0);
    });
  }

  it('does not resolve a name at all under `none`', async () => {
    // Nothing is checked, so the lookup would be one the connection never uses.
    // The sources are counted here, not live: handed the name, the real ones would ask a
    // real resolver for it.
    const sources = counted();
    await identify('metadata.test', options('none'), { ...sources.deps, resolve: live().resolve });
    assert.deepEqual(lookups, []);
    assert.ok(sources.asked.includes('snmp metadata.test'), sources.asked.join(', '));
  });

  it('reports a name that does not resolve as a host that said nothing, not as refused', async () => {
    // Counted sources: handed the name, the real ones would ask a real resolver and find
    // nothing either, which would look the same from here.
    const sources = counted();
    const found = await identify('nowhere.test', options(), {
      ...sources.deps,
      resolve: live().resolve,
    });
    assert.deepEqual(sources.asked, [], 'there is nowhere to connect, so nothing is asked');
    assert.deepEqual(lookups, ['nowhere.test/4']);
    assert.equal(found.refused, undefined);
    assert.equal(found.kind, 'unknown');
    assert.deepEqual(found.ports, []);
    assert.equal(agent.requests, 0);
    assert.equal(connections, 0);
  });
});

describe('the identification pass, under a policy', () => {
  const JOB: IdentifyJob = {
    runId: 7,
    addresses: ['10.0.0.1', METADATA, '10.0.0.2', '169.254.0.9', '10.0.0.3', '10.0.0.4'],
    cursor: 0,
    timeoutMs: 500,
    concurrency: 2,
    community: 'public',
  };

  interface Pass {
    found: Fingerprint[];
    asked: string[];
    peak: number;
    cursor: number;
    stats: ReturnType<IdentifyRunner['stats']>;
  }

  async function pass(policy: TargetPolicy | undefined, job: IdentifyJob = JOB): Promise<Pass> {
    const found: Fingerprint[] = [];
    const asked: string[] = [];
    let inFlight = 0;
    let peak = 0;
    let finish: (at: number) => void = () => undefined;
    const finished = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const runner = new IdentifyRunner({
      logger: silent,
      sources: {
        reverseLookup: async (address) => {
          asked.push(address);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise<void>((done) => setTimeout(done, 5));
          inFlight -= 1;
          return null;
        },
        snmpSystem: () => Promise.resolve(null),
        tcpProbe: () => Promise.resolve(null),
        httpServer: () => Promise.resolve(null),
      },
      ...(policy === undefined ? {} : { policy }),
      queueDepth: () => 0,
      onProgress: (_runId, _cursor, some) => {
        found.push(...some);
      },
      onFinished: (_runId, _ending, at) => {
        finish(at);
      },
    });
    runner.start(job);
    const cursor = await finished;
    return { found, asked, peak, cursor, stats: runner.stats() };
  }

  it('reports the refused addresses as refused and identifies the rest', async () => {
    const run = await pass('link-local');
    assert.equal(run.cursor, 6, 'a refusal is offered and passed, not retried');
    assert.equal(run.found.length, 6, 'every host is reported, so the core moves past each');
    assert.deepEqual(
      run.found
        .filter((one) => one.refused !== undefined)
        .map((one) => one.address)
        .sort(),
      ['169.254.0.9', METADATA],
    );
    assert.deepEqual(run.asked.sort(), ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']);
    assert.equal(run.stats.identified, 4);
    assert.equal(run.stats.refused, 2);
  });

  // What `main.ts` relies on: it hands the runner no policy, and puts `probe.targetPolicy` in
  // the environment before anything is built (`handTargetPolicy`, tested with the runners).
  describe('told no policy, it reads the one the probe put in its environment', () => {
    const held = process.env[TARGET_POLICY_ENV];
    afterEach(() => {
      if (held === undefined) delete process.env['MS_TARGET_POLICY'];
      else process.env[TARGET_POLICY_ENV] = held;
    });

    it('identifies everything when the probe is set to `none`', async () => {
      process.env[TARGET_POLICY_ENV] = 'none';
      const run = await pass(undefined);
      assert.equal(run.stats.refused, 0);
      assert.ok(run.asked.includes(METADATA));
    });

    it('refuses a private address when the probe is set to `private`', async () => {
      process.env[TARGET_POLICY_ENV] = 'private';
      const run = await pass(undefined);
      assert.equal(run.stats.refused, 6);
      assert.deepEqual(run.asked, []);
    });

    for (const value of [undefined, '', 'None', 'off', 'link-local']) {
      it(`holds to link-local, never none, when the value is ${JSON.stringify(value)}`, async () => {
        if (value === undefined) delete process.env['MS_TARGET_POLICY'];
        else process.env[TARGET_POLICY_ENV] = value;
        const run = await pass(undefined);
        assert.equal(run.stats.refused, 2);
        assert.ok(!run.asked.includes(METADATA));
        assert.equal(run.asked.length, 4);
      });
    }

    it('is told at construction, so a run started later is held to the same policy', async () => {
      process.env[TARGET_POLICY_ENV] = 'none';
      const run = await pass('link-local');
      assert.equal(run.stats.refused, 2, 'a policy it was handed is the one it uses');
    });
  });

  it('identifies every address under `none`', async () => {
    const run = await pass('none');
    assert.equal(run.stats.refused, 0);
    assert.equal(run.stats.identified, 6);
    assert.equal(run.asked.length, 6);
    assert.ok(run.found.every((one) => one.refused === undefined));
  });

  it('keeps its concurrency bound, with refusals among the hosts', async () => {
    const addresses = Array.from({ length: 24 }, (_, at) =>
      at % 3 === 0 ? `169.254.1.${String(at)}` : `10.0.1.${String(at)}`,
    );
    for (const concurrency of [1, 3]) {
      const run = await pass('link-local', { ...JOB, addresses, concurrency });
      assert.equal(run.found.length, 24);
      assert.equal(run.stats.refused, 8);
      assert.ok(run.peak <= concurrency, `peak ${String(run.peak)} of ${String(concurrency)}`);
      assert.equal(run.peak, concurrency, 'and the bound is used, not narrowed');
    }
  });
});
