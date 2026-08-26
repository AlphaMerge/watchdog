import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { SmtpConfig, SmtpRelay, WebhookConfig } from '@ms/shared';
import { CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { MessageContextLoader } from '../src/notifications/context.js';
import { EmailTransport } from '../src/notifications/delivery/email.js';
import { WebhookTransport } from '../src/notifications/delivery/webhook.js';
import { NotificationDispatcher } from '../src/notifications/dispatcher.js';
import { AlarmEngine } from '../src/notifications/engine.js';
import { AlarmScheduler } from '../src/notifications/scheduler.js';
import { TriggerSync } from '../src/notifications/sync.js';
import { TemplateService } from '../src/notifications/templates.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import { TriggerService } from '../src/triggers/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
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

function smtp(): SmtpConfig {
  const relay: SmtpRelay = {
    host: MAILHOG_HOST,
    port: 1025,
    security: 'none',
    verifyCertificate: true,
    auth: 'none',
    user: '',
    password: '',
    heloName: 'ms-core.test',
    timeoutMs: 10_000,
  };
  return { sender: 'monitoring@example.test', primary: relay, fallback: { ...relay, host: '' } };
}

const T0 = new Date('2026-08-26T09:00:00.000Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

/** `PLAN.md`'s number. Two hundred sensors, so "one message plus digests" is a real claim. */
const SENSORS = 200;
const DEVICES = 8;

/** `CAPABILITIES.MD §5.2`'s cap, and therefore how many digests 199 held messages become. */
const PER_DIGEST = 25;

/**
 * `N-15`: Phase 4's exit criteria, end to end, against things that really deliver.
 *
 * `M-17` proved the *state* half of "one outage, one alarm": a switch failure in front of forty
 * sensors produces one Down and forty Paused, because a dependency was modelled. This is the
 * other half — the case where nothing was modelled, two hundred sensors fail at once, and the
 * only thing standing between an operator and two hundred emails is summarisation.
 *
 * **Against MailHog and a real HTTP sink**, not stubs. A scenario test whose delivery is a mock
 * proves the mock agrees with itself; the whole point of the exit criterion is that a message
 * arrives somewhere an operator could look.
 */
describe(
  'notification scenarios',
  {
    skip: available
      ? mailhog
        ? false
        : 'no MailHog reachable (start docker-compose.dev.yml)'
      : 'no PostgreSQL reachable (start docker-compose.dev.yml)',
  },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let engine: AlarmEngine;
    let triggers: TriggerService;
    let templates: TemplateService;
    let contexts: MessageContextLoader;
    let scheduler: AlarmScheduler;
    let dispatcher: NotificationDispatcher;
    let email: EmailTransport;
    let sink: Server;
    let sinkPort: number;
    let posted: { url: string; body: string }[];

    before(async () => {
      scratch = await createScratchDatabase('notifscenario');
      db = scratch.db;

      engine = new AlarmEngine({ logger: silent });
      h = await buildHarness(db, { states: true, alarms: engine });
      const sync = new TriggerSync({ engine, logger: silent });
      h.audit.also = sync;
      triggers = new TriggerService({
        db,
        audit: new CompositeAuditSink([new DatabaseAuditSink(), sync]),
        logger: silent,
      });
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
      scheduler = new AlarmScheduler({ db, engine, logger: silent });

      posted = [];
      sink = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        request.on('end', () => {
          posted.push({
            url: request.url ?? '',
            body: Buffer.concat(chunks).toString('utf8'),
          });
          response.writeHead(204).end();
        });
      });
      await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
      sinkPort = (sink.address() as AddressInfo).port;

      email = new EmailTransport({ config: smtp(), logger: silent });
      const webhookConfig: WebhookConfig = {
        targetPolicy: 'link-local',
        maxRedirects: 0,
        userAgent: 'ms-core-scenario',
      };
      dispatcher = new NotificationDispatcher({
        db,
        logger: silent,
        contexts,
        transports: [
          email,
          new WebhookTransport({
            config: webhookConfig,
            logger: silent,
            resolve: () => Promise.resolve(['127.0.0.1']),
          }),
        ],
        // No wait between attempts, so `drain` below can finish rather than sleeping through a
        // production backoff. What is being tested is how many messages there are, not when.
        retry: { firstDelayMs: 0, maxDelayMs: 0 },
        leaseMs: 0,
      });
    });

    after(async () => {
      await email.close();
      await new Promise<void>((resolve) => {
        sink.close(() => {
          resolve();
        });
      });
      await scratch.drop();
    });

    beforeEach(async () => {
      // Each scenario starts from an empty installation. A trigger on the root applies to every
      // sensor there is, so one scenario's leftovers would arm the next one's sensors.
      await db.query('DELETE FROM notification_request');
      await db.query('DELETE FROM notification_summary');
      await db.query('DELETE FROM notification_alarm');
      await db.query('DELETE FROM notification_trigger');
      await db.query('DELETE FROM notification_template');
      await db.query(`DELETE FROM object WHERE kind = 'probe'`);
      posted = [];
    });

    // ---------------------------------------------------------------------------------------
    // Driving the system the way ingestion does.
    // ---------------------------------------------------------------------------------------

    async function scan(sensors: readonly number[], ok: boolean, when: Date): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      const results: SensorResult[] = sensors.map((id) => ({
        sensorId: id,
        at: when,
        outcome: ok ? 'ok' : 'error',
        message: ok ? 'reachable' : 'no ICMP reply',
      }));
      const decisions = await states.decide(results);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
        await engine.react(q, sensors, when);
      });
    }

    /** Dispatches until the queue stops moving, the way `DeliveryLoop` does. */
    async function drain(now: Date, rounds = 40): Promise<void> {
      for (let round = 0; round < rounds; round += 1) {
        if ((await dispatcher.dispatch(now)) === 0) return;
      }
      assert.fail('the queue never drained');
    }

    /**
     * Decodes an RFC 2047 encoded-word subject.
     *
     * A digest's subject contains an em dash, so it goes out encoded — which is correct, and
     * means the raw header is `=?UTF-8?Q?...?=` rather than anything a test can match. Decoding
     * it here asserts what a mail client would actually show.
     */
    function decodeSubject(raw: string): string {
      return raw
        // Adjacent encoded words are separated by whitespace that is not part of the text.
        .replace(/\?=\s+=\?/g, '?==?')
        .replace(/=\?utf-8\?q\?([^?]*)\?=/gi, (_match, text: string) => {
          const bytes: number[] = [];
          for (let index = 0; index < text.length; index += 1) {
            const character = text.charAt(index);
            if (character === '_') {
              bytes.push(0x20);
            } else if (character === '=' && index + 2 < text.length) {
              bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16));
              index += 2;
            } else {
              bytes.push(character.charCodeAt(0));
            }
          }
          return Buffer.from(bytes).toString('utf8');
        });
    }

    async function mailFor(address: string): Promise<string[]> {
      const response = await fetch(
        `${MAILHOG_API}/search?kind=to&query=${address}&limit=200`,
        { signal: AbortSignal.timeout(10_000) },
      );
      assert.ok(response.ok, 'MailHog did not answer');
      const found = (await response.json()) as {
        items: { Content: { Headers: Record<string, string[]> } }[];
      };
      return found.items.map((item) => decodeSubject(item.Content.Headers['Subject']?.[0] ?? ''));
    }

    // ---------------------------------------------------------------------------------------
    // Two hundred sensors, one message plus digests.
    // ---------------------------------------------------------------------------------------

    it('turns a 200-sensor outage into one message plus digests', async () => {
      const address = `storm-${String(process.hrtime.bigint())}@example.test`;

      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
      });
      const sensors: number[] = [];
      for (let index = 0; index < DEVICES; index += 1) {
        const device = await h.service.create(testActor, {
          kind: 'device',
          parentId: probe.id,
          name: `rack-${String(index).padStart(2, '0')}`,
          host: `192.0.2.${String(10 + index)}`,
        });
        for (let n = 0; n < SENSORS / DEVICES; n += 1) {
          const sensor = await h.service.create(testActor, {
            kind: 'sensor',
            parentId: device.id,
            name: `ping-${String(n).padStart(2, '0')}`,
            sensorType: 'icmp.ping',
          });
          sensors.push(sensor.id);
        }
      }
      assert.equal(sensors.length, SENSORS);

      // Email: the default mode, which is what an installation runs unless it says otherwise.
      const mail = await templates.create(testActor, {
        name: `Storm mail ${String(process.hrtime.bigint())}`,
        method: 'email',
        settings: {},
        subject: '%sensor on %device is %status',
        body: '%lastmessage',
        recipients: [{ kind: 'address', value: address }],
        summaryWindowSeconds: 60,
      });
      // Webhook: never summarised (`CAPABILITIES.MD §5.2`), so this is the other half of the
      // scenario — what an operator is choosing when they pick a machine-consumed channel.
      const hook = await templates.create(testActor, {
        name: `Storm hook ${String(process.hrtime.bigint())}`,
        method: 'webhook',
        settings: {
          url: `http://sink.test:${String(sinkPort)}/alarms`,
          verb: 'POST',
          contentType: 'application/json',
        },
        subject: '%sensor is %status',
        body: '{"sensor":"%sensor","status":"%status"}',
        recipients: [],
      });

      for (const templateId of [mail.id, hook.id]) {
        await triggers.create(testActor, h.rootId, {
          kind: 'state',
          settings: { state: 'down', initialLatencySeconds: 0, initialTemplateId: templateId },
        });
      }

      // The outage: everything fails, twice, because the two-step rule takes a sensor through
      // Warning before it is Down.
      await scan(sensors, false, T0);
      await scan(sensors, false, at(60));

      // Two triggers on the root, so every sensor arms two independent chains — which is the
      // accumulating inheritance of `N-01`, and the reason the counts below differ per method.
      const fired = await scheduler.sweep(at(61));
      assert.equal(fired, SENSORS * 2, 'every sensor armed and fired both of its chains');

      const queued = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notification_request',
      );
      assert.equal(Number(queued[0]?.n), SENSORS * 2, 'one obligation per sensor per template');

      // First pass: the first Down goes at once and the other 199 are collected.
      await drain(at(62));
      assert.deepEqual(await mailFor(address), ['ping-00 on rack-00 is down']);

      // Then time passes. The window opened on the pass above and is due sixty seconds later,
      // so this is the real due-time path rather than a poke at the table.
      await drain(at(200));

      const subjects = await mailFor(address);
      const digests = subjects.filter((subject) => subject.includes('notifications'));
      const expectedDigests = Math.ceil((SENSORS - 1) / PER_DIGEST);
      assert.equal(digests.length, expectedDigests, 'the rest arrived as digests');
      assert.equal(
        subjects.length,
        1 + expectedDigests,
        `${String(SENSORS)} alarms became ${String(1 + expectedDigests)} emails`,
      );
      // Numbered, because a digest that says "25 notifications" with no idea how many are
      // missing is a digest an operator cannot trust.
      assert.ok(
        digests.every((subject) => / \(\d+ of 8\)$/.test(subject)),
        `digest subjects were ${digests.join(' | ')}`,
      );
      assert.ok(
        digests.some((subject) => subject.startsWith('Acme production: 25 notifications — 25 down')),
        'and each says what is in it',
      );

      // The webhook got all two hundred, and that is correct rather than a failure: a machine
      // consumer wants every event, which is exactly why these methods are never summarised.
      assert.equal(posted.length, SENSORS);
      assert.ok(posted.every((request) => request.url === '/alarms'));
      assert.ok(
        posted.some((request) => request.body === '{"sensor":"ping-00","status":"down"}'),
        'and each carries the sensor it is about',
      );

      const health = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM notification_request WHERE status <> 'sent'",
      );
      assert.equal(health[0]?.n, '0', 'nothing was left owed');
    });

    // ---------------------------------------------------------------------------------------
    // The blip that notifies nobody.
    // ---------------------------------------------------------------------------------------

    it('says nothing about a 30-second blip under a 5-minute latency', async () => {
      // `WORKFLOW.MD §6`: latency prevents false alarms, and this is the case it exists for. The
      // recovery is silent too — a chain that never fired has nothing to recover from, and a
      // "resolved" for an alarm nobody was told about is noise with extra steps.
      const address = `blip-${String(process.hrtime.bigint())}@example.test`;

      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: `blip-probe-${String(process.hrtime.bigint())}`,
      });
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'flaky',
        host: '192.0.2.99',
      });
      const sensor = await h.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name: 'ping',
        sensorType: 'icmp.ping',
      });

      const template = await templates.create(testActor, {
        name: `Blip mail ${String(process.hrtime.bigint())}`,
        method: 'email',
        settings: {},
        subject: '%sensor is %status',
        body: '%lastmessage',
        recipients: [{ kind: 'address', value: address }],
        summarisation: 'always-immediate',
      });
      const trigger = await triggers.create(testActor, device.id, {
        kind: 'state',
        settings: {
          state: 'down',
          initialLatencySeconds: 300,
          initialTemplateId: template.id,
          recoveryTemplateId: template.id,
        },
      });

      // Down at +60 (the second failure), up again at +90. Thirty seconds, against five minutes.
      await scan([sensor.id], false, at(0));
      await scan([sensor.id], false, at(60));
      const armed = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notification_alarm WHERE sensor_id = $1',
        [sensor.id],
      );
      assert.equal(armed[0]?.n, '1', 'the chain is armed and waiting out its latency');

      await scan([sensor.id], true, at(90));

      // Long past the latency, and past any repeat it might have had.
      assert.equal(await scheduler.sweep(at(600)), 0, 'nothing fell due');
      await drain(at(601));

      const queued = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notification_request',
      );
      assert.equal(queued[0]?.n, '0', 'not one notification was queued');
      assert.deepEqual(await mailFor(address), [], 'and nothing arrived');

      const standing = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notification_alarm WHERE sensor_id = $1',
        [sensor.id],
      );
      assert.equal(standing[0]?.n, '0', 'and the chain was stood down rather than left armed');

      await triggers.delete(testActor, trigger.id);
    });
  },
);
