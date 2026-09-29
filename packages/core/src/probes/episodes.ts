import type { EndedEpisode, ProbeEpisode, ProbeEpisodes } from '../notifications/episodes.js';
import type { OfflineReason } from './reachability.js';

/** What `ProbeReachability` holds for one probe. */
export interface LostProbe {
  readonly sensorIds: readonly number[];
  readonly reason: OfflineReason;
  readonly since: Date;
}

/** What `ClockFreeze` holds for one probe. */
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
  /** `ProbeHealthService`: which Probe Health sensors report on which probe. */
  readonly alarms: () =>
    | {
        reportingOn(probeObjectId: number): readonly number[];
        reportsOn(sensorId: number): number | undefined;
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
 */
export class ProbeEpisodeIndex implements ProbeEpisodes {
  readonly #sources: EpisodeSources;
  readonly #current = new Map<number, { episode: ProbeEpisode; causes: readonly number[] }>();
  readonly #ended = new Map<number, EndedEpisode>();

  constructor(sources: EpisodeSources) {
    this.#sources = sources;
  }

  carrierOf(sensorId: number): number | undefined {
    return this.#sources.lost()?.carrierOf(sensorId) ?? this.#sources.frozen()?.carrierOf(sensorId);
  }

  alarmsFor(probeObjectId: number): readonly number[] {
    return this.#sources.alarms()?.reportingOn(probeObjectId) ?? [];
  }

  episodeOf(alarmSensorId: number): ProbeEpisode | undefined {
    const probe = this.#sources.alarms()?.reportsOn(alarmSensorId);
    return probe === undefined ? undefined : this.#episode(probe);
  }

  endedEpisodeOf(alarmSensorId: number): EndedEpisode | undefined {
    const probe = this.#sources.alarms()?.reportsOn(alarmSensorId);
    if (probe === undefined) return undefined;
    // Observed first, so an episode that ended since the last question is filed as ended.
    this.#episode(probe);
    return this.#ended.get(probe);
  }

  heldFor(alarmSensorId: number): readonly number[] {
    const probe = this.#sources.alarms()?.reportsOn(alarmSensorId);
    return probe === undefined ? [] : [...this.#held(probe).held];
  }

  /** What holds a probe's sensors, and which sensors: the lost set and the frozen set, joined. */
  #held(probeObjectId: number): {
    lost: LostProbe | undefined;
    frozen: FrozenProbe | undefined;
    held: ReadonlySet<number>;
  } {
    const lost = this.#sources.lost()?.heldBy(probeObjectId);
    const frozen = this.#sources.frozen()?.frozenBy(probeObjectId);
    const held = new Set<number>(lost?.sensorIds ?? []);
    for (const id of frozen?.sensorIds ?? []) held.add(id);
    return { lost, frozen, held };
  }

  /** The probe's episode now, and what it is remembered as. */
  #episode(probeObjectId: number): ProbeEpisode | undefined {
    const { lost, frozen, held } = this.#held(probeObjectId);

    const causes = [lost?.since, frozen?.since]
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
        emptied: held.size === 0 && causes.length > 0,
      });
      this.#current.delete(probeObjectId);
    }
    if (held.size === 0) return undefined;

    const episode: ProbeEpisode = {
      probeObjectId,
      kind: lost === undefined ? 'frozen' : lost.reason === 'silence' ? 'silent' : 'lost',
      // Still the same episode: its alarm was armed from where it began.
      since: continues ? previous.episode.since : new Date(Math.min(...causes)),
      held: held.size,
    };
    this.#current.set(probeObjectId, { episode, causes });
    return episode;
  }
}
