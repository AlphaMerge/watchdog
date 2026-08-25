import type { Logger } from '@ms/shared';

/** One second, in nanoseconds. The wheel's resolution (WORKFLOW.MD §3). */
const TICK_NS = 1_000_000_000n;

/** Slots in the wheel: one hour at one-second resolution. */
const DEFAULT_SLOTS = 3_600;

/** Tick latencies kept for the percentiles Probe Health reports (P-13). */
const LAG_WINDOW = 1_024;

/**
 * How far the monotonic and wall clocks may disagree over one advance before it is called a
 * jump. Generous: ordinary scheduling delay moves both together, and only a stepped clock or a
 * suspended machine moves one without the other.
 */
const CLOCK_JUMP_MS = 2_000;

export interface ScheduledTask {
  /** The sensor this task scans. */
  readonly id: number;
  readonly intervalSeconds: number;
}

export interface WheelStats {
  tasks: number;
  /** Ticks elapsed since the wheel started. */
  tick: number;
  dispatched: number;
  /**
   * Ticks the wheel was too far behind to visit individually. Never silent: a scheduler that
   * quietly skipped a minute of work would look identical to one that had nothing to do.
   */
  skippedTicks: number;
  /** Times the monotonic and wall clocks disagreed — a stepped clock, or a suspended machine. */
  clockJumps: number;
  /** How late ticks ran against their ideal instant, over the last 1,024 of them. */
  lagMs: { p50: number; p95: number; p99: number; max: number };
}

export interface AdvanceReport {
  /** Ticks the wheel moved through. */
  ticks: number;
  /** Sensor ids that came due. */
  due: number[];
  /** True when the wheel was more than a revolution behind and coalesced the catch-up. */
  coalesced: boolean;
  lagMs: number;
}

export interface TimingWheelOptions {
  logger: Logger;
  /** Called with every id that comes due. Must not block: it is on the wheel's own thread. */
  onDue: (due: readonly number[], tick: number) => void;
  slots?: number;
  /** The monotonic clock. Injectable so tests can drive time rather than wait for it. */
  now?: () => bigint;
  /** Wall clock, in milliseconds. Used only to *notice* a jump, never to schedule one. */
  wallNow?: () => number;
}

interface Entry {
  id: number;
  intervalSeconds: number;
  dueTick: number;
}

/**
 * Deterministic phase offset for a sensor, in seconds (ADR-001 Decision 2).
 *
 * Sensors created together — a discovery run provisioning a rack, an operator cloning a
 * template — would otherwise all land on the same second forever. The offset is a hash rather
 * than `id % interval` because ids are not guaranteed contiguous: a tree built and pruned
 * leaves gaps, and gaps in a modulo become clumps in the schedule.
 *
 * A splitmix32 finaliser: cheap, no dependency, and it scatters sequential ids the way a
 * monitoring system needs.
 */
export function phaseFor(id: number, intervalSeconds: number): number {
  let x = id >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0_aaad) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x735a_2d97) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  return x % intervalSeconds;
}

/**
 * A hashed timing wheel, bucketed by due second (ADR-001 Decision 2).
 *
 * One timer for the whole probe rather than one per sensor: at the v1 target of 5,000 sensors a
 * timer heap becomes the bottleneck and precision degrades, which is the failure this structure
 * exists to avoid.
 *
 * Three properties are worth knowing before changing anything here.
 *
 * **It is driven by the monotonic clock**, never the wall clock (CLAUDE.md). An NTP step or a
 * daylight-saving change must not make a 60-second sensor fire twice or skip an hour. The wall
 * clock is read only to *notice* that the two have diverged, which is worth a log line and a
 * counter.
 *
 * **A missed period is coalesced, not replayed.** If the process is blocked — a stop-the-world
 * pause, a suspended VM, a laptop lid — a sensor that missed thirty scans is due once, now, not
 * thirty times. Monitoring wants the current state of the world, and thirty backlogged pings
 * would arrive as a stampede at the worst possible moment.
 *
 * **Phase survives a catch-up.** A task re-arms to the next instant congruent with its original
 * due tick, so a sensor on the 17th second of each minute stays on the 17th second even after
 * the wheel has been asleep.
 */
export class TimingWheel {
  readonly #logger: Logger;
  readonly #onDue: (due: readonly number[], tick: number) => void;
  readonly #slots: number;
  readonly #now: () => bigint;
  readonly #wallNow: () => number;

  /** slot index -> the entries whose next due tick hashes there. */
  readonly #wheel: Set<Entry>[];
  readonly #byId = new Map<number, Entry>();
  readonly #lag: number[] = [];

  #epochNs = 0n;
  /** The pair the last divergence check was taken against. */
  #lastMonoNs = 0n;
  #lastWallMs = 0;
  #tick = 0;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #dispatched = 0;
  #skippedTicks = 0;
  #clockJumps = 0;

  constructor(options: TimingWheelOptions) {
    this.#logger = options.logger.child({ component: 'timing-wheel' });
    this.#onDue = options.onDue;
    this.#slots = options.slots ?? DEFAULT_SLOTS;
    // Wrapped rather than passed by reference: `process.hrtime.bigint` detached from its
    // object is a scoping accident waiting to happen.
    this.#now = options.now ?? (() => process.hrtime.bigint());
    this.#wallNow = options.wallNow ?? Date.now;
    this.#wheel = Array.from({ length: this.#slots }, () => new Set<Entry>());
    this.#epochNs = this.#now();
    this.#lastMonoNs = this.#epochNs;
    this.#lastWallMs = this.#wallNow();
  }

  get size(): number {
    return this.#byId.size;
  }

  get tick(): number {
    return this.#tick;
  }

  has(id: number): boolean {
    return this.#byId.has(id);
  }

  /**
   * Schedules a sensor, or re-schedules it if its interval changed.
   *
   * The first firing is the next tick that lands on the sensor's own phase — not a whole
   * interval away. Waiting an interval would mean a newly created sensor tells the operator
   * nothing for up to twenty-four hours, and the first scan is the one they are watching for.
   *
   * That is safe to do promptly precisely because of the phase: a configuration push that
   * schedules five thousand sensors at once (R-04) spreads their first firings across the whole
   * interval rather than stampeding the tick it arrived on.
   */
  add(task: ScheduledTask): void {
    if (!Number.isInteger(task.intervalSeconds) || task.intervalSeconds < 1) {
      throw new RangeError(
        `interval must be a whole number of seconds, got ${String(task.intervalSeconds)}`,
      );
    }

    const existing = this.#byId.get(task.id);
    if (existing !== undefined) {
      if (existing.intervalSeconds === task.intervalSeconds) return;
      this.remove(task.id);
    }

    const phase = phaseFor(task.id, task.intervalSeconds);
    // The next tick strictly in the future whose position within the interval is the phase.
    const from = this.#tick + 1;
    const dueTick =
      from +
      ((phase - (from % task.intervalSeconds) + task.intervalSeconds) % task.intervalSeconds);

    const entry: Entry = { id: task.id, intervalSeconds: task.intervalSeconds, dueTick };
    this.#byId.set(task.id, entry);
    this.#slotFor(dueTick).add(entry);
  }

  remove(id: number): boolean {
    const entry = this.#byId.get(id);
    if (entry === undefined) return false;
    this.#slotFor(entry.dueTick).delete(entry);
    this.#byId.delete(id);
    return true;
  }

  /** Everything the wheel knows, for Probe Health (P-13). */
  stats(): WheelStats {
    const sorted = [...this.#lag].sort((a, b) => a - b);
    const at = (fraction: number): number => {
      if (sorted.length === 0) return 0;
      const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
      return Number((sorted[index] ?? 0).toFixed(3));
    };
    return {
      tasks: this.#byId.size,
      tick: this.#tick,
      dispatched: this.#dispatched,
      skippedTicks: this.#skippedTicks,
      clockJumps: this.#clockJumps,
      lagMs: { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) },
    };
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#arm();
    this.#logger.info({ slots: this.#slots, tasks: this.#byId.size }, 'timing wheel started');
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Advances to whatever the monotonic clock now says, dispatching everything due.
   *
   * Public because it is the only honest way to test a scheduler: a unit test drives the clock
   * and calls this, rather than sleeping and hoping. The timer calls exactly the same method.
   */
  advance(): AdvanceReport {
    const nowNs = this.#now();
    const target = Number((nowNs - this.#epochNs) / TICK_NS);
    const idealNs = this.#epochNs + BigInt(target) * TICK_NS;
    const lagMs = Number(nowNs - idealNs) / 1e6;

    if (target <= this.#tick) return { ticks: 0, due: [], coalesced: false, lagMs };

    this.#noticeClockJump(nowNs);

    const gap = target - this.#tick;
    // One full revolution visits every slot, so a longer gap needs no more walking — and
    // walking it would only re-find tasks this same pass has already re-armed past `target`.
    const steps = Math.min(gap, this.#slots);
    const coalesced = gap > this.#slots;
    if (gap > 1) this.#skippedTicks += gap - 1;

    const due: number[] = [];
    for (let step = 0; step < steps; step += 1) {
      const visiting = target - steps + 1 + step;
      const slot = this.#slotFor(visiting);
      if (slot.size === 0) continue;

      // Snapshot: re-arming mutates this slot when the interval is a multiple of the wheel.
      for (const entry of [...slot]) {
        // Entries sharing a slot from a later revolution are not due yet.
        if (entry.dueTick > target) continue;
        slot.delete(entry);
        due.push(entry.id);
        this.#rearm(entry, target);
      }
    }

    this.#tick = target;
    this.#dispatched += due.length;
    this.#record(lagMs);

    if (coalesced) {
      this.#logger.warn(
        { behindTicks: gap, dispatched: due.length },
        'timing wheel was more than a revolution behind; missed periods coalesced into one',
      );
    }

    if (due.length > 0) this.#onDue(due, target);
    return { ticks: gap, due, coalesced, lagMs };
  }

  /**
   * Re-arms a fired task to the next instant congruent with its original due tick.
   *
   * This is what makes a catch-up fire once rather than once per missed period, and what keeps
   * a sensor's phase across one: the next due tick is the first multiple of the interval past
   * `target` that still lands on the sensor's own second.
   */
  #rearm(entry: Entry, target: number): void {
    const periods = Math.ceil((target - entry.dueTick + 1) / entry.intervalSeconds);
    entry.dueTick += entry.intervalSeconds * Math.max(1, periods);
    this.#slotFor(entry.dueTick).add(entry);
  }

  #slotFor(tick: number): Set<Entry> {
    const slot = this.#wheel[((tick % this.#slots) + this.#slots) % this.#slots];
    /* c8 ignore next -- the modulo above is always in range; this is a type guard */
    if (slot === undefined) throw new Error('timing wheel slot out of range');
    return slot;
  }

  /**
   * Notices that the two clocks have parted company.
   *
   * Nothing is corrected — the monotonic clock is right by definition for scheduling — but an
   * operator debugging "why did my sensors stop for eight hours" deserves to find the suspend in
   * the log rather than infer it.
   *
   * The comparison is between *consecutive* checks, not against a fixed epoch. Measuring from an
   * epoch means a single step leaves the two clocks permanently apart, and every tick afterwards
   * reports the same jump again — which is how the first version of this reported one NTP step
   * three times. A per-advance delta reports each divergence exactly once and needs no
   * re-anchoring, so tick numbering is never disturbed by a diagnostic.
   *
   * Note that a *stall* is not a jump: when the process is blocked, both clocks move together,
   * and it is the tick count that jumps rather than the clocks diverging.
   */
  #noticeClockJump(nowNs: bigint): void {
    const wallMs = this.#wallNow();
    const monotonicDeltaMs = Number(nowNs - this.#lastMonoNs) / 1e6;
    const wallDeltaMs = wallMs - this.#lastWallMs;
    this.#lastMonoNs = nowNs;
    this.#lastWallMs = wallMs;

    const drift = wallDeltaMs - monotonicDeltaMs;
    if (Math.abs(drift) < CLOCK_JUMP_MS) return;

    this.#clockJumps += 1;
    this.#logger.warn(
      { driftMs: Math.round(drift) },
      drift > 0
        ? 'the wall clock ran ahead of the monotonic clock: the machine slept, or the clock was stepped forward'
        : 'the wall clock fell behind the monotonic clock: it was stepped backwards',
    );
  }

  #record(lagMs: number): void {
    this.#lag.push(Math.max(0, lagMs));
    if (this.#lag.length > LAG_WINDOW) this.#lag.shift();
  }

  /** One timer, re-armed to the next tick boundary, so the wheel does not drift. */
  #arm(): void {
    if (!this.#running) return;
    const nextNs = this.#epochNs + BigInt(this.#tick + 1) * TICK_NS;
    const delayMs = Math.max(0, Number(nextNs - this.#now()) / 1e6);
    this.#timer = setTimeout(() => {
      try {
        this.advance();
      } catch (error: unknown) {
        // A throwing dispatcher must not stop the clock. Everything else would still be due.
        this.#logger.error({ err: error }, 'timing wheel tick failed');
      }
      this.#arm();
    }, delayMs);
    this.#timer.unref();
  }
}
