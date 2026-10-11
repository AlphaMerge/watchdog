import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Visibility } from '../src/auth/access.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/**
 * The channels without the lookup their type declares, listed for an operator and never filled
 * (`P-308`, decided by the user 2026-10-11). Through the routes, `object-visibility.test.ts`'s
 * sweep calls it as a branch account like every other `GET`.
 */
describe(
  'the channels without their declared lookup (P-308)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let seenDevice: number;
    let unseenDevice: number;

    before(async () => {
      scratch = await createScratchDatabase('without_lookup');
      db = scratch.db;
      h = await buildHarness(db);
      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'Probe',
      });
      for (const name of ['seen', 'unseen']) {
        const device = await h.service.create(testActor, {
          kind: 'device',
          parentId: probe.id,
          name,
          host: '192.0.2.60',
        });
        if (name === 'seen') seenDevice = device.id;
        else unseenDevice = device.id;
      }
    });

    after(async () => {
      await scratch.drop();
    });

    const traffic = async (parentId: number, name: string): Promise<number> =>
      (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId,
          name,
          sensorType: 'snmp.traffic',
          params: { port: 3 },
        })
      ).id;

    /** As a clone made before `P-302` left it, or as an operator who cleared it leaves it. */
    const withoutLookup = (sensorId: number, key: string): Promise<unknown> =>
      db.query('UPDATE channel SET lookup_id = NULL WHERE sensor_id = $1 AND key = $2', [
        sensorId,
        key,
      ]);

    const lookupOf = async (sensorId: number, key: string): Promise<string | null> =>
      (
        await db.query<{ lookup_id: string | null }>(
          'SELECT lookup_id FROM channel WHERE sensor_id = $1 AND key = $2',
          [sensorId, key],
        )
      )[0]?.lookup_id ?? null;

    it('names each channel whose type declares a lookup it lacks, and fills none', async () => {
      const whole = await traffic(seenDevice, 'uplink');
      const lost = await traffic(seenDevice, 'uplink clone');
      await withoutLookup(lost, 'status');
      assert.equal(await lookupOf(whole, 'status'), 'ms.snmp.if-oper-status', 'the fixture');

      const listed = await h.service.channelsWithoutLookup(Visibility.EVERYTHING);
      assert.deepEqual(listed, {
        items: [
          {
            sensorId: lost,
            sensorName: 'uplink clone',
            sensorType: 'snmp.traffic',
            key: 'status',
            channelName: 'Interface status',
            declaredLookup: 'ms.snmp.if-oper-status',
          },
        ],
        total: 1,
        unanswered: 0,
      });
      // `in` and `out` have no lookup and their type declares none: not listed. And the list
      // writes nothing: the channel is as it was.
      assert.equal(await lookupOf(lost, 'status'), null, 'listed, not filled');
    });

    it('names only the sensors the caller can see', async () => {
      const hidden = await traffic(unseenDevice, 'hidden clone');
      await withoutLookup(hidden, 'status');
      const all = await h.service.channelsWithoutLookup(Visibility.EVERYTHING);
      assert.ok(all.items.some((one) => one.sensorId === hidden));

      const branch = Visibility.of(new Map([[seenDevice, true]]), false, null);
      const listed = await h.service.channelsWithoutLookup(branch);
      assert.ok(listed.items.length > 0, 'its own are listed');
      assert.ok(
        listed.items.every((one) => one.sensorId !== hidden),
        'not the one outside its view',
      );
      assert.equal(listed.total, all.total - 1, 'nor counted');
      assert.deepEqual(await h.service.channelsWithoutLookup(Visibility.nothing(null)), {
        items: [],
        total: 0,
        unanswered: 0,
      });
    });

    it('counts, and does not judge, a sensor whose type cannot say what it declares', async () => {
      const gone = await traffic(seenDevice, 'of a type this build lacks');
      await withoutLookup(gone, 'status');
      await db.query(
        `UPDATE sensor_config SET type = 'test.not-in-this-build' WHERE object_id = $1`,
        [gone],
      );
      const listed = await h.service.channelsWithoutLookup(Visibility.EVERYTHING);
      assert.equal(listed.unanswered, 1);
      assert.ok(listed.items.every((one) => one.sensorId !== gone));
    });

    it('names at most the limit, in sensor order, and counts the rest', async () => {
      const all = await h.service.channelsWithoutLookup(Visibility.EVERYTHING);
      assert.ok(all.total >= 2);
      const ids = all.items.map((one) => one.sensorId);
      assert.deepEqual(
        ids,
        [...ids].sort((a, b) => a - b),
        'by sensor id',
      );
      const first = await h.service.channelsWithoutLookup(Visibility.EVERYTHING, 1);
      assert.deepEqual(first.items, all.items.slice(0, 1));
      assert.equal(first.total, all.total, 'the total is every one, not the page');
    });
  },
);
