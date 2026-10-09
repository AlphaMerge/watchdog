import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Migrator } from '../src/db/migrator.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { InheritanceError, InheritanceResolver } from '../src/settings/inheritance.js';
import {
  SettingError,
  SettingRegistry,
  settingRegistry,
  type SettingDefinition,
} from '../src/settings/registry.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';

const available = await databaseAvailable();

const INTERVAL = 'scan.intervalSeconds';
const TIMEOUT = 'scan.timeoutMs';
const RETRIES = 'scan.retryWarnings';

describe('the setting registry', () => {
  it('refuses a pattern with no sentence, and a sentence with no pattern, at load (P-377)', () => {
    // As the sensor catalogue (`U-53`) and the method registry (`P-372`) refuse one: a value a
    // pattern refuses is told its sentence, so a pattern without one would answer with the
    // expression.
    const withSchema = (schema: Record<string, unknown>): SettingRegistry =>
      new SettingRegistry([
        {
          key: 'test.patterned',
          schema,
          default: '',
          description: '',
        } satisfies SettingDefinition<string>,
      ]);
    const refused = (schema: Record<string, unknown>, said: RegExp): void => {
      assert.throws(
        () => withSchema(schema),
        (error: unknown) => {
          assert.ok(error instanceof SettingError);
          assert.match(error.message, said);
          return true;
        },
      );
    };
    refused(
      { type: 'string', pattern: '^[a-z]+$' },
      /setting test\.patterned gives its value a pattern without x-patternMessage/,
    );
    refused(
      { type: 'object', properties: { site: { type: 'string', pattern: '^[a-z]+$' } } },
      /setting test\.patterned gives "site" a pattern without x-patternMessage/,
    );
    refused(
      { type: 'string', 'x-patternMessage': 'must be a word' },
      /setting test\.patterned gives its value x-patternMessage without a pattern/,
    );
    // And one that says it is taken, and says it, without the value.
    const said = withSchema({
      type: 'string',
      pattern: '^[a-z]+$',
      'x-patternMessage': 'must be a word',
    });
    assert.throws(
      () => {
        said.validate('test.patterned', 'CANARY-1');
      },
      (error: unknown) => {
        assert.ok(error instanceof SettingError);
        assert.equal(error.message, 'invalid value for test.patterned: value must be a word');
        return true;
      },
    );
    // The shipped settings pass the same check, or this module would not have loaded.
    assert.deepEqual(new SettingRegistry(settingRegistry.definitions()).keys, settingRegistry.keys);
  });
});

describe(
  'InheritanceResolver',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let resolver: InheritanceResolver;

    /** root → probe → group → subgroup → device → sensor */
    const tree: Record<string, number> = {};

    before(async () => {
      scratch = await createScratchDatabase('inheritance');
      await new Migrator({
        db: scratch.db,
        logger: silentLogger,
        migrations: MIGRATIONS,
      }).up();
      resolver = new InheritanceResolver({ db: scratch.db, logger: silentLogger });

      const rootRows = await scratch.db.query<{ id: string }>(
        "SELECT id FROM object WHERE kind = 'root'",
      );
      tree['root'] = Number(rootRows[0]?.id);

      const insert = async (kind: string, name: string, parent: number): Promise<number> => {
        const rows = await scratch.db.query<{ id: string }>(
          'INSERT INTO object (parent_id, kind, name) VALUES ($1, $2, $3) RETURNING id',
          [parent, kind, name],
        );
        return Number(rows[0]?.id);
      };

      tree['probe'] = await insert('probe', 'Local probe', tree['root']);
      tree['group'] = await insert('group', 'Datacentre', tree['probe']);
      tree['subgroup'] = await insert('group', 'Rack 4', tree['group']);
      tree['device'] = await insert('device', 'switch-01', tree['subgroup']);
      tree['sensor'] = await insert('sensor', 'Ping', tree['device']);
      await scratch.db.query('INSERT INTO sensor_config (object_id, type) VALUES ($1, $2)', [
        tree['sensor'],
        'icmp.ping',
      ]);
    });

    after(async () => {
      await scratch.drop();
    });

    const clearAll = async (): Promise<void> => {
      await scratch.db.query('DELETE FROM object_setting');
    };

    it('falls back to the registry default when nothing in the tree defines it', async () => {
      await clearAll();
      const resolved = await resolver.resolve<number>(tree['sensor'] ?? 0, INTERVAL);

      assert.equal(resolved.value, 60);
      assert.deepEqual(resolved.source, { kind: 'default' });
    });

    // Table-driven: the same sensor, resolved against every position a value could be defined.
    const cases: { name: string; definedAt: string; expectedDepth: number }[] = [
      { name: 'the root', definedAt: 'root', expectedDepth: 5 },
      { name: 'the probe', definedAt: 'probe', expectedDepth: 4 },
      { name: 'a group', definedAt: 'group', expectedDepth: 3 },
      { name: 'a nested group', definedAt: 'subgroup', expectedDepth: 2 },
      { name: 'the device', definedAt: 'device', expectedDepth: 1 },
      { name: 'the sensor itself', definedAt: 'sensor', expectedDepth: 0 },
    ];

    for (const testCase of cases) {
      it(`inherits a value defined at ${testCase.name}`, async () => {
        await clearAll();
        const objectId = tree[testCase.definedAt] ?? 0;
        await resolver.set(objectId, INTERVAL, 300);

        const resolved = await resolver.resolve<number>(tree['sensor'] ?? 0, INTERVAL);

        assert.equal(resolved.value, 300);
        if (testCase.expectedDepth === 0) {
          assert.deepEqual(resolved.source, { kind: 'own', objectId });
        } else {
          assert.deepEqual(resolved.source, {
            kind: 'inherited',
            objectId,
            depth: testCase.expectedDepth,
          });
        }
      });
    }

    it('takes the nearest ancestor when several define the same setting', async () => {
      await clearAll();
      await resolver.set(tree['root'] ?? 0, INTERVAL, 60);
      await resolver.set(tree['probe'] ?? 0, INTERVAL, 120);
      await resolver.set(tree['group'] ?? 0, INTERVAL, 300);
      await resolver.set(tree['device'] ?? 0, INTERVAL, 600);

      const atSensor = await resolver.resolve<number>(tree['sensor'] ?? 0, INTERVAL);
      assert.equal(atSensor.value, 600, 'the device is nearest');

      // And each level resolves to its own nearest ancestor, not to the leaf's answer.
      assert.equal((await resolver.resolve<number>(tree['subgroup'] ?? 0, INTERVAL)).value, 300);
      assert.equal((await resolver.resolve<number>(tree['probe'] ?? 0, INTERVAL)).value, 120);
      assert.equal((await resolver.resolve<number>(tree['root'] ?? 0, INTERVAL)).value, 60);
    });

    it('lets a child override its ancestors', async () => {
      await clearAll();
      await resolver.set(tree['group'] ?? 0, INTERVAL, 300);
      await resolver.set(tree['sensor'] ?? 0, INTERVAL, 30);

      const resolved = await resolver.resolve<number>(tree['sensor'] ?? 0, INTERVAL);
      assert.equal(resolved.value, 30);
      assert.equal(resolved.source.kind, 'own');
    });

    it('discards the local value when reverted to inherit', async () => {
      await clearAll();
      await resolver.set(tree['group'] ?? 0, INTERVAL, 300);
      await resolver.set(tree['sensor'] ?? 0, INTERVAL, 30);
      assert.equal((await resolver.resolve<number>(tree['sensor'] ?? 0, INTERVAL)).value, 30);

      const removed = await resolver.clear(tree['sensor'] ?? 0, INTERVAL);

      assert.equal(removed, true);
      const reverted = await resolver.resolve<number>(tree['sensor'] ?? 0, INTERVAL);
      assert.equal(reverted.value, 300, 'the inherited value applies again');
      assert.equal(reverted.source.kind, 'inherited');

      // Discarded, not remembered: nothing local survives to reappear later.
      assert.deepEqual(await resolver.own(tree['sensor'] ?? 0), {});
    });

    it('reports clearing a setting that was not overridden', async () => {
      await clearAll();
      assert.equal(await resolver.clear(tree['sensor'] ?? 0, INTERVAL), false);
    });

    it('overwrites rather than duplicating when set twice', async () => {
      await clearAll();
      await resolver.set(tree['device'] ?? 0, INTERVAL, 120);
      await resolver.set(tree['device'] ?? 0, INTERVAL, 240);

      assert.equal((await resolver.resolve<number>(tree['device'] ?? 0, INTERVAL)).value, 240);
      assert.deepEqual(await resolver.own(tree['device'] ?? 0), { [INTERVAL]: 240 });
    });

    it('resolves settings independently of one another', async () => {
      await clearAll();
      await resolver.set(tree['probe'] ?? 0, INTERVAL, 120);
      await resolver.set(tree['device'] ?? 0, TIMEOUT, 5_000);

      const resolved = await resolver.resolveKeys(tree['sensor'] ?? 0, [
        INTERVAL,
        TIMEOUT,
        RETRIES,
      ]);

      const interval = resolved[INTERVAL];
      const timeout = resolved[TIMEOUT];
      const retries = resolved[RETRIES];
      assert.ok(interval !== undefined && timeout !== undefined && retries !== undefined);

      assert.equal(interval.value, 120);
      assert.equal(interval.source.kind, 'inherited');
      assert.equal(timeout.value, 5_000);
      assert.equal(retries.value, 1, 'untouched settings still fall back to default');
      assert.equal(retries.source.kind, 'default');
    });

    it('resolveAll covers every registered setting', async () => {
      await clearAll();
      const resolved = await resolver.resolveAll(tree['sensor'] ?? 0);
      assert.deepEqual(Object.keys(resolved).sort(), [...settingRegistry.keys].sort());
    });

    it('resolves many objects in one query, each against its own chain', async () => {
      await clearAll();
      await resolver.set(tree['root'] ?? 0, INTERVAL, 60);
      await resolver.set(tree['group'] ?? 0, INTERVAL, 300);
      await resolver.set(tree['sensor'] ?? 0, INTERVAL, 10);

      const ids = [
        tree['probe'] ?? 0,
        tree['subgroup'] ?? 0,
        tree['device'] ?? 0,
        tree['sensor'] ?? 0,
      ];
      const resolved = await resolver.resolveForObjects<number>(ids, INTERVAL);

      assert.equal(resolved.get(tree['probe'] ?? 0)?.value, 60);
      assert.equal(resolved.get(tree['subgroup'] ?? 0)?.value, 300);
      assert.equal(resolved.get(tree['device'] ?? 0)?.value, 300);
      assert.equal(resolved.get(tree['sensor'] ?? 0)?.value, 10);
      assert.equal(resolved.get(tree['sensor'] ?? 0)?.source.kind, 'own');
    });

    it('resolveForObjects returns defaults for objects with no chain value', async () => {
      await clearAll();
      const ids = [tree['device'] ?? 0, tree['sensor'] ?? 0];
      const resolved = await resolver.resolveForObjects<number>(ids, TIMEOUT);

      for (const id of ids) {
        assert.equal(resolved.get(id)?.value, 30_000);
        assert.deepEqual(resolved.get(id)?.source, { kind: 'default' });
      }
    });

    it('handles an empty id list without querying', async () => {
      assert.equal((await resolver.resolveForObjects([], INTERVAL)).size, 0);
    });

    it('follows a move: the same sensor inherits from its new parent', async () => {
      await clearAll();
      const slowRows = await scratch.db.query<{ id: string }>(
        'INSERT INTO object (parent_id, kind, name) VALUES ($1, $2, $3) RETURNING id',
        [tree['probe'], 'group', 'Slow group'],
      );
      const slowGroup = Number(slowRows[0]?.id);

      await resolver.set(tree['group'] ?? 0, INTERVAL, 60);
      await resolver.set(slowGroup, INTERVAL, 3_600);
      assert.equal((await resolver.resolve<number>(tree['sensor'] ?? 0, INTERVAL)).value, 60);

      // Move the device — and everything under it — into the slow group.
      await scratch.db.query('UPDATE object SET parent_id = $1 WHERE id = $2', [
        slowGroup,
        tree['device'],
      ]);

      assert.equal(
        (await resolver.resolve<number>(tree['sensor'] ?? 0, INTERVAL)).value,
        3_600,
        'inheritance is resolved live, never denormalised onto children',
      );

      await scratch.db.query('UPDATE object SET parent_id = $1 WHERE id = $2', [
        tree['subgroup'],
        tree['device'],
      ]);
      await scratch.db.query('DELETE FROM object WHERE id = $1', [slowGroup]);
    });

    it('rejects an unknown setting key instead of storing it', async () => {
      await assert.rejects(
        () => resolver.set(tree['sensor'] ?? 0, 'scan.intervalSecond', 60),
        SettingError,
      );
      await assert.rejects(() => resolver.resolve(tree['sensor'] ?? 0, 'nope'), SettingError);
    });

    it('validates the value against the setting schema', async () => {
      await assert.rejects(() => resolver.set(tree['sensor'] ?? 0, INTERVAL, 0), SettingError);
      await assert.rejects(() => resolver.set(tree['sensor'] ?? 0, INTERVAL, 1.5), SettingError);
      await assert.rejects(() => resolver.set(tree['sensor'] ?? 0, INTERVAL, '60'), SettingError);
      await assert.rejects(
        () => resolver.set(tree['sensor'] ?? 0, INTERVAL, 100_000),
        SettingError,
      );
    });

    it('distinguishes a missing object from an object that defines nothing', async () => {
      await clearAll();
      await assert.rejects(() => resolver.resolve(999_999_999, INTERVAL), InheritanceError);

      // An object that exists but defines nothing resolves to the default, no error.
      const resolved = await resolver.resolve<number>(tree['sensor'] ?? 0, INTERVAL);
      assert.equal(resolved.source.kind, 'default');
    });

    it('drops a subtree’s settings when the object is deleted', async () => {
      await clearAll();
      const rows = await scratch.db.query<{ id: string }>(
        'INSERT INTO object (parent_id, kind, name) VALUES ($1, $2, $3) RETURNING id',
        [tree['probe'], 'group', 'Temporary'],
      );
      const temporary = Number(rows[0]?.id);
      await resolver.set(temporary, INTERVAL, 900);

      await scratch.db.query('DELETE FROM object WHERE id = $1', [temporary]);

      const remaining = await scratch.db.query<{ count: string }>(
        'SELECT count(*) AS count FROM object_setting WHERE object_id = $1',
        [temporary],
      );
      assert.equal(remaining[0]?.count, '0');
    });

    it('resolves correctly through a deep chain', async () => {
      await clearAll();
      // 60 nested groups. Deeper than any sane installation, which is the point: the recursive
      // walk must not degrade or truncate.
      let parent = tree['probe'] ?? 0;
      const chain: number[] = [];
      for (let i = 0; i < 60; i += 1) {
        const rows = await scratch.db.query<{ id: string }>(
          'INSERT INTO object (parent_id, kind, name) VALUES ($1, $2, $3) RETURNING id',
          [parent, 'group', `Level ${String(i)}`],
        );
        parent = Number(rows[0]?.id);
        chain.push(parent);
      }

      await resolver.set(tree['probe'] ?? 0, INTERVAL, 111);
      const deepest = chain.at(-1) ?? 0;

      const fromTop = await resolver.resolve<number>(deepest, INTERVAL);
      assert.equal(fromTop.value, 111);
      assert.equal(
        fromTop.source.kind === 'inherited' ? fromTop.source.depth : -1,
        60,
        'depth counts every hop',
      );

      // A value halfway down wins over the one at the top.
      const middle = chain[29] ?? 0;
      await resolver.set(middle, INTERVAL, 222);
      const fromMiddle = await resolver.resolve<number>(deepest, INTERVAL);
      assert.equal(fromMiddle.value, 222);
      assert.equal(fromMiddle.source.kind === 'inherited' ? fromMiddle.source.objectId : 0, middle);

      await scratch.db.query('DELETE FROM object WHERE id = $1', [chain[0]]);
    });

    it('resolves a wide tree in one query', async () => {
      await clearAll();
      await resolver.set(tree['group'] ?? 0, INTERVAL, 45);

      const deviceIds: number[] = [];
      for (let i = 0; i < 200; i += 1) {
        const rows = await scratch.db.query<{ id: string }>(
          'INSERT INTO object (parent_id, kind, name) VALUES ($1, $2, $3) RETURNING id',
          [tree['subgroup'], 'device', `wide-${String(i)}`],
        );
        deviceIds.push(Number(rows[0]?.id));
      }
      // A handful override locally; the rest inherit.
      for (const id of deviceIds.slice(0, 10)) await resolver.set(id, INTERVAL, 5);

      const resolved = await resolver.resolveForObjects<number>(deviceIds, INTERVAL);

      assert.equal(resolved.size, 200);
      for (const [index, id] of deviceIds.entries()) {
        const entry = resolved.get(id);
        assert.ok(entry !== undefined);
        if (index < 10) {
          assert.equal(entry.value, 5, `device ${String(index)} overrides`);
          assert.equal(entry.source.kind, 'own');
        } else {
          assert.equal(entry.value, 45, `device ${String(index)} inherits`);
          assert.equal(entry.source.kind, 'inherited');
        }
      }

      for (const id of deviceIds) {
        await scratch.db.query('DELETE FROM object WHERE id = $1', [id]);
      }
    });
  },
);
