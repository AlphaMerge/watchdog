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
import { Visibility } from '../src/auth/access.js';

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

  it('refuses a secret header Node would not send, naming it and never its value (N-19)', () => {
    // Accepted before, and then every delivery failed on it, retried, and gave up.
    const refusal = (secretHeaders: Record<string, string>): string => {
      try {
        notificationMethods.validate('webhook', {
          url: 'https://example.test/hook',
          secretHeaders,
        });
      } catch (error: unknown) {
        assert.ok(error instanceof MethodError);
        return [error.message, ...error.details.problems].join('\n');
      }
      return assert.fail('it was accepted');
    };
    const script = refusal({ 'x-token': 'Bearer Київ-s3cret' });
    assert.match(script, /\/secretHeaders\/x-token cannot be sent as a header value/u);
    assert.doesNotMatch(script, /s3cret|Київ/u);
    const broken = refusal({ 'x-token': 'Bearer s3cret\r\nBcc: someone@else' });
    assert.match(broken, /\/secretHeaders\/x-token cannot be sent as a header value/u);
    assert.doesNotMatch(broken, /s3cret/u);
    const name = refusal({ 'Bad Name': 's3cret' });
    assert.match(name, /\/secretHeaders "Bad Name" is not a header name/u);
    assert.doesNotMatch(name, /s3cret/u);

    // What Node does send is still accepted: every token character, a tab and Latin-1.
    notificationMethods.validate('webhook', {
      url: 'https://example.test/hook',
      secretHeaders: { "x!#$%&'*+.^_`|~-09AZaz": 'café\tþ' },
    });
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

  describe('a secret stays with where it is sent (A-40)', () => {
    const HOOK = 'https://hooks.example.test/pager';
    const stored = {
      url: HOOK,
      verb: 'POST',
      secretHeaders: { authorization: BEARER },
      timeoutMs: 10_000,
    };

    it('keeps it through an edit that leaves the destination alone', () => {
      const merged = notificationMethods.mergeSecrets(
        'webhook',
        { url: HOOK, verb: 'PUT' },
        stored,
      );
      assert.deepEqual(merged['secretHeaders'], { authorization: BEARER });
      assert.deepEqual(notificationMethods.secretsLeftBehind('webhook', { url: HOOK }, stored), []);
    });

    it('leaves it behind when the edit points the webhook somewhere else', () => {
      // The attack: somebody who may edit the template but never saw the token points it at a
      // host of their own and presses "test".
      for (const url of [
        'https://collector.attacker.test/pager',
        'https://hooks.example.test/elsewhere',
        'https://hooks.example.test/pager?copy=1',
        'http://hooks.example.test/pager',
      ]) {
        const merged = notificationMethods.mergeSecrets('webhook', { url }, stored);
        assert.equal(merged['secretHeaders'], undefined, url);
        assert.deepEqual(
          notificationMethods.secretsLeftBehind('webhook', { url }, stored),
          ['secretHeaders'],
          url,
        );
      }
    });

    it('keeps what the same edit sends again, since its sender has it', () => {
      const incoming = {
        url: 'https://collector.example.test/new',
        secretHeaders: { authorization: 'Bearer typed-again' },
      };
      const merged = notificationMethods.mergeSecrets('webhook', incoming, stored);
      assert.deepEqual(merged['secretHeaders'], { authorization: 'Bearer typed-again' });
      assert.deepEqual(notificationMethods.secretsLeftBehind('webhook', incoming, stored), []);
    });

    it('reads a URL as the address it is, not as the characters typed', () => {
      const merged = notificationMethods.mergeSecrets(
        'webhook',
        { url: 'HTTPS://Hooks.Example.test/pager' },
        stored,
      );
      assert.deepEqual(merged['secretHeaders'], { authorization: BEARER });
    });

    it('binds a program’s secret arguments to the program', () => {
      const program = { path: 'page.sh', secretArgs: ['--token=s3cret'] };
      const same = notificationMethods.mergeSecrets('program', { path: 'page.sh' }, program);
      assert.deepEqual(same['secretArgs'], ['--token=s3cret']);
      const other = notificationMethods.mergeSecrets('program', { path: 'log-args.sh' }, program);
      assert.equal(other['secretArgs'], undefined);
    });

    describe('and a program’s visible arguments are where its secret ones go (A-48)', () => {
      const GATEWAY = ['--gateway', 'https://sms.example.test/api'];
      const sms = { path: 'sms.sh', args: GATEWAY, secretArgs: ['--key', 'do-not-leak'] };

      it('leaves them behind when an edit changes the arguments and not the program', () => {
        // The attack A-40 closed for the path, through the arguments instead: the program stays
        // `sms.sh`, and the gateway it is told to post the key to becomes somebody's own.
        for (const args of [
          ['--gateway', 'https://collector.attacker.test/api'],
          ['--gateway', 'https://sms.example.test/api', '--copy-to', 'https://attacker.test/'],
          ['https://sms.example.test/api', '--gateway'],
          [],
        ]) {
          const incoming = { path: 'sms.sh', args };
          const merged = notificationMethods.mergeSecrets('program', incoming, sms);
          assert.equal(merged['secretArgs'], undefined, JSON.stringify(args));
          assert.deepEqual(
            notificationMethods.secretsLeftBehind('program', incoming, sms),
            ['secretArgs'],
            JSON.stringify(args),
          );
        }
      });

      it('keeps them through an edit that leaves the command line as it was', () => {
        const incoming = { path: 'sms.sh', args: [...GATEWAY], timeoutMs: 5_000 };
        const merged = notificationMethods.mergeSecrets('program', incoming, sms);
        assert.deepEqual(merged['secretArgs'], ['--key', 'do-not-leak']);
        assert.deepEqual(notificationMethods.secretsLeftBehind('program', incoming, sms), []);
      });

      it('keeps what the same edit sends again', () => {
        const incoming = {
          path: 'sms.sh',
          args: ['--gateway', 'https://sms.example.test/v2'],
          secretArgs: ['--key', 'typed-again'],
        };
        const merged = notificationMethods.mergeSecrets('program', incoming, sms);
        assert.deepEqual(merged['secretArgs'], ['--key', 'typed-again']);
        assert.deepEqual(notificationMethods.secretsLeftBehind('program', incoming, sms), []);
      });

      it('reads arguments left out as none, which is what the save stores', () => {
        // Merged before validation fills the default in. A program saved with no arguments stores
        // `args: []`, and an edit that does not mention them has not changed them.
        const bare = { path: 'page.sh', args: [], secretArgs: ['--token=s3cret'] };
        const kept = notificationMethods.mergeSecrets('program', { path: 'page.sh' }, bare);
        assert.deepEqual(kept['secretArgs'], ['--token=s3cret']);
        assert.deepEqual(
          notificationMethods.secretsLeftBehind('program', { path: 'page.sh' }, bare),
          [],
        );
        // A row stored without the field reads the same way.
        const older = { path: 'page.sh', secretArgs: ['--token=s3cret'] };
        const echoed = notificationMethods.mergeSecrets(
          'program',
          { path: 'page.sh', args: [] },
          older,
        );
        assert.deepEqual(echoed['secretArgs'], ['--token=s3cret']);
        // And leaving out arguments that were set is saving none: a change.
        assert.deepEqual(
          notificationMethods.secretsLeftBehind('program', { path: 'sms.sh' }, sms),
          ['secretArgs'],
        );
      });
    });

    it('says nothing is left behind where nothing was set', () => {
      // A webhook with no secret headers loses nothing by moving, and an audit entry saying it
      // cleared an empty bag would invite somebody to go looking for a token that never existed.
      assert.deepEqual(
        notificationMethods.secretsLeftBehind(
          'webhook',
          { url: 'https://elsewhere.example.test/' },
          { url: HOOK, secretHeaders: {} },
        ),
        [],
      );
    });

    const method = (secretDestinations: Record<string, string[]>) => ({
      id: 'probe',
      name: 'Probe',
      description: '',
      usesRecipients: false,
      summarisable: false,
      placeholderFields: [],
      secretDestinations,
      settingsSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          token: { type: 'string', writeOnly: true },
          key: { type: 'string', writeOnly: true },
        },
      },
      describe: () => '',
    });

    it('refuses a method that stores a secret without saying where it goes', () => {
      assert.throws(
        () => new MethodRegistry([method({ token: ['url'] })]),
        /must say where each of its secrets is sent/,
      );
    });

    it('refuses a destination that is not a visible setting', () => {
      assert.throws(
        () => new MethodRegistry([method({ token: ['host'], key: [] })]),
        /sends "token" to "host", which is not a visible setting/,
      );
      assert.throws(
        () => new MethodRegistry([method({ token: ['key'], key: [] })]),
        /sends "token" to "key", which is not a visible setting/,
      );
    });
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
            placeholderFields: [],
            secretDestinations: {},
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
        placeholderFields: [],
        secretDestinations: { token: [] },
        settingsSchema: {
          type: 'object',
          properties: { token: { type: 'string', writeOnly: true } },
        },
        describe: () => '',
      },
    ]);
    assert.deepEqual(registry.secretsOf('fine'), ['token']);
  });

  it('refuses a mistyped keyword at load, which used to constrain nothing (P-379)', () => {
    const withSettings = (properties: Record<string, unknown>): MethodRegistry =>
      new MethodRegistry([
        {
          id: 'strict',
          name: 'Strict',
          description: '',
          usesRecipients: false,
          summarisable: false,
          placeholderFields: [],
          secretDestinations: {},
          settingsSchema: { type: 'object', properties },
          describe: () => '',
        },
      ]);
    assert.throws(
      () => withSettings({ url: { type: 'string', maxLenght: 10 } }),
      /unknown keyword: "maxLenght"/,
    );
    // Spelt right, it is taken.
    withSettings({ url: { type: 'string', maxLength: 10 } });
  });

  it('refuses a pattern with no sentence, and a sentence with no pattern (P-372)', () => {
    // As the sensor catalogue refuses one (`U-53`): `validate` says the sentence beside a pattern,
    // so a pattern without one would answer an operator with the expression.
    const withSettings = (properties: Record<string, unknown>): MethodRegistry =>
      new MethodRegistry([
        {
          id: 'patterned',
          name: 'Patterned',
          description: '',
          usesRecipients: false,
          summarisable: false,
          placeholderFields: [],
          secretDestinations: {},
          settingsSchema: { type: 'object', properties },
          describe: () => '',
        },
      ]);
    assert.throws(
      () => withSettings({ room: { type: 'string', pattern: '^#' } }),
      /method patterned gives "room" a pattern without x-patternMessage/,
    );
    assert.throws(
      () => withSettings({ tags: { type: 'object', propertyNames: { pattern: '^[a-z]+$' } } }),
      /method patterned gives "tags\.propertyNames" a pattern without x-patternMessage/,
    );
    assert.throws(
      () => withSettings({ room: { type: 'string', 'x-patternMessage': 'must start with #' } }),
      /method patterned gives "room" x-patternMessage without a pattern/,
    );
    const said = withSettings({
      room: { type: 'string', pattern: '^#', 'x-patternMessage': 'must start with #' },
    });
    assert.throws(
      () => said.validate('patterned', { room: 'general-SECRET' }),
      (error: unknown) => {
        assert.ok(error instanceof MethodError);
        assert.deepEqual(error.details.problems, ['/room must start with #']);
        return true;
      },
    );
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

  it('clears the secret headers of a webhook an edit re-points, and says so (A-40)', async () => {
    const created = await templates.create(testActor, {
      name: 'Pager',
      method: 'webhook',
      settings: {
        url: 'https://hooks.example.test/pager',
        secretHeaders: { authorization: BEARER },
      },
    });
    audited.length = 0;
    const updated = await templates.update(testActor, created.id, {
      name: 'Pager',
      method: 'webhook',
      settings: { url: 'https://collector.attacker.test/pager' },
    });
    assert.deepEqual(updated.redactedSettings, [], 'the form now shows them as not set');

    const rows = await db.query<{ settings: Record<string, unknown> }>(
      'SELECT settings FROM notification_template WHERE id = $1',
      [created.id],
    );
    assert.ok(!JSON.stringify(rows[0]?.settings).includes('do-not-leak'), 'gone from storage');

    const entry = audited.find((m) => m.action === 'template.updated');
    assert.ok(entry?.action === 'template.updated');
    assert.deepEqual(entry.secretsCleared, ['secretHeaders'], 'the history names what went');
    assert.ok(!JSON.stringify(entry).includes('do-not-leak'), 'by name, never by value');
  });

  it('clears the secret arguments of a program an edit gives new arguments, and says so (A-48)', async () => {
    const created = await templates.create(testActor, {
      name: 'SMS',
      method: 'program',
      settings: {
        path: 'sms.sh',
        args: ['--gateway', 'https://sms.example.test/api'],
        secretArgs: ['--key', 'do-not-leak'],
      },
    });
    const stored = async (): Promise<string> => {
      const rows = await db.query<{ settings: Record<string, unknown> }>(
        'SELECT settings FROM notification_template WHERE id = $1',
        [created.id],
      );
      return JSON.stringify(rows[0]?.settings);
    };

    // The form echoed back, with the subject fixed: the key stays, and nothing is cleared.
    audited.length = 0;
    const echoed = await templates.update(testActor, created.id, {
      name: 'SMS',
      method: 'program',
      settings: { path: 'sms.sh', args: ['--gateway', 'https://sms.example.test/api'] },
      subject: 'fixed the typo',
    });
    assert.deepEqual(echoed.redactedSettings, ['secretArgs'], 'still set');
    const kept = audited.find((m) => m.action === 'template.updated');
    assert.ok(kept?.action === 'template.updated');
    assert.equal(kept.secretsCleared, undefined);

    // The same program, pointed at another gateway.
    audited.length = 0;
    const moved = await templates.update(testActor, created.id, {
      name: 'SMS',
      method: 'program',
      settings: { path: 'sms.sh', args: ['--gateway', 'https://collector.attacker.test/api'] },
    });
    assert.deepEqual(moved.redactedSettings, [], 'the form now shows them as not set');
    assert.ok(!(await stored()).includes('do-not-leak'), 'gone from storage');

    const entry = audited.find((m) => m.action === 'template.updated');
    assert.ok(entry?.action === 'template.updated');
    assert.deepEqual(entry.secretsCleared, ['secretArgs'], 'the history names what went');
    assert.ok(!JSON.stringify(entry).includes('do-not-leak'), 'by name, never by value');
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

    const uses = await templates.usedBy(id, Visibility.EVERYTHING);
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
      () => templates.delete(testActor, id, Visibility.EVERYTHING),
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
    await templates.delete(testActor, id, Visibility.EVERYTHING);
    assert.deepEqual(await templates.list(), []);
  });

  it('records every change in the audit log, without the settings', async () => {
    const id = await slackTemplate();
    await templates.update(testActor, id, {
      name: 'On-call (edited)',
      method: 'slack',
      settings: {},
    });
    await templates.delete(testActor, id, Visibility.EVERYTHING);

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

    // The webhook's header sentences reach the form (`P-372`, `P-377`): the closed response
    // schema (`ms:notificationMethod`) keeps them, so the form says them as `validate` does.
    const webhook = body.items.find((method) => method.id === 'webhook');
    assert.ok(webhook !== undefined);
    const sentences = (schema: Record<string, unknown>): unknown[] => {
      const properties = schema['properties'] as Record<string, Record<string, unknown>>;
      const headers = properties['secretHeaders'] as Record<string, Record<string, unknown>>;
      return [
        headers['propertyNames']?.['x-patternMessage'],
        headers['additionalProperties']?.['x-patternMessage'],
      ];
    };
    const served = sentences(webhook.settingsSchema);
    assert.deepEqual(served, sentences(notificationMethods.get('webhook').settingsSchema));
    assert.match(String(served[0]), /is not a header name/u);
    assert.match(String(served[1]), /cannot be sent as a header value/u);
  });

  it('answers an unsendable secret header with a 400 that names it and not its value (N-19)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/templates',
      payload: {
        name: 'Pager',
        method: 'webhook',
        settings: {
          url: 'https://example.test/hook',
          secretHeaders: { 'x-token': 'Bearer Київ-do-not-leak' },
        },
      },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /x-token cannot be sent as a header value/u);
    assert.ok(!response.body.includes('do-not-leak'), 'the value came back');
    assert.ok(!response.body.includes('Київ'), 'part of the value came back');
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
