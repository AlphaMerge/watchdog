import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { probeHealth as probeHealthType } from '@ms/sensors';
import { ApiServer } from '../src/api/server.js';
import { AccountService } from '../src/auth/accounts.js';
import { GroupService } from '../src/auth/groups.js';
import { AccessService } from '../src/auth/access.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { SessionService } from '../src/auth/sessions.js';
import { TokenService } from '../src/auth/tokens.js';
import { TotpService } from '../src/auth/totp.js';
import { AuditRepository, DatabaseAuditSink } from '../src/audit/store.js';
import { HistoryService } from '../src/timeseries/history.js';
import type {
  CoreHealthReading,
  CoreHealthService,
  CoreHealthSources,
} from '../src/health/core-health.js';
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
import { connectedLink, fixedCoreHealth, probeHealthOver } from './support/health.js';
import { everyVoucherHolds } from './support/vouching.js';

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

  const coreHealth = (): CoreHealthService => fixedCoreHealth(db);
  const probeHealth = (link: ProbeLink): ProbeHealthService => probeHealthOver(db, link);
  const connected = connectedLink;

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
      // `P-229`: the pool's limits. The oldest statement is read from `pg_stat_activity`, so it
      // is whatever this database is running, and a measurement rather than a gap either way.
      assert.equal(metrics.get('ms_core_db_statements_cancelled_total'), 4);
      assert.equal(metrics.get('ms_core_db_lock_waits_given_up_total'), 3);
      assert.ok((metrics.get('ms_core_db_oldest_statement_seconds') ?? -1) >= 0);
      // `P-290`: results refused, and readings dropped, for not fitting the protocol. Three from
      // batches and two from query answers (`P-300`).
      assert.equal(metrics.get('ms_core_results_refused_unfit_total'), 5);
      assert.equal(metrics.get('ms_core_readings_dropped_unfit_total'), 5);
      // `P-306`: channels created without what their type declares for them.
      assert.equal(metrics.get('ms_core_channels_created_undeclared_total'), 6);
      // `P-321`: channels created outside a declaration that promised every key.
      assert.equal(metrics.get('ms_core_channels_created_outside_declaration_total'), 7);
      // `P-358`: sensors whose stored parameters their type's current schema refuses. A gauge.
      assert.equal(metrics.get('ms_core_sensors_with_invalid_params'), 8);
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
        'ms_core_stream_probe_changes_coalesced_total',
        // `U-27`: what an edge did while the sign-in check could not answer it.
        'ms_core_stream_changes_unvetted_total',
        'ms_core_stream_sockets_held_back_total',
        'ms_core_stream_changes_sharing_check_total',
        'ms_core_dependency_pauses_total',
        'ms_core_alarm_steps_fired_total',
        'ms_core_probe_queries_refused_total',
        'ms_core_db_statements_cancelled_total',
        'ms_core_db_lock_waits_given_up_total',
        'ms_core_results_refused_unfit_total',
        'ms_core_readings_dropped_unfit_total',
        'ms_core_channels_created_undeclared_total',
        'ms_core_channels_created_outside_declaration_total',
      ]) {
        assert.match(body, new RegExp(`# TYPE ${name} counter`), name);
      }
      for (const name of [
        'ms_core_ingestion_queue_rows',
        'ms_core_alarm_sweep_overdue_seconds',
        'ms_core_sensors_owed_redecision',
        'ms_core_db_oldest_statement_seconds',
      ]) {
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
            vouching: everyVoucherHolds,
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

  describe('a core series with no reading (P-223)', () => {
    // The core's series carry no labels, and an unlabelled metric has a series at 0 from the
    // moment it exists. So these were exported as 0: disk free on a core whose database is on
    // another host, which fires a disk-low alert for ever, and a v1 core's report failures.
    it('leaves out a core gauge whose reading is a gap, rather than exporting zero', async () => {
      // The fixture's disk and limit are gaps: a database elsewhere, and no cgroup ceiling.
      const body = (await exporter().scrape()).body;
      for (const name of [
        'ms_core_disk_free_percent',
        'ms_core_memory_limit_usage_ratio',
        'ms_core_memory_limit_bytes',
      ]) {
        assert.equal(body.includes(name), false, `${name} was exported with no reading`);
      }
      assert.equal(parse(body).get('ms_core_ingestion_queue_rows'), 41, 'the control');
    });

    it('leaves out a v1 core’s report series, counters and gauges, which it does not run', async () => {
      const core = fixedCoreHealth(db, { reporting: false });
      const body = (
        await new MetricsExporter({
          db,
          logger: silent,
          coreHealth: () => core,
          probeHealth: () => undefined,
        }).scrape()
      ).body;
      for (const name of [
        'ms_core_reports_deferred_total',
        'ms_core_report_runs_failed_total',
        'ms_core_reports_undelivered',
        'ms_core_report_formats_waiting',
        'ms_core_report_formats_refused_total',
      ]) {
        assert.equal(
          body.includes(name),
          false,
          `${name} was exported on a core without reporting`,
        );
      }
      const full = parse((await exporter().scrape()).body);
      assert.equal(full.get('ms_core_report_runs_failed_total'), 3, 'the control: a full core');
    });

    it('exports a core series while it has a reading, and stops when it loses it', async () => {
      let disk: ReturnType<CoreHealthSources['disk']> = null;
      const core = fixedCoreHealth(db, { disk: () => disk });
      const exports = new MetricsExporter({
        db,
        logger: silent,
        coreHealth: () => core,
        probeHealth: () => undefined,
      });
      assert.equal(parse((await exports.scrape()).body).has('ms_core_disk_free_percent'), false);
      disk = { freePercent: 37.5, freeBytes: 1, databaseBytes: 1 };
      assert.equal(parse((await exports.scrape()).body).get('ms_core_disk_free_percent'), 37.5);
      disk = null;
      assert.equal(
        parse((await exports.scrape()).body).has('ms_core_disk_free_percent'),
        false,
        'it kept its last value, or went to zero',
      );
    });

    it('exports nothing of the core’s own when there is no Core Health to read', async () => {
      const body = (
        await new MetricsExporter({
          db,
          logger: silent,
          coreHealth: () => undefined,
          probeHealth: () => undefined,
        }).scrape()
      ).body;
      assert.equal(body.includes('ms_core_ingestion_queue_rows'), false);
      assert.match(body, /ms_core_process_resident_memory_bytes/, 'the process series stay');
    });

    it('exports only what it would without Core Health when every core reading is a gap', async (t) => {
      // Every channel at once, rather than the ones whose source can be null today, so a channel
      // added later is held to the rule without anyone remembering to list it here.
      const families = async (exports: MetricsExporter): Promise<Set<string>> =>
        new Set(
          (await exports.scrape()).body
            .split('\n')
            .filter((line) => line.startsWith('# TYPE ms_core_'))
            .map((line) => line.split(' ')[2] ?? ''),
        );
      const over = (core: CoreHealthService | undefined): MetricsExporter =>
        new MetricsExporter({
          db,
          logger: silent,
          coreHealth: () => core,
          probeHealth: () => undefined,
        });
      const core = fixedCoreHealth(db);
      const read = core.read.bind(core);
      const gapped = t.mock.method(
        core,
        'read',
        async (...args: Parameters<CoreHealthService['read']>): Promise<CoreHealthReading> =>
          Object.fromEntries(Object.keys(await read(...args)).map((key) => [key, null])),
      );
      const without = await families(over(undefined));
      const exported = [...(await families(over(core)))].filter((name) => !without.has(name));
      assert.deepEqual(exported, [], 'a core series exported with no reading');
      assert.equal(gapped.mock.callCount(), 1, 'the control: the gapped reading was the one read');
      assert.ok((await families(over(fixedCoreHealth(db)))).size > without.size, 'the control');
    });
  });

  describe('counters', () => {
    /** An exporter whose probe link a test can move between scrapes. */
    const varying = (get: () => ProbeLink): MetricsExporter => {
      const core = coreHealth();
      const probe = new ProbeHealthService({
        vouching: everyVoucherHolds,
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

    it('exports what a flow collector’s buffer overwrote unread, apart from what it missed', async () => {
      // `B-11`. Two different losses and two series; a probe with no collector has neither.
      const label = `{probe="${String(probeId)}"}`;
      const flowing = (): ProbeLink => ({
        ...connected,
        health: { ...connected.health, flowMissed: 61, flowOverwritten: 250 },
      });
      const metrics = parse((await varying(flowing).scrape()).body);
      assert.equal(metrics.get(`ms_probe_flows_overwritten_total${label}`), 250);
      assert.equal(metrics.get(`ms_probe_flows_missed_total${label}`), 61);

      const without = parse((await varying(() => connected).scrape()).body);
      assert.equal(without.has(`ms_probe_flows_overwritten_total${label}`), false);
    });

    it('exports what the trap and syslog buffers overwrote unread, each as its own series', async () => {
      // `B-14`. Beside `ms_probe_flows_overwritten_total`; a probe that sent neither has neither.
      const label = `{probe="${String(probeId)}"}`;
      const lossy = (): ProbeLink => ({
        ...connected,
        health: { ...connected.health, trapOverwritten: 1_300, syslogOverwritten: 75 },
      });
      const metrics = parse((await varying(lossy).scrape()).body);
      assert.equal(metrics.get(`ms_probe_traps_overwritten_total${label}`), 1_300);
      assert.equal(metrics.get(`ms_probe_syslog_overwritten_total${label}`), 75);

      const without = parse((await varying(() => connected).scrape()).body);
      assert.equal(without.has(`ms_probe_traps_overwritten_total${label}`), false);
      assert.equal(without.has(`ms_probe_syslog_overwritten_total${label}`), false);
    });

    it('exports the child checks that never started, and the p95 of a start in seconds', async () => {
      // `P-260`. Beside the other child-process series; a probe that sent neither has neither.
      const label = `{probe="${String(probeId)}"}`;
      const starved = (): ProbeLink => ({
        ...connected,
        health: {
          ...connected.health,
          childStartupFailed: 6,
          childStartupMs: { p50: 25, p95: 9_400, p99: 14_800, max: 30_000 },
        },
      });
      const metrics = parse((await varying(starved).scrape()).body);
      assert.equal(metrics.get(`ms_probe_child_checks_not_started_total${label}`), 6);
      assert.equal(metrics.get(`ms_probe_child_startup_p95_seconds${label}`), 9.4);

      const without = parse((await varying(() => connected).scrape()).body);
      assert.equal(without.has(`ms_probe_child_checks_not_started_total${label}`), false);
      assert.equal(without.has(`ms_probe_child_startup_p95_seconds${label}`), false);
    });

    it('exports the workers the pool could not start, and nothing for a probe that sent none', async () => {
      // `P-263`. Beside the worker crashes; a hang the pool ended is not one of them.
      const label = `{probe="${String(probeId)}"}`;
      const hung = (): ProbeLink => ({
        ...connected,
        health: { ...connected.health, workerStartupFailed: 4 },
      });
      const metrics = parse((await varying(hung).scrape()).body);
      assert.equal(metrics.get(`ms_probe_workers_not_started_total${label}`), 4);

      const without = parse((await varying(() => connected).scrape()).body);
      assert.equal(without.has(`ms_probe_workers_not_started_total${label}`), false);
    });

    it('exports the probe’s name lookups, and nothing for a probe that sent none', async () => {
      // `A-66`. Distinct values, so a series reading its neighbour's field is seen.
      const label = `{probe="${String(probeId)}"}`;
      const stuck = (): ProbeLink => ({
        ...connected,
        health: { ...connected.health, lookupsInFlight: 37, lookupsGivenUp: 1_250 },
      });
      const scraped = (await varying(stuck).scrape()).body;
      const metrics = parse(scraped);
      assert.equal(metrics.get(`ms_probe_name_lookups_in_flight${label}`), 37);
      assert.equal(metrics.get(`ms_probe_name_lookups_given_up_total${label}`), 1_250);
      // `P-426` redefined given up in place: checks failed for want of an answer, most of them at
      // once during an outage, not lookups waited for to their bound.
      assert.match(
        scraped,
        /^# HELP ms_probe_name_lookups_given_up_total Checks that failed for want of an answer from the probe’s resolver, .*failed them at once \(EAI_AGAIN, a name it holds, every lane stuck, or a full queue\)\.$/mu,
      );

      const without = parse((await varying(() => connected).scrape()).body);
      assert.equal(without.has(`ms_probe_name_lookups_in_flight${label}`), false);
      assert.equal(without.has(`ms_probe_name_lookups_given_up_total${label}`), false);
    });

    it('exports the name answers a probe loaded at start, a zero included, and nothing for one that sent none', async () => {
      // `P-438`.
      const label = `{probe="${String(probeId)}"}`;
      const loaded = (answersLoaded: number) => (): ProbeLink => ({
        ...connected,
        health: { ...connected.health, lookupsGivenUp: 1_250, answersLoaded },
      });
      const metrics = parse((await varying(loaded(450)).scrape()).body);
      assert.equal(metrics.get(`ms_probe_name_answers_loaded${label}`), 450);
      assert.equal(metrics.get(`ms_probe_name_lookups_given_up_total${label}`), 1_250);
      const cold = parse((await varying(loaded(0)).scrape()).body);
      assert.equal(cold.get(`ms_probe_name_answers_loaded${label}`), 0);
      const without = parse((await varying(() => connected).scrape()).body);
      assert.equal(without.has(`ms_probe_name_answers_loaded${label}`), false);
    });

    it('exports how a probe resolves names, gate mode’s own beside it, and nothing for one that sent none (`P-432`)', async () => {
      const label = `{probe="${String(probeId)}"}`;
      const gate = (): ProbeLink => ({
        ...connected,
        health: {
          ...connected.health,
          nameResolverMode: 2,
          lookupHelperTrouble: 1,
          nameCheckOnSeconds: 3_600,
          namePassedStuck: 4,
          nameHelperStuck: 9,
          nameQuestionsOpen: 12,
        },
      });
      const metrics = parse((await varying(gate).scrape()).body);
      assert.equal(metrics.get(`ms_probe_name_resolver_mode${label}`), 2);
      assert.equal(metrics.get(`ms_probe_lookup_helper_trouble${label}`), 1);
      assert.equal(metrics.get(`ms_probe_name_check_on_seconds_total${label}`), 3_600);
      assert.equal(metrics.get(`ms_probe_name_lookups_passed_stuck_total${label}`), 4);
      assert.equal(metrics.get(`ms_probe_lookup_helper_stuck_total${label}`), 9);
      assert.equal(metrics.get(`ms_probe_dns_questions_open${label}`), 12);
      // `system` mode sends its mode alone.
      const system = parse(
        (
          await varying(() => ({
            ...connected,
            health: { ...connected.health, nameResolverMode: 1 },
          })).scrape()
        ).body,
      );
      assert.equal(system.get(`ms_probe_name_resolver_mode${label}`), 1);
      assert.equal(system.has(`ms_probe_lookup_helper_trouble${label}`), false);
      assert.equal(system.has(`ms_probe_dns_questions_open${label}`), false);
      const without = parse((await varying(() => connected).scrape()).body);
      assert.equal(without.has(`ms_probe_name_resolver_mode${label}`), false);
    });

    it('exports the readings a probe could not send, and nothing for a probe that sent none', async () => {
      // `P-283`. Distinct values, so a series reading its neighbour's field is seen.
      const label = `{probe="${String(probeId)}"}`;
      const lost = (): ProbeLink => ({
        ...connected,
        health: {
          ...connected.health,
          resultChannelsDropped: 17,
          spoolRejected: 40,
          spoolOversized: 2,
        },
      });
      const metrics = parse((await varying(lost).scrape()).body);
      assert.equal(metrics.get(`ms_probe_readings_unsendable_total${label}`), 17);
      assert.equal(metrics.get(`ms_probe_spool_rejected_total${label}`), 40);
      assert.equal(metrics.get(`ms_probe_spool_oversized_total${label}`), 2);

      const without = parse((await varying(() => connected).scrape()).body);
      for (const name of [
        'ms_probe_readings_unsendable_total',
        'ms_probe_spool_rejected_total',
        'ms_probe_spool_oversized_total',
      ]) {
        assert.equal(without.has(`${name}${label}`), false, name);
      }
    });

    it('exports the script groups a dead check process left open, and nothing for a probe that sent none', async () => {
      // `P-275`. Distinct values, so a series reading its neighbour's field is seen.
      const label = `{probe="${String(probeId)}"}`;
      const left = (): ProbeLink => ({
        ...connected,
        health: {
          ...connected.health,
          scriptGroupsEnded: 8,
          scriptGroupsRefused: 1,
          scriptGroupsRecycled: 3,
        },
      });
      const metrics = parse((await varying(left).scrape()).body);
      assert.equal(metrics.get(`ms_probe_script_groups_ended_total${label}`), 8);
      assert.equal(metrics.get(`ms_probe_script_groups_refused_total${label}`), 1);
      assert.equal(metrics.get(`ms_probe_script_groups_left_alone_total${label}`), 3);

      const without = parse((await varying(() => connected).scrape()).body);
      for (const name of [
        'ms_probe_script_groups_ended_total',
        'ms_probe_script_groups_refused_total',
        'ms_probe_script_groups_left_alone_total',
      ]) {
        assert.equal(without.has(`${name}${label}`), false, name);
      }
    });

    it('exports what each listener kept out of a first scan, and nothing for a probe that sent none', async () => {
      // `P-270`. Beside each listener's overwritten count, and not added to it.
      const label = `{probe="${String(probeId)}"}`;
      const resumed = (): ProbeLink => ({
        ...connected,
        health: {
          ...connected.health,
          trapOverwritten: 1_300,
          trapEarlier: 357,
          syslogEarlier: 1_200,
          flowEarlier: 9_000,
        },
      });
      const metrics = parse((await varying(resumed).scrape()).body);
      assert.equal(metrics.get(`ms_probe_traps_before_first_scan_total${label}`), 357);
      assert.equal(metrics.get(`ms_probe_syslog_before_first_scan_total${label}`), 1_200);
      assert.equal(metrics.get(`ms_probe_flows_before_first_scan_total${label}`), 9_000);
      assert.equal(metrics.get(`ms_probe_traps_overwritten_total${label}`), 1_300);

      const without = parse((await varying(() => connected).scrape()).body);
      for (const name of [
        'ms_probe_traps_before_first_scan_total',
        'ms_probe_syslog_before_first_scan_total',
        'ms_probe_flows_before_first_scan_total',
      ]) {
        assert.equal(without.has(`${name}${label}`), false, name);
      }
    });

    it('exports each listener’s malformed count beside its received count (`B-16`)', async () => {
      const label = `{probe="${String(probeId)}"}`;
      // Distinct values, so a series reading its neighbour's channel is seen.
      const SERIES = [
        ['trapReceived', 'ms_probe_traps_received_total', 900],
        ['trapMalformed', 'ms_probe_traps_malformed_total', 41],
        ['syslogReceived', 'ms_probe_syslog_received_total', 5_000],
        ['syslogMalformed', 'ms_probe_syslog_malformed_total', 17],
        ['flowReceived', 'ms_probe_flows_received_total', 70_000],
        ['flowMalformed', 'ms_probe_flows_malformed_total', 3],
      ] as const;
      const listening = (): ProbeLink => ({
        ...connected,
        health: {
          ...connected.health,
          trapReceived: 900,
          trapMalformed: 41,
          syslogReceived: 5_000,
          syslogMalformed: 17,
          flowReceived: 70_000,
          flowMalformed: 3,
        },
      });
      const scrape = (await varying(listening).scrape()).body;
      const metrics = parse(scrape);
      for (const [, name, value] of SERIES) assert.equal(metrics.get(`${name}${label}`), value);
      // One family each: HELP and TYPE once, and a counter.
      const lines = scrape.split('\n');
      for (const [, name] of SERIES) {
        assert.equal(lines.filter((line) => line.startsWith(`# HELP ${name} `)).length, 1, name);
        assert.deepEqual(
          lines.filter((line) => line.startsWith(`# TYPE ${name} `)),
          [`# TYPE ${name} counter`],
        );
      }

      // A reported zero is a reading; a probe running no listener has no series, not a zero.
      const quiet = (): ProbeLink => ({
        ...connected,
        health: { ...connected.health, trapMalformed: 0, syslogMalformed: 0, flowMalformed: 0 },
      });
      const zeroed = parse((await varying(quiet).scrape()).body);
      const without = parse((await varying(() => connected).scrape()).body);
      for (const [field, name] of SERIES) {
        if (!field.endsWith('Malformed')) continue;
        assert.equal(
          zeroed.get(`${name}${label}`),
          0,
          `${name} for a listener that discarded none`,
        );
        assert.equal(without.has(`${name}${label}`), false, `${name} with no listener`);
      }
    });

    it('has one series for every listener channel Probe Health declares (`B-16`)', async () => {
      // The exporter's table is private, so it is read through a scrape: a probe that reported
      // every listener channel has that many `ms_probe_(traps|syslog|flows)_` series, each
      // carrying its own channel's value.
      const keys = probeHealthType
        .channels({})
        .map((channel) => channel.key)
        .filter((key) => /^(trap|syslog|flow)[A-Z]/.test(key));
      assert.ok(keys.length >= 14, `found ${String(keys.length)} listener channels`);
      const all = (): ProbeLink => ({
        ...connected,
        health: {
          ...connected.health,
          ...Object.fromEntries(keys.map((key, index) => [key, 1_000 + index])),
        },
      });
      const metrics = parse((await varying(all).scrape()).body);
      const exported = [...metrics.entries()]
        .filter(([name]) => /^ms_probe_(traps|syslog|flows)_/.test(name))
        .map(([, value]) => value)
        .sort((a, b) => a - b);
      assert.deepEqual(
        exported,
        keys.map((_, index) => 1_000 + index),
        'each listener channel is one series, carrying its own value',
      );
    });

    it('exports a probe’s results dropped for withheld sensors, and its version flap, and neither where nothing knows them (`A-72`)', async () => {
      const label = `{probe="${String(probeId)}"}`;
      let dropped = 2;
      let changes: number | null = 5;
      const core = coreHealth();
      const probe = new ProbeHealthService({
        vouching: everyVoucherHolds,
        db,
        logger: silent,
        sources: {
          link: () => connected,
          withheldResults: () => dropped,
          protocolFlap: () =>
            changes === null
              ? null
              : { version: 24, floor: 23, changes, sinceMs: 60_000, remainingMs: 60_000 },
        },
        ingest: () => Promise.resolve(),
      });
      const exports = new MetricsExporter({
        db,
        logger: silent,
        coreHealth: () => core,
        probeHealth: () => probe,
      });
      const first = (await exports.scrape()).body;
      assert.equal(parse(first).get(`ms_probe_results_withheld_total${label}`), 2);
      assert.equal(parse(first).get(`ms_probe_protocol_flap_changes${label}`), 5);
      assert.match(first, /^# TYPE ms_probe_results_withheld_total counter$/mu);
      assert.match(first, /^# TYPE ms_probe_protocol_flap_changes gauge$/mu);
      dropped = 3;
      changes = null;
      const second = parse((await exports.scrape()).body);
      assert.equal(second.get(`ms_probe_results_withheld_total${label}`), 3);
      assert.equal(second.get(`ms_probe_protocol_flap_changes${label}`), 0, 'no flap is a 0');

      const without = parse((await varying(() => connected).scrape()).body);
      assert.equal(without.has(`ms_probe_results_withheld_total${label}`), false);
      assert.equal(without.has(`ms_probe_protocol_flap_changes${label}`), false);
    });

    it('exports a probe’s late refusals apart from the reports refused from it (`A-56`)', async () => {
      const label = `{probe="${String(probeId)}"}`;
      let late = 3;
      const core = coreHealth();
      const probe = new ProbeHealthService({
        vouching: everyVoucherHolds,
        db,
        logger: silent,
        sources: {
          link: () => connected,
          refusals: () => ({ refused: 9, foreignRecently: 0 }),
          lateRefusals: () => late,
        },
        ingest: () => Promise.resolve(),
      });
      const exports = new MetricsExporter({
        db,
        logger: silent,
        coreHealth: () => core,
        probeHealth: () => probe,
      });
      const first = (await exports.scrape()).body;
      assert.equal(parse(first).get(`ms_probe_late_refusals_total${label}`), 3);
      assert.equal(parse(first).get(`ms_probe_reports_refused_total${label}`), 9);
      assert.match(first, /^# TYPE ms_probe_late_refusals_total counter$/mu);
      assert.match(first, /^# TYPE ms_probe_reports_refused_total counter$/mu);
      late = 5;
      const second = parse((await exports.scrape()).body);
      assert.equal(second.get(`ms_probe_late_refusals_total${label}`), 5);
      assert.equal(second.get(`ms_probe_reports_refused_total${label}`), 9);

      // A core that does not count them exports neither: absent, not zero.
      const without = parse((await varying(() => connected).scrape()).body);
      assert.equal(without.has(`ms_probe_late_refusals_total${label}`), false);
      assert.equal(without.has(`ms_probe_reports_refused_total${label}`), false);
    });

    it('exports the late-refusal record’s given-up writes as a core counter, and nothing where they are not counted (`A-68`)', async () => {
      let givenUp = 2;
      const core = fixedCoreHealth(db, { lateRefusalWritesGivenUp: () => givenUp });
      const exports = new MetricsExporter({
        db,
        logger: silent,
        coreHealth: () => core,
        probeHealth: () => undefined,
      });
      const first = (await exports.scrape()).body;
      assert.equal(parse(first).get('ms_core_late_refusal_writes_given_up_total'), 2);
      assert.match(first, /^# TYPE ms_core_late_refusal_writes_given_up_total counter$/mu);
      assert.match(first, /^# HELP ms_core_late_refusal_writes_given_up_total \S/mu);
      givenUp = 5;
      assert.equal(
        parse((await exports.scrape()).body).get('ms_core_late_refusal_writes_given_up_total'),
        5,
      );
      // A core with no source for it exports no series: absent, not zero.
      assert.equal(
        parse((await exporter().scrape()).body).has('ms_core_late_refusal_writes_given_up_total'),
        false,
      );
    });

    it('exports the probe hellos refused unproven as a core counter, and nothing without a registry (`P-319`)', async () => {
      let refused = 3;
      const core = fixedCoreHealth(db, { probeHellosUnproven: () => refused });
      const exports = new MetricsExporter({
        db,
        logger: silent,
        coreHealth: () => core,
        probeHealth: () => undefined,
      });
      const first = (await exports.scrape()).body;
      assert.equal(parse(first).get('ms_core_probe_hellos_unproven_total'), 3);
      assert.match(first, /^# TYPE ms_core_probe_hellos_unproven_total counter$/mu);
      assert.match(first, /^# HELP ms_core_probe_hellos_unproven_total \S/mu);
      refused = 8;
      assert.equal(
        parse((await exports.scrape()).body).get('ms_core_probe_hellos_unproven_total'),
        8,
      );
      assert.equal(
        parse((await exporter().scrape()).body).has('ms_core_probe_hellos_unproven_total'),
        false,
      );
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
          accounts: new AccountService({ audit: new DatabaseAuditSink(), db, logger: silent }),
          sessions: new SessionService({ db, logger: silent }),
          throttle: new LoginThrottle({ db, logger: silent, sleep: () => Promise.resolve() }),
          groups: new GroupService({ audit: new DatabaseAuditSink(), db, logger: silent }),
          access: new AccessService({ db, audit: new DatabaseAuditSink(), logger: silent }),
          tokens: new TokenService({ audit: new DatabaseAuditSink(), db, logger: silent }),
          totp: new TotpService({ audit: new DatabaseAuditSink(), db, logger: silent }),
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
