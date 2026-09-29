import type { SensorCatalogue } from '@ms/sensors';
import type { Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import type { SensorState, SensorStateCause } from '../state/tables.js';
import { STATE_TRIGGER, THRESHOLD_TRIGGER, triggerKinds } from '../triggers/definition.js';
import type { EffectiveTrigger } from '../triggers/repository.js';
import { TriggerRepository } from '../triggers/repository.js';
import {
  fire,
  reconcile,
  recoveryConfirmAt,
  stillStanding,
  type Alarm,
  type Reconciliation,
  type StateTriggerSettings,
} from './chain.js';
import {
  acknowledgedEpisode,
  episodeEndedMessage,
  episodeMessage,
  isCarried,
  isLive,
  seenBy,
  type EndedEpisode,
  type ProbeEpisode,
  type ProbeEpisodes,
} from './episodes.js';
import {
  AlarmRepository,
  type AlarmAdvance,
  type AlarmInsert,
  type AlarmRow,
  type DueAlarm,
  type RequestInsert,
  type SensorStanding,
} from './repository.js';
import {
  fireThreshold,
  readingsAreCurrent,
  reconcileThreshold,
  thresholdDueAt,
  type ChannelReading,
  type ThresholdCondition,
  type ThresholdTriggerSettings,
} from './threshold.js';

export interface AlarmEngineOptions {
  logger: Logger;
  alarms?: AlarmRepository;
  triggers?: TriggerRepository;
  /**
   * How many alarms one due-sweep fires.
   *
   * Bounded so a clock jump forward, or a core that was down over a long outage, cannot turn one
   * sweep into an unbounded write. What is left is still due at the next one.
   */
  maxPerSweep?: number;
  /** How many sensors one trigger edit reconciles. Beyond this the sweep picks the rest up. */
  maxReconciled?: number;
  /**
   * How far back a channel reading may be and still count as the channel's current value
   * (`N-03`).
   *
   * A threshold trigger is a claim about the present, so a reading from yesterday is not one —
   * a sensor that stopped reporting has no current value, which is not the same as a value of
   * zero. Six hours by default: generous enough for any sane scan interval, and short enough
   * that the lookup stays inside the newest chunk or two of a hypertable chunked by the day.
   */
  valueLookbackMs?: number;
  /**
   * Poked whenever a reaction armed an alarm (`N-04`).
   *
   * `AlarmScheduler.wake` in production: it sleeps until the next due time, and an alarm armed
   * with a nearer one has to end that sleep. Called inside the arming transaction, before the
   * commit that may never happen — a spurious wake costs one indexed query, and the alternative
   * is an after-commit hook threaded through every path that can arm an alarm.
   */
  onArmed?: () => void;
  /**
   * Poked whenever a notification request is queued (`N-07`).
   *
   * `DeliveryLoop.wake` in production. Same contract as `onArmed` and the same caveat: it fires
   * inside the queueing transaction, so a pass prompted by it may find nothing yet — which is
   * one indexed query on a partial index, against a notification that would otherwise wait for
   * the loop's idle heartbeat.
   */
  onQueued?: () => void;
  /**
   * Which probe holds which sensors, and which sensors are its own alarm (`M-22`).
   *
   * Absent, a lost or frozen probe's sensors notify one by one, as they did before it existed.
   */
  episodes?: ProbeEpisodes;
  /**
   * How long a sensor type holds a return to Up before its alarm is over, in seconds (`M-18`).
   * The catalogue's `recoveryHoldSeconds` in production. A trigger's own setting overrides it.
   *
   * Absent, no type holds one, and every alarm ends at its return as it did before.
   */
  recoveryHolds?: (sensorType: string) => number;
}

/** A sensor as the hold reads it: its id, and its state and why. */
interface Held {
  readonly sensorId: number;
  readonly state: SensorState;
  readonly cause: SensorStateCause | null;
}

/**
 * Which probe holds each carried sensor, and which triggers hear about that probe from its own
 * alarm (`M-22`).
 */
interface Holds {
  readonly carrier: ReadonlyMap<number, number>;
  /** By probe: the state triggers that cover one of its live probe-alarm sensors. */
  readonly covering: ReadonlyMap<number, ReadonlySet<number>>;
}

const NO_HOLDS: Holds = { carrier: new Map(), covering: new Map() };

/** What one (sensor, state trigger) pair sees, beyond the sensor's own row (`M-22`). */
interface Seen {
  readonly held: boolean;
  /** The episode this sensor stands for, when it is a live probe-alarm sensor. */
  readonly episode: ProbeEpisode | undefined;
  /** The last episode it stood for that has ended. A recovery closing it says so. */
  readonly ended: EndedEpisode | undefined;
  readonly names: ReadonlyMap<number, string>;
}

const PLAIN: Seen = { held: false, episode: undefined, ended: undefined, names: new Map() };

/** What a reaction did. Every field is a counter Core Health will want (`M-18`, `N-13`). */
export interface AlarmReaction {
  armed: number;
  cleared: number;
  suppressed: number;
  resumed: number;
  /** Returns held rather than recovered (`M-18`). */
  recovering: number;
  queued: number;
}

const EMPTY: AlarmReaction = {
  armed: 0,
  cleared: 0,
  suppressed: 0,
  resumed: 0,
  recovering: 0,
  queued: 0,
};

const DEFAULT_MAX_PER_SWEEP = 500;
const DEFAULT_MAX_RECONCILED = 20_000;
const DEFAULT_VALUE_LOOKBACK_MS = 6 * 60 * 60 * 1_000;

/**
 * The state trigger's engine (`N-02`).
 *
 * Two entry points, and the division between them is the whole design.
 *
 * `react` is called whenever sensors may have moved — from the ingestion write and from
 * `SensorStateService.reevaluate`, which between them cover every path that can change a state.
 * It reconciles: it compares where each sensor is now against the alarms standing for it, and
 * arms, suppresses, resumes or stands them down. It consumes no events and keeps no memory, so a
 * missed call is corrected by the next one and a restart needs no replay.
 *
 * `sweep` fires what has fallen due. `N-04` is what will call it at the right moment rather than
 * on a fixed tick; the due times themselves are absolute and already in the table, so the
 * difference between the two is promptness, not correctness.
 *
 * **Nothing here delivers anything.** A fired step queues a `notification_request` in the same
 * transaction that advanced the alarm, which is what makes "sent exactly once" reachable at all.
 * `N-05` gives the template ids meaning and `N-07` onwards deliver.
 */
/** How a reaction should behave, for the callers that are not an ordinary state change. */
export interface ReactionOptions {
  /**
   * Where the initial latency is measured from (`P-181`).
   *
   * Absent, or `'state'`: from the sensor's own `since`, which is what a trigger edit wants — an
   * outage already an hour old is already past a five-minute latency. `'now'` starts the clock
   * at this reaction, which is what a reconciliation at boot wants: there, `since` is as old as
   * the outage, so every deadline computed from it is already past and the sweep fires the page,
   * the escalation and the repeat on consecutive passes.
   */
  armFrom?: 'state' | 'now';
}

export class AlarmEngine {
  readonly #alarms: AlarmRepository;
  readonly #triggers: TriggerRepository;
  readonly #logger: Logger;
  readonly #maxPerSweep: number;
  readonly #maxReconciled: number;
  readonly #valueLookbackMs: number;
  readonly #onArmed: (() => void) | undefined;
  readonly #onQueued: (() => void) | undefined;
  readonly #episodes: ProbeEpisodes | undefined;
  readonly #recoveryHolds: ((sensorType: string) => number) | undefined;
  #queued = 0;
  #fired = 0;
  /**
   * Steps that fell due and named no template.
   *
   * Not an error and not a drop: "do not tell me when it goes down, tell me if it is still down
   * in half an hour" is a trigger with no initial template, and the chain still has to run
   * through `initial` to reach the escalation. Counted so an operator wondering why a trigger is
   * silent can see that it is firing and sending nothing.
   */
  #untemplated = 0;

  constructor(options: AlarmEngineOptions) {
    this.#alarms = options.alarms ?? new AlarmRepository();
    this.#triggers = options.triggers ?? new TriggerRepository();
    this.#logger = options.logger.child({ component: 'alarms' });
    this.#maxPerSweep = options.maxPerSweep ?? DEFAULT_MAX_PER_SWEEP;
    this.#maxReconciled = options.maxReconciled ?? DEFAULT_MAX_RECONCILED;
    this.#valueLookbackMs = options.valueLookbackMs ?? DEFAULT_VALUE_LOOKBACK_MS;
    this.#onArmed = options.onArmed;
    this.#onQueued = options.onQueued;
    this.#episodes = options.episodes;
    this.#recoveryHolds = options.recoveryHolds;
  }

  get stats(): { queued: number; fired: number; untemplated: number } {
    return { queued: this.#queued, fired: this.#fired, untemplated: this.#untemplated };
  }

  /**
   * Reconciles a batch of sensors against the triggers that apply to them.
   *
   * Inside the caller's transaction, always. A sensor whose state committed without its alarm
   * would be an outage nobody is tracking, and one whose alarm committed without its state would
   * page somebody about a sensor that is fine.
   */
  /**
   * Whether a result batch has to be reconciled in full, or only where the state moved (`P-104`).
   *
   * A state trigger fires on a transition, so reacting to the sensors that transitioned is
   * complete for it. A **threshold** trigger fires on a *reading*, and a reading changes without
   * the state changing — so `if (transitions.length > 0)` on the ingestion path meant a breach on
   * a stable Up sensor never armed anything, and a breach that cleared while the sensor stayed Up
   * was never stood down and paged after its latency with a value that was minutes stale.
   *
   * The engine's own sweep comment relies on the opposite — "react stands the alarm down the
   * moment a reading clears it" — and nothing was calling it to.
   *
   * **The gate is global on purpose.** Working out which sensors in a batch are covered by a
   * threshold trigger is the inheritance walk that `react` itself does, so asking it first would
   * cost the thing it is meant to avoid. One indexed existence check answers `false` on every
   * installation that has not configured this feature, and those pay nothing; one that has pays
   * a full reconcile per batch, which is what making the feature work costs.
   */
  async reconcilesReadings(q: Queryable): Promise<boolean> {
    return this.#alarms.anyThresholdTriggers(q, THRESHOLD_TRIGGER.id);
  }

  async react(
    q: Queryable,
    sensorIds: readonly number[],
    now: Date,
    options: ReactionOptions = {},
  ): Promise<AlarmReaction> {
    if (sensorIds.length === 0) return { ...EMPTY };
    // The guard, first and cheapest. An installation that notifies nobody pays exactly this.
    if (!(await this.#alarms.anyWork(q))) return { ...EMPTY };

    // One at a time, deliberately. `q` is always a transaction's client here — the method
    // contract above says so — and a client is one wire: `Promise.all` bought no parallelism,
    // only pg's "already executing a query" deprecation, which `N-15`'s scenario test surfaced.
    const asked = await this.#alarms.standingOf(q, sensorIds);
    // **The link back from a probe alarm to what it holds** (`M-24`). A probe alarm in this batch
    // that is not live, paused or withheld, is no route to anybody, so the sensors its probe
    // holds are re-decided here with it, unheld, and notify one by one: the same answer as a
    // Probe Health paused before the loss. The other direction needs nothing: whatever moves an
    // episode, lost or found, frozen or thawed, or the tree, re-evaluates the probe's alarm in
    // the same transaction as the sensors it carries, and the sweep parks what a resumed alarm
    // holds again.
    const released = this.#released(sensorIds, asked);
    const ids = released.length === 0 ? sensorIds : [...sensorIds, ...released];
    const standing =
      released.length === 0
        ? asked
        : new Map([...asked, ...(await this.#alarms.standingOf(q, released))]);
    // Which of these a probe holds, and under which triggers (`M-22`).
    const holds = await this.#holds(q, standing.values());
    const names = await this.#episodeNames(q, ids);
    const existing = await this.#alarms.alarmsFor(q, ids);
    const effective = await this.#triggers.effectiveForMany(q, ids);

    // Only the channels some threshold trigger in this batch actually names, and only when
    // there is one. An installation with no threshold triggers never touches the hypertable.
    const values = await this.#alarms.currentValues(
      q,
      ids,
      channelKeysIn(effective),
      now,
      this.#valueLookbackMs,
    );

    const arm: AlarmInsert[] = [];
    const advance: AlarmAdvance[] = [];
    const clear: number[] = [];
    const requests: RequestInsert[] = [];
    const result: AlarmReaction = { ...EMPTY };

    for (const sensorId of ids) {
      const sensor = standing.get(sensorId);
      // No runtime row means no sensor, or one that has never been decided. Either way there is
      // nothing to reconcile against, and any alarm for it went with the object's cascade.
      if (sensor === undefined) continue;
      const carrier = holds.carrier.get(sensorId);
      const covering = carrier === undefined ? undefined : holds.covering.get(carrier);
      const episode =
        this.#episodes !== undefined && isLive(sensor)
          ? this.#episodes.episodeOf(sensorId)
          : undefined;
      const ended = this.#episodes?.endedEpisodeOf(sensorId);

      const readings = values.get(sensorId);
      const alarms = new Map(
        (existing.get(sensorId) ?? []).map((alarm) => [alarm.triggerId, alarm]),
      );
      for (const trigger of effective.get(sensorId) ?? []) {
        if (!trigger.enabled) continue;
        const out = { arm, advance, clear, requests, result };

        if (trigger.kind === STATE_TRIGGER.id) {
          const alarm = alarms.get(trigger.id) ?? null;
          // **Claimed before the settings are read** (`P-114`). Anything still in this map at the
          // end of the sensor is treated as an orphan and deleted; a trigger this build cannot
          // parse is not an orphan, it is a trigger this build cannot judge. Skipping while
          // leaving the row claimed means a downgrade — or a settings shape written by a newer
          // build — logs a warning and changes nothing, rather than silently cancelling the
          // standing alarm for an outage that is still happening.
          alarms.delete(trigger.id);
          const stored = readSettings(trigger, this.#logger);
          if (stored === null) continue;
          const seen: Seen =
            covering === undefined && episode === undefined && ended === undefined
              ? PLAIN
              : { held: covering?.has(trigger.id) === true, episode, ended, names };
          const settings = this.#forSensor(stored, sensor.type);
          this.#apply(sensor, trigger, alarm, settings, now, out, options, seen);
          continue;
        }

        if (trigger.kind === THRESHOLD_TRIGGER.id) {
          const alarm = alarms.get(trigger.id) ?? null;
          alarms.delete(trigger.id);
          const settings = readThreshold(trigger, this.#logger);
          if (settings === null) continue;
          // `undefined` from the map is "no reading", which is not zero (`CLAUDE.md`). And a
          // sensor whose last check failed, or that nobody is scanning, has no current value
          // whatever the hypertable still holds for it — see `readingsAreCurrent`.
          const reading: ChannelReading = readingsAreCurrent(sensor)
            ? (readings?.get(settings.channelKey) ?? null)
            : null;
          this.#applyThreshold(sensor, trigger, alarm, settings, reading, now, out);
          continue;
        }

        // **A kind this build does not know is not an orphan either** (`G13`). `P-114` made an
        // unreadable *settings* shape leave its alarm standing, on the reasoning that a trigger
        // this build cannot judge is not a trigger that has gone away — and left the identical
        // case one level up unhandled. A `speed` trigger written by build N+1 matches neither
        // branch, so it never claims its alarm, and the orphan sweep below deletes it: no
        // recovery notification, nothing logged past a `cleared` count, and on the roll-forward
        // the chain arms fresh from the sensor's current `since` — a second initial page for
        // one continuous outage, with the escalation deadline reset.
        alarms.delete(trigger.id);
        this.#logger.warn(
          { triggerId: trigger.id, kind: trigger.kind, sensorId },
          'this build does not know that trigger kind; leaving its alarm as it stands',
        );
      }

      // Whatever is left applied to this sensor once and no longer does — a trigger deleted, or
      // disabled, or the sensor moved out from under it. Nothing recovered, so nobody is told.
      for (const orphan of alarms.values()) {
        clear.push(orphan.id);
        result.cleared += 1;
      }
    }

    result.queued = await this.#alarms.queue(q, requests);
    this.#queued += result.queued;
    this.#untemplated += requests.length - result.queued;
    await this.#alarms.advance(q, advance);
    // **Cleared before armed, and the order is load-bearing** (`P-112`, `P-115`). `arm` is
    // `ON CONFLICT (sensor_id, trigger_id) DO NOTHING`, so a pair that is both cleared and armed
    // in one reaction — a trigger retargeted onto the state the sensor is already in, or one
    // whose kind changed under a standing alarm — would have its insert swallowed by the row it
    // is replacing and then lose that row to the delete. Arming into the hole the clear leaves
    // is the only order that survives both.
    await this.#alarms.clear(q, clear);
    await this.#alarms.arm(q, arm);
    // **Armed or resumed** (`P-117`). A reaction that only cleared alarms has made the next due
    // time later, never sooner, and a scheduler asleep for longer than it needs is not worth a
    // query. A resume is the other case: an acknowledgement lapsing, or a sensor returning to the
    // state after a probe blip, gives an alarm a due time that can be sooner than anything the
    // scheduler is currently sleeping for — and it would then sleep straight past it, delaying an
    // escalation by however long the next unrelated event happened to be away.
    // And a held return (`M-18`), whose confirmation is a due time like any other.
    if (arm.length > 0 || result.resumed > 0 || result.recovering > 0) this.#onArmed?.();
    if (result.queued > 0) this.#onQueued?.();
    return result;
  }

  /**
   * Re-decides, unheld, what deleted probe-alarm sensors held (`M-25`).
   *
   * **The one path `#released` cannot see.** A Probe Health paused or withheld mid-loss is in the
   * batch that re-decides it, and brings what its probe holds with it (`M-24`). A deleted one has
   * no row, and nothing re-decided anything for it: the sensors held behind it stayed held, with
   * no alarm under any trigger that heard of the probe only from it, until each was next
   * re-decided. That was usually when the probe came back, when there was nothing left to say.
   *
   * Asked from the delete's own transaction, while the episode index still maps the deleted
   * sensor to its probe: Probe Health's targets are re-read only at its next sweep. `#holds` then
   * finds no row for it, so a trigger it alone covered stops holding, and one that another live
   * Probe Health covers still holds.
   */
  async releaseDeleted(
    q: Queryable,
    sensorIds: readonly number[],
    now: Date,
  ): Promise<AlarmReaction> {
    const episodes = this.#episodes;
    if (episodes === undefined || sensorIds.length === 0) return { ...EMPTY };
    const deleted = new Set(sensorIds);
    const held = new Set<number>();
    for (const sensorId of sensorIds) {
      for (const id of episodes.heldFor(sensorId)) {
        if (!deleted.has(id)) held.add(id);
      }
    }
    if (held.size === 0) return { ...EMPTY };
    return this.react(q, [...held], now);
  }

  /**
   * Fires every alarm whose next step has fallen due.
   *
   * Returns how many it fired, so a caller that got a full sweep can come straight back rather
   * than waiting for the next tick.
   */
  /**
   * Parks an alarm whose trigger this build cannot read (`P-152`).
   *
   * **`P-114` stopped the reaction from deleting these rows, and left the sweep unable to do
   * anything with them at all.** After that change no path could clear one: `react` claims the
   * trigger out of the orphan map and skips it, the sweep reads the same settings and bails, and
   * the stale-alarm clear sits below that bail. A row whose `next_due_at` was already past — the
   * ordinary state for anything pending past its latency or carrying a repeat — was returned by
   * `due` on every pass for ever, and `AlarmScheduler` clamps an immediately-due row to its
   * 25 ms floor: forty sweeps a second, two queries and a warn line each, until somebody noticed
   * the log. That is the pathology `P-115` names as unacceptable, reintroduced in the same
   * commit that fixed it.
   *
   * Parked rather than cleared, which keeps `P-114`'s point: the alarm still stands, so the
   * outage it is about is not forgotten, and `suppressed` is what a chain waiting to be resumed
   * already means. When the trigger becomes readable — an upgrade, or the settings corrected —
   * the reaction un-parks it and the chain picks up where it stopped: `reconcile`'s `resume`
   * branch for a state alarm, and `#applyThreshold`'s `hold` branch for a threshold one
   * (`P-170`). Those are two different paths and the second did not exist when this was
   * written, which left every parked threshold alarm stranded — never due, never notified, and
   * silently deleted when the value came back under its limit.
   *
   * **Collected separately from the firings**, because a park is not a firing: counting it as one
   * would put it on Core Health's `alarmsFired` and tell a caller that got a full sweep to come
   * straight back for more work that does not exist.
   */
  #park(alarm: DueAlarm, parked: AlarmAdvance[]): void {
    parked.push({
      id: alarm.id,
      phase: alarm.phase,
      nextDueAt: null,
      repeats: alarm.repeats,
      suppressed: true,
      // A parked return is no longer being timed. Re-decided when it is un-parked, it is held
      // again from the sensor's return, or over if that return has already lasted.
      recoveringSince: null,
      observed: alarm.observed,
    });
  }

  async sweep(q: Queryable, now: Date): Promise<{ fired: number; queued: number }> {
    const due = await this.#alarms.due(q, now, this.#maxPerSweep);
    if (due.length === 0) return { fired: 0, queued: 0 };
    const holds = await this.#holds(
      q,
      due
        .filter((alarm) => alarm.kind === 'state')
        .map((alarm) => ({
          sensorId: alarm.sensorId,
          state: alarm.currentState,
          cause: alarm.currentCause,
        })),
    );
    const names = await this.#episodeNames(
      q,
      due.map((alarm) => alarm.sensorId),
    );

    const advance: AlarmAdvance[] = [];
    const parked: AlarmAdvance[] = [];
    // Held returns decided without a firing (`M-18`): written back, never counted as fired.
    const settled: AlarmAdvance[] = [];
    const requests: RequestInsert[] = [];
    const clear: number[] = [];

    for (const alarm of due) {
      if (alarm.kind === 'threshold') {
        // No staleness check to make. A threshold alarm's condition is a value, and the value it
        // was armed with is on the row — re-reading the hypertable here would only let a channel
        // that dipped for one sample suppress a notification the operator asked for after a
        // latency they chose. `react` stands the alarm down the moment a reading clears it.
        const config = readThreshold(
          { id: alarm.triggerId, kind: THRESHOLD_TRIGGER.id, settings: alarm.triggerSettings },
          this.#logger,
        );
        if (config === null) {
          this.#park(alarm, parked);
          continue;
        }
        const firing = fireThreshold(config);
        requests.push({
          at: now,
          sensorId: alarm.sensorId,
          triggerId: alarm.triggerId,
          triggerKind: THRESHOLD_TRIGGER.id,
          templateId: firing.templateId,
          reason: firing.reason,
          state: alarm.currentState,
          message: alarm.message,
          channelKey: alarm.channelKey,
          observed: alarm.observed,
        });
        advance.push({
          id: alarm.id,
          phase: firing.phase,
          nextDueAt: firing.nextDueAt,
          repeats: alarm.repeats,
          suppressed: alarm.suppressed,
          recoveringSince: null,
          observed: alarm.observed,
        });
        continue;
      }

      const stored = readSettings(
        { id: alarm.triggerId, kind: STATE_TRIGGER.id, settings: alarm.triggerSettings },
        this.#logger,
      );
      if (stored === null) {
        this.#park(alarm, parked);
        continue;
      }
      const settings = this.#forSensor(stored, alarm.sensorType);

      // **Held: parked, not fired** (`M-22`). The reaction suspends a carried sensor's alarm under
      // a trigger that hears about its probe from the probe's own alarm; this checks rather than
      // assumes, for the reason the staleness check below gives. Parked is what suspended means.
      const carrier = holds.carrier.get(alarm.sensorId);
      if (carrier !== undefined && holds.covering.get(carrier)?.has(alarm.triggerId) === true) {
        this.#park(alarm, parked);
        continue;
      }
      const episode =
        this.#episodes !== undefined &&
        isLive({ state: alarm.currentState, cause: alarm.currentCause })
          ? this.#episodes.episodeOf(alarm.sensorId)
          : undefined;
      // **Acknowledged: parked, not fired** (`M-24`). The view reads an acknowledged Probe Health
      // as Unknown for this trigger, and the acknowledgement stops the chain all the same.
      if (acknowledgedEpisode(settings.state, alarm.currentState, episode !== undefined)) {
        this.#park(alarm, parked);
        continue;
      }
      const current = seenBy(settings.state, alarm.currentState, episode !== undefined);

      // **A held return falling due is its confirmation, not a firing** (`M-18`). Decided by
      // `reconcile`, as the reaction decides it, and ahead of the staleness check below: that
      // check reads a sensor that has left the armed state and stands the alarm down in silence,
      // and the recovery its recipients are owed would never go out.
      if (alarm.recoveringSince !== null && alarm.state !== null) {
        // An episode alarm whose episode has ended is timed as `#episodeDecision` times it.
        const ended =
          episode === undefined && alarm.currentState !== 'paused'
            ? this.#episodes?.endedEpisodeOf(alarm.sensorId)
            : undefined;
        const closed = ended !== undefined && closes(alarm, ended) ? ended : undefined;
        const decided =
          closed === undefined
            ? reconcile(
                { ...alarm, state: alarm.state },
                current,
                alarm.currentSince,
                settings,
                now,
              )
            : heldEpisodeReturn(
                { ...alarm, recoveringSince: alarm.recoveringSince },
                settings,
                now,
              );
        switch (decided.kind) {
          case 'recover':
            requests.push({
              at: now,
              sensorId: alarm.sensorId,
              triggerId: alarm.triggerId,
              triggerKind: STATE_TRIGGER.id,
              templateId: settings.recoveryTemplateId,
              reason: 'recovery',
              state: alarm.currentState,
              message:
                closed === undefined
                  ? alarm.message
                  : episodeEndedMessage(closed, probeName(names, closed.probeObjectId)),
            });
            clear.push(alarm.id);
            break;
          case 'resume':
          case 'suppress':
          case 'hold':
            // A relapse the reaction has not seen yet, or a hold that was lengthened.
            settled.push({
              id: alarm.id,
              phase: alarm.phase,
              nextDueAt:
                decided.kind === 'resume'
                  ? decided.nextDueAt
                  : decided.kind === 'hold'
                    ? recoveryConfirmAt(alarm.recoveringSince, settings)
                    : null,
              repeats: alarm.repeats,
              suppressed: decided.kind === 'suppress',
              recoveringSince: decided.kind === 'hold' ? alarm.recoveringSince : null,
            });
            break;
          case 'cancel':
          case 'retarget':
          case 'idle':
          case 'arm':
          case 'recovering':
            // Nobody was told, or the trigger now watches another state. A retarget's new chain
            // is the reaction's to arm, as the staleness check below leaves it.
            clear.push(alarm.id);
            break;
        }
        continue;
      }

      // The alarm fell due for a state the sensor is no longer in. `react` should have stood it
      // down already, and does in every path that goes through a transaction — but the sweep is
      // the last thing between a stale row and a page at 3 a.m., so it checks rather than
      // assumes. Standing it down silently is right for everything but one alarm: nothing
      // recovered that anybody was told about, or `react` would have sent the recovery.
      if (alarm.state === null || !stillStanding(alarm.state, current)) {
        // **The one: an episode alarm whose episode has ended** (`M-24`). Its recipients were
        // told the probe's sensors are held, and whatever ended the episode may not have reached
        // `react` for this sensor, so the all-clear goes out here rather than nowhere.
        const ended =
          episode === undefined && alarm.currentState !== 'paused'
            ? this.#episodes?.endedEpisodeOf(alarm.sensorId)
            : undefined;
        if (ended !== undefined && closes(alarm, ended) && alarm.phase !== 'pending') {
          requests.push({
            at: now,
            sensorId: alarm.sensorId,
            triggerId: alarm.triggerId,
            triggerKind: STATE_TRIGGER.id,
            templateId: settings.recoveryTemplateId,
            reason: 'recovery',
            state: alarm.currentState,
            message: episodeEndedMessage(ended, probeName(names, ended.probeObjectId)),
          });
        }
        clear.push(alarm.id);
        continue;
      }
      const armedState = alarm.state;

      const firing = fire({ ...alarm, state: armedState }, now, settings);
      requests.push({
        at: now,
        sensorId: alarm.sensorId,
        triggerId: alarm.triggerId,
        triggerKind: STATE_TRIGGER.id,
        templateId: firing.templateId,
        reason: firing.reason,
        // The state that armed the alarm, not the one the sensor is in now. They differ when an
        // acknowledgement landed between the due time and the sweep, and the message is about
        // the outage, not about the acknowledgement.
        state: armedState,
        // An episode alarm says which probe and how many sensors (`M-22`): the recipient's UI
        // shows Probe Health Down, not Unknown, and the sensor's own message is about the link.
        message:
          episode !== undefined && armedState === 'unknown'
            ? episodeMessage(episode, probeName(names, episode.probeObjectId))
            : alarm.message,
      });
      advance.push({
        id: alarm.id,
        phase: firing.phase,
        nextDueAt: firing.nextDueAt,
        repeats: firing.repeats,
        suppressed: alarm.suppressed,
        recoveringSince: null,
      });
    }

    const queued = await this.#alarms.queue(q, requests);
    if (queued > 0) this.#onQueued?.();
    await this.#alarms.advance(q, [...advance, ...parked, ...settled]);
    const stale = await this.#alarms.clear(q, clear);
    this.#fired += advance.length;
    this.#queued += queued;
    this.#untemplated += requests.length - queued;
    if (advance.length > 0 || stale > 0 || parked.length > 0 || settled.length > 0) {
      this.#logger.info(
        {
          fired: advance.length,
          queued,
          stale,
          ...(parked.length === 0 ? {} : { parked: parked.length }),
          ...(settled.length === 0 ? {} : { held: settled.length }),
        },
        'notification chain advanced',
      );
    }
    return { fired: advance.length, queued };
  }

  /** When the next alarm falls due, so a caller can wait rather than poll (`N-04`). */
  async nextDueAt(q: Queryable): Promise<Date | null> {
    return this.#alarms.nextDueAt(q);
  }

  /**
   * Reconciles every sensor beneath an object, which is what a trigger edit needs.
   *
   * Creating "tell me about outages" during an outage has to arm the outage in progress. The
   * chain is measured from the sensor's own `since`, so a sensor that has been Down for an hour
   * is already past a five-minute latency and notifies at the next sweep — which is right: the
   * operator asked to be told about sensors that are down, and it is.
   */
  async reconcileSubtree(
    q: Queryable,
    objectId: number,
    now: Date,
    options: ReactionOptions = {},
  ): Promise<AlarmReaction> {
    const sensors = await this.#alarms.sensorsUnder(q, objectId, this.#maxReconciled);
    if (sensors.length === this.#maxReconciled) {
      this.#logger.warn(
        { objectId, limit: this.#maxReconciled },
        'trigger reconciliation hit its bound; the rest follow at their next state change',
      );
    }
    return this.react(q, sensors, now, options);
  }

  /**
   * One (sensor, trigger) pair: decide, and collect the writes.
   *
   * The decision itself is `chain.reconcile`, which knows nothing about databases. This turns
   * its answer into rows.
   */
  #apply(
    sensor: SensorStanding,
    trigger: { id: number },
    alarm: AlarmRow | null,
    settings: StateTriggerSettings,
    now: Date,
    out: {
      arm: AlarmInsert[];
      advance: AlarmAdvance[];
      clear: number[];
      requests: RequestInsert[];
      result: AlarmReaction;
    },
    options: ReactionOptions,
    seen: Seen,
  ): void {
    const view: Alarm | null =
      alarm === null || alarm.state === null
        ? null
        : {
            state: alarm.state,
            since: alarm.since,
            phase: alarm.phase,
            nextDueAt: alarm.nextDueAt,
            repeats: alarm.repeats,
            suppressed: alarm.suppressed,
            recoveringSince: alarm.recoveringSince,
          };
    // **A row of the other kind under this trigger is cleared here** (`P-115`). `PUT /triggers/:id`
    // is whole-document and does not refuse a change of `kind`, so a standing threshold alarm can
    // find itself under a state trigger. Its `state` is null, so `view` collapses and `reconcile`
    // can only answer `idle` or `arm` — neither of which clears a row — while the trigger has
    // already been claimed out of the orphan map. The row became unreachable by every clearing
    // path: the state arm was swallowed by `ON CONFLICT`, so that pair could never notify again,
    // and the sweep re-read a `next_due_at` in the past forty times a second for ever.
    if (alarm !== null && view === null) {
      out.clear.push(alarm.id);
      out.result.cleared += 1;
    }

    // **What the latency is measured from** (`P-181`). Ordinarily it is the state's own
    // beginning, so a sensor that has been Down for an hour when a trigger is created is already
    // past its latency rather than starting a fresh five minutes — which is right for an edit,
    // where the outage was already being watched by something.
    //
    // It is wrong for a reconciliation at boot. There the sensor's `since` is as old as the
    // outage, so *every* deadline computed from it — initial, escalation, repeat — is already in
    // the past: the sweep fires all three on consecutive passes, for an outage whose recovery
    // may still be sitting in a probe's spool. That is the `P-146` storm, produced by the pass
    // written to repair a missed alarm. Armed from `now` instead, the alarm still happens — the
    // hole `P-177` closes stays closed — and it happens once, after its normal latency, by which
    // time a drain has usually said whether the outage is still real.
    //
    // **What this trigger sees, which is the sensor's state except in one place** (`M-22`). A
    // trigger on Unknown sees a probe's live Probe Health as Unknown while the probe's sensors are
    // held, and its alarm is armed from the episode's start rather than the sensor's. Nothing
    // outside this decision and the sweep's standing check ever reads it.
    const onEpisode = seen.episode !== undefined && settings.state === 'unknown';
    const current = seenBy(settings.state, sensor.state, seen.episode !== undefined);
    const since = onEpisode ? seen.episode.since : sensor.since;
    const armFrom = options.armFrom === 'now' ? now : since;
    const decision =
      this.#episodeDecision(alarm, view, sensor, settings, seen, now) ??
      reconcile(view, current, armFrom, settings, now, seen.held);

    switch (decision.kind) {
      case 'idle':
      case 'hold':
        return;

      case 'recovering':
        if (alarm === null) return;
        // The chain stops and nothing is sent. The due time is the return's confirmation, which
        // the sweep reads as such (`M-18`).
        out.advance.push({
          id: alarm.id,
          phase: alarm.phase,
          nextDueAt: decision.confirmAt,
          repeats: alarm.repeats,
          suppressed: false,
          recoveringSince: decision.since,
        });
        out.result.recovering += 1;
        return;

      case 'arm':
        out.arm.push({
          sensorId: sensor.sensorId,
          triggerId: trigger.id,
          kind: 'state',
          state: settings.state,
          channelKey: null,
          observed: null,
          since,
          nextDueAt: decision.nextDueAt,
        });
        out.result.armed += 1;
        return;

      case 'suppress':
        if (alarm === null) return;
        // The chain stops and the alarm stands, which is the pair PLAN.md's exit criterion names.
        out.advance.push({
          id: alarm.id,
          phase: alarm.phase,
          nextDueAt: null,
          repeats: alarm.repeats,
          suppressed: true,
          recoveringSince: null,
        });
        out.result.suppressed += 1;
        return;

      case 'resume':
        if (alarm === null) return;
        out.advance.push({
          id: alarm.id,
          phase: alarm.phase,
          nextDueAt: decision.nextDueAt,
          repeats: alarm.repeats,
          suppressed: false,
          recoveringSince: null,
        });
        out.result.resumed += 1;
        return;

      case 'recover':
        if (alarm === null) return;
        out.requests.push({
          at: now,
          sensorId: sensor.sensorId,
          triggerId: trigger.id,
          triggerKind: STATE_TRIGGER.id,
          templateId: settings.recoveryTemplateId,
          reason: 'recovery',
          state: sensor.state,
          message: recoveryMessage(alarm, seen) ?? sensor.message,
        });
        out.clear.push(alarm.id);
        out.result.cleared += 1;
        return;

      case 'cancel':
        if (alarm === null) return;
        out.clear.push(alarm.id);
        out.result.cleared += 1;
        return;

      case 'retarget':
        // Both writes, in one reaction: the old row goes and the new chain starts from the state
        // the sensor is already in. `clear` runs before `arm`, which is what makes that possible.
        if (alarm !== null) {
          out.clear.push(alarm.id);
          out.result.cleared += 1;
        }
        out.arm.push({
          sensorId: sensor.sensorId,
          triggerId: trigger.id,
          kind: 'state',
          state: settings.state,
          channelKey: null,
          observed: null,
          since,
          nextDueAt: decision.nextDueAt,
        });
        out.result.armed += 1;
        return;
    }
  }

  /** The settings as one sensor's alarm reads them (`M-18`): the trigger's hold, or its type's. */
  #forSensor(stored: StoredStateSettings, sensorType: string | null): StateTriggerSettings {
    return {
      ...stored,
      recoveryHoldSeconds:
        stored.recoveryHoldSeconds ??
        (sensorType === null ? 0 : (this.#recoveryHolds?.(sensorType) ?? 0)),
    };
  }

  /**
   * What an episode alarm owes that `reconcile` cannot see through the view (`M-24`), or undefined
   * to let `reconcile` decide.
   *
   * **An episode that has ended is recovered, whatever Probe Health reads.** The view is gone, so
   * `reconcile` would see Probe Health's own state, still Down when the episode ended because its
   * sensors were moved off a probe that is still lost, and suspend the alarm, and the sweep would
   * later stand it down silently. Its recipients were told the probe's sensors are held, and are
   * owed the word that they are not: a recovery in the episode-ended words, or nothing for an alarm
   * that was never sent. A pause is left to `reconcile`, which cancels, as it does any alarm.
   *
   * **An acknowledged Probe Health stops the episode alarm's chain.** The view reads it as Unknown
   * for this trigger, which would hide the acknowledgement from `reconcile`; stopping here is what
   * an acknowledgement does to any chain, and its lapse takes `reconcile`'s `resume` branch.
   *
   * **A probe that came back is a return, and held like one** (`M-18`). A probe killed and
   * restarted every few seconds ends an episode at each reconnect and opens one at each kill, and
   * without the hold a trigger on Unknown paged at every kill. Held, a loss inside the hold is a
   * new episode and the same alarm: the view reads it as Unknown and `reconcile` resumes the
   * chain. An **emptied** episode is not a return, its probe is still at fault and nothing
   * flaps, so it recovers at once, as before.
   */
  #episodeDecision(
    alarm: AlarmRow | null,
    view: Alarm | null,
    sensor: SensorStanding,
    settings: StateTriggerSettings,
    seen: Seen,
    now: Date,
  ): Reconciliation | undefined {
    if (settings.state !== 'unknown') return undefined;
    if (seen.episode === undefined) {
      const ended = seen.ended;
      if (alarm === null || ended === undefined || sensor.state === 'paused') return undefined;
      if (!closes(alarm, ended)) return undefined;
      if (alarm.recoveringSince !== null) {
        return heldEpisodeReturn(
          { ...alarm, recoveringSince: alarm.recoveringSince },
          settings,
          now,
        );
      }
      // **Standing on Probe Health's own state, it is not the episode's to close** (`M-18`). An
      // episode alarm whose episode has ended faces Probe Health Down, still at fault, or Up or
      // Warning, back, and never Unknown. An alarm that still stands is Probe Health's own, armed
      // before the episode began, which `closes` now accepts by its earlier `since`. Left to
      // `reconcile`, as the sweep leaves it, since the sweep reaches this only from its staleness
      // check. Not asked of a held return above, where Probe Health resumed and awaiting its
      // first reading would read as a relapse, and only a new episode is one.
      if (alarm.state !== null && stillStanding(alarm.state, sensor.state)) return undefined;
      if (!ended.emptied && settings.recoveryHoldSeconds > 0) {
        // No end time is kept for an episode, and this runs in the transaction that ended it.
        return { kind: 'recovering', since: now, confirmAt: recoveryConfirmAt(now, settings) };
      }
      return alarm.phase === 'pending' ? { kind: 'cancel' } : { kind: 'recover' };
    }
    if (!acknowledgedEpisode(settings.state, sensor.state, true)) return undefined;
    if (view === null) return { kind: 'idle' };
    if (view.state !== settings.state) return undefined;
    return view.suppressed ? { kind: 'hold' } : { kind: 'suppress' };
  }

  /**
   * The sensors to re-decide unheld because the probe alarm in this batch that stood for them is
   * not live (`M-24`): paused, or withheld for want of a voucher (`A-29`). Those already in the
   * batch are not repeated.
   */
  #released(sensorIds: readonly number[], standing: ReadonlyMap<number, Held>): number[] {
    const episodes = this.#episodes;
    if (episodes === undefined) return [];
    const inBatch = new Set(sensorIds);
    const released = new Set<number>();
    for (const sensorId of sensorIds) {
      const row = standing.get(sensorId);
      if (row === undefined || isLive(row)) continue;
      for (const held of episodes.heldFor(sensorId)) {
        if (!inBatch.has(held)) released.add(held);
      }
    }
    return [...released];
  }

  /**
   * Which probe holds each carried sensor, and which triggers hear about that probe from its own
   * alarm (`M-22`).
   *
   * **Free unless something is carried.** An ordinary batch reads nothing here. The probe holding
   * a sensor comes from the lost and frozen sets, and from the tree for a carried sensor they do
   * not account for, which after a core restart is all of them until the grace has run out.
   */
  async #holds(q: Queryable, sensors: Iterable<Held>): Promise<Holds> {
    const episodes = this.#episodes;
    if (episodes === undefined) return NO_HOLDS;
    const carrier = new Map<number, number>();
    const unaccounted: number[] = [];
    for (const sensor of sensors) {
      if (!isCarried(sensor)) continue;
      const probe = episodes.carrierOf(sensor.sensorId);
      if (probe === undefined) unaccounted.push(sensor.sensorId);
      else carrier.set(sensor.sensorId, probe);
    }
    for (const [sensorId, probe] of await this.#alarms.probesAbove(q, unaccounted)) {
      carrier.set(sensorId, probe);
    }
    if (carrier.size === 0) return NO_HOLDS;

    const byProbe = new Map<number, readonly number[]>();
    for (const probe of new Set(carrier.values())) byProbe.set(probe, episodes.alarmsFor(probe));
    const candidates = [...new Set([...byProbe.values()].flat())];
    const standing = await this.#alarms.standingOf(q, candidates);
    const alarms = candidates.filter((id) => {
      const row = standing.get(id);
      return row !== undefined && isLive(row);
    });
    const effective = await this.#triggers.effectiveForMany(q, alarms);
    const covering = new Map<number, ReadonlySet<number>>();
    for (const [probe, ids] of byProbe) {
      const triggers = new Set<number>();
      for (const id of ids) {
        for (const trigger of effective.get(id) ?? []) {
          if (trigger.enabled && trigger.kind === STATE_TRIGGER.id) triggers.add(trigger.id);
        }
      }
      covering.set(probe, triggers);
    }
    return { carrier, covering };
  }

  /** The names of the probes these sensors stand for, or stood for, in an episode (`M-22`). */
  async #episodeNames(q: Queryable, sensorIds: readonly number[]): Promise<Map<number, string>> {
    const episodes = this.#episodes;
    if (episodes === undefined) return new Map();
    const probes = new Set<number>();
    for (const id of sensorIds) {
      const episode = episodes.episodeOf(id) ?? episodes.endedEpisodeOf(id);
      if (episode !== undefined) probes.add(episode.probeObjectId);
    }
    return this.#alarms.namesOf(q, [...probes]);
  }

  /**
   * One (sensor, threshold trigger) pair.
   *
   * The decision is `reconcileThreshold`, which knows nothing about databases. This turns its
   * answer into rows — and the only place the two kinds diverge is what a `recover` means: a
   * state alarm's is a recovery notification, a threshold alarm's is a clear.
   */
  #applyThreshold(
    sensor: SensorStanding,
    trigger: { id: number },
    alarm: AlarmRow | null,
    settings: ThresholdTriggerSettings,
    reading: ChannelReading,
    now: Date,
    out: {
      arm: AlarmInsert[];
      advance: AlarmAdvance[];
      clear: number[];
      requests: RequestInsert[];
      result: AlarmReaction;
    },
  ): void {
    const decision = reconcileThreshold(
      alarm === null
        ? null
        : {
            channelKey: alarm.channelKey ?? '',
            since: alarm.since,
            phase: alarm.phase,
            observed: alarm.observed,
          },
      reading,
      settings,
      now,
    );

    switch (decision.kind) {
      case 'idle':
        return;

      case 'hold': {
        if (alarm === null) return;
        // **This is the only place a parked threshold alarm can be un-parked** (`P-170`).
        // `#park` nulls `next_due_at` so the sweep stops finding a row whose trigger this build
        // cannot read, and its comment says the reaction resumes it when the trigger becomes
        // readable again. That is true of a *state* alarm, which goes through `reconcile` and
        // its `resume` branch. `reconcileThreshold` has no such branch — it says so thirty lines
        // below — so a parked threshold alarm reached only `hold`, which wrote `nextDueAt` back
        // unchanged: still null, never due, never notified. The breach was silent, and so was
        // its recovery, because by then the row was cancelled and deleted.
        //
        // Reaching here at all means `readThreshold` just succeeded, so the settings are
        // readable again and the deadline can be recomputed from the alarm's own `since` —
        // exactly what it was armed with.
        const parked = alarm.suppressed && alarm.nextDueAt === null;
        // Not a no-op, unlike a state alarm's: the channel is still over its threshold and the
        // value has probably moved, and the row is where "what is this about to page somebody
        // about" is answered. A parked row is written back even when the value has not moved,
        // because the un-parking is the point.
        if (!parked && alarm.observed === reading) return;
        out.advance.push({
          id: alarm.id,
          phase: alarm.phase,
          nextDueAt: parked ? thresholdDueAt(alarm.since, settings) : alarm.nextDueAt,
          repeats: alarm.repeats,
          suppressed: parked ? false : alarm.suppressed,
          recoveringSince: null,
          observed: reading,
        });
        return;
      }

      case 'arm':
        out.arm.push({
          sensorId: sensor.sensorId,
          triggerId: trigger.id,
          kind: 'threshold',
          state: null,
          channelKey: settings.channelKey,
          observed: reading,
          since: now,
          nextDueAt: decision.nextDueAt,
        });
        out.result.armed += 1;
        return;

      case 'recover':
        if (alarm === null) return;
        out.requests.push({
          at: now,
          sensorId: sensor.sensorId,
          triggerId: trigger.id,
          triggerKind: THRESHOLD_TRIGGER.id,
          templateId: settings.clearTemplateId,
          reason: 'clear',
          state: sensor.state,
          message: sensor.message,
          channelKey: settings.channelKey,
          observed: reading,
        });
        out.clear.push(alarm.id);
        out.result.cleared += 1;
        return;

      case 'cancel':
        if (alarm === null) return;
        out.clear.push(alarm.id);
        out.result.cleared += 1;
        return;

      // A threshold trigger has no acknowledgement semantics: it is about a value, and a sensor
      // can be over its threshold while perfectly Up. `reconcileThreshold` never returns these.
      case 'suppress':
      case 'resume':
        return;
    }
  }
}

/**
 * The engine's `recoveryHolds` from a sensor catalogue (`M-18`): each type's declared hold, and
 * none for a type the catalogue does not have. One function, so `main.ts` and the scenarios that
 * stand in for it read the holds the same way.
 */
export function holdsFrom(
  catalogue: Pick<SensorCatalogue, 'has' | 'declaration'>,
): (sensorType: string) => number {
  return (type) =>
    catalogue.has(type) ? (catalogue.declaration(type).recoveryHoldSeconds ?? 0) : 0;
}

/**
 * A state trigger's settings as stored (`M-18`): the hold is the trigger's own, or null where it
 * sets none and the sensor's type decides.
 */
type StoredStateSettings = Omit<StateTriggerSettings, 'recoveryHoldSeconds'> & {
  readonly recoveryHoldSeconds: number | null;
};

/**
 * A stored trigger's settings as the chain needs them.
 *
 * Re-validated on the way out rather than trusted. The row was validated on the way in, but a
 * downgrade, a hand-edited row or a future kind change could all leave settings the current
 * build cannot read — and the honest answer to that is to skip the trigger and say so, not to
 * crash the ingestion batch it happens to be riding in.
 */
function readSettings(
  trigger: Pick<EffectiveTrigger, 'id' | 'kind' | 'settings'>,
  logger: Logger,
): StoredStateSettings | null {
  try {
    const settings = triggerKinds.validate(trigger.kind, trigger.settings);
    return {
      state: settings['state'] as StateTriggerSettings['state'],
      initialLatencySeconds: Number(settings['initialLatencySeconds'] ?? 0),
      initialTemplateId: idOrNull(settings['initialTemplateId']),
      escalationLatencySeconds: Number(settings['escalationLatencySeconds'] ?? 0),
      escalationTemplateId: idOrNull(settings['escalationTemplateId']),
      repeatMinutes: Number(settings['repeatMinutes'] ?? 0),
      recoveryTemplateId: idOrNull(settings['recoveryTemplateId']),
      recoveryHoldSeconds:
        typeof settings['recoveryHoldSeconds'] === 'number'
          ? settings['recoveryHoldSeconds']
          : null,
    };
  } catch {
    logger.warn(
      { triggerId: trigger.id, kind: trigger.kind },
      'stored trigger settings are not readable by this build; skipping it',
    );
    return null;
  }
}

/**
 * A stored threshold trigger's settings, re-validated on the way out for the same reason.
 *
 * `fire` on a state alarm reads five fields and this reads four; they are separate functions
 * rather than one generic reader because a `Record<string, unknown>` narrowed by a `kind` string
 * is a discriminated union in name only, and the field names are the whole content.
 */
function readThreshold(
  trigger: Pick<EffectiveTrigger, 'id' | 'kind' | 'settings'>,
  logger: Logger,
): ThresholdTriggerSettings | null {
  try {
    const settings = triggerKinds.validate(trigger.kind, trigger.settings);
    return {
      channelKey: typeof settings['channelKey'] === 'string' ? settings['channelKey'] : '',
      condition: settings['condition'] as ThresholdCondition,
      value: Number(settings['value'] ?? 0),
      latencySeconds: Number(settings['latencySeconds'] ?? 0),
      triggerTemplateId: idOrNull(settings['triggerTemplateId']),
      clearTemplateId: idOrNull(settings['clearTemplateId']),
    };
  } catch {
    logger.warn(
      { triggerId: trigger.id, kind: trigger.kind },
      'stored trigger settings are not readable by this build; skipping it',
    );
    return null;
  }
}

/** A probe's name as an episode's words give it. */
function probeName(names: ReadonlyMap<number, string>, probeObjectId: number): string {
  return names.get(probeObjectId) ?? `#${String(probeObjectId)}`;
}

/**
 * Whether this alarm is the one that stood for an episode that has ended (`M-22`).
 *
 * Known by its `since`: an episode alarm is armed from the episode's start, so an alarm on
 * Unknown armed at that instant is the one that stood for it. **Or earlier** (`M-18`): a loss
 * inside a held return resumes the alarm the last episode armed, and its `since` stays that
 * episode's start, which is what keeps the outage's escalation clock. The episode this alarm
 * went on to stand for began after it, and its end is the alarm's to close. The index keeps only
 * the last episode each probe-alarm sensor stood for, so an earlier one cannot match.
 */
function closes(
  alarm: { readonly state: SensorState | null; readonly since: Date },
  ended: ProbeEpisode,
): boolean {
  return alarm.state === 'unknown' && alarm.since.getTime() <= ended.since.getTime();
}

/**
 * A held return of an episode alarm whose episode has ended (`M-18`): over once it has lasted,
 * whatever Probe Health reads. Only a new episode is a relapse, and that reaches `reconcile`
 * through the view, never through here.
 */
function heldEpisodeReturn(
  alarm: { readonly phase: AlarmRow['phase']; readonly recoveringSince: Date },
  settings: StateTriggerSettings,
  now: Date,
): Reconciliation {
  if (now < recoveryConfirmAt(alarm.recoveringSince, settings)) return { kind: 'hold' };
  return alarm.phase === 'pending' ? { kind: 'cancel' } : { kind: 'recover' };
}

/** The words of a recovery that closes an episode alarm, or undefined for any other (`M-22`). */
function recoveryMessage(alarm: AlarmRow, seen: Seen): string | undefined {
  const ended = seen.ended;
  if (ended === undefined || !closes(alarm, ended)) return undefined;
  return episodeEndedMessage(ended, probeName(seen.names, ended.probeObjectId));
}

/**
 * Every channel a threshold trigger in this batch names, deduplicated.
 *
 * What bounds the value lookup to a seek. An installation with no threshold triggers produces an
 * empty list, and `currentValues` then never touches the hypertable at all.
 */
function channelKeysIn(effective: ReadonlyMap<number, readonly EffectiveTrigger[]>): string[] {
  const keys = new Set<string>();
  for (const triggers of effective.values()) {
    for (const trigger of triggers) {
      if (trigger.kind !== THRESHOLD_TRIGGER.id || !trigger.enabled) continue;
      const key = trigger.settings['channelKey'];
      if (typeof key === 'string' && key !== '') keys.add(key);
    }
  }
  return [...keys];
}

function idOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
