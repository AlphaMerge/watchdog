import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { pino } from 'pino';
import {
  HelperTroubleLatch,
  TROUBLE_CLEAR_MS,
  TROUBLE_LOSSES,
  TROUBLE_NOT_UP_MS,
  TROUBLE_WINDOW_MS,
} from '../src/health/latch.js';
import type {
  HelperChange,
  HelperState,
  LossReason,
  RouteState,
} from '../src/resolver/lookup-helper.js';

/**
 * The lookup helper's trouble latch (`P-432` §1.13, D29): set by the helper failing, never by a
 * zone's outage, and cleared by ten minutes up with no loss unless a rest lasts until restart.
 */

const silent = pino({ level: 'silent' });

function make() {
  const clock = { now: 0 };
  const latch = new HelperTroubleLatch({ logger: silent, now: () => clock.now });
  let state: HelperState = 'idle';
  const to = (next: HelperState, extra: Partial<HelperChange> = {}): void => {
    const route: RouteState =
      next === 'up'
        ? 'up'
        : next === 'resting'
          ? 'resting'
          : next === 'backoff'
            ? 'rejoining'
            : 'down';
    latch.change({ state: next, previous: state, route, isolating: false, ...extra });
    state = next;
  };
  /** A loss: the child is gone, and the helper backs off or rests; `null`, until restart. */
  const lose = (
    reason: LossReason,
    extra: Partial<HelperChange> = {},
    next: HelperState = 'backoff',
    delayMs: number | null = 250,
  ): void => {
    to(next, { loss: reason, ...(delayMs === null ? {} : { delayMs }), ...extra });
  };
  /** A loss and the child back up at once. */
  const bounce = (reason: LossReason, extra: Partial<HelperChange> = {}): void => {
    lose(reason, extra);
    to('starting');
    to('up');
  };
  return { clock, latch, to, lose, bounce };
}

describe('the lookup helper’s trouble latch (P-432 S3, §1.13)', () => {
  it('is built to the numbers decided: 30 s not up, 3 losses in 10 minutes, cleared after 10', () => {
    assert.equal(TROUBLE_NOT_UP_MS, 30_000);
    assert.equal(TROUBLE_LOSSES, 3);
    assert.equal(TROUBLE_WINDOW_MS, 600_000);
    assert.equal(TROUBLE_CLEAR_MS, 600_000);
  });

  it('stays 0 for a helper that starts and answers', () => {
    const { clock, latch, to } = make();
    to('starting');
    clock.now = 2_000;
    to('up');
    clock.now = 3_600_000;
    assert.equal(latch.value(), 0);
    assert.equal(latch.reason(), undefined);
  });

  it('sets at 30 s not up from the start, and not a millisecond before', () => {
    const { clock, latch, to } = make();
    to('starting');
    clock.now = TROUBLE_NOT_UP_MS - 1;
    assert.equal(latch.value(), 0);
    clock.now = TROUBLE_NOT_UP_MS;
    assert.equal(latch.value(), 1);
    assert.equal(latch.reason(), 'not-up');
  });

  it('counts a stretch not up that ended between two reports', () => {
    const { clock, latch, lose, to } = make();
    to('starting');
    to('up');
    clock.now = 1_000;
    lose('exit');
    to('starting');
    clock.now = 1_000 + TROUBLE_NOT_UP_MS;
    to('up');
    // No report read it while it was down.
    clock.now += 1;
    assert.equal(latch.value(), 1);
    assert.equal(latch.reason(), 'not-up');
  });

  it('times the stretch from its first moment: backoff, starting and unresponsive are all not up', () => {
    const { clock, latch, lose, to } = make();
    to('starting');
    to('up');
    clock.now = 100;
    to('unresponsive');
    clock.now = 10_100;
    lose('hung');
    clock.now = 20_100;
    to('starting');
    clock.now = 100 + TROUBLE_NOT_UP_MS - 1;
    assert.equal(latch.value(), 0);
    clock.now = 100 + TROUBLE_NOT_UP_MS;
    assert.equal(latch.value(), 1);
  });

  it('never sets while the probe stops, or for a helper not started', () => {
    const { clock, latch, to } = make();
    to('starting');
    to('up');
    to('stopping');
    clock.now = 10 * TROUBLE_NOT_UP_MS;
    assert.equal(latch.value(), 0);
    to('stopped');
    clock.now = 20 * TROUBLE_NOT_UP_MS;
    assert.equal(latch.value(), 0);
  });

  it('sets at the third loss in ten minutes, each child back up at once', () => {
    const { clock, latch, bounce } = make();
    bounce('exit');
    clock.now = 100_000;
    bounce('exit');
    assert.equal(latch.value(), 0, 'two losses are not trouble');
    clock.now = TROUBLE_WINDOW_MS - 1;
    bounce('hung');
    assert.equal(latch.value(), 1);
    assert.equal(latch.reason(), 'losses');
  });

  it('forgets a loss ten minutes old', () => {
    const { clock, latch, bounce } = make();
    bounce('exit');
    clock.now = 100_000;
    bounce('exit');
    clock.now = TROUBLE_WINDOW_MS;
    bounce('exit');
    assert.equal(latch.value(), 0, 'the first is out of the window');
    clock.now = TROUBLE_WINDOW_MS + 99_999;
    bounce('exit');
    assert.equal(latch.value(), 1);
  });

  it('does not count a poison name crashing again at its hourly ask, and does count a new one', () => {
    const { clock, latch, bounce } = make();
    bounce('exit', { charged: 'again' });
    clock.now = 1_000;
    bounce('exit', { charged: 'again' });
    clock.now = 2_000;
    bounce('exit', { charged: 'again' });
    clock.now = 3_000;
    bounce('exit');
    assert.equal(latch.value(), 0, 'one loss counted');
    clock.now = 4_000;
    bounce('exit', { charged: 'new' });
    clock.now = 5_000;
    bounce('exit');
    assert.equal(latch.value(), 1, 'a crash that makes a poison mark counts');
  });

  it('sets on the first memory loss', () => {
    const { latch, bounce } = make();
    bounce('memory');
    assert.equal(latch.value(), 1);
    assert.equal(latch.reason(), 'memory');
  });

  it('sets on a rest, while the probe resolves as with system', () => {
    const { latch, lose } = make();
    lose('exit', { delayMs: 600_000 }, 'resting');
    assert.equal(latch.value(), 1);
    assert.equal(latch.reason(), 'resting');
  });

  it('clears after ten minutes up with no loss, and not before', () => {
    const { clock, latch, bounce } = make();
    bounce('memory');
    clock.now = TROUBLE_CLEAR_MS - 1;
    assert.equal(latch.value(), 1);
    clock.now = TROUBLE_CLEAR_MS;
    assert.equal(latch.value(), 0);
    assert.equal(latch.reason(), undefined);
  });

  it('starts the ten minutes again at every loss', () => {
    const { clock, latch, bounce } = make();
    bounce('memory');
    clock.now = TROUBLE_CLEAR_MS - 1_000;
    bounce('exit');
    clock.now = TROUBLE_CLEAR_MS;
    assert.equal(latch.value(), 1, 'up again only 1 s');
    clock.now = 2 * TROUBLE_CLEAR_MS - 1_000;
    assert.equal(latch.value(), 0);
  });

  it('starts the ten minutes only once the helper is up again', () => {
    const { clock, latch, lose, to } = make();
    to('starting');
    to('up');
    lose('memory');
    to('starting');
    clock.now = TROUBLE_CLEAR_MS;
    assert.equal(latch.value(), 1, 'not up yet');
    to('up');
    clock.now = 2 * TROUBLE_CLEAR_MS - 1;
    assert.equal(latch.value(), 1);
    clock.now = 2 * TROUBLE_CLEAR_MS;
    assert.equal(latch.value(), 0);
  });

  it('a timed rest clears once its child has answered ten minutes', () => {
    const { clock, latch, lose, to } = make();
    lose('exit', { delayMs: 600_000 }, 'resting');
    clock.now = 600_000;
    to('starting');
    to('up');
    clock.now = 600_000 + TROUBLE_CLEAR_MS;
    assert.equal(latch.value(), 0);
  });

  it('a rest until restart (a skew) keeps it set, whatever comes after', () => {
    const { clock, latch, lose, to } = make();
    lose('skew', {}, 'resting', null);
    assert.equal(latch.value(), 1);
    // Nothing short of a restart mends it, even a child that came up.
    to('starting');
    to('up');
    clock.now = 10 * TROUBLE_CLEAR_MS;
    assert.equal(latch.value(), 1);
    assert.equal(latch.reason(), 'resting');
  });

  it('keeps the first reason while it is set', () => {
    const { latch, bounce, lose } = make();
    bounce('memory');
    lose('exit', { delayMs: 600_000 }, 'resting');
    assert.equal(latch.reason(), 'memory');
  });
});
