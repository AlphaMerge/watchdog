import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { Database } from '../src/db/pool.js';
import { AccessService } from '../src/auth/access.js';
import { HistoryService } from '../src/timeseries/history.js';
import { MapResolver, type MapAudience } from '../src/maps/resolver.js';
import { readWidgets } from '../src/maps/widgets.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor } from './support/tree.js';

const available = await databaseAvailable();

/**
 * Filling a map's widgets (`G-02`).
 *
 * The four constraints this ticket carried, each asserted: the resolver works with no principal,
 * a deleted object leaves a widget that says so, a widget cannot read what its viewer may not,
 * and forty widgets are not forty round trips.
 */
describe('reading a widget document', () => {
  it('keeps an unreadable widget as a problem rather than dropping it', () => {
    const { widgets, problems } = readWidgets({
      widgets: [
        { id: 'a', kind: 'status', objectId: 1 },
        { id: 'b', kind: 'nonsense', objectId: 1 },
        { id: 'c', kind: 'status', objectId: 'not a number' },
        'not an object',
      ],
    });
    assert.equal(widgets.length, 1, 'the readable one still renders');
    assert.deepEqual(
      problems.map((one) => one.id),
      ['b', 'c', 'widget-3'],
    );
  });

  it('gives a widget a usable box when it has none', () => {
    // A zero-sized tile is invisible and unclickable, which reads as a widget that vanished.
    const { widgets } = readWidgets({ widgets: [{ id: 'a', kind: 'status', objectId: 1 }] });
    assert.ok((widgets[0]?.box.w ?? 0) >= 1);
    assert.ok((widgets[0]?.box.h ?? 0) >= 1);
  });

  it('bounds the canvas and says what it left out', () => {
    // CLAUDE.md: backpressure is visible, never silent. Silently resolving the first two
    // hundred would make a truncated map look like a complete one.
    const many = Array.from({ length: 250 }, (_, i) => ({
      id: `w${String(i)}`,
      kind: 'status',
      objectId: 1,
    }));
    const { widgets, problems } = readWidgets({ widgets: many });
    assert.equal(widgets.length, 200);
    assert.match(problems.at(-1)?.problem ?? '', /only the first 200/);
  });

  it('treats a layout with no widgets key as an empty canvas', () => {
    assert.deepEqual(readWidgets({}).widgets, []);
    assert.deepEqual(readWidgets(null).widgets, []);
  });
});

describe(
  'the map resolver',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let resolver: MapResolver;
    let sensorId: number;
    let groupId: number;
    let userId: number;

    const asAuthor = (): MapAudience => ({
      kind: 'viewer',
      viewer: { userId, role: 'readwrite' },
      holdsFull: true,
    });
    const asReader = (): MapAudience => ({
      kind: 'viewer',
      viewer: { userId, role: 'readwrite' },
      holdsFull: false,
    });
    const asPublic = (): MapAudience => ({ kind: 'public' });

    before(async () => {
      scratch = await createScratchDatabase('mapres');
      db = scratch.db;
      const harness = await buildHarness(db);

      resolver = new MapResolver({
        db,
        access: new AccessService({ db, logger: silent }),
        history: new HistoryService({ db, logger: silent }),
      });

      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        name: 'res-probe',
        parentId: harness.rootId,
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        name: 'res-device',
        parentId: probe.id,
        host: '10.0.0.1',
      });
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        name: 'res-sensor',
        parentId: device.id,
        sensorType: 'icmp.ping',
      });
      sensorId = sensor.id;

      const groups = await db.query<{ id: string }>(
        `INSERT INTO user_group (name) VALUES ('res-group') RETURNING id`,
      );
      groupId = Number(groups[0]?.id);
      const users = await db.query<{ id: string }>(
        `INSERT INTO user_account (login, display_name, password_hash, role)
         VALUES ('res-user', 'res', 'x', 'readwrite') RETURNING id`,
      );
      userId = Number(users[0]?.id);
      await db.query(
        `INSERT INTO user_group_member (group_id, user_id, is_primary) VALUES ($1, $2, true)`,
        [groupId, userId],
      );
    });

    after(async () => {
      await scratch.drop();
    });

    const layout = (objectId: number, kind = 'status') => ({
      widgets: [{ id: 'w1', kind, objectId, title: 'A tile', box: { x: 0, y: 0, w: 4, h: 3 } }],
    });

    describe('the public audience, which has no principal at all', () => {
      it('resolves without one — the widget list is the authorisation', async () => {
        // ADR-002 Decision 1: the author chose what is on the canvas and the route serves that.
        const { widgets } = await resolver.resolve(layout(sensorId), asPublic());
        assert.equal(widgets[0]?.state, 'ok');
      });

      it('is a choice at the call site, not an absent principal', () => {
        // The failure this shape prevents: a resolver where `principal === undefined` quietly
        // means "no checks", so any caller that forgets to pass one reads everything.
        const audience: MapAudience = { kind: 'public' };
        assert.equal(audience.kind, 'public');
      });
    });

    describe('a widget naming something the viewer may not see', () => {
      it('does not draw it', async () => {
        // No grant on the object, so a widget must not become a way to read it.
        const { widgets } = await resolver.resolve(layout(sensorId), asReader());
        assert.equal(widgets[0]?.state, 'unavailable');
      });

      it('resolves once the viewer is granted read', async () => {
        await db.query(
          `INSERT INTO object_access (object_id, group_id, right_) VALUES ($1, $2, 'read')
           ON CONFLICT (object_id, group_id) DO UPDATE SET right_ = 'read'`,
          [sensorId, groupId],
        );
        const { widgets } = await resolver.resolve(layout(sensorId), asReader());
        assert.equal(widgets[0]?.state, 'ok');
      });
    });

    describe('a widget naming something that is gone', () => {
      it('says the tile is unavailable rather than dropping it', async () => {
        // G-01's schema keeps the reference on purpose; this is the half that renders it.
        const { widgets } = await resolver.resolve(layout(999_999), asReader());
        assert.equal(widgets.length, 1, 'the tile is still on the canvas');
        const widget = widgets[0];
        assert.ok(widget);
        assert.equal(widget.state, 'unavailable');
        assert.equal(widget.title, 'A tile', 'still where the author put it');
      });

      it('tells an author why, and tells a reader nothing', async () => {
        // **The oracle this closes.** "Deleted" against "you may not see it" is the difference
        // between knowing an id is dead and knowing it is alive, which is what G-01 refused when
        // it made an unreadable map answer 404.
        const author = await resolver.resolve(layout(999_999), asAuthor());
        const reader = await resolver.resolve(layout(999_999), asReader());
        assert.equal(
          (author.widgets[0] as { reason?: string }).reason,
          'object-deleted',
          'the person fixing it is told',
        );
        assert.equal((reader.widgets[0] as { reason?: string }).reason, undefined);
      });

      it('tells the public audience nothing either', async () => {
        const { widgets } = await resolver.resolve(layout(999_999), asPublic());
        assert.equal((widgets[0] as { reason?: string }).reason, undefined);
      });
    });

    describe('what each widget kind draws', () => {
      it('gives a status widget the state and why', async () => {
        const { widgets } = await resolver.resolve(layout(sensorId), asPublic());
        const widget = widgets[0];
        assert.ok(widget?.state === 'ok');
        assert.ok(widget.data.kind === 'status');
        assert.equal(widget.data.name, 'res-sensor');
      });

      it('gives a sensor list the sensors below an object', async () => {
        const { widgets } = await resolver.resolve(layout(sensorId, 'sensor-list'), asPublic());
        const widget = widgets[0];
        assert.ok(widget?.state === 'ok');
        assert.ok(widget.data.kind === 'sensor-list');
        assert.equal(widget.data.sensors.length, 1);
        assert.equal(widget.data.sensors[0]?.name, 'res-sensor');
      });

      it('gives a table its channels, with a gap rather than a zero', async () => {
        const { widgets } = await resolver.resolve(layout(sensorId, 'table'), asPublic());
        const widget = widgets[0];
        assert.ok(widget?.state === 'ok');
        assert.ok(widget.data.kind === 'table');
        // Nothing has been recorded, so every channel is a gap. A zero here would say the
        // sensor measured nothing rather than that nothing was measured.
        for (const channel of widget.data.channels) assert.equal(channel.value, null);
      });
    });

    describe('one pass, not one per widget', () => {
      it('resolves forty widgets without forty object queries', async () => {
        // The constraint the ticket set. Counted by watching the object lookup rather than by
        // timing, so a slow machine cannot make this pass or fail for the wrong reason.
        let objectQueries = 0;
        const counting = {
          query: async <T>(text: string, values?: readonly unknown[]): Promise<T[]> => {
            if (text.includes('FROM object o') && text.includes('sensor_runtime')) {
              objectQueries += 1;
            }
            return db.query(text, values) as Promise<T[]>;
          },
        };

        // **Forty distinct objects, and that is the whole point.** The first version of this
        // pointed all forty widgets at one sensor; the resolver de-duplicates ids before it
        // queries, so one lookup and forty lookups behaved identically and the case passed
        // against the bug it exists to catch. Found by the mutation surviving — the same shape
        // as entry 38, a fixture where every actor is the same actor.
        const many = {
          widgets: Array.from({ length: 40 }, (_, i) => ({
            id: `w${String(i)}`,
            kind: 'status',
            objectId: i === 0 ? sensorId : 900_000 + i,
          })),
        };
        const { widgets } = await resolver.resolve(many, asPublic(), counting);
        assert.equal(widgets.length, 40);
        assert.equal(objectQueries, 1, 'one lookup for the whole canvas');
      });
    });
  },
);
