import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { CheckResult, ProbeQuery } from '@ms/shared';
import { ApiServer } from '../src/api/server.js';
import { AuditRepository } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { ProbeConfigService } from '../src/probes/config.js';
import { ProbeQueryService, type ProbeQuerySender } from '../src/probes/queries.js';
import { InheritanceResolver } from '../src/settings/inheritance.js';
import { HistoryService } from '../src/timeseries/history.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { testCatalogue } from './support/sensor-types.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';

const available = await databaseAvailable();

/**
 * `POST /sensors/{id}/check` — running one check now (`R-09`).
 *
 * **What this endpoint is for is telling failures apart**, so what is tested here is which
 * failure reaches the client and as what. A check that ran and failed is a 200 carrying the
 * reason; the error statuses are reserved for the *query* failing, and a client that could not
 * tell those apart would show a retry button for a probe that will never answer, or an upgrade
 * prompt for a device that is merely down.
 */

/** Answers whatever a test tells it to, without a socket. */
class StubSender implements ProbeQuerySender {
  delivery: ReturnType<ProbeQuerySender['sendQuery']> = { kind: 'sent' };
  answer: { result?: CheckResult; failure?: 'busy'; message?: string } | null = null;
  asked: ProbeQuery[] = [];
  service: ProbeQueryService | undefined;

  sendQuery(
    _probeObjectId: number,
    message:
      | { kind: 'ask'; queryId: string; query: ProbeQuery; timeoutMs: number }
      | { kind: 'cancel'; queryId: string },
  ): ReturnType<ProbeQuerySender['sendQuery']> {
    if (message.kind === 'cancel') return { kind: 'sent' };
    this.asked.push(message.query);
    const delivery = this.delivery;
    const answer = this.answer;
    if (delivery.kind === 'sent' && answer !== null) {
      // Answered on the next turn, exactly as a probe's reply arrives: synchronously here would
      // settle the promise before `ask` had even created it.
      setImmediate(() => this.service?.deliver({ queryId: message.queryId, ...answer }));
    }
    return delivery;
  }
}

describe(
  'checking a sensor now',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let harness: Harness;
    let app: FastifyInstance;
    let sender: StubSender;
    let sensorId: number;
    let deviceId: number;

    before(async () => {
      scratch = await createScratchDatabase('checknow');
      db = scratch.db;
      harness = await buildHarness(db);

      sender = new StubSender();
      const queries = new ProbeQueryService({ logger: silent, sender });
      sender.service = queries;

      const server = new ApiServer({
        config: { host: '127.0.0.1', port: 0, webRoot: '', allowedOrigins: [] },
        logger: silent,
        version: '9.9.9',
        service: harness.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
        queries,
        probeConfig: new ProbeConfigService({
          db,
          resolver: new InheritanceResolver({ db, logger: silent }),
        }),
      });
      await server.build('9.9.9', harness.service);
      app = server.app;

      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'Check probe',
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'Check device',
        host: '192.0.2.70',
        ipVersion: 'v4',
      });
      deviceId = device.id;
      const sensor = await harness.service.create(testActor, {
        kind: 'sensor',
        parentId: device.id,
        name: 'Ping',
        sensorType: 'icmp.ping',
        params: { count: 4 },
      });
      sensorId = sensor.id;
    });

    after(async () => {
      await app.close();
      await scratch.drop();
    });

    beforeEach(() => {
      sender.delivery = { kind: 'sent' };
      sender.answer = null;
      sender.asked = [];
    });

    const check = (body: Record<string, unknown> = {}) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/sensors/${String(sensorId)}/check`,
        payload: body,
      });

    const ok = (): CheckResult => ({
      sensorId,
      at: '2026-08-29T10:00:00.000Z',
      outcome: 'ok',
      message: '4/4 replies, avg 1.2 ms',
      durationMs: 612,
      channels: [{ key: 'rtt', value: 1.2, name: 'Response time', unit: 'ms' }],
    });

    it('answers with what the check said', async () => {
      sender.answer = { result: ok() };
      const response = await check();

      assert.equal(response.statusCode, 200);
      const body = response.json<{
        outcome: string;
        message: string;
        channels: { key: string; value: number }[];
        stored: boolean;
      }>();
      assert.equal(body.outcome, 'ok');
      assert.match(body.message, /4\/4 replies/);
      assert.deepEqual(body.channels, [
        { key: 'rtt', value: 1.2, name: 'Response time', unit: 'ms' },
      ]);
    });

    it('says on every response that it stored nothing', async () => {
      // A reading taken outside the schedule is not history: ten presses of the button would
      // otherwise draw ten spikes into a channel whose interval is a minute. Said rather than
      // assumed, so a client is not guessing and the guess cannot change between releases.
      sender.answer = { result: ok() };
      assert.equal(await storedFlag(), false);

      const rows = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM sample');
      assert.equal(rows[0]?.n, '0', 'an on-demand check must not write a sample');
    });

    async function storedFlag(): Promise<boolean> {
      return (await check()).json<{ stored: boolean }>().stored;
    }

    it('asks for exactly the assignment the schedule would run', async () => {
      sender.answer = { result: ok() };
      await check();

      const asked = sender.asked[0];
      assert.ok(asked !== undefined);
      assert.equal(asked.kind, 'check');
      assert.equal(asked.assignment.sensorId, sensorId);
      assert.equal(asked.assignment.sensorType, 'icmp.ping');
      assert.deepEqual(asked.assignment.params, { count: 4 });
      assert.equal(asked.assignment.target.host, '192.0.2.70');
    });

    it('is a 200 when the check itself failed, because that is the answer', async () => {
      // The whole reason somebody pressed the button. An error status would send this down a
      // client's failure path and hide the one thing they were trying to see.
      sender.answer = {
        result: {
          ...ok(),
          outcome: 'error',
          message: 'no ICMP reply from 192.0.2.70 (4 sent, 0 replies)',
          channels: [],
        },
      };
      const response = await check();

      assert.equal(response.statusCode, 200);
      const body = response.json<{ outcome: string; message: string; channels: unknown[] }>();
      assert.equal(body.outcome, 'error');
      assert.match(body.message, /no ICMP reply/);
      assert.deepEqual(body.channels, [], 'a failed check reports no channel values');
    });

    it('is a 503 when the probe is not connected, and says which', async () => {
      sender.delivery = { kind: 'offline' };
      const response = await check();

      assert.equal(response.statusCode, 503);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'PROBE_QUERY_OFFLINE');
    });

    it('is a 409 when the probe is too old, because waiting will not fix it', async () => {
      sender.delivery = { kind: 'too-old', protocolVersion: 5 };
      const response = await check();

      assert.equal(response.statusCode, 409);
      const error = response.json<{ error: { code: string; message: string } }>().error;
      assert.equal(error.code, 'PROBE_QUERY_TOO_OLD');
      assert.match(error.message, /protocol 5/);
    });

    it('is a 503 when the probe refuses for being busy', async () => {
      sender.answer = { failure: 'busy', message: 'this sensor is already being checked' };
      const response = await check();

      assert.equal(response.statusCode, 503);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'PROBE_QUERY_BUSY');
    });

    it('refuses something that is not a sensor rather than asking a probe about it', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/sensors/${String(deviceId)}/check`,
        payload: {},
      });
      assert.equal(response.statusCode, 404);
      assert.equal(sender.asked.length, 0, 'nothing should have been sent');
    });

    it('refuses a timeout outside the bounds a person would wait', async () => {
      for (const timeoutMs of [10, 600_000]) {
        const response = await check({ timeoutMs });
        assert.equal(response.statusCode, 400, `${String(timeoutMs)} should be refused`);
      }
    });

    it('passes the caller’s timeout down to the probe', async () => {
      sender.answer = { result: ok() };
      const response = await check({ timeoutMs: 4_000 });
      assert.equal(response.statusCode, 200);
    });
  },
);
