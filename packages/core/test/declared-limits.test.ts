import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { SensorCatalogue, type SensorType } from '@ms/sensors';
import type { Database } from '../src/db/pool.js';
import { applyDeclaredLimits } from '../src/state/declared-limits.js';
import { limitsFromDeclaration, NO_LIMITS, parseLimits } from '../src/state/limits.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/**
 * Thresholds a sensor type declares, and who is allowed to overwrite them (`S-18`).
 *
 * **The whole ticket is one distinction**: `{}` in `channel.limits` used to mean both "nobody has
 * configured this" and "somebody deliberately cleared it", and a default cannot be applied safely
 * without telling those apart. `limits_source` is that distinction, and most of what follows is
 * about the second case — because the first is easy and the second is the one that would quietly
 * undo an operator's decision on every restart.
 */

/** A type with one channel that declares thresholds and one that does not. */
const watched: SensorType = {
  id: 'test.watched',
  category: 'System',
  costHint: 'light',
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
  channels: () => [
    {
      key: 'lag',
      name: 'Lag',
      unit: 'ms',
      isPrimary: true,
      limits: { upperWarning: 1_000, upperError: 5_000, errorMessage: 'far too late' },
    },
    { key: 'plain', name: 'Plain', unit: '' },
  ],
  execute: () => Promise.resolve({ channels: [] }),
};

/** The same type, later, with the numbers revised — which is how a default changes. */
const revised: SensorType = {
  ...watched,
  channels: () => [
    {
      key: 'lag',
      name: 'Lag',
      unit: 'ms',
      isPrimary: true,
      limits: { upperWarning: 250, upperError: 750, errorMessage: 'far too late' },
    },
    { key: 'plain', name: 'Plain', unit: '' },
  ],
};

const catalogueOf = (type: SensorType): SensorCatalogue =>
  new SensorCatalogue().register(type).seal();

describe(
  'declared channel limits',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let sensorId: number;

    before(async () => {
      scratch = await createScratchDatabase('declaredlimits');
      db = scratch.db;
      // Builds the schema as well as the service, so nothing may read a table before this.
      h = await buildHarness(db, { types: [watched] });
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM channel');
      await db.query("DELETE FROM object WHERE kind <> 'root'");
      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'Limits probe',
      });
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'Limits device',
        host: '192.0.2.40',
      });
      const sensor = await h.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name: 'Limits sensor',
        sensorType: 'test.watched',
      });
      sensorId = sensor.id;
    });

    const channel = async (key: string): Promise<{ limits: unknown; source: string }> => {
      const rows = await db.query<{ limits: unknown; limits_source: string }>(
        'SELECT limits, limits_source FROM channel WHERE sensor_id = $1 AND key = $2',
        [sensorId, key],
      );
      const row = rows[0];
      assert.ok(row !== undefined, `no channel ${key}`);
      return { limits: row.limits, source: row.limits_source };
    };

    describe('when a sensor is created', () => {
      it('writes the thresholds its type declares, and says where they came from', async () => {
        const lag = await channel('lag');
        assert.equal(lag.source, 'declared');
        assert.deepEqual(parseLimits(lag.limits), {
          ...NO_LIMITS,
          upperWarning: 1_000,
          upperError: 5_000,
          errorMessage: 'far too late',
        });
      });

      it('leaves a channel with no declaration unset rather than empty-but-decided', async () => {
        // The difference matters later: `unset` is what makes a channel eligible for a default
        // its type has not declared yet, and marking it otherwise would freeze it out for ever.
        const plain = await channel('plain');
        assert.equal(plain.source, 'unset');
        assert.deepEqual(parseLimits(plain.limits), NO_LIMITS);
      });
    });

    describe('when an operator has an opinion', () => {
      it('takes ownership the moment a limit is set by hand', async () => {
        // 8,000 rather than 42, and the difference is itself a check: the declared warning at
        // 1,000 is really in the row, so a patch below it is refused as contradictory.
        await h.service.patchChannel(testActor, sensorId, 'lag', {
          limits: { upperError: 8_000 },
        });
        const lag = await channel('lag');
        assert.equal(lag.source, 'operator');
        assert.equal(parseLimits(lag.limits).upperError, 8_000);
        assert.equal(parseLimits(lag.limits).upperWarning, 1_000, 'a patch, so the rest stands');
      });

      it('does not put a default back over a threshold that was cleared', async () => {
        // **The reason this ticket needed a column.** Clearing every bound writes `{}`, which is
        // exactly what an untouched channel holds — so a backfill reading the value would
        // reinstate on the next start what somebody had just removed, and do it silently.
        await h.service.patchChannel(testActor, sensorId, 'lag', {
          limits: { upperWarning: null, upperError: null },
        });
        // The bounds, not the whole value: `patchChannel` is a patch, so the message the
        // declaration came with survives the bounds being cleared. That is right — the message
        // is what an alarm says, and clearing a threshold is not asking to lose it.
        const cleared = parseLimits((await channel('lag')).limits);
        assert.equal(cleared.upperWarning, null);
        assert.equal(cleared.upperError, null);

        const report = await applyDeclaredLimits({
          db,
          logger: silent,
          catalogue: catalogueOf(watched),
        });

        assert.equal(report.applied, 0);
        assert.equal(report.operatorOwned, 1);
        const after = parseLimits((await channel('lag')).limits);
        assert.equal(after.upperWarning, null, 'still cleared');
        assert.equal(after.upperError, null, 'still cleared');
      });

      it('does not overwrite a threshold an operator changed, even to a newer default', async () => {
        await h.service.patchChannel(testActor, sensorId, 'lag', { limits: { upperError: 9_999 } });
        await applyDeclaredLimits({ db, logger: silent, catalogue: catalogueOf(revised) });
        assert.equal(parseLimits((await channel('lag')).limits).upperError, 9_999);
      });
    });

    describe('the start-up pass', () => {
      it('fills a channel that predates the declaration', async () => {
        // The upgrade case, and the reason the pass exists at all: without it the same build
        // would alarm on a fresh install and stay silent on the one that has been running for a
        // year, with nothing on screen to say why.
        await db.query(
          `UPDATE channel SET limits = '{}'::jsonb, limits_source = 'unset' WHERE sensor_id = $1`,
          [sensorId],
        );

        const report = await applyDeclaredLimits({
          db,
          logger: silent,
          catalogue: catalogueOf(watched),
        });

        assert.equal(report.applied, 1, 'the declared channel, and not the other one');
        const lag = await channel('lag');
        assert.equal(lag.source, 'declared');
        assert.equal(parseLimits(lag.limits).upperError, 5_000);
        assert.equal((await channel('plain')).source, 'unset');
      });

      it('moves a default when the declaration changes', async () => {
        const report = await applyDeclaredLimits({
          db,
          logger: silent,
          catalogue: catalogueOf(revised),
        });
        assert.equal(report.applied, 1);
        assert.equal(parseLimits((await channel('lag')).limits).upperError, 750);
      });

      it('writes nothing when the declaration has not moved', async () => {
        // Not an optimisation. Writing a channel bumps its sensor's version and invalidates every
        // open ETag (`S-13`), so a pass that touched every health channel on every start would
        // make a restart look like a configuration change to every client watching.
        const report = await applyDeclaredLimits({
          db,
          logger: silent,
          catalogue: catalogueOf(watched),
        });
        assert.equal(report.applied, 0);
      });

      it('is safe to run twice', async () => {
        const options = { db, logger: silent, catalogue: catalogueOf(revised) };
        assert.equal((await applyDeclaredLimits(options)).applied, 1);
        assert.equal((await applyDeclaredLimits(options)).applied, 0);
      });

      it('reports a declaration this installation has no channel for', async () => {
        // Not an error — an installation with no probes has no Probe Health sensor — but the
        // other cause is a channel key renamed on one side only, which is invisible otherwise.
        const orphan: SensorType = {
          ...watched,
          id: 'test.absent',
          channels: () => [{ key: 'nothing', name: 'Nothing', limits: { upperError: 1 } }],
        };
        const report = await applyDeclaredLimits({
          db,
          logger: silent,
          catalogue: new SensorCatalogue().register(orphan).seal(),
        });
        assert.deepEqual(report.unmatched, ['test.absent.nothing']);
      });

      it('does nothing at all when no registered type declares any limit', async () => {
        const bare: SensorType = {
          ...watched,
          id: 'test.bare',
          channels: () => [{ key: 'x', name: 'X' }],
        };
        const report = await applyDeclaredLimits({
          db,
          logger: silent,
          catalogue: new SensorCatalogue().register(bare).seal(),
        });
        assert.deepEqual(report, { applied: 0, operatorOwned: 0, unmatched: [] });
      });
    });

    describe('the shipped declarations', () => {
      it('turns into the stored shape without losing a message', () => {
        // `limitsFromDeclaration` is the one place a declaration becomes a row, and the messages
        // are the half that would be easy to drop — they are what an alarm actually says.
        assert.deepEqual(
          limitsFromDeclaration({ upperWarning: 1, upperError: 2, errorMessage: 'go and look' }),
          {
            ...NO_LIMITS,
            upperWarning: 1,
            upperError: 2,
            errorMessage: 'go and look',
          },
        );
      });
    });
  },
);
