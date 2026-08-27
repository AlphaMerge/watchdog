import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { snmpTraffic } from '../src/types/snmp-traffic.js';
import type { CheckContext, CheckExecution } from '../src/contract.js';
import { TestSnmpAgent, type AgentEntry } from './support/snmp-agent.js';

const IF_DESCR = '1.3.6.1.2.1.2.2.1.2';
const IF_NAME = '1.3.6.1.2.1.31.1.1.1.1';
const IF_ALIAS = '1.3.6.1.2.1.31.1.1.1.18';
const IF_OPER = '1.3.6.1.2.1.2.2.1.8';
const IF_SPEED = '1.3.6.1.2.1.2.2.1.5';
const IF_HIGH_SPEED = '1.3.6.1.2.1.31.1.1.1.15';
const HC_IN = '1.3.6.1.2.1.31.1.1.1.6';
const HC_OUT = '1.3.6.1.2.1.31.1.1.1.10';
const IN = '1.3.6.1.2.1.2.2.1.10';
const OUT = '1.3.6.1.2.1.2.2.1.16';

/** A device with two interfaces: index 2 has 64-bit counters, index 3 only has 32-bit ones. */
const MIB: AgentEntry[] = [
  { oid: `${IF_DESCR}.2`, type: 'OctetString', value: 'eth0' },
  { oid: `${IF_DESCR}.3`, type: 'OctetString', value: 'eth1' },
  { oid: `${IF_NAME}.2`, type: 'OctetString', value: 'GigabitEthernet0/1' },
  { oid: `${IF_NAME}.3`, type: 'OctetString', value: 'GigabitEthernet0/2' },
  { oid: `${IF_ALIAS}.2`, type: 'OctetString', value: 'uplink to core' },
  { oid: `${IF_OPER}.2`, type: 'Integer', value: 1 },
  { oid: `${IF_OPER}.3`, type: 'Integer', value: 2 },
  { oid: `${IF_SPEED}.2`, type: 'Gauge', value: 1_000_000_000 },
  { oid: `${IF_SPEED}.3`, type: 'Gauge', value: 100_000_000 },
  { oid: `${IF_HIGH_SPEED}.2`, type: 'Gauge', value: 1_000 },
  // Past 2^53 on purpose: this is the range ifHCInOctets exists to reach.
  { oid: `${HC_IN}.2`, type: 'Counter64', value: 18_014_398_509_482_000n },
  { oid: `${HC_OUT}.2`, type: 'Counter64', value: 9_007_199_254_741_000n },
  { oid: `${IN}.2`, type: 'Counter', value: 4_000 },
  { oid: `${OUT}.2`, type: 'Counter', value: 2_000 },
  // Index 3 has no ifXTable entries at all, which is what an old agent looks like.
  { oid: `${IN}.3`, type: 'Counter', value: 111_000 },
  { oid: `${OUT}.3`, type: 'Counter', value: 222_000 },
];

let agent: TestSnmpAgent;

before(async () => {
  agent = await TestSnmpAgent.start(MIB);
});

after(async () => {
  await agent.stop();
});

beforeEach(() => {
  agent.behave({});
  agent.accept('public');
  agent.load(MIB);
});

function context(params: Record<string, unknown>, over: Partial<CheckContext> = {}): CheckContext {
  return {
    sensorId: 1,
    target: { host: agent.host, ipVersion: 'v4' },
    params: { port: agent.port, timeoutMs: 400, retries: 0, ...params },
    credentials: { snmp: { version: 'v2c', community: 'public' } },
    signal: new AbortController().signal,
    ...over,
  };
}

const run = (
  params: Record<string, unknown>,
  over: Partial<CheckContext> = {},
): Promise<CheckExecution> => snmpTraffic.execute(context(params, over));

function reading(execution: CheckExecution, key: string) {
  return execution.channels.find((channel) => channel.key === key);
}

describe('the channels it declares', () => {
  it('declares in, out, total and status', () => {
    assert.deepEqual(
      snmpTraffic.channels({}).map((channel) => channel.key),
      ['in', 'out', 'total', 'status'],
    );
  });

  it('marks the three traffic channels as counters and the status as not', () => {
    const channels = snmpTraffic.channels({});
    for (const key of ['in', 'out', 'total']) {
      assert.equal(channels.find((c) => c.key === key)?.counter?.bits, 64);
    }
    assert.equal(channels.find((c) => c.key === 'status')?.counter, undefined);
  });

  it('judges the status by a lookup rather than a threshold', () => {
    // up(1) / down(2) / testing(3) is not a measurement, and "warn above 1.5" is not a rule
    // anybody should have to write (`M-06`).
    assert.equal(
      snmpTraffic.channels({}).find((c) => c.key === 'status')?.lookup,
      'ms.snmp.if-oper-status',
    );
  });

  it('declares 32-bit counters when the operator forced that width', () => {
    const channels = snmpTraffic.channels({ counterWidth: '32' });
    assert.equal(channels.find((c) => c.key === 'in')?.counter?.bits, 32);
  });

  it('has exactly one primary channel', () => {
    assert.deepEqual(
      snmpTraffic
        .channels({})
        .filter((c) => c.isPrimary === true)
        .map((c) => c.key),
      ['in'],
    );
  });
});

describe('reading an interface by index', () => {
  it('reports the counters exactly, as text', async () => {
    // The reason `counter` is text: as a double these lose their low bits, and this is the range
    // a busy 100 Gbit/s link reaches in about nine days.
    const execution = await run({ ifIndex: 2 });
    assert.equal(reading(execution, 'in')?.counter, '18014398509482000');
    assert.equal(reading(execution, 'out')?.counter, '9007199254741000');
  });

  it('reports the total as the sum of the raw counters', async () => {
    // Summing the counters is exactly equivalent to summing the rates the core derives —
    // (Δin + Δout)/Δt is (Δin/Δt) + (Δout/Δt) — and this type never sees the rates.
    const execution = await run({ ifIndex: 2 });
    assert.equal(
      reading(execution, 'total')?.counter,
      String(18_014_398_509_482_000n + 9_007_199_254_741_000n),
    );
  });

  it('says which width it used, so a reading is self-describing', async () => {
    const execution = await run({ ifIndex: 2 });
    assert.equal(reading(execution, 'in')?.counterBits, 64);
  });

  it('reports the operational status as its own channel', async () => {
    assert.equal(reading(await run({ ifIndex: 2 }), 'status')?.value, 1);
  });

  it('names the interface and the counter width in the message', async () => {
    const execution = await run({ ifIndex: 2 });
    assert.match(execution.message ?? '', /interface 2/);
    assert.match(execution.message ?? '', /64-bit/);
  });

  it('fails, naming the index, when the device has no such interface', async () => {
    // An agent answers a missing index with noSuchObject rather than an error, so this is a
    // varbind check. "ETIMEDOUT" alone is not a diagnosis (CLAUDE.md), and neither is silence.
    await assert.rejects(() => run({ ifIndex: 99 }), /has no interface 99/);
  });
});

describe('falling back to 32-bit counters', () => {
  it('uses them when the device has no ifXTable, and says so', async () => {
    // Index 3 has no HC counters. The sensor still works — a 10 Mbit/s link with a v1 agent is
    // perfectly monitorable — but the message has to say the numbers may be low, because
    // nothing else in the system can tell.
    const execution = await run({ ifIndex: 3 });
    assert.equal(reading(execution, 'in')?.counter, '111000');
    assert.equal(reading(execution, 'in')?.counterBits, 32);
    assert.match(execution.message ?? '', /32-bit/);
    assert.match(execution.message ?? '', /under-report/);
  });

  it('carries the discovered width on the reading, not the declared one', async () => {
    // The bug this prevents: `channels()` runs at sensor-creation time and cannot know what the
    // device offers, so it declares 64. A 32-bit wrap read as a 64-bit counter looks exactly
    // like a device reset, and every wrap would be a gap — on a gigabit link, every 34 seconds.
    assert.equal(snmpTraffic.channels({}).find((c) => c.key === 'in')?.counter?.bits, 64);
    const execution = await run({ ifIndex: 3 });
    assert.equal(reading(execution, 'in')?.counterBits, 32);
  });

  it('does not fall back when the width was forced to 64', async () => {
    await assert.rejects(() => run({ ifIndex: 3, counterWidth: '64' }), /has no interface 3/);
  });

  it('uses 32-bit directly when told to', async () => {
    const execution = await run({ ifIndex: 2, counterWidth: '32' });
    assert.equal(reading(execution, 'in')?.counter, '4000');
    assert.equal(reading(execution, 'in')?.counterBits, 32);
  });
});

describe('finding an interface by name', () => {
  it('matches ifName', async () => {
    const execution = await run({ interfaceName: 'GigabitEthernet0/1' });
    assert.equal(reading(execution, 'in')?.counter, '18014398509482000');
    assert.match(execution.message ?? '', /found by name/);
  });

  it('matches ifDescr when ifName does not have it', async () => {
    const execution = await run({ interfaceName: 'eth1' });
    assert.equal(reading(execution, 'in')?.counter, '111000');
  });

  it('matches ifAlias, which is what somebody configured on the port', async () => {
    const execution = await run({ interfaceName: 'uplink to core' });
    assert.equal(reading(execution, 'in')?.counter, '18014398509482000');
  });

  it('ignores case and surrounding space', async () => {
    const execution = await run({ interfaceName: '  gigabitethernet0/1  ' });
    assert.match(execution.message ?? '', /interface 2/);
  });

  it('follows the name when the index moved, which is why naming exists', async () => {
    // A device renumbering its interfaces across a reboot is the failure an index cannot
    // survive: the sensor keeps working and is silently watching a different port.
    const execution = await run({ interfaceName: 'GigabitEthernet0/1', ifIndex: 3 });
    assert.equal(reading(execution, 'in')?.counter, '18014398509482000', 'should follow the name');
  });

  it('fails, saying what it matched against, when no interface has that name', async () => {
    await assert.rejects(
      () => run({ interfaceName: 'TenGigE9/9' }),
      /no interface .* is called "TenGigE9\/9".*ifName, ifDescr and ifAlias/s,
    );
  });
});

describe('when it cannot run', () => {
  it('names the missing credential rather than failing to authenticate', async () => {
    // "Authentication failed" twenty seconds later reads like a broken device. This says what
    // to do about it.
    await assert.rejects(
      () => run({ ifIndex: 2 }, { credentials: {} }),
      /no SNMP credentials are set on this device or any group above it/,
    );
  });

  it('refuses a sensor that names neither an index nor a name', async () => {
    await assert.rejects(() => run({}), /neither an interface index nor an interface name/);
  });

  it('refuses a device with no host', async () => {
    await assert.rejects(
      () => run({ ifIndex: 2 }, { target: { host: '', ipVersion: 'v4' } }),
      /no host to query/,
    );
  });

  it('reports a silent agent rather than hanging', async () => {
    agent.behave({ silent: true });
    await assert.rejects(() => run({ ifIndex: 2, timeoutMs: 150, retries: 0 }), /did not answer/);
  });

  it('returns promptly when the check is aborted', async () => {
    agent.behave({ silent: true });
    const controller = new AbortController();
    const started = Date.now();
    const pending = run(
      { ifIndex: 2, timeoutMs: 10_000, retries: 0 },
      { signal: controller.signal },
    );
    setTimeout(() => {
      controller.abort();
    }, 50);
    await assert.rejects(() => pending, /cancelled/);
    assert.ok(Date.now() - started < 2_000, 'abort must not wait out the SNMP timeout');
  });
});
