import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { NotificationRing } from '../src/listeners/ring.js';

/**
 * Where a sensor's first drain starts reading (`P-254`).
 *
 * `H-15` restarted a probe, sent three traps 41 seconds later, and found them in Probe Health's
 * `trapReceived` and in neither trap sensor's `count` or `dropped`: each sensor's cursor was made at
 * its first scan, at the ring's current sequence, so what was already in the ring belonged to
 * nobody. The ring now tells apart the reasons a sensor has no cursor, and each is here: the
 * probe restarted, a cut push parked it, the sensor is new to a running probe (`P-269`: it reads
 * from its assignment), and `retain` removed it.
 *
 * Sensor 9 stands for a sensor of another type — a ping sensor — which `retain` is handed like any
 * other and which never drains this ring.
 */

const TRAP = 'snmp-trap';
const PING = 9;
/** Every sensor here scans once a minute: how far back a restart's first scan reads. */
const MINUTE = 60_000;

function ringOf(size = 100): {
  ring: NotificationRing;
  push: (n: number) => void;
  tick: (seconds?: number) => void;
  started: string;
} {
  let clock = 0;
  // The wall clock and the monotonic one move together here; one test steps the wall alone.
  const ring = new NotificationRing(
    size,
    () => new Date(1_800_000_000_000 + clock * 1_000),
    () => clock * 1_000,
  );
  let sent = 0;
  return {
    ring,
    push: (n) => {
      for (let i = 0; i < n; i += 1) {
        ring.push({
          at: new Date(1_800_000_000_000 + clock * 1_000).toISOString(),
          source: '192.0.2.1',
          text: `trap ${String(sent)}`,
          detail: {},
        });
        sent += 1;
      }
    },
    tick: (seconds = 1) => {
      clock += seconds;
    },
    started: new Date(1_800_000_000_000).toISOString(),
  };
}

const texts = (ring: NotificationRing, sensorId: number): string[] =>
  ring.drain(sensorId, TRAP, MINUTE).items.map((item) => item.text);

describe('a sensor held across a probe restart (`P-254`)', () => {
  it('reads what arrived before its first scan, when it scans before the probe has its sensors', () => {
    const h = ringOf();
    h.push(3);
    h.tick();

    const first = h.ring.drain(1, TRAP, MINUTE);
    assert.deepEqual(
      first.items.map((item) => item.text),
      ['trap 0', 'trap 1', 'trap 2'],
    );
    assert.equal(first.dropped, 0);
    assert.equal(first.since, h.started, 'since the listener started, not since this scan');
    assert.equal(h.ring.drain(1, TRAP, MINUTE).items.length, 0, 'and not a second time');
  });

  it('reads them when the probe has its sensors and the scan has not come yet — `H-15`’s shape', () => {
    // The settled push names both trap sensors and a ping sensor. Three traps arrive, and the two
    // trap sensors' first scans come nine seconds apart: each reads all three.
    const h = ringOf();
    h.ring.retain([1, 2, PING]);
    h.tick();
    h.push(3);
    h.tick();
    assert.equal(texts(h.ring, 1).length, 3, 'the first sensor counted none of them');
    h.tick();
    const second = h.ring.drain(2, TRAP, MINUTE);
    assert.equal(second.items.length, 3, 'the second sensor counted none of them');
    assert.equal(second.since, h.started);
    assert.equal(h.ring.cursors, 2, 'the ping sensor has no cursor here, and costs none');
  });

  it('is still one after a later push that names it again, as a reconnect does', () => {
    const h = ringOf();
    h.ring.retain([1, PING]);
    h.ring.retain([1, PING]);
    h.push(2);
    assert.equal(texts(h.ring, 1).length, 2);
  });

  it('counts as dropped what the ring overwrote inside its window, and on Probe Health once', () => {
    const h = ringOf(4);
    h.ring.retain([1, 2, PING]);
    h.push(7);
    assert.equal(h.ring.unread, 0, 'no sensor is known to read this ring yet');

    const first = h.ring.drain(1, TRAP, MINUTE);
    assert.deepEqual(
      first.items.map((item) => item.text),
      ['trap 3', 'trap 4', 'trap 5', 'trap 6'],
    );
    assert.equal(first.dropped, 3, 'the three the ring could not hold were this sensor’s loss');
    assert.equal(first.earlier, 0, 'all seven arrived inside its window');
    assert.equal(h.ring.unread, 3, 'and Probe Health says so');

    const second = h.ring.drain(2, TRAP, MINUTE);
    assert.equal(second.dropped, 3, 'the second sensor lost the same three');
    assert.equal(h.ring.unread, 3, 'counted once, however many sensors were behind');
  });

  it('counts what one sensor read and the other had not, once the other scans', () => {
    // Sensor 1 keeps up; sensor 2, held across the restart too, has not scanned. The four that
    // leave the ring had all been read by sensor 1, so nobody with a cursor lost them — but
    // sensor 2 did, from the listener's start.
    const h = ringOf(4);
    h.ring.retain([1, 2]);
    h.ring.drain(1, TRAP, MINUTE);
    h.push(4);
    assert.equal(h.ring.drain(1, TRAP, MINUTE).items.length, 4);
    h.push(4);
    assert.equal(h.ring.unread, 0);

    const late = h.ring.drain(2, TRAP, MINUTE);
    assert.equal(late.items.length, 4);
    assert.equal(late.dropped, 4);
    assert.equal(h.ring.unread, 4, 'the probe’s count is what the sensor behind lost');
    assert.equal(h.ring.drain(1, TRAP, MINUTE).dropped, 0, 'and sensor 1 lost nothing');
  });

  it('does not count again what was counted while a sensor with a cursor was behind', () => {
    // Sensor 1 has scanned once and fallen behind, so the two that leave the ring are counted as
    // they go. Sensor 2's first scan lost the same two, and they are not counted a second time.
    const h = ringOf(4);
    h.ring.retain([1, 2]);
    h.ring.drain(1, TRAP, MINUTE);
    h.push(6);
    assert.equal(h.ring.unread, 2);

    assert.equal(h.ring.drain(2, TRAP, MINUTE).dropped, 2);
    assert.equal(h.ring.unread, 2);
    assert.equal(h.ring.drain(1, TRAP, MINUTE).dropped, 2);
  });
});

describe('how far back a restart reads: one interval (`P-254`, the alarm volume)', () => {
  // A probe that started and could not reach its core for two minutes, with sensors that scan
  // once a minute. Each first scan is one interval's reading, as every later one is; what came
  // before that is `earlier`, which fails nothing and moves no channel.
  it('hands one interval and counts the rest as earlier, not dropped', () => {
    const h = ringOf();
    h.ring.retain([1]);
    h.push(5);
    h.tick(120);
    h.push(2);

    const first = h.ring.drain(1, TRAP, MINUTE);
    assert.deepEqual(
      first.items.map((item) => item.text),
      ['trap 5', 'trap 6'],
    );
    assert.equal(first.earlier, 5, 'the five from before the window are named');
    assert.equal(first.dropped, 0, 'and are not a loss, which would fail the scan');
    assert.equal(first.since, new Date(1_800_000_000_000 + 60_000).toISOString());
    assert.equal(h.ring.unread, 0);
  });

  it('is not a loss when the ring overwrote only what came before the window', () => {
    const h = ringOf(4);
    h.ring.retain([1]);
    h.push(10);
    h.tick(120);
    h.push(2);

    const first = h.ring.drain(1, TRAP, MINUTE);
    assert.equal(first.items.length, 2);
    assert.equal(first.earlier, 10);
    assert.equal(first.dropped, 0);
    assert.equal(h.ring.unread, 0, 'nothing anybody was waiting for was lost');
  });

  it('is a loss for what the ring overwrote inside the window, counted once', () => {
    const h = ringOf(4);
    h.ring.retain([1, 2]);
    h.push(3);
    h.tick(120);
    h.push(6);

    // Sequences 0..2 came two minutes ago; 3..8 now. The ring holds 5..8, so 3 and 4 were lost
    // inside the window, and 0..2 are before it.
    const first = h.ring.drain(1, TRAP, MINUTE);
    assert.equal(first.items.length, 4);
    assert.equal(first.dropped, 2);
    assert.equal(first.earlier, 3);
    assert.equal(h.ring.unread, 2);

    // A sensor that scans every five minutes reads back to the listener's start, so nothing is
    // earlier: all five that left were its loss, the oldest of them older than the ring can date.
    // Probe Health counts the three the first sensor had not.
    const slow = h.ring.drain(2, TRAP, 5 * MINUTE);
    assert.equal(slow.since, h.started);
    assert.equal(slow.earlier, 0, 'nothing comes before the listener’s start');
    assert.equal(slow.dropped, 5);
    assert.equal(h.ring.unread, 5);
  });

  it('counts the whole loss as dropped when the window reaches the listener’s start', () => {
    // Ten in a buffer of four inside the first interval: more than twice the buffer, so when the
    // first two arrived is no longer known — and does not need to be.
    const h = ringOf(4);
    h.ring.retain([1]);
    h.push(10);
    const first = h.ring.drain(1, TRAP, MINUTE);
    assert.equal(first.items.length, 4);
    assert.equal(first.earlier, 0);
    assert.equal(first.dropped, 6);
    assert.equal(first.since, h.started);
    assert.equal(h.ring.unread, 6);
  });

  it('counts a flood it cannot date as undated, and only what it can date inside the window as dropped', () => {
    // A buffer of a hundred. Five hundred arrive a minute after the start, two quiet minutes
    // pass, five hundred more arrive, and the sensor scans once a minute. The ring can date the
    // last two hundred, all inside the window; the eight hundred before them left it undated —
    // five hundred of them two minutes ago, three hundred inside the window, and no telling which.
    const h = ringOf(100);
    h.ring.retain([1, 2]);
    h.tick(60);
    h.push(500);
    h.tick(120);
    h.push(500);

    const first = h.ring.drain(1, TRAP, MINUTE);
    assert.equal(first.items.length, 100);
    assert.equal(first.dropped, 100, 'the dated hundred lost inside the window: one buffer');
    assert.equal(first.undated, 800, 'the rest, which could have arrived any time since the start');
    assert.equal(first.earlier, 0);
    assert.equal(
      first.items.length + first.dropped + (first.undated ?? 0) + (first.earlier ?? 0),
      1_000,
    );
    assert.equal(first.since, new Date(1_800_000_000_000 + 120_000).toISOString(), 'the window');
    assert.equal(h.ring.unread, 900, 'Probe Health counts every one lost, undated or not');

    const second = h.ring.drain(2, TRAP, MINUTE);
    assert.equal(second.dropped, 100);
    assert.equal(second.undated, 800);
    assert.equal(
      h.ring.unread,
      900,
      'once a record, from the running total and not the side array',
    );
  });

  it('starts `since` at the window, not the listener’s start, after a quiet ring', () => {
    // Two hours of nothing, then three in the last half minute: the record it resumes at is
    // itself inside the window. `since` is the window's start — a flow rate over the two hours
    // would read a hundred and twenty times too low.
    const h = ringOf(100);
    h.ring.retain([1]);
    h.tick(7_170);
    h.push(3);
    h.tick(30);
    const first = h.ring.drain(1, TRAP, MINUTE);
    assert.equal(first.items.length, 3);
    assert.equal(first.earlier, 0);
    assert.equal(Date.parse(first.until) - Date.parse(first.since), MINUTE);
  });

  it('measures the window on the monotonic clock, when the wall clock steps back an hour', () => {
    // A probe that starts before time sync: two arrive, two quiet minutes pass, the wall clock is
    // stepped back an hour, three more arrive. One interval back is the three, on the monotonic
    // clock. On the wall clock the window would begin before every arrival — or, clamped to the
    // listener's start, after all of them — and `since` could fall after `until`.
    let mono = 0;
    let wall = 1_800_000_000_000;
    const ring = new NotificationRing(
      100,
      () => new Date(wall),
      () => mono,
    );
    ring.retain([1]);
    const push = (): void => {
      ring.push({ at: new Date(wall).toISOString(), source: '192.0.2.1', text: 't', detail: {} });
    };
    push();
    push();
    mono += 120_000;
    wall += 120_000 - 3_600_000;
    push();
    push();
    push();
    mono += 1_000;
    wall += 1_000;

    const first = ring.drain(1, TRAP, MINUTE);
    assert.equal(first.items.length, 3, 'the three inside the interval');
    assert.equal(first.earlier, 2, 'the two before it');
    assert.equal(first.dropped, 0);
    assert.ok(first.since <= first.until, `${first.since} is after ${first.until}`);
    assert.equal(Date.parse(first.until) - Date.parse(first.since), MINUTE, 'one monotonic minute');
  });

  it('carries no `earlier` on any scan but a resume’s first', () => {
    const h = ringOf();
    h.ring.retain([1]);
    h.ring.drain(1, TRAP, MINUTE);
    h.push(1);
    assert.equal('earlier' in h.ring.drain(1, TRAP, MINUTE), false);
    h.ring.retain([1, 2]);
    // A new sensor's first scan resumes from its assignment (`P-269`), and nothing came before.
    assert.equal(h.ring.drain(2, TRAP, MINUTE).earlier, 0, 'a new sensor’s first: none earlier');
    h.push(1);
    assert.equal('earlier' in h.ring.drain(2, TRAP, MINUTE), false, 'nor its second');
  });
});

describe('a sensor a cut push took off the wheel (`P-254`)', () => {
  // A full push is cut after its first chunk; the sensors in the other chunks stop being scanned
  // until the reconnect's whole push brings them back. Each resumes one interval back, from where
  // its cursor stood: the hours the link was down are not one reading.
  it('resumes one interval back, with what came before since its last scan as earlier', () => {
    const h = ringOf(100);
    h.ring.retain([1, 2]);
    h.ring.drain(1, TRAP, MINUTE);
    h.ring.drain(2, TRAP, MINUTE);
    h.push(4);
    assert.equal(h.ring.drain(2, TRAP, MINUTE).items.length, 4, 'read before the cut');

    h.ring.retain([1], false);
    assert.equal(h.ring.cursors, 1, 'parked, not following');
    // Two hours, a record every twenty seconds: 360, in a buffer of 100.
    for (let at = 0; at < 360; at += 1) {
      h.push(1);
      h.tick(20);
    }
    h.ring.retain([1, 2], true);

    const back = h.ring.drain(2, TRAP, MINUTE);
    assert.equal(back.items.length, 3, 'one interval: three');
    assert.equal(back.dropped, 0, 'what the ring lost was before its window');
    assert.equal(back.earlier, 357, 'and every one since its last scan before that is named');
    assert.equal(
      back.items.length + back.dropped + (back.earlier ?? 0),
      360,
      'everything since its last read',
    );
    assert.equal(Date.parse(back.until) - Date.parse(back.since), MINUTE);
  });

  it('reads everything since its last scan when it comes back within an interval', () => {
    const h = ringOf(100);
    h.tick(300);
    h.ring.retain([1, 2]);
    h.ring.drain(2, TRAP, MINUTE);
    h.push(2);
    h.ring.retain([1], false);
    h.tick(10);
    h.push(3);
    h.ring.retain([1, 2], true);
    const back = h.ring.drain(2, TRAP, MINUTE);
    assert.equal(back.items.length, 5);
    assert.equal(back.earlier, 0);
    assert.equal(
      back.since,
      new Date(1_800_000_000_000 + 300_000).toISOString(),
      'since its last scan, not the listener’s start',
    );
  });

  it('starts `since` at the window, not its last scan, when it was quiet while parked', () => {
    const h = ringOf(100);
    h.ring.retain([1, 2]);
    h.ring.drain(2, TRAP, MINUTE);
    h.ring.retain([1], false);
    h.tick(7_170);
    h.push(3);
    h.tick(30);
    h.ring.retain([1, 2], true);
    const back = h.ring.drain(2, TRAP, MINUTE);
    assert.equal(back.items.length, 3);
    assert.equal(back.earlier, 0);
    assert.equal(Date.parse(back.until) - Date.parse(back.since), MINUTE);
  });

  it('is new if the whole push leaves it out', () => {
    const h = ringOf(100);
    h.ring.retain([1, 2]);
    h.ring.drain(2, TRAP, MINUTE);
    h.ring.retain([1], false);
    h.push(3);
    h.ring.retain([1], true);
    h.ring.retain([1, 2], true);
    const back = h.ring.drain(2, TRAP, MINUTE);
    assert.deepEqual(back.items, [], 'not the three from before it was added again');
    assert.equal(back.earlier, 0, 'deleted, then added again: from its return, not resumed');
  });

  it('counts on Probe Health what it lost inside its window, once', () => {
    // A buffer of four, parked sensor 2 and nobody else following: what leaves the ring is
    // counted by nobody until sensor 2 comes back and says which part of it was its loss.
    const h = ringOf(4);
    h.ring.retain([1, 2]);
    h.ring.drain(2, TRAP, MINUTE);
    h.ring.retain([1], false);
    h.tick(120);
    h.push(6);
    assert.equal(h.ring.unread, 0);
    h.ring.retain([1, 2], true);
    const back = h.ring.drain(2, TRAP, MINUTE);
    assert.equal(back.dropped, 2);
    assert.equal(back.earlier, 0);
    assert.equal(h.ring.unread, 2);
  });
});

describe('what a resuming sensor adds to Probe Health is its own loss, once (`P-273`)', () => {
  /**
   * Sensors that keep up with a buffer of ten for a thousand records: the ring overwrites 990
   * that they had all read, which no cursor was behind, and counts none of them. `held` are the
   * sensors the probe held across its restart, which may include one that has not scanned yet.
   */
  function keptUp(sensors: number[], held: number[] = sensors): ReturnType<typeof ringOf> {
    const h = ringOf(10);
    h.ring.retain(held);
    for (let batch = 0; batch < 100; batch += 1) {
      h.push(10);
      for (const sensor of sensors) h.ring.drain(sensor, TRAP, MINUTE);
    }
    assert.equal(h.ring.overwritten, 990);
    assert.equal(h.ring.unread, 0, 'nobody missed any of them');
    return h;
  }

  it('does not count what it had read, when another sensor kept its cursor — the traced case', () => {
    // Sensor 1 is parked by a cut push at 1000; sensor 2 keeps its cursor there. Thirty arrive
    // within the interval: the ring overwrites 990–999, which both had read, and 1000–1019, which
    // both missed and which sensor 2's cursor counted as they left. Sensor 1, back 40 s after its
    // last scan, lost 1000–1019 too: twenty, already counted. The single running total it drew
    // from held the 990 and the ten both had read, and Probe Health read thirty.
    const h = keptUp([1, 2]);
    h.ring.retain([2], false);
    for (let at = 0; at < 30; at += 1) {
      h.push(1);
      h.tick();
    }
    h.tick(10);
    assert.equal(h.ring.unread, 20, 'sensor 2’s cursor counted its twenty as they left');
    h.ring.retain([1, 2], true);

    const back = h.ring.drain(1, TRAP, MINUTE);
    assert.equal(back.earlier, 0, 'inside its window: everything since its last scan');
    assert.equal(back.undated, undefined);
    assert.equal(back.dropped, 20);
    assert.equal(back.items.length, 10);
    assert.equal(h.ring.unread, 20, 'the twenty both lost, once — not thirty');
    assert.equal(h.ring.drain(2, TRAP, MINUTE).dropped, 20);
    assert.equal(h.ring.unread, 20);
  });

  it('counts once what two parked sensors both lost, and none of what they had read', () => {
    // Both parked at 1000 with no cursor left: fifty arrive in the interval, and the ring
    // overwrites 990–1039 with nobody behind any of it. 990–999 both had read; 1000–1039 both
    // lost, thirty of them more than a buffer back, where the ring keeps nothing per record.
    const h = keptUp([1, 2]);
    h.ring.retain([], false);
    h.push(50);
    h.tick(30);
    assert.equal(h.ring.unread, 0, 'nobody is known to be waiting yet');
    h.ring.retain([1, 2], true);

    const first = h.ring.drain(1, TRAP, MINUTE);
    assert.equal(first.dropped, 40);
    assert.equal(h.ring.unread, 40, 'its own forty, not the ten it had read');
    const second = h.ring.drain(2, TRAP, MINUTE);
    assert.equal(second.dropped, 40);
    assert.equal(h.ring.unread, 40, 'the same forty, counted once');
  });

  it('leaves a restarted sensor that missed everything with every overwrite counted once', () => {
    // Sensor 3 was held across the restart and never scanned until now: it missed every record
    // the ring overwrote, the 990 the others read, and the forty the parked pair lost.
    const h = keptUp([1, 2], [1, 2, 3]);
    h.ring.retain([3], false);
    h.push(50);
    h.ring.retain([1, 2, 3], true);
    h.ring.drain(1, TRAP, MINUTE);
    h.ring.drain(2, TRAP, MINUTE);
    assert.equal(h.ring.unread, 40);

    const late = h.ring.drain(3, TRAP);
    assert.equal(late.dropped, 1_040);
    assert.equal(h.ring.unread, 1_040, 'every overwrite, once');
    assert.equal(h.ring.unread, h.ring.overwritten);
  });

  it('matches the union of what every scan reported missing, through many cuts — table of 400 rounds', () => {
    // A seeded walk: each round some records arrive, every sensor on the wheel scans, and then a
    // cut push may park some and bring back some parked ones, or a whole push bring back all.
    // After each round's scans, Probe Health must equal the number of distinct records some scan
    // reported as `dropped` or `undated` — counted once, and never a record nobody reported
    // missing. Sensor 5 is held across the restart and scans only at the end, so its claim from 0
    // reaches every range the ring has folded away.
    const size = 10;
    const h = ringOf(size);
    let seed = 0x2731;
    const random = (n: number): number => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed % n;
    };
    const all = [1, 2, 3, 4, 5];
    h.ring.retain(all);
    const parked = new Set<number>();
    const lost = new Set<number>();
    // `P-270`: every record some scan named as `earlier`, which the ring counts once each.
    const named = new Set<number>();
    let sent = 0;
    const note = (batch: {
      items: readonly unknown[];
      dropped: number;
      undated?: number;
      earlier?: number;
    }): void => {
      const oldest = Math.max(0, sent - size);
      for (let s = oldest - batch.dropped - (batch.undated ?? 0); s < oldest; s += 1) lost.add(s);
      // The read begins where its items and its `dropped` begin; `earlier` is just below that.
      const first = sent - batch.items.length - batch.dropped;
      for (let s = first - (batch.earlier ?? 0); s < first; s += 1) named.add(s);
    };
    for (let round = 0; round < 400; round += 1) {
      const arrivals = random(4) === 0 ? 15 + random(30) : random(8);
      for (let i = 0; i < arrivals; i += 1) {
        h.push(1);
        sent += 1;
        h.tick(random(3));
      }
      h.tick(random(40));
      for (const sensor of [1, 2, 3, 4]) {
        if (!parked.has(sensor)) note(h.ring.drain(sensor, TRAP, MINUTE));
      }
      assert.equal(h.ring.unread, lost.size, `round ${String(round)}`);
      assert.equal(h.ring.earlier, named.size, `earlier, round ${String(round)}`);
      const push = random(3);
      if (push === 0) {
        // A cut push: what its chunks named is on the wheel, a parked sensor among them coming
        // back while others stay parked; what they did not name is parked, or stays so.
        parked.clear();
        for (const sensor of [1, 2, 3, 4]) if (random(2) === 0) parked.add(sensor);
        h.ring.retain(
          all.filter((sensor) => !parked.has(sensor)),
          false,
        );
      } else if (push === 1 && parked.size > 0) {
        parked.clear();
        h.ring.retain(all, true);
      }
    }
    const late = h.ring.drain(5, TRAP);
    note(late);
    assert.equal(late.dropped, h.ring.overwritten, 'sensor 5 missed everything that left');
    assert.equal(h.ring.unread, lost.size);
    assert.equal(h.ring.unread, h.ring.overwritten, 'and each is counted once');
    assert.ok(named.size > 0, 'the walk named some records as earlier');
    assert.equal(h.ring.earlier, named.size);
  });
});

describe('what a resuming first scan kept out, counted on Probe Health once (`P-270`)', () => {
  it('counts once the records two restarted sensors both named as earlier', () => {
    const h = ringOf();
    h.ring.retain([1, 2]);
    h.push(5);
    h.tick(120);
    h.push(2);
    assert.equal(h.ring.earlier, 0, 'nothing until a scan names them');

    assert.equal(h.ring.drain(1, TRAP, MINUTE).earlier, 5);
    assert.equal(h.ring.earlier, 5);
    assert.equal(h.ring.drain(2, TRAP, MINUTE).earlier, 5);
    assert.equal(h.ring.earlier, 5, 'the same five, once');
    assert.equal(h.ring.unread, 0, 'and none of them is a loss');
    // Later scans name nothing, and the count stays.
    h.push(1);
    h.ring.drain(1, TRAP, MINUTE);
    assert.equal(h.ring.earlier, 5);
  });

  it('counts the union of what sensors with different intervals named, in either order', () => {
    // Thirty records ten seconds apart. A one-minute sensor names the 24 before its window, a
    // two-minute one the 18 before its own, and reads six the first named: those stay counted,
    // since a scan with a longer window may still read what a shorter one named.
    const run = (order: [number, number][]): { earlier: number; named: number[] } => {
      const h = ringOf();
      h.ring.retain([1, 2]);
      for (let at = 0; at < 30; at += 1) {
        h.push(1);
        h.tick(10);
      }
      const named = order.map(
        ([sensor, window]) => h.ring.drain(sensor, TRAP, window).earlier ?? 0,
      );
      return { earlier: h.ring.earlier, named };
    };
    const shortFirst = run([
      [1, MINUTE],
      [2, 2 * MINUTE],
    ]);
    assert.deepEqual(shortFirst.named, [24, 18]);
    assert.equal(shortFirst.earlier, 24);
    const longFirst = run([
      [2, 2 * MINUTE],
      [1, MINUTE],
    ]);
    assert.deepEqual(longFirst.named, [18, 24]);
    assert.equal(longFirst.earlier, 24, 'the same count whichever scans first');
  });

  it('counts what a parked sensor names on its return, apart from what the ring lost', () => {
    // Sensor 1 keeps its cursor and never scans, so what the ring overwrites is counted lost as it
    // goes; sensor 2 is parked by a cut push and names 357 on its return, as above.
    const h = ringOf(100);
    h.ring.retain([1, 2]);
    h.ring.drain(1, TRAP, MINUTE);
    h.ring.drain(2, TRAP, MINUTE);
    h.ring.retain([1], false);
    for (let at = 0; at < 360; at += 1) {
      h.push(1);
      h.tick(20);
    }
    const lost = h.ring.unread;
    assert.equal(lost, 260, 'sensor 1 was behind what the ring overwrote');
    h.ring.retain([1, 2], true);
    const back = h.ring.drain(2, TRAP, MINUTE);
    assert.equal(back.earlier, 357);
    assert.equal(h.ring.earlier, 357);
    assert.equal(h.ring.unread, lost, 'and nothing added to the loss');
  });

  it('counts nothing for a flood it cannot date, which is a loss', () => {
    // More than twice the buffer inside the window: `undated`, counted in `unread`, not here.
    const h = ringOf(10);
    h.ring.retain([1]);
    h.tick(120);
    h.push(1_000);
    const first = h.ring.drain(1, TRAP, MINUTE);
    assert.equal(first.earlier, 0);
    assert.ok((first.undated ?? 0) > 0, 'the flood is undated');
    assert.equal(h.ring.earlier, 0);
    assert.equal(h.ring.unread, h.ring.overwritten);
  });

  /**
   * Sensor 1 is parked by a cut push `episodes` times and names five each time; between the
   * episodes it reads four. Sensor 2 was held across the restart and scans only at the end, one
   * interval back from the listener's start, so it names everything before its window.
   */
  function parkedRepeatedly(episodes: number): {
    h: ReturnType<typeof ringOf>;
    named: number;
  } {
    const h = ringOf(100);
    h.ring.retain([1, 2]);
    h.ring.drain(1, TRAP, MINUTE);
    let named = 0;
    for (let episode = 0; episode < episodes; episode += 1) {
      h.ring.retain([2], false);
      h.push(5);
      h.tick(120);
      h.push(1);
      h.ring.retain([1, 2], true);
      const back = h.ring.drain(1, TRAP, MINUTE);
      assert.equal(back.earlier, 5, `episode ${String(episode)}`);
      named += 5;
      assert.equal(h.ring.earlier, named, `episode ${String(episode)}`);
      h.push(3);
      h.ring.drain(1, TRAP, MINUTE);
    }
    return { h, named };
  }

  it('counts each cut push’s apart, and a later restart scan’s from 0 as their union', () => {
    // Five episodes of nine records: 45 sent, the last four inside sensor 2's window. It names
    // the 41 before it, which include the twenty sensor 1 read between its own: the union is 41.
    const { h, named } = parkedRepeatedly(5);
    assert.equal(named, 25);
    const late = h.ring.drain(2, TRAP, MINUTE);
    assert.equal(late.earlier, 41);
    assert.equal(h.ring.earlier, 41);
  });

  /**
   * Each episode is nine records: five sensor 1 names, one inside its window, three it reads. So
   * after `n` episodes sensor 2's late scan names all but the last four, `9n - 4`, and each range
   * the ring joined takes the four records between two of sensor 1's off that count.
   */
  const lateUnion = (episodes: number): number => 9 * episodes - 4;

  it('keeps 32 ranges apart exactly: thirty-two cut pushes and a late scan count the union', () => {
    // The control for the two below: at the cap, nothing is joined and the count is exact.
    const { h, named } = parkedRepeatedly(32);
    assert.equal(named, 160);
    const late = h.ring.drain(2, TRAP, MINUTE);
    assert.equal(late.earlier, lateUnion(32));
    assert.equal(h.ring.earlier, lateUnion(32), 'every record some scan named, once');
  });

  it('joins the two lowest ranges at the thirty-third, and counts their gap as counted', () => {
    // One range past the cap: the lowest two become one, so the four records sensor 1 read
    // between them are taken as counted, and sensor 2's claim from 0 counts four fewer.
    const { h, named } = parkedRepeatedly(33);
    assert.equal(named, 165);
    const late = h.ring.drain(2, TRAP, MINUTE);
    assert.equal(late.earlier, lateUnion(33));
    assert.equal(h.ring.earlier, lateUnion(33) - 4);
  });

  it('keeps 32 ranges apart at most, and then counts less than it named, never more', () => {
    // Forty episodes: forty ranges apart, so eight joins, each taking the four records sensor 1
    // read between two of its ranges as counted. Every claim above them is still exact; sensor
    // 2's from 0 reaches the eight joined gaps and counts 32 fewer than the 356 it named.
    const { h, named } = parkedRepeatedly(40);
    assert.equal(named, 200);
    const late = h.ring.drain(2, TRAP, MINUTE);
    assert.equal(late.earlier, lateUnion(40));
    assert.equal(lateUnion(40), 356);
    assert.equal(h.ring.earlier, 356 - 8 * 4, 'less by exactly the joined gaps, never more');
  });
});

describe('a sensor new to a running probe (`P-269`)', () => {
  it('reads what arrived between its assignment and its first scan, and nothing from before', () => {
    // `P-254` started it at its first scan: what the device just added sent while the sensor
    // waited for its phase was in no reading.
    const h = ringOf();
    h.ring.retain([1, PING]);
    h.ring.drain(1, TRAP, MINUTE);
    h.push(2);
    h.tick(5);
    h.ring.retain([1, 2, PING]);
    const assigned = new Date(1_800_000_000_000 + 5_000).toISOString();
    h.tick();
    h.push(3);
    h.tick(30);

    const first = h.ring.drain(2, TRAP, MINUTE);
    assert.deepEqual(
      first.items.map((item) => item.text),
      ['trap 2', 'trap 3', 'trap 4'],
      'the three since it was assigned, not the two before',
    );
    assert.equal(first.dropped, 0);
    assert.equal(first.earlier, 0, 'what came before its assignment is not its, nor earlier');
    assert.equal(first.since, assigned, 'since its assignment');
    h.push(1);
    assert.deepEqual(texts(h.ring, 2), ['trap 5']);
    assert.equal(texts(h.ring, 1).length, 6, 'and the sensor held at the restart read all six');
    assert.equal(h.ring.earlier, 0);
  });

  it('counts what the ring overwrote after its assignment as dropped, and once on Probe Health', () => {
    const h = ringOf(4);
    h.ring.retain([PING]);
    h.push(2);
    h.ring.retain([PING, 3]);
    h.push(6);

    const first = h.ring.drain(3, TRAP, MINUTE);
    assert.deepEqual(
      first.items.map((item) => item.text),
      ['trap 4', 'trap 5', 'trap 6', 'trap 7'],
    );
    assert.equal(first.dropped, 2, 'traps 2 and 3 arrived after it was assigned and left unread');
    assert.equal(h.ring.unread, 2, 'and not traps 0 and 1, which nobody was waiting for');
    assert.equal(h.ring.drain(3, TRAP, MINUTE).dropped, 0);
    assert.equal(h.ring.unread, 2);
  });

  it('counts less on Probe Health, never more, when the ring overflowed twice over first', () => {
    // Only the last `size` overwrites are dated record by record; a new sensor's assignment is
    // not noted against the running total, so what left before those cannot be claimed.
    const h = ringOf(4);
    h.ring.retain([PING]);
    h.push(2);
    h.ring.retain([PING, 3]);
    h.push(10);

    const first = h.ring.drain(3, TRAP, MINUTE);
    assert.equal(first.items.length, 4);
    assert.equal(first.dropped, 6, 'the sensor still says all it lost');
    assert.ok(h.ring.unread <= first.dropped, `${String(h.ring.unread)} counted, more than lost`);
  });

  it('reads one interval back when its first scan comes later than that, with the rest earlier', () => {
    const h = ringOf();
    h.ring.retain([PING]);
    h.ring.retain([PING, 4]);
    h.push(2);
    h.tick(90);
    h.push(1);

    const first = h.ring.drain(4, TRAP, MINUTE);
    assert.deepEqual(
      first.items.map((item) => item.text),
      ['trap 2'],
    );
    assert.equal(first.earlier, 2);
    assert.equal(first.dropped, 0);
    assert.equal(h.ring.earlier, 2);
  });

  it('starts at its first scan when that comes before the sweep that names it', () => {
    const h = ringOf();
    h.ring.retain([1]);
    h.push(2);
    assert.deepEqual(texts(h.ring, 2), []);
  });

  it('claims no loss from before it, however much the ring overwrote', () => {
    const h = ringOf(4);
    h.ring.retain([PING]);
    h.push(10);
    h.ring.retain([PING, 3]);
    const first = h.ring.drain(3, TRAP, MINUTE);
    assert.equal(first.dropped, 0);
    assert.equal(h.ring.unread, 0, 'nothing was waiting for those ten');
  });

  it('forgets an assignment a complete push takes back', () => {
    const h = ringOf();
    h.ring.retain([PING]);
    h.ring.retain([PING, 5]);
    h.push(2);
    h.ring.retain([PING]);
    h.push(1);
    h.ring.retain([PING, 5]);
    h.push(1);
    assert.deepEqual(texts(h.ring, 5), ['trap 3'], 'from its second assignment');
  });
});

describe('a sensor whose cursor `retain` removed, back again (`P-254`)', () => {
  it('starts at its return when it had never scanned before it left', () => {
    // Paused before its first scan, so it is held across the restart and then not held at all.
    const h = ringOf();
    h.ring.retain([1, 2, PING]);
    h.ring.retain([1, PING]);
    h.push(3);
    h.ring.retain([1, 2, PING]);

    const back = h.ring.drain(2, TRAP, MINUTE);
    assert.deepEqual(back.items, [], 'what arrived while it was paused is not its');
    assert.equal(back.dropped, 0);
    assert.equal(texts(h.ring, 1).length, 3);
  });

  it('reads what arrived after its return, before its first scan back (`P-269`)', () => {
    const h = ringOf();
    h.ring.retain([1, 2, PING]);
    h.ring.drain(2, TRAP, MINUTE);
    h.ring.retain([1, PING]);
    h.push(3);
    h.ring.retain([1, 2, PING]);
    h.push(2);

    const back = h.ring.drain(2, TRAP, MINUTE);
    assert.deepEqual(
      back.items.map((item) => item.text),
      ['trap 3', 'trap 4'],
      'not the three that came while it was paused',
    );
    assert.equal(back.dropped, 0);
  });

  it('starts at its return when it had scanned before it left', () => {
    const h = ringOf(4);
    h.ring.retain([1, 2]);
    h.ring.drain(1, TRAP, MINUTE);
    h.ring.drain(2, TRAP, MINUTE);
    h.push(3);
    h.ring.retain([1]);
    assert.equal(h.ring.cursors, 1);
    h.push(4);
    h.ring.retain([1, 2]);

    const back = h.ring.drain(2, TRAP, MINUTE);
    assert.deepEqual(back.items, []);
    assert.equal(back.dropped, 0, 'three it never read left the ring, and it was not here');
    assert.equal(h.ring.unread, 3, 'sensor 1 was behind on those three, and only it');
  });
});
