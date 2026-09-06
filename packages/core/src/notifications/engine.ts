import type { Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import { STATE_TRIGGER, THRESHOLD_TRIGGER, triggerKinds } from '../triggers/definition.js';
import type { EffectiveTrigger } from '../triggers/repository.js';
import { TriggerRepository } from '../triggers/repository.js';
import { fire, reconcile, stillStanding, type Alarm, type StateTriggerSettings } from './chain.js';
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
}

/** What a reaction did. Every field is a counter Core Health will want (`M-18`, `N-13`). */
export interface AlarmReaction {
  armed: number;
  cleared: number;
  suppressed: number;
  resumed: number;
  queued: number;
}

const EMPTY: AlarmReaction = { armed: 0, cleared: 0, suppressed: 0, resumed: 0, queued: 0 };

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
export class AlarmEngine {
  readonly #alarms: AlarmRepository;
  readonly #triggers: TriggerRepository;
  readonly #logger: Logger;
  readonly #maxPerSweep: number;
  readonly #maxReconciled: number;
  readonly #valueLookbackMs: number;
  readonly #onArmed: (() => void) | undefined;
  readonly #onQueued: (() => void) | undefined;
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

  async react(q: Queryable, sensorIds: readonly number[], now: Date): Promise<AlarmReaction> {
    if (sensorIds.length === 0) return { ...EMPTY };
    // The guard, first and cheapest. An installation that notifies nobody pays exactly this.
    if (!(await this.#alarms.anyWork(q))) return { ...EMPTY };

    // One at a time, deliberately. `q` is always a transaction's client here — the method
    // contract above says so — and a client is one wire: `Promise.all` bought no parallelism,
    // only pg's "already executing a query" deprecation, which `N-15`'s scenario test surfaced.
    const standing = await this.#alarms.standingOf(q, sensorIds);
    const existing = await this.#alarms.alarmsFor(q, sensorIds);
    const effective = await this.#triggers.effectiveForMany(q, sensorIds);

    // Only the channels some threshold trigger in this batch actually names, and only when
    // there is one. An installation with no threshold triggers never touches the hypertable.
    const values = await this.#alarms.currentValues(
      q,
      sensorIds,
      channelKeysIn(effective),
      now,
      this.#valueLookbackMs,
    );

    const arm: AlarmInsert[] = [];
    const advance: AlarmAdvance[] = [];
    const clear: number[] = [];
    const requests: RequestInsert[] = [];
    const result: AlarmReaction = { ...EMPTY };

    for (const sensorId of sensorIds) {
      const sensor = standing.get(sensorId);
      // No runtime row means no sensor, or one that has never been decided. Either way there is
      // nothing to reconcile against, and any alarm for it went with the object's cascade.
      if (sensor === undefined) continue;

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
          const settings = readSettings(trigger, this.#logger);
          if (settings === null) continue;
          this.#apply(sensor, trigger, alarm, settings, now, out);
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
    if (arm.length > 0 || result.resumed > 0) this.#onArmed?.();
    if (result.queued > 0) this.#onQueued?.();
    return result;
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
      observed: alarm.observed,
    });
  }

  async sweep(q: Queryable, now: Date): Promise<{ fired: number; queued: number }> {
    const due = await this.#alarms.due(q, now, this.#maxPerSweep);
    if (due.length === 0) return { fired: 0, queued: 0 };

    const advance: AlarmAdvance[] = [];
    const parked: AlarmAdvance[] = [];
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
          observed: alarm.observed,
        });
        continue;
      }

      const settings = readSettings(
        { id: alarm.triggerId, kind: STATE_TRIGGER.id, settings: alarm.triggerSettings },
        this.#logger,
      );
      if (settings === null) {
        this.#park(alarm, parked);
        continue;
      }

      // The alarm fell due for a state the sensor is no longer in. `react` should have stood it
      // down already, and does in every path that goes through a transaction — but the sweep is
      // the last thing between a stale row and a page at 3 a.m., so it checks rather than
      // assumes. Standing it down silently is right: nothing recovered that anybody was told
      // about, or `react` would have sent the recovery when it cleared it.
      if (alarm.state === null || !stillStanding(alarm.state, alarm.currentState)) {
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
        message: alarm.message,
      });
      advance.push({
        id: alarm.id,
        phase: firing.phase,
        nextDueAt: firing.nextDueAt,
        repeats: firing.repeats,
        suppressed: alarm.suppressed,
      });
    }

    const queued = await this.#alarms.queue(q, requests);
    if (queued > 0) this.#onQueued?.();
    await this.#alarms.advance(q, [...advance, ...parked]);
    const stale = await this.#alarms.clear(q, clear);
    this.#fired += advance.length;
    this.#queued += queued;
    this.#untemplated += requests.length - queued;
    if (advance.length > 0 || stale > 0 || parked.length > 0) {
      this.#logger.info(
        {
          fired: advance.length,
          queued,
          stale,
          ...(parked.length === 0 ? {} : { parked: parked.length }),
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
  async reconcileSubtree(q: Queryable, objectId: number, now: Date): Promise<AlarmReaction> {
    const sensors = await this.#alarms.sensorsUnder(q, objectId, this.#maxReconciled);
    if (sensors.length === this.#maxReconciled) {
      this.#logger.warn(
        { objectId, limit: this.#maxReconciled },
        'trigger reconciliation hit its bound; the rest follow at their next state change',
      );
    }
    return this.react(q, sensors, now);
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

    const decision = reconcile(view, sensor.state, sensor.since, settings, now);

    switch (decision.kind) {
      case 'idle':
      case 'hold':
        return;

      case 'arm':
        out.arm.push({
          sensorId: sensor.sensorId,
          triggerId: trigger.id,
          kind: 'state',
          state: settings.state,
          channelKey: null,
          observed: null,
          since: sensor.since,
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
          message: sensor.message,
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
          since: sensor.since,
          nextDueAt: decision.nextDueAt,
        });
        out.result.armed += 1;
        return;
    }
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
): StateTriggerSettings | null {
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
