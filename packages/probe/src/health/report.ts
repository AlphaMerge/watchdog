import { CpuMeter, type ProbeHealthReport } from '@ms/shared';
import type { PoolStats } from '../runner/pool.js';
import type { DrainStats } from '../spool/drain.js';
import type { SpoolStats } from '../spool/spool.js';
import type { WheelStats } from '../scheduler/wheel.js';

/**
 * The probe's own numbers, gathered for the heartbeat (`P-13`, `P-04`).
 *
 * **This is the half of Probe Health only the probe knows.** Scheduler lag can only be measured
 * by the wheel, because only it knows the instant each tick *should* have run at; pool
 * saturation and the deferred count only exist inside the pool; the spool depth is a directory
 * on the probe's disk. The other half — whether the link is up, how old the last heartbeat is,
 * what protocol the probe speaks — is the core's, and is exactly the half that still works when
 * the probe is gone.
 *
 * **Absent means absent, never zero.** A build with no spool wired reports no spool fields, and
 * the channel gaps rather than reading a confident 0 that cannot be told from an empty spool.
 */
export interface ProbeHealthSources {
  scheduler: () => WheelStats;
  pool: () => PoolStats;
  /** Absent when this build runs no spool. */
  spool?: () => SpoolStats;
  /**
   * Absent when this build runs no drain — which is the same builds that run no spool, but the
   * two are separate sources because they answer different questions: the spool knows how much is
   * waiting, and only the drain knows whether any of it is moving.
   */
  drain?: () => DrainStats;
  /** Injectable so a test does not measure the test runner. */
  process?: {
    cpuUsage: () => NodeJS.CpuUsage;
    memoryUsage: () => { rss: number };
    uptime: () => number;
    hrtime: () => bigint;
  };
}

const MB = 1024 * 1024;

export class ProbeHealthReporter {
  readonly #sources: ProbeHealthSources;
  readonly #cpu = new CpuMeter();
  readonly #process: NonNullable<ProbeHealthSources['process']>;

  constructor(sources: ProbeHealthSources) {
    this.#sources = sources;
    this.#process = sources.process ?? {
      cpuUsage: () => process.cpuUsage(),
      memoryUsage: () => process.memoryUsage(),
      uptime: () => process.uptime(),
      hrtime: () => process.hrtime.bigint(),
    };
  }

  report(): ProbeHealthReport {
    const scheduler = this.#sources.scheduler();
    const pool = this.#sources.pool();
    const spool = this.#sources.spool?.();
    const drain = this.#sources.drain?.();
    const cpu = this.#cpu.percent(this.#process.cpuUsage(), this.#process.hrtime());

    return {
      scheduled: scheduler.tasks,
      schedulerLagMs: scheduler.lagMs,
      skippedTicks: scheduler.skippedTicks,
      clockJumps: scheduler.clockJumps,
      poolSize: pool.size,
      poolBusy: pool.busy,
      queued: pool.queued,
      queueWaitMs: pool.waitMs,
      deferred: pool.deferred,
      refused: pool.refused,
      timedOut: pool.timedOut,
      workerCrashes: pool.workerCrashes,
      // Absent when no registry keeps session pools (`P-36`), so the channels gap rather than
      // reading a confident zero on a build that has nothing to report.
      ...(pool.sessions === undefined
        ? {}
        : {
            sessionsOpen: pool.sessions.open,
            sessionOverflows: pool.sessions.overflowed,
            sessionsEvicted: pool.sessions.evicted,
            sessionsOpened: pool.sessions.opened,
          }),
      ...(spool === undefined
        ? {}
        : {
            spoolPending: spool.pending,
            spoolBytes: spool.bytes,
            spoolDropped: spool.dropped,
            spoolCorrupt: spool.corrupt,
          }),
      // Separate from the spool block above, so a build with a drain and no spool — or the
      // reverse — reports what it has rather than nothing. Absent is absent.
      ...(drain === undefined ? {} : { spoolStalledMs: drain.stalledForMs }),
      // The first heartbeat after a start carries no CPU: a rate needs two samples, and 0% would
      // say the probe is idle rather than that nothing has been measured yet.
      ...(cpu === null ? {} : { cpuPercent: cpu }),
      memoryMb: Math.round((this.#process.memoryUsage().rss / MB) * 10) / 10,
      uptimeSeconds: Math.round(this.#process.uptime()),
    };
  }
}
