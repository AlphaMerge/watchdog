import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { NotificationRing } from '../src/listeners/ring.js';

/**
 * Where a sensor's first drain starts reading (`P-254`).
 *
 * `H-15` restarted a probe, sent three traps 41 seconds later, and found them in Probe Health's
 * `trapReceived` and in neither trap sensor's `count` or `dropped`: each sensor's cursor was made at
 * its first scan, at the ring's current sequence, so what was already in the ring belonged to
 * nobody. The ring now tells apart the three reasons a sensor has no cursor, and each is here:
 * the probe restarted, the sensor is new to a running probe, and `retain` removed it.
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
  const ring = new NotificationRing(size, () => new Date(1_800_000_000_000 + clock * 1_000));
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

    // A sensor that scans every five minutes reads back to the listener's start. It lost the
    // two the first did and two before them; Probe Health counts the two it had not.
    const slow = h.ring.drain(2, TRAP, 5 * MINUTE);
    assert.equal(slow.since, h.started);
    assert.equal(slow.dropped, 4);
    assert.equal(slow.earlier, 1, 'the oldest is past what the ring remembers arriving');
    assert.equal(h.ring.unread, 4);
  });

  it('starts a window past everything known at the oldest known, in a flood', () => {
    // Ten in a buffer of four inside one interval: more than twice the buffer, so when the first
    // two arrived is no longer known. The scan still fails on the four it reports lost.
    const h = ringOf(4);
    h.ring.retain([1]);
    h.push(10);
    const first = h.ring.drain(1, TRAP, MINUTE);
    assert.equal(first.items.length, 4);
    assert.equal(first.dropped, 4);
    assert.equal(first.earlier, 2);
    assert.equal(h.ring.unread, 4);
  });

  it('carries no `earlier` on any scan but a restart’s first', () => {
    const h = ringOf();
    h.ring.retain([1]);
    h.ring.drain(1, TRAP, MINUTE);
    h.push(1);
    assert.equal('earlier' in h.ring.drain(1, TRAP, MINUTE), false);
    h.ring.retain([1, 2]);
    assert.equal('earlier' in h.ring.drain(2, TRAP, MINUTE), false, 'nor a new sensor’s first');
  });
});

describe('a sensor new to a running probe (`P-254`)', () => {
  it('starts at its first scan, with nothing and nothing dropped', () => {
    const h = ringOf();
    h.ring.retain([1, PING]);
    h.ring.drain(1, TRAP, MINUTE);
    h.push(2);
    h.ring.retain([1, 2, PING]);
    h.tick();

    const first = h.ring.drain(2, TRAP, MINUTE);
    assert.deepEqual(first.items, [], 'what came before it is not its to read');
    assert.equal(first.dropped, 0);
    assert.notEqual(first.since, h.started, 'since its first scan, not the listener’s start');
    h.push(1);
    assert.deepEqual(texts(h.ring, 2), ['trap 2']);
    assert.equal(texts(h.ring, 1).length, 3, 'and the sensor held at the restart read all three');
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
