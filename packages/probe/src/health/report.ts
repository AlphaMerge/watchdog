import {
  capabilitiesFor,
  CpuMeter,
  MemorySampler,
  type AvailableMemoryLow,
  type LogOutputStats,
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
  /**
   * The log output (`P-216` part 3): what it dropped since the probe started, and what it holds.
   * Absent under `logPretty`, which writes through pino's own transport, so both channels gap.
   */
  log?: () => LogOutputStats;
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
  readonly machine: MemoryLows;
  readonly limit: MemoryLows;
  start: () => void;
  stop: () => void;
}

/** What the reporter needs of one `AvailableMemoryWatch`. */
interface MemoryLows {
  lowest: () => AvailableMemoryLow | null;
  takeLow: () => AvailableMemoryLow | null;
}

/** The heartbeat a report is for, from `CoreClient` (`P-219`). */
export interface HeartbeatContext {
  readonly seq: number;
  /** The version the two ends speak, which decides what the memory channels cover. */
  readonly peerVersion: number;
}

/** The memory lows of heartbeats the core has not acknowledged, oldest first (`P-219`). */
interface Unacknowledged {
  readonly seq: number;
  readonly machine: AvailableMemoryLow | null;
  readonly limit: AvailableMemoryLow | null;
}

/**
 * How many unacknowledged heartbeats are kept apart before the oldest two are merged. Merging
 * keeps their low and loses only which heartbeat it belonged to, which matters only to a core
 * that acknowledges some of them and not others — and a core acknowledges in order or not at all.
 */
const MAX_UNACKNOWLEDGED = 64;

const MB = 1024 * 1024;

export class ProbeHealthReporter {
  readonly #sources: ProbeHealthSources;
  readonly #cpu = new CpuMeter();
  readonly #process: NonNullable<ProbeHealthSources['process']>;
  readonly #memory: MemoryReadings;
  #unacknowledged: Unacknowledged[] = [];

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

  /**
   * The report for one heartbeat, or, without one, the latest thirty seconds (`P-218`).
   *
   * **At protocol 20 the memory channels cover exactly the time since the last heartbeat the core
   * acknowledged** (`P-219`), and the core folds every report between two of its records into the
   * second. So each low is in one report and one record: never missed between the reports two
   * records happen to read, and never in two. Each heartbeat takes what the watches read since the
   * one before and keeps it until the core acknowledges that heartbeat, so a report the core never
   * got — sent as the link dropped — is carried by the next, and an outage by the first report
   * after it. The lag is at most a heartbeat.
   *
   * **Below 20 the core records whichever report it has**, and folding would lose what fell in the
   * reports it did not read, so an older core gets the lowest of the last thirty seconds, as
   * before. Every heartbeat takes its share either way, so a core that changes version between
   * connections starts from a clean cut.
   */
  report(heartbeat?: HeartbeatContext): ProbeHealthReport {
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
    const log = this.#sources.log?.();
    const cpu = this.#cpu.percent(this.#process.cpuUsage(), this.#process.hrtime());
    // The lowest headroom is the highest usage, so both are the lowest of what they cover.
    const { machine, limit } = this.#memoryFor(heartbeat);

    return {
      scheduled: scheduler.tasks,
      schedulerLagMs: scheduler.lagMs,
      skippedTicks: scheduler.skippedTicks,
      clockJumps: scheduler.clockJumps,
      poolSize: pool.size,
      poolBusy: pool.busy,
      // `P-236`: the ceiling memory leaves the pool, and how much of the one it would otherwise
      // have that memory is holding back. The cap is absent where memory cannot be read.
      poolCeiling: pool.ceiling,
      ...(pool.memoryCap === undefined ? {} : { poolMemoryCap: pool.memoryCap }),
      poolHeldBack: pool.heldBack,
      queued: pool.queued,
      queueWaitMs: pool.waitMs,
      deferred: pool.deferred,
      refused: pool.refused,
      discarded: pool.discarded,
      poolState: pool.disabled ? 1 : 0,
      timedOut: pool.timedOut,
      workerCrashes: pool.workerCrashes,
      // `P-263`: workers that never said ready, a hang the pool ended among them. Sent only to a
      // core at protocol 30.
      workerStartupFailed: pool.startupFailed,
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
            // `P-260`: checks whose process never got as far as running them, and how long a
            // start takes. Sent only to a core at protocol 29. The time is absent until a process
            // has started or been given up, rather than a start that took no time.
            childStartupFailed: children.startupFailed,
            ...(children.startupMs === null ? {} : { childStartupMs: children.startupMs }),
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
            // `B-14`: received, and overwritten in the buffer before a sensor read it. Sent only
            // to a core at protocol 26, as the syslog one below is.
            trapOverwritten: trap.overwrittenUnread,
          }),
      ...(syslog === undefined
        ? {}
        : {
            syslogReceived: syslog.received,
            syslogRejected: syslog.rejected,
            syslogMalformed: syslog.malformed,
            syslogOverwritten: syslog.overwrittenUnread,
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
            // `B-11`: received, and overwritten in the buffer before a sensor read it. Sent only
            // to a core at protocol 25.
            flowOverwritten: flows.overwrittenUnread,
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
      // A running total, not a count since the last report: a report the core never got loses
      // nothing, and the core records the growth between two of its readings.
      ...(log === undefined
        ? {}
        : { logDropped: log.droppedLines, logBacklogBytes: log.backlogBytes }),
    };
  }

  /** The core has this heartbeat, and every one before it: what they covered is delivered. */
  acknowledged(seq: number): void {
    this.#unacknowledged = this.#unacknowledged.filter((entry) => entry.seq > seq);
  }

  #memoryFor(heartbeat: HeartbeatContext | undefined): {
    machine: AvailableMemoryLow | null;
    limit: AvailableMemoryLow | null;
  } {
    if (heartbeat === undefined) {
      return { machine: this.#memory.machine.lowest(), limit: this.#memory.limit.lowest() };
    }
    this.#unacknowledged.push({
      seq: heartbeat.seq,
      machine: this.#memory.machine.takeLow(),
      limit: this.#memory.limit.takeLow(),
    });
    while (this.#unacknowledged.length > MAX_UNACKNOWLEDGED) {
      const [oldest, next, ...rest] = this.#unacknowledged;
      if (oldest === undefined || next === undefined) break;
      this.#unacknowledged = [
        {
          seq: next.seq,
          machine: lower(oldest.machine, next.machine),
          limit: lower(oldest.limit, next.limit),
        },
        ...rest,
      ];
    }
    if (!capabilitiesFor(heartbeat.peerVersion).memorySinceLastReport) {
      return { machine: this.#memory.machine.lowest(), limit: this.#memory.limit.lowest() };
    }
    let machine: AvailableMemoryLow | null = null;
    let limit: AvailableMemoryLow | null = null;
    for (const entry of this.#unacknowledged) {
      machine = lower(machine, entry.machine);
      limit = lower(limit, entry.limit);
    }
    return { machine, limit };
  }
}

/** The lower of two readings, where either may be a gap. */
function lower(
  a: AvailableMemoryLow | null,
  b: AvailableMemoryLow | null,
): AvailableMemoryLow | null {
  if (a === null) return b;
  if (b === null) return a;
  return b.availableBytes < a.availableBytes ? b : a;
}
