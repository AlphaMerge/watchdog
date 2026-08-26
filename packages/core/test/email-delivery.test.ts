import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { SmtpConfig, SmtpRelay } from '@ms/shared';
import { DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { MessageContextLoader } from '../src/notifications/context.js';
import { EmailTransport } from '../src/notifications/delivery/email.js';
import { DeliveryLoop } from '../src/notifications/delivery/loop.js';
import { headerSafe, type OutgoingMessage } from '../src/notifications/delivery/transport.js';
import { NotificationDispatcher } from '../src/notifications/dispatcher.js';
import { TemplateService } from '../src/notifications/templates.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { messageContext } from './support/messages.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/** MailHog, from `docker-compose.dev.yml`. Absent on a host that only started PostgreSQL. */
const MAILHOG_HOST = process.env['MS_TEST_MAILHOG_HOST'] ?? 'mailhog';
const MAILHOG_API = `http://${MAILHOG_HOST}:8025/api/v2`;

async function mailhogAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${MAILHOG_API}/messages?limit=1`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const mailhog = available ? await mailhogAvailable() : false;

function relay(overrides: Partial<SmtpRelay> = {}): SmtpRelay {
  return {
    host: MAILHOG_HOST,
    port: 1025,
    // MailHog speaks no TLS at all, which is exactly the localhost-relay case `none` exists for.
    security: 'none',
    verifyCertificate: true,
    auth: 'none',
    user: '',
    password: '',
    heloName: 'ms-core.test',
    timeoutMs: 5_000,
    ...overrides,
  };
}

function smtp(overrides: Partial<SmtpConfig> = {}): SmtpConfig {
  return {
    sender: 'monitoring@example.test',
    primary: relay(),
    fallback: relay({ host: '' }),
    ...overrides,
  };
}

function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    requestId: 1,
    sensorId: 2,
    subject: 'Ping on edge-router is down',
    body: 'no ICMP reply from 192.0.2.7',
    recipients: [{ kind: 'address', value: 'ops@example.test' }],
    priority: 3,
    settings: { format: 'plain', senderOverride: null },
    context: messageContext(),
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------
// Header safety, which is the part an attacker would reach.
// -------------------------------------------------------------------------------------------

describe('header sanitisation', () => {
  it('removes anything that could end a header line', () => {
    // A subject is built from a sensor's name and a probe's own message, and neither is under
    // this system's control. `ETIMEDOUT\r\nBcc: someone@else` must not become a Bcc.
    assert.equal(headerSafe('ETIMEDOUT\r\nBcc: someone@else'), 'ETIMEDOUT Bcc: someone@else');
    assert.equal(headerSafe('two\nlines'), 'two lines');
    assert.equal(headerSafe('trailing\r\n'), 'trailing');
  });

  it('collapses rather than drops, so a two-line message still reads', () => {
    assert.equal(headerSafe('first\nsecond'), 'first second');
  });

  it('leaves an ordinary subject exactly as it is', () => {
    assert.equal(headerSafe('Ping on edge-router is down'), 'Ping on edge-router is down');
  });
});

// -------------------------------------------------------------------------------------------
// The transport, with a relay that answers however the test needs.
// -------------------------------------------------------------------------------------------

describe('the email transport', () => {
  /** A stand-in relay. Records what it was asked to send, and fails on demand. */
  function stub(failures: Record<string, { code?: number; message: string } | undefined> = {}) {
    const sent: { relay: string; mail: Record<string, unknown> }[] = [];
    const build = (built: SmtpRelay): never =>
      ({
        sendMail: (mail: Record<string, unknown>) => {
          const name = built.host;
          const failure = failures[name];
          if (failure !== undefined) {
            const error = Object.assign(new Error(failure.message), {
              responseCode: failure.code,
              command: 'DATA',
            });
            return Promise.reject(error);
          }
          sent.push({ relay: name, mail });
          return Promise.resolve({ messageId: `<${name}>` });
        },
        close: () => undefined,
      }) as never;
    return { sent, build };
  }

  it('refuses to send when no relay is configured, and does not retry', async () => {
    const transport = new EmailTransport({
      config: smtp({ primary: relay({ host: '' }) }),
      logger: silent,
    });
    assert.equal(transport.configured, false);
    const result = await transport.send(message());
    // `assert.ok` narrows the union, so the failure fields below need no second guard.
    assert.ok(!result.ok);
    assert.equal(result.retryable, false, 'no amount of waiting configures a relay');
    assert.ok(result.error.includes('notifications.smtp.primary.host'));
  });

  it('refuses a template with no addresses, and says which recipients it could not resolve', async () => {
    const { build } = stub();
    const transport = new EmailTransport({ config: smtp(), logger: silent, build });
    const result = await transport.send(
      message({ recipients: [{ kind: 'user', value: 'alice' }] }),
    );
    assert.ok(!result.ok);
    assert.ok(result.error.includes('accounts'), result.error);
    assert.equal(result.retryable, false);
  });

  it('sends through the primary relay', async () => {
    const { sent, build } = stub();
    const transport = new EmailTransport({ config: smtp(), logger: silent, build });
    const result = await transport.send(message());
    assert.ok(result.ok);
    assert.equal(sent.length, 1);
    const [first] = sent;
    assert.ok(first !== undefined);
    assert.equal(first.mail['from'], 'monitoring@example.test');
    assert.deepEqual(first.mail['to'], ['ops@example.test']);
    assert.equal(first.mail['subject'], 'Ping on edge-router is down');
    assert.equal(first.mail['text'], 'no ICMP reply from 192.0.2.7');
  });

  it('falls back to the second relay when the first fails', async () => {
    // Paessler's own advice is two delivery paths per trigger; this is the cheaper half. One
    // relay going down must not silence an installation.
    const { sent, build } = stub({ [MAILHOG_HOST]: { code: 421, message: 'service unavailable' } });
    const transport = new EmailTransport({
      config: smtp({ fallback: relay({ host: 'backup.test' }) }),
      logger: silent,
      build,
    });
    const result = await transport.send(message());
    assert.ok(result.ok);
    assert.equal(sent.length, 1);
    assert.equal(sent.at(0)?.relay, 'backup.test');
  });

  it('reports every relay’s reason when they all fail', async () => {
    // "timed out" on its own sends somebody to look at the wrong machine.
    const { build } = stub({
      [MAILHOG_HOST]: { code: 550, message: 'no such user' },
      'backup.test': { code: 421, message: 'service unavailable' },
    });
    const transport = new EmailTransport({
      config: smtp({ fallback: relay({ host: 'backup.test' }) }),
      logger: silent,
      build,
    });
    const result = await transport.send(message());
    assert.ok(!result.ok);
    assert.ok(result.error.includes('primary: 550'), result.error);
    assert.ok(result.error.includes('fallback: 421'));
    // One permanent rejection does not make the whole thing permanent: the fallback's 421 might
    // work later, so the message is worth trying again.
    assert.equal(result.retryable, true);
  });

  it('treats a 5xx as permanent and a 4xx as worth retrying', async () => {
    // SMTP already answers this, which is why the protocol has two failure classes.
    for (const [code, retryable] of [
      [421, true],
      [450, true],
      [550, false],
      [552, false],
    ] as const) {
      const { build } = stub({ [MAILHOG_HOST]: { code, message: 'refused' } });
      const transport = new EmailTransport({ config: smtp(), logger: silent, build });
      const result = await transport.send(message());
      assert.ok(!result.ok);
      assert.equal(result.retryable, retryable, String(code));
    }
  });

  it('treats a connection failure with no code as worth retrying', async () => {
    const { build } = stub({ [MAILHOG_HOST]: { message: 'ECONNREFUSED' } });
    const transport = new EmailTransport({ config: smtp(), logger: silent, build });
    const result = await transport.send(message());
    assert.ok(!result.ok);
    assert.equal(result.retryable, true);
  });

  it('sends HTML when the template asks for it', async () => {
    const { sent, build } = stub();
    const transport = new EmailTransport({ config: smtp(), logger: silent, build });
    await transport.send(message({ settings: { format: 'html' }, body: '<b>down</b>' }));
    assert.equal(sent.at(0)?.mail['html'], '<b>down</b>');
    assert.equal(sent.at(0)?.mail['text'], undefined);
  });

  it('honours a template’s sender override', async () => {
    const { sent, build } = stub();
    const transport = new EmailTransport({ config: smtp(), logger: silent, build });
    await transport.send(message({ settings: { senderOverride: 'noc@example.test' } }));
    assert.equal(sent.at(0)?.mail['from'], 'noc@example.test');
  });

  it('strips a newline out of every header it builds', async () => {
    const { sent, build } = stub();
    const transport = new EmailTransport({ config: smtp(), logger: silent, build });
    await transport.send(
      message({
        subject: 'down\r\nBcc: someone@else',
        recipients: [{ kind: 'address', value: 'ops@example.test\r\nBcc: x@y' }],
        settings: { senderOverride: 'noc@example.test\r\nX: y' },
      }),
    );
    const mail = sent.at(0)?.mail ?? {};
    assert.ok(!JSON.stringify(mail['subject']).includes('\\r'));
    assert.ok(!JSON.stringify(mail['to']).includes('\\r'));
    assert.ok(!JSON.stringify(mail['from']).includes('\\r'));
  });

  it('carries the priority and the request id in headers', async () => {
    const { sent, build } = stub();
    const transport = new EmailTransport({ config: smtp(), logger: silent, build });
    await transport.send(message({ priority: 1, requestId: 77, sensorId: 88 }));
    const headers = sent.at(0)?.mail['headers'] as Record<string, string>;
    assert.equal(headers['X-Priority'], '1');
    assert.equal(headers['Importance'], 'high');
    // The only way to answer "did this alarm go out" from the mail side.
    assert.equal(headers['X-MS-Request'], '77');
    assert.equal(headers['X-MS-Sensor'], '88');
  });
});

// -------------------------------------------------------------------------------------------
// The dispatcher, against a real queue.
// -------------------------------------------------------------------------------------------

describe(
  'notification delivery',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let templates: TemplateService;
    let contexts: MessageContextLoader;
    let sensorId: number;

    before(async () => {
      scratch = await createScratchDatabase('emaildelivery');
      db = scratch.db;
      h = await buildHarness(db, { states: true });
      contexts = new MessageContextLoader({
        settings: h.resolver,
        publicUrl: 'https://monitoring.example.test',
        siteName: 'Acme production',
      });
      templates = new TemplateService({
        db,
        audit: new DatabaseAuditSink(),
        logger: silent,
        contexts,
      });
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM notification_request');
      await db.query('DELETE FROM notification_template');
      await db.query(`DELETE FROM object WHERE kind = 'probe'`);

      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: 'Local probe',
      });
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'edge-router',
        host: '192.0.2.7',
      });
      sensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: device.id,
          name: 'Ping',
          sensorType: 'icmp.ping',
        })
      ).id;

      // Down, so a message has something true to say.
      const states = h.states;
      assert.ok(states !== undefined);
      const base = new Date(Date.now() - 600_000);
      for (const offset of [0, 60_000]) {
        const when = new Date(base.getTime() + offset);
        const results: SensorResult[] = [
          { sensorId, at: when, outcome: 'error', message: 'no ICMP reply from 192.0.2.7' },
        ];
        const decisions = await states.decide(results);
        await db.tx(async (q) => {
          await writeStateHistory(q, decisions.transitions);
          await writeRuntimes(q, decisions.runtimes);
        });
      }
    });

    async function emailTemplate(overrides: Record<string, unknown> = {}): Promise<number> {
      const created = await templates.create(testActor, {
        name: `On-call-${String(process.hrtime.bigint())}`,
        method: 'email',
        settings: {},
        subject: '%sitename: %sensor on %device is %status',
        body: '%lastmessage — %linksensor',
        recipients: [{ kind: 'address', value: 'ops@example.test' }],
        ...overrides,
      });
      return created.id;
    }

    async function queue(templateId: number | null): Promise<number> {
      const rows = await db.query<{ id: string }>(
        `INSERT INTO notification_request
           (at, sensor_id, trigger_id, trigger_kind, template_id, reason, state, message)
         VALUES (now(), $1, NULL, 'state', $2, 'initial', 'down', 'no ICMP reply from 192.0.2.7')
         RETURNING id::text AS id`,
        [sensorId, templateId],
      );
      return Number(rows[0]?.id ?? 0);
    }

    async function statusOf(
      id: number,
    ): Promise<{ status: string; attempts: number; error: string | null; delivered: Date | null }> {
      const rows = await db.query<{
        status: string;
        attempts: number;
        last_error: string | null;
        delivered_at: Date | null;
      }>(
        'SELECT status, attempts, last_error, delivered_at FROM notification_request WHERE id = $1',
        [id],
      );
      const row = rows[0];
      assert.ok(row !== undefined);
      return {
        status: row.status,
        attempts: row.attempts,
        error: row.last_error,
        delivered: row.delivered_at,
      };
    }

    /** A transport that records what it was given and answers however the test needs. */
    function recorder(answer: () => { ok: true } | { ok: false; retryable: boolean }) {
      const seen: OutgoingMessage[] = [];
      return {
        seen,
        transport: {
          method: 'email',
          send: (outgoing: OutgoingMessage) => {
            seen.push(outgoing);
            const decided = answer();
            return Promise.resolve(
              decided.ok
                ? ({ ok: true, detail: 'test' } as const)
                : ({ ok: false, retryable: decided.retryable, error: 'refused' } as const),
            );
          },
        },
      };
    }

    function dispatcherWith(
      transport: { method: string; send: (m: OutgoingMessage) => Promise<never> } | object,
      options: { retryDelayMs?: number; maxAttempts?: number } = {},
    ): NotificationDispatcher {
      return new NotificationDispatcher({
        db,
        logger: silent,
        contexts,
        transports: [transport as never],
        retryDelayMs: options.retryDelayMs ?? 0,
        maxAttempts: options.maxAttempts ?? 5,
      });
    }

    it('renders the template and marks the request sent', async () => {
      const templateId = await emailTemplate();
      const requestId = await queue(templateId);
      const { seen, transport } = recorder(() => ({ ok: true }));

      assert.equal(await dispatcherWith(transport).dispatch(), 1);
      assert.equal(seen.length, 1);
      const [only] = seen;
      assert.ok(only !== undefined);
      assert.equal(only.subject, 'Acme production: Ping on edge-router is down');
      assert.equal(
        only.body,
        `no ICMP reply from 192.0.2.7 — https://monitoring.example.test/objects/${String(sensorId)}`,
      );
      assert.deepEqual(only.recipients, [{ kind: 'address', value: 'ops@example.test' }]);

      const after = await statusOf(requestId);
      assert.equal(after.status, 'sent');
      assert.equal(after.attempts, 1);
      assert.ok(after.delivered !== null, 'and records when, which is not when it fell due');
    });

    it('does not send the same request twice', async () => {
      const templateId = await emailTemplate();
      await queue(templateId);
      const { seen, transport } = recorder(() => ({ ok: true }));
      const dispatcher = dispatcherWith(transport);

      await dispatcher.dispatch();
      await dispatcher.dispatch();
      assert.equal(seen.length, 1);
    });

    it('retries a transient failure and records why', async () => {
      const templateId = await emailTemplate();
      const requestId = await queue(templateId);
      let attempt = 0;
      const { transport } = recorder(() => {
        attempt += 1;
        return attempt === 1 ? { ok: false, retryable: true } : { ok: true };
      });
      const dispatcher = dispatcherWith(transport);

      await dispatcher.dispatch();
      const first = await statusOf(requestId);
      assert.equal(first.status, 'pending', 'still owed');
      assert.equal(first.attempts, 1);
      assert.equal(first.error, 'refused');

      await dispatcher.dispatch();
      assert.equal((await statusOf(requestId)).status, 'sent');
      // The error is cleared on success: a delivered message with a failure attached to it is a
      // row that reads as broken.
      assert.equal((await statusOf(requestId)).error, null);
    });

    it('gives up at once on a failure no waiting fixes', async () => {
      const templateId = await emailTemplate();
      const requestId = await queue(templateId);
      const { transport } = recorder(() => ({ ok: false, retryable: false }));

      await dispatcherWith(transport).dispatch();
      const after = await statusOf(requestId);
      assert.equal(after.status, 'failed');
      assert.equal(after.attempts, 1, 'once, not five times');
    });

    it('gives up after the attempt bound, so nothing sits in the queue for ever', async () => {
      const templateId = await emailTemplate();
      const requestId = await queue(templateId);
      const { transport } = recorder(() => ({ ok: false, retryable: true }));
      const dispatcher = dispatcherWith(transport, { maxAttempts: 3 });

      for (let round = 0; round < 4; round += 1) await dispatcher.dispatch();
      const after = await statusOf(requestId);
      assert.equal(after.status, 'failed');
      assert.equal(after.attempts, 3);
    });

    it('fails a request whose template is gone, rather than queueing it for ever', async () => {
      // Migration 018 deliberately has no foreign key here: a trigger names its templates inside
      // a JSON document, so it can name one that does not exist, and the obligation is recorded
      // rather than lost. This is where an operator finds out.
      const requestId = await queue(999_999);
      const { transport } = recorder(() => ({ ok: true }));

      await dispatcherWith(transport).dispatch();
      const after = await statusOf(requestId);
      assert.equal(after.status, 'failed');
      assert.ok(after.error?.includes('no transport'), after.error ?? '');
    });

    it('leaves a request queued when its method has no transport yet', async () => {
      // N-08 to N-10 are days away, and marking these undeliverable would throw away real
      // obligations. They wait, and they are counted so somebody can see them waiting.
      const templateId = await templates.create(testActor, {
        name: 'Pager',
        method: 'webhook',
        settings: { url: 'https://example.test/hook' },
        subject: '%sensor',
      });
      const requestId = await queue(templateId.id);
      const { seen, transport } = recorder(() => ({ ok: true }));
      const dispatcher = dispatcherWith(transport);

      assert.equal(await dispatcher.dispatch(), 0);
      assert.equal(seen.length, 0);
      assert.equal((await statusOf(requestId)).status, 'pending');
      assert.equal((await statusOf(requestId)).attempts, 0, 'not even counted as an attempt');
      assert.equal(dispatcher.stats.awaiting, 1);
    });

    it('leaves a request queued while its template is switched off', async () => {
      // CAPABILITIES.MD §5.2's activation schedules make "collect and send when reactivated" a
      // first-class choice (N-12); this is that behaviour arrived at early.
      const templateId = await emailTemplate({ enabled: false });
      const requestId = await queue(templateId);
      const { transport } = recorder(() => ({ ok: true }));
      const dispatcher = dispatcherWith(transport);

      assert.equal(await dispatcher.dispatch(), 0);
      assert.equal((await statusOf(requestId)).status, 'pending');
      assert.equal(dispatcher.stats.awaiting, 1);
    });

    it('counts what it did, for Core Health', async () => {
      const templateId = await emailTemplate();
      await queue(templateId);
      await queue(templateId);
      const { transport } = recorder(() => ({ ok: true }));
      const dispatcher = dispatcherWith(transport);
      await dispatcher.dispatch();
      assert.equal(dispatcher.stats.sent, 2);
      assert.equal(dispatcher.stats.failed, 0);
    });

    it('drains a backlog through the loop rather than one batch per tick', async () => {
      const templateId = await emailTemplate();
      for (let index = 0; index < 7; index += 1) await queue(templateId);
      const { seen, transport } = recorder(() => ({ ok: true }));
      const dispatcher = new NotificationDispatcher({
        db,
        logger: silent,
        contexts,
        transports: [transport],
        batchSize: 2,
      });

      const loop = new DeliveryLoop({ dispatcher, logger: silent });
      const attempted = await loop.run();
      assert.equal(attempted, 7, 'all of them, in one pass');
      assert.equal(seen.length, 7);
    });

    it('is woken by something being queued', async () => {
      const templateId = await emailTemplate();
      const { seen, transport } = recorder(() => ({ ok: true }));
      const dispatcher = dispatcherWith(transport);
      const loop = new DeliveryLoop({ dispatcher, logger: silent, idleMs: 60_000, busyMs: 10 });
      loop.start();
      try {
        await sleep(60);
        await queue(templateId);
        loop.wake();
        for (let round = 0; round < 100 && seen.length === 0; round += 1) await sleep(20);
        assert.equal(seen.length, 1, 'the wake is what sent it, not the idle heartbeat');
      } finally {
        loop.stop();
      }
    });

    // -----------------------------------------------------------------------------------
    // The real thing.
    // -----------------------------------------------------------------------------------

    it(
      'delivers to a real SMTP relay',
      { skip: mailhog ? false : 'no MailHog reachable (start docker-compose.dev.yml)' },
      async () => {
        // PLAN.md's Phase 4 exit criterion is verified against MailHog, and this is the piece it
        // rests on: a real ESMTP conversation, not a stub agreeing with itself.
        const address = `ops-${String(process.hrtime.bigint())}@example.test`;
        const templateId = await emailTemplate({
          recipients: [{ kind: 'address', value: address }],
        });
        const requestId = await queue(templateId);

        const transport = new EmailTransport({ config: smtp(), logger: silent });
        const dispatcher = new NotificationDispatcher({
          db,
          logger: silent,
          contexts,
          transports: [transport],
        });
        try {
          // Dispatched until it lands, rather than once. MailHog is a small Go binary sharing a
          // container host with a dozen test files, and it drops the occasional connection under
          // that load — which the transport correctly reports as retryable. Asserting a
          // first-attempt success would be asserting that the relay was not busy.
          let delivered = await statusOf(requestId);
          for (let attempt = 0; attempt < 5 && delivered.status !== 'sent'; attempt += 1) {
            await dispatcher.dispatch();
            delivered = await statusOf(requestId);
          }
          assert.equal(delivered.status, 'sent', delivered.error ?? 'no error recorded');

          const response = await fetch(`${MAILHOG_API}/search?kind=to&query=${address}`, {
            signal: AbortSignal.timeout(5_000),
          });
          assert.ok(response.ok);
          const found = (await response.json()) as {
            total: number;
            items: { Content: { Headers: Record<string, string[]>; Body: string } }[];
          };
          assert.equal(found.total, 1, 'exactly one message reached the relay');

          const item = found.items[0];
          assert.ok(item !== undefined);
          // Case-insensitively: MIME header names are, and MailHog canonicalises them the way
          // Go's textproto does, so `X-MS-Request` comes back as `X-Ms-Request`.
          const header = (name: string): string | undefined => {
            const key = Object.keys(item.Content.Headers).find(
              (candidate) => candidate.toLowerCase() === name.toLowerCase(),
            );
            return key === undefined ? undefined : item.Content.Headers[key]?.[0];
          };
          assert.equal(header('Subject'), 'Acme production: Ping on edge-router is down');
          assert.equal(header('From'), 'monitoring@example.test');
          assert.equal(header('To'), address);
          assert.equal(header('X-MS-Request'), String(requestId));
          assert.equal(header('X-Priority'), '3');
          assert.ok(item.Content.Body.includes('no ICMP reply from 192.0.2.7'));
          assert.ok(item.Content.Body.includes(`/objects/${String(sensorId)}`));
        } finally {
          await transport.close();
        }
      },
    );

    it(
      'reports a refused connection as a transient failure',
      { skip: mailhog ? false : 'no MailHog reachable (start docker-compose.dev.yml)' },
      async () => {
        // A real socket refusing a real connection, rather than a stub throwing a made-up error.
        const transport = new EmailTransport({
          config: smtp({ primary: relay({ port: 1 }) }),
          logger: silent,
        });
        try {
          const result = await transport.send(message());
          assert.ok(!result.ok);
          assert.equal(result.retryable, true, 'a relay that is down comes back');
        } finally {
          await transport.close();
        }
      },
    );
  },
);
