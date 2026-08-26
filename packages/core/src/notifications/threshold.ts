/**
 * The threshold trigger's decisions (`N-03`).
 *
 * Pure, like `chain.ts`, and sharing its `Reconciliation` vocabulary because a threshold alarm
 * and a state alarm differ only in what arms them. What is *not* shared is the meaning: a
 * channel limit (`M-04`) decides the sensor's state, and everyone who looks at the sensor sees
 * it; a threshold trigger decides who gets told, without changing what the sensor is. "Page me
 * at 80% but do not call the disk Down until 95%" needs both, and this is the half that pages.
 */

import type { Reconciliation } from './chain.js';

export type ThresholdCondition = 'above' | 'below' | 'equal' | 'notEqual';

/** A threshold trigger's settings, after `triggerKinds.validate` has filled the defaults in. */
export interface ThresholdTriggerSettings {
  readonly channelKey: string;
  readonly condition: ThresholdCondition;
  readonly value: number;
  readonly latencySeconds: number;
  readonly triggerTemplateId: number | null;
  readonly clearTemplateId: number | null;
}

/** The threshold alarm standing for one (sensor, trigger). */
export interface ThresholdAlarm {
  readonly channelKey: string;
  /** When the breach began. Fixed for as long as it stands, so the latency means what it says. */
  readonly since: Date;
  readonly phase: 'pending' | 'notified' | 'escalated';
  readonly observed: number | null;
}

/**
 * The channel's current value, or the fact that there is not one.
 *
 * `null` is load-bearing and is not zero (`CLAUDE.md`). A failed check records no channel values
 * at all, and a sensor nobody has scanned since it was paused has none either — treating that
 * absence as a number would either clear a breach that never cleared or raise one that never
 * happened, depending on which way the condition points.
 */
export type ChannelReading = number | null;

/**
 * Whether a sensor's stored readings are its channels' *current* values.
 *
 * The question a time window cannot answer. A sensor that failed its last check still has
 * yesterday's readings in the hypertable, thirty seconds old and completely stale — "no reading
 * since" and "reported recently" look identical from the table alone, and a threshold trigger
 * that could not tell them apart would keep a breach standing across an outage and then send a
 * clear notification when the sensor came back under its threshold, describing a recovery that
 * never happened.
 *
 * `consecutiveFailures` is the exact signal: zero means the most recent result succeeded, so
 * what is in the table came from it. A Down sensor with none is Down because a *limit* was
 * breached (`M-04`), which is a successful check with a bad number in it — and its readings are
 * as current as any. Paused and Unknown are neither: nobody is scanning, so nothing in the table
 * is current whatever its timestamp says.
 */
export function readingsAreCurrent(sensor: {
  readonly state: string;
  readonly consecutiveFailures: number;
}): boolean {
  if (sensor.state === 'paused' || sensor.state === 'unknown') return false;
  return sensor.consecutiveFailures === 0;
}

const SECOND = 1_000;

/**
 * Whether a value breaches the condition.
 *
 * `equal` and `notEqual` compare exactly, which is right for the channels anybody sets them on —
 * status codes, counts, enumerated values — and treacherous for a computed float. That is the
 * operator's choice to make and not ours to round for them: a system that quietly compared
 * within an epsilon would fire on a value the operator can see is different.
 */
export function breaches(
  condition: ThresholdCondition,
  observed: number,
  threshold: number,
): boolean {
  switch (condition) {
    case 'above':
      return observed > threshold;
    case 'below':
      return observed < threshold;
    case 'equal':
      return observed === threshold;
    case 'notEqual':
      return observed !== threshold;
  }
}

/** When the trigger notification falls due, measured from the first breaching reading. */
export function thresholdDueAt(since: Date, settings: ThresholdTriggerSettings): Date {
  return new Date(since.getTime() + settings.latencySeconds * SECOND);
}

/**
 * What to do about one (sensor, threshold trigger) pair.
 *
 * The same reconciliation the state chain does, over a different input, and with two rows of the
 * table that are worth reading twice:
 *
 * - **A breach that clears before its latency notifies nobody**, exactly as a blip under a state
 *   trigger's latency does. Nothing was sent, so a clear notification would be the first anyone
 *   heard of it.
 * - **Losing the reading is not clearing the breach.** A disk that was 95% full when its sensor
 *   went Down is not a disk that emptied. The alarm is stood down — we no longer know, and the
 *   outage is what alarms — but *silently*, because "back under 80%" would be a false all-clear,
 *   and a false all-clear is worse than silence: somebody stops looking.
 */
export function reconcileThreshold(
  alarm: ThresholdAlarm | null,
  reading: ChannelReading,
  settings: ThresholdTriggerSettings,
  now: Date,
): Reconciliation {
  const breaching = reading !== null && breaches(settings.condition, reading, settings.value);

  if (alarm === null) {
    if (!breaching) return { kind: 'idle' };
    // From now, not from the sensor's state: a threshold's clock starts at the first reading
    // that breached it, which is the only moment anything here knows about.
    return { kind: 'arm', nextDueAt: thresholdDueAt(now, settings) };
  }

  // The trigger was edited to watch a different channel. The old alarm is about a value nobody
  // is watching any more; standing it down silently is right, because nothing cleared.
  if (alarm.channelKey !== settings.channelKey) return { kind: 'cancel' };

  if (breaching) return { kind: 'hold' };

  // Nothing was ever sent, so there is nothing to take back.
  if (alarm.phase === 'pending') return { kind: 'cancel' };

  // A fresh reading that does not breach is a genuine clear. No reading at all is not.
  return reading === null ? { kind: 'cancel' } : { kind: 'recover' };
}

/**
 * What a due threshold alarm owes.
 *
 * One step and no chain: `CAPABILITIES.MD §5.1` gives a threshold trigger a trigger notification
 * and a clear notification and nothing between them. Escalation and repeat belong to the state
 * trigger, where the thing being escalated is an outage; a channel that has been over its
 * threshold for an hour has said everything it has to say the first time.
 */
export function fireThreshold(settings: ThresholdTriggerSettings): {
  readonly reason: 'threshold';
  readonly templateId: number | null;
  readonly phase: 'notified';
  readonly nextDueAt: null;
} {
  return {
    reason: 'threshold',
    templateId: settings.triggerTemplateId,
    phase: 'notified',
    nextDueAt: null,
  };
}
