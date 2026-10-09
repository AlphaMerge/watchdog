import { strict as assert } from 'node:assert';
import { DatabaseAuditSink } from '../src/audit/store.js';
import { after, before, describe, it } from 'node:test';
import type { Database, Queryable } from '../src/db/pool.js';
import { AccessService } from '../src/auth/access.js';
import { HistoryService } from '../src/timeseries/history.js';
import { MapResolver, type MapAudience } from '../src/maps/resolver.js';
import { readConnectors, readWidgets } from '../src/maps/widgets.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor } from './support/tree.js';

const available = await databaseAvailable();

/** The canvas size the constraint is stated in: "a map with forty widgets is not forty trips". */
const FORTY = 40;

/**
 * Every statement one `resolve` runs, by watching the real `Database` rather than a stand-in.
 *
 * **The `q` a caller passes is not the whole story**, which is why this exists and the earlier
 * counting stub was not enough: `HistoryService` holds its own handle and reads through that, so
 * a wrapper around the argument sees the object lookup and none of the per-widget work that
 * `G-10` was about. This wraps the instance itself, and its own `tx`, so nothing gets past it.
 */
function watchStatements(db: Database): { seen: string[]; stop: () => void } {
  const seen: string[] = [];
  const realQuery = db.query.bind(db);
  const realTx = db.tx.bind(db);
  const spy = (q: Queryable): Queryable =>
    new Proxy(q, {
      get(target, property, receiver) {
        if (property !== 'query') return Reflect.get(target, property, receiver) as unknown;
        return (text: string, values?: readonly unknown[]) => {
          seen.push(text);
          return target.query(text, values);
        };
      },
    });

  Object.defineProperty(db, 'query', {
    configurable: true,
    value: (text: string, values?: readonly unknown[]) => {
      seen.push(text);
      return realQuery(text, values);
    },
  });
  Object.defineProperty(db, 'tx', {
    configurable: true,
    value: <T>(fn: (q: Queryable) => Promise<T>) => realTx((q) => fn(spy(q))),
  });

  return {
    seen,
    stop: () => {
      Object.defineProperty(db, 'query', { configurable: true, value: realQuery });
      Object.defineProperty(db, 'tx', { configurable: true, value: realTx });
    },
  };
}

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

  it('keeps a connector between two widgets, and reports one that cannot be drawn', () => {
    const { widgets } = readWidgets({
      widgets: [
        { id: 'a', kind: 'status', objectId: 1 },
        { id: 'b', kind: 'status', objectId: 2 },
      ],
    });
    const { connectors, problems } = readConnectors(
      {
        connectors: [
          { id: 'c1', from: 'a', to: 'b' },
          { id: 'c2', from: 'a', to: 'nowhere' },
          { id: 'c3', from: 'a', to: 'a' },
          { id: 'c4', from: 'a' },
          { id: 'c1', from: 'b', to: 'a' },
          'not an object',
        ],
      },
      widgets,
    );

    assert.deepEqual(
      connectors.map((one) => one.id),
      ['c1'],
    );
    // Named rather than dropped: a line has no geometry to be drawn as broken with, so the only
    // way to say it exists is to say why it could not be drawn.
    assert.deepEqual(
      problems.map((one) => one.id),
      ['c2', 'c3', 'c4', 'c1', 'connector-5'],
    );
  });

  it('bounds the connectors and says what it left out', () => {
    const { widgets } = readWidgets({
      widgets: [
        { id: 'a', kind: 'status', objectId: 1 },
        { id: 'b', kind: 'status', objectId: 2 },
      ],
    });
    const many = Array.from({ length: 450 }, (_, i) => ({
      id: `c${String(i)}`,
      from: 'a',
      to: 'b',
    }));
    const { connectors, problems } = readConnectors({ connectors: many }, widgets);
    assert.equal(connectors.length, 400);
    assert.match(problems.at(-1)?.problem ?? '', /only the first 400/);
  });

  it('lets a custom HTML widget name no object at all', () => {
    // A widget that draws whatever somebody typed has nothing to point at, and requiring an id
    // would mean inventing one — a sensor id a widget does not read is a field a later ticket
    // starts believing.
    const { widgets, problems } = readWidgets({
      widgets: [{ id: 'a', kind: 'html', html: '<p>on call: 555</p>' }],
    });
    assert.equal(problems.length, 0);
    const widget = widgets[0];
    assert.ok(widget);
    assert.equal(widget.objectId, null);
    assert.equal(widget.html, '<p>on call: 555</p>');
  });

  it('still insists on an object for the kinds that draw one', () => {
    const { problems } = readWidgets({ widgets: [{ id: 'a', kind: 'status' }] });
    assert.match(problems[0]?.problem ?? '', /objectId/);
  });

  it('drops an object id from a widget that does not draw one', () => {
    const { widgets } = readWidgets({ widgets: [{ id: 'a', kind: 'html', objectId: 42 }] });
    assert.equal(widgets[0]?.objectId, null, 'a field nothing reads is a field somebody trusts');
  });

  it('keeps the markup exactly, and bounds it', () => {
    // **Not sanitised, on purpose** (`ADR-002` Decision 2): the renderer's sandbox is what makes
    // this safe, and a half-cleaner in front of it would invite somebody to lean on it.
    const hostile = '<img src=x onerror="alert(1)"><script>fetch("/api/v1/maps")</script>';
    const { widgets } = readWidgets({ widgets: [{ id: 'a', kind: 'html', html: hostile }] });
    assert.equal(widgets[0]?.html, hostile);

    const long = 'x'.repeat(9000);
    const bounded = readWidgets({ widgets: [{ id: 'b', kind: 'html', html: long }] });
    assert.equal(bounded.widgets[0]?.html.length, 4096);
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
    let deviceId: number;
    let groupId: number;
    let userId: number;
    let adminId: number;
    const many: number[] = [];

    const asReader = (): MapAudience => ({ kind: 'viewer', viewer: { userId, role: 'readwrite' } });
    /** A link an administrator made, which is what every public case here was before `A-22`. */
    const asPublic = (): MapAudience => ({
      kind: 'public',
      maker: { userId: adminId, role: 'admin' },
    });

    before(async () => {
      scratch = await createScratchDatabase('mapres');
      db = scratch.db;
      const harness = await buildHarness(db);

      resolver = new MapResolver({
        db,
        access: new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent }),
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
      deviceId = device.id;

      // Forty more, for the cases that count statements. Creating a sensor materialises the
      // channels its type declares, so each of these has `rtt` and `loss` already.
      for (let i = 0; i < FORTY; i += 1) {
        const made = await harness.service.create(testActor, {
          kind: 'sensor',
          name: `batch-sensor-${String(i).padStart(2, '0')}`,
          parentId: device.id,
          sensorType: 'icmp.ping',
        });
        many.push(made.id);
      }

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
      const admins = await db.query<{ id: string }>(
        `INSERT INTO user_group (name, is_admin) VALUES ('res-admins', true) RETURNING id`,
      );
      const admin = await db.query<{ id: string }>(
        `INSERT INTO user_account (login, display_name, password_hash, role)
         VALUES ('res-admin', 'res', 'x', 'admin') RETURNING id`,
      );
      adminId = Number(admin[0]?.id);
      await db.query(
        `INSERT INTO user_group_member (group_id, user_id, is_primary) VALUES ($1, $2, true)`,
        [Number(admins[0]?.id), adminId],
      );
    });

    after(async () => {
      await scratch.drop();
    });

    const layout = (objectId: number, kind = 'status') => ({
      widgets: [{ id: 'w1', kind, objectId, title: 'A tile', box: { x: 0, y: 0, w: 4, h: 3 } }],
    });

    describe('the public audience, which sees through the link’s maker (A-22)', () => {
      it('draws what the maker may see', async () => {
        const { widgets } = await resolver.resolve(layout(sensorId), asPublic());
        assert.equal(widgets[0]?.state, 'ok');
      });

      it('draws nothing the maker may not see, whatever the stored map names', async () => {
        // The canvas is a document; before `A-22` it was also the whole authorisation, so a map
        // naming the device — saved before the save check existed, or by an author who has since
        // lost the grant — published every sensor on it to anybody with the link.
        const maker = { userId, role: 'readwrite' as const };
        const audience: MapAudience = { kind: 'public', maker };
        const tile = await resolver.resolve(layout(sensorId), audience);
        assert.equal(tile.widgets[0]?.state, 'unavailable');
        const list = await resolver.resolve(layout(deviceId, 'sensor-list'), audience);
        assert.equal(list.widgets[0]?.state, 'unavailable');
      });

      it('draws nothing at all when the maker is gone', async () => {
        const audience: MapAudience = { kind: 'public', maker: null };
        const { widgets } = await resolver.resolve(layout(sensorId), audience);
        assert.equal(widgets[0]?.state, 'unavailable');
      });

      it('is a choice at the call site, not an absent principal', () => {
        // The failure this shape prevents: a resolver where `principal === undefined` quietly
        // means "no checks", so any caller that forgets to pass one reads everything. The maker
        // is a field that has to be written, and `null` is an answer, not an omission.
        const audience: MapAudience = { kind: 'public', maker: null };
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

      it('draws a deleted tile and a hidden one as the same document', async () => {
        // **The oracle this closes.** "Deleted" against "you may not see it" is the difference
        // between knowing an id is dead and knowing it is alive, which is what G-01 refused when
        // it made an unreadable map answer 404. It used to be told to a `full` holder on the map,
        // which every map's creator is (`A-15`), so it is told to nobody. The device is hidden:
        // the case above grants the viewer its sensor and nothing above it.
        const gone = await resolver.resolve(layout(999_999), asReader());
        const hidden = await resolver.resolve(layout(deviceId), asReader());
        assert.equal(hidden.widgets[0]?.state, 'unavailable', 'the fixture really is hidden');
        assert.deepEqual(gone.widgets, hidden.widgets);
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

      it('resolves a custom HTML widget without touching the database', async () => {
        // It names nothing, so there is nothing to look up, nothing to be deleted underneath it
        // and no visibility decision to take.
        const watch = watchStatements(db);
        try {
          const { widgets } = await resolver.resolve(
            { widgets: [{ id: 'w1', kind: 'html', html: '<b>hello</b>' }] },
            asPublic(),
          );
          const widget = widgets[0];
          assert.ok(widget?.state === 'ok');
          assert.ok(widget.data.kind === 'html');
          assert.equal(widget.data.html, '<b>hello</b>');
        } finally {
          watch.stop();
        }
        assert.equal(watch.seen.length, 0, 'a widget that names nothing costs no query');
      });

      it('gives a graph its channels, its state and the range the author chose', async () => {
        // The series are not here on purpose (`G-04`): a resolved map is one request, and a week
        // of buckets for every graph on a canvas is not a thing to put inside it.
        const { widgets } = await resolver.resolve(
          {
            widgets: [
              { id: 'w1', kind: 'graph', objectId: sensorId, title: 'Latency', rangeMinutes: 360 },
            ],
          },
          asPublic(),
        );
        const widget = widgets[0];
        assert.ok(widget?.state === 'ok');
        assert.ok(widget.data.kind === 'graph');
        assert.equal(widget.data.rangeMinutes, 360);
        assert.equal(widget.data.channels.length, 2);
        assert.equal(widget.data.name, 'res-sensor');
      });

      it('clamps a range the document asked for and cannot have', async () => {
        // Clamped rather than refused: a bad number is a tile drawn over a strange period, not a
        // map that will not open — and an unbounded one is a query anybody can ask for.
        const huge = await resolver.resolve(
          { widgets: [{ id: 'w1', kind: 'graph', objectId: sensorId, rangeMinutes: 999_999_999 }] },
          asPublic(),
        );
        const widget = huge.widgets[0];
        assert.ok(widget?.state === 'ok');
        assert.ok(widget.data.kind === 'graph');
        assert.equal(widget.data.rangeMinutes, 60 * 24 * 31);
      });

      it('gives a table its channels, with a gap rather than a zero', async () => {
        const { widgets } = await resolver.resolve(layout(sensorId, 'table'), asPublic());
        const widget = widgets[0];
        assert.ok(widget?.state === 'ok');
        assert.ok(widget.data.kind === 'table');
        // **The count first**, so the loop below is asserting about something: an empty channel
        // list would satisfy every `for (const channel of ...)` there is.
        assert.equal(widget.data.channels.length, 2, 'icmp.ping declares rtt and loss');
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
        const canvas = {
          widgets: Array.from({ length: FORTY }, (_, i) => ({
            id: `w${String(i)}`,
            kind: 'status',
            objectId: i === 0 ? sensorId : 900_000 + i,
          })),
        };
        const { widgets } = await resolver.resolve(canvas, asPublic(), counting);
        assert.equal(widgets.length, FORTY);
        assert.equal(objectQueries, 1, 'one lookup for the whole canvas');
      });

      /**
       * The rest of the claim, which was not true until `G-10`.
       *
       * The counting stub above only ever saw the object lookup — every per-widget read went
       * through `HistoryService`'s own handle, out of its sight. These count *every* statement.
       */
      const canvasOf = (kind: string, ids: readonly number[]) => ({
        widgets: ids.map((objectId, i) => ({ id: `w${String(i)}`, kind, objectId })),
      });

      it('reads forty channel tables in a constant number of statements', async () => {
        const watch = watchStatements(db);
        try {
          const { widgets } = await resolver.resolve(canvasOf('table', many), asPublic());
          assert.equal(widgets.length, FORTY);
        } finally {
          watch.stop();
        }

        const channelReads = watch.seen.filter((text) => text.includes('LEFT JOIN channel c'));
        const valueReads = watch.seen.filter((text) => text.includes('FROM sample'));
        assert.equal(channelReads.length, 1, 'one channel lookup for forty tables');
        assert.equal(valueReads.length, 1, 'one newest-per-channel scan for forty tables');
        // **Five, named**, rather than a generous bound: the object lookup, the audience's rights
        // over every widget at once, the channel lookup, the effective interval for every sensor
        // at once, and one newest-per-channel scan. The rights were not read for a public view
        // until `A-22` made it its link maker's view. Before `G-10` this canvas cost
        // 1 + 40 × 3 = 121, sequentially.
        assert.equal(
          watch.seen.length,
          5,
          `forty tables cost ${String(watch.seen.length)} statements`,
        );
      });

      it('reads forty sensor lists in one recursive query, each with its own subtree', async () => {
        const watch = watchStatements(db);
        try {
          // **The device goes first, and that is not decoration.** Every other root here is a
          // sensor, where the root id and the listed sensor's id are the same number — so a
          // resolver that keyed the answers by the wrong column would still look right. The
          // device is the one root whose subtree is not itself.
          const roots = [deviceId, ...many];
          const { widgets } = await resolver.resolve(canvasOf('sensor-list', roots), asPublic());
          assert.equal(widgets.length, roots.length);

          const below = widgets[0];
          assert.ok(below?.state === 'ok');
          assert.ok(below.data.kind === 'sensor-list');
          assert.equal(below.data.sensors.length, FORTY + 1, 'every sensor under the device');

          const itself = widgets[1];
          assert.ok(itself?.state === 'ok');
          assert.ok(itself.data.kind === 'sensor-list');
          assert.equal(itself.data.sensors.length, 1, 'a sensor lists itself and nothing else');
        } finally {
          watch.stop();
        }

        const subtreeReads = watch.seen.filter((text) => text.includes('WITH RECURSIVE below'));
        assert.equal(subtreeReads.length, 1, 'one subtree query for forty-one lists');
      });

      it('holds each sensor to its own staleness window, not one shared with the widest', async () => {
        // The price of asking one query the widest question: a fast sensor must not keep a
        // reading that a slow sensor's window would have allowed.
        const fast = many[0];
        const slow = many[1];
        assert.ok(fast !== undefined && slow !== undefined);
        await db.query(
          `INSERT INTO object_setting (object_id, key, value) VALUES ($1, 'scan.intervalSeconds', '86400'::jsonb)
           ON CONFLICT (object_id, key) DO UPDATE SET value = excluded.value`,
          [slow],
        );

        const channels = await db.query<{ id: number; sensor_id: string }>(
          `SELECT id, sensor_id::text AS sensor_id FROM channel WHERE sensor_id = ANY($1::bigint[])`,
          [[fast, slow]],
        );
        // Half an hour old: inside a daily sensor's window (three days) and far outside a
        // minute sensor's (three minutes).
        for (const channel of channels) {
          await db.query(
            `INSERT INTO sample (channel_id, time, value) VALUES ($1, now() - interval '30 minutes', 1)`,
            [channel.id],
          );
        }

        const history = new HistoryService({ db, logger: silent });
        const values = await history.latestForSensors([fast, slow]);
        assert.equal(values.get(fast)?.channels[0]?.value, null, 'too old for a minute sensor');
        assert.equal(values.get(slow)?.channels[0]?.value, 1, 'current for a daily one');
      });

      it('says nothing about a sensor id that is not a sensor', async () => {
        const history = new HistoryService({ db, logger: silent });
        const values = await history.latestForSensors([deviceId, 900_001]);
        assert.equal(values.size, 0);
      });
    });
  },
);

/**
 * Which hundred sensors a list shows when their names repeat (`P-381`'s review).
 *
 * Every device has a Ping, so a list over a group ranks a great many equal names, and ranked by
 * name alone the cut fell wherever the plan's input order put it. Here a hundred and one sensors
 * share one name, and the lowest id is written again so a table read in last-written order gives
 * it last. Index scans, merge joins and nested loops are off, so every table is read that way. The
 * ranking without its id is run under the same plan first and must leave the lowest id out; that
 * is the precondition, so a planner that changed its mind fails the test rather than passing it.
 */
describe(
  'a sensor list where names repeat (P-381)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;

    before(async () => {
      scratch = await createScratchDatabase('mapcut');
      db = scratch.db;
    });

    after(async () => {
      await scratch.drop();
    });

    /** The ranking as it was, by name alone: which ids made a list of `$2`. */
    const RANKED_BY_NAME = `WITH RECURSIVE below AS (
        SELECT o.id AS root, o.id AS id, 0 AS depth FROM object o WHERE o.id = $1
        UNION ALL
        SELECT b.root, c.id, b.depth + 1 FROM object c JOIN below b ON c.parent_id = b.id
        WHERE b.depth < 64
      ),
      ranked AS (
        SELECT o.id, row_number() OVER (PARTITION BY b.root ORDER BY lower(o.name)) AS rn
        FROM below b
        JOIN object o ON o.id = b.id
        JOIN sensor_runtime r ON r.object_id = o.id
        WHERE o.kind = 'sensor'
      )
      SELECT id::text AS id FROM ranked WHERE rn <= $2`;

    /** `fn` in a transaction whose plans read each table in the order its rows were last written. */
    const lastWrittenFirst = <T>(fn: (q: Queryable) => Promise<T>): Promise<T> =>
      db.tx(async (q) => {
        for (const setting of [
          'enable_indexscan',
          'enable_indexonlyscan',
          'enable_bitmapscan',
          'enable_mergejoin',
          'enable_nestloop',
        ]) {
          await q.query(`SET LOCAL ${setting} = off`);
        }
        return fn(q);
      });

    it('shows the hundred lowest ids, in id order, whatever plan the ranking gets', async () => {
      const harness = await buildHarness(db);
      const resolver = new MapResolver({
        db,
        access: new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent }),
        history: new HistoryService({ db, logger: silent }),
      });
      const admins = await db.query<{ id: string }>(
        `INSERT INTO user_group (name, is_admin) VALUES ('cut-admins', true) RETURNING id`,
      );
      const admin = await db.query<{ id: string }>(
        `INSERT INTO user_account (login, display_name, password_hash, role)
         VALUES ('cut-admin', 'cut', 'x', 'admin') RETURNING id`,
      );
      const adminId = Number(admin[0]?.id);
      await db.query(
        `INSERT INTO user_group_member (group_id, user_id, is_primary) VALUES ($1, $2, true)`,
        [Number(admins[0]?.id), adminId],
      );

      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        name: 'cut-probe',
        parentId: harness.rootId,
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        name: 'cut-device',
        parentId: probe.id,
        host: '10.0.0.1',
      });
      const ids: number[] = [];
      for (let i = 0; i <= 100; i += 1) {
        const made = await harness.service.create(testActor, {
          kind: 'sensor',
          name: 'Ping',
          parentId: device.id,
          sensorType: 'icmp.ping',
        });
        ids.push(made.id);
      }
      ids.sort((a, b) => a - b);
      const lowest = ids[0] ?? 0;
      const highest = ids.at(-1) ?? 0;
      await db.query('UPDATE object SET name = name WHERE id = $1', [lowest]);
      await db.query('UPDATE sensor_runtime SET message = message WHERE object_id = $1', [lowest]);

      const { byName, widgets } = await lastWrittenFirst(async (q) => ({
        byName: (await q.query<{ id: string }>(RANKED_BY_NAME, [device.id, 100])).map((row) =>
          Number(row.id),
        ),
        widgets: (
          await resolver.resolve(
            { widgets: [{ id: 'list', kind: 'sensor-list', objectId: device.id }] },
            { kind: 'public', maker: { userId: adminId, role: 'admin' } },
            q,
          )
        ).widgets,
      }));
      assert.equal(byName.length, 100);
      assert.equal(
        byName.includes(lowest),
        false,
        'the plan this test needs: by name alone, the rewritten lowest id misses the cut',
      );

      const list = widgets[0];
      assert.ok(list?.state === 'ok');
      assert.ok(list.data.kind === 'sensor-list');
      const shown = list.data.sensors.map((sensor) => sensor.id);
      assert.deepEqual(shown, ids.slice(0, 100), 'the hundred lowest ids, in id order');
      assert.equal(shown.includes(highest), false);
    });
  },
);
