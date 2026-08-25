import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { Queryable } from '../../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from '../support/database.js';
import { buildHarness, testActor, type Harness } from '../support/tree.js';

const available = await databaseAvailable();

/**
 * A committed measurement, per CLAUDE.md: "performance claims need a measurement committed to
 * the repo, not an assertion".
 *
 * The claim being measured is that cloning is set-based — a fixed number of statements per
 * depth level, not per object. It is the difference between a 1,000-object clone taking about
 * a second and taking 1,000 round trips.
 */
describe(
  'clone performance',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let h: Harness;

    before(async () => {
      scratch = await createScratchDatabase('cloneperf');
      h = await buildHarness(scratch.db);
    });

    after(async () => {
      await scratch.drop();
    });

    it('issues a number of statements proportional to depth, not to object count', async () => {
      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'Perf probe',
      });

      // 1 group + 20 devices + 200 sensors = 221 objects at depth 3.
      const group = await h.service.create(testActor, {
        kind: 'group',
        parentId: probe.id,
        name: 'Big group',
      });
      for (let d = 0; d < 20; d += 1) {
        const device = await h.service.create(testActor, {
          kind: 'device',
          parentId: group.id,
          name: `device-${String(d)}`,
          host: `10.0.0.${String(d + 1)}`,
        });
        for (let s = 0; s < 10; s += 1) {
          await h.service.create(testActor, {
            kind: 'sensor',
            parentId: device.id,
            name: `sensor-${String(s)}`,
            sensorType: 'icmp.ping',
          });
        }
      }

      const target = await h.service.create(testActor, {
        kind: 'group',
        parentId: probe.id,
        name: 'Target',
      });

      // Count the statements the clone actually issues.
      let statements = 0;
      const counted = await h.service.batch('shared', async (q, repo) => {
        const spy: Queryable = {
          query: async (text, values) => {
            statements += 1;
            return q.query(text, values);
          },
        };
        const startedAt = process.hrtime.bigint();
        const result = await repo.copySubtree(
          spy,
          group.id,
          target.id,
          'Clone of Big group',
          5_000,
        );
        return { result, elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1e6 };
      });

      assert.equal(counted.result.counts.total, 221);

      // Depth is 3 (group, device, sensor), so 4 per-depth inserts plus a fixed set of bulk
      // statements. Anything proportional to 221 objects means the set-based path was lost.
      assert.ok(
        statements < 20,
        `expected O(depth) statements, got ${String(statements)} for 221 objects`,
      );

      process.stdout.write(
        `\n    measured: cloned ${String(counted.result.counts.total)} objects in ` +
          `${counted.elapsedMs.toFixed(1)} ms using ${String(statements)} statements\n`,
      );
    });
  },
);
