import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { probeHealth, SensorCatalogue, type ChannelDef, type SensorType } from '@ms/sensors';
import type { Database } from '../src/db/pool.js';
import { ChannelResolver } from '../src/ingestion/channels.js';
import { applyDeclaredLimits, declaredLimitsLookup } from '../src/state/declared-limits.js';
import {
  limitsFromDeclaration,
  NO_LIMITS,
  parseLimits,
  type ChannelLimits,
} from '../src/state/limits.js';
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

/** `test.watched` at a later build, declaring `channels` instead (`P-291`). */
const watchedLater = (channels: readonly ChannelDef[]): SensorType => ({
  ...watched,
  channels: () => channels,
});

const LAG: ChannelDef = { key: 'lag', name: 'Lag', unit: 'ms', isPrimary: true };
const PLAIN: ChannelDef = { key: 'plain', name: 'Plain', unit: '' };

/** What `lag` holds when the type's first declaration put it there. */
const LAG_DECLARED: ChannelLimits = {
  ...NO_LIMITS,
  upperWarning: 1_000,
  upperError: 5_000,
  errorMessage: 'far too late',
};

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

      it('reaches a channel ingestion creates, not only one created with its sensor', async () => {
        // Found live: `S-17` added channels to `ms.core.health`, whose sensors already existed,
        // so the first reading created them through the ingestion path — where nothing knew what
        // the type declared. They sat unset until the *next* restart, which is a default that
        // arrives a restart late for every channel added to an existing type.
        const resolver = new ChannelResolver({
          logger: silent,
          declaredLimits: declaredLimitsLookup(catalogueOf(watched)),
        });
        await db.tx((q) =>
          resolver.resolve(q, [
            {
              sensorId,
              at: new Date().toISOString(),
              outcome: 'ok',
              message: '',
              durationMs: 1,
              channels: [{ key: 'late', value: 1 }],
            },
          ]),
        );

        // `late` is not declared, so it is `unset` — and the one that *is* declared proves the
        // lookup reached this path at all.
        assert.equal((await channel('late')).source, 'unset');

        await db.query('DELETE FROM channel WHERE sensor_id = $1 AND key = $2', [sensorId, 'lag']);
        await db.tx((q) =>
          resolver.resolve(q, [
            {
              sensorId,
              at: new Date().toISOString(),
              outcome: 'ok',
              message: '',
              durationMs: 1,
              channels: [{ key: 'lag', value: 1 }],
            },
          ]),
        );
        const lag = await channel('lag');
        assert.equal(lag.source, 'declared');
        assert.equal(parseLimits(lag.limits).upperError, 5_000);
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
        assert.deepEqual(report, { applied: 0, cleared: 0, operatorOwned: 0, unmatched: [] });
      });
    });

    describe('a declaration taken away (P-291)', () => {
      interface Withdrawal {
        readonly name: string;
        /** The build the core restarts into. */
        readonly catalogue: () => SensorCatalogue;
        /** Who owns `lag` before the restart: as created, or after a person set a bound. */
        readonly owner: 'declared' | 'operator';
        readonly cleared: number;
        readonly applied: number;
        readonly lag: { readonly source: string; readonly limits: ChannelLimits };
        readonly plain?: { readonly source: string; readonly limits: ChannelLimits };
      }

      const cases: readonly Withdrawal[] = [
        {
          // The `P-284` shape, and the early return's: a type left declaring nothing at all.
          name: 'the type declares no limit anywhere any more',
          catalogue: () => catalogueOf(watchedLater([LAG, PLAIN])),
          owner: 'declared',
          cleared: 1,
          applied: 0,
          lag: { source: 'unset', limits: NO_LIMITS },
        },
        {
          // The type still declares limits, for another channel: per key, not per type.
          name: 'the type moved its declaration to another channel',
          catalogue: () =>
            catalogueOf(watchedLater([LAG, { ...PLAIN, limits: { upperError: 3 } }])),
          owner: 'declared',
          cleared: 1,
          applied: 1,
          lag: { source: 'unset', limits: NO_LIMITS },
          plain: { source: 'declared', limits: { ...NO_LIMITS, upperError: 3 } },
        },
        {
          // A channel the type no longer has at all still has its row and its readings.
          name: 'the type no longer has the channel',
          catalogue: () => catalogueOf(watchedLater([{ ...PLAIN, isPrimary: true }])),
          owner: 'declared',
          cleared: 1,
          applied: 0,
          lag: { source: 'unset', limits: NO_LIMITS },
        },
        {
          // Some bounds kept and one dropped: the rewrite of the whole declaration takes the
          // dropped one with it, and the channel stays the type's.
          name: 'the type still declares the channel, with one bound fewer',
          catalogue: () =>
            catalogueOf(
              watchedLater([
                { ...LAG, limits: { upperError: 5_000, errorMessage: 'far too late' } },
                PLAIN,
              ]),
            ),
          owner: 'declared',
          cleared: 0,
          applied: 1,
          lag: { source: 'declared', limits: { ...LAG_DECLARED, upperWarning: null } },
        },
        {
          name: 'the declaration has not moved',
          catalogue: () => catalogueOf(watched),
          owner: 'declared',
          cleared: 0,
          applied: 0,
          lag: { source: 'declared', limits: LAG_DECLARED },
        },
        {
          // **The rule the pass exists under.** A person's limit outlives the declaration it
          // started from, including the bounds they did not touch.
          name: 'an operator owns the channel',
          catalogue: () => catalogueOf(watchedLater([LAG, PLAIN])),
          owner: 'operator',
          cleared: 0,
          applied: 0,
          lag: { source: 'operator', limits: { ...LAG_DECLARED, upperError: 8_000 } },
        },
        {
          // A build that does not register the type says nothing about what it declares.
          name: 'the type is not registered',
          catalogue: () => catalogueOf({ ...watched, id: 'test.other', channels: () => [PLAIN] }),
          owner: 'declared',
          cleared: 0,
          applied: 0,
          lag: { source: 'declared', limits: LAG_DECLARED },
        },
        {
          // Its channels vary per sensor, so a parameterless read cannot speak for this one.
          name: 'the type needs parameters to name its channels',
          catalogue: () =>
            catalogueOf({
              ...watched,
              channels: (params) => {
                if (params['shape'] === undefined) throw new Error('needs a shape');
                return [LAG, PLAIN];
              },
            }),
          owner: 'declared',
          cleared: 0,
          applied: 0,
          lag: { source: 'declared', limits: LAG_DECLARED },
        },
      ];

      for (const one of cases) {
        it(`when ${one.name}`, async () => {
          if (one.owner === 'operator') {
            await h.service.patchChannel(testActor, sensorId, 'lag', {
              limits: { upperError: 8_000 },
            });
          }
          assert.equal((await channel('lag')).source, one.owner, 'the row starts as the case says');

          const report = await applyDeclaredLimits({
            db,
            logger: silent,
            catalogue: one.catalogue(),
          });

          assert.equal(report.cleared, one.cleared, 'cleared');
          assert.equal(report.applied, one.applied, 'applied');
          const lag = await channel('lag');
          assert.equal(lag.source, one.lag.source);
          assert.deepEqual(parseLimits(lag.limits), one.lag.limits);
          if (one.lag.source === 'unset') {
            // The value a channel created by this build holds, not a row of nulls that only
            // parses the same: an `unset` row is meant to be indistinguishable from a new one.
            assert.deepEqual(lag.limits, {});
          }
          if (one.plain !== undefined) {
            const plain = await channel('plain');
            assert.equal(plain.source, one.plain.source);
            assert.deepEqual(parseLimits(plain.limits), one.plain.limits);
          }

          // And a second start finds nothing: a cleared row is `unset`, so writing it again would
          // only bump the sensor's version and break every open ETag (`S-13`).
          const again = await applyDeclaredLimits({
            db,
            logger: silent,
            catalogue: one.catalogue(),
          });
          assert.equal(again.cleared, 0, 'nothing left to clear');
          assert.equal(again.applied, 0, 'nothing left to apply');
        });
      }

      it('gives a cleared channel back to a later build that declares it again', async () => {
        await applyDeclaredLimits({
          db,
          logger: silent,
          catalogue: catalogueOf(watchedLater([LAG, PLAIN])),
        });
        assert.equal((await channel('lag')).source, 'unset');

        const report = await applyDeclaredLimits({
          db,
          logger: silent,
          catalogue: catalogueOf(watched),
        });
        assert.equal(report.applied, 1);
        const lag = await channel('lag');
        assert.equal(lag.source, 'declared');
        assert.deepEqual(parseLimits(lag.limits), LAG_DECLARED);
      });

      it('takes protocol 31’s rate warning off Probe Health’s script-groups total', async () => {
        // The case that found the ticket. `P-270` declared `upperWarning: 0.000_01` on the
        // running total; `P-284` moved the warning to the five-minute count and declared nothing
        // on the total — so an install that ran the earlier build kept a threshold nothing
        // declares and the documentation says is gone.
        const probe = await h.service.create(testActor, {
          kind: 'probe',
          parentId: h.rootId,
          name: 'Upgraded probe',
        });
        const device = await h.service.create(testActor, {
          kind: 'device',
          parentId: probe.id,
          name: 'Upgraded probe device',
          host: '192.0.2.41',
        });
        const health = await h.service.create(testActor, {
          kind: 'sensor',
          parentId: device.id,
          name: 'Probe Health',
          sensorType: 'ms.probe.health',
        });
        const read = async (key: string): Promise<{ limits: unknown; source: string }> => {
          const rows = await db.query<{ limits: unknown; limits_source: string }>(
            'SELECT limits, limits_source FROM channel WHERE sensor_id = $1 AND key = $2',
            [health.id, key],
          );
          const row = rows[0];
          assert.ok(row !== undefined, `no channel ${key}`);
          return { limits: row.limits, source: row.limits_source };
        };

        // What protocol 31's build left on the row.
        await db.query(
          `UPDATE channel SET limits = $3::jsonb, limits_source = 'declared'
           WHERE sensor_id = $1 AND key = $2`,
          [
            health.id,
            'scriptGroupsRefused',
            JSON.stringify(limitsFromDeclaration({ upperWarning: 0.000_01 })),
          ],
        );
        const recently = await read('scriptGroupsRefusedRecently');
        assert.equal(recently.source, 'declared', 'the channel that carries the warning now');

        const report = await applyDeclaredLimits({
          db,
          logger: silent,
          catalogue: catalogueOf(probeHealth),
        });

        assert.equal(report.cleared, 1, 'the total, and nothing else on Probe Health');
        const total = await read('scriptGroupsRefused');
        assert.equal(total.source, 'unset');
        assert.deepEqual(total.limits, {});
        assert.deepEqual(await read('scriptGroupsRefusedRecently'), recently, 'kept as it was');
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
