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
 *
 * **Everything is an age in milliseconds** (`P-81`). The rule used to take `Date`s and subtract
 * them, which is a duration on the wrong clock — `CLAUDE.md`: time is monotonic for scheduling,
 * wall-clock for data. Ages cannot be negative and no clock step can move one, so the two clock
 * defects `P-80` found are not expressible against this interface rather than merely untested.
 */

const GRACE_MS = DELIVERY_DEFAULTS.graceSeconds * 1_000;
/** Core uptime at `seconds` past the end of the grace, which is where every window starts. */
const pastGrace = (seconds: number): number => GRACE_MS + seconds * 1_000;

const facts = (over: Partial<DeliveryFacts> = {}): DeliveryFacts => ({
  assignedSensors: 100,
  cadenceSeconds: 60,
  sinceResultsMs: null,
  sinceConfigMs: null,
  connectedForMs: Number.MAX_SAFE_INTEGER,
  configured: true,
  configurable: true,
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
    const seen = verdict(facts({ assignedSensors: 0 }), pastGrace(100_000));
    assert.equal(seen.stalled, false);
    assert.equal(seen.reason, 'nothing-assigned');
  });

  it('does not mistake a configuration the core never built for a probe with no work', () => {
    // **`P-82`.** `assignedSensors` is what the core *built*, and on every path where that
    // computation did not happen it is still the empty set a session opens with — which reads
    // exactly like the row above. `assignmentsFor` throwing is logged once and the connection is
    // kept, and on a stable installation nothing retries for days, so a probe carrying three
    // hundred sensors and checking none of them reported itself as delivering: the precise
    // failure this rule exists to catch, reached through the rule.
    const seen = verdict(facts({ assignedSensors: 0, configured: false }), pastGrace(100_000));
    assert.equal(seen.stalled, true);
    assert.equal(seen.reason, 'unconfigured', 'a distinct fault, with a distinct fix');
  });

  it('leaves a probe too old to be configured to the channel that already alarms for it', () => {
    // One outage, one alarm. A probe below the config-push version scans nothing, but `R-06`'s
    // `protocol` channel says so with its own lookup, and this raising a second alarm for the
    // same cause is what `CLAUDE.md` forbids.
    const seen = verdict(
      facts({ assignedSensors: 0, configured: false, configurable: false }),
      pastGrace(100_000),
    );
    assert.equal(seen.stalled, false);
    assert.equal(seen.reason, 'too-old');
  });

  it('says nothing at all while the core is still starting up', () => {
    // **The trap that killed one of the rejected designs.** `loadRuntimes` restores
    // `probeReachable: true` optimistically and the reachability set starts empty, both
    // deliberately, so a restart does not generate its own alarm storm. A watchdog without a
    // grace produces exactly that storm on the way back up.
    const seen = verdict(facts(), GRACE_MS - 1_000);
    assert.equal(seen.stalled, false);
    assert.equal(seen.reason, 'in-grace');
  });

  it('runs its window from the end of the grace, not from the core’s start', () => {
    // Otherwise the grace is not a grace: a probe would be judged on silence from before the
    // core existed to hear it.
    assert.equal(verdict(facts(), pastGrace(239)).stalled, false, '239 s against a 240 s window');
    assert.equal(verdict(facts(), pastGrace(241)).stalled, true);
  });

  it('runs its window from the config push, because new work cannot already be late', () => {
    const soonAfter = verdict(facts({ sinceConfigMs: 100_000 }), pastGrace(100_000));
    assert.equal(soonAfter.stalled, false, 'a hundred seconds into a 240 s window');
    assert.equal(soonAfter.reason, 'delivering');

    assert.equal(verdict(facts({ sinceConfigMs: 400_000 }), pastGrace(100_000)).stalled, true);
  });

  it('counts from the last arrival once there has been one', () => {
    assert.equal(verdict(facts({ sinceResultsMs: 200_000 }), pastGrace(5_000)).stalled, false);
    assert.equal(verdict(facts({ sinceResultsMs: 300_000 }), pastGrace(5_000)).stalled, true);
  });

  it('is punctual, not late, at exactly its own window', () => {
    // `>` and not `>=`. A probe reporting on exactly the period it was given must not be called
    // late for being on time — the same boundary `P-59` settled for staleness.
    const exactly = verdict(facts({ sinceResultsMs: 240_000 }), pastGrace(5_000));
    assert.equal(exactly.stalled, false);
    assert.equal(exactly.silentForMs, 240_000);
    assert.equal(exactly.windowMs, 240_000);
  });

  it('takes the most recent evidence, whichever of the four it is', () => {
    // A probe that was silent, then had its assignments re-sent, is not still silent for the
    // original span: the push resets the question. Among ages the most recent is the smallest.
    const seen = verdict(
      facts({ sinceResultsMs: 8_000_000, sinceConfigMs: 100_000 }),
      pastGrace(9_000),
    );
    assert.equal(seen.stalled, false);
    assert.equal(seen.silentForMs, 100_000);
  });

  it('gives a probe that has only just connected its window, not the core’s uptime', () => {
    // **`P-80`, and a regression `P-77` introduced.** `P-77` narrowed `configSentAt` to the branch
    // that actually sends configuration — correct in itself — but the ordinary reconnect is
    // `config-unchanged`: the probe kept its fingerprint across the drop, so the core sends
    // nothing and stamps nothing. That session then has neither an arrival nor a push, and the
    // window ran from the core's whole uptime. A probe cannot have been silent for longer than
    // the session it is silent on.
    const seen = verdict(
      facts({ sinceResultsMs: null, sinceConfigMs: null, connectedForMs: 3_000 }),
      pastGrace(21_600),
    );
    assert.equal(seen.stalled, false, 'three seconds into a session is not six hours of silence');
    assert.equal(seen.silentForMs, 3_000);
  });

  it('does not let the session clock excuse a probe that has been connected and quiet', () => {
    // The other side of it: the session's own age is a floor on the window, not a reprieve.
    const seen = verdict(
      facts({ sinceResultsMs: null, sinceConfigMs: null, connectedForMs: 3_600_000 }),
      pastGrace(4_000),
    );
    assert.equal(seen.stalled, true);
    assert.equal(seen.silentForMs, 3_600_000);
  });

  it('treats an anchor that has never happened as forever ago, never as just now', () => {
    // The one arithmetic trap in moving from instants to ages. `null` meaning "no arrival yet"
    // has to read as `Infinity` in a `Math.min`, because 0 would read as "this instant" and
    // excuse the probe for the life of the process — the mirror of the `?? 0` that was correct
    // under `Math.max` over instants.
    const seen = verdict(
      facts({ sinceResultsMs: null, sinceConfigMs: null, connectedForMs: 900_000 }),
      pastGrace(1_000),
    );
    assert.equal(seen.stalled, true, 'never having delivered is not the same as having just');
    assert.equal(seen.silentForMs, 900_000);
  });

  it('can be switched off entirely', () => {
    const seen = verdict(facts(), pastGrace(1_000_000), { ...DELIVERY_DEFAULTS, intervals: 0 });
    assert.equal(seen.stalled, false);
    assert.equal(seen.reason, 'disabled');
  });

  it('is monotone in silence and in nothing else', () => {
    // Once stalled, more silence cannot make it un-stalled; the only thing that clears it is
    // something arriving. Stated as a law because a rule that flaps writes garbage into the state
    // history uptime and SLA are computed from.
    let sawStalled = false;
    for (let ms = 0; ms <= 1_000_000; ms += 10_000) {
      const seen = verdict(facts({ sinceResultsMs: ms }), pastGrace(100_000));
      if (seen.stalled) sawStalled = true;
      else assert.equal(sawStalled, false, `un-stalled at ${String(ms)} ms of silence`);
    }
    assert.equal(sawStalled, true, 'and it does stall eventually');
  });

  it('cannot express a negative age, which is what the clock defects were', () => {
    // `P-80` found the rule answering 'delivering' for every probe after a backward clock step,
    // because `silentForMs` was a difference of two wall-clock instants and nothing checked its
    // sign. There is no longer an input that could produce one: every field is a monotonic age,
    // and `Math.min` over non-negative numbers is non-negative. This asserts the property rather
    // than a scenario, because the scenario is no longer constructible.
    for (const over of [
      { sinceResultsMs: 0 },
      { sinceConfigMs: 0, connectedForMs: 0 },
      { sinceResultsMs: 0, sinceConfigMs: 0, connectedForMs: 0 },
    ]) {
      const seen = verdict(facts(over), pastGrace(0));
      assert.ok((seen.silentForMs ?? 0) >= 0, `negative age from ${JSON.stringify(over)}`);
      assert.equal(seen.stalled, false, 'and zero silence is never a stall');
    }
  });
});
