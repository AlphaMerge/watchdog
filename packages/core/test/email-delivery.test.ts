import { strict as assert } from 'node:assert';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecipientResolver } from '../src/notifications/recipients.js';
import { AccessService } from '../src/auth/access.js';
import { addressesOnly } from './support/recipients.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTransport, type SendMailOptions } from 'nodemailer';
import type { SmtpConfig, SmtpRelay } from '@ms/shared';
import { DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { MessageContextLoader } from '../src/notifications/context.js';
import { EmailTransport } from '../src/notifications/delivery/email.js';
import { DeliveryLoop } from '../src/notifications/delivery/loop.js';
import { ProgramTransport } from '../src/notifications/delivery/program.js';
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
    about: [2],
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
  function stub(
    failures: Record<string, { code?: number; message: string } | undefined> = {},
    /**
     * Addresses the relay accepts the message for and then refuses (`P-119`).
     *
     * `sendMail` **resolves** for a partial send and reports the refusals in `rejected`, which is
     * the case this stub could not express before — so every test here was about a relay that
     * either took everything or threw.
     */
    rejected: readonly string[] = [],
    /**
     * Addresses the relay took it for (`R13`).
     *
     * **What nodemailer actually reports, and this stub did not.** A recipient *entry* is a
     * 320-character string that nothing stops from holding two addresses, so the envelope can
     * carry more recipients than the template resolved entries — which is how a partial
     * rejection satisfied a "rejected everything" test written as a count against our own list.
     * Undefined leaves it off, which is the older shape and exercises the fallback.
     */
    accepted?: readonly string[],
  ) {
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
          return Promise.resolve({
            messageId: `<${name}>`,
            rejected: [...rejected],
            ...(accepted === undefined ? {} : { accepted: [...accepted] }),
          });
        },
        close: () => undefined,
      }) as never;
    return { sent, build };
  }

  it('sends a subject in any script, which the mail library encodes (N-18)', async () => {
    // The webhook's header failed on anything above U+00FF. Email's subject is a header too, and
    // this is the check that it is encoded rather than refused: the real library builds the
    // message here, and only the relay is left out.
    const compiled: string[] = [];
    const library = createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const build = (): never =>
      ({
        sendMail: async (mail: SendMailOptions) => {
          const info = await library.sendMail(mail);
          const raw: unknown = info.message;
          compiled.push(Buffer.isBuffer(raw) ? raw.toString('utf8') : '');
          return { messageId: info.messageId, accepted: ['ops@example.test'], rejected: [] };
        },
        close: () => undefined,
      }) as never;
    const transport = new EmailTransport({
      config: smtp(),
      logger: silent,
      recipients: addressesOnly,
      build,
    });
    const subject = 'Ping on Київ-edge 🔥 is down — 東京, ÿ';
    const result = await transport.send(message({ subject }));
    assert.ok(result.ok, result.ok ? '' : result.error);

    const raw = compiled.at(0) ?? '';
    const header = /^Subject: (.*(?:\n[ \t].*)*)/mu.exec(raw)?.[1] ?? '';
    assert.match(header, /^[\x20-\x7E\n\t]+$/u, 'the header itself is ASCII');
    assert.equal(decodeWords(header), subject);
  });

  it('refuses to send when no relay is configured, and does not retry', async () => {
    const transport = new EmailTransport({
      config: smtp({ primary: relay({ host: '' }) }),
      logger: silent,
      recipients: addressesOnly,
    });
    assert.equal(transport.configured, false);
    const result = await transport.send(message());
    // `assert.ok` narrows the union, so the failure fields below need no second guard.
    assert.ok(!result.ok);
    assert.equal(result.retryable, false, 'no amount of waiting configures a relay');
    assert.ok(result.error.includes('notifications.smtp.primary.host'));
  });

  it('refuses a message nobody it names can receive, and says who and why', async () => {
    const { sent, build } = stub();
    const transport = new EmailTransport({
      config: smtp(),
      logger: silent,
      recipients: addressesOnly,
      build,
    });
    const result = await transport.send(
      message({ recipients: [{ kind: 'user', value: 'alice' }] }),
    );
    assert.ok(!result.ok);
    // The error names nobody (`A-44`): who, and why, travel beside it for whoever may read them.
    assert.equal(result.error, 'nobody to send to');
    assert.deepEqual(result.skipped, [{ who: 'user "alice"', reason: 'no such account' }]);
    assert.equal(result.retryable, false, 'waiting gives nobody an address');
    assert.equal(sent.length, 0);
  });

  it('sends to the addresses and names the people it missed, rather than dropping them', async () => {
    // **The regression `M-19` is about.** A template naming an address *and* a person used to
    // send to the address and drop the person without a word — it looked like it worked.
    const { sent, build } = stub();
    const transport = new EmailTransport({
      config: smtp(),
      logger: silent,
      recipients: addressesOnly,
      build,
    });
    const result = await transport.send(
      message({
        recipients: [
          { kind: 'address', value: 'ops@example.test' },
          { kind: 'userGroup', value: 'noc' },
        ],
      }),
    );
    assert.ok(result.ok);
    assert.deepEqual(result.skipped, [{ who: 'group "noc"', reason: 'no such group' }]);
    assert.ok(!result.detail.includes('noc'), 'and the detail does not name them');
    assert.equal(sent.length, 1);
  });

  it('sends through the primary relay', async () => {
    const { sent, build } = stub();
    const transport = new EmailTransport({
      config: smtp(),
      logger: silent,
      recipients: addressesOnly,
      build,
    });
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
      recipients: addressesOnly,
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
      recipients: addressesOnly,
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
      const transport = new EmailTransport({
        config: smtp(),
        logger: silent,
        recipients: addressesOnly,
        build,
      });
      const result = await transport.send(message());
      assert.ok(!result.ok);
      assert.equal(result.retryable, retryable, String(code));
    }
  });

  it('treats a connection failure with no code as worth retrying', async () => {
    const { build } = stub({ [MAILHOG_HOST]: { message: 'ECONNREFUSED' } });
    const transport = new EmailTransport({
      config: smtp(),
      logger: silent,
      recipients: addressesOnly,
      build,
    });
    const result = await transport.send(message());
    assert.ok(!result.ok);
    assert.equal(result.retryable, true);
  });

  it('sends HTML when the template asks for it', async () => {
    const { sent, build } = stub();
    const transport = new EmailTransport({
      config: smtp(),
      logger: silent,
      recipients: addressesOnly,
      build,
    });
    await transport.send(message({ settings: { format: 'html' }, body: '<b>down</b>' }));
    assert.equal(sent.at(0)?.mail['html'], '<b>down</b>');
    assert.equal(sent.at(0)?.mail['text'], undefined);
  });

  it('asks for HTML escaping only when the template is HTML', () => {
    // The transport declared no escaping at all (`P-118`). Asserted here rather than through a
    // rendered body because the escaping belongs to substitution — only substitution knows which
    // characters came from a value and which the operator typed as syntax — and this is the half
    // that was missing.
    const transport = new EmailTransport({
      config: smtp(),
      logger: silent,
      recipients: addressesOnly,
      build: stub().build,
    });
    assert.equal(transport.bodyEscaping({ format: 'html' }), 'html');
    assert.equal(transport.bodyEscaping({ format: 'text' }), 'none');
    assert.equal(transport.bodyEscaping({}), 'none', 'a plain email has no syntax to break out of');
  });

  it('fails when the relay rejected every recipient', async () => {
    // **`sendMail` resolves for a partial send**, and the rejections were thrown away — so an
    // alarm that reached nobody on the list was recorded `delivered`, counted as a success on
    // Delivery Health, and never retried. The one place an operator would look said it went out.
    const { build } = stub({}, ['ops@example.test']);
    const transport = new EmailTransport({
      config: smtp(),
      logger: silent,
      recipients: addressesOnly,
      build,
    });
    const result = await transport.send(message());
    assert.ok(!result.ok);
    assert.match(result.error, /rejected every recipient/);
    assert.equal(
      result.retryable,
      false,
      'a rejection at RCPT TO is the relay\u2019s permanent answer about that address',
    );
  });

  it('does not call a partial rejection a total one when one entry held two addresses', async () => {
    // **`R13`.** "Nobody got it" was a count against `to.length` — the recipient *entries* the
    // template resolved — and one entry is a string that nothing stops from holding two
    // addresses: `ops@example.test, oncall@example.test` passes the `includes('@')` check the
    // template applies. The relay parses that into two envelope recipients, refuses one and
    // takes the other, and `1 >= 1` held: a message a real person received was reported a
    // permanent failure, the fallback relay sent them a second copy, and with no fallback
    // Delivery Health went Down over an alarm that was delivered.
    const { build } = stub({}, ['ops@example.test'], ['oncall@example.test']);
    const transport = new EmailTransport({
      config: smtp(),
      logger: silent,
      recipients: addressesOnly,
      build,
    });
    const result = await transport.send(message());
    assert.ok(result.ok, 'somebody received it, so it was delivered');
    assert.match(result.detail, /rejected ops@example.test/, 'and the miss is still said');
  });

  it('still counts a partial send as delivered, and says who missed it', async () => {
    // Somebody got it, so it is delivered. Saying nothing about the rest is how a rota gap
    // survives for months.
    const { build } = stub({}, ['gone@example.test']);
    const transport = new EmailTransport({
      config: smtp(),
      logger: silent,
      recipients: addressesOnly,
      build,
    });
    const result = await transport.send(
      message({
        recipients: [
          { kind: 'address', value: 'ops@example.test' },
          { kind: 'address', value: 'gone@example.test' },
        ],
      }),
    );
    assert.ok(result.ok);
    assert.match(result.detail, /rejected gone@example\.test/);
  });

  it('honours a template’s sender override', async () => {
    const { sent, build } = stub();
    const transport = new EmailTransport({
      config: smtp(),
      logger: silent,
      recipients: addressesOnly,
      build,
    });
    await transport.send(message({ settings: { senderOverride: 'noc@example.test' } }));
    assert.equal(sent.at(0)?.mail['from'], 'noc@example.test');
  });

  it('strips a newline out of every header it builds', async () => {
    const { sent, build } = stub();
    const transport = new EmailTransport({
      config: smtp(),
      logger: silent,
      recipients: addressesOnly,
      build,
    });
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
    const transport = new EmailTransport({
      config: smtp(),
      logger: silent,
      recipients: addressesOnly,
      build,
    });
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
      const created = await templates.create(
        testActor,
        {
          name: `On-call-${String(process.hrtime.bigint())}`,
          method: 'email',
          settings: {},
          subject: '%sitename: %sensor on %device is %status',
          body: '%lastmessage — %linksensor',
          recipients: [{ kind: 'address', value: 'ops@example.test' }],
          ...overrides,
          // Written as an administrator, who alone may name a group (`A-44`).
        },
        { namesAccounts: true },
      );
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
        // No wait between attempts, so a test can drive several in a row. `leaseMs` matters as
        // much as the backoff: the claim writes the lease, so anything above zero would put the
        // next attempt in the future whatever the retry policy said.
        retry: { firstDelayMs: options.retryDelayMs ?? 0, maxDelayMs: options.retryDelayMs ?? 0 },
        leaseMs: 0,
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

    it('records a program that printed a NUL as failed once, and does not run it again (P-277)', async () => {
      // The program's last line is the request's `last_error`, and PostgreSQL text cannot hold
      // U+0000. The write failed, so the request stayed claimed, and every time its lease ran out
      // it was claimed and the program run again: one alarm, a ticket every five minutes. The real
      // program transport behind the template's method, so what is recorded is what it said.
      const root = await mkdtemp(join(tmpdir(), 'ms-nul-'));
      try {
        const runs = join(root, 'runs.txt');
        const file = join(root, 'binary.sh');
        await writeFile(
          file,
          `#!/bin/sh\necho ran >> '${runs}'\nprintf 'refused \\000by the gateway\\n' >&2\nexit 3\n`,
          'utf8',
        );
        await chmod(file, 0o755);
        const program = new ProgramTransport({
          config: { directory: root, maxOutputBytes: 4096, killGraceMs: 500, uid: -1, gid: -1 },
          logger: silent,
        });
        const viaProgram = {
          method: 'email',
          send: (outgoing: OutgoingMessage) =>
            program.send({ ...outgoing, settings: { path: 'binary.sh', timeoutMs: 10_000 } }),
        };
        const requestId = await queue(await emailTemplate());
        const dispatcher = dispatcherWith(viaProgram);

        await dispatcher.dispatch();
        const after = await statusOf(requestId);
        assert.equal(after.status, 'failed', 'a non-zero exit is an answer');
        assert.equal(after.attempts, 1);
        assert.equal(after.error, 'binary.sh exited 3 — refused by the gateway');

        await dispatcher.dispatch();
        assert.equal((await readFile(runs, 'utf8')).trim().split('\n').length, 1, 'run once');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('records a refusal that quotes a NUL, and does not send the message again (P-277)', async () => {
      // A webhook's response body is the far end's words, and a 4xx is quoted into the error.
      const templateId = await emailTemplate();
      const requestId = await queue(templateId);
      let sends = 0;
      const quoting = {
        method: 'email',
        send: () => {
          sends += 1;
          return Promise.resolve({
            ok: false,
            retryable: false,
            error: '400 from hooks.example.test — bad\u0000request',
          } as const);
        },
      };
      const dispatcher = dispatcherWith(quoting);

      await dispatcher.dispatch();
      const after = await statusOf(requestId);
      assert.equal(after.status, 'failed');
      assert.equal(after.error, '400 from hooks.example.test — badrequest');
      await dispatcher.dispatch();
      assert.equal(sends, 1);
    });

    it('records who a message reached nobody among, by name and by count, and not in the error (A-44)', async () => {
      // "Nobody to send to" fails for good, and who and why are what make it a diagnosis. They
      // go where the log can give each reader what they may read: names to an administrator,
      // counts to everybody else. The error names nobody, for every reader alike.
      const templateId = await emailTemplate();
      const requestId = await queue(templateId);
      const nobody = {
        method: 'email',
        send: () =>
          Promise.resolve({
            ok: false,
            retryable: false,
            error: 'nobody to send to',
            skipped: [
              { who: 'user "alice"', reason: 'disabled' },
              { who: 'user 57', reason: 'no such account' },
              { who: '"bob" in group "NOC"', reason: 'disabled' },
            ],
          } as const),
      };
      await dispatcherWith(nobody).dispatch();
      const [row] = await db.query<{
        status: string;
        last_error: string | null;
        skipped_recipients: string;
        skipped_counts: Record<string, number>;
      }>(
        `SELECT status, last_error, skipped_recipients, skipped_counts
         FROM notification_request WHERE id = $1`,
        [requestId],
      );
      assert.deepEqual(row, {
        status: 'failed',
        last_error: 'nobody to send to',
        skipped_recipients:
          'user "alice" (disabled), user 57 (no such account), "bob" in group "NOC" (disabled)',
        skipped_counts: { disabled: 2, 'no such account': 1 },
      });
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
      // Immediate, because this is about the counters and not about `N-11`: under the default
      // mode the second of two simultaneous notifications is held for the digest, which is a
      // different test in a different file.
      const templateId = await emailTemplate({ summarisation: 'always-immediate' });
      await queue(templateId);
      await queue(templateId);
      const { transport } = recorder(() => ({ ok: true }));
      const dispatcher = dispatcherWith(transport);
      await dispatcher.dispatch();
      assert.equal(dispatcher.stats.sent, 2);
      assert.equal(dispatcher.stats.failed, 0);
    });

    it('drains a backlog through the loop rather than one batch per tick', async () => {
      // Immediate for the same reason: the question here is whether the loop comes back for the
      // second batch, which needs seven messages rather than one message and a digest.
      const templateId = await emailTemplate({ summarisation: 'always-immediate' });
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

        const transport = new EmailTransport({
          config: smtp(),
          logger: silent,
          recipients: addressesOnly,
        });
        const dispatcher = new NotificationDispatcher({
          db,
          logger: silent,
          contexts,
          transports: [transport],
          // Zero, and load-bearing: the loop below cannot retry anything through the default
          // backoff, because a deferred request's `next_attempt_at` is a minute away and the very
          // next `dispatch()` claims nothing.
          retry: { firstDelayMs: 0, maxDelayMs: 0 },
          leaseMs: 0,
        });
        try {
          // Dispatched until it lands, rather than once. Kept as a defence rather than as a
          // diagnosis: the intermittent failures this was written for turned out to be Jim,
          // MailHog's chaos monkey, which is live in that image and randomly answers
          // `550 Invalid recipient` — a permanent rejection by every correct reading, so the
          // transport does not retry it and no amount of looping would have helped. Jim is
          // switched off in `docker-compose.dev.yml` (`N-14`). A relay genuinely being busy is
          // still a thing, and this still survives it.
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
      'delivers to a group’s members at their own addresses, and records who it missed',
      { skip: mailhog ? false : 'no MailHog reachable (start docker-compose.dev.yml)' },
      async () => {
        // `M-19` end to end: a template naming a group, resolved when the alarm is sent, through
        // a real relay. One member receives it; one is disabled and one has no address, and the
        // notification log says so rather than recording a plain "sent".
        const mark = String(process.hrtime.bigint());
        const account = async (login: string, email: string, disabled = false) =>
          Number(
            (
              await db.query<{ id: string }>(
                `INSERT INTO user_account (login, display_name, email, password_hash, role, disabled)
                 VALUES ($1, $1, $2, 'x', 'readwrite', $3) RETURNING id::text AS id`,
                [`${login}-${mark}`, email, disabled],
              )
            )[0]?.id,
          );
        const reachable = `oncall-${mark}@example.test`;
        const members = [
          await account('oncall', reachable),
          await account('leaver', `leaver-${mark}@example.test`, true),
          await account('noaddress', ''),
        ];
        const groupId = Number(
          (
            await db.query<{ id: string }>(
              `INSERT INTO user_group (name) VALUES ($1) RETURNING id::text AS id`,
              [`NOC ${mark}`],
            )
          )[0]?.id,
        );
        for (const member of members) {
          await db.query(`INSERT INTO user_group_member (group_id, user_id) VALUES ($1, $2)`, [
            groupId,
            member,
          ]);
        }
        // Read on the whole tree, so the rights rule lets the members through and the case is
        // about the account column alone.
        await db.query(
          `INSERT INTO object_access (object_id, group_id, right_, granted_by)
           VALUES ($1, $2, 'read', 'test')`,
          [h.rootId, groupId],
        );

        const templateId = await emailTemplate({
          recipients: [{ kind: 'userGroup', value: String(groupId) }],
        });
        const requestId = await queue(templateId);
        const transport = new EmailTransport({
          config: smtp(),
          logger: silent,
          recipients: new RecipientResolver({
            db,
            access: new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent }),
          }),
        });
        const dispatcher = new NotificationDispatcher({
          db,
          logger: silent,
          contexts,
          transports: [transport],
          retry: { firstDelayMs: 0, maxDelayMs: 0 },
          leaseMs: 0,
        });
        try {
          let delivered = await statusOf(requestId);
          for (let attempt = 0; attempt < 5 && delivered.status !== 'sent'; attempt += 1) {
            await dispatcher.dispatch();
            delivered = await statusOf(requestId);
          }
          assert.equal(delivered.status, 'sent', delivered.error ?? 'no error recorded');

          const response = await fetch(`${MAILHOG_API}/search?kind=to&query=${reachable}`, {
            signal: AbortSignal.timeout(5_000),
          });
          assert.ok(response.ok);
          assert.equal(((await response.json()) as { total: number }).total, 1);

          const [row] = await db.query<{
            skipped_recipients: string;
            skipped_counts: Record<string, number>;
          }>(`SELECT skipped_recipients, skipped_counts FROM notification_request WHERE id = $1`, [
            requestId,
          ]);
          assert.equal(
            row?.skipped_recipients,
            `"leaver-${mark}" in group "NOC ${mark}" (disabled), ` +
              `"noaddress-${mark}" in group "NOC ${mark}" (no email address)`,
          );
          // And by count, which is what a reader who may not list accounts is shown (`A-44`).
          assert.deepEqual(row.skipped_counts, { disabled: 1, 'no email address': 1 });
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
          recipients: addressesOnly,
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

/**
 * RFC 2047's encoded words back to text, for the one test that reads a compiled message. Adjacent
 * words are joined, since the whitespace between them is folding and not part of the subject.
 */
function decodeWords(header: string): string {
  return header
    .replace(/\n[ \t]/gu, ' ')
    .replace(/\?=\s+=\?/gu, '?==?')
    .replace(/=\?utf-8\?([bq])\?([^?]*)\?=/giu, (_word, encoding: string, text: string) =>
      encoding.toLowerCase() === 'b'
        ? Buffer.from(text, 'base64').toString('utf8')
        : Buffer.from(
            text
              .replace(/_/gu, ' ')
              .replace(/=([0-9a-f]{2})/giu, (_hex, pair: string) =>
                String.fromCharCode(parseInt(pair, 16)),
              ),
            'latin1',
          ).toString('utf8'),
    );
}
