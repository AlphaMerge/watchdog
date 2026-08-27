import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { snmpTable } from '../src/types/snmp-table.js';
import { standardCatalogue } from '../src/index.js';
import type { CheckContext, CheckExecution } from '../src/contract.js';
import { TestSnmpAgent, type AgentEntry } from './support/snmp-agent.js';

/** `hrStorageEntry`, which is the table this type gets pointed at most often. */
const TABLE = '1.3.6.1.2.1.25.2.3.1';
const DESCR = 3;
const UNITS = 4;
const SIZE = 5;
const USED = 6;
const FAILS = 7;
const STATE = 9;
const HC_FAILS = 11;

/** A table indexed by two arcs, which plenty of real ones are. */
const COMPOSITE = '1.3.6.1.4.1.9999.7.1';

const column = (relative: number, row: string): string => `${TABLE}.${String(relative)}.${row}`;

const MIB: AgentEntry[] = [
  { oid: column(DESCR, '1'), type: 'OctetString', value: '/' },
  { oid: column(DESCR, '2'), type: 'OctetString', value: '/var' },
  { oid: column(DESCR, '3'), type: 'OctetString', value: 'Physical memory' },
  // A long run of one character with a mismatching tail — the shape that makes a regex explode.
  { oid: column(DESCR, '4'), type: 'OctetString', value: `${'a'.repeat(200)}b` },

  { oid: column(UNITS, '1'), type: 'Integer', value: 4_096 },
  { oid: column(UNITS, '2'), type: 'Integer', value: 4_096 },
  { oid: column(UNITS, '3'), type: 'Integer', value: 1_024 },

  { oid: column(SIZE, '1'), type: 'Integer', value: 1_000_000 },
  { oid: column(SIZE, '2'), type: 'Integer', value: 500_000 },
  { oid: column(SIZE, '3'), type: 'Integer', value: 8_000_000 },

  { oid: column(USED, '1'), type: 'Integer', value: 250_000 },
  { oid: column(USED, '2'), type: 'Integer', value: 400_000 },
  { oid: column(USED, '3'), type: 'Integer', value: 3_000_000 },

  // Row 3 deliberately has no allocation-failure counter: an agent that implements a table but
  // not every column of it is ordinary, and it is the case a channel must *gap* rather than zero.
  { oid: column(FAILS, '1'), type: 'Counter', value: 0 },
  { oid: column(FAILS, '2'), type: 'Counter', value: 17 },

  { oid: column(HC_FAILS, '2'), type: 'Counter64', value: 18_014_398_509_482_000n },

  { oid: column(STATE, '1'), type: 'Integer', value: 1 },
  { oid: column(STATE, '2'), type: 'Integer', value: 2 },
  { oid: column(STATE, '3'), type: 'Integer', value: 1 },

  { oid: `${COMPOSITE}.1.10.2`, type: 'OctetString', value: 'port-a' },
  { oid: `${COMPOSITE}.1.10.3`, type: 'OctetString', value: 'port-b' },
  { oid: `${COMPOSITE}.2.10.2`, type: 'Integer', value: 55 },
  { oid: `${COMPOSITE}.2.10.3`, type: 'Integer', value: 66 },
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
  params: Record<string, unknown>,
  over: Partial<CheckContext> = {},
): Promise<CheckExecution> {
  return snmpTable.execute({
    sensorId: 1,
    target: { host: agent.host, ipVersion: 'v4' },
    params: {
      port: agent.port,
      timeoutMs: 400,
      retries: 0,
      tableOid: TABLE,
      ...params,
    },
    credentials: { snmp: { version: 'v2c', community: 'public' } },
    signal: new AbortController().signal,
    ...over,
  });
}

const SIZE_AND_USED = [
  { column: String(SIZE), name: 'Size', unit: 'blocks' },
  { column: String(USED), name: 'Used', unit: 'blocks' },
];

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

describe('snmp.table — a channel per column of one row', () => {
  it('reads the row it was pinned to, one channel per column', async () => {
    const execution = await run({ rowIndex: '2', columns: SIZE_AND_USED });
    assert.equal(execution.channels.length, 2);
    assert.equal(valueOf(execution, 'col5'), 500_000);
    assert.equal(valueOf(execution, 'col6'), 400_000);
  });

  it('reads the whole row in one request, however many columns there are', async () => {
    // The instances are known once the index is, so a five-column sensor is a Get and not five
    // walks. This is what keeps a table sensor as cheap as a single-OID one.
    agent.resetCounters();
    await run({
      rowIndex: '2',
      columns: [
        { column: String(UNITS), name: 'Units' },
        { column: String(SIZE), name: 'Size' },
        { column: String(USED), name: 'Used' },
        { column: String(FAILS), name: 'Failures', mode: 'counter' },
        { column: String(STATE), name: 'State' },
      ],
    });
    assert.equal(agent.requests, 1);
  });

  it('names the channels and makes the first the one the sensor is judged by', () => {
    const defs = snmpTable.channels({ columns: SIZE_AND_USED });
    assert.deepEqual(
      defs.map((def) => ({ key: def.key, name: def.name, unit: def.unit })),
      [
        { key: 'col5', name: 'Size', unit: 'blocks' },
        { key: 'col6', name: 'Used', unit: 'blocks' },
      ],
    );
    assert.deepEqual(
      defs.filter((def) => def.isPrimary === true).map((def) => def.key),
      ['col5'],
    );
  });

  it('derives the channel key from the column, so a rename keeps the history', () => {
    // The key is stable within the sensor and is never the label. Deriving it also makes two
    // columns with the same key impossible, which the one-key-per-sensor constraint would
    // otherwise turn into a failed insert at sensor creation.
    assert.equal(snmpTable.channels({ columns: [{ column: '6', name: 'Used' }] })[0]?.key, 'col6');
    assert.equal(
      snmpTable.channels({ columns: [{ column: '1.6', name: 'Nested' }] })[0]?.key,
      'col1_6',
    );
    assert.equal(
      snmpTable.channels({ columns: [{ column: '6', name: 'Before' }] })[0]?.key,
      snmpTable.channels({ columns: [{ column: '6', name: 'After' }] })[0]?.key,
    );
  });

  it('treats the same column listed twice as one channel', () => {
    // Idempotent rather than lossy: two entries for column 6 is one channel for column 6, where
    // declaring it twice would violate the unique key per sensor at insert time.
    const defs = snmpTable.channels({
      columns: [
        { column: '6', name: 'Used' },
        { column: '6', name: 'Used again' },
      ],
    });
    assert.equal(defs.length, 1);
    assert.equal(defs[0]?.name, 'Used');
  });
});

describe('finding the row', () => {
  it('finds it by what the naming column says', async () => {
    const execution = await run({
      indexColumn: String(DESCR),
      rowMatch: '/var',
      columns: SIZE_AND_USED,
    });
    assert.equal(valueOf(execution, 'col6'), 400_000);
    assert.match(execution.message ?? '', /row 2 "\/var" found by name/);
  });

  it('follows the row when the device has renumbered the table', async () => {
    // The reason naming a row exists at all. The sensor was created against row 1; the table has
    // since been reordered, and an index-pinned sensor would now be watching a different volume
    // with nothing anywhere to say that it happened.
    const execution = await run({
      indexColumn: String(DESCR),
      rowMatch: '/var',
      rowIndex: '1',
      columns: SIZE_AND_USED,
    });
    assert.equal(valueOf(execution, 'col6'), 400_000, 'should have followed /var to row 2');
    assert.match(execution.message ?? '', /row 2/);
  });

  it('checks the hinted index first, so an unchanged table costs no walk', async () => {
    agent.resetCounters();
    await run({
      indexColumn: String(DESCR),
      rowMatch: '/var',
      rowIndex: '2',
      columns: SIZE_AND_USED,
    });
    const withHint = agent.requests;

    agent.resetCounters();
    await run({
      indexColumn: String(DESCR),
      rowMatch: '/var',
      rowIndex: '1',
      columns: SIZE_AND_USED,
    });
    assert.equal(withHint, 2, 'one request to check the hint, one to read the row');
    assert.ok(agent.requests > withHint, 'a wrong hint has to walk the naming column');
  });

  it('matches on part of the value, and on a pattern', async () => {
    const contains = await run({
      indexColumn: String(DESCR),
      rowMatch: 'memory',
      rowMatchMode: 'contains',
      columns: SIZE_AND_USED,
    });
    assert.equal(valueOf(contains, 'col5'), 8_000_000);

    const regex = await run({
      indexColumn: String(DESCR),
      rowMatch: '^/va',
      rowMatchMode: 'regex',
      columns: SIZE_AND_USED,
    });
    assert.equal(valueOf(regex, 'col5'), 500_000);
  });

  it('ignores case and surrounding space on an exact match', async () => {
    const execution = await run({
      indexColumn: String(DESCR),
      rowMatch: '  Physical Memory ',
      columns: SIZE_AND_USED,
    });
    assert.equal(valueOf(execution, 'col5'), 8_000_000);
  });

  it('reads a table indexed by more than one arc', async () => {
    // `rowIndex` is text and not an integer for this: plenty of real tables are indexed by an
    // address or a pair, and an integer parameter would make them unreachable.
    const execution = await run({
      tableOid: COMPOSITE,
      rowIndex: '10.3',
      columns: [{ column: '2', name: 'Value' }],
    });
    assert.equal(valueOf(execution, 'col2'), 66);

    const byName = await run({
      tableOid: COMPOSITE,
      indexColumn: '1',
      rowMatch: 'port-a',
      columns: [{ column: '2', name: 'Value' }],
    });
    assert.equal(valueOf(byName, 'col2'), 55);
    assert.match(byName.message ?? '', /row 10\.2/);
  });

  it('fails, naming what it looked for, when no row matches', async () => {
    await assert.rejects(
      () =>
        run({
          indexColumn: String(DESCR),
          rowMatch: '/opt',
          columns: SIZE_AND_USED,
        }),
      /no row of 1\.3\.6\.1\.2\.1\.25\.2\.3\.1 on .* has a .*\.3 of "\/opt"/,
    );
  });

  it('fails when the row index does not exist', async () => {
    await assert.rejects(
      () => run({ rowIndex: '99', columns: SIZE_AND_USED }),
      /has no row 99 in 1\.3\.6\.1\.2\.1\.25\.2\.3\.1.*no such object/s,
    );
  });

  it('refuses a row value with no column to look for it in', async () => {
    agent.resetCounters();
    await assert.rejects(
      () => run({ rowMatch: '/var', columns: SIZE_AND_USED }),
      /looks for "\/var" but names no column to look in/,
    );
    assert.equal(agent.requests, 0, 'a misconfigured sensor should not trouble the device');
  });

  it('refuses a sensor that names no row at all', async () => {
    await assert.rejects(() => run({ columns: SIZE_AND_USED }), /names no row of/);
  });

  it('refuses a pattern that is not a regular expression, before querying anything', async () => {
    agent.resetCounters();
    await assert.rejects(
      () =>
        run({
          indexColumn: String(DESCR),
          rowMatch: '([0-9]+',
          rowMatchMode: 'regex',
          columns: SIZE_AND_USED,
        }),
      /not a valid regular expression/,
    );
    assert.equal(agent.requests, 0);
  });

  it('stops a backtracking pattern on the first row it explodes on', async () => {
    // Matching runs against every row of the naming column, so a pattern that backtracks would
    // otherwise cost the watchdog's 250 ms *per row*. It fails the check on the first one
    // instead, naming the pattern, which is the thing to go and fix.
    const started = Date.now();
    await assert.rejects(
      () =>
        run({
          indexColumn: String(DESCR),
          rowMatch: '^(a+)+$',
          rowMatchMode: 'regex',
          columns: SIZE_AND_USED,
        }),
      /still running after \d+ ms and was stopped.*nested quantifier/s,
    );
    assert.ok(Date.now() - started < 5_000, 'the watchdog, not the scan interval, ends it');
  });
});

describe('the columns themselves', () => {
  it('sends a counter exactly, with the width the device actually used', async () => {
    const execution = await run({
      rowIndex: '2',
      columns: [
        { column: String(FAILS), name: 'Failures', mode: 'counter' },
        { column: String(HC_FAILS), name: 'Failures 64', mode: 'counter' },
      ],
    });
    const narrow = execution.channels.find((channel) => channel.key === 'col7');
    const wide = execution.channels.find((channel) => channel.key === 'col11');
    assert.ok(narrow);
    assert.ok(wide);
    assert.equal(narrow.counter, '17');
    // Declared 64 by `channels()`, which cannot know; corrected here, or every 32-bit wrap would
    // read as a device reset (`T-02`).
    assert.equal(narrow.counterBits, 32);
    assert.equal(wide.counter, '18014398509482000');
    assert.equal(wide.counterBits, 64);
  });

  it('declares a counter channel, and appends /s to its unit', () => {
    const [failures, used] = snmpTable.channels({
      columns: [
        { column: '7', name: 'Failures', unit: 'failures', mode: 'counter' },
        { column: '6', name: 'Used', unit: 'blocks' },
      ],
    });
    assert.ok(failures);
    assert.ok(used);
    assert.equal(failures.counter?.bits, 64);
    assert.equal(failures.unit, 'failures/s');
    assert.equal(used.counter, undefined);
    assert.equal(used.unit, 'blocks');
  });

  it('declares the lookup a column names, and none when it names nothing', () => {
    const defs = snmpTable.channels({
      columns: [
        { column: '9', name: 'State', lookup: 'ms.snmp.if-oper-status' },
        { column: '6', name: 'Used', lookup: '' },
      ],
    });
    assert.equal(defs[0]?.lookup, 'ms.snmp.if-oper-status');
    // An empty id would have the core hunting for a lookup called "" and reporting it missing
    // on every scan.
    assert.equal(defs[1]?.lookup, undefined);
  });

  it('says so when a column’s reading type disagrees with the device', async () => {
    const asGauge = await run({
      rowIndex: '2',
      columns: [{ column: String(FAILS), name: 'Failures' }],
    });
    assert.match(asGauge.message ?? '', /only ever goes up/);

    const asCounter = await run({
      rowIndex: '2',
      columns: [{ column: String(USED), name: 'Used', mode: 'counter' }],
    });
    assert.match(asCounter.message ?? '', /read as a counter and the device returned a Integer/);
  });

  it('gaps a column the device does not implement rather than reporting zero', async () => {
    // CLAUDE.md: no-data is not zero. Row 3 has no allocation-failure counter, and a channel
    // fed 0 for it would draw a flat line at the floor that an operator would read as "no
    // failures" rather than as "this device does not count them".
    const execution = await run({
      rowIndex: '3',
      columns: [
        { column: String(USED), name: 'Used' },
        { column: String(FAILS), name: 'Failures', mode: 'counter' },
      ],
    });
    assert.deepEqual(
      execution.channels.map((channel) => channel.key),
      ['col6'],
    );
    assert.match(execution.message ?? '', /Failures .* is not implemented on this device/);
  });

  it('reports a text column rather than turning it into a number', async () => {
    await assert.rejects(
      () => run({ rowIndex: '2', columns: [{ column: String(DESCR), name: 'Description' }] }),
      /produced no readings.*OctetString, which is not a number/s,
    );
  });

  it('carries the row’s name in the message on every scan', async () => {
    // How an operator answers "am I still watching the right volume?" without a walk of their
    // own — and the only thing that would show a table having been renumbered under an
    // index-pinned sensor.
    const execution = await run({
      rowIndex: '2',
      indexColumn: String(DESCR),
      columns: SIZE_AND_USED,
    });
    assert.match(execution.message ?? '', /row 2 "\/var"/);
  });
});

describe('the type as the catalogue sees it', () => {
  const catalogue = standardCatalogue();

  it('declares one primary channel with no parameters, which is what registration checks', () => {
    const defs = snmpTable.channels({});
    assert.equal(defs.filter((def) => def.isPrimary === true).length, 1);
  });

  it('requires a table and at least one column', () => {
    const result = catalogue.validate('snmp.table', { tableOid: TABLE, columns: [] });
    assert.ok(!result.valid);
    assert.equal(result.problems[0]?.path, '/columns');
  });

  it('names the OID it actually asked for when a column is a whole OID', async () => {
    // The mistake somebody makes first — and the schema cannot catch it, because
    // `1.3.6.1.2.1.25.2.3.1.6` is a syntactically valid position *under* the table. It is caught
    // where it shows: the agent says "no such object", and printing the doubled prefix back is
    // what turns that into a diagnosis rather than a shrug.
    const result = catalogue.validate('snmp.table', {
      tableOid: TABLE,
      rowIndex: '1',
      columns: [{ column: `${TABLE}.6`, name: 'Used' }],
    });
    assert.ok(result.valid, 'syntactically it is a relative OID, so the schema accepts it');

    await assert.rejects(
      () => run({ rowIndex: '1', columns: [{ column: `${TABLE}.6`, name: 'Used' }] }),
      new RegExp(
        `asked for ${TABLE.replace(/\./g, '\\.')}\\.${TABLE.replace(/\./g, '\\.')}\\.6\\.1`,
      ),
    );
  });

  it('fills in a column’s defaults, so channels() never has to guess', () => {
    const result = catalogue.validate('snmp.table', {
      tableOid: TABLE,
      rowIndex: '1',
      columns: [{ column: '6', name: 'Used' }],
    });
    assert.ok(result.valid);
    assert.deepEqual(result.params['columns'], [
      { column: '6', name: 'Used', unit: '', mode: 'gauge', lookup: '' },
    ]);
  });

  it('needs SNMP credentials and says which kind is missing', async () => {
    await assert.rejects(
      () => run({ rowIndex: '2', columns: SIZE_AND_USED }, { credentials: {} }),
      /no SNMP credentials are set on this device or any group above it/,
    );
  });

  it('returns promptly when the check is aborted', async () => {
    agent.behave({ silent: true });
    const controller = new AbortController();
    const started = Date.now();
    const pending = run(
      { rowIndex: '2', columns: SIZE_AND_USED, timeoutMs: 10_000, retries: 0 },
      { signal: controller.signal },
    );
    setTimeout(() => {
      controller.abort();
    }, 50);
    await assert.rejects(() => pending, /cancelled/);
    assert.ok(Date.now() - started < 2_000);
  });
});
