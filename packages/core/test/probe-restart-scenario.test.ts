import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { probeHealth, standardCatalogue } from '@ms/sensors';
import { PROTOCOL_VERSION, type CheckResult } from '@ms/shared';
import { CompositeAuditSink, DatabaseAuditSink } from '../src/audit/store.js';
import type { Database } from '../src/db/pool.js';
import { ProbeHealthService } from '../src/health/probe-health.js';
import { BUILT_IN_LOOKUPS } from '../src/lookups/built-in.js';
import { AlarmEngine, holdsFrom } from '../src/notifications/engine.js';
import { AlarmRepository } from '../src/notifications/repository.js';
import { AlarmScheduler } from '../src/notifications/scheduler.js';
import { TriggerSync } from '../src/notifications/sync.js';
import { NO_LIMITS, rollUp } from '../src/state/limits.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { SensorResult } from '../src/state/service.js';
import type { ProbeLink } from '../src/transport/probe-endpoint.js';
import { TriggerService } from '../src/triggers/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { shippedRecovery, shippedUnit, startLimitOf, type Recovery } from './support/units.js';
import { everyVoucherHolds } from './support/vouching.js';

const available = await databaseAvailable();

const T0 = new Date('2026-09-28T18:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

/** The core's Probe Health sweep interval (`packages/core/src/main.ts`). */
const SWEEP_MS = 30_000;

/** Any id: the scheduler writes the obligation, and delivery is not what is being counted. */
const TEMPLATE = 401;

const PROBE_LINK = BUILT_IN_LOOKUPS.find((lookup) => lookup.id === 'ms.probe.link');

const HOUR = 3_600_000;

const notifications = (n: number): string => `${String(n)} notification${n === 1 ? '' : 's'}`;

/** systemd's start limit. */
interface StartLimit {
  readonly burst: number;
  readonly intervalMs: number;
}

/** Read from `deploy/systemd/ms-probe.service`, so editing the unit re-runs this arithmetic (`P-222`). */
const SHIPPED_LIMIT: StartLimit = startLimitOf(shippedUnit('ms-probe'));

/**
 * A probe being killed and restarted, as the link to it looks from the core.
 *
 * Each round starts at a kill and lasts the next of `roundsMs`, cycled. The probe is down for
 * `upFromMs` of it — `RestartSec`, its own start, the connection — and connected for the rest.
 * With a `limit`, a round is refused once `burst` starts have already happened inside
 * `intervalMs`, and the link stays down from then on: the unit is `failed`.
 *
 * **A sequence of rounds rather than one period, because one period aliases against the sweep.**
 * At a constant ten seconds the thirty-second sweep lands on the same phase of every third round
 * for ever and sees nothing, or everything; at 11.3 s it saw 42 outages an hour and at 14 s, 18.
 * Replaying the measured rounds, which jitter, gives 36–45 whatever the phase.
 */
interface RestartLoop {
  readonly roundsMs: readonly number[];
  readonly upFromMs: number;
  readonly limit?: StartLimit;
}

/**
 * The measured loop: kill to kill 12.9, 11.3, 10.7, 9.9 and 14.4 s, with `RestartSec=5s`
 * (`docs/findings/2026-09-28-memory-ceiling.md`, via `P-213`). Down for the first 6.5 s of each —
 * the five seconds systemd waits, and a start — then connected until the kill: an assumption, and
 * the one that makes this the dangerous case. A probe whose working set is too large for its
 * ceiling gets far enough to connect, is sent its sensors, and grows past it.
 */
const MEASURED_ROUNDS_MS: readonly number[] = [12_900, 11_300, 10_700, 9_900, 14_400];
const DOWN_MS = 6_500;
const MEASURED: RestartLoop = { roundsMs: MEASURED_ROUNDS_MS, upFromMs: DOWN_MS };

/**
 * A loop whose probe stays connected for `connectedMs` a round before the ceiling takes it, with
 * the measured rounds' jitter. The measured loop is the fast end — its ceiling was 132 MiB — and
 * a probe that does not fit in the stock 6 GiB lasts longer: `P-206` measured 171 MiB/s early in
 * start-up and a peak of 2.5–3.5 GiB.
 */
function connectedFor(connectedMs: number): RestartLoop {
  const median = 11_300;
  return {
    roundsMs: MEASURED_ROUNDS_MS.map((round) =>
      Math.round(((DOWN_MS + connectedMs) * round) / median),
    ),
    upFromMs: DOWN_MS,
  };
}

/** When each round the unit is allowed begins, up to `horizonMs`. */
function startsOf(loop: RestartLoop, horizonMs: number): number[] {
  const starts: number[] = [];
  let at = 0;
  for (let round = 0; at < horizonMs; round += 1) {
    const { limit } = loop;
    if (limit !== undefined) {
      const recent = starts.filter((start) => start > at - limit.intervalMs).length;
      if (recent >= limit.burst) break;
    }
    starts.push(at);
    at += loop.roundsMs[round % loop.roundsMs.length] ?? 1;
  }
  return starts;
}

function linkUpAt(loop: RestartLoop, starts: readonly number[], ms: number): boolean {
  if (ms < 0) return true; // Healthy until the loop begins.
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index] ?? 0;
    const end = starts[index + 1] ?? start + (loop.roundsMs[index % loop.roundsMs.length] ?? 1);
    if (ms >= start && ms < end) return ms - start >= loop.upFromMs;
  }
  return false; // Past the last start the unit allowed: `failed`, and the link stays down.
}

/** When the core sweeps: one healthy sweep before the first kill, then every thirty seconds. */
function sweepTimes(durationMs: number, offsetMs: number): number[] {
  const times = [offsetMs - SWEEP_MS];
  for (let ms = offsetMs; ms < durationMs; ms += SWEEP_MS) times.push(ms);
  return times;
}

/**
 * How many outages the sweep *sees*: every Up it observed followed by a Down.
 *
 * Pure arithmetic over the timeline, kept apart from the system under test so the pipeline test
 * below is a claim about the pipeline — that it turns each observed outage into exactly one
 * notification, collapsing none and adding none — rather than the pipeline checked against itself.
 */
function observedOutages(loop: RestartLoop, durationMs: number, offsetMs: number): number {
  const starts = startsOf(loop, durationMs + 60_000);
  let outages = 0;
  let wasUp = true;
  for (const ms of sweepTimes(durationMs, offsetMs)) {
    const up = linkUpAt(loop, starts, ms);
    if (wasUp && !up) outages += 1;
    wasUp = up;
  }
  return outages;
}

/** The loop begun at each of its rounds, and the sweep at every second of its thirty. */
function everyPhase(
  loop: RestartLoop,
  durationMs: number,
): { least: number; most: number; twoOrMore: number } {
  const counts: number[] = [];
  for (let first = 0; first < loop.roundsMs.length; first += 1) {
    const rotated = {
      ...loop,
      roundsMs: [...loop.roundsMs.slice(first), ...loop.roundsMs.slice(0, first)],
    };
    for (let offset = 0; offset < SWEEP_MS; offset += 1_000) {
      counts.push(observedOutages(rotated, durationMs, offset));
    }
  }
  return {
    least: Math.min(...counts),
    most: Math.max(...counts),
    twoOrMore: counts.filter((count) => count >= 2).length / counts.length,
  };
}

/**
 * `P-215`, in arithmetic: the worst case over every phase, not the phase one run happened to get.
 *
 * **Why this exists separately.** The first version of this scenario ran one phase through the
 * pipeline, got 1, and asserted `<= 2`. Over every phase, the same loop and limit raise two alarms
 * 41% of the time. A single phase is a sample; the claim in `docs/TASKS.md` is a bound, and a
 * bound is only asserted by looking at all of them.
 *
 * **What it shows, and does not.** A start limit turns an unbounded storm into a bounded one. It
 * does **not** give one alarm: `CLAUDE.md`'s *one outage, one alarm* is not met at the unit level.
 * `M-18`'s hold in the alarm engine is where it is met, in the suite after `H-23`'s. The counts
 * here are the engine without it, which is every sensor type but Probe Health.
 */
describe('how many alarms a restart loop can raise, over every phase', () => {
  it('raises dozens an hour when nothing stops it', () => {
    const { least, most } = everyPhase(MEASURED, HOUR);
    assert.ok(least >= 30, `expected a storm at every phase, the quietest raised ${String(least)}`);
    assert.ok(most <= 50, String(most));
  });

  it('raises one or two once the shipped start limit stops it — not always one', () => {
    const { least, most, twoOrMore } = everyPhase({ ...MEASURED, limit: SHIPPED_LIMIT }, HOUR);
    assert.equal(least, 1);
    assert.equal(most, 2);
    // Pinned so that nobody reads the bound as "one" and tightens an assertion to match a lucky
    // run. `M-18`'s hold is what makes it one, below.
    assert.ok(twoOrMore > 0.3, `two alarms at ${(twoOrMore * 100).toFixed(0)}% of phases`);
  });

  it('stops a probe that lasts a minute before the ceiling takes it, which five minutes would not', () => {
    const slow = connectedFor(60_000);
    // systemd refuses the sixth start inside the window, which takes five whole rounds: under
    // five minutes, rounds of about 66 s never fit, and the loop runs for ever.
    const fiveMinutes = everyPhase({ ...slow, limit: { burst: 5, intervalMs: 300_000 } }, HOUR);
    assert.ok(
      fiveMinutes.least >= 9,
      `a five-minute window let through ${String(fiveMinutes.least)}`,
    );
    const shipped = everyPhase({ ...slow, limit: SHIPPED_LIMIT }, HOUR);
    assert.ok(shipped.most <= 4, `the ten-minute window let through ${String(shipped.most)}`);
  });

  it('bounds every loop shape up to two minutes a round', () => {
    for (const connectedMs of [5_000, 15_000, 30_000, 60_000]) {
      const { most } = everyPhase({ ...connectedFor(connectedMs), limit: SHIPPED_LIMIT }, HOUR);
      assert.ok(most <= 4, `connected ${String(connectedMs / 1000)} s a round: ${String(most)}`);
    }
  });
});

/** Read from `deploy/recover.sh`, so editing its schedule re-runs this arithmetic (`H-23`). */
const SHIPPED_RECOVERY: Recovery = shippedRecovery();

const DAY = 24 * HOUR;

/** One start: the link is down for the loop's `upFromMs` of it, then up until it ends. */
interface Round {
  readonly start: number;
  readonly lengthMs: number;
}

/**
 * The loop under `H-23`: each time the start limit stops the unit, `ms-recover` starts it again
 * after a cool-down that doubles to its cap, and `reset-failed` clears the limit's count.
 *
 * Rounds rather than starts, because between a failure and its retry the link is down, where
 * `linkUpAt` above would take the next start as the end of the round before it. From `clearsAtMs`
 * the cause has gone, and the next start stays up.
 */
function roundsWithRecovery(
  loop: RestartLoop,
  limit: StartLimit,
  recovery: Recovery,
  horizonMs: number,
  clearsAtMs = Number.POSITIVE_INFINITY,
): { rounds: Round[]; failures: number[] } {
  const rounds: Round[] = [];
  const failures: number[] = [];
  let counted: number[] = [];
  let at = 0;
  let round = 0;
  while (at < horizonMs) {
    if (counted.filter((start) => start > at - limit.intervalMs).length >= limit.burst) {
      let delay = recovery.baseMs;
      for (let retry = 0; retry < failures.length && delay < recovery.capMs; retry += 1) delay *= 2;
      failures.push(at);
      at += Math.min(delay, recovery.capMs);
      counted = [];
      continue;
    }
    counted.push(at);
    if (at >= clearsAtMs) {
      rounds.push({ start: at, lengthMs: Number.POSITIVE_INFINITY });
      break;
    }
    const lengthMs = loop.roundsMs[round % loop.roundsMs.length] ?? 1;
    rounds.push({ start: at, lengthMs });
    at += lengthMs;
    round += 1;
  }
  return { rounds, failures };
}

function linkUpInRounds(rounds: readonly Round[], upFromMs: number, ms: number): boolean {
  if (ms < 0) return true;
  for (const { start, lengthMs } of rounds) {
    if (ms >= start && ms < start + lengthMs) return ms - start >= upFromMs;
  }
  return false; // Between a failure and its retry, the unit is `failed` and the link is down.
}

/** The outages the sweep sees in `[fromMs, toMs)`, with the loop and its retries under way. */
function outagesWithRecovery(
  loop: RestartLoop,
  fromMs: number,
  toMs: number,
  offsetMs: number,
): number {
  const { rounds } = roundsWithRecovery(loop, SHIPPED_LIMIT, SHIPPED_RECOVERY, toMs + HOUR);
  let outages = 0;
  let wasUp = linkUpInRounds(rounds, loop.upFromMs, fromMs + offsetMs - SWEEP_MS);
  for (let ms = fromMs + offsetMs; ms < toMs; ms += SWEEP_MS) {
    const up = linkUpInRounds(rounds, loop.upFromMs, ms);
    if (wasUp && !up) outages += 1;
    wasUp = up;
  }
  return outages;
}

/** Every phase, as `everyPhase` takes them: the loop begun at each round, the sweep at each second. */
function everyPhaseWithRecovery(
  loop: RestartLoop,
  fromMs: number,
  toMs: number,
): { least: number; most: number } {
  const counts: number[] = [];
  for (let first = 0; first < loop.roundsMs.length; first += 1) {
    const rotated = {
      ...loop,
      roundsMs: [...loop.roundsMs.slice(first), ...loop.roundsMs.slice(0, first)],
    };
    for (let offset = 0; offset < SWEEP_MS; offset += 1_000) {
      counts.push(outagesWithRecovery(rotated, fromMs, toMs, offset));
    }
  }
  return { least: Math.min(...counts), most: Math.max(...counts) };
}

/** How many loops of up to `burst` starts begin in `[fromMs, toMs)`: the first, and each retry. */
function loopsBetween(loop: RestartLoop, fromMs: number, toMs: number): number {
  const { failures } = roundsWithRecovery(loop, SHIPPED_LIMIT, SHIPPED_RECOVERY, toMs + HOUR);
  const starts = [0, ...failures.map((failedAt, retry) => failedAt + cooldownMs(retry))];
  return starts.filter((start) => start >= fromMs && start < toMs).length;
}

function cooldownMs(retry: number): number {
  let delay = SHIPPED_RECOVERY.baseMs;
  for (let n = 0; n < retry && delay < SHIPPED_RECOVERY.capMs; n += 1) delay *= 2;
  return Math.min(delay, SHIPPED_RECOVERY.capMs);
}

/**
 * `H-23`: the start limit stops a crash loop, and `ms-recover` starts it again after a cool-down.
 *
 * **What it buys.** A probe whose cause goes away comes back by itself. Before `H-23` it stayed
 * `failed` until somebody reset it, which for a remote probe means a visit.
 *
 * **What it cost without a hold.** Each retry is a new loop of up to five starts, and `P-215`'s
 * arithmetic above gives each loop one or two alarms. So a probe that never stops crashing
 * re-alarmed at every retry, which broke `CLAUDE.md`'s *one outage, one alarm*. The bounds below
 * are that cost, still true of any type with no hold. `M-18`'s hold makes the whole crash loop
 * one alarm on Probe Health, asserted in the suite that follows.
 */
describe('a crash loop that `ms-recover` retries (`H-23`)', () => {
  it('comes back by itself once the cause has gone, where the start limit alone never did', () => {
    const loop = { ...MEASURED, limit: SHIPPED_LIMIT };
    const clearsAtMs = 30 * 60_000;
    const { rounds } = roundsWithRecovery(loop, SHIPPED_LIMIT, SHIPPED_RECOVERY, DAY, clearsAtMs);
    const back = rounds.find((round) => round.lengthMs === Number.POSITIVE_INFINITY);
    assert.ok(back !== undefined, 'never came back');
    // At the first retry after the cause went, and no later.
    assert.ok(back.start >= clearsAtMs);
    assert.ok(
      rounds.every((round) => round.start < clearsAtMs || round === back),
      'a retry after the cause had gone that did not stay up',
    );
    assert.ok(linkUpInRounds(rounds, loop.upFromMs, DAY), 'and it is still up a day later');
    // Without it: the same loop is `failed` from its sixth start for as long as anyone looks.
    const starts = startsOf(loop, DAY);
    assert.equal(starts.length, SHIPPED_LIMIT.burst);
    assert.equal(linkUpAt(loop, starts, DAY), false);
  });

  it('re-alarms at each retry of a loop that never ends when a return is not held', () => {
    const loop = { ...MEASURED, limit: SHIPPED_LIMIT };
    // The first day: the first loop and every retry the doubling cool-down fits into it.
    const dayOneLoops = loopsBetween(loop, 0, DAY);
    const dayOne = everyPhaseWithRecovery(loop, 0, DAY);
    // Any later day, at the cap.
    const laterLoops = loopsBetween(loop, DAY, 2 * DAY);
    const later = everyPhaseWithRecovery(loop, DAY, 2 * DAY);

    process.stdout.write(
      `\n    a crash loop that never ends, retried by ms-recover (the measured loop, every phase):\n` +
        `      first day  ${String(dayOneLoops)} loops, ${String(dayOne.least)}–${String(dayOne.most)} alarms\n` +
        `      a later day ${String(laterLoops)} loops, ${String(later.least)}–${String(later.most)} alarms\n`,
    );

    // The schedule, pinned: 10, 20, 40, 80, 160 minutes and then every 4 hours.
    assert.equal(dayOneLoops, 10);
    assert.equal(laterLoops, 6);
    // One or two a loop, as P-215 measured each loop: never more.
    assert.ok(dayOne.most <= 2 * dayOneLoops, `day one: ${notifications(dayOne.most)}`);
    assert.ok(later.most <= 2 * laterLoops, `a later day: ${notifications(later.most)}`);
    // And not one outage, one alarm, which is what `M-18`'s hold is for.
    assert.ok(dayOne.least > 1, `day one at least ${notifications(dayOne.least)}`);
  });
});

/** Read from the Probe Health type, so changing its hold re-runs this arithmetic (`M-18`). */
const SHIPPED_HOLD_MS = (probeHealth.recoveryHoldSeconds ?? 0) * 1_000;

/** Up or not, at the moment the core learnt it. */
type Observation = readonly [ms: number, up: boolean];

/**
 * How many alarms a run of observations raises when a return must last `holdMs` (`M-18`).
 *
 * A Down after a return that has lasted the hold is a new alarm, and one inside the hold is a
 * relapse: the same alarm. **A Down at the very moment the hold ends is a relapse.** The sweep's
 * reaction reaches the engine before the scheduler's pass that would have confirmed the return,
 * which is the order `play` below runs them in, and the engine reads a relapse before the time.
 * A hold of zero is the engine before `M-18`: every Down after an Up is an alarm.
 */
function alarmsUnderHold(observations: readonly Observation[], holdMs: number): number {
  let alarms = 0;
  let open = false;
  let returnedAt: number | null = null;
  let wasUp = true;
  for (const [ms, up] of observations) {
    if (returnedAt !== null && ms > returnedAt + holdMs) {
      // The return lasted, and the recovery went out.
      returnedAt = null;
      open = false;
    }
    if (wasUp && !up) {
      if (returnedAt !== null) returnedAt = null;
      else if (!open) {
        alarms += 1;
        open = true;
      }
    } else if (!wasUp && up && open) {
      returnedAt = ms;
    }
    wasUp = up;
  }
  return alarms;
}

/** What the thirty-second sweep reads of the link, which is what a trigger on Down hears. */
function sweepObservations(
  rounds: readonly Round[],
  upFromMs: number,
  times: readonly number[],
): Observation[] {
  return times.map((ms): Observation => [ms, linkUpInRounds(rounds, upFromMs, ms)]);
}

/**
 * What a trigger on Unknown hears of the same loop, through `M-22`'s episode.
 *
 * **Every kill, not every sweep.** A running core marks a probe lost when its socket closes and
 * found when it reconnects, so the episode that holds its sensors opens at each kill and ends at
 * each reconnect, and its alarm follows the loop itself. `P-215` and `H-23` counted the link's
 * Down trigger only, and this one went uncounted until `M-18`.
 */
function episodeObservations(rounds: readonly Round[], upFromMs: number): Observation[] {
  const observed: Observation[] = [];
  let up = true;
  for (const { start, lengthMs } of rounds) {
    if (up) observed.push([start, false]);
    up = lengthMs > upFromMs;
    if (!up) continue;
    observed.push([start + upFromMs, true]);
    if (Number.isFinite(lengthMs)) {
      observed.push([start + lengthMs, false]);
      up = false;
    }
  }
  return observed;
}

/** The rounds of a loop the start limit alone stops, as `roundsWithRecovery` gives them. */
function roundsOf(loop: RestartLoop, horizonMs: number): Round[] {
  return startsOf(loop, horizonMs).map((start, index) => ({
    start,
    lengthMs: loop.roundsMs[index % loop.roundsMs.length] ?? 1,
  }));
}

/**
 * Every phase of a loop, and the alarms each kind of trigger hears under `holdMs`: the loop begun
 * at each of its rounds, and the sweep at every second of its thirty.
 */
function everyPhaseHeld(
  loop: RestartLoop,
  rounds: (rotated: RestartLoop) => Round[],
  durationMs: number,
  holdMs: number,
): { down: { least: number; most: number; twoOrMore: number }; unknown: number[] } {
  const down: number[] = [];
  const unknown: number[] = [];
  for (let first = 0; first < loop.roundsMs.length; first += 1) {
    const rotated = {
      ...loop,
      roundsMs: [...loop.roundsMs.slice(first), ...loop.roundsMs.slice(0, first)],
    };
    const played = rounds(rotated).filter((round) => round.start < durationMs);
    unknown.push(alarmsUnderHold(episodeObservations(played, loop.upFromMs), holdMs));
    for (let offset = 0; offset < SWEEP_MS; offset += 1_000) {
      const times = sweepTimes(durationMs, offset);
      down.push(alarmsUnderHold(sweepObservations(played, loop.upFromMs, times), holdMs));
    }
  }
  return {
    down: {
      least: Math.min(...down),
      most: Math.max(...down),
      twoOrMore: down.filter((count) => count >= 2).length / down.length,
    },
    unknown,
  };
}

/**
 * `M-18`: a return to Up held for Probe Health's five minutes before the alarm is over.
 *
 * **What "genuine" means here.** A return that lasts the hold is genuine, and the next Down after
 * it is a second outage and a second alarm (the pipeline suite below walks one). Anything shorter
 * is a relapse. Five minutes was chosen over ten or fifteen for the delay it puts on every
 * probe's recovery notification, and it leaves one shape short: a probe connected about a minute
 * a round can still raise two at some phases, pinned below so nobody reads the bound as one.
 */
describe('one alarm per outage once a return must last Probe Health’s hold (`M-18`)', () => {
  it('reads a five-minute hold from Probe Health', () => {
    // Pinned, so the counts below are known to be about the hold that ships.
    assert.equal(SHIPPED_HOLD_MS, 300_000);
  });

  it('agrees with the arithmetic above when there is no hold', () => {
    // The two models of a sweep's outages have to be one model, or the counts below are about
    // something else.
    for (const loop of [MEASURED, { ...MEASURED, limit: SHIPPED_LIMIT }]) {
      for (let offset = 0; offset < SWEEP_MS; offset += 1_000) {
        const times = sweepTimes(HOUR, offset);
        assert.equal(
          alarmsUnderHold(sweepObservations(roundsOf(loop, HOUR + 60_000), DOWN_MS, times), 0),
          observedOutages(loop, HOUR, offset),
          `sweep at +${String(offset / 1000)} s`,
        );
      }
    }
  });

  it('raises one alarm for every loop shape the start limit stops, but for one at some phases', () => {
    const shapes: readonly [string, RestartLoop][] = [
      ['the measured loop', MEASURED],
      ...[5_000, 15_000, 30_000].map((ms): [string, RestartLoop] => [
        `connected ${String(ms / 1000)} s`,
        connectedFor(ms),
      ]),
    ];
    for (const [name, shape] of shapes) {
      const loop = { ...shape, limit: SHIPPED_LIMIT };
      const held = everyPhaseHeld(
        loop,
        (rotated) => roundsOf(rotated, 2 * HOUR),
        HOUR,
        SHIPPED_HOLD_MS,
      );
      assert.deepEqual([held.down.least, held.down.most], [1, 1], name);
    }
    // The shape the five minutes leave short, and why: its five Down gaps of 6.5 s can all fall
    // between sweeps, so the sweep reads about five minutes of loop as one return, and the Down
    // that ends it comes just after the hold confirmed it. Ten minutes would have made it one.
    const minute = { ...connectedFor(60_000), limit: SHIPPED_LIMIT };
    const short = everyPhaseHeld(
      minute,
      (rotated) => roundsOf(rotated, 2 * HOUR),
      HOUR,
      SHIPPED_HOLD_MS,
    );
    assert.deepEqual([short.down.least, short.down.most], [1, 2]);
    assert.ok(
      short.down.twoOrMore > 0.05 && short.down.twoOrMore < 0.2,
      `two at ${(short.down.twoOrMore * 100).toFixed(0)}% of phases`,
    );
    const ten = everyPhaseHeld(minute, (rotated) => roundsOf(rotated, 2 * HOUR), HOUR, 600_000);
    assert.equal(ten.down.most, 1, 'ten minutes, for the record');
  });

  it('raises one alarm for the measured loop even with nothing to stop it', () => {
    const held = everyPhaseHeld(
      MEASURED,
      (rotated) => roundsOf(rotated, 2 * HOUR),
      HOUR,
      SHIPPED_HOLD_MS,
    );
    assert.deepEqual([held.down.least, held.down.most], [1, 1]);
    assert.ok(
      held.unknown.every((count) => count === 1),
      held.unknown.join(', '),
    );
  });

  it('raises one alarm on a trigger on Unknown, where without the hold it raised one per kill', () => {
    for (const shape of [MEASURED, ...[5_000, 15_000, 30_000, 60_000].map(connectedFor)]) {
      const loop = { ...shape, limit: SHIPPED_LIMIT };
      const rounds = (rotated: RestartLoop): Round[] => roundsOf(rotated, 2 * HOUR);
      // The first kill and the five rounds' own: six episodes, six alarms, at every phase.
      const unheld = everyPhaseHeld(loop, rounds, HOUR, 0);
      assert.ok(
        unheld.unknown.every((count) => count === SHIPPED_LIMIT.burst + 1),
        unheld.unknown.join(', '),
      );
      const held = everyPhaseHeld(loop, rounds, HOUR, SHIPPED_HOLD_MS);
      assert.ok(
        held.unknown.every((count) => count === 1),
        held.unknown.join(', '),
      );
    }
  });

  it('raises one alarm per outage under `ms-recover`’s retries, on a trigger on Down and on Unknown', () => {
    // `H-23`'s scenario, extended as `M-18` asked: a crash loop that never ends, retried at 10,
    // 20, 40, 80 and 160 minutes and then every four hours. The link is down between retries, so
    // each retry's loop relapses into the outage it never left.
    const loop = { ...MEASURED, limit: SHIPPED_LIMIT };
    const rounds = (rotated: RestartLoop): Round[] =>
      roundsWithRecovery(rotated, SHIPPED_LIMIT, SHIPPED_RECOVERY, 3 * DAY).rounds;
    for (const days of [1, 2]) {
      const unheld = everyPhaseHeld(loop, rounds, days * DAY, 0);
      const held = everyPhaseHeld(loop, rounds, days * DAY, SHIPPED_HOLD_MS);
      process.stdout.write(
        `\n    ${String(days)} day(s) of a crash loop that never ends, retried by ms-recover:\n` +
          `      on Down    ${String(unheld.down.least)}–${String(unheld.down.most)} without the hold, ` +
          `${String(held.down.least)}–${String(held.down.most)} with it\n` +
          `      on Unknown ${String(Math.max(...unheld.unknown))} without the hold, ` +
          `${String(Math.max(...held.unknown))} with it\n`,
      );
      assert.deepEqual(
        [held.down.least, held.down.most],
        [1, 1],
        `${String(days)} day(s), on Down`,
      );
      assert.ok(
        held.unknown.every((count) => count === 1),
        `${String(days)} day(s), on Unknown`,
      );
    }
  });

  it('alarms again for a second outage after a return that lasted the hold', () => {
    // Genuine, in arithmetic: back and connected for an hour, then gone for good. The pipeline
    // suite walks the same through the engine.
    const observed: Observation[] = [
      [0, false],
      [60_000, true],
      [60_000 + HOUR, false],
    ];
    assert.equal(alarmsUnderHold(observed, SHIPPED_HOLD_MS), 2);
    // And a return one sweep short of the hold is the same outage.
    const short: Observation[] = [
      [0, false],
      [60_000, true],
      [60_000 + SHIPPED_HOLD_MS, false],
    ];
    assert.equal(alarmsUnderHold(short, SHIPPED_HOLD_MS), 1);
  });
});

/**
 * `P-215`: a probe killed at its memory ceiling and restarted, and the alarms that makes.
 *
 * `P-213` made both units' ceiling kill rather than throttle, and nothing in either unit ever
 * stops restarting: `RestartSec=5s` keeps five starts from fitting in systemd's default ten-second
 * window, so the default start limit can never trip. **One outage, one alarm** (`CLAUDE.md`) is
 * then a question of what the loop looks like from the core, and this counts it.
 *
 * **The link is judged by a lookup, so it is immediate** (`docs/state-machine.md` §2.2): no
 * two-step rule softens it, and a probe that is connected at one sweep and not at the next is Up
 * and then Down. State triggers default `initialLatencySeconds` to 0, so nothing downstream
 * softens it either. What decides the count is the phase between the loop and the sweep.
 *
 * Driven through the real sweep, the real `ms.probe.link` lookup, the real state machine, trigger
 * engine and scheduler. Only ingestion's batching is skipped: it moves results, it does not judge
 * them, and the judgement — `rollUp` over the lookup — is the same function ingestion calls.
 */
describe(
  'a probe restarted at its memory ceiling, and how many alarms it raises',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let engine: AlarmEngine;
    let scheduler: AlarmScheduler;
    let triggers: TriggerService;
    let probeId: number;
    let sensorId: number;
    /**
     * Whether the engine reads the types' holds (`M-18`). The cases that count the loop's outages
     * run without, and `M-18`'s run with the catalogue, as `main.ts` wires it.
     */
    let holding = false;
    const holds = holdsFrom(standardCatalogue());

    before(async () => {
      assert.ok(PROBE_LINK !== undefined, 'the built-in ms.probe.link lookup is missing');
      scratch = await createScratchDatabase('proberestart');
      db = scratch.db;
      engine = new AlarmEngine({
        logger: silent,
        alarms: new AlarmRepository(),
        recoveryHolds: (type) => (holding ? holds(type) : 0),
      });
      h = await buildHarness(db, { states: true, alarms: engine });
      const sync = new TriggerSync({ engine, logger: silent });
      h.audit.also = sync;
      triggers = new TriggerService({
        db,
        audit: new CompositeAuditSink([new DatabaseAuditSink(), sync]),
        logger: silent,
      });
      scheduler = new AlarmScheduler({ db, engine, logger: silent });
    });

    after(async () => {
      scheduler.stop();
      await scratch.drop();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM notification_request');
      await db.query('DELETE FROM notification_alarm');
      await db.query('DELETE FROM notification_trigger');
      await db.query(`DELETE FROM object WHERE kind = 'probe'`);

      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
      });
      probeId = probe.id;
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'probe-box',
        host: '127.0.0.1',
      });
      sensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: device.id,
          name: 'Probe Health',
          sensorType: 'ms.probe.health',
          params: {},
        })
      ).id;

      // What an installation has unless somebody changed it: tell me when it goes Down, at once.
      await triggers.create(testActor, probeId, {
        kind: 'state',
        settings: { state: 'down', initialLatencySeconds: 0, initialTemplateId: TEMPLATE },
      });
    });

    function link(up: boolean, now: Date): ProbeLink {
      if (!up) return { connected: false };
      return {
        connected: true,
        gid: 'probe-gid',
        clockOffsetMs: null,
        protocolVersion: PROTOCOL_VERSION,
        connectedAt: now,
        lastHeartbeatAt: now,
        approved: true,
        agentVersion: '1.0.0',
        assignedSensors: 100,
        cadenceSeconds: 60,
        connectedForMs: 1_000,
        sinceResultsMs: 0,
        sinceConfigMs: 0,
        configured: true,
        configurable: true,
        lastResultsAt: now,
        configSentAt: now,
      };
    }

    /** What ingestion does with a Probe Health result, for the one channel that decides it. */
    async function ingest(results: readonly CheckResult[], now: Date): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined && PROBE_LINK !== undefined);
      const decided: SensorResult[] = results.map((result) => {
        const connected = result.channels.find((channel) => channel.key === 'connected');
        return {
          sensorId: result.sensorId,
          at: now,
          outcome: result.outcome,
          message: result.message,
          channels:
            connected === undefined
              ? null
              : rollUp([
                  {
                    key: 'connected',
                    name: 'Link to the core',
                    unit: '',
                    value: connected.value,
                    decimals: null,
                    limits: NO_LIMITS,
                    lookupId: PROBE_LINK.id,
                    lookup: PROBE_LINK,
                  },
                ]),
        };
      });
      const decisions = await states.decide(decided);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
        await engine.react(
          q,
          decided.map((one) => one.sensorId),
          now,
        );
      });
    }

    /** Plays the loop past the core's sweep, and returns how many notifications it asked for. */
    async function play(loop: RestartLoop, durationMs: number, offsetMs: number): Promise<number> {
      const starts = startsOf(loop, durationMs + 60_000);
      for (const ms of sweepTimes(durationMs, offsetMs)) {
        const now = at(ms);
        const up = linkUpAt(loop, starts, ms);
        const service = new ProbeHealthService({
          vouching: everyVoucherHolds,
          db,
          logger: silent,
          sources: { link: () => link(up, now) },
          ingest: (results) => ingest(results, now),
          now: () => now,
        });
        await service.sweep();
        await scheduler.sweep(now);
      }
      const rows = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notification_request',
      );
      return Number(rows[0]?.n ?? 0);
    }

    async function stateNow(): Promise<string | undefined> {
      const rows = await db.query<{ state: string }>(
        'SELECT state FROM sensor_runtime WHERE object_id = $1',
        [sensorId],
      );
      return rows[0]?.state;
    }

    it('raises one alarm when the restarted probe never gets as far as connecting', async () => {
      // Every start dies before the link comes up — the loop `P-213` measured with the ceiling
      // below the probe's baseline. Quiet, and uninformative: the reason is on the probe's box.
      const notified = await play({ ...MEASURED, upFromMs: 60_000 }, 10 * 60_000, 15_000);
      assert.equal(notified, 1);
      assert.equal(await stateNow(), 'down');
    });

    // **Fidelity, not the bound.** The bound is the pure suite above, over every phase. What only a
    // database can show is that the real pipeline turns each outage the sweep saw into exactly one
    // notification — collapsing none and adding none — so the arithmetic's count is the count an
    // operator would get. Two phases each, one of them a phase that raises two with the limit.

    for (const offsetMs of [15_000, 3_000]) {
      it(`raises one notification per outage the sweep sees, unbounded (sweep at +${String(offsetMs / 1000)} s)`, async (t) => {
        const notified = await play(MEASURED, HOUR, offsetMs);
        assert.equal(notified, observedOutages(MEASURED, HOUR, offsetMs));
        assert.ok(notified > 30, `expected a storm, got ${String(notified)} in an hour`);
        t.diagnostic(`an hour of the measured loop, never stopped: ${notifications(notified)}`);
      });

      it(`raises one notification per outage the sweep sees, with the start limit (sweep at +${String(offsetMs / 1000)} s)`, async (t) => {
        const limited: RestartLoop = { ...MEASURED, limit: SHIPPED_LIMIT };
        const notified = await play(limited, HOUR, offsetMs);
        assert.equal(notified, observedOutages(limited, HOUR, offsetMs));
        assert.equal(await stateNow(), 'down', 'and it stays Down, where an operator will see it');
        t.diagnostic(`the same loop, stopped by the start limit: ${notifications(notified)}`);
      });
    }

    // **`M-18`, through the pipeline.** The arithmetic above says what the hold gives over every
    // phase; this says the engine gives exactly that at a few, one of them the phase where the
    // five minutes leave a minute-a-round loop at two.
    const held = (t: { after: (fn: () => void) => void }): void => {
      holding = true;
      t.after(() => {
        holding = false;
      });
    };
    const expected = (loop: RestartLoop, offsetMs: number): number =>
      alarmsUnderHold(
        sweepObservations(roundsOf(loop, HOUR + 60_000), loop.upFromMs, sweepTimes(HOUR, offsetMs)),
        SHIPPED_HOLD_MS,
      );

    for (const offsetMs of [15_000, 3_000]) {
      it(`raises one notification for the whole loop when a return must last the hold (sweep at +${String(offsetMs / 1000)} s)`, async (t) => {
        held(t);
        const notified = await play(MEASURED, HOUR, offsetMs);
        assert.equal(notified, expected(MEASURED, offsetMs));
        assert.equal(notified, 1);
      });

      it(`raises one notification for the loop the start limit stops when a return must last the hold (sweep at +${String(offsetMs / 1000)} s)`, async (t) => {
        held(t);
        const limited: RestartLoop = { ...MEASURED, limit: SHIPPED_LIMIT };
        const notified = await play(limited, HOUR, offsetMs);
        assert.equal(notified, expected(limited, offsetMs));
        assert.equal(notified, 1);
      });
    }

    it('raises two for a minute-a-round loop at a phase where the sweep reads the loop as one return', async (t) => {
      // The shape five minutes leaves short, at a phase the arithmetic says gives two: every Down
      // gap falls between sweeps, and the hold confirms the return just before the loop stops.
      held(t);
      const minute: RestartLoop = { ...connectedFor(60_000), limit: SHIPPED_LIMIT };
      const notified = await play(minute, HOUR, 2_000);
      assert.equal(expected(minute, 2_000), 2, 'the arithmetic’s phase');
      assert.equal(notified, 2);
    });

    it('raises a second notification for an outage after a return that lasted the hold', async (t) => {
      // What "genuine" means, through the engine: Down for a minute, back for an hour, gone again.
      held(t);
      const genuine: RestartLoop = { roundsMs: [HOUR], upFromMs: 60_000 };
      const notified = await play(genuine, HOUR + 5 * 60_000, 15_000);
      assert.equal(notified, 2);
    });
  },
);
