import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { snmpCustom } from '../src/types/snmp-custom.js';
import { snmpCustomString } from '../src/types/snmp-custom-string.js';
import type { CheckContext, CheckExecution, SensorType } from '../src/contract.js';
import { TestSnmpAgent, type AgentEntry } from './support/snmp-agent.js';

const SYS_DESCR = '1.3.6.1.2.1.1.1.0';
const UPTIME = '1.3.6.1.2.1.1.3.0';
const TEMP_TEXT = '1.3.6.1.4.1.9999.1.1.0';
const BATTERY_TEXT = '1.3.6.1.4.1.9999.1.2.0';
const COUNTER32 = '1.3.6.1.4.1.9999.2.1.0';
const COUNTER64 = '1.3.6.1.4.1.9999.2.2.0';
const GAUGE = '1.3.6.1.4.1.9999.3.1.0';
const NUMBER_AS_TEXT = '1.3.6.1.4.1.9999.4.1.0';
/** A long run of one character with a mismatching tail — the shape that makes a regex explode. */
const BACKTRACK_BAIT = '1.3.6.1.4.1.9999.5.1.0';

const MIB: AgentEntry[] = [
  { oid: SYS_DESCR, type: 'OctetString', value: 'Cisco IOS Software, Version 15.2(4)S7' },
  { oid: UPTIME, type: 'TimeTicks', value: 987_654 },
  { oid: TEMP_TEXT, type: 'OctetString', value: 'Inlet Temp: 41.5C (normal)' },
  { oid: BATTERY_TEXT, type: 'OctetString', value: 'batteryNormal' },
  { oid: COUNTER32, type: 'Counter', value: 4_000_000 },
  { oid: COUNTER64, type: 'Counter64', value: 18_014_398_509_482_000n },
  { oid: GAUGE, type: 'Gauge', value: 73 },
  { oid: NUMBER_AS_TEXT, type: 'OctetString', value: '  42  ' },
  { oid: BACKTRACK_BAIT, type: 'OctetString', value: `${'a'.repeat(200)}b` },
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

function run(
  type: SensorType,
  params: Record<string, unknown>,
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

const only = (execution: CheckExecution) => execution.channels[0];

describe('snmp.custom — an arbitrary numeric OID', () => {
  it('reads a gauge and reports it as it stands', async () => {
    const execution = await run(snmpCustom, { oid: GAUGE });
    assert.equal(only(execution)?.value, 73);
    assert.equal(only(execution)?.counter, undefined, 'a gauge is not a counter');
  });

  it('names the channel and the unit the operator chose', () => {
    const [channel] = snmpCustom.channels({ channelName: 'Battery charge', unit: '%' });
    assert.ok(channel);
    assert.equal(channel.name, 'Battery charge');
    assert.equal(channel.unit, '%');
    assert.equal(channel.isPrimary, true);
  });

  it('appends /s to the unit for a counter, because that is what gets stored', () => {
    // The stored sample is a rate (`T-02`), so a channel labelled "octets" would be labelled
    // wrong on its own axis.
    assert.equal(snmpCustom.channels({ mode: 'counter', unit: 'octets' })[0]?.unit, 'octets/s');
    assert.equal(snmpCustom.channels({ mode: 'gauge', unit: 'octets' })[0]?.unit, 'octets');
  });

  it('declares a counter channel only in counter mode', () => {
    assert.equal(snmpCustom.channels({ mode: 'counter' })[0]?.counter?.bits, 64);
    assert.equal(snmpCustom.channels({ mode: 'gauge' })[0]?.counter, undefined);
  });

  it('sends a counter exactly, with the width the device actually used', async () => {
    const wide = await run(snmpCustom, { oid: COUNTER64, mode: 'counter' });
    assert.equal(only(wide)?.counter, '18014398509482000');
    assert.equal(only(wide)?.counterBits, 64);

    const narrow = await run(snmpCustom, { oid: COUNTER32, mode: 'counter' });
    assert.equal(only(narrow)?.counter, '4000000');
    // Declared 64 by `channels()`, which cannot know; corrected here, or every 32-bit wrap would
    // read as a device reset (`T-02`).
    assert.equal(only(narrow)?.counterBits, 32);
  });

  it('says so when the device disagrees with the reading type', async () => {
    // The single most likely reason a graph looks wrong, and nothing else in the system can
    // tell. Not a failure: a vendor exposing a counter as an Integer is real.
    const asGauge = await run(snmpCustom, { oid: COUNTER64, mode: 'gauge' });
    assert.match(asGauge.message ?? '', /only ever goes up/);

    const asCounter = await run(snmpCustom, { oid: GAUGE, mode: 'counter' });
    assert.match(
      asCounter.message ?? '',
      /treats .* as a counter, and the device returned a Gauge/,
    );
  });

  it('puts the value and its SNMP type in the message', async () => {
    assert.match((await run(snmpCustom, { oid: UPTIME })).message ?? '', /= 987654 \(TimeTicks\)/);
  });

  it('fails, naming the OID, when the device has no such object', async () => {
    // Also what an agent says about a table column asked for without a row index, which is the
    // mistake somebody makes first.
    await assert.rejects(
      () => run(snmpCustom, { oid: '1.3.6.1.4.1.12345.1' }),
      /has no object at 1\.3\.6\.1\.4\.1\.12345\.1.*no such object/s,
    );
  });

  it('points at the string type when the object is text', async () => {
    await assert.rejects(
      () => run(snmpCustom, { oid: SYS_DESCR }),
      /which is not a number — use SNMP Custom String/,
    );
  });

  it('normalises a leading dot rather than querying something else', async () => {
    assert.equal(only(await run(snmpCustom, { oid: `.${GAUGE}` }))?.value, 73);
  });
});

describe('snmp.custom.string — an arbitrary string OID', () => {
  it('pulls a number out with a capture group', async () => {
    const execution = await run(snmpCustomString, {
      oid: TEMP_TEXT,
      pattern: 'Temp: ([0-9.]+)C',
    });
    assert.equal(only(execution)?.value, 41.5);
  });

  it('parses the whole string when no pattern is given', async () => {
    // An agent reporting a number as an OctetString is common enough to be the default path.
    assert.equal(only(await run(snmpCustomString, { oid: NUMBER_AS_TEXT }))?.value, 42);
  });

  it('reports 1 when a phrase is present in match mode', async () => {
    const execution = await run(snmpCustomString, {
      oid: SYS_DESCR,
      pattern: 'Cisco',
      mode: 'match',
    });
    assert.equal(only(execution)?.value, 1);
  });

  it('reports 0 rather than failing when the phrase is gone', async () => {
    // "The phrase is gone" is the reading — it is what a limit or a lookup is set against — and
    // failing the check instead would make the sensor Down and lose the data point.
    const execution = await run(snmpCustomString, {
      oid: SYS_DESCR,
      pattern: 'Juniper',
      mode: 'match',
    });
    assert.equal(only(execution)?.value, 0);
    assert.match(execution.message ?? '', /did not match/);
  });

  it('always carries what the device actually said', async () => {
    // The only way to tell "my pattern is wrong" from "the device changed what it reports".
    const execution = await run(snmpCustomString, { oid: TEMP_TEXT, pattern: 'Temp: ([0-9.]+)C' });
    assert.match(execution.message ?? '', /Inlet Temp: 41\.5C \(normal\)/);
  });

  it('declares the lookup the operator named, and none when they did not', () => {
    assert.equal(
      snmpCustomString.channels({ lookup: 'ms.snmp.if-oper-status' })[0]?.lookup,
      'ms.snmp.if-oper-status',
    );
    // An empty id would have the core hunting for a lookup called "" and reporting it missing
    // on every scan.
    assert.equal(snmpCustomString.channels({ lookup: '' })[0]?.lookup, undefined);
    assert.equal(snmpCustomString.channels({})[0]?.lookup, undefined);
  });

  it('fails with the device text when it needed a number and did not get one', async () => {
    await assert.rejects(
      () => run(snmpCustomString, { oid: BATTERY_TEXT }),
      /matched "batteryNormal", which is not a number — use the match mode/,
    );
  });

  it('fails with the device text when the pattern did not match in number mode', async () => {
    await assert.rejects(
      () => run(snmpCustomString, { oid: SYS_DESCR, pattern: 'Temp: ([0-9]+)' }),
      /did not match .*the device says "Cisco IOS Software/s,
    );
  });

  it('refuses a pattern that is not a regular expression, before querying anything', async () => {
    agent.resetCounters();
    await assert.rejects(
      () => run(snmpCustomString, { oid: SYS_DESCR, pattern: '([0-9]+' }),
      /not a valid regular expression/,
    );
    assert.equal(agent.requests, 0, 'a bad pattern should not trouble the device');
  });

  it('stops a backtracking pattern and says which one', async () => {
    // `^(a+)+$` against two hundred a's and a b is the exponential case. Run directly this does
    // not finish — the equivalent at forty characters already takes 86 seconds — and it would
    // hold the worker until the pool terminated it. The sensor fails the check instead, naming
    // the pattern, which is the thing to go and fix.
    const started = Date.now();
    await assert.rejects(
      () => run(snmpCustomString, { oid: BACKTRACK_BAIT, pattern: '^(a+)+$', mode: 'match' }),
      /still running after \d+ ms and was stopped.*nested quantifier/s,
    );
    assert.ok(Date.now() - started < 5_000, 'the watchdog, not the scan interval, ends it');
  });

  it('reads a numeric object as text, which is harmless and sometimes useful', async () => {
    // Not an error. A Gauge stringifies to "73" and parses back to 73; refusing it would only
    // send an operator to a different sensor type to get the same number.
    assert.equal(only(await run(snmpCustomString, { oid: GAUGE }))?.value, 73);
  });
});

describe('both types', () => {
  it('need SNMP credentials and say which kind is missing', async () => {
    for (const type of [snmpCustom, snmpCustomString]) {
      await assert.rejects(
        () => run(type, { oid: GAUGE }, { credentials: {} }),
        /no SNMP credentials are set on this device or any group above it/,
        type.id,
      );
    }
  });

  it('declare exactly one primary channel', () => {
    for (const type of [snmpCustom, snmpCustomString]) {
      assert.equal(type.channels({}).filter((c) => c.isPrimary === true).length, 1, type.id);
    }
  });

  it('return promptly when the check is aborted', async () => {
    agent.behave({ silent: true });
    const controller = new AbortController();
    const started = Date.now();
    const pending = run(
      snmpCustom,
      { oid: GAUGE, timeoutMs: 10_000, retries: 0 },
      { signal: controller.signal },
    );
    setTimeout(() => {
      controller.abort();
    }, 50);
    await assert.rejects(() => pending, /cancelled/);
    assert.ok(Date.now() - started < 2_000);
  });
});
