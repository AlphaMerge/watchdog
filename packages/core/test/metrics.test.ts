import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ApiServer } from '../src/api/server.js';
import { AccountService } from '../src/auth/accounts.js';
import { GroupService } from '../src/auth/groups.js';
import { AccessService } from '../src/auth/access.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { SessionService } from '../src/auth/sessions.js';
import { TokenService } from '../src/auth/tokens.js';
import { TotpService } from '../src/auth/totp.js';
import { AuditRepository } from '../src/audit/store.js';
import { HistoryService } from '../src/timeseries/history.js';
import { CoreHealthService } from '../src/health/core-health.js';
import { ProbeHealthService } from '../src/health/probe-health.js';
import { MetricsExporter } from '../src/metrics/exporter.js';
import type { ProbeLink } from '../src/transport/probe-endpoint.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor } from './support/tree.js';
import { testCatalogue } from './support/sensor-types.js';

/**
 * The Prometheus scrape endpoint (`P-14`).
 *
 * Two properties are worth more than the rest and are what most of this file is about. **A gap is
 * an absent series**, because Prometheus has no null and a zero would be a claim; and **the
 * numbers are the health sensors' own**, because a second implementation of a health question is
 * a second answer to it.
 */

const available = await databaseAvailable();

/** Parses the text format into `name{labels} -> value`, which is all these tests need. */
function parse(body: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of body.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const at = line.lastIndexOf(' ');
    if (at < 0) continue;
    out.set(line.slice(0, at), Number(line.slice(at + 1)));
  }
  return out;
}

describe('the metrics endpoint', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let probeId = 0;

  before(async () => {
    scratch = await createScratchDatabase('metrics');
    db = scratch.db;
    const harness = await buildHarness(db);
    const probe = await harness.service.create(testActor, {
      kind: 'probe',
      parentId: harness.rootId,
      name: 'scraped-probe',
    });
    probeId = probe.id;
  });

  after(async () => {
    await scratch.drop();
  });

  const coreHealth = (): CoreHealthService =>
    new CoreHealthService({
      db,
      logger: silent,
      sources: {
        disk: () => null,
        evictedChunks: () => 0,
        ingestion: () => ({
          queuedRows: 41,
          refusedRows: 7,
          dependencyPauses: 3,
          deferredReactions: 0,
          writeMs: { p95: 12.5 },
        }),
        stream: () => ({ overflowed: 2 }),
        probes: () => ({ probesDown: 1, probesSilent: 2 }),
        alarms: () => ({ fired: 6, nextWakeAt: null }),
        reports: () => ({ deferred: 5, failed: 3 }),
        queries: () => ({ refused: 2 }),
        ingestionDiscards: () => ({ discardedFutureTime: 0 }),
        delivery: () => Promise.resolve({ pending: 9, failed: 4, oldestPendingAgeMs: 125_000 }),
      },
      ingest: () => Promise.resolve(),
    });

  const probeHealth = (link: ProbeLink): ProbeHealthService =>
    new ProbeHealthService({
      db,
      logger: silent,
      sources: { link: () => link },
      ingest: () => Promise.resolve(),
    });

  // The connected arm rather than the union: spreading a union loses the discriminant, so every
  // `{ ...connected, health: … }` below would stop type-checking against the other arm.
  const connected: Extract<ProbeLink, { connected: true }> = {
    connected: true,
    protocolVersion: 7,
    connectedAt: new Date(),
    lastHeartbeatAt: new Date(),
    approved: true,
    agentVersion: '1.0.0',
    assignedSensors: 120,
    cadenceSeconds: 60,
    connectedForMs: Number.MAX_SAFE_INTEGER,
    sinceResultsMs: 0,
    sinceConfigMs: 0,
    configured: true,
    configurable: true,
    lastResultsAt: new Date(),
    configSentAt: new Date(),
    health: {
      scheduled: 120,
      schedulerLagMs: { p50: 2, p95: 11, p99: 30, max: 90 },
      poolSize: 48,
      poolBusy: 12,
      queued: 3,
      queueWaitMs: { p50: 1, p95: 40, p99: 90, max: 500 },
      deferred: 7,
      refused: 2,
      timedOut: 0,
      workerCrashes: 0,
      spoolPending: 500,
      spoolBytes: 2 * 1024 * 1024,
      spoolDropped: 4,
      clockJumps: 1,
      memoryMb: 210,
      uptimeSeconds: 3_600,
    },
  };

  const exporter = (link: ProbeLink = connected): MetricsExporter => {
    const core = coreHealth();
    const probe = probeHealth(link);
    return new MetricsExporter({
      db,
      logger: silent,
      coreHealth: () => core,
      probeHealth: () => probe,
    });
  };

  describe('what it exports', () => {
    it('carries the core’s numbers in base units', async () => {
      // Milliseconds become seconds and percentages become ratios, because that is what every
      // dashboard and alert expression assumes. The channels keep the units an operator reads.
      const metrics = parse((await exporter().scrape()).body);
      assert.equal(metrics.get('ms_core_ingestion_queue_rows'), 41);
      assert.equal(metrics.get('ms_core_db_write_p95_seconds'), 0.0125);
      assert.equal(metrics.get('ms_core_notification_oldest_seconds'), 125);
      assert.equal(metrics.get('ms_core_probes_disconnected'), 1);
      // `P-22`: the alarm scheduler's numbers reach a scrape through the same read as the
      // sensor's, rather than being counted a second time from the same object.
      assert.equal(metrics.get('ms_core_alarm_sweep_overdue_seconds'), 0);
      assert.equal(metrics.get('ms_core_alarm_steps_fired_total'), 6);
      assert.equal(metrics.get('ms_core_probe_queries_refused_total'), 2);
    });

    it('carries each probe’s numbers, labelled by probe', async () => {
      const metrics = parse((await exporter().scrape()).body);
      const label = `{probe="${String(probeId)}"}`;
      assert.equal(metrics.get(`ms_probe_connected${label}`), 1);
      assert.equal(metrics.get(`ms_probe_scheduler_lag_p95_seconds${label}`), 0.011);
      assert.equal(metrics.get(`ms_probe_pool_usage_ratio${label}`), 0.25);
      assert.equal(metrics.get(`ms_probe_spool_bytes${label}`), 2 * 1024 * 1024);
      assert.equal(metrics.get(`ms_probe_sensors_scheduled${label}`), 120);
    });

    it('names the probe once, in an info series rather than on every metric', async () => {
      // A label repeated on twenty series is twenty copies of a string that changes the moment
      // somebody renames a probe.
      const body = (await exporter().scrape()).body;
      assert.match(
        body,
        new RegExp(`ms_probe_info\\{probe="${String(probeId)}",name="scraped-probe"\\} 1`),
      );
      assert.equal(/ms_probe_connected\{[^}]*name=/.test(body), false);
    });

    it('includes the process metrics a Node dashboard already reads', async () => {
      // And does *not* re-spell them as channels of its own: `process_cpu_seconds_total` is a
      // total, so a scraper computes the rate over whatever window it likes rather than being
      // handed ours.
      const body = (await exporter().scrape()).body;
      assert.match(body, /ms_core_process_resident_memory_bytes/);
      assert.match(body, /ms_core_nodejs_heap_size_used_bytes/);
      assert.equal(/ms_core_cpu_ratio/.test(body), false, 'the standard series is the one to use');
    });

    it('declares a type and a help line for every series it invents', async () => {
      const body = (await exporter().scrape()).body;
      for (const name of ['ms_core_ingestion_queue_rows', 'ms_probe_connected']) {
        assert.match(body, new RegExp(`# HELP ${name} `));
        assert.match(body, new RegExp(`# TYPE ${name} `));
      }
    });

    it('declares the right type, since a `_total` gauge is a rate nobody can take', async () => {
      // `rate()` on a gauge is silently wrong rather than an error — it ignores resets, so a core
      // restart turns into a negative rate or a hole. The suffix is a naming convention and the
      // TYPE line is the part Prometheus acts on, so the two have to agree.
      const body = (await exporter().scrape()).body;
      for (const name of [
        'ms_core_ingestion_refused_rows_total',
        'ms_core_stream_cutoffs_total',
        'ms_core_dependency_pauses_total',
        'ms_core_alarm_steps_fired_total',
        'ms_core_probe_queries_refused_total',
      ]) {
        assert.match(body, new RegExp(`# TYPE ${name} counter`), name);
      }
      for (const name of ['ms_core_ingestion_queue_rows', 'ms_core_alarm_sweep_overdue_seconds']) {
        assert.match(body, new RegExp(`# TYPE ${name} gauge`), name);
      }
    });
  });

  describe('a gap is an absent series, never a zero', () => {
    it('exports one series for a probe that is not connected', async () => {
      // **Prometheus has no null**, so the honest translation of the no-data rule is to stop
      // exporting the series: a graph then breaks the line, exactly as ours does. A scheduler lag
      // of 0 s from a probe that has gone would be the most confidently wrong number this system
      // could publish.
      const metrics = parse((await exporter({ connected: false }).scrape()).body);
      const label = `{probe="${String(probeId)}"}`;
      assert.equal(metrics.get(`ms_probe_connected${label}`), 0);
      assert.equal(metrics.has(`ms_probe_scheduler_lag_p95_seconds${label}`), false);
      assert.equal(metrics.has(`ms_probe_sensors_scheduled${label}`), false);
      assert.equal(metrics.has(`ms_probe_memory_bytes${label}`), false);
    });

    it('stops exporting a series that had a value and lost it', async () => {
      // The failure a gauge makes easy: it keeps its last value for ever, so a probe that has
      // gone goes on reporting whatever it was doing when it left.
      const core = coreHealth();
      let link: ProbeLink = connected;
      const probe = probeHealth(link);
      const exports = new MetricsExporter({
        db,
        logger: silent,
        coreHealth: () => core,
        probeHealth: () =>
          new ProbeHealthService({
            db,
            logger: silent,
            sources: { link: () => link },
            ingest: () => Promise.resolve(),
          }),
      });
      void probe;

      const label = `{probe="${String(probeId)}"}`;
      assert.equal(
        parse((await exports.scrape()).body).get(`ms_probe_sensors_scheduled${label}`),
        120,
      );

      link = { connected: false };
      assert.equal(
        parse((await exports.scrape()).body).has(`ms_probe_sensors_scheduled${label}`),
        false,
        'the gauge kept its last value',
      );
    });
  });

  describe('counters', () => {
    /** An exporter whose probe link a test can move between scrapes. */
    const varying = (get: () => ProbeLink): MetricsExporter => {
      const core = coreHealth();
      const probe = new ProbeHealthService({
        db,
        logger: silent,
        sources: { link: () => get() },
        ingest: () => Promise.resolve(),
      });
      return new MetricsExporter({
        db,
        logger: silent,
        coreHealth: () => core,
        probeHealth: () => probe,
      });
    };

    it('does not move while the source counter does not', async () => {
      const exports = varying(() => connected);
      const first = parse((await exports.scrape()).body);
      const second = parse((await exports.scrape()).body);
      assert.equal(first.get('ms_core_ingestion_refused_rows_total'), 7);
      assert.equal(second.get('ms_core_ingestion_refused_rows_total'), 7);
    });

    it('exports a counter the probe reported as zero, rather than omitting it', async () => {
      // Found live. A labelled counter does not exist until something touches it, so skipping a
      // zero delta left `ms_probe_checks_refused_total` absent on a probe that had refused
      // nothing — indistinguishable from a probe that never reported. A reported zero is a
      // reading; only a missing reading is an absent series. It is also the baseline `rate()`
      // and any "no data" alert need to start from.
      const metrics = parse((await varying(() => connected).scrape()).body);
      const label = `{probe="${String(probeId)}"}`;
      assert.equal(metrics.get(`ms_probe_checks_timed_out_total${label}`), 0);
      assert.equal(metrics.get(`ms_probe_worker_crashes_total${label}`), 0);
    });

    it('still omits a counter the probe did not report at all', async () => {
      // The other half. A probe that is gone reports nothing, and nothing is not zero.
      const metrics = parse((await varying(() => ({ connected: false })).scrape()).body);
      const label = `{probe="${String(probeId)}"}`;
      assert.equal(metrics.has(`ms_probe_checks_timed_out_total${label}`), false);
    });

    it('follows the source counter upwards', async () => {
      let deferred = 7;
      const link = (): ProbeLink => ({
        ...connected,
        health: { ...connected.health, deferred },
      });
      const exports = varying(link);
      const label = `{probe="${String(probeId)}"}`;

      assert.equal(
        parse((await exports.scrape()).body).get(`ms_probe_checks_deferred_total${label}`),
        7,
      );
      deferred = 19;
      assert.equal(
        parse((await exports.scrape()).body).get(`ms_probe_checks_deferred_total${label}`),
        19,
      );
    });

    it('keeps the total honest when the probe restarts and its counter goes back to zero', async () => {
      // Exporting the source value directly would make the series go *backwards*, which
      // Prometheus reads as this exporter having restarted; freezing it would hide every check
      // deferred afterwards. The whole new value is new activity, so the total keeps climbing —
      // `T-02`'s rule for a counter that went backwards, applied one layer up.
      let deferred = 100;
      const link = (): ProbeLink => ({
        ...connected,
        health: { ...connected.health, deferred },
      });
      const exports = varying(link);
      const label = `{probe="${String(probeId)}"}`;

      await exports.scrape();
      deferred = 5;
      const after = parse((await exports.scrape()).body);
      assert.equal(
        after.get(`ms_probe_checks_deferred_total${label}`),
        105,
        'the exported total never goes backwards',
      );
    });
  });

  describe('the route', () => {
    const serve = async (options: {
      metrics?: () => MetricsExporter | undefined;
      required: boolean;
    }): Promise<FastifyInstance> => {
      const harness = await buildHarness(db);
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
        service: harness.service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
        ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
        auth: {
          accounts: new AccountService({ db, logger: silent }),
          sessions: new SessionService({ db, logger: silent }),
          throttle: new LoginThrottle({ db, logger: silent, sleep: () => Promise.resolve() }),
          groups: new GroupService({ db, logger: silent }),
          access: new AccessService({ db, logger: silent }),
          tokens: new TokenService({ db, logger: silent }),
          totp: new TotpService({ db, logger: silent }),
          required: options.required,
        },
      });
      await server.build('9.9.9', harness.service);
      return server.app;
    };

    it('serves the text format at /metrics, not under /api/v1', async () => {
      // The path every scraper config, service-discovery rule and Helm chart already assumes. A
      // monitoring system that made people configure a non-standard one would be picking a fight
      // it cannot win.
      const exports = exporter();
      const app = await serve({ metrics: () => exports, required: false });
      const response = await app.inject({ method: 'GET', url: '/metrics' });
      assert.equal(response.statusCode, 200);
      assert.match(response.headers['content-type'] ?? '', /text\/plain/);
      assert.match(response.body, /ms_core_ingestion_queue_rows/);
      await app.close();
    });

    it('refuses an unauthenticated scrape once authentication is on', async () => {
      // **The default is wrong here and had to be corrected explicitly.**
      // `registerAuthentication` guards paths under `/api/` only, because the app shell must be
      // public — so a route outside that prefix is public unless it says otherwise. The scrape
      // body carries every queue depth, the sensor count per probe and the probe names, which
      // together is a map of the installation.
      const exports = exporter();
      const app = await serve({ metrics: () => exports, required: true });
      const response = await app.inject({ method: 'GET', url: '/metrics' });
      assert.equal(response.statusCode, 401);
      assert.equal(/ms_core_/.test(response.body), false, 'and it leaks nothing on the way out');
      await app.close();
    });

    it('answers a scrape during start-up with a failure, not an empty body', async () => {
      // An empty body is recorded as "every series vanished", which is worse than a failed
      // scrape the collector will simply retry.
      const app = await serve({ metrics: () => undefined, required: false });
      const response = await app.inject({ method: 'GET', url: '/metrics' });
      assert.equal(response.statusCode, 503);
      assert.match(response.body, /still starting/);
      await app.close();
    });

    it('records its response-schema exemption where somebody will review it', async () => {
      // The guard is the structural half of the credential defence (`A-10`), and this route is
      // exempt because the Prometheus text format is not JSON to filter. An exemption nobody can
      // enumerate is an exemption nobody reviews, so it is listed and asserted.
      const exports = exporter();
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
        service: (await buildHarness(db)).service,
        history: new HistoryService({ db, logger: silent }),
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
        metrics: () => exports,
      });
      await server.build('9.9.9', (await buildHarness(db)).service);
      assert.deepEqual(server.unfilteredRoutes, ['GET /metrics']);
      await server.app.close();
    });

    it('is absent altogether in a build without an exporter', async () => {
      // A 404 an operator can diagnose, rather than an endpoint that answers with nothing.
      const app = await serve({ required: false });
      assert.equal((await app.inject({ method: 'GET', url: '/metrics' })).statusCode, 404);
      await app.close();
    });
  });
});
