import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Backoff } from '../src/transport/backoff.js';

describe('reconnect backoff', () => {
  it('grows exponentially up to the ceiling', () => {
    // random() === 1 takes the top of each jitter window, exposing the growth curve.
    const backoff = new Backoff({ minDelayMs: 1_000, maxDelayMs: 60_000, random: () => 1 });

    assert.deepEqual(
      [
        backoff.nextDelayMs(),
        backoff.nextDelayMs(),
        backoff.nextDelayMs(),
        backoff.nextDelayMs(),
        backoff.nextDelayMs(),
        backoff.nextDelayMs(),
        backoff.nextDelayMs(),
        backoff.nextDelayMs(),
      ],
      [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000],
    );
  });

  it('never returns less than the minimum delay', () => {
    const backoff = new Backoff({ minDelayMs: 1_000, maxDelayMs: 60_000, random: () => 0 });
    for (let i = 0; i < 10; i += 1) {
      assert.ok(backoff.nextDelayMs() >= 1_000, 'a tight reconnect loop is its own outage');
    }
  });

  it('spreads a simultaneous reconnect across the window', () => {
    // Every probe in an installation is disconnected by one core restart. Without jitter they
    // would return in lockstep and collide again.
    const delays = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      const backoff = new Backoff({ minDelayMs: 1_000, maxDelayMs: 60_000 });
      backoff.nextDelayMs();
      backoff.nextDelayMs();
      backoff.nextDelayMs();
      delays.add(backoff.nextDelayMs());
    }
    assert.ok(
      delays.size > 100,
      `expected a wide spread, got ${String(delays.size)} distinct delays`,
    );
  });

  it('resets after a successful connection', () => {
    const backoff = new Backoff({ minDelayMs: 1_000, maxDelayMs: 60_000, random: () => 1 });
    backoff.nextDelayMs();
    backoff.nextDelayMs();
    backoff.nextDelayMs();
    assert.equal(backoff.attempt, 3);

    backoff.reset();

    assert.equal(backoff.attempt, 0);
    assert.equal(backoff.nextDelayMs(), 1_000, 'the next outage starts from the bottom again');
  });
});
