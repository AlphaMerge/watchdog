import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { pino } from 'pino';
import { SensorCatalogue, standardCatalogue, type SensorType } from '@ms/sensors';
import type { CheckResult, IngestionConfig, Logger } from '@ms/shared';
import { Visibility } from '../src/auth/access.js';
import { Migrator } from '../src/db/migrator.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { repairChannelShapes } from '../src/db/migrations/073-channel-declared-shape.js';
import type { Database } from '../src/db/pool.js';
import { ChannelResolver } from '../src/ingestion/channels.js';
import { Ingestor } from '../src/ingestion/ingestor.js';
import { IngestionService } from '../src/ingestion/service.js';
import type { LookupCatalogue } from '../src/lookups/catalogue.js';
import { loadLookups } from '../src/lookups/loader.js';
import { PauseRepository } from '../src/objects/pause-repository.js';
import { CHANNEL_COLUMNS_A_CLONE_OWNS, CLONED_CHANNEL_COLUMNS } from '../src/objects/repository.js';
import { SensorStateService } from '../src/state/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();
const skip = available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)';

/** The shipped catalogue: the types whose declarations a clone has to keep. */
const catalogue = standardCatalogue();

const IF_TABLE = '1.3.6.1.2.1.2.2.1';
const STATUS = 'ms.snmp.if-oper-status';

/**
 * Every shipped type that declares a lookup or a counter (`P-297`'s survey), with parameters that
 * make it declare one, and what the channels that matter must hold. `expect` is asserted on the
 * source and on every copy, so a copy that matched a source holding nothing would still fail.
 */
const SHIPPED: readonly {
  name: string;
  type: string;
  params: Record<string, unknown>;
  expect: Record<string, { lookup_id: string | null; counter_bits: number | null }>;
}[] = [
  {
    name: 'Traffic',
    type: 'snmp.traffic',
    params: { ifIndex: 1 },
    expect: {
      in: { lookup_id: null, counter_bits: 64 },
      out: { lookup_id: null, counter_bits: 64 },
      total: { lookup_id: null, counter_bits: 64 },
      status: { lookup_id: STATUS, counter_bits: null },
    },
  },
  {
    name: 'Traffic at 32 bits',
    type: 'snmp.traffic',
    params: { ifIndex: 2, counterWidth: '32' },
    expect: {
      in: { lookup_id: null, counter_bits: 32 },
      status: { lookup_id: STATUS, counter_bits: null },
    },
  },
  {
    name: 'Uptime ticks',
    type: 'snmp.custom',
    params: { oid: '1.3.6.1.2.1.1.3.0', mode: 'counter' },
    expect: { value: { lookup_id: null, counter_bits: 64 } },
  },
  {
    name: 'Status string',
    type: 'snmp.custom.string',
    params: { oid: '1.3.6.1.2.1.1.1.0', lookup: STATUS },
    expect: { value: { lookup_id: STATUS, counter_bits: null } },
  },
  {
    name: 'Interface table',
    type: 'snmp.table',
    params: {
      tableOid: IF_TABLE,
      columns: [
        { column: '10', name: 'Octets in', mode: 'counter' },
        { column: '8', name: 'Status', lookup: STATUS },
      ],
    },
    expect: {
      col10: { lookup_id: null, counter_bits: 64 },
      col8: { lookup_id: STATUS, counter_bits: null },
    },
  },
];

/** Every column a clone copies; the ones a test reads by name are typed. */
type ChannelRow = Record<string, unknown> & {
  key: string;
  lookup_id: string | null;
  counter_bits: number | null;
  limits_source: string;
  scale_mul: string;
  show_in_graph: boolean;
};

/** A sensor's channels, every column a clone copies, by key. */
async function channelsOf(db: Database, sensorId: number): Promise<ChannelRow[]> {
  return db.query<ChannelRow>(
    `SELECT ${CLONED_CHANNEL_COLUMNS.join(', ')} FROM channel WHERE sensor_id = $1 ORDER BY key`,
    [sensorId],
  );
}

function assertDeclared(rows: readonly ChannelRow[], expect: (typeof SHIPPED)[number]['expect']) {
  for (const [key, shape] of Object.entries(expect)) {
    const row = rows.find((one) => one.key === key);
    assert.ok(row !== undefined, `channel ${key} exists`);
    assert.deepEqual({ lookup_id: row.lookup_id, counter_bits: row.counter_bits }, shape, key);
  }
}

describe('a clone’s channels (P-302)', { skip }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let h: Harness;
  let deviceId: number;
  const sources = new Map<string, number>();
  let cleared: number;

  before(async () => {
    scratch = await createScratchDatabase('cloned_channels');
    db = scratch.db;
    h = await buildHarness(db, { catalogue });
    const probe = await h.service.create(testActor, {
      kind: 'probe',
      parentId: h.rootId,
      name: 'Probe',
    });
    const device = await h.service.create(testActor, {
      kind: 'device',
      parentId: probe.id,
      name: 'core-switch',
      host: '192.0.2.40',
    });
    deviceId = device.id;
    for (const one of SHIPPED) {
      const sensor = await h.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: one.name,
        sensorType: one.type,
        params: one.params,
      });
      sources.set(one.name, sensor.id);
    }
    const traffic = sources.get('Traffic') ?? assert.fail('no traffic sensor');
    // An operator's decisions, which a declaration could not give back: a threshold, so
    // `limits_source` is `operator`; scaling and a spike filter; a series kept off the graph.
    await h.service.patchChannel(testActor, traffic, 'in', {
      limits: { enabled: true, upperWarning: 1_000_000 },
      processing: { scaleMul: '8', decimals: 1, spikeMax: 1e12 },
    });
    await db.query(
      `UPDATE channel SET show_in_graph = false WHERE sensor_id = $1 AND key = 'out'`,
      [traffic],
    );
    // A counter baseline, which belongs to the channel id and is not copied.
    await db.query(
      `INSERT INTO channel_counter (channel_id, last_value, last_at)
       SELECT id, 123456789, now() FROM channel WHERE sensor_id = $1 AND key = 'in'`,
      [traffic],
    );
    // A lookup an operator cleared (`M-06`): the copy keeps it cleared.
    const another = await h.service.create(testActor, {
      kind: 'sensor',
      parentId: deviceId,
      name: 'Traffic, status unjudged',
      sensorType: 'snmp.traffic',
      params: { ifIndex: 3 },
    });
    cleared = another.id;
    await h.service.patchChannel(testActor, cleared, 'status', { lookupId: null });
  });

  after(async () => {
    await scratch.drop();
  });

  it('copies every column but the four it owns, from one list held against the table', async () => {
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'channel'
        ORDER BY column_name`,
    );
    // A column added to `channel` fails this until somebody says whether a clone copies it.
    assert.deepEqual(
      columns.map((one) => one.column_name),
      [...CLONED_CHANNEL_COLUMNS, ...CHANNEL_COLUMNS_A_CLONE_OWNS].sort(),
    );
  });

  it('keeps the lookup, counter width and threshold owner of each shipped type, cloning a device', async () => {
    const result = await h.service.clone(testActor, deviceId, {}, Visibility.EVERYTHING);
    const copies = await db.query<{ id: string; name: string }>(
      `SELECT id::text AS id, name FROM object WHERE parent_id = $1`,
      [result.object.id],
    );
    for (const one of SHIPPED) {
      const source = sources.get(one.name) ?? assert.fail(one.name);
      const copy = copies.find((row) => row.name === one.name) ?? assert.fail(`${one.name} copy`);
      const before = await channelsOf(db, source);
      const after = await channelsOf(db, Number(copy.id));
      assertDeclared(before, one.expect);
      assertDeclared(after, one.expect);
      assert.deepEqual(after, before, one.name);
    }

    const traffic = copies.find((row) => row.name === 'Traffic') ?? assert.fail('traffic copy');
    const rows = await channelsOf(db, Number(traffic.id));
    const inbound = rows.find((row) => row.key === 'in') ?? assert.fail('no in');
    const outbound = rows.find((row) => row.key === 'out') ?? assert.fail('no out');
    assert.equal(inbound.limits_source, 'operator', 'not left for a declared default to replace');
    assert.equal(inbound.scale_mul, '8');
    assert.equal(outbound.show_in_graph, false);
    const baselines = async (sensorId: number): Promise<string | undefined> =>
      (
        await db.query<{ count: string }>(
          `SELECT count(*) AS count FROM channel_counter cc JOIN channel c ON c.id = cc.channel_id
            WHERE c.sensor_id = $1`,
          [sensorId],
        )
      )[0]?.count;
    assert.equal(await baselines(sources.get('Traffic') ?? 0), '1', 'the source has one');
    assert.equal(
      await baselines(Number(traffic.id)),
      '0',
      'the copy starts its counters at `first`',
    );

    const unjudged = copies.find((row) => row.name === 'Traffic, status unjudged');
    const status = (await channelsOf(db, Number(unjudged?.id))).find((row) => row.key === 'status');
    assert.ok(status !== undefined);
    assert.equal(status.lookup_id, null, 'a cleared lookup stays cleared');
  });

  it('keeps them cloning a sensor on its own', async () => {
    for (const one of SHIPPED) {
      const source = sources.get(one.name) ?? assert.fail(one.name);
      const result = await h.service.clone(testActor, source, {}, Visibility.EVERYTHING);
      const after = await channelsOf(db, result.object.id);
      assertDeclared(after, one.expect);
      assert.deepEqual(after, await channelsOf(db, source), one.name);
    }
  });
});

/**
 * A type that cannot answer for some stored parameters, as `P-297`'s `brittle` is. The repair
 * leaves its sensors alone rather than writing `{}`'s answer into them.
 */
const brittle: SensorType = {
  id: 'test.brittle',
  category: 'Custom',
  costHint: 'light',
  paramsSchema: { type: 'object', properties: { broken: { type: 'boolean' } } },
  channels: (params) => {
    if (params['broken'] === true) throw new TypeError('cannot read these parameters');
    return [{ key: 'value', name: 'Value', isPrimary: true, counter: { bits: 64 } }];
  },
  execute: () => Promise.resolve({ channels: [] }),
};

/** A logger whose lines a test can read. */
function capturing(): { logger: Logger; lines: () => Record<string, unknown>[] } {
  const written: string[] = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => void written.push(line) });
  return {
    logger,
    lines: () => written.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/**
 * The row the clone's INSERT wrote before `P-302`. It copied every other column, so a clone made
 * now with these three put back to what that statement left them is that row exactly.
 */
async function asTheOldCloneWroteIt(db: Database, sensorId: number): Promise<void> {
  await db.query(
    `UPDATE channel SET lookup_id = NULL, counter_bits = NULL, limits_source = 'unset'
      WHERE sensor_id = $1`,
    [sensorId],
  );
}

/** A probe, a device and the shipped sensors on it, for the two suites below. */
async function sourcesOn(h: Harness, host: string): Promise<{ deviceId: number }> {
  const probe = await h.service.create(testActor, {
    kind: 'probe',
    parentId: h.rootId,
    name: 'Probe',
  });
  const device = await h.service.create(testActor, {
    kind: 'device',
    parentId: probe.id,
    name: 'edge-router',
    host,
  });
  return { deviceId: device.id };
}

describe('migration 073 repairs a clone made before P-302', { skip }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let h: Harness;
  let deviceId: number;
  const sources = new Map<string, number>();
  const clones = new Map<string, number>();

  /** A sensor written by SQL, for a type the harness does not register. */
  const rawSensor = async (
    type: string,
    params: Record<string, unknown>,
    channels: readonly { key: string; limits?: string }[],
  ): Promise<number> => {
    const [row] = await db.query<{ id: string }>(
      `INSERT INTO object (parent_id, kind, name) VALUES ($1, 'sensor', $2) RETURNING id::text`,
      [deviceId, type],
    );
    const id = Number(row?.id ?? assert.fail('no sensor'));
    await db.query(`INSERT INTO sensor_config (object_id, type, params) VALUES ($1, $2, $3)`, [
      id,
      type,
      JSON.stringify(params),
    ]);
    for (const [at, channel] of channels.entries()) {
      await db.query(
        `INSERT INTO channel (sensor_id, key, name, is_primary, limits, limits_source)
         VALUES ($1, $2, $2, $3, $4::jsonb, 'unset')`,
        [id, channel.key, at === 0, channel.limits ?? '{}'],
      );
    }
    return id;
  };

  before(async () => {
    scratch = await createScratchDatabase('channel_shape_repair');
    db = scratch.db;
    h = await buildHarness(db, { catalogue });
    ({ deviceId } = await sourcesOn(h, '192.0.2.41'));
    for (const one of SHIPPED) {
      const sensor = await h.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: one.name,
        sensorType: one.type,
        params: one.params,
      });
      sources.set(one.name, sensor.id);
    }
    await h.service.patchChannel(testActor, sources.get('Traffic') ?? 0, 'in', {
      limits: { enabled: true, upperWarning: 1_000_000 },
    });
    // The case the lookup must not be filled for: a shut port whose status an operator cleared
    // on the source (`M-06`), which the old clone did not copy and nothing on the clone records.
    const shut = await h.service.create(testActor, {
      kind: 'sensor',
      parentId: deviceId,
      name: 'Shut port',
      sensorType: 'snmp.traffic',
      params: { ifIndex: 9 },
    });
    await h.service.patchChannel(testActor, shut.id, 'status', { lookupId: null });
    sources.set('Shut port', shut.id);
    for (const [name, source] of sources) {
      const copy = await h.service.clone(testActor, source, {}, Visibility.EVERYTHING);
      clones.set(name, copy.object.id);
      await asTheOldCloneWroteIt(db, copy.object.id);
    }
  });

  after(async () => {
    await scratch.drop();
  });

  it('writes the counter widths and the thresholds’ owners, no lookup, and names the channels judged by nothing', async () => {
    // Copied thresholds on a fixed type, one an older build's declaration and one not: both
    // `declared`, for the start-up pass to bring to this build's. On a type that cannot declare
    // limits, and on one this build does not register, `operator`.
    const fixed = catalogue
      .ids()
      .filter((id) => catalogue.declaration(id).fixedChannels === true)
      .flatMap((id) =>
        catalogue
          .channelsFor(id, {})
          .filter((def) => def.limits !== undefined)
          .map((def) => ({ type: id, key: def.key })),
      )[0];
    assert.ok(fixed !== undefined, 'a shipped fixed type declares a threshold');
    const health = await rawSensor(fixed.type, {}, [
      { key: fixed.key, limits: JSON.stringify({ enabled: true, upperError: 123_456 }) },
      { key: 'chosen', limits: JSON.stringify({ enabled: true, upperError: 5 }) },
      // Untouched: empty and `unset` is a channel nobody has decided about.
      { key: 'blank' },
    ]);
    const gone = await rawSensor('gone.type', {}, [
      { key: 'value', limits: JSON.stringify({ enabled: true, upperError: 7 }) },
    ]);
    const extended = new SensorCatalogue();
    for (const id of catalogue.ids()) extended.register(catalogue.type(id));
    extended.register(brittle);
    const unanswering = await rawSensor('test.brittle', { broken: true }, [{ key: 'value' }]);
    const answering = await rawSensor('test.brittle', {}, [{ key: 'value' }]);

    // One sensor id a window, so the walk crosses every boundary there is; one sensor named a
    // type, so the bound is seen.
    const log = capturing();
    const repaired = await repairChannelShapes(db, extended.seal(), {
      window: 1,
      listed: 1,
      logger: log.logger,
    });

    for (const one of SHIPPED) {
      const copy = clones.get(one.name) ?? assert.fail(one.name);
      const rows = await channelsOf(db, copy);
      for (const [key, shape] of Object.entries(one.expect)) {
        const row = rows.find((candidate) => candidate.key === key) ?? assert.fail(key);
        assert.equal(row.counter_bits, shape.counter_bits, `${one.name} ${key} width`);
        assert.equal(row.lookup_id, null, `${one.name} ${key}: no lookup written`);
      }
    }
    const shutRows = await channelsOf(db, clones.get('Shut port') ?? 0);
    assert.equal(shutRows.find((row) => row.key === 'status')?.lookup_id, null);
    assert.equal(shutRows.find((row) => row.key === 'in')?.counter_bits, 64);

    const rowOf = async (sensorId: number, key: string): Promise<ChannelRow | undefined> =>
      (await channelsOf(db, sensorId)).find((row) => row.key === key);
    const trafficIn = await rowOf(clones.get('Traffic') ?? 0, 'in');
    assert.equal(trafficIn?.limits_source, 'operator', 'a non-fixed type’s thresholds');
    assert.equal((await rowOf(health, fixed.key))?.limits_source, 'declared');
    assert.equal((await rowOf(health, 'chosen'))?.limits_source, 'declared');
    assert.equal((await rowOf(health, 'blank'))?.limits_source, 'unset');
    assert.equal((await rowOf(gone, 'value'))?.limits_source, 'operator');
    assert.equal((await rowOf(unanswering, 'value'))?.counter_bits, null);
    assert.equal((await rowOf(answering, 'value'))?.counter_bits, 64);

    // Widths: in, out and total on three traffic copies, the custom one, the table's column and
    // the brittle type's answer.
    assert.equal(repaired.counters, 12);
    assert.deepEqual(repaired.limitSources, { declared: 2, operator: 2 });
    assert.equal(repaired.unregistered, 1);
    assert.deepEqual(repaired.unanswerable, { 'test.brittle': 1 });
    assert.equal(repaired.byType['snmp.traffic'], 9);
    // The status of the three traffic copies and of the shut port's source, whose clear is a
    // decision; the string's value and the table's status column.
    const firstTraffic = Math.min(
      clones.get('Traffic') ?? 0,
      clones.get('Traffic at 32 bits') ?? 0,
      clones.get('Shut port') ?? 0,
      sources.get('Shut port') ?? 0,
    );
    assert.deepEqual(repaired.unjudged, {
      'snmp.traffic': { channels: 4, sensorIds: [firstTraffic] },
      'snmp.custom.string': { channels: 1, sensorIds: [clones.get('Status string')] },
      'snmp.table': { channels: 1, sensorIds: [clones.get('Interface table')] },
    });
    const warned = log.lines().filter((line) => line['level'] === 40);
    assert.equal(warned.length, 1, 'said once');
    assert.deepEqual(warned[0]?.['unjudged'], repaired.unjudged);
    assert.match(String(warned[0]['msg']), /PATCH \/api\/v1\/objects\/:id\/channels\/:key/u);

    const again = await repairChannelShapes(db, extended.seal(), { window: 1 });
    assert.equal(again.counters, 0);
    assert.deepEqual(again.limitSources, { declared: 0, operator: 0 });
    assert.equal(again.unjudged['snmp.traffic']?.channels, 4, 'still said, never written');
  });
});

const CONFIG: IngestionConfig = {
  queueMaxRows: 200_000,
  batchMaxRows: 5_000,
  batchMaxDelayMs: 5,
  slowDownAtPercent: 50,
  retryAfterMs: 1_000,
  replay: { maxConcurrentProbes: 4, stepMs: 250, maxDelayMs: 30_000, idleAfterMs: 30_000 },
};

/**
 * The upgrade over a clone of a switch whose shut ports had their status cleared (`P-302`
 * review, `M-17`): one scan before 073, 073, one scan after, the port still reporting down. The
 * clone stays Up and writes no state, where a channel with the lookup goes Down on the same
 * reading, so the test can tell.
 */
describe('migration 073 raises no state change on a cleared status (scenario)', { skip }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let h: Harness;
  let lookups: LookupCatalogue;

  before(async () => {
    lookups = await loadLookups({ logger: silentLogger });
    scratch = await createScratchDatabase('channel_shape_scenario');
    db = scratch.db;
    h = await buildHarness(db, { catalogue });
  });

  after(async () => {
    await scratch.drop();
  });

  it('keeps a shut port’s clone Up across the upgrade, while a judged port goes Down', async () => {
    const { deviceId } = await sourcesOn(h, '192.0.2.42');
    const traffic = (name: string, ifIndex: number) =>
      h.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name,
        sensorType: 'snmp.traffic',
        params: { ifIndex },
      });
    const shut = await traffic('Shut port', 7);
    await h.service.patchChannel(testActor, shut.id, 'status', { lookupId: null });
    const judged = await traffic('Judged port', 8);
    const copy = await h.service.clone(testActor, shut.id, {}, Visibility.EVERYTHING);
    await asTheOldCloneWroteIt(db, copy.object.id);
    // A clone arrives paused (`S-03`); this one had long been put to work.
    await h.service.resume(testActor, copy.object.id, Visibility.EVERYTHING);

    const build = () => {
      const states = new SensorStateService({
        db,
        logger: silentLogger,
        settings: h.resolver,
        pauses: new PauseRepository(),
      });
      const ingestor = new Ingestor({ db, logger: silentLogger, config: CONFIG });
      const service = new IngestionService({
        db,
        logger: silentLogger,
        ingestor,
        states,
        resolver: new ChannelResolver({ logger: silentLogger, lookups }),
      });
      return { service, ingestor };
    };
    const scan = async (minute: number, batchId: string): Promise<void> => {
      const { service, ingestor } = build();
      // Behind the core's clock, which refuses a reading from its future.
      const at = new Date(Date.now() - (10 - minute) * 60_000).toISOString();
      const result = (sensorId: number): CheckResult => ({
        sensorId,
        at,
        outcome: 'ok',
        message: '',
        durationMs: 5,
        channels: [{ key: 'status', value: 2 }],
      });
      const reply = await service.acceptResults('probe-073', {
        type: 'results',
        batchId,
        results: [result(copy.object.id), result(judged.id)],
      });
      await ingestor.stop();
      assert.equal(reply.type, 'results-ack', `batch ${batchId} taken`);
    };
    const states = async (sensorId: number): Promise<string[]> =>
      (
        await db.query<{ state: string }>(
          'SELECT state FROM sensor_state WHERE sensor_id = $1 ORDER BY time',
          [sensorId],
        )
      ).map((row) => row.state);
    const current = async (sensorId: number): Promise<string | undefined> =>
      (
        await db.query<{ state: string }>('SELECT state FROM sensor_runtime WHERE object_id = $1', [
          sensorId,
        ])
      )[0]?.state;

    await scan(0, 'before');
    assert.equal(await current(judged.id), 'down', 'the lookup turns ifOperStatus 2 Down');
    assert.equal(await current(copy.object.id), 'up');
    const before = await states(copy.object.id);

    // A fresh service after it, as a core starting after `migrate up` would have.
    await repairChannelShapes(db, catalogue);
    await scan(1, 'after');

    assert.equal(await current(copy.object.id), 'up', 'still judged by nothing');
    assert.deepEqual(await states(copy.object.id), before, 'no state written');
    assert.equal(
      (await channelsOf(db, copy.object.id)).find((row) => row.key === 'in')?.counter_bits,
      64,
      'the repair did run on it',
    );
  });
});

describe('migration 073 as the migrator runs it', { skip }, () => {
  it('repairs before it is recorded, says so on the column, and leaves the rows on the way back', async () => {
    const fresh = await createScratchDatabase('channel_shape_073');
    try {
      const q = fresh.db;
      const upTo = (id: number): Migrator =>
        new Migrator({
          db: q,
          logger: silentLogger,
          migrations: MIGRATIONS.filter((one) => one.id <= id),
        });
      await upTo(72).up();
      const [root] = await q.query<{ id: string }>(`SELECT id FROM object WHERE kind = 'root'`);
      const insert = async (kind: string, parent: string | undefined): Promise<string> => {
        const [row] = await q.query<{ id: string }>(
          'INSERT INTO object (parent_id, kind, name) VALUES ($1, $2, $3) RETURNING id::text',
          [parent, kind, kind],
        );
        return row?.id ?? assert.fail('no row');
      };
      const sensor = await insert(
        'sensor',
        await insert('device', await insert('probe', root?.id)),
      );
      await q.query(`INSERT INTO sensor_config (object_id, type, params) VALUES ($1, $2, $3)`, [
        sensor,
        'snmp.traffic',
        JSON.stringify({ ifIndex: 1, counterWidth: 'auto' }),
      ]);
      for (const key of ['in', 'status']) {
        await q.query(`INSERT INTO channel (sensor_id, key, name) VALUES ($1, $2, $2)`, [
          sensor,
          key,
        ]);
      }
      const read = async (): Promise<unknown[]> =>
        q.query(
          'SELECT key, lookup_id, counter_bits FROM channel WHERE sensor_id = $1 ORDER BY key',
          [sensor],
        );
      const comment = async (): Promise<string | null> =>
        (
          await q.query<{ comment: string | null }>(
            `SELECT col_description('channel'::regclass, attnum) AS comment
               FROM pg_attribute WHERE attrelid = 'channel'::regclass AND attname = 'counter_bits'`,
          )
        )[0]?.comment ?? null;
      const before = await comment();
      assert.match(before ?? '', /T-02/u);

      assert.deepEqual(
        (await upTo(73).up()).applied.map((one) => one.id),
        [73],
      );
      const repaired = await read();
      assert.deepEqual(repaired, [
        { key: 'in', lookup_id: null, counter_bits: 64 },
        { key: 'status', lookup_id: null, counter_bits: null },
      ]);
      assert.match((await comment()) ?? '', /migration 073/u);

      assert.deepEqual(
        (await upTo(73).down(1)).reverted.map((one) => one.id),
        [73],
      );
      assert.equal(await comment(), before, '023’s comment, as it was');
      assert.deepEqual(await read(), repaired);
    } finally {
      await fresh.drop();
    }
  });
});
