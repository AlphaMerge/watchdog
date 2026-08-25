import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import { ReplayPacer, type ReplayPacerConfig } from '../src/ingestion/replay-pacer.js';

const silent = pino({ level: 'silent' });

const CONFIG: ReplayPacerConfig = {
  maxConcurrentProbes: 2,
  stepMs: 100,
  maxDelayMs: 1_000,
  idleAfterMs: 10_000,
};

function pacer(over: Partial<ReplayPacerConfig> = {}) {
  let clock = 1_700_000_000_000;
  const instance = new ReplayPacer({
    config: { ...CONFIG, ...over },
    logger: silent,
    now: () => clock,
  });
  return {
    pacer: instance,
    advance: (ms: number): void => {
      clock += ms;
    },
  };
}

describe('replay pacing', () => {
  it('never delays a probe with nothing behind it', () => {
    // The property the whole task is about: a probe reporting a check that just ran must not be
    // queued behind a fleet replaying their spools.
    const { pacer: p } = pacer();
    for (const source of ['a', 'b', 'c', 'd', 'e', 'f']) p.pace(source, 500);

    assert.equal(p.pace('live-probe', 0), 0);
    assert.equal(
      p.pace('another', undefined),
      0,
      'a probe that reports nothing is treated as live',
    );
  });

  it('lets a few probes catch up at full speed', () => {
    const { pacer: p } = pacer();
    assert.equal(p.pace('a', 100), 0);
    assert.equal(p.pace('b', 100), 0);
    assert.equal(p.stats().replaying, 2);
  });

  it('slows catch-up in proportion to how many probes are doing it', () => {
    const { pacer: p } = pacer();
    p.pace('a', 100);
    p.pace('b', 100);

    assert.equal(p.pace('c', 100), 100, 'one over the limit');
    assert.equal(p.pace('d', 100), 200, 'two over');
    assert.equal(p.pace('e', 100), 300);
  });

  it('caps the delay it will ask for', () => {
    // Past a point, asking politely is not the tool any more: the queue's own refusals are, and
    // they do not depend on a probe choosing to honour a hint.
    const { pacer: p } = pacer({ maxDelayMs: 250 });
    for (let n = 0; n < 50; n += 1) p.pace(`probe-${String(n)}`, 100);
    assert.equal(p.pace('probe-99', 100), 250);
  });

  it('releases a probe the moment it has caught up', () => {
    const { pacer: p } = pacer();
    p.pace('a', 100);
    p.pace('b', 100);
    p.pace('c', 100);
    assert.equal(p.stats().replaying, 3);

    // Caught up. It should stop counting against the others immediately — not after a timeout,
    // or the fleet keeps paying for a backlog nobody has any more.
    assert.equal(p.pace('c', 0), 0);
    assert.equal(p.stats().replaying, 2);
    assert.equal(p.pace('d', 100), 100, 'one over again, not two');
  });

  it('converges as probes finish, without any coordination', () => {
    const { pacer: p } = pacer();
    const sources = ['a', 'b', 'c', 'd', 'e'];
    for (const source of sources) p.pace(source, 100);
    assert.equal(p.pace('a', 100), 300, 'five replaying, three over the limit of two');

    for (const source of ['e', 'd', 'c']) p.pace(source, 0);
    assert.equal(p.pace('a', 100), 0, 'two left, so nobody is being slowed any more');
  });

  it('forgets a probe that stopped sending', () => {
    // A disconnected probe must not keep a slot: the ones still here would be paced for ever
    // against a backlog nobody is draining.
    const { pacer: p, advance } = pacer({ idleAfterMs: 5_000 });
    p.pace('gone', 100);
    p.pace('a', 100);
    p.pace('b', 100);
    assert.equal(p.stats().replaying, 3);

    advance(6_000);
    assert.equal(p.stats().replaying, 0, 'all three went quiet');
    assert.equal(p.pace('a', 100), 0);
  });

  it('counts what it paced, for Probe Health to report', () => {
    const { pacer: p } = pacer();
    for (const source of ['a', 'b', 'c', 'd']) p.pace(source, 100);
    const stats = p.stats();
    assert.ok(stats.paced > 0);
    assert.equal(stats.maxDelayMs, 200);
  });
});
