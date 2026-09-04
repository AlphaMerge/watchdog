import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  DELIVERY_DEFAULTS,
  deliveryWindowMs,
  verdict,
  type DeliveryFacts,
} from '../src/probes/delivery.js';

/**
 * Whether a connected probe is still carrying its sensors (`P-74`).
 *
 * Table-driven against the pure function, and needing no database, because the rule is the whole
 * of the ticket: every design that got this wrong got it wrong in the *predicate*, not in the
 * plumbing. The two that were rejected fired during a legitimate spool replay and alarmed on
 * every sensor after a core restart respectively, and both are rows here.
 */

const START = new Date('2026-09-04T00:00:00.000Z');
const after = (seconds: number): Date => new Date(START.getTime() + seconds * 1_000);

const facts = (over: Partial<DeliveryFacts> = {}): DeliveryFacts => ({
  assignedSensors: 100,
  cadenceSeconds: 60,
  lastResultsAt: null,
  configSentAt: null,
  ...over,
});

describe('the delivery window', () => {
  it('is four of the probe’s own intervals', () => {
    assert.equal(deliveryWindowMs(60), 240_000);
    assert.equal(deliveryWindowMs(300), 1_200_000);
  });

  it('never shrinks below the floor, however fast the probe scans', () => {
    // A ten-second sensor would otherwise buy a forty-second window, which is hair-trigger for
    // anything that has to cross a network and be written.
    assert.equal(deliveryWindowMs(10), DELIVERY_DEFAULTS.floorSeconds * 1_000);
    assert.equal(deliveryWindowMs(0), DELIVERY_DEFAULTS.floorSeconds * 1_000);
  });

  it('never grows past the ceiling, however slowly', () => {
    // A daily sensor must not buy its probe a day of silence: everything else under that probe
    // would be frozen for the whole of it, which is the defect rather than the fix.
    assert.equal(deliveryWindowMs(86_400), DELIVERY_DEFAULTS.ceilingSeconds * 1_000);
  });

  it('gives a probe with no cadence yet the floor rather than nothing', () => {
    // Zero would call every probe stalled the instant it was assigned anything.
    assert.equal(deliveryWindowMs(null), DELIVERY_DEFAULTS.floorSeconds * 1_000);
  });
});

describe('whether a connected probe is delivering', () => {
  it('has no opinion about a probe with nothing assigned', () => {
    // The assignment list already excludes every pause source, schedule window, dependency and
    // core-evaluated type, so a legitimately quiet probe arrives here with nothing to be late
    // with — and none of that exclusion logic is restated, which is how the two would drift.
    const seen = verdict(facts({ assignedSensors: 0 }), after(100_000), START);
    assert.equal(seen.stalled, false);
    assert.equal(seen.reason, 'nothing-assigned');
  });

  it('says nothing at all while the core is still starting up', () => {
    // **The trap that killed one of the rejected designs.** `loadRuntimes` restores
    // `probeReachable: true` optimistically and the reachability set starts empty, both
    // deliberately, so a restart does not generate its own alarm storm. A watchdog without a
    // grace produces exactly that storm on the way back up.
    const seen = verdict(facts(), after(DELIVERY_DEFAULTS.graceSeconds - 1), START);
    assert.equal(seen.stalled, false);
    assert.equal(seen.reason, 'in-grace');
  });

  it('runs its window from the end of the grace, not from the core’s start', () => {
    // Otherwise the grace is not a grace: a probe would be judged on silence from before the
    // core existed to hear it.
    const justInside = verdict(facts(), after(DELIVERY_DEFAULTS.graceSeconds + 239), START);
    assert.equal(justInside.stalled, false, '239 s after the grace, against a 240 s window');

    const justOutside = verdict(facts(), after(DELIVERY_DEFAULTS.graceSeconds + 241), START);
    assert.equal(justOutside.stalled, true);
  });

  it('runs its window from the config push, because new work cannot already be late', () => {
    const sentAt = after(1_000);
    const soonAfter = verdict(facts({ configSentAt: sentAt }), after(1_100), START);
    assert.equal(soonAfter.stalled, false, 'a hundred seconds into a 240 s window');
    assert.equal(soonAfter.reason, 'delivering');

    const longAfter = verdict(facts({ configSentAt: sentAt }), after(1_400), START);
    assert.equal(longAfter.stalled, true);
  });

  it('counts from the last arrival once there has been one', () => {
    const arrived = after(5_000);
    assert.equal(verdict(facts({ lastResultsAt: arrived }), after(5_200), START).stalled, false);
    assert.equal(verdict(facts({ lastResultsAt: arrived }), after(5_300), START).stalled, true);
  });

  it('is punctual, not late, at exactly its own window', () => {
    // `>` and not `>=`. A probe reporting on exactly the period it was given must not be called
    // late for being on time — the same boundary `P-59` settled for staleness.
    const arrived = after(5_000);
    const exactly = verdict(facts({ lastResultsAt: arrived }), after(5_240), START);
    assert.equal(exactly.stalled, false);
    assert.equal(exactly.silentForMs, 240_000);
    assert.equal(exactly.windowMs, 240_000);
  });

  it('takes the latest evidence, whichever of the three it is', () => {
    // A probe that was silent, then had its assignments re-sent, is not still silent for the
    // original span: the push resets the question.
    const seen = verdict(
      facts({ lastResultsAt: after(1_000), configSentAt: after(9_000) }),
      after(9_100),
      START,
    );
    assert.equal(seen.stalled, false);
    assert.equal(seen.silentForMs, 100_000);
  });

  it('does not fire on a probe replaying an hour of spool', () => {
    // **The trap the whole design turns on.** A replay delivers results *stamped* an hour ago but
    // *arriving* now. Nothing here reads the probe's timestamp for a check, so a catch-up that is
    // working looks exactly like ordinary delivery — which it is.
    let now = after(10_000);
    for (let i = 0; i < 40; i += 1) {
      // Batches landing every 30 s, each carrying results the probe stamped an hour earlier.
      const seen = verdict(facts({ lastResultsAt: now }), new Date(now.getTime() + 30_000), START);
      assert.equal(seen.stalled, false, `replay batch ${String(i)} must not trip the watchdog`);
      now = new Date(now.getTime() + 30_000);
    }
  });

  it('can be switched off entirely', () => {
    const seen = verdict(facts(), after(1_000_000), START, {
      ...DELIVERY_DEFAULTS,
      intervals: 0,
    });
    assert.equal(seen.stalled, false);
    assert.equal(seen.reason, 'disabled');
  });

  it('is monotone in silence and in nothing else', () => {
    // Once stalled, more silence cannot make it un-stalled; the only thing that clears it is
    // something arriving. Stated as a law because a rule that flaps writes garbage into the state
    // history uptime and SLA are computed from.
    const arrived = after(5_000);
    let sawStalled = false;
    for (let s = 5_000; s <= 6_000; s += 10) {
      const seen = verdict(facts({ lastResultsAt: arrived }), after(s), START);
      if (seen.stalled) sawStalled = true;
      else assert.equal(sawStalled, false, `un-stalled at ${String(s)} s after having stalled`);
    }
    assert.equal(sawStalled, true, 'and it does stall eventually');
  });
});
