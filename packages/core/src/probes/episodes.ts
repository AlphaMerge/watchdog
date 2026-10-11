import type { EndedEpisode, ProbeEpisode, ProbeEpisodes } from '../notifications/episodes.js';
import type { OfflineReason } from './reachability.js';

/** What `ProbeReachability` holds for one probe. */
export interface LostProbe {
  readonly sensorIds: readonly number[];
  readonly reason: OfflineReason;
  readonly since: Date;
}

/** What `ClockFreeze` holds for one probe, and `NotStarted` (`P-265`). */
export interface FrozenProbe {
  readonly sensorIds: ReadonlySet<number>;
  readonly since: Date;
}

export interface EpisodeSources {
  /** `ProbeReachability`. Getters, because the index is built before the sources are. */
  readonly lost: () =>
    | {
        heldBy(probeObjectId: number): LostProbe | undefined;
        carrierOf(sensorId: number): number | undefined;
      }
    | undefined;
  /** `ClockFreeze`. */
  readonly frozen: () =>
    | {
        frozenBy(probeObjectId: number): FrozenProbe | undefined;
        carrierOf(sensorId: number): number | undefined;
      }
    | undefined;
  /**
   * `NotStarted`: the sensors whose checks the probe could not start (`P-265`). Absent where no
   * sensor is ever held for it.
   */
  readonly unstarted?: () =>
    | {
        heldBy(probeObjectId: number): FrozenProbe | undefined;
        carrierOf(sensorId: number): number | undefined;
      }
    | undefined;
  /** `ProbeHealthService`: which Probe Health sensors report on which probe. */
  readonly alarms: () =>
    | {
        reportingOn(probeObjectId: number): readonly number[];
        reportsOn(sensorId: number): number | undefined;
      }
    | undefined;
  /**
   * `FactoryReach`: the Sensor Factories held Unknown for their inputs' probe, and the sensors
   * each lacks (`M-26`). Absent where no factory is ever held.
   */
  readonly factories?: () =>
    | {
        unreached(): ReadonlySet<number>;
        inputsOf(factoryId: number): readonly number[] | undefined;
      }
    | undefined;
}

/**
 * The lost and frozen sets and Probe Health's targets, as the notification engine reads them
 * (`M-22`).
 *
 * Nothing here is persisted, for the reason `ProbeReachability` gives: these are live facts about
 * connections and clocks. What it remembers is each probe's episode as it last saw it, so that an
 * episode that goes on while its cause changes (lost, then frozen as well, then only frozen)
 * keeps the start its alarm was armed from. It is the same episode when a cause it last saw is
 * still there, by the start that cause carries, and a new one when none is. It also remembers
 * the last one that ended, so the recovery can say which episode it closes. One entry of each per
 * probe, at most.
 *
 * **And the probe each probe-alarm sensor last stood for in an episode** (`M-29`), one entry per
 * Probe Health, at most. A Probe Health moved to another probe during an episode asks about the
 * new one from the next health sweep, which has no episode to end, so its episode alarm would
 * recover as any sensor does, in the new probe's words. Asked through the probe it stood for, it
 * closes that episode, which it no longer stands for, in words that say the probe is still at
 * fault. Remembered only from a question asked since this core started.
 */
export class ProbeEpisodeIndex implements ProbeEpisodes {
  readonly #sources: EpisodeSources;
  readonly #current = new Map<number, { episode: ProbeEpisode; causes: readonly number[] }>();
  readonly #ended = new Map<number, EndedEpisode>();
  readonly #stoodFor = new Map<number, number>();

  constructor(sources: EpisodeSources) {
    this.#sources = sources;
  }

  carrierOf(sensorId: number): number | undefined {
    const carrier = this.#carrierOfScanned(sensorId);
    if (carrier !== undefined) return carrier;
    // A factory held for its inputs' probe is carried where they are (`M-26`), never where it
    // sits in the tree: the first of them that a lost or frozen probe holds.
    for (const input of this.inputsOf(sensorId)) {
      const probe = this.#carrierOfScanned(input);
      if (probe !== undefined) return probe;
    }
    return undefined;
  }

  inputsOf(sensorId: number): readonly number[] {
    return this.#sources.factories?.()?.inputsOf(sensorId) ?? [];
  }

  alarmsFor(probeObjectId: number): readonly number[] {
    return this.#sources.alarms()?.reportingOn(probeObjectId) ?? [];
  }

  episodeOf(alarmSensorId: number): ProbeEpisode | undefined {
    const probe = this.#sources.alarms()?.reportsOn(alarmSensorId);
    if (probe === undefined) return undefined;
    const episode = this.#episode(probe);
    if (episode !== undefined) this.#stoodFor.set(alarmSensorId, probe);
    return episode;
  }

  endedEpisodeOf(alarmSensorId: number): EndedEpisode | undefined {
    const probe = this.#sources.alarms()?.reportsOn(alarmSensorId);
    // Reporting on nothing, withheld or deleted, it is not retargeted: a pause's reaction and a
    // delete's decide its alarm (`M-24`, `M-25`).
    if (probe === undefined) return undefined;
    const stood = this.#stoodFor.get(alarmSensorId);
    if (stood !== undefined && stood !== probe) {
      // Moved since it stood for an episode (`M-29`): that one ends for it, however it goes on.
      const going = this.#episode(stood);
      return going === undefined ? this.#ended.get(stood) : { ...going, ending: 'retargeted' };
    }
    // Observed first, so an episode that ended since the last question is filed as ended.
    this.#episode(probe);
    return this.#ended.get(probe);
  }

  heldFor(alarmSensorId: number): readonly number[] {
    const probe = this.#sources.alarms()?.reportsOn(alarmSensorId);
    return probe === undefined ? [] : this.heldBy(probe);
  }

  heldBy(probeObjectId: number): readonly number[] {
    const held = [...this.#held(probeObjectId).held];
    // And the factories carried by it (`M-26`), which its sets do not name: they are held behind
    // the same alarm, and have to be let go with the sensors when it stops being live.
    for (const factory of this.#sources.factories?.()?.unreached() ?? []) {
      if (this.carrierOf(factory) === probeObjectId) held.push(factory);
    }
    return held;
  }

  /** The probe whose loss or clock holds a probe-scanned sensor, while one does. */
  #carrierOfScanned(sensorId: number): number | undefined {
    return (
      this.#sources.lost()?.carrierOf(sensorId) ??
      this.#sources.frozen()?.carrierOf(sensorId) ??
      this.#sources.unstarted?.()?.carrierOf(sensorId)
    );
  }

  /**
   * What holds a probe's sensors, and which sensors: the lost set, the frozen set and the set it
   * could not start (`P-265`), joined.
   */
  #held(probeObjectId: number): {
    lost: LostProbe | undefined;
    frozen: FrozenProbe | undefined;
    unstarted: FrozenProbe | undefined;
    held: ReadonlySet<number>;
  } {
    const lost = this.#sources.lost()?.heldBy(probeObjectId);
    const frozen = this.#sources.frozen()?.frozenBy(probeObjectId);
    const unstarted = this.#sources.unstarted?.()?.heldBy(probeObjectId);
    const held = new Set<number>(lost?.sensorIds ?? []);
    for (const id of frozen?.sensorIds ?? []) held.add(id);
    for (const id of unstarted?.sensorIds ?? []) held.add(id);
    return { lost, frozen, unstarted, held };
  }

  /** The probe's episode now, and what it is remembered as. */
  #episode(probeObjectId: number): ProbeEpisode | undefined {
    const { lost, frozen, unstarted, held } = this.#held(probeObjectId);

    const causes = [lost?.since, frozen?.since, unstarted?.since]
      .filter((at): at is Date => at !== undefined)
      .map((at) => at.getTime());
    const previous = this.#current.get(probeObjectId);
    const continues =
      previous !== undefined && held.size > 0 && causes.some((at) => previous.causes.includes(at));
    if (previous !== undefined && !continues) {
      // Emptied, when a cause is still there and nothing is held: the probe is as lost, silent
      // or behind as it was, and its sensors were moved off it or deleted (`M-24`).
      this.#ended.set(probeObjectId, {
        ...previous.episode,
        ending: held.size === 0 && causes.length > 0 ? 'emptied' : 'resolved',
      });
      this.#current.delete(probeObjectId);
    }
    if (held.size === 0) return undefined;

    const episode: ProbeEpisode = {
      probeObjectId,
      // The cause that says most: a lost probe starts nothing, and a clock behind is the fix
      // whatever else is wrong.
      kind:
        lost !== undefined
          ? lost.reason === 'silence'
            ? 'silent'
            : 'lost'
          : frozen !== undefined
            ? 'frozen'
            : 'unstarted',
      // Still the same episode: its alarm was armed from where it began.
      since: continues ? previous.episode.since : new Date(Math.min(...causes)),
      held: held.size,
    };
    this.#current.set(probeObjectId, { episode, causes });
    return episode;
  }
}
