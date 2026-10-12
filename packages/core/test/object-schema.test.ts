import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Migrator } from '../src/db/migrator.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';

const available = await databaseAvailable();

/**
 * The object tree's invariants are enforced in the database, not only in the application. A
 * malformed tree breaks inheritance, status rollup and access control at once, and the API is
 * not the only thing that will ever write to these tables.
 */
describe(
  'object model schema',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let rootId: number;

    before(async () => {
      scratch = await createScratchDatabase('objects');
      await new Migrator({
        db: scratch.db,
        logger: silentLogger,
        migrations: MIGRATIONS,
      }).up();

      const rows = await scratch.db.query<{ id: string }>(
        "SELECT id FROM object WHERE kind = 'root'",
      );
      rootId = Number(rows[0]?.id);
      assert.ok(Number.isInteger(rootId), 'the migration seeds exactly one root');
    });

    after(async () => {
      await scratch.drop();
    });

    const insert = async (kind: string, name: string, parentId: number | null): Promise<number> => {
      const rows = await scratch.db.query<{ id: string }>(
        'INSERT INTO object (parent_id, kind, name) VALUES ($1, $2, $3) RETURNING id',
        [parentId, kind, name],
      );
      return Number(rows[0]?.id);
    };

    it('accepts the legal shape of the tree', async () => {
      const probe = await insert('probe', 'Local probe', rootId);
      const group = await insert('group', 'Datacentre', probe);
      const nested = await insert('group', 'Rack 4', group);
      const device = await insert('device', 'switch-01', nested);
      const sensor = await insert('sensor', 'Ping', device);

      assert.ok(sensor > 0);

      // A device may also hang directly off a probe, with no group in between.
      const bare = await insert('device', 'router-01', probe);
      assert.ok(bare > 0);
    });

    it('refuses illegal parent/child combinations', async () => {
      const probe = await insert('probe', 'Probe for illegal tests', rootId);
      const device = await insert('device', 'device-x', probe);
      const sensor = await insert('sensor', 'Ping', device);

      // A sensor's parent is always a device.
      await assert.rejects(() => insert('sensor', 'Orphan', probe), /may not be a child/);
      // Devices do not nest.
      await assert.rejects(() => insert('device', 'Nested', device), /may not be a child/);
      // Nothing hangs off a sensor — a channel is not an object.
      await assert.rejects(() => insert('group', 'Under a sensor', sensor), /may not be a child/);
      // Probes attach to the root only.
      await assert.rejects(() => insert('probe', 'Nested probe', probe), /may not be a child/);
    });

    it('allows exactly one root', async () => {
      await assert.rejects(() => insert('root', 'Second root', null), /duplicate key|unique/i);
    });

    it('requires every non-root object to have a parent', async () => {
      // A BEFORE trigger fires ahead of the CHECK constraint, so this is the message an
      // operator actually sees. Both defences exist; only one of them speaks first.
      await assert.rejects(() => insert('group', 'Floating', null), /must have a parent/);
    });

    it('refuses to create a cycle', async () => {
      const probe = await insert('probe', 'Cycle probe', rootId);
      const outer = await insert('group', 'Outer', probe);
      const inner = await insert('group', 'Inner', outer);
      const deepest = await insert('group', 'Deepest', inner);

      // Moving an ancestor beneath its own descendant would strand the whole subtree: it is
      // unreachable from the root and ON DELETE CASCADE can never reach it either.
      await assert.rejects(
        () => scratch.db.query('UPDATE object SET parent_id = $1 WHERE id = $2', [deepest, outer]),
        /cycle/,
      );

      // An object cannot be its own parent.
      await assert.rejects(
        () => scratch.db.query('UPDATE object SET parent_id = $1 WHERE id = $1', [outer]),
        /cycle/,
      );

      // A legal move still works.
      await scratch.db.query('UPDATE object SET parent_id = $1 WHERE id = $2', [probe, deepest]);
    });

    it('deletes a subtree when its root is deleted', async () => {
      const probe = await insert('probe', 'Delete probe', rootId);
      const group = await insert('group', 'Doomed', probe);
      const device = await insert('device', 'doomed-device', group);
      const sensor = await insert('sensor', 'Doomed ping', device);

      await scratch.db.query('INSERT INTO sensor_config (object_id, type) VALUES ($1, $2)', [
        sensor,
        'icmp.ping',
      ]);
      await scratch.db.query(
        'INSERT INTO channel (sensor_id, key, name, is_primary) VALUES ($1, $2, $3, true)',
        [sensor, 'rtt', 'Response time'],
      );

      await scratch.db.query('DELETE FROM object WHERE id = $1', [group]);

      const remaining = await scratch.db.query<{ count: string }>(
        'SELECT count(*) AS count FROM object WHERE id = ANY($1)',
        [[group, device, sensor]],
      );
      assert.equal(remaining[0]?.count, '0');

      const orphanChannels = await scratch.db.query<{ count: string }>(
        'SELECT count(*) AS count FROM channel WHERE sensor_id = $1',
        [sensor],
      );
      assert.equal(orphanChannels[0]?.count, '0', 'channels go with their sensor');
    });

    it('keeps sensor_config attached only to sensors', async () => {
      const probe = await insert('probe', 'Config probe', rootId);
      const device = await insert('device', 'config-device', probe);

      await assert.rejects(
        () =>
          scratch.db.query('INSERT INTO sensor_config (object_id, type) VALUES ($1, $2)', [
            device,
            'icmp.ping',
          ]),
        /only describe an object of kind sensor/,
      );
    });

    it('keeps inheritable settings out of sensor_config entirely', async () => {
      const probe = await insert('probe', 'Inherit probe', rootId);
      const device = await insert('device', 'inherit-device', probe);
      const sensor = await insert('sensor', 'Ping', device);

      await scratch.db.query('INSERT INTO sensor_config (object_id, type) VALUES ($1, $2)', [
        sensor,
        'icmp.ping',
      ]);

      // Scan interval, timeout and retry policy are inheritable, so they live in
      // object_setting and are resolved against the ancestor chain (S-04). A column here would
      // be a second source of truth, and a default in that column would silently become an
      // explicit local value that breaks revert-to-inherit.
      const columns = await scratch.db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'sensor_config' ORDER BY column_name`,
      );
      // Who vouched for the sensor (`A-29`, 059) is a fact about this sensor's last write, not a
      // setting — nothing inherits it, and a child has no reason to. Nor when its parameters last
      // changed (`P-340`, 080), which is this row's own history.
      assert.deepEqual(
        columns.map((row) => row.column_name),
        [
          'created_at',
          'object_id',
          'params',
          'params_changed_at',
          'type',
          'updated_at',
          'vouched_by',
          'vouched_by_user',
        ],
      );

      // A freshly created sensor defines nothing of its own.
      const own = await scratch.db.query<{ count: string }>(
        'SELECT count(*) AS count FROM object_setting WHERE object_id = $1',
        [sensor],
      );
      assert.equal(own[0]?.count, '0');
    });

    it('allows at most one primary channel per sensor', async () => {
      const probe = await insert('probe', 'Channel probe', rootId);
      const device = await insert('device', 'channel-device', probe);
      const sensor = await insert('sensor', 'Traffic', device);
      await scratch.db.query('INSERT INTO sensor_config (object_id, type) VALUES ($1, $2)', [
        sensor,
        'snmp.traffic',
      ]);

      const addChannel = (key: string, primary: boolean) =>
        scratch.db.query(
          'INSERT INTO channel (sensor_id, key, name, is_primary) VALUES ($1, $2, $3, $4)',
          [sensor, key, key, primary],
        );

      await addChannel('in', false);
      await addChannel('out', false);
      await addChannel('sum', true);

      await assert.rejects(() => addChannel('total', true), /duplicate key|unique/i);
      // Non-primary channels are unlimited.
      await addChannel('errors', false);
    });

    it('keeps channel keys unique within a sensor but not across sensors', async () => {
      const probe = await insert('probe', 'Key probe', rootId);
      const device = await insert('device', 'key-device', probe);
      const a = await insert('sensor', 'Sensor A', device);
      const b = await insert('sensor', 'Sensor B', device);
      for (const id of [a, b]) {
        await scratch.db.query('INSERT INTO sensor_config (object_id, type) VALUES ($1, $2)', [
          id,
          'icmp.ping',
        ]);
      }

      await scratch.db.query('INSERT INTO channel (sensor_id, key, name) VALUES ($1, $2, $3)', [
        a,
        'rtt',
        'Response time',
      ]);
      // The same key on a different sensor is normal.
      await scratch.db.query('INSERT INTO channel (sensor_id, key, name) VALUES ($1, $2, $3)', [
        b,
        'rtt',
        'Response time',
      ]);

      await assert.rejects(
        () =>
          scratch.db.query('INSERT INTO channel (sensor_id, key, name) VALUES ($1, $2, $3)', [
            a,
            'rtt',
            'Duplicate',
          ]),
        /duplicate key|unique/i,
      );
    });

    it('rejects a spike filter whose bounds are inverted', async () => {
      const probe = await insert('probe', 'Spike probe', rootId);
      const device = await insert('device', 'spike-device', probe);
      const sensor = await insert('sensor', 'Spiky', device);
      await scratch.db.query('INSERT INTO sensor_config (object_id, type) VALUES ($1, $2)', [
        sensor,
        'icmp.ping',
      ]);

      await assert.rejects(
        () =>
          scratch.db.query(
            'INSERT INTO channel (sensor_id, key, name, spike_min, spike_max) VALUES ($1, $2, $3, $4, $5)',
            [sensor, 'rtt', 'Response time', 100, 10],
          ),
        /channel_spike_range/,
      );
    });

    it('allows one credential set per kind per object, and overrides on a child', async () => {
      const probe = await insert('probe', 'Credential probe', rootId);
      const device = await insert('device', 'credential-device', probe);

      const addCredential = (objectId: number, kind: string) =>
        scratch.db.query(
          'INSERT INTO credential_set (object_id, kind, secret, key_id) VALUES ($1, $2, $3, $4)',
          [objectId, kind, Buffer.from('ciphertext'), 'key-1'],
        );

      await addCredential(probe, 'snmp');
      await addCredential(probe, 'ssh');
      // The device overrides the probe's SNMP credentials by defining its own.
      await addCredential(device, 'snmp');

      await assert.rejects(() => addCredential(probe, 'snmp'), /duplicate key|unique/i);
    });

    it('maintains updated_at on write', async () => {
      const probe = await insert('probe', 'Timestamp probe', rootId);
      const before = await scratch.db.query<{ created_at: Date; updated_at: Date }>(
        'SELECT created_at, updated_at FROM object WHERE id = $1',
        [probe],
      );

      await scratch.db.query('UPDATE object SET name = $1 WHERE id = $2', ['Renamed', probe]);

      const after = await scratch.db.query<{ created_at: Date; updated_at: Date }>(
        'SELECT created_at, updated_at FROM object WHERE id = $1',
        [probe],
      );

      assert.ok(after[0] !== undefined && before[0] !== undefined);
      assert.equal(after[0].created_at.getTime(), before[0].created_at.getTime());
      assert.ok(after[0].updated_at.getTime() >= before[0].updated_at.getTime());
    });

    it('enforces the documented value ranges', async () => {
      const probe = await insert('probe', 'Range probe', rootId);

      await assert.rejects(
        () => scratch.db.query('UPDATE object SET priority = $1 WHERE id = $2', [6, probe]),
        /priority/,
      );
      await assert.rejects(
        () => scratch.db.query('UPDATE object SET name = $1 WHERE id = $2', ['', probe]),
        /name/,
      );
    });
  },
);
