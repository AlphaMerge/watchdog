import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { CheckResult } from '@ms/shared';
import { ChannelResolver } from '../src/ingestion/channels.js';
import { declaredChannelLookup, declaredLimitsLookup } from '../src/state/declared-limits.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor } from './support/tree.js';
import { testCatalogue } from './support/sensor-types.js';

const available = await databaseAvailable();

/**
 * What a channel gets when **ingestion** creates it rather than sensor creation (`P-80`).
 *
 * `ChannelResolver.resolve` is the only path by which a key a sensor type newly declares reaches
 * the `channel` table on a sensor that already exists — every upgrade, in other words. Its INSERT
 * wrote `limits` and nothing else, so a channel born this way had `lookup_id = NULL` and
 * `counter_bits = NULL`, and neither was noticed because both readers fail *quietly*:
 * `evaluateChannel` falls through every branch and judges the channel by nothing at all, and the
 * counter-to-rate conversion is gated on `counterBits !== null` and simply stores the raw total.
 *
 * The consequence was that `delivering` (`P-74`), `checksCompleting` (`P-76`) and `poolState`
 * (`P-62`) — the headline alarm of each of those tickets, all lookup channels with no limits —
 * could not fire at all on any installation that predated them. On a fresh install the same
 * outage produced Down with the right message; on an upgraded one the sensor stayed Up.
 */
describe(
  'a channel that ingestion creates',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let sensorId: number;

    before(async () => {
      scratch = await createScratchDatabase('provisioning');
      db = scratch.db;
      const harness = await buildHarness(db);
      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'Probe',
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'router',
        host: '192.0.2.30',
      });
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name: 'eth0',
        sensorType: 'snmp.traffic',
        params: {},
      });
      sensorId = sensor.id;

      // **Simulating an installation that predates these channels**, which is the only state in
      // which this path runs. Creation already writes them correctly — that is why the defect
      // was invisible to every test in the suite, all of which create their sensors on this build.
      await db.query('DELETE FROM channel WHERE sensor_id = $1', [sensorId]);
    });

    after(async () => {
      await scratch.drop();
    });

    it('carries the lookup and counter width its type declares, not just its limits', async () => {
      const catalogue = testCatalogue();
      const resolver = new ChannelResolver({
        logger: silent,
        declaredLimits: declaredLimitsLookup(catalogue),
        declaredShape: declaredChannelLookup(catalogue),
      });

      const result: CheckResult = {
        sensorId,
        at: new Date('2026-09-04T10:00:00.000Z').toISOString(),
        outcome: 'ok',
        message: '',
        durationMs: 1,
        channels: [
          { key: 'in', value: 1_000, counter: '1000', counterBits: 64 },
          { key: 'status', value: 1 },
        ],
      };
      await db.tx((q) => resolver.resolve(q, [result]));

      const rows = await db.query<{
        key: string;
        lookup_id: string | null;
        counter_bits: number | null;
      }>('SELECT key, lookup_id, counter_bits FROM channel WHERE sensor_id = $1 ORDER BY key', [
        sensorId,
      ]);
      const byKey = new Map(rows.map((row) => [row.key, row]));

      // The lookup channel. Null here is what left `ms.probe.delivery`, `ms.probe.checks` and
      // `ms.probe.pool` judged by nothing on every upgraded installation.
      assert.equal(byKey.get('status')?.lookup_id, 'ms.snmp.if-oper-status');
      // And the counter width. Null here stores a cumulative total where a rate was declared, so
      // a limit written for a rate — `spoolUnwritten`'s `upperError: 0.00001`, for instance —
      // latches Down for the life of the probe process and cannot be cleared.
      assert.equal(byKey.get('in')?.counter_bits, 64);
    });
  },
);
