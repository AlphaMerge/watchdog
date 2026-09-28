import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository, CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import { Visibility } from '../src/auth/access.js';
import { diffObjects } from '../src/audit/diff.js';
import type { Database } from '../src/db/pool.js';
import type { Mutation } from '../src/objects/audit.js';
import {
  STATE_TRIGGER,
  THRESHOLD_TRIGGER,
  TRIGGERABLE_STATES,
  triggerKinds,
  TriggerError,
} from '../src/triggers/definition.js';
import { TriggerRepository } from '../src/triggers/repository.js';
import { TriggerService } from '../src/triggers/service.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

// -------------------------------------------------------------------------------------------
// The kinds, and the one place settings are checked.
// -------------------------------------------------------------------------------------------

describe('trigger kinds', () => {
  it('knows the two v1 kinds and nothing else', () => {
    assert.deepEqual(triggerKinds.ids.sort(), ['state', 'threshold']);
  });

  it('fills the schema defaults in, so a minimal trigger is a complete one', () => {
    const settings = triggerKinds.validate('state', { state: 'down' });
    assert.deepEqual(settings, {
      state: 'down',
      initialLatencySeconds: 0,
      escalationLatencySeconds: 0,
      repeatMinutes: 0,
    });
  });

  it('does not mutate what it was handed', () => {
    // `useDefaults` writes into the object it validates. A caller reusing one literal across
    // two triggers would otherwise have the first one's defaults leak into the second.
    const input = { state: 'down' };
    triggerKinds.validate('state', input);
    assert.deepEqual(input, { state: 'down' });
  });

  it('refuses a state nothing can reach', () => {
    // `unusual` is [V2]. A form field for a trigger that could never fire is worse than a
    // missing one: it looks configured.
    assert.throws(
      () => triggerKinds.validate('state', { state: 'unusual' }),
      (error: unknown) => error instanceof TriggerError && error.code === 'TRIGGER_INVALID',
    );
  });

  it('offers the states CAPABILITIES.MD §5.1 lists, and not every state a sensor has', () => {
    assert.deepEqual([...TRIGGERABLE_STATES], ['down', 'warning', 'up', 'unknown']);
    // Reachable, and still not offered. Pausing is the operator's own action, and acknowledging
    // is how they stop being told — a trigger on either notifies about the wrong thing (N-16).
    for (const state of ['paused', 'down_acknowledged']) {
      assert.throws(() => triggerKinds.validate('state', { state }), TriggerError, state);
    }
  });

  it('refuses a field the kind does not have, rather than storing it', () => {
    assert.throws(
      () => triggerKinds.validate('state', { state: 'down', escalate: true }),
      TriggerError,
    );
  });

  it('refuses settings that leave out what the kind needs', () => {
    assert.throws(
      () => triggerKinds.validate('threshold', { channelKey: 'load', condition: 'above' }),
      TriggerError,
    );
  });

  it('names the problems, so a client can point at the field', () => {
    try {
      triggerKinds.validate('threshold', { channelKey: '', condition: 'sideways', value: 'nope' });
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof TriggerError);
      const problems = (error.details as { problems?: string[] }).problems ?? [];
      assert.ok(problems.length >= 3, `expected each bad field named, got ${problems.join('; ')}`);
      assert.ok(problems.some((problem) => problem.includes('/condition')));
    }
  });

  it('refuses a kind this build does not have', () => {
    assert.throws(
      () => triggerKinds.get('speed'),
      (error: unknown) => error instanceof TriggerError && error.message.includes('speed'),
    );
  });

  it('describes a state trigger as a sentence an operator reads', () => {
    assert.equal(
      STATE_TRIGGER.describe({ state: 'down', initialLatencySeconds: 300 }),
      'when down, notify after 300s',
    );
    assert.equal(
      STATE_TRIGGER.describe({
        state: 'down',
        initialLatencySeconds: 0,
        escalationLatencySeconds: 900,
        repeatMinutes: 60,
      }),
      'when down, notify immediately; escalate after 900s; repeat every 60m',
    );
  });

  it('describes a threshold trigger with the comparison in it', () => {
    assert.equal(
      THRESHOLD_TRIGGER.describe({ channelKey: 'load', condition: 'above', value: 80 }),
      'when load > 80',
    );
    assert.equal(
      THRESHOLD_TRIGGER.describe({
        channelKey: 'load',
        condition: 'below',
        value: 1,
        latencySeconds: 120,
      }),
      'when load < 1 for 120s',
    );
  });

  it('finds the templates a trigger references, so N-05 can refuse to delete one in use', () => {
    assert.deepEqual(
      triggerKinds.templatesIn('state', {
        state: 'down',
        initialTemplateId: 7,
        escalationTemplateId: null,
        recoveryTemplateId: 9,
      }),
      [7, 9],
    );
  });
});

// -------------------------------------------------------------------------------------------
// Storage and inheritance.
// -------------------------------------------------------------------------------------------

describe('triggers', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let h: Harness;
  let app: FastifyInstance;
  let triggers: TriggerService;
  let repo: TriggerRepository;
  let probeId: number;
  let groupId: number;
  let deviceId: number;
  let sensorId: number;
  let otherDeviceId: number;
  let otherSensorId: number;
  let audited: Mutation[];

  before(async () => {
    scratch = await createScratchDatabase('triggers');
    db = scratch.db;
    h = await buildHarness(db);

    repo = new TriggerRepository();
    audited = [];
    // The production composite, plus one capture: a trigger edit is a configuration change, and
    // the entry has to be written inside the mutation's own transaction like every other.
    triggers = new TriggerService({
      db,
      audit: new CompositeAuditSink([
        new DatabaseAuditSink(),
        {
          record: (_q, _actor, mutations) => {
            audited.push(...mutations);
            return Promise.resolve();
          },
        },
      ]),
      logger: silent,
      repository: repo,
    });

    const server = new ApiServer({
      config: {
        host: '127.0.0.1',
        port: 0,
        webRoot: '',
        allowedOrigins: [],
        requireAuthentication: true,
      },
      logger: silent,
      version: '9.9.9',
      service: h.service,
      history: new HistoryService({ db, logger: silent }),
      db,
      audit: new AuditRepository(),
      catalogue: testCatalogue(),
      triggers,
    });
    await server.build('9.9.9', h.service);
    app = server.app;
  });

  after(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    // A trigger on the root would apply to every other test's sensors, which is exactly the
    // behaviour under test and exactly why each test has to start from none.
    await db.query('DELETE FROM notification_trigger');
    audited.length = 0;
    h.audit.recorded.length = 0;

    const probe = await h.service.create(testActor, {
      kind: 'probe',
      parentId: h.rootId,
      name: `probe-${String(process.hrtime.bigint())}`,
    });
    probeId = probe.id;
    groupId = (
      await h.service.create(testActor, { kind: 'group', parentId: probeId, name: 'London' })
    ).id;
    deviceId = (
      await h.service.create(testActor, {
        kind: 'device',
        parentId: groupId,
        name: 'device',
        host: '192.0.2.80',
      })
    ).id;
    sensorId = (
      await h.service.create(testActor, {
        kind: 'sensor',
        parentId: deviceId,
        name: 'sensor',
        sensorType: 'icmp.ping',
      })
    ).id;
    otherDeviceId = (
      await h.service.create(testActor, {
        kind: 'device',
        parentId: groupId,
        name: 'other',
        host: '192.0.2.81',
      })
    ).id;
    otherSensorId = (
      await h.service.create(testActor, {
        kind: 'sensor',
        parentId: otherDeviceId,
        name: 'other sensor',
        sensorType: 'icmp.ping',
      })
    ).id;
  });

  const downTrigger = { kind: 'state', settings: { state: 'down' } };
  const loadTrigger = {
    kind: 'threshold',
    settings: { channelKey: 'load', condition: 'above', value: 80 },
  };

  it('stores a trigger with its kind’s defaults filled in', async () => {
    const created = await triggers.create(testActor, deviceId, downTrigger);
    assert.equal(created.kind, 'state');
    assert.equal(created.enabled, true);
    assert.equal(created.inherited, false);
    assert.equal(created.definedOn.objectId, deviceId);
    assert.equal(created.definedOn.name, 'device');
    assert.equal(created.summary, 'when down, notify immediately');
    assert.equal(created.settings['initialLatencySeconds'], 0);
  });

  it('inherits by accumulation, not by nearest-ancestor', async () => {
    // The central distinction of N-01. A *setting* on the device would displace the group's;
    // a trigger does not — CAPABILITIES.MD §5.1 says the child shows its own and every
    // inherited one, so both fire.
    await triggers.create(testActor, h.rootId, downTrigger);
    await triggers.create(testActor, groupId, loadTrigger);
    await triggers.create(testActor, sensorId, {
      kind: 'state',
      settings: { state: 'warning', initialLatencySeconds: 60 },
    });

    const effective = await triggers.effectiveFor(sensorId, Visibility.EVERYTHING);
    assert.equal(effective.length, 3, 'all three apply; none displaces another');
    assert.deepEqual(
      effective.map((trigger) => trigger.summary),
      ['when warning, notify after 60s', 'when load > 80', 'when down, notify immediately'],
      'nearest first: the sensor’s own, then the group’s, then the root’s',
    );
  });

  it('names the object each inherited trigger is defined on', async () => {
    // The only place it can be edited or removed. A trigger an operator cannot find is one
    // they cannot turn off.
    await triggers.create(testActor, groupId, downTrigger);
    const [inherited] = await triggers.effectiveFor(sensorId, Visibility.EVERYTHING);
    assert.ok(inherited !== undefined);
    assert.equal(inherited.inherited, true);
    assert.equal(inherited.definedOn.objectId, groupId);
    assert.equal(inherited.definedOn.name, 'London');
  });

  it('applies a root trigger to every sensor in the installation', async () => {
    await triggers.create(testActor, h.rootId, downTrigger);
    for (const id of [sensorId, otherSensorId, deviceId, probeId]) {
      const effective = await triggers.effectiveFor(id, Visibility.EVERYTHING);
      assert.equal(effective.length, 1, `object ${String(id)} should inherit the root trigger`);
    }
  });

  it('does not reach across a branch', async () => {
    await triggers.create(testActor, deviceId, downTrigger);
    assert.equal((await triggers.effectiveFor(otherSensorId, Visibility.EVERYTHING)).length, 0);
    assert.equal(
      (await triggers.effectiveFor(groupId, Visibility.EVERYTHING)).length,
      0,
      'nor upward',
    );
  });

  it('follows the object, not a copy: moving a sensor changes what applies to it', async () => {
    await triggers.create(testActor, deviceId, downTrigger);
    assert.equal((await triggers.effectiveFor(sensorId, Visibility.EVERYTHING)).length, 1);

    await h.service.move(testActor, sensorId, otherDeviceId, { kind: 'none' });
    assert.equal(
      (await triggers.effectiveFor(sensorId, Visibility.EVERYTHING)).length,
      0,
      'inheritance is resolved from where the object is now',
    );
  });

  it('resolves the same set downward for a batch of sensors', async () => {
    // What the engine asks (N-02), and the cheap direction: a handful of triggers, five
    // thousand sensors. It has to agree with the tab, or the two halves of the system disagree
    // about who gets told.
    await triggers.create(testActor, h.rootId, downTrigger);
    await triggers.create(testActor, deviceId, loadTrigger);

    const batch = await repo.effectiveForSensors(db, [sensorId, otherSensorId]);
    assert.deepEqual(
      (batch.get(sensorId) ?? []).map((trigger) => trigger.kind),
      ['threshold', 'state'],
      'nearest first, like the tab: the device’s own before the root’s',
    );
    assert.deepEqual(
      (batch.get(otherSensorId) ?? []).map((trigger) => trigger.kind),
      ['state'],
    );

    // Not just the same set — the same order. The engine sees the most specific rule first, and
    // a tab that ranked them differently would be describing a different system.
    for (const id of [sensorId, otherSensorId]) {
      assert.deepEqual(
        (batch.get(id) ?? []).map((trigger) => trigger.id),
        (await triggers.effectiveFor(id, Visibility.EVERYTHING)).map((trigger) => trigger.id),
        `the batch and the tab should agree about ${String(id)}`,
      );
    }
  });

  // -----------------------------------------------------------------------------------------
  // `N-16`: fencing a subtree off from its ancestors' triggers.
  // -----------------------------------------------------------------------------------------

  /** Turns the fence on or off for one object. */
  async function fence(objectId: number, inherits: boolean): Promise<void> {
    await h.service.update(
      testActor,
      objectId,
      {
        kind: objectId === deviceId || objectId === otherDeviceId ? 'device' : 'group',
        inheritsTriggers: inherits,
      },
      { kind: 'none' },
    );
  }

  it('stops the walk at an object that does not inherit', async () => {
    // The case the flag exists for: a lab inside a production tree. Keep monitoring it, keep the
    // graphs and the uptime, and stop telling anybody about it.
    await triggers.create(testActor, h.rootId, downTrigger);
    await triggers.create(testActor, groupId, loadTrigger);
    assert.equal((await triggers.effectiveFor(sensorId, Visibility.EVERYTHING)).length, 2);

    await fence(deviceId, false);
    assert.deepEqual(
      await triggers.effectiveFor(sensorId, Visibility.EVERYTHING),
      [],
      'nothing above the fence reaches the sensor',
    );
    assert.equal(
      (await triggers.effectiveFor(otherSensorId, Visibility.EVERYTHING)).length,
      2,
      'and the branch beside it is untouched',
    );
  });

  it('keeps the fenced object’s own triggers, and its subtree’s', async () => {
    // The flag says where the climb stops, not that this object notifies nobody. A lab team
    // that wants its own alarms and none of production's is the whole point.
    await triggers.create(testActor, h.rootId, downTrigger);
    await fence(deviceId, false);
    const own = await triggers.create(testActor, deviceId, loadTrigger);

    const effective = await triggers.effectiveFor(sensorId, Visibility.EVERYTHING);
    assert.deepEqual(
      effective.map((trigger) => trigger.id),
      [own.id],
      'the fence’s own trigger still reaches the sensor beneath it',
    );
  });

  it('agrees in both directions, which is the only way the tab and the engine can', async () => {
    // The tab walks up from a sensor and the engine walks down from a trigger. A fence one of
    // them ignored would put a notification on a page that says no notification applies.
    await triggers.create(testActor, h.rootId, downTrigger);
    await triggers.create(testActor, groupId, loadTrigger);
    await triggers.create(testActor, deviceId, {
      kind: 'state',
      settings: { state: 'warning' },
    });
    await fence(deviceId, false);

    for (const id of [sensorId, otherSensorId]) {
      const tab = (await triggers.effectiveFor(id, Visibility.EVERYTHING))
        .map((trigger) => trigger.id)
        .sort();
      const batch = ((await repo.effectiveForSensors(db, [id])).get(id) ?? [])
        .map((trigger) => trigger.id)
        .sort();
      assert.deepEqual(batch, tab, `the batch and the tab should agree about ${String(id)}`);
    }
  });

  it('lets the fence come down again', async () => {
    await triggers.create(testActor, h.rootId, downTrigger);
    await fence(deviceId, false);
    assert.equal((await triggers.effectiveFor(sensorId, Visibility.EVERYTHING)).length, 0);
    await fence(deviceId, true);
    assert.equal(
      (await triggers.effectiveFor(sensorId, Visibility.EVERYTHING)).length,
      1,
      'and everything comes back',
    );
  });

  it('records the change, because who gets told is worth finding afterwards', async () => {
    await fence(deviceId, false);
    const change = h.audit.recorded
      .flatMap((mutation) => (mutation.action === 'object.updated' ? [mutation] : []))
      .at(-1);
    assert.ok(change !== undefined, 'nothing was audited');
    assert.equal(change.before.inheritsTriggers, true);
    assert.equal(change.after.inheritsTriggers, false);
    assert.deepEqual(diffObjects(change.before, change.after), [
      { field: 'inheritsTriggers', before: true, after: false },
    ]);
  });

  it('serves a disabled trigger to the tab and withholds it from the engine', async () => {
    // Different questions. The tab asks "what is configured here", and a disabled trigger an
    // operator cannot see is one they cannot re-enable. The engine asks "what fires", and the
    // answer for a disabled trigger is nothing.
    const created = await triggers.create(testActor, deviceId, { ...downTrigger, enabled: false });

    const tab = await triggers.effectiveFor(sensorId, Visibility.EVERYTHING);
    assert.equal(tab.length, 1);
    assert.equal(tab[0]?.enabled, false);

    const batch = await repo.effectiveForSensors(db, [sensorId]);
    assert.equal(batch.get(sensorId), undefined);

    await triggers.update(testActor, created.id, { ...downTrigger, enabled: true });
    assert.equal((await repo.effectiveForSensors(db, [sensorId])).get(sensorId)?.length, 1);
  });

  it('answers the engine’s guard without scanning anything', async () => {
    assert.equal(await repo.anyDefined(db), false);
    const created = await triggers.create(testActor, deviceId, downTrigger);
    assert.equal(await repo.anyDefined(db), true);

    // Disabled is not defined, as far as the guard is concerned: an installation whose only
    // trigger is switched off notifies nobody, and should pay nothing for it.
    await triggers.update(testActor, created.id, { ...downTrigger, enabled: false });
    assert.equal(await repo.anyDefined(db), false);
  });

  it('replaces a trigger whole, rather than merging fields', async () => {
    const created = await triggers.create(testActor, deviceId, {
      kind: 'state',
      settings: { state: 'down', initialLatencySeconds: 300, repeatMinutes: 60 },
    });
    const updated = await triggers.update(testActor, created.id, {
      kind: 'state',
      settings: { state: 'warning' },
    });
    assert.equal(updated.id, created.id);
    assert.equal(updated.settings['initialLatencySeconds'], 0, 'the old latency is gone');
    assert.equal(updated.settings['repeatMinutes'], 0);
    assert.equal(updated.summary, 'when warning, notify immediately');
  });

  it('changes a trigger’s kind in place', async () => {
    const created = await triggers.create(testActor, deviceId, downTrigger);
    const updated = await triggers.update(testActor, created.id, loadTrigger);
    assert.equal(updated.kind, 'threshold');
    assert.equal(updated.summary, 'when load > 80');
  });

  it('refuses to save settings that fail their kind', async () => {
    await assert.rejects(
      () => triggers.create(testActor, deviceId, { kind: 'state', settings: {} }),
      TriggerError,
    );
    assert.equal(await repo.anyDefined(db), false, 'nothing was stored');
  });

  it('takes its triggers with it when the object is deleted', async () => {
    await triggers.create(testActor, otherDeviceId, downTrigger);
    await triggers.create(testActor, otherSensorId, loadTrigger);
    await h.service.delete(
      testActor,
      otherDeviceId,
      { kind: 'exact', descendants: 1 },
      { kind: 'none' },
    );
    assert.equal(await repo.anyDefined(db), false);
  });

  it('records every change in the audit log, inside the mutation’s transaction', async () => {
    const created = await triggers.create(testActor, deviceId, downTrigger);
    await triggers.update(testActor, created.id, loadTrigger);
    await triggers.delete(testActor, created.id);

    assert.deepEqual(
      audited.map((mutation) => mutation.action),
      ['trigger.created', 'trigger.updated', 'trigger.deleted'],
    );
    for (const mutation of audited) {
      assert.equal(mutation.objectId, deviceId, 'the entry hangs off the object it changed');
    }
    // The summary is what the history tab reads. "trigger.updated" alone says nothing about
    // what an alarm will now do.
    assert.equal(
      audited.map((mutation) => (mutation as { summary?: string }).summary)[2],
      'when load > 80',
    );

    const rows = await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE object_id = $1 AND action LIKE 'trigger.%'
       ORDER BY id`,
      [deviceId],
    );
    assert.deepEqual(
      rows.map((row) => row.action),
      ['trigger.created', 'trigger.updated', 'trigger.deleted'],
    );
  });

  it('bumps the owning object’s configuration version', async () => {
    // Editing a trigger changes what leaves the building. It is a configuration change like
    // any other, and the ETag has to move or a cached read serves a stale tab.
    const before = await version(deviceId);
    const created = await triggers.create(testActor, deviceId, downTrigger);
    const afterCreate = await version(deviceId);
    assert.ok(afterCreate > before, `${String(afterCreate)} should exceed ${String(before)}`);

    await triggers.delete(testActor, created.id);
    assert.ok((await version(deviceId)) > afterCreate, 'and again when it is removed');
  });

  it('refuses to edit or delete a trigger that is not there', async () => {
    await assert.rejects(() => triggers.update(testActor, 999_999, downTrigger), {
      code: 'OBJECT_NOT_FOUND',
    });
    await assert.rejects(() => triggers.delete(testActor, 999_999), {
      code: 'OBJECT_NOT_FOUND',
    });
  });

  // -----------------------------------------------------------------------------------------
  // Over HTTP.
  // -----------------------------------------------------------------------------------------

  it('serves the kinds with the schema a form is built from', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/trigger-kinds' });
    assert.equal(response.statusCode, 200);
    const body = response.json<{
      items: { id: string; settingsSchema: { required: string[] } }[];
    }>();
    assert.deepEqual(body.items.map((kind) => kind.id).sort(), ['state', 'threshold']);
    const state = body.items.find((kind) => kind.id === 'state');
    assert.deepEqual(state?.settingsSchema.required, ['state']);
  });

  it('creates, reads, replaces and removes a trigger over HTTP', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/objects/${String(deviceId)}/triggers`,
      payload: downTrigger,
    });
    assert.equal(created.statusCode, 201);
    const id = created.json<{ id: number }>().id;

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/objects/${String(sensorId)}/triggers`,
    });
    assert.equal(listed.statusCode, 200);
    const body = listed.json<{
      objectId: number;
      items: { id: number; inherited: boolean; definedOn: { objectId: number } }[];
    }>();
    assert.equal(body.objectId, sensorId);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0]?.inherited, true);
    assert.equal(body.items[0].definedOn.objectId, deviceId);

    const replaced = await app.inject({
      method: 'PUT',
      url: `/api/v1/triggers/${String(id)}`,
      payload: loadTrigger,
    });
    assert.equal(replaced.statusCode, 200);
    assert.equal(replaced.json<{ summary: string }>().summary, 'when load > 80');

    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/triggers/${String(id)}` });
    assert.equal(removed.statusCode, 200);
    assert.equal((await triggers.effectiveFor(sensorId, Visibility.EVERYTHING)).length, 0);
  });

  it('reports bad settings as the caller’s mistake, naming the field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/objects/${String(deviceId)}/triggers`,
      payload: { kind: 'state', settings: { state: 'sideways' } },
    });
    assert.equal(response.statusCode, 400, 'not a 500 — the request was wrong, not the server');
    const body = response.json<{ error: { code: string; details: { problems: string[] } } }>();
    assert.equal(body.error.code, 'TRIGGER_INVALID');
    assert.ok(body.error.details.problems.length > 0, 'and says which field');
  });

  it('reports an unknown kind rather than storing one nothing can interpret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/objects/${String(deviceId)}/triggers`,
      payload: { kind: 'telepathy', settings: {} },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json<{ error: { code: string } }>().error.code, 'TRIGGER_INVALID');
  });

  it('still lists and still deletes a trigger of a kind this build does not know', async () => {
    // **`P-139`.** A row written by a newer build, or left behind by a downgrade, made
    // `triggerKinds.get` throw on the *list* — so the whole trigger tab answered 500 and the
    // operator could not see any of their triggers, including the one causing it. It threw again
    // in `delete`, which builds its audit summary through the kind, so the one action that would
    // have cleared the row was the one action that could not be taken.
    const created = await triggers.create(testActor, sensorId, {
      kind: 'state',
      settings: { state: 'down', initialTemplateId: 7 },
    });
    await db.query(`UPDATE notification_trigger SET kind = 'from-the-future' WHERE id = $1`, [
      created.id,
    ]);

    const listed = await triggers.effectiveFor(sensorId, Visibility.EVERYTHING);
    assert.equal(listed.length, 1, 'the list still answers');
    const only = listed[0];
    assert.ok(only !== undefined);
    assert.equal(only.kind, 'from-the-future');
    assert.match(only.summary, /does not know the trigger kind/);

    await triggers.delete(testActor, created.id);
    assert.equal(
      (await triggers.effectiveFor(sensorId, Visibility.EVERYTHING)).length,
      0,
      'and the row can be cleared',
    );
  });

  it('404s for a trigger that is not there', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/api/v1/triggers/999999' });
    assert.equal(response.statusCode, 404);
  });

  it('never caches the effective set', async () => {
    // It changes when *any* ancestor is edited, and an ETag built from this object alone would
    // not move.
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/objects/${String(sensorId)}/triggers`,
    });
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  async function version(objectId: number): Promise<number> {
    const rows = await db.query<{ version: number }>('SELECT version FROM object WHERE id = $1', [
      objectId,
    ]);
    return rows[0]?.version ?? 0;
  }
});
