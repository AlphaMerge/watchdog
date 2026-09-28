import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  episodeEndedMessage,
  episodeMessage,
  isCarried,
  isLive,
  seenBy,
} from '../src/notifications/episodes.js';
import { ProbeEpisodeIndex, type FrozenProbe, type LostProbe } from '../src/probes/episodes.js';
import { V1_STATES } from '../src/state/tables.js';

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
  index: ProbeEpisodeIndex;
} {
  const lost = new Map<number, LostProbe>();
  const frozen = new Map<number, FrozenProbe>();
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
  });
  return { lost, frozen, index };
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

  it('files an end it is first told of through the ended question', () => {
    const { lost, index } = world();
    lost.set(PROBE, { sensorIds: [1], reason: 'link', since: T1 });
    index.episodeOf(HEALTH);
    lost.delete(PROBE);
    assert.equal(index.endedEpisodeOf(HEALTH)?.kind, 'lost');
  });

  it('answers nothing before its sources exist', () => {
    const index = new ProbeEpisodeIndex({
      lost: () => undefined,
      frozen: () => undefined,
      alarms: () => undefined,
    });
    assert.equal(index.carrierOf(1), undefined);
    assert.deepEqual(index.alarmsFor(PROBE), []);
    assert.equal(index.episodeOf(HEALTH), undefined);
    assert.equal(index.endedEpisodeOf(HEALTH), undefined);
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
    assert.equal(
      episodeEndedMessage(lost, 'Site A'),
      'probe Site A is answering again: its sensors are no longer held',
    );
    assert.match(episodeEndedMessage({ ...lost, kind: 'frozen' }, 'Site A'), /caught up/u);
  });
});
