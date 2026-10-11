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

/** Why a probe's sensors are held. `unstarted` is a probe that could not start their checks. */
export type EpisodeKind = 'lost' | 'silent' | 'frozen' | 'unstarted';

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

/**
 * How an episode ended, for the alarm that asks (`M-24`, `M-29`).
 *
 * - `resolved`: the probe is answering again, or its clock has caught up.
 * - `emptied`: its cause went on, and the probe is still lost, silent or behind, but every sensor
 *   it held was moved off it or deleted.
 * - `retargeted`: it goes on, but not for this alarm. The Probe Health asking reports on another
 *   probe now, and holds none of its sensors.
 *
 * Only `resolved` is a return. The other two leave the probe at fault, and their recovery must
 * not say it is answering again.
 */
export type EpisodeEnding = 'resolved' | 'emptied' | 'retargeted';

/** An episode that has ended, and how (`M-24`). */
export interface EndedEpisode extends ProbeEpisode {
  readonly ending: EpisodeEnding;
}

/** Where the engine learns which probe holds which sensors, and which sensors are its alarm. */
export interface ProbeEpisodes {
  /**
   * The probe whose loss or clock holds this sensor Unknown, while one does. For a Sensor Factory
   * held for its inputs' probe, the probe holding the first of those inputs (`M-26`).
   */
  carrierOf(sensorId: number): number | undefined;
  /**
   * The sensors a Sensor Factory held for its inputs' probe lacks, and nothing for any other
   * sensor (`M-26`). Where the lost and frozen sets no longer account for them, which is the
   * boot grace and a probe's return, the factory is carried by the probe they sit under in the
   * tree, and never by the one it sits under itself.
   */
  inputsOf(sensorId: number): readonly number[];
  /** The sensors that are this probe's own alarm: its Probe Health, as its last sweep found it. */
  alarmsFor(probeObjectId: number): readonly number[];
  /** The episode this probe-alarm sensor stands for, while its probe's sensors are held. */
  episodeOf(alarmSensorId: number): ProbeEpisode | undefined;
  /**
   * The last episode of this probe-alarm sensor's probe that has ended, for a recovery's words.
   * For one moved to another probe since it last stood for an episode, that episode, which it
   * stands for no longer: `retargeted` while it goes on (`M-29`).
   */
  endedEpisodeOf(alarmSensorId: number): EndedEpisode | undefined;
  /**
   * The sensors this probe-alarm sensor's probe holds now, so that when the alarm stops being
   * live they can be re-decided unheld (`M-24`). Factories carried by it included (`M-26`).
   */
  heldFor(alarmSensorId: number): readonly number[];
  /**
   * The sensors this probe holds now, factories carried by it included (`M-27`): what to re-decide
   * when a Probe Health stops reporting on it and the question can no longer go through that
   * sensor, whose target has already moved.
   */
  heldBy(probeObjectId: number): readonly number[];
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

/**
 * Whether a trigger watching `watched` sees an episode on a Probe Health that has been
 * acknowledged (`M-24`).
 *
 * The view turns the sensor's `down_acknowledged` into Unknown for the trigger on Unknown, and an
 * acknowledgement has to survive that: it stops the episode alarm's chain as it stops any other
 * (`WORKFLOW.MD` §6), and its lapse resumes it where it stopped.
 */
export function acknowledgedEpisode(
  watched: SensorState,
  actual: SensorState,
  episode: boolean,
): boolean {
  return episode && watched === 'unknown' && actual === 'down_acknowledged';
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
    case 'unstarted':
      return (
        `probe ${probeName} could not start the checks of ${sensors(count)}: ` +
        `${count === 1 ? 'it reads' : 'they read'} Unknown until it runs them, held as this one ` +
        'alarm'
      );
  }
}

/**
 * What the recovery of an episode alarm says. An episode that was emptied rather than resolved
 * says so, because its probe is still at fault (`M-24`), and so does one whose Probe Health was
 * moved to another probe (`M-29`).
 */
export function episodeEndedMessage(episode: EndedEpisode, probeName: string): string {
  if (episode.ending === 'resolved') {
    switch (episode.kind) {
      case 'frozen':
        return `probe ${probeName}'s clock has caught up: its sensors are no longer held`;
      case 'unstarted':
        return `probe ${probeName} is running its checks again: its sensors are no longer held`;
      case 'lost':
      case 'silent':
        return `probe ${probeName} is answering again: its sensors are no longer held`;
    }
  }
  const why =
    episode.ending === 'emptied'
      ? 'but none of its sensors are held now: they were moved off it or deleted'
      : 'but this Probe Health reports on another probe now, and holds none of its sensors';
  switch (episode.kind) {
    case 'lost':
      return `probe ${probeName} is still lost, ${why}`;
    case 'silent':
      return `probe ${probeName} is still sending no results, ${why}`;
    case 'frozen':
      return `probe ${probeName}'s clock is still behind, ${why}`;
    case 'unstarted':
      return `probe ${probeName} still cannot start checks, ${why}`;
  }
}
