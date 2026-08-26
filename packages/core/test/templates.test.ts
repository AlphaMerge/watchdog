import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository, CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import type { Mutation } from '../src/objects/audit.js';
import {
  MethodError,
  MethodRegistry,
  notificationMethods,
  PROGRAM_METHOD,
  SLACK_METHOD,
  WEBHOOK_METHOD,
} from '../src/notifications/methods.js';
import { TemplateService } from '../src/notifications/templates.js';
import { HistoryService } from '../src/timeseries/history.js';
import { TriggerService } from '../src/triggers/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/** The string that must never come back out of anything. */
const SLACK_SECRET = 'https://hooks.slack.example/services/T000/B000/xoxb-do-not-leak';
const BEARER = 'Bearer do-not-leak-either';

// -------------------------------------------------------------------------------------------
// The method registry.
// -------------------------------------------------------------------------------------------

describe('notification methods', () => {
  it('knows the five v1 methods and nothing else', () => {
    assert.deepEqual(notificationMethods.ids.sort(), [
      'email',
      'program',
      'slack',
      'teams',
      'webhook',
    ]);
  });

  it('fills the schema defaults in', () => {
    assert.deepEqual(notificationMethods.validate('email', {}), {
      format: 'plain',
      senderOverride: null,
    });
  });

  it('refuses a method this build does not have', () => {
    assert.throws(() => notificationMethods.get('carrier-pigeon'), MethodError);
  });

  it('refuses settings that leave out what the method needs', () => {
    assert.throws(() => notificationMethods.validate('slack', {}), MethodError);
    assert.throws(() => notificationMethods.validate('webhook', {}), MethodError);
    assert.throws(() => notificationMethods.validate('program', {}), MethodError);
  });

  it('does not mutate what it was handed', () => {
    const input = { url: 'https://example.test/hook' };
    notificationMethods.validate('webhook', input);
    assert.deepEqual(input, { url: 'https://example.test/hook' });
  });

  // ── the part that matters ──────────────────────────────────────────────────────────────

  it('knows which field of each method is a credential', () => {
    // Declared once, in the schema, and collected at load. A method that adds a secret and
    // forgets to mark it is the failure this list is here to make visible in review.
    assert.deepEqual(notificationMethods.secretsOf('slack'), ['webhookUrl']);
    assert.deepEqual(notificationMethods.secretsOf('teams'), ['webhookUrl']);
    assert.deepEqual(notificationMethods.secretsOf('webhook'), ['secretHeaders']);
    assert.deepEqual(notificationMethods.secretsOf('program'), ['secretArgs']);
    assert.deepEqual(notificationMethods.secretsOf('email'), []);
  });

  it('strips the secret and says it did', () => {
    const stored = notificationMethods.validate('slack', { webhookUrl: SLACK_SECRET });
    const { settings, redacted } = notificationMethods.redact('slack', stored);
    assert.equal(settings['webhookUrl'], undefined);
    assert.deepEqual(redacted, ['webhookUrl']);
    // Naming what was removed is the difference between "not configured" and "configured, not
    // shown" — a form that could not tell them apart would invite an operator to retype it.
    assert.ok(!JSON.stringify(settings).includes('xoxb'));
  });

  it('strips a whole secret object, not just its known keys', () => {
    const stored = notificationMethods.validate('webhook', {
      url: 'https://example.test/hook',
      secretHeaders: { authorization: BEARER, 'x-signature': 'abc' },
    });
    const { settings } = notificationMethods.redact('webhook', stored);
    assert.equal(settings['url'], 'https://example.test/hook', 'the address stays visible');
    assert.equal(settings['secretHeaders'], undefined);
    assert.ok(!JSON.stringify(settings).includes('do-not-leak'));
  });

  it('describes a template without reaching for its secret', () => {
    // A one-line summary is the likeliest place for a secret to escape by accident, so the
    // methods whose only interesting field is secret describe themselves without it.
    assert.equal(SLACK_METHOD.describe({ webhookUrl: SLACK_SECRET }), 'Slack incoming webhook');
    assert.ok(!SLACK_METHOD.describe({ webhookUrl: SLACK_SECRET }).includes('xoxb'));
    assert.equal(
      WEBHOOK_METHOD.describe({ verb: 'POST', url: 'https://example.test/hook' }),
      'POST https://example.test/hook',
    );
    assert.equal(
      PROGRAM_METHOD.describe({ path: '/opt/page.sh', args: ['a', 'b'] }),
      'run /opt/page.sh with 2 argument(s)',
    );
  });

  it('keeps a secret the caller did not resend, and clears one sent as null', () => {
    // Without this, every edit clears the secrets: the form was rendered from a redacted read,
    // so a PUT that faithfully echoes what the operator saw carries no webhook URL.
    const stored = { webhookUrl: SLACK_SECRET, timeoutMs: 10_000 };
    const kept = notificationMethods.mergeSecrets('slack', { timeoutMs: 5_000 }, stored);
    assert.equal(kept['webhookUrl'], SLACK_SECRET);

    const cleared = notificationMethods.mergeSecrets(
      'slack',
      { webhookUrl: null, timeoutMs: 5_000 },
      stored,
    );
    assert.equal(cleared['webhookUrl'], null, 'an explicit null is an instruction, not an absence');
  });

  it('refuses a schema that hides a secret where the redactor cannot reach it', () => {
    // The rule `SensorCatalogue` enforces, enforced here too and at the same moment: a
    // `writeOnly` under a combinator is a secret that quietly comes back, so building the
    // registry fails rather than the credential leaking at some later read.
    assert.throws(
      () =>
        new MethodRegistry([
          {
            id: 'bad',
            name: 'Bad',
            description: '',
            usesRecipients: false,
            summarisable: false,
            settingsSchema: {
              type: 'object',
              oneOf: [{ properties: { token: { type: 'string', writeOnly: true } } }],
            },
            describe: () => '',
          },
        ]),
      /writeOnly inside a schema combinator/,
    );
  });

  it('accepts the same secret hoisted to a plain property', () => {
    // The remedy the error names, so the guard is a signpost rather than a wall.
    const registry = new MethodRegistry([
      {
        id: 'fine',
        name: 'Fine',
        description: '',
        usesRecipients: false,
        summarisable: false,
        settingsSchema: {
          type: 'object',
          properties: { token: { type: 'string', writeOnly: true } },
        },
        describe: () => '',
      },
    ]);
    assert.deepEqual(registry.secretsOf('fine'), ['token']);
  });
});

// -------------------------------------------------------------------------------------------
// Storage, and the one place secrets are removed.
// -------------------------------------------------------------------------------------------

describe('templates', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let h: Harness;
  let app: FastifyInstance;
  let templates: TemplateService;
  let triggers: TriggerService;
  let deviceId: number;
  let audited: Mutation[];

  before(async () => {
    scratch = await createScratchDatabase('templates');
    db = scratch.db;
    h = await buildHarness(db);

    audited = [];
    templates = new TemplateService({
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
    });
    triggers = new TriggerService({ db, audit: new DatabaseAuditSink(), logger: silent });

    const server = new ApiServer({
      config: { host: '127.0.0.1', port: 0, webRoot: '' },
      logger: silent,
      version: '9.9.9',
      service: h.service,
      history: new HistoryService({ db, logger: silent }),
      db,
      audit: new AuditRepository(),
      catalogue: testCatalogue(),
      templates,
      triggers,
    });
    await server.build('9.9.9', h.service);
    app = server.app;
  });

  after(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM notification_trigger');
    await db.query('DELETE FROM notification_template');
    await db.query(`DELETE FROM object WHERE kind = 'probe'`);
    await db.query('DELETE FROM audit_log');
    audited.length = 0;

    const probe = await h.service.create(testActor, {
      kind: 'probe',
      parentId: h.rootId,
      name: `probe-${String(process.hrtime.bigint())}`,
    });
    deviceId = (
      await h.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'device',
        host: '192.0.2.70',
      })
    ).id;
  });

  async function slackTemplate(name = 'On-call'): Promise<number> {
    const created = await templates.create(testActor, {
      name,
      method: 'slack',
      settings: { webhookUrl: SLACK_SECRET },
      subject: '%sensor is %status',
      body: '%device / %sensor: %lastmessage',
    });
    return created.id;
  }

  it('stores a template with its method’s defaults filled in', async () => {
    const created = await templates.create(testActor, {
      name: 'Ops mail',
      method: 'email',
      settings: {},
      recipients: [{ kind: 'address', value: 'ops@example.test' }],
    });
    assert.equal(created.method, 'email');
    assert.equal(created.methodName, 'Email');
    assert.equal(created.settings['format'], 'plain');
    assert.equal(created.priority, 3, 'normal until somebody says otherwise');
    assert.equal(created.enabled, true);
    assert.equal(created.summarisable, true);
  });

  it('never returns a secret, from create, read or list', async () => {
    const created = await templates.create(testActor, {
      name: 'On-call',
      method: 'slack',
      settings: { webhookUrl: SLACK_SECRET },
    });
    for (const view of [created, await templates.get(created.id), (await templates.list())[0]]) {
      assert.ok(view !== undefined);
      assert.deepEqual(view.redactedSettings, ['webhookUrl']);
      assert.ok(
        !JSON.stringify(view).includes('xoxb'),
        'the secret reached a caller through one of the read paths',
      );
    }
  });

  it('keeps the secret where the delivery code can still find it', async () => {
    // Redaction is a property of the *read*, not of the storage: N-07 has to be able to post to
    // the URL, and a system that redacted on the way in would have nothing to send with.
    const id = await slackTemplate();
    const rows = await db.query<{ settings: Record<string, unknown> }>(
      'SELECT settings FROM notification_template WHERE id = $1',
      [id],
    );
    assert.equal(rows[0]?.settings['webhookUrl'] ?? null, SLACK_SECRET);
  });

  it('keeps a secret through an edit that does not resend it', async () => {
    // The failure this prevents is mundane and total: an operator fixes a typo in the subject
    // line and the template silently stops being able to deliver anything.
    const id = await slackTemplate();
    const updated = await templates.update(testActor, id, {
      name: 'On-call',
      method: 'slack',
      settings: { timeoutMs: 5_000 },
      subject: 'fixed the typo',
    });
    assert.equal(updated.subject, 'fixed the typo');
    assert.deepEqual(updated.redactedSettings, ['webhookUrl'], 'still set');

    const rows = await db.query<{ settings: Record<string, unknown> }>(
      'SELECT settings FROM notification_template WHERE id = $1',
      [id],
    );
    const stored = rows[0]?.settings ?? {};
    assert.equal(stored['webhookUrl'], SLACK_SECRET);
    assert.equal(stored['timeoutMs'], 5_000, 'and the edit landed');
  });

  it('does not carry a secret across a change of method', async () => {
    // A slack webhook URL is not a webhook template's secret headers. Merging across methods
    // would be carrying a credential into a schema that never asked for it.
    const id = await slackTemplate();
    const updated = await templates.update(testActor, id, {
      name: 'On-call',
      method: 'webhook',
      settings: { url: 'https://example.test/hook' },
    });
    assert.deepEqual(updated.redactedSettings, [], 'nothing secret is set on the new method');
    const rows = await db.query<{ settings: Record<string, unknown> }>(
      'SELECT settings FROM notification_template WHERE id = $1',
      [id],
    );
    assert.ok(!JSON.stringify(rows[0]?.settings).includes('xoxb'));
  });

  it('refuses recipients on a method that has none', async () => {
    await assert.rejects(
      () =>
        templates.create(testActor, {
          name: 'Wrong',
          method: 'slack',
          settings: { webhookUrl: SLACK_SECRET },
          recipients: [{ kind: 'address', value: 'ops@example.test' }],
        }),
      MethodError,
    );
  });

  it('refuses an address that is not one', async () => {
    await assert.rejects(
      () =>
        templates.create(testActor, {
          name: 'Wrong',
          method: 'email',
          settings: {},
          recipients: [{ kind: 'address', value: 'ops-at-example' }],
        }),
      MethodError,
    );
  });

  it('refuses two templates with the same name', async () => {
    await slackTemplate('On-call');
    await assert.rejects(() => slackTemplate('On-call'));
  });

  // ── used by, and deletion ──────────────────────────────────────────────────────────────

  it('says which triggers name it', async () => {
    const id = await slackTemplate();
    await triggers.create(testActor, deviceId, {
      kind: 'state',
      settings: { state: 'down', initialTemplateId: id, escalationTemplateId: id },
    });
    await triggers.create(testActor, deviceId, {
      kind: 'threshold',
      settings: { channelKey: 'rtt', condition: 'above', value: 80, triggerTemplateId: id },
    });
    // A trigger that names a *different* template must not appear.
    await triggers.create(testActor, deviceId, {
      kind: 'state',
      settings: { state: 'warning', initialTemplateId: id + 999 },
    });

    const uses = await templates.usedBy(id);
    assert.equal(uses.length, 2, 'once per trigger, not once per field');
    assert.deepEqual(uses.map((use) => use.triggerKind).sort(), ['state', 'threshold']);
    const [first] = uses;
    assert.ok(first !== undefined);
    assert.equal(first.objectId, deviceId);
    assert.equal(first.objectName, 'device');
  });

  it('refuses to delete a template a trigger still names, and says which', async () => {
    const id = await slackTemplate();
    await triggers.create(testActor, deviceId, {
      kind: 'state',
      settings: { state: 'down', initialTemplateId: id },
    });

    await assert.rejects(
      () => templates.delete(testActor, id),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const details = (error as { details?: { usedBy?: unknown[] } }).details;
        assert.equal(details?.usedBy?.length, 1, 'the operator is told what to fix');
        return true;
      },
    );
    assert.equal((await templates.list()).length, 1, 'and nothing was deleted');
  });

  it('deletes a template nothing names', async () => {
    const id = await slackTemplate();
    await templates.delete(testActor, id);
    assert.deepEqual(await templates.list(), []);
  });

  it('records every change in the audit log, without the settings', async () => {
    const id = await slackTemplate();
    await templates.update(testActor, id, {
      name: 'On-call (edited)',
      method: 'slack',
      settings: {},
    });
    await templates.delete(testActor, id);

    assert.deepEqual(
      audited.map((mutation) => mutation.action),
      ['template.created', 'template.updated', 'template.deleted'],
    );
    // An audit log is read by more people, kept for longer, and exported. It is the wrong place
    // to keep a copy of a credential no API will return.
    assert.ok(!JSON.stringify(audited).includes('xoxb'));

    const rows = await db.query<{ summary: Record<string, unknown>; diff: unknown }>(
      `SELECT summary, diff FROM audit_log WHERE action LIKE 'template.%' ORDER BY id`,
    );
    assert.equal(rows.length, 3);
    const [entry] = rows;
    assert.ok(entry !== undefined);
    assert.equal(entry.summary['method'], 'slack');
    assert.ok(!JSON.stringify(rows).includes('xoxb'));
  });

  // ── over HTTP ──────────────────────────────────────────────────────────────────────────

  it('serves the methods with the schema a form is built from', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/notification-methods' });
    assert.equal(response.statusCode, 200);
    const body = response.json<{
      items: { id: string; usesRecipients: boolean; settingsSchema: Record<string, unknown> }[];
    }>();
    assert.equal(body.items.length, 5);
    const slack = body.items.find((method) => method.id === 'slack');
    assert.ok(slack !== undefined);
    assert.equal(slack.usesRecipients, false);
    // The form has to know which field it must never render back — that is what `writeOnly` is.
    const properties = slack.settingsSchema['properties'] as Record<
      string,
      { writeOnly?: boolean }
    >;
    assert.equal(properties['webhookUrl']?.writeOnly, true);
  });

  it('never puts a secret on the wire, on any route that serves a template', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/templates',
      payload: {
        name: 'On-call',
        method: 'slack',
        settings: { webhookUrl: SLACK_SECRET },
        subject: '%sensor is %status',
      },
    });
    assert.equal(created.statusCode, 201);
    const id = created.json<{ id: number }>().id;

    const webhook = await app.inject({
      method: 'POST',
      url: '/api/v1/templates',
      payload: {
        name: 'Pager',
        method: 'webhook',
        settings: {
          url: 'https://example.test/hook',
          secretHeaders: { authorization: BEARER },
        },
      },
    });
    assert.equal(webhook.statusCode, 201);

    for (const url of [
      '/api/v1/templates',
      `/api/v1/templates/${String(id)}`,
      `/api/v1/templates/${String(id)}/used-by`,
      '/api/v1/openapi.json',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200, url);
      // The raw body, not the parsed object: a secret that escaped through a field nobody
      // thought to check is still a string in the payload.
      assert.ok(!response.body.includes('xoxb'), `${url} leaked the Slack webhook URL`);
      assert.ok(!response.body.includes('do-not-leak'), `${url} leaked a secret header`);
    }

    // And the edit path, which is the one that hands a secret back by echoing the request.
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/templates/${String(id)}`,
      payload: { name: 'On-call', method: 'slack', settings: { webhookUrl: SLACK_SECRET } },
    });
    assert.equal(updated.statusCode, 200);
    assert.ok(!updated.body.includes('xoxb'), 'the update echoed the secret straight back');
  });

  it('reports bad settings as the caller’s mistake, naming the field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/templates',
      payload: { name: 'Broken', method: 'slack', settings: {} },
    });
    assert.equal(response.statusCode, 400);
    const body = response.json<{ error: { code: string; details: { problems: string[] } } }>();
    assert.equal(body.error.code, 'TEMPLATE_INVALID');
    assert.ok(body.error.details.problems.length > 0);
  });

  it('404s for a template that is not there', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/templates/999999' });
    assert.equal(response.statusCode, 404);
  });

  it('refuses the delete over HTTP too, with the list', async () => {
    const id = await slackTemplate();
    await triggers.create(testActor, deviceId, {
      kind: 'state',
      settings: { state: 'down', initialTemplateId: id },
    });
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/templates/${String(id)}`,
    });
    assert.equal(response.statusCode, 409, 'the request is fine; the state of the world refuses');
    const body = response.json<{ error: { details: { usedBy: unknown[] } } }>();
    assert.equal(body.error.details.usedBy.length, 1);
  });
});
