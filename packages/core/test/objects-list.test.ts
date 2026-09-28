import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { Database } from '../src/db/pool.js';
import type { ObjectId, ObjectRef, ObjectSummary } from '../src/objects/types.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/**
 * The list filters. Every one of them was shipped untested in the first cut of S-03, including
 * the LIKE escaping and the tag case-folding the code documents as deliberate — behaviour that
 * is documented but unexercised is a comment, not a guarantee.
 */
describe(
  'object listing filters',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let h: Harness;
    let probeId: ObjectId;
    let berlin: ObjectId;
    let munich: ObjectId;

    before(async () => {
      scratch = await createScratchDatabase('objlist');
      h = await buildHarness(scratch.db);

      probeId = (
        await h.service.create(testActor, {
          kind: 'probe',
          parentId: h.rootId,
          name: 'Local probe',
        })
      ).id;

      berlin = (
        await h.service.create(testActor, {
          kind: 'group',
          parentId: probeId,
          // Deliberately mixed case: tags are stored as written and matched folded.
          name: 'Berlin DC',
          tags: ['Berlin', 'Production'],
        })
      ).id;
      munich = (
        await h.service.create(testActor, {
          kind: 'group',
          parentId: probeId,
          name: 'Munich DC',
          tags: ['munich'],
        })
      ).id;

      // **Tags on different levels of one chain** (`P-102`). Every other fixture here puts the
      // tags being ANDed on the *same* object, which is the one arrangement the old filter could
      // match — so nothing noticed that a filter spread across a chain returned nothing at all.
      const paris = (
        await h.service.create(testActor, {
          kind: 'group',
          parentId: probeId,
          name: 'Paris DC',
          tags: ['paris'],
        })
      ).id;
      const parisSwitch = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: paris,
          name: 'switch-07',
          host: '10.3.0.1',
          tags: ['production'],
        })
      ).id;
      await h.service.create(testActor, {
        kind: 'sensor',
        parentId: parisSwitch,
        name: 'Paris ping',
        sensorType: 'icmp.ping',
      });

      const berlinSwitch = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: berlin,
          name: 'switch_01',
          host: '10.1.0.1',
          priority: 5,
        })
      ).id;
      await h.service.create(testActor, {
        kind: 'sensor',
        parentId: berlinSwitch,
        name: 'Ping',
        sensorType: 'icmp.ping',
      });
      await h.service.create(testActor, {
        kind: 'device',
        parentId: munich,
        name: 'switchX01',
        host: '10.2.0.1',
        priority: 1,
      });
    });

    after(async () => {
      await scratch.drop();
    });

    const list = async (filter: Parameters<Harness['service']['list']>[0]) =>
      (await h.service.list(filter, { limit: 100, sort: 'name', cursor: null })).items;

    it('matches tags case-insensitively', async () => {
      const upper = await list({ tags: ['BERLIN'] });
      const lower = await list({ tags: ['berlin'] });
      assert.ok(upper.length > 0);
      assert.deepEqual(
        upper.map((i) => i.id).sort(),
        lower.map((i) => i.id).sort(),
        'the stored casing must not decide whether a filter matches',
      );
    });

    it('includes objects that inherit the tag from an ancestor', async () => {
      // CAPABILITIES.MD §1: tags are inherited. Tagging a group is how an operator says
      // "everything in Berlin", so the group's devices and their sensors must come back.
      const tagged = await list({ tags: ['berlin'] });
      const names = tagged.map((i) => i.name).sort();

      assert.deepEqual(names, ['Berlin DC', 'Ping', 'switch_01']);
      assert.ok(
        !names.includes('switchX01'),
        'and nothing outside the tagged subtree comes with it',
      );
    });

    it('requires every tag when several are given', async () => {
      assert.equal((await list({ tags: ['berlin', 'production'] })).length, 3);
      assert.equal((await list({ tags: ['berlin', 'munich'] })).length, 0);
    });

    it('matches tags spread across the inheritance chain, not only ones on the same object', async () => {
      // **`P-102`.** The walk's base case demanded every tag at once — one object had to carry
      // all of them before the descent started — so an AND-filter whose tags sit at different
      // levels matched nothing. `Berlin DC` carries both of its tags itself, which is why the
      // case above stayed green.
      //
      // The effective-tag rule everything else uses is the union of an object's own tags with
      // its ancestors': `MessageContextLoader` computes exactly that for `%tags`, so a
      // notification about the Paris sensor interpolates "paris, production" while a search for
      // those two tags could not find the sensor it is about. `repository.ts` says a filter that
      // quietly under-reports is worse than one that errors, which is what this was.
      const both = await list({ tags: ['paris', 'production'] });
      assert.deepEqual(
        both.map((item) => item.name).sort(),
        ['Paris ping', 'switch-07'],
        'the device carries production itself and paris from its group; the sensor both',
      );

      // The group is not in it: it carries `paris` and not `production`, and inheritance goes
      // down. A filter that returned it would be over-reporting, which is the other failure.
      assert.ok(!both.some((item) => item.name === 'Paris DC'));
    });

    it('treats _ in a name search as a literal, not a wildcard', async () => {
      // Without escaping, "switch_01" would also match "switchX01".
      const underscore = await list({ q: 'switch_01' });
      assert.deepEqual(
        underscore.map((i) => i.name),
        ['switch_01'],
      );
    });

    it('treats % in a name search as a literal too', async () => {
      assert.equal((await list({ q: '%' })).length, 0, 'a bare % must not match everything');
    });

    it('searches names case-insensitively, as a substring', async () => {
      assert.deepEqual(
        (await list({ q: 'berlin' })).map((i) => i.name),
        ['Berlin DC'],
      );
    });

    it('searches device hosts as a substring, not only names', async () => {
      // `P-212`. The tree's search box says "Search names and hosts" and sends `q` alone, which
      // matched names alone — an operator typing an address found nothing unless the device was
      // named after it. No fixture name contains "10.1.0", so only the host can find this.
      assert.deepEqual(
        (await list({ q: '10.1.0' })).map((i) => i.name),
        ['switch_01'],
      );

      // A fragment every host shares finds every device, and none of the sensors beneath them:
      // a sensor has no host of its own, and its device is the match.
      assert.deepEqual((await list({ q: '0.1' })).map((i) => i.name).sort(), [
        'switch-07',
        'switchX01',
        'switch_01',
      ]);
    });

    it('still ANDs a host search with the other filters', async () => {
      // The OR inside `q` is parenthesised. Without that, `kind = … AND name ILIKE … OR host
      // ILIKE …` binds as `(kind AND name) OR host`, and the host arm escapes every filter.
      assert.equal((await list({ q: '10.1.0', kinds: ['group'] })).length, 0);
      assert.equal((await list({ q: '10.1.0', tags: ['munich'] })).length, 0);
      assert.deepEqual(
        (await list({ q: '10.1.0', tags: ['berlin'] })).map((i) => i.name),
        ['switch_01'],
      );
    });

    it('keeps host as an exact filter, which a fragment does not satisfy', async () => {
      assert.equal((await list({ host: '10.1.0' })).length, 0);
    });

    it('filters by kind', async () => {
      const devices = await list({ kinds: ['device'] });
      assert.deepEqual(devices.map((i) => i.name).sort(), ['switch-07', 'switchX01', 'switch_01']);
      assert.equal((await list({ kinds: ['device', 'sensor'] })).length, 5);
    });

    it('filters devices by host, case-folded', async () => {
      assert.deepEqual(
        (await list({ host: '10.1.0.1' })).map((i) => i.name),
        ['switch_01'],
      );
      assert.equal((await list({ host: '10.9.9.9' })).length, 0);
    });

    it('filters by minimum priority', async () => {
      const important = await list({ priorityMin: 5 });
      assert.deepEqual(
        important.map((i) => i.name),
        ['switch_01'],
      );
    });

    it('combines filters conjunctively', async () => {
      assert.deepEqual(
        (await list({ kinds: ['device'], tags: ['berlin'] })).map((i) => i.name),
        ['switch_01'],
      );
      assert.equal((await list({ kinds: ['sensor'], tags: ['munich'] })).length, 0);
    });

    it('reports hasChildren without counting', async () => {
      const groups = await list({ kinds: ['group'] });
      const berlinRow = groups.find((g) => g.id === berlin);
      const munichRow = groups.find((g) => g.id === munich);
      assert.equal(berlinRow?.hasChildren, true);
      assert.equal(munichRow?.hasChildren, true);

      const sensors = await list({ kinds: ['sensor'] });
      assert.equal(sensors[0]?.hasChildren, false);
    });

    it('carries kind-specific summary fields only for the kinds that have them', async () => {
      const rows = await list({});
      const device = rows.find((r) => r.name === 'switch_01');
      const sensor = rows.find((r) => r.name === 'Ping');
      const group = rows.find((r) => r.id === berlin);

      assert.ok(device !== undefined && sensor !== undefined && group !== undefined);
      assert.equal(device.host, '10.1.0.1');
      assert.equal(device.sensorType, undefined);
      assert.equal(sensor.sensorType, 'icmp.ping');
      assert.equal(sensor.host, undefined);
      assert.equal(group.host, undefined);
    });
  },
);

/**
 * Counts the statements a service issues through its own pool (`P-214`).
 *
 * A proxy rather than a spy on the repository: the promise is about round trips to PostgreSQL,
 * and a spy would still pass if the one repository call looped over its ids inside.
 */
function countingDatabase(db: Database): { db: Database; statements: () => number } {
  let statements = 0;
  const proxy = new Proxy(db, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (property !== 'query') return method.bind(target);
      return (...args: unknown[]) => {
        statements += 1;
        return method.apply(target, args);
      };
    },
  });
  return { db: proxy, statements: () => statements };
}

/**
 * `include=path` (`P-214`): a flat search result that says where each match is.
 *
 * The tree's search box shows matches flat, and `web-ui.md` promised each came "with the path
 * written out" while every row carried only a parent id — so two sensors called `Ping` on two
 * devices were the same line twice. The fixture is exactly that, three times, at two depths.
 */
describe(
  'object listing paths',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let h: Harness;
    /** Where each `Ping` is, root left off, keyed by the sensor's id. */
    const expected = new Map<ObjectId, string[]>();

    before(async () => {
      scratch = await createScratchDatabase('objpath');
      h = await buildHarness(scratch.db);

      const create = async (
        input: Parameters<Harness['service']['create']>[1],
      ): Promise<ObjectId> => (await h.service.create(testActor, input)).id;

      const probe = await create({ kind: 'probe', parentId: h.rootId, name: 'Local probe' });
      const berlin = await create({ kind: 'group', parentId: probe, name: 'Berlin DC' });
      const munich = await create({ kind: 'group', parentId: probe, name: 'Munich DC' });
      const rack = await create({ kind: 'group', parentId: munich, name: 'Rack 4' });

      const ping = async (parentId: ObjectId, device: string, where: string[]): Promise<void> => {
        const d = await create({ kind: 'device', parentId, name: device, host: '10.0.0.1' });
        const s = await create({
          kind: 'sensor',
          parentId: d,
          name: 'Ping',
          sensorType: 'icmp.ping',
        });
        expected.set(s, [...where, device]);
      };
      await ping(berlin, 'switch-01', ['Local probe', 'Berlin DC']);
      await ping(munich, 'switch-02', ['Local probe', 'Munich DC']);
      await ping(rack, 'switch-03', ['Local probe', 'Munich DC', 'Rack 4']);
      // Enough rows that a walk per row would show in the statement count below.
      for (let i = 10; i < 40; i += 1) {
        await ping(rack, `edge-${String(i)}`, ['Local probe', 'Munich DC', 'Rack 4']);
      }
    });

    after(async () => {
      await scratch.drop();
    });

    const page = { limit: 500, sort: 'name', cursor: null } as const;
    const names = (path: readonly ObjectRef[] | undefined): string[] | undefined =>
      path?.filter((ancestor) => ancestor.kind !== 'root').map((ancestor) => ancestor.name);

    it('tells objects with the same name apart by where they are', async () => {
      const { items } = await h.service.list({ q: 'Ping', kinds: ['sensor'] }, page, {
        path: true,
      });

      assert.equal(items.length, expected.size);
      for (const item of items) {
        assert.deepEqual(names(item.path), expected.get(item.id), `the path of ${String(item.id)}`);
      }
    });

    it('gives every row the chain its breadcrumb gives it', async () => {
      // One implementation of "where is this" in the UI's eyes, even though there are two walks:
      // a search row and the page it links to must not disagree about the way there.
      const { items } = await h.service.list({}, page, { path: true });
      assert.ok(
        items.some((item) => item.kind === 'root'),
        'the root is in the listing too',
      );

      for (const item of items) {
        assert.deepEqual(
          item.path,
          await h.service.ancestors(item.id),
          `${item.kind} ${item.name} (${String(item.id)})`,
        );
      }
    });

    it('leaves the path off a listing that did not ask for it', async () => {
      // Opt-in, because it is a second statement: the tree's own levels already know where they
      // are, and a page of five hundred children should not pay for a walk nobody reads.
      const { items } = await h.service.list({}, page);
      assert.ok(items.length > 0);
      assert.ok(items.every((item: ObjectSummary) => !('path' in item)));
    });

    it('walks the whole page in one statement, however many rows it has', async () => {
      const counting = countingDatabase(scratch.db);
      const counted = await buildHarness(counting.db);

      const statementsFor = async (limit: number, path: boolean): Promise<number> => {
        const before = counting.statements();
        const { items } = await counted.service.list(
          { q: 'Ping', kinds: ['sensor'] },
          { limit, sort: 'name', cursor: null },
          { path },
        );
        assert.equal(items.length, Math.min(limit, expected.size));
        return counting.statements() - before;
      };

      const plain = await statementsFor(1, false);
      const one = await statementsFor(1, true);
      const many = await statementsFor(100, true);

      assert.equal(one - plain, 1, 'the paths cost one statement over the listing');
      assert.equal(many, one, `and ${String(expected.size)} rows cost what one row does`);
    });

    it('gives an id with no object no path, rather than an empty one', async () => {
      // An empty path is the root's — "directly under nothing". An object deleted between the
      // listing and the walk is not that, so its row goes out without a path at all.
      const paths = await h.repository.paths(scratch.db, [h.rootId, Number.MAX_SAFE_INTEGER]);
      assert.deepEqual(paths.get(h.rootId), []);
      assert.equal(paths.has(Number.MAX_SAFE_INTEGER), false);
      assert.equal((await h.repository.paths(scratch.db, [])).size, 0);
    });
  },
);
