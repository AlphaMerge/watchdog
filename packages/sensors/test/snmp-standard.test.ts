import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { snmpCpu } from '../src/types/snmp-cpu.js';
import { snmpDiskFree } from '../src/types/snmp-disk-free.js';
import { snmpMemory } from '../src/types/snmp-memory.js';
import { snmpUptime } from '../src/types/snmp-uptime.js';
import type { CheckContext, CheckExecution, SensorType } from '../src/contract.js';
import { TestSnmpAgent, type AgentEntry } from '@ms/simulators';
import { assertDeclaresEveryKey } from './support/declared-keys.js';

/**
 * The MIB below is the dev target's own agent, copied from a live walk while `T-05` was written.
 * The awkward parts are the point: processors indexed from 196608, storage rows indexed
 * 1, 3, 6, 7, 10, 11, 31, 33, allocation units of 1024 on the memory rows and 4096 on the
 * filesystems, and `sysUpTime` disagreeing with `hrSystemUptime` by eight days.
 */
const HR_UPTIME = '1.3.6.1.2.1.25.1.1.0';
const SYS_UPTIME = '1.3.6.1.2.1.1.3.0';
const PROC_LOAD = '1.3.6.1.2.1.25.3.3.1.2';
const S_TYPE = '1.3.6.1.2.1.25.2.3.1.2';
const S_DESCR = '1.3.6.1.2.1.25.2.3.1.3';
const S_UNITS = '1.3.6.1.2.1.25.2.3.1.4';
const S_SIZE = '1.3.6.1.2.1.25.2.3.1.5';
const S_USED = '1.3.6.1.2.1.25.2.3.1.6';

const T_RAM = '1.3.6.1.2.1.25.2.1.2';
const T_VIRTUAL = '1.3.6.1.2.1.25.2.1.3';
const T_DISK = '1.3.6.1.2.1.25.2.1.4';
const T_OTHER = '1.3.6.1.2.1.25.2.1.1';

const UCD_TOTAL_SWAP = '1.3.6.1.4.1.2021.4.3.0';
const UCD_AVAIL_SWAP = '1.3.6.1.4.1.2021.4.4.0';
const UCD_TOTAL_REAL = '1.3.6.1.4.1.2021.4.5.0';
const UCD_AVAIL_REAL = '1.3.6.1.4.1.2021.4.6.0';
const UCD_BUFFER = '1.3.6.1.4.1.2021.4.14.0';
const UCD_CACHED = '1.3.6.1.4.1.2021.4.15.0';
const UCD_CPU_IDLE = '1.3.6.1.4.1.2021.11.11.0';

const KIB = 1024;
const GIB = 1024 ** 3;

interface StorageSpec {
  readonly row: number;
  readonly descr: string;
  readonly type: string;
  readonly units: number;
  readonly size: number;
  readonly used: number;
}

const STORAGE: StorageSpec[] = [
  { row: 1, descr: 'Physical memory', type: T_RAM, units: 1024, size: 8_126_756, used: 5_232_264 },
  {
    row: 3,
    descr: 'Virtual memory',
    type: T_VIRTUAL,
    units: 1024,
    size: 9_175_328,
    used: 5_782_224,
  },
  { row: 6, descr: 'Memory buffers', type: T_OTHER, units: 1024, size: 8_126_756, used: 54_596 },
  { row: 7, descr: 'Cached memory', type: T_OTHER, units: 1024, size: 2_774_084, used: 2_774_084 },
  { row: 10, descr: 'Swap space', type: T_VIRTUAL, units: 1024, size: 1_048_572, used: 549_960 },
  // net-snmp publishes Linux's own MemAvailable here. 5_292_996 KiB — well below free+cache.
  { row: 11, descr: 'Available memory', type: T_OTHER, units: 1024, size: 5_292_996, used: 0 },
  // 100 GiB, 40 GiB used, at 4096 bytes an allocation unit.
  { row: 31, descr: '/', type: T_DISK, units: 4096, size: 26_214_400, used: 10_485_760 },
  { row: 33, descr: '/dev', type: T_DISK, units: 4096, size: 16_384, used: 0 },
  {
    row: 44,
    descr: 'C:\\ Label:System  Serial Number 1a2b-3c4d',
    type: T_DISK,
    units: 4096,
    size: 26_214_400,
    used: 20_971_520,
  },
];

function storageEntries(): AgentEntry[] {
  const out: AgentEntry[] = [];
  for (const s of STORAGE) {
    out.push({ oid: `${S_TYPE}.${String(s.row)}`, type: 'OID', value: s.type });
    out.push({ oid: `${S_DESCR}.${String(s.row)}`, type: 'OctetString', value: s.descr });
    out.push({ oid: `${S_UNITS}.${String(s.row)}`, type: 'Integer', value: s.units });
    out.push({ oid: `${S_SIZE}.${String(s.row)}`, type: 'Integer', value: s.size });
    out.push({ oid: `${S_USED}.${String(s.row)}`, type: 'Integer', value: s.used });
  }
  return out;
}

/** Eight processors, indexed from 196608 the way a real agent does. */
const PROCESSORS: AgentEntry[] = [4, 3, 3, 3, 3, 3, 3, 3].map((load, at) => ({
  oid: `${PROC_LOAD}.${String(196_608 + at)}`,
  type: 'Integer',
  value: load,
}));

const UCD_ENTRIES: AgentEntry[] = [
  { oid: UCD_TOTAL_SWAP, type: 'Integer', value: 1_048_572 },
  { oid: UCD_AVAIL_SWAP, type: 'Integer', value: 498_612 },
  { oid: UCD_TOTAL_REAL, type: 'Integer', value: 8_126_756 },
  { oid: UCD_AVAIL_REAL, type: 'Integer', value: 2_886_860 },
  { oid: UCD_BUFFER, type: 'Integer', value: 54_220 },
  { oid: UCD_CACHED, type: 'Integer', value: 2_776_116 },
  { oid: UCD_CPU_IDLE, type: 'Integer', value: 97 },
];

/** 8.9 days for the host, 32 hours for the agent — the box had not rebooted. */
const HOST_TICKS = 76_895_839;
const AGENT_TICKS = 11_574_868;

const MIB: AgentEntry[] = [
  { oid: SYS_UPTIME, type: 'TimeTicks', value: AGENT_TICKS },
  { oid: HR_UPTIME, type: 'TimeTicks', value: HOST_TICKS },
  ...PROCESSORS,
  ...storageEntries(),
  ...UCD_ENTRIES,
];

/** The MIB without the OIDs whose prefixes are listed — for "this device has no …" cases. */
function without(...prefixes: string[]): AgentEntry[] {
  return MIB.filter((entry) => !prefixes.some((prefix) => entry.oid.startsWith(prefix)));
}

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

function run(
  type: SensorType,
  params: Record<string, unknown> = {},
  over: Partial<CheckContext> = {},
): Promise<CheckExecution> {
  return type.execute({
    sensorId: 1,
    target: { host: agent.host, ipVersion: 'v4' },
    params: { port: agent.port, timeoutMs: 400, retries: 0, ...params },
    credentials: { snmp: { version: 'v2c', community: 'public' } },
    signal: new AbortController().signal,
    ...over,
  });
}

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

describe('snmp.uptime', () => {
  it('reports the host’s uptime, not the SNMP agent’s', async () => {
    // The whole reason this type exists. `sysUpTime` counts from the last time the *agent*
    // re-initialised, and on the dev target it read 32 hours against the host's 8.9 days — a
    // sensor built on it would have reported a reboot that never happened.
    const execution = await run(snmpUptime);
    assert.equal(valueOf(execution, 'uptime'), HOST_TICKS / 100);
    assert.equal(valueOf(execution, 'agentUptime'), AGENT_TICKS / 100);
  });

  it('says when the agent restarted on its own', async () => {
    // A real event with real consequences: it explains a gap in every other SNMP sensor on the
    // device, and nothing else in the system is in a position to say so.
    const execution = await run(snmpUptime);
    assert.match(execution.message ?? '', /agent has been up .* less than the host/);
  });

  it('falls back to sysUpTime, and says the reading now means something else', async () => {
    // Most network hardware has no HOST-RESOURCES-MIB. Monitoring it is still right; pretending
    // the number means the same thing is not.
    agent.load(without(HR_UPTIME));
    const execution = await run(snmpUptime);
    assert.equal(valueOf(execution, 'uptime'), AGENT_TICKS / 100);
    assert.match(execution.message ?? '', /no hrSystemUptime.*will look like a restart/s);
  });

  it('reports seconds, which is what makes a "below 600" trigger mean ten minutes', () => {
    // Restart detection is a threshold trigger on this channel, so the unit is load-bearing:
    // raw TimeTicks would make every threshold somebody writes wrong by a factor of a hundred.
    const [channel] = snmpUptime.channels({});
    assert.ok(channel);
    assert.equal(channel.unit, 's');
    assert.equal(channel.isPrimary, true);
  });

  it('puts the boot time in the message, which is what a person actually reads', async () => {
    const execution = await run(snmpUptime);
    assert.match(execution.message ?? '', /up 8 days, 21 hours, since \d{4}-\d\d-\d\dT\d\d:\d\dZ/);
  });

  it('fails rather than guessing when the device reports no uptime at all', async () => {
    agent.load(without(HR_UPTIME, SYS_UPTIME));
    await assert.rejects(() => run(snmpUptime), /answered neither hrSystemUptime nor sysUpTime/);
  });

  it('warns near the point where the device’s own counter goes round', async () => {
    // TimeTicks wraps at 2^32 centiseconds — about 497 days — and the reading does not say how
    // many times it has. Network hardware genuinely reaches this.
    agent.load([
      { oid: HR_UPTIME, type: 'TimeTicks', value: 4_290_000_000 },
      { oid: SYS_UPTIME, type: 'TimeTicks', value: 4_290_000_000 },
    ]);
    const execution = await run(snmpUptime);
    assert.match(execution.message ?? '', /497-day point where the device’s counter goes round/);
  });
});

describe('snmp.cpu', () => {
  it('averages the processors and reports the busiest beside it', async () => {
    // A 32-core box with one pegged core averages 3% and is in trouble. The mean alone hides
    // exactly the case worth alarming on.
    const execution = await run(snmpCpu);
    assert.equal(valueOf(execution, 'load'), 3.13);
    assert.equal(valueOf(execution, 'loadMax'), 4);
    assert.equal(valueOf(execution, 'processors'), 8);
  });

  it('does not assume processor indexes start at one', async () => {
    // The dev target indexes its eight processors from 196608. An implementation walking 1..n
    // would find nothing at all.
    const execution = await run(snmpCpu);
    assert.equal(valueOf(execution, 'processors'), 8);
  });

  it('falls back to ssCpuIdle and gaps the per-processor channels', async () => {
    // Not filled with the average and 1: a "busiest processor" equal to the mean is a number an
    // operator would set a limit against, and it would be fiction.
    agent.load(without(PROC_LOAD));
    const execution = await run(snmpCpu);
    assert.equal(valueOf(execution, 'load'), 3);
    assert.equal(valueOf(execution, 'loadMax'), undefined);
    assert.equal(valueOf(execution, 'processors'), undefined);
    assert.match(execution.message ?? '', /no hrProcessorLoad, so there is no per-processor/);
  });

  it('refuses to fall back when the operator pinned the source', async () => {
    agent.load(without(PROC_LOAD));
    await assert.rejects(
      () => run(snmpCpu, { source: 'hr' }),
      /set to read HOST-RESOURCES-MIB only/,
    );
  });

  it('names both MIBs it looked in when neither answers', async () => {
    agent.load(without(PROC_LOAD, UCD_CPU_IDLE));
    await assert.rejects(
      () => run(snmpCpu),
      /neither HOST-RESOURCES-MIB \(hrProcessorLoad\) nor UCD-SNMP-MIB \(ssCpuIdle\)/,
    );
  });
});

describe('snmp.memory', () => {
  it('uses the kernel’s own MemAvailable where the agent publishes it', async () => {
    // Measured on the dev target, three sources on one box: MemAvailable 5169 MiB,
    // free+buffers+cached 5583 MiB, MemFree alone 2819 MiB. The last would call this machine
    // 64% used when the true figure is 35%.
    const execution = await run(snmpMemory);
    assert.equal(valueOf(execution, 'available'), 5_292_996 * KIB);
    assert.equal(valueOf(execution, 'total'), 8_126_756 * KIB);
    assert.equal(valueOf(execution, 'percentUsed'), 34.87);
    assert.match(execution.message ?? '', /Available memory.*MemAvailable/);
  });

  it('falls back to free + buffers + cached, and says so', async () => {
    agent.load(MIB.filter((entry) => entry.value !== 'Available memory'));
    const execution = await run(snmpMemory);
    assert.equal(valueOf(execution, 'available'), (2_886_860 + 54_220 + 2_776_116) * KIB);
    assert.match(execution.message ?? '', /memAvailReal \+ memBuffer \+ memCached/);
  });

  it('reports MemFree alone when told to, and says it reads low', async () => {
    const execution = await run(snmpMemory, { countCacheAsAvailable: false });
    assert.equal(valueOf(execution, 'available'), 2_886_860 * KIB);
    assert.equal(valueOf(execution, 'percentUsed'), 64.48);
    assert.match(execution.message ?? '', /MemFree and reads far lower than reality/);
  });

  it('converts UCD’s kilobytes to bytes', async () => {
    // The 1024× trap: UCD-SNMP-MIB reports kB and says so nowhere at the point of use.
    agent.load(without('1.3.6.1.2.1.25.2.3.1'));
    const execution = await run(snmpMemory);
    assert.equal(valueOf(execution, 'total'), 8_126_756 * KIB);
  });

  it('reports swap as its own pair of channels', async () => {
    // Swap filling up is a different fault from RAM filling up; adding them hides both.
    const execution = await run(snmpMemory);
    assert.equal(valueOf(execution, 'swapAvailable'), 498_612 * KIB);
    assert.equal(valueOf(execution, 'swapPercentUsed'), 52.45);
  });

  it('gaps swap rather than reporting a device with none as 0% used', async () => {
    agent.load(without(UCD_TOTAL_SWAP, UCD_AVAIL_SWAP));
    const execution = await run(snmpMemory);
    assert.equal(valueOf(execution, 'swapPercentUsed'), undefined);
    assert.equal(valueOf(execution, 'swapAvailable'), undefined);
  });

  it('names both MIBs it looked in when neither answers', async () => {
    agent.load(without('1.3.6.1.2.1.25.2.3.1', '1.3.6.1.4.1.2021.4'));
    await assert.rejects(() => run(snmpMemory), /neither HOST-RESOURCES-MIB.*nor UCD-SNMP-MIB/s);
  });
});

describe('snmp.diskfree', () => {
  it('multiplies by the allocation units, which is the whole job', async () => {
    // `hrStorageSize` is a count of allocation units, not bytes, and the unit differs per row on
    // the same device — 1024 on the memory rows and 4096 on the filesystems here. A sensor
    // reading the column raw reports a filesystem four times too small.
    const execution = await run(snmpDiskFree, { mountPoint: '/' });
    assert.equal(valueOf(execution, 'total'), 100 * GIB);
    assert.equal(valueOf(execution, 'used'), 40 * GIB);
    assert.equal(valueOf(execution, 'free'), 60 * GIB);
    assert.equal(valueOf(execution, 'percentUsed'), 40);
  });

  it('finds the filesystem by mount point rather than by index', async () => {
    const execution = await run(snmpDiskFree, { mountPoint: '/dev' });
    assert.equal(valueOf(execution, 'total'), 64 * 1024 * 1024);
    assert.match(execution.message ?? '', /row 33 found by name/);
  });

  it('checks a hinted index and uses it when it still holds', async () => {
    agent.resetCounters();
    const execution = await run(snmpDiskFree, { mountPoint: '/', storageIndex: '31' });
    assert.equal(valueOf(execution, 'total'), 100 * GIB);
    assert.equal(agent.requests, 2, 'one request to verify the hint, one to read the row');
  });

  it('re-walks when the hinted index has moved to a different filesystem', async () => {
    // The failure this type is shaped around: hrStorageIndex is arbitrary and changes when a
    // filesystem is mounted, and a sensor that trusted its hint would silently start reporting
    // free space for something else.
    const execution = await run(snmpDiskFree, { mountPoint: '/', storageIndex: '33' });
    assert.equal(valueOf(execution, 'total'), 100 * GIB, 'should have followed "/" to row 31');
    assert.match(execution.message ?? '', /found by name/);
  });

  it('matches the front of a description, for Windows', async () => {
    // Windows reports `C:\ Label:System  Serial Number 1a2b-3c4d`, where the only part anybody
    // can type reliably — and the only part that survives a relabel — is the front.
    const execution = await run(snmpDiskFree, {
      mountPoint: 'c:\\',
      matchMode: 'startsWith',
    });
    assert.equal(valueOf(execution, 'percentUsed'), 80);
  });

  it('lists what the device does have when the mount point is not one of them', async () => {
    // Nearly always a typo or a decorated description away from something already in the list,
    // so printing the list is the difference between a five-second fix and an snmpwalk session.
    await assert.rejects(
      () => run(snmpDiskFree, { mountPoint: '/srv' }),
      /has no storage called "\/srv" — it reports .*"\/", "\/dev"/s,
    );
  });

  it('notes a row that is not a disk rather than refusing it', async () => {
    // An operator may deliberately watch a RAM disk. It is still the usual reason a "disk"
    // sensor reports a suspiciously small volume.
    const execution = await run(snmpDiskFree, { mountPoint: 'Physical memory' });
    assert.match(execution.message ?? '', /this row is not a disk/);
  });

  it('fails rather than reporting a filesystem with no usage as empty', async () => {
    agent.load(MIB.filter((entry) => entry.oid !== `${S_USED}.31`));
    await assert.rejects(
      () => run(snmpDiskFree, { mountPoint: '/' }),
      /no hrStorageUsed.*reassuring lie/s,
    );
  });

  it('says so when the device has no storage table at all', async () => {
    agent.load(without('1.3.6.1.2.1.25.2.3.1'));
    await assert.rejects(
      () => run(snmpDiskFree, { mountPoint: '/' }),
      /no storage table at all, so it has no HOST-RESOURCES-MIB/,
    );
  });
});

describe('all four types', () => {
  const types = [snmpCpu, snmpDiskFree, snmpMemory, snmpUptime];

  it('declare exactly one primary channel', () => {
    for (const type of types) {
      assert.equal(type.channels({}).filter((c) => c.isPrimary === true).length, 1, type.id);
    }
  });

  it('need SNMP credentials and say which kind is missing', async () => {
    for (const type of types) {
      await assert.rejects(
        () => run(type, { mountPoint: '/' }, { credentials: {} }),
        /no SNMP credentials are set on this device or any group above it/,
        type.id,
      );
    }
  });

  it('return promptly when the check is aborted', async () => {
    for (const type of types) {
      agent.behave({ silent: true });
      const controller = new AbortController();
      const started = Date.now();
      const pending = run(
        type,
        { mountPoint: '/', timeoutMs: 10_000, retries: 0 },
        { signal: controller.signal },
      );
      setTimeout(() => {
        controller.abort();
      }, 50);
      await assert.rejects(() => pending, /cancelled/, type.id);
      assert.ok(Date.now() - started < 2_000, type.id);
    }
  });

  it('report only keys their declaration names, on each path (P-320)', async () => {
    // Each path that leaves a channel out as well as the full one. A key the declaration does not
    // name would be a broken promise to the core, and a live channel shown retired.
    const cases: [SensorType, Record<string, unknown>, AgentEntry[]][] = [
      [snmpUptime, {}, MIB],
      [snmpUptime, {}, without(HR_UPTIME)],
      [snmpCpu, {}, MIB],
      [snmpCpu, {}, without(PROC_LOAD)],
      [snmpMemory, {}, MIB],
      [snmpMemory, { countCacheAsAvailable: false }, MIB],
      [snmpMemory, {}, without('1.3.6.1.2.1.25.2.3.1')],
      [snmpMemory, {}, without(UCD_TOTAL_SWAP, UCD_AVAIL_SWAP)],
      [snmpDiskFree, { mountPoint: '/' }, MIB],
      [snmpDiskFree, { mountPoint: '/', storageIndex: '31' }, MIB],
      [snmpDiskFree, { mountPoint: 'c:\\', matchMode: 'startsWith' }, MIB],
    ];
    for (const [type, params, mib] of cases) {
      agent.load(mib);
      assertDeclaresEveryKey(type.id, params, await run(type, params));
    }
  });
});
