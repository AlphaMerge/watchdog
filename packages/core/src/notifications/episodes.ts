import type { SensorState, SensorStateCause } from '../state/tables.js';

/**
 * A lost or frozen probe, as the notification engine sees it (`M-22`).
 *
 * **One outage, one alarm.** A probe that stops answering, stops sending results or has its
 * clock step back leaves every sensor it carries Unknown with cause `probe`. The one alarm for
 * that is the probe's own: its Probe Health, which the core evaluates and which reads Down in
 * all three cases. Before this, every trigger on Unknown also queued one notification per
 * carried sensor, and every trigger on Up one more per sensor when the probe came back.
 *
 * **Held per trigger, never per sensor.** A carried sensor's alarm under a trigger is held only
 * when that trigger covers a live Probe Health reporting on the probe, so it hears about the
 * probe from there. A trigger on a group below the probe, or a probe with no live Probe Health,
 * notifies per sensor as before. Holding never takes the last route away from any trigger.
 *
 * **What the trigger on Unknown sees.** Probe Health reads Down, so a trigger on Unknown would
 * never raise the probe's alarm, and holding its carried sensors would leave it silent. While
 * the probe's sensors are held, a trigger on Unknown sees the probe's live Probe Health as
 * Unknown. It raises one alarm for the episode, on that sensor, and the alarm says which probe
 * and how many sensors. **Nothing else sees it.** The view is an input to `reconcile` and to the
 * sweep's standing check. It never reaches `sensor_state`, uptime, the API, the stream or the
 * UI, all of which go on reading Probe Health as Down.
 */

/** Why a probe's sensors are held. */
export type EpisodeKind = 'lost' | 'silent' | 'frozen';

export interface ProbeEpisode {
  readonly probeObjectId: number;
  readonly kind: EpisodeKind;
  /**
   * When the probe's sensors began to be held. The episode alarm's latency is measured from here,
   * and a recovery knows the episode it closes by it: the alarm was armed from this instant.
   */
  readonly since: Date;
  /**
   * How many sensors it holds, counted from the sets that decide which sensors are held, so the
   * number a notification states is the number held.
   */
  readonly held: number;
}

/** Where the engine learns which probe holds which sensors, and which sensors are its alarm. */
export interface ProbeEpisodes {
  /** The probe whose loss or clock holds this sensor Unknown, while one does. */
  carrierOf(sensorId: number): number | undefined;
  /** The sensors that are this probe's own alarm: its Probe Health, as its last sweep found it. */
  alarmsFor(probeObjectId: number): readonly number[];
  /** The episode this probe-alarm sensor stands for, while its probe's sensors are held. */
  episodeOf(alarmSensorId: number): ProbeEpisode | undefined;
  /** The last episode of this probe-alarm sensor's probe that has ended, for a recovery's words. */
  endedEpisodeOf(alarmSensorId: number): ProbeEpisode | undefined;
}

interface Standing {
  readonly state: SensorState;
  readonly cause: SensorStateCause | null;
}

/** Whether this sensor reads Unknown because of its probe, and so could be held. */
export function isCarried(standing: Standing): boolean {
  return standing.state === 'unknown' && standing.cause === 'probe';
}

/**
 * Whether a probe-alarm sensor is live, so it can raise the probe's alarm.
 *
 * A paused Probe Health raises nothing, and neither does one whose voucher can no longer read
 * the probe (`A-29`). Holding a carried sensor behind either would be silence.
 */
export function isLive(standing: Standing): boolean {
  if (standing.state === 'paused') return false;
  return !(standing.state === 'unknown' && standing.cause === 'access');
}

/**
 * The state a trigger watching `watched` sees on a sensor that reads `actual`.
 *
 * `episode` is true only for a live probe-alarm sensor whose probe's sensors are held. It is the
 * one place a trigger's view differs from the sensor's state.
 */
export function seenBy(watched: SensorState, actual: SensorState, episode: boolean): SensorState {
  return episode && watched === 'unknown' ? 'unknown' : actual;
}

function sensors(count: number): string {
  return count === 1 ? '1 sensor' : `${String(count)} sensors`;
}

function are(count: number): string {
  return count === 1 ? 'is' : 'are';
}

/** What an episode alarm says. The recipient's UI shows Probe Health Down, so it has to explain. */
export function episodeMessage(episode: ProbeEpisode, probeName: string): string {
  const count = episode.held;
  const carried = `the ${sensors(count)} it carries ${are(count)} Unknown, held as this one alarm`;
  switch (episode.kind) {
    case 'lost':
      return `probe ${probeName} is lost: ${carried}`;
    case 'silent':
      return `probe ${probeName} is connected but sending no results: ${carried}`;
    case 'frozen':
      return (
        `probe ${probeName}'s clock reads earlier than results it already sent: ` +
        `${sensors(count)} ${are(count)} Unknown until it catches up, held as this one alarm`
      );
  }
}

/** What the recovery of an episode alarm says. */
export function episodeEndedMessage(episode: ProbeEpisode, probeName: string): string {
  return episode.kind === 'frozen'
    ? `probe ${probeName}'s clock has caught up: its sensors are no longer held`
    : `probe ${probeName} is answering again: its sensors are no longer held`;
}
