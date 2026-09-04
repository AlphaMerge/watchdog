import { Counter, Gauge, Registry, collectDefaultMetrics } from '@prometheus-io/client';
import type { Logger } from '@ms/shared';
import { CpuMeter } from '@ms/shared';
import type { Database } from '../db/pool.js';
import type { CoreHealthService } from '../health/core-health.js';
import type { ProbeHealthService } from '../health/probe-health.js';

/**
 * Everything `P-04`, `P-12` and `P-13` measure, for an external scraper (`P-14`).
 *
 * **Read from the health services rather than from the subsystems again**, which is the same rule
 * `N-13` set for delivery health: a second implementation of a health question is a second answer
 * to it, and the day they disagree is the day nobody trusts either. So `/metrics` and the Core
 * Health and Probe Health sensors are the same numbers, from the same call, differing only in how
 * they are spelled.
 *
 * **A gap is an absent series, never a zero.** Prometheus has no null, and the honest translation
 * of `CLAUDE.md`'s no-data rule is to stop exporting the series for that scrape: a graph then
 * breaks the line, exactly as ours does. Every gauge is therefore reset before each collection and
 * set only where there is a reading — a gauge that kept its last value would report a probe that
 * has gone as still running at whatever it was doing when it left.
 *
 * **Base units, because that is what every dashboard and alert assumes.** Milliseconds become
 * seconds, megabytes become bytes, percentages become ratios. The channels keep their own units,
 * which are the ones an operator reads on a graph; these are the ones `rate()` and `histogram`
 * arithmetic assume.
 *
 * **CPU, memory, heap and uptime for the *core* are deliberately not re-exported.** `prom-client`'s
 * default collector already provides `process_resident_memory_bytes`, `nodejs_heap_size_used_bytes`
 * and `process_cpu_seconds_total`, which is what a Prometheus user's existing dashboards already
 * read — and `process_cpu_seconds_total` is a total, so a scraper computes the rate over whatever
 * window it likes rather than being handed ours. Shipping a worse duplicate of a standard metric
 * helps nobody. The *probe's* process numbers have no such standard series, because the probe is a
 * different process on a different machine, so those are exported.
 */

export interface MetricsExporterOptions {
  readonly db: Database;
  readonly logger: Logger;
  readonly coreHealth: () => CoreHealthService | undefined;
  readonly probeHealth: () => ProbeHealthService | undefined;
}

/** One channel, and how it is spelled for Prometheus. */
interface Metric {
  /** The channel key on the health sensor. */
  readonly key: string;
  readonly name: string;
  readonly help: string;
  /** Multiplied by this on the way out — ms → s, MB → bytes, % → ratio. */
  readonly scale?: number;
  /**
   * A monotonic counter rather than a gauge.
   *
   * Exported by *delta*, so that a probe restarting mid-scrape-interval does not export a series
   * that goes backwards. A counter that jumped from 5,000 to 0 and stayed flat would hide every
   * check deferred after the restart; adding the whole new value instead keeps the total honest.
   */
  readonly counter?: boolean;
}

const MS = 1 / 1_000;
const MB = 1024 * 1024;
const PERCENT = 1 / 100;

const CORE_METRICS: readonly Metric[] = [
  {
    key: 'ingestQueue',
    name: 'ms_core_ingestion_queue_rows',
    help: 'Readings accepted and not yet written. Zero while the core is keeping up.',
  },
  {
    key: 'writeLatency',
    name: 'ms_core_db_write_p95_seconds',
    help: 'Database write latency, 95th percentile over the last 1,024 writes.',
    scale: MS,
  },
  {
    key: 'ingestRefused',
    name: 'ms_core_ingestion_refused_rows_total',
    help: 'Readings turned away because the ingestion queue was full.',
    counter: true,
  },
  {
    key: 'rollupLag',
    name: 'ms_core_rollup_lag_seconds',
    help: 'How far the worst rollup tier is behind, beyond its own bucket width.',
  },
  {
    key: 'backfillQueue',
    name: 'ms_core_rollup_backfill_windows',
    help: 'Windows waiting to be rolled up again after late data arrived.',
  },
  {
    key: 'diskFree',
    name: 'ms_core_disk_free_percent',
    help: 'Free space on the filesystem holding the readings. Absent where the core cannot say.',
  },
  {
    key: 'databaseSize',
    name: 'ms_core_database_bytes',
    help: 'What this installation’s database occupies.',
    scale: MB,
  },
  {
    key: 'evictedChunks',
    name: 'ms_core_evicted_chunks_total',
    help: 'Chunks dropped ahead of their configured retention because the disk was filling.',
    counter: true,
  },
  {
    key: 'reapQueue',
    name: 'ms_core_channel_reap_queue',
    help: 'Channels whose rows are still being deleted after their sensor went.',
  },
  {
    key: 'notifyPending',
    name: 'ms_core_notifications_pending',
    help: 'Notifications owed and not yet delivered.',
  },
  {
    key: 'notifyOldest',
    name: 'ms_core_notification_oldest_seconds',
    help: 'How long the oldest undelivered notification has been waiting.',
  },
  {
    key: 'notifyFailed',
    name: 'ms_core_notifications_failed',
    help: 'Notifications given up on in the last hour. Each one is an alarm nobody received.',
  },
  {
    key: 'streamCutoffs',
    name: 'ms_core_stream_cutoffs_total',
    help: 'Live-state subscribers cut off for falling behind.',
    counter: true,
  },
  {
    key: 'dependencyPauses',
    name: 'ms_core_dependency_pauses_total',
    help: 'Sensors paused or released because a master sensor moved.',
    counter: true,
  },
  {
    key: 'probesDown',
    name: 'ms_core_probes_disconnected',
    help: 'Approved probes the core currently has no connection from.',
  },
  {
    key: 'alarmOverdue',
    name: 'ms_core_alarm_sweep_overdue_seconds',
    help: 'How late the alarm scheduler is for the sweep it said it would run. Zero when idle.',
  },
  {
    key: 'alarmsFired',
    name: 'ms_core_alarm_steps_fired_total',
    help: 'Notification steps the alarm scheduler has fired. Its rate is the alarm rate.',
    counter: true,
  },
  {
    key: 'queriesRefused',
    name: 'ms_core_probe_queries_refused_total',
    help: 'On-demand checks turned away because too many were already in flight.',
    counter: true,
  },
];

const PROBE_METRICS: readonly Metric[] = [
  {
    key: 'connected',
    name: 'ms_probe_connected',
    help: '1 when the core has a connection from this probe, 0 when it has none.',
  },
  {
    key: 'heartbeatAge',
    name: 'ms_probe_heartbeat_age_seconds',
    help: 'Time since this probe’s last heartbeat.',
  },
  {
    key: 'protocol',
    name: 'ms_probe_protocol_skew',
    help: '0 the same as the core, 1 older, 2 incompatible.',
  },
  {
    key: 'schedulerLag',
    name: 'ms_probe_scheduler_lag_p95_seconds',
    help: 'How late the timing wheel fired, 95th percentile over the last 1,024 ticks.',
    scale: MS,
  },
  {
    key: 'poolUsage',
    name: 'ms_probe_pool_usage_ratio',
    help: 'Worker slots in use, as a fraction of the pool.',
    scale: PERCENT,
  },
  { key: 'queued', name: 'ms_probe_checks_queued', help: 'Checks waiting for a worker slot.' },
  {
    key: 'checkWait',
    name: 'ms_probe_check_wait_p95_seconds',
    help: 'How long a check waited for a slot, 95th percentile.',
    scale: MS,
  },
  {
    key: 'deferred',
    name: 'ms_probe_checks_deferred_total',
    help: 'Checks skipped because the previous scan of that sensor had not finished.',
    counter: true,
  },
  {
    key: 'refused',
    name: 'ms_probe_checks_refused_total',
    help: 'Checks turned away because the queue was full.',
    counter: true,
  },
  {
    key: 'timedOut',
    name: 'ms_probe_checks_timed_out_total',
    help: 'Checks killed at their timeout.',
    counter: true,
  },
  {
    key: 'workerCrashes',
    name: 'ms_probe_worker_crashes_total',
    help: 'Worker threads that died and were recycled.',
    counter: true,
  },
  {
    key: 'scheduled',
    name: 'ms_probe_sensors_scheduled',
    help: 'Sensors this probe currently has on its wheel.',
  },
  // The child-process runner (`P-61`). Separate series from the pool's, because EXE and Script
  // checks never touch the pool and the two saturate at completely different loads — summing
  // them would hide whichever is healthy behind whichever is not.
  {
    key: 'childBusy',
    name: 'ms_probe_child_processes_running',
    help: 'Check child processes running right now.',
  },
  {
    key: 'childQueued',
    name: 'ms_probe_child_checks_queued',
    help: 'Checks waiting for a child-process slot.',
  },
  {
    key: 'childDeferred',
    name: 'ms_probe_child_checks_deferred_total',
    help: 'Child-process checks skipped because the previous scan had not finished.',
    counter: true,
  },
  {
    key: 'childRefused',
    name: 'ms_probe_child_checks_refused_total',
    help: 'Child-process checks turned away because the queue was full.',
    counter: true,
  },
  {
    key: 'childTimedOut',
    name: 'ms_probe_child_checks_timed_out_total',
    help: 'Child-process checks killed at their timeout.',
    counter: true,
  },
  {
    key: 'childCrashes',
    name: 'ms_probe_child_process_crashes_total',
    help: 'Check child processes that died without producing a result.',
    counter: true,
  },
  {
    key: 'spoolDepth',
    name: 'ms_probe_spool_results',
    help: 'Results written to disk and not yet acknowledged by the core.',
  },
  { key: 'spoolBytes', name: 'ms_probe_spool_bytes', help: 'Spool size on disk.', scale: MB },
  {
    key: 'spoolDropped',
    name: 'ms_probe_spool_dropped_total',
    help: 'Results evicted to stay inside the spool cap. Each one no longer exists anywhere.',
    counter: true,
  },
  {
    key: 'clockJumps',
    name: 'ms_probe_clock_jumps_total',
    help: 'Times the timing wheel resynchronised against a clock that moved.',
    counter: true,
  },
  {
    key: 'cpu',
    name: 'ms_probe_cpu_ratio',
    help: 'Probe process CPU, as a fraction of one core. Above 1 on more than one thread.',
    scale: PERCENT,
  },
  {
    key: 'memory',
    name: 'ms_probe_memory_bytes',
    help: 'Probe process resident memory.',
    scale: MB,
  },
  { key: 'uptime', name: 'ms_probe_uptime_seconds', help: 'Seconds since the probe started.' },
];

const PROBE_LABEL = 'probe';

export class MetricsExporter {
  readonly #options: MetricsExporterOptions;
  readonly #registry = new Registry();
  readonly #coreGauges = new Map<string, Gauge<string>>();
  readonly #coreCounters = new Map<string, Counter<string>>();
  readonly #probeGauges = new Map<string, Gauge<string>>();
  readonly #probeCounters = new Map<string, Counter<string>>();
  readonly #info: Gauge<string>;
  /** Its own CPU baseline, so a scrape does not shorten the recorded sensor's window. */
  readonly #cpu = new CpuMeter();
  /** The last absolute value seen per counter, keyed by metric and probe, for delta export. */
  readonly #lastCounter = new Map<string, number>();

  constructor(options: MetricsExporterOptions) {
    this.#options = options;

    // The Node process's own numbers, under the same prefix. These are the series a Prometheus
    // user's existing Node dashboards already read, which is exactly why they are not re-spelled.
    collectDefaultMetrics({ register: this.#registry, prefix: 'ms_core_' });

    for (const metric of CORE_METRICS) {
      if (metric.counter === true) {
        this.#coreCounters.set(
          metric.key,
          new Counter({ name: metric.name, help: metric.help, registers: [this.#registry] }),
        );
      } else {
        this.#coreGauges.set(
          metric.key,
          new Gauge({ name: metric.name, help: metric.help, registers: [this.#registry] }),
        );
      }
    }
    for (const metric of PROBE_METRICS) {
      const config = {
        name: metric.name,
        help: metric.help,
        labelNames: [PROBE_LABEL],
        registers: [this.#registry],
      };
      if (metric.counter === true) this.#probeCounters.set(metric.key, new Counter(config));
      else this.#probeGauges.set(metric.key, new Gauge(config));
    }

    // The standard info-metric shape: a constant 1 carrying the labels nothing else should.
    // The name is here rather than on every probe series, because a label repeated on twenty
    // series is twenty copies of a string that changes when somebody renames a probe.
    this.#info = new Gauge({
      name: 'ms_probe_info',
      help: 'One series per probe, carrying its name. Always 1.',
      labelNames: [PROBE_LABEL, 'name'],
      registers: [this.#registry],
    });
  }

  /** The scrape body, in the Prometheus text format. */
  async scrape(): Promise<{ body: string; contentType: string }> {
    await this.#refresh();
    return { body: await this.#registry.metrics(), contentType: this.#registry.contentType };
  }

  /**
   * One consistent snapshot per scrape.
   *
   * Read once and set everything, rather than a `collect` callback per metric: sixteen callbacks
   * would each run the same two queries, and the values would be from sixteen different instants —
   * which on a dashboard shows up as numbers that do not add up.
   */
  async #refresh(): Promise<void> {
    const core = this.#options.coreHealth();
    if (core !== undefined) {
      const reading = await core.read(this.#cpu);
      for (const metric of CORE_METRICS) {
        this.#set(metric, reading[metric.key] ?? null, {});
      }
    }

    const probeHealth = this.#options.probeHealth();
    if (probeHealth === undefined) return;

    const probes = await this.#options.db.query<{ id: string; name: string }>(
      `SELECT id::text AS id, name FROM object WHERE kind = 'probe' ORDER BY id`,
    );
    // Reset before setting, so a probe that has been deleted stops being exported rather than
    // freezing at whatever it last said.
    this.#info.reset();
    for (const gauge of this.#probeGauges.values()) gauge.reset();

    for (const row of probes) {
      const labels = { [PROBE_LABEL]: row.id };
      this.#info.set({ ...labels, name: row.name }, 1);
      const { reading } = probeHealth.read(Number(row.id));
      for (const metric of PROBE_METRICS) {
        this.#set(metric, reading[metric.key] ?? null, labels);
      }
    }
  }

  #set(metric: Metric, value: number | null, labels: Record<string, string>): void {
    const scaled = value === null || !Number.isFinite(value) ? null : value * (metric.scale ?? 1);
    if (metric.counter !== true) {
      const gauge = (labels[PROBE_LABEL] === undefined ? this.#coreGauges : this.#probeGauges).get(
        metric.key,
      );
      if (gauge === undefined) return;
      // **An absent reading is an absent series**, not a zero. `reset()` on the core gauges is
      // per-metric because they carry no labels; the probe gauges are reset wholesale above.
      if (scaled === null) {
        if (labels[PROBE_LABEL] === undefined) gauge.reset();
        return;
      }
      gauge.set(labels, scaled);
      return;
    }

    const counter = (
      labels[PROBE_LABEL] === undefined ? this.#coreCounters : this.#probeCounters
    ).get(metric.key);
    if (counter === undefined || scaled === null) return;
    const held = `${metric.name}|${labels[PROBE_LABEL] ?? ''}`;
    const previous = this.#lastCounter.get(held);
    this.#lastCounter.set(held, scaled);
    // A source counter that went backwards is a process that restarted (`T-02`'s rule for a
    // 64-bit counter). The whole new value is new activity; treating it as a negative delta
    // would make the exported total go backwards, which Prometheus reads as *its own* reset.
    const delta = previous === undefined || scaled < previous ? scaled : scaled - previous;
    // **Incremented by zero rather than skipped**, which is what creates the series. A labelled
    // counter does not exist in `prom-client` until something touches it, so skipping a zero
    // delta left `ms_probe_checks_refused_total{probe="2"}` absent on a probe that had refused
    // nothing — indistinguishable from a probe that never reported. A reported zero is a
    // *reading*; only a reading that is missing may be an absent series. It also gives `rate()`
    // and any "no data" alert a baseline to start from, which is why the convention exists.
    counter.inc(labels, delta > 0 ? delta : 0);
  }
}
