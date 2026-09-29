import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AlarmEngine } from '../src/notifications/engine.js';
import {
  acknowledgedEpisode,
  episodeEndedMessage,
  episodeMessage,
  isCarried,
  isLive,
  seenBy,
} from '../src/notifications/episodes.js';
import { ProbeEpisodeIndex, type FrozenProbe, type LostProbe } from '../src/probes/episodes.js';
import type {
  AlarmAdvance,
  AlarmInsert,
  AlarmRepository,
  AlarmRow,
  RequestInsert,
} from '../src/notifications/repository.js';
import { V1_STATES, type SensorState, type SensorStateCause } from '../src/state/tables.js';
import type { TriggerRepository } from '../src/triggers/repository.js';
import { silent } from './support/tree.js';

/**
 * The episode index (`M-22`): which probe holds which sensors, which sensor is its alarm, and
 * what one episode is. Pure: its three sources are maps here.
 */

const PROBE = 7;
const OTHER = 8;
const HEALTH = 70;
const T1 = new Date('2026-09-29T10:00:00.000Z');
const T2 = new Date('2026-09-29T10:05:00.000Z');
const T3 = new Date('2026-09-29T11:00:00.000Z');

function world(): {
  lost: Map<number, LostProbe>;
  frozen: Map<number, FrozenProbe>;
  /** The factories held for their inputs' probe, each with the sensors it lacks (`M-26`). */
  factories: Map<number, readonly number[]>;
  index: ProbeEpisodeIndex;
} {
  const lost = new Map<number, LostProbe>();
  const frozen = new Map<number, FrozenProbe>();
  const factories = new Map<number, readonly number[]>();
  const carrier = (probes: ReadonlyMap<number, { sensorIds: Iterable<number> }>, id: number) => {
    for (const [probe, held] of probes) if ([...held.sensorIds].includes(id)) return probe;
    return undefined;
  };
  const index = new ProbeEpisodeIndex({
    lost: () => ({
      heldBy: (probe) => lost.get(probe),
      carrierOf: (id) => carrier(lost, id),
    }),
    frozen: () => ({
      frozenBy: (probe) => frozen.get(probe),
      carrierOf: (id) => carrier(frozen, id),
    }),
    alarms: () => ({
      reportingOn: (probe) => (probe === PROBE ? [HEALTH] : []),
      reportsOn: (id) => (id === HEALTH ? PROBE : undefined),
    }),
    factories: () => ({
      unreached: () => new Set(factories.keys()),
      inputsOf: (id) => factories.get(id),
    }),
  });
  return { lost, frozen, factories, index };
}

describe('the episode index (`M-22`)', () => {
  it('says which probe holds a sensor, from either set', () => {
    const { lost, frozen, index } = world();
    lost.set(PROBE, { sensorIds: [1, 2], reason: 'link', since: T1 });
    frozen.set(OTHER, { sensorIds: new Set([3]), since: T1 });
    assert.equal(index.carrierOf(1), PROBE);
    assert.equal(index.carrierOf(3), OTHER);
    assert.equal(index.carrierOf(4), undefined);
    assert.deepEqual(index.alarmsFor(PROBE), [HEALTH]);
    assert.deepEqual(index.alarmsFor(OTHER), []);
  });

  it('names the episode by its cause, counts what it holds and starts at the earliest', () => {
    const { lost, frozen, index } = world();
    assert.equal(index.episodeOf(HEALTH), undefined, 'nothing held, no episode');

    lost.set(PROBE, { sensorIds: [1, 2, 3], reason: 'link', since: T2 });
    assert.deepEqual(index.episodeOf(HEALTH), {
      probeObjectId: PROBE,
      kind: 'lost',
      since: T2,
      held: 3,
    });
    assert.equal(index.episodeOf(99), undefined, 'a sensor that is no probe’s alarm');

    const silent = world();
    silent.lost.set(PROBE, { sensorIds: [1], reason: 'silence', since: T1 });
    assert.equal(silent.index.episodeOf(HEALTH)?.kind, 'silent');

    const cold = world();
    cold.frozen.set(PROBE, { sensorIds: new Set([1, 2]), since: T1 });
    assert.equal(cold.index.episodeOf(HEALTH)?.kind, 'frozen');

    // Lost and frozen at once: the sensors counted once, from the earlier start.
    const both = world();
    both.lost.set(PROBE, { sensorIds: [1, 2, 3], reason: 'link', since: T2 });
    both.frozen.set(PROBE, { sensorIds: new Set([3, 4]), since: T1 });
    assert.deepEqual(both.index.episodeOf(HEALTH), {
      probeObjectId: PROBE,
      kind: 'lost',
      since: T1,
      held: 4,
    });
    assert.equal(frozen.size, 0);
  });

  it('holds no episode for a probe that went away carrying nothing', () => {
    const { lost, index } = world();
    lost.set(PROBE, { sensorIds: [], reason: 'link', since: T1 });
    assert.equal(index.episodeOf(HEALTH), undefined);
  });

  it('keeps one start while the cause changes, and files it as ended once none is left', () => {
    // A probe whose clock froze its sensors and which then lost its link, came back, and was
    // still frozen: one episode throughout, so its one alarm is armed from one start.
    const { lost, frozen, index } = world();
    frozen.set(PROBE, { sensorIds: new Set([1, 2]), since: T1 });
    assert.equal(index.episodeOf(HEALTH)?.since.getTime(), T1.getTime());

    lost.set(PROBE, { sensorIds: [1, 2, 3], reason: 'link', since: T2 });
    assert.equal(index.episodeOf(HEALTH)?.kind, 'lost');

    frozen.delete(PROBE);
    const going = index.episodeOf(HEALTH);
    assert.equal(going?.since.getTime(), T1.getTime(), 'the frozen start, kept');
    assert.equal(going.held, 3);
    assert.equal(index.endedEpisodeOf(HEALTH), undefined, 'nothing has ended yet');

    lost.delete(PROBE);
    assert.equal(index.episodeOf(HEALTH), undefined);
    assert.equal(index.endedEpisodeOf(HEALTH)?.since.getTime(), T1.getTime());
  });

  it('opens a new episode when none of the causes it last saw is left', () => {
    // An end nobody asked about, then a new loss: the new episode starts afresh rather than
    // inheriting a start from an hour ago, which would page past its latency at once.
    const { lost, index } = world();
    lost.set(PROBE, { sensorIds: [1], reason: 'link', since: T1 });
    assert.equal(index.episodeOf(HEALTH)?.since.getTime(), T1.getTime());
    lost.set(PROBE, { sensorIds: [1], reason: 'link', since: T3 });
    assert.equal(index.episodeOf(HEALTH)?.since.getTime(), T3.getTime());
    assert.equal(index.endedEpisodeOf(HEALTH)?.since.getTime(), T1.getTime());
  });

  it('files an episode whose sensors all left, while its probe is still lost, as emptied (`M-24`)', () => {
    const { lost, index } = world();
    lost.set(PROBE, { sensorIds: [1, 2], reason: 'link', since: T1 });
    assert.deepEqual(index.heldFor(HEALTH), [1, 2]);
    index.episodeOf(HEALTH);
    lost.set(PROBE, { sensorIds: [], reason: 'link', since: T1 });
    assert.equal(index.episodeOf(HEALTH), undefined);
    assert.equal(index.endedEpisodeOf(HEALTH)?.emptied, true);
    assert.deepEqual(index.heldFor(HEALTH), []);

    // And one that ended because the probe came back is not.
    lost.set(PROBE, { sensorIds: [3], reason: 'link', since: T2 });
    index.episodeOf(HEALTH);
    lost.delete(PROBE);
    assert.equal(index.endedEpisodeOf(HEALTH)?.emptied, false);
  });

  it('files an end it is first told of through the ended question', () => {
    const { lost, index } = world();
    lost.set(PROBE, { sensorIds: [1], reason: 'link', since: T1 });
    index.episodeOf(HEALTH);
    lost.delete(PROBE);
    assert.equal(index.endedEpisodeOf(HEALTH)?.kind, 'lost');
  });

  it('carries a factory held for its inputs’ probe by that probe, and lets it go with them (`M-26`)', () => {
    const { lost, frozen, factories, index } = world();
    lost.set(PROBE, { sensorIds: [1, 2], reason: 'link', since: T1 });
    frozen.set(OTHER, { sensorIds: new Set([3]), since: T1 });
    factories.set(50, [2]);
    factories.set(51, [4, 3]);
    factories.set(52, [5]);
    assert.equal(index.carrierOf(50), PROBE);
    assert.equal(index.carrierOf(51), OTHER, 'the first input a probe holds');
    assert.equal(index.carrierOf(52), undefined, 'none of its inputs is held any more');
    assert.deepEqual(index.inputsOf(51), [4, 3]);
    assert.deepEqual(index.inputsOf(1), [], 'a sensor a probe scans lacks nothing');
    assert.deepEqual(index.heldFor(HEALTH), [1, 2, 50]);
    assert.equal(index.episodeOf(HEALTH)?.held, 2, 'the episode counts what the probe carries');
  });

  it('answers nothing before its sources exist', () => {
    const index = new ProbeEpisodeIndex({
      lost: () => undefined,
      frozen: () => undefined,
      alarms: () => undefined,
    });
    assert.equal(index.carrierOf(1), undefined);
    assert.deepEqual(index.inputsOf(1), []);
    assert.deepEqual(index.alarmsFor(PROBE), []);
    assert.equal(index.episodeOf(HEALTH), undefined);
    assert.equal(index.endedEpisodeOf(HEALTH), undefined);
    assert.deepEqual(index.heldFor(HEALTH), []);
  });
});

describe('what a trigger sees, and what can stand in for a probe (`M-22`)', () => {
  it('shows Unknown to a trigger on Unknown during an episode, and the sensor’s own state to everything else', () => {
    for (const watched of V1_STATES) {
      for (const actual of V1_STATES) {
        assert.equal(seenBy(watched, actual, false), actual, `${watched}/${actual}, no episode`);
        assert.equal(
          seenBy(watched, actual, true),
          watched === 'unknown' ? 'unknown' : actual,
          `${watched}/${actual}, in an episode`,
        );
      }
    }
  });

  it('sees an acknowledgement through the view only on the trigger the view is for (`M-24`)', () => {
    for (const watched of V1_STATES) {
      for (const actual of V1_STATES) {
        assert.equal(
          acknowledgedEpisode(watched, actual, true),
          watched === 'unknown' && actual === 'down_acknowledged',
          `${watched}/${actual}`,
        );
        assert.equal(acknowledgedEpisode(watched, actual, false), false);
      }
    }
  });

  it('holds only what its probe made Unknown', () => {
    assert.equal(isCarried({ state: 'unknown', cause: 'probe' }), true);
    assert.equal(isCarried({ state: 'unknown', cause: 'scan' }), false);
    assert.equal(isCarried({ state: 'unknown', cause: 'access' }), false);
    assert.equal(isCarried({ state: 'down', cause: 'probe' }), false);
  });

  it('never stands a paused or withheld Probe Health in for its probe', () => {
    assert.equal(isLive({ state: 'down', cause: 'lookup' }), true);
    assert.equal(isLive({ state: 'up', cause: 'scan' }), true);
    assert.equal(isLive({ state: 'unknown', cause: 'scan' }), true);
    assert.equal(isLive({ state: 'paused', cause: 'user' }), false);
    assert.equal(isLive({ state: 'unknown', cause: 'access' }), false);
  });

  it('says which probe, why, and how many, and what ended', () => {
    const lost = { probeObjectId: PROBE, kind: 'lost', since: T1, held: 312 } as const;
    assert.equal(
      episodeMessage(lost, 'Site A'),
      'probe Site A is lost: the 312 sensors it carries are Unknown, held as this one alarm',
    );
    assert.equal(
      episodeMessage({ ...lost, kind: 'silent', held: 1 }, 'Site A'),
      'probe Site A is connected but sending no results: the 1 sensor it carries is Unknown, ' +
        'held as this one alarm',
    );
    assert.match(
      episodeMessage({ ...lost, kind: 'frozen' }, 'Site A'),
      /clock reads earlier .*312 sensors are Unknown until it catches up/u,
    );
    const ended = { ...lost, emptied: false };
    assert.equal(
      episodeEndedMessage(ended, 'Site A'),
      'probe Site A is answering again: its sensors are no longer held',
    );
    assert.match(episodeEndedMessage({ ...ended, kind: 'frozen' }, 'Site A'), /caught up/u);
    // Emptied: the probe is as much at fault as it was, and the words must not say otherwise.
    const emptied = { ...lost, emptied: true };
    assert.equal(
      episodeEndedMessage(emptied, 'Site A'),
      'probe Site A is still lost, but none of its sensors are held now: they were moved off it ' +
        'or deleted',
    );
    assert.match(
      episodeEndedMessage({ ...emptied, kind: 'silent' }, 'Site A'),
      /still sending no/u,
    );
    assert.match(episodeEndedMessage({ ...emptied, kind: 'frozen' }, 'Site A'), /still behind/u);
  });
});

/**
 * What the engine does with an episode alarm where the view cannot decide for it (`M-24`): an
 * episode that ended while its probe stayed at fault, and an acknowledged Probe Health. The
 * repository and the triggers are maps holding one alarm under one trigger on Unknown.
 */
describe('an episode alarm the view cannot decide (`M-24`)', () => {
  const SETTINGS = {
    state: 'unknown',
    initialLatencySeconds: 0,
    initialTemplateId: 11,
    recoveryTemplateId: 12,
    repeatMinutes: 30,
  };
  const EMPTIED =
    'probe Site A is still lost, but none of its sensors are held now: they were moved off it ' +
    'or deleted';

  interface Fixture {
    /** Probe Health's state. */
    readonly state: SensorState;
    /** The alarm's phase, or null for no alarm. */
    readonly phase: AlarmRow['phase'] | null;
    readonly suppressed?: boolean;
    /** The episode ended while its probe stayed lost: its sensors were moved off it. */
    readonly emptied: boolean;
    /** When the alarm was armed, the episode's start unless said. */
    readonly since?: Date;
    /** Why Probe Health reads its state, `lookup` unless said (paused: none). */
    readonly cause?: SensorStateCause | null;
  }

  function over(fixture: Fixture): {
    engine: AlarmEngine;
    requests: RequestInsert[];
    cleared: number[];
    advanced: AlarmAdvance[];
    armed: AlarmInsert[];
  } {
    const { lost, index } = world();
    lost.set(PROBE, { sensorIds: [1, 2], reason: 'link', since: T1 });
    index.episodeOf(HEALTH);
    // Emptied by a tree change whose re-evaluation of Probe Health never landed.
    if (fixture.emptied) lost.set(PROBE, { sensorIds: [], reason: 'link', since: T1 });
    const cause = fixture.cause ?? (fixture.state === 'paused' ? null : 'lookup');
    const suppressed = fixture.suppressed ?? false;
    const row: AlarmRow | null =
      fixture.phase === null
        ? null
        : {
            id: 900,
            sensorId: HEALTH,
            triggerId: 5,
            kind: 'state',
            state: 'unknown',
            channelKey: null,
            observed: null,
            since: fixture.since ?? T1,
            phase: fixture.phase,
            nextDueAt: suppressed ? null : T3,
            repeats: 0,
            suppressed,
            recoveringSince: null,
          };
    const requests: RequestInsert[] = [];
    const cleared: number[] = [];
    const advanced: AlarmAdvance[] = [];
    const armed: AlarmInsert[] = [];
    const alarms = {
      anyWork: () => Promise.resolve(true),
      standingOf: (_q: unknown, ids: readonly number[]) =>
        Promise.resolve(
          new Map(
            ids
              .filter((id) => id === HEALTH)
              .map((id) => [
                id,
                {
                  sensorId: id,
                  state: fixture.state,
                  cause,
                  since: T1,
                  message: 'no heartbeat',
                  consecutiveFailures: 1,
                },
              ]),
          ),
        ),
      alarmsFor: () => Promise.resolve(new Map(row === null ? [] : [[HEALTH, [row]]])),
      currentValues: () => Promise.resolve(new Map()),
      due: () =>
        Promise.resolve(
          row === null
            ? []
            : [
                {
                  ...row,
                  triggerSettings: SETTINGS,
                  currentState: fixture.state,
                  currentCause: cause,
                  message: 'no heartbeat',
                },
              ],
        ),
      probesAbove: () => Promise.resolve(new Map()),
      namesOf: () => Promise.resolve(new Map([[PROBE, 'Site A']])),
      queue: (_q: unknown, queued: readonly RequestInsert[]) => {
        requests.push(...queued);
        return Promise.resolve(queued.length);
      },
      advance: (_q: unknown, rows: readonly AlarmAdvance[]) => {
        advanced.push(...rows);
        return Promise.resolve();
      },
      clear: (_q: unknown, ids: readonly number[]) => {
        cleared.push(...ids);
        return Promise.resolve(ids.length);
      },
      arm: (_q: unknown, rows: readonly AlarmInsert[]) => {
        armed.push(...rows);
        return Promise.resolve(rows.length);
      },
    } as unknown as AlarmRepository;
    const trigger = {
      id: 5,
      objectId: 1,
      kind: 'state',
      settings: SETTINGS,
      enabled: true,
      createdAt: T1,
      updatedAt: T1,
      inherited: true,
      depth: 3,
      definedOn: { objectId: 1, name: 'Root' },
    };
    const triggers = {
      effectiveForMany: (_q: unknown, ids: readonly number[]) =>
        Promise.resolve(new Map(ids.map((id) => [id, [trigger]]))),
    } as unknown as TriggerRepository;
    return {
      engine: new AlarmEngine({ logger: silent, alarms, triggers, episodes: index }),
      requests,
      cleared,
      advanced,
      armed,
    };
  }

  const react = (engine: AlarmEngine): Promise<unknown> =>
    engine.react({} as never, [HEALTH], new Date(T3.getTime() + 60_000));
  const sweep = (engine: AlarmEngine): Promise<unknown> =>
    engine.sweep({} as never, new Date(T3.getTime() + 60_000));
  const said = (requests: readonly RequestInsert[]): unknown[] =>
    requests.map((request) => [request.reason, request.templateId, request.message]);

  describe('whose episode ended while its probe stayed lost', () => {
    for (const [name, run] of [
      ['the reaction', react],
      ['the sweep', sweep],
    ] as const) {
      it(`is recovered by ${name} in words that say why, never stood down silently`, async () => {
        const { engine, requests, cleared } = over({
          state: 'down',
          phase: 'notified',
          emptied: true,
        });
        await run(engine);
        assert.deepEqual(said(requests), [['recovery', 12, EMPTIED]]);
        assert.deepEqual(cleared, [900]);
      });

      it(`is cancelled by ${name}, saying nothing, when it was never sent or Probe Health is paused`, async () => {
        for (const [state, phase] of [
          ['down', 'pending'],
          ['paused', 'notified'],
        ] as const) {
          const { engine, requests, cleared } = over({ state, phase, emptied: true });
          await run(engine);
          assert.deepEqual(requests, [], `${state}/${phase}`);
          assert.deepEqual(cleared, [900], `${state}/${phase}`);
        }
      });
    }
  });

  describe('that is Probe Health’s own, armed before the episode (`M-18`)', () => {
    it('is left to its own state by the reaction, emptied or not', async () => {
      // `closes` takes an alarm armed at or before the episode's start, so that one resumed across
      // episodes inside a held return is still closed by the last. One armed before the episode
      // on Probe Health's own Unknown, a sensor awaiting its first reading, still stands on that,
      // and is not the episode's to recover.
      for (const emptied of [true, false]) {
        const { engine, requests, cleared } = over({
          state: 'unknown',
          cause: 'scan',
          phase: 'notified',
          emptied,
          since: new Date(T1.getTime() - 60_000),
        });
        await react(engine);
        assert.deepEqual(requests, [], `emptied: ${String(emptied)}`);
        assert.deepEqual(cleared, [], `emptied: ${String(emptied)}`);
      }
    });
  });

  describe('on an acknowledged Probe Health, while the episode goes on', () => {
    it('is not armed by the reaction', async () => {
      const { engine, armed, requests } = over({
        state: 'down_acknowledged',
        phase: null,
        emptied: false,
      });
      await react(engine);
      assert.deepEqual(armed, []);
      assert.deepEqual(requests, []);
    });

    it('is suppressed by the reaction, once: a suppressed one is held as it stands', async () => {
      const once = over({ state: 'down_acknowledged', phase: 'notified', emptied: false });
      await react(once.engine);
      assert.deepEqual(
        once.advanced.map((row) => [row.id, row.suppressed, row.nextDueAt]),
        [[900, true, null]],
      );
      const again = over({
        state: 'down_acknowledged',
        phase: 'notified',
        suppressed: true,
        emptied: false,
      });
      await react(again.engine);
      assert.deepEqual(again.advanced, []);
      assert.deepEqual([...again.requests, ...again.cleared], []);
    });

    it('is parked by the sweep, not fired, when it falls due', async () => {
      const { engine, requests, cleared, advanced } = over({
        state: 'down_acknowledged',
        phase: 'notified',
        emptied: false,
      });
      await sweep(engine);
      assert.deepEqual(requests, [], 'no repeat');
      assert.deepEqual(cleared, []);
      assert.deepEqual(
        advanced.map((row) => [row.id, row.suppressed, row.nextDueAt]),
        [[900, true, null]],
      );
    });
  });
});
