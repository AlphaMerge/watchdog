import {
  CpuMeter,
  MemorySampler,
  type AvailableMemoryLow,
  type ProbeHealthReport,
} from '@ms/shared';
import type { PoolStats } from '../runner/pool.js';
import type { CheckFlowStats } from './check-flow.js';
import type { ProcessRunnerStats } from '../runner/process-runner.js';
import type { FlowListenerStats } from '../listeners/flow-listener.js';
import type { SyslogListenerStats } from '../listeners/syslog-listener.js';
import type { TrapListenerStats } from '../listeners/trap-listener.js';
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
  /**
   * The child-process runner, absent on a build that runs no isolated sensor types.
   *
   * **A second runner is a second source, and forgetting it is `P-61`.** EXE and Script checks
   * never touch the worker pool: they have their own ceiling, their own queue and their own
   * deferred and refused counts, and for as long as this key did not exist every one of those
   * numbers was computed and thrown away. A probe saturated by slow shell-outs reported a
   * healthy pool while it turned checks away.
   */
  children?: () => ProcessRunnerStats;
  /**
   * The listeners, each absent unless this probe runs that one (`P-64`).
   *
   * Separate keys rather than one, because a probe may run neither, either or both, and absent
   * has to stay absent: a build with no syslog listener must gap its channels rather than report
   * a confident zero that cannot be told from a listener nothing is sending to.
   */
  /** Whether dispatched checks are coming back, absent on a build without the watchdog. */
  checkFlow?: () => CheckFlowStats;
  trapListener?: () => TrapListenerStats;
  syslogListener?: () => SyslogListenerStats;
  /**
   * The flow collector (`B-02`).
   *
   * It carries one counter the other two have no equivalent for — `missed`, flows the exporter's
   * own running sequence says it sent and this probe never received. UDP drops silently, so
   * without it a collector losing a third of its flows to a saturated link looks exactly like a
   * quiet network.
   */
  flowListener?: () => FlowListenerStats;
  /** Absent when this build runs no spool. */
  spool?: () => SpoolStats;
  /**
   * Absent when this build runs no drain — which is the same builds that run no spool, but the
   * two are separate sources because they answer different questions: the spool knows how much is
   * waiting, and only the drain knows whether any of it is moving.
   */
  drain?: () => DrainStats;
  /**
   * How much the machine has left (`P-208`) and how close the probe's own cgroup is to its ceiling
   * (`P-210`), each the lowest of the last thirty seconds.
   *
   * **Read every two seconds on a timer of its own, not at the report** (`P-218`). The report runs
   * at the heartbeat, 10 s as shipped and up to 300, and a window only holds the readings somebody
   * took: at 10 s it held three, and a five-second squeeze fell between two of them. Injectable
   * for the same reason `process` is.
   */
  memory?: MemoryReadings;
  /** Injectable so a test does not measure the test runner. */
  process?: {
    cpuUsage: () => NodeJS.CpuUsage;
    memoryUsage: () => { rss: number };
    uptime: () => number;
    hrtime: () => bigint;
  };
}

/** What the reporter needs of a `MemorySampler`. */
interface MemoryReadings {
  readonly machine: { lowest: () => AvailableMemoryLow | null };
  readonly limit: { lowest: () => AvailableMemoryLow | null };
  start: () => void;
  stop: () => void;
}

const MB = 1024 * 1024;

export class ProbeHealthReporter {
  readonly #sources: ProbeHealthSources;
  readonly #cpu = new CpuMeter();
  readonly #process: NonNullable<ProbeHealthSources['process']>;
  readonly #memory: MemoryReadings;

  constructor(sources: ProbeHealthSources) {
    this.#sources = sources;
    this.#memory = sources.memory ?? new MemorySampler();
    this.#process = sources.process ?? {
      cpuUsage: () => process.cpuUsage(),
      memoryUsage: () => process.memoryUsage(),
      uptime: () => process.uptime(),
      hrtime: () => process.hrtime.bigint(),
    };
  }

  /** Starts reading memory between reports. Until it is called, both memory channels gap. */
  start(): void {
    this.#memory.start();
  }

  stop(): void {
    this.#memory.stop();
  }

  report(): ProbeHealthReport {
    const scheduler = this.#sources.scheduler();
    const pool = this.#sources.pool();
    const children = this.#sources.children?.();
    const flow = this.#sources.checkFlow?.();
    const trap = this.#sources.trapListener?.();
    const syslog = this.#sources.syslogListener?.();
    // `flow` above is the check-flow watchdog (`P-76`); this is the NetFlow collector.
    const flows = this.#sources.flowListener?.();
    const spool = this.#sources.spool?.();
    const drain = this.#sources.drain?.();
    const cpu = this.#cpu.percent(this.#process.cpuUsage(), this.#process.hrtime());
    const machine = this.#memory.machine.lowest();
    // The lowest headroom is the highest usage: the worst of the last thirty seconds either way.
    const limit = this.#memory.limit.lowest();

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
      discarded: pool.discarded,
      poolState: pool.disabled ? 1 : 0,
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
      // Absent on a build with no child-process runner, so the channels gap rather than reading
      // a confident zero that cannot be told from a probe running no EXE or Script sensors.
      ...(children === undefined
        ? {}
        : {
            childSlots: children.maxConcurrent,
            childBusy: children.running,
            childQueued: children.queued,
            childDeferred: children.deferred,
            childRefused: children.refused,
            childTimedOut: children.timedOut,
            childCrashes: children.crashed,
          }),
      ...(flow === undefined
        ? {}
        : {
            checksCompleting: flow.completing,
            checksBehind: flow.behind,
            checksOutstanding: flow.outstanding,
            checkStalledMs: flow.oldestOutstandingMs,
          }),
      ...(trap === undefined
        ? {}
        : {
            trapReceived: trap.received,
            trapRejected: trap.rejected,
            trapMalformed: trap.malformed,
          }),
      ...(syslog === undefined
        ? {}
        : {
            syslogReceived: syslog.received,
            syslogRejected: syslog.rejected,
            syslogMalformed: syslog.malformed,
          }),
      ...(flows === undefined
        ? {}
        : {
            flowReceived: flows.received,
            flowRejected: flows.rejected,
            flowMalformed: flows.malformed,
            // The one an operator acts on: everything else counts what arrived, and this counts
            // what did not.
            flowMissed: flows.missed,
            // `B-03`: records whose template has not arrived. Ordinary for seconds after a
            // restart; permanent when an exporter's template interval exceeds its data one.
            flowUndecodable: flows.undecodable,
          }),
      ...(spool === undefined
        ? {}
        : {
            spoolPending: spool.pending,
            spoolBytes: spool.bytes,
            spoolDropped: spool.dropped,
            spoolCorrupt: spool.corrupt,
            spoolUnwritten: spool.unwritten,
          }),
      // Separate from the spool block above, so a build with a drain and no spool — or the
      // reverse — reports what it has rather than nothing. Absent is absent.
      ...(drain === undefined ? {} : { spoolStalledMs: drain.stalledForMs }),
      // The first heartbeat after a start carries no CPU: a rate needs two samples, and 0% would
      // say the probe is idle rather than that nothing has been measured yet.
      ...(cpu === null ? {} : { cpuPercent: cpu }),
      memoryMb: Math.round((this.#process.memoryUsage().rss / MB) * 10) / 10,
      uptimeSeconds: Math.round(this.#process.uptime()),
      // Absent where the platform cannot say how much is available, so both channels gap rather
      // than read a zero — which on this channel is the alarm itself.
      ...(machine === null
        ? {}
        : {
            memoryAvailablePercent: machine.availablePercent,
            memoryAvailableMb: Math.round((machine.availableBytes / MB) * 10) / 10,
          }),
      // Absent where the probe has no ceiling to be near — no limit, cgroup v1, or not Linux.
      ...(limit === null
        ? {}
        : {
            memoryLimitUsagePercent: Math.round((100 - limit.availablePercent) * 10) / 10,
            memoryLimitMb: Math.round((limit.totalBytes / MB) * 10) / 10,
          }),
    };
  }
}
