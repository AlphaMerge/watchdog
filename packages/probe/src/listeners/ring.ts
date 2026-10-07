import type { ReceivedBatch, ReceivedNotification } from '@ms/sensors';

/**
 * The buffer every listener sensor is fed from (`T-06`, extracted by `T-20`).
 *
 * **Extracted at the second caller, not the first, and not guessed at.** `P-19` says the opposite
 * about the SNMP and SSH session pools — that extracting those at two instances would have
 * guessed which half varies. The difference is that these two are not *similar*: the ring, the
 * cursor arithmetic, the drop counting and the retain sweep are byte-for-byte the same thing for
 * traps and for syslog, and what varies is entirely outside them (which socket, which filter,
 * how a message is rendered). There is nothing here to guess about.
 *
 * **Bounded, and what it loses is counted.** A device stuck in a loop sends thousands of messages
 * a second; an unbounded buffer is a probe that dies of memory exhaustion during exactly the
 * incident it was bought for. A cursor the ring has overtaken yields a *drop count* rather than a
 * quietly shorter list — CLAUDE.md's rule that backpressure is visible, never silent — and the
 * sensor turns that count into a failed check rather than an undercount.
 *
 * **Where a sensor's first scan starts reading (`P-254`).** A cursor exists from a sensor's first
 * drain, and what arrived before that drain is either the sensor's or not, by why it had no
 * cursor. The ring tells three cases apart, and each is handled on purpose:
 *
 * - **The probe restarted.** The sensor was held when the listener started — it is in the first
 *   set of sensors the probe handed `retain`, or it drains before any set was handed. Its first
 *   drain reads from the listener's start: every message still in the ring, and as `dropped`
 *   whatever the ring overwrote before then. A device rebooting alongside the probe sends exactly
 *   in that window, and `H-15` lost three traps there that `trapReceived` had counted. A probe
 *   that could not reach its core for a while after starting is the same case, for longer: what
 *   it heard meanwhile is read, and what the ring could not hold is a loss and says so.
 * - **The sensor is new to a running probe** — in a later set and not the first. It starts at its
 *   first drain, with nothing and nothing dropped. It does not read what arrived between its
 *   assignment and that scan: starting it at its assignment would need `retain` to say which held
 *   sensors are this ring's, so that the drops before a first drain could be counted on Probe
 *   Health as they happen, and it is not told.
 * - **`retain` removed its cursor** (deleted, paused, moved away) **and it came back.** It is new
 *   again, and starts at its first drain: what arrived while the probe did not hold it is not its
 *   loss, and a sensor that never drained before it left does not claim the listener's start on
 *   its return.
 *
 * The ring is not told which held sensors are its own: `retain` is handed every sensor the probe
 * holds, of every type. So the first set is remembered as candidates rather than as cursors, and a
 * candidate that never drains here (a ping sensor in a trap ring) costs one number and claims
 * nothing.
 */
export class NotificationRing {
  /** Slot is `sequence % size`, so a cursor can tell it has been overtaken. */
  readonly #slots: (ReceivedNotification | undefined)[];
  readonly #now: () => Date;
  readonly #cursors = new Map<number, { next: number; since: Date }>();
  /** When the ring was built, which is when its listener was: where a restart reads from. */
  readonly #started: Date;
  /**
   * The sensors held when the listener started that have not drained here yet (`P-254`).
   *
   * `undefined` until `retain` is first called: until then the probe has not been told what it
   * holds, and every sensor that drains is one it held across the restart. After that, the first
   * set less every sensor that has since drained here for the first time or left. A sensor that
   * already has a cursor never looks here, so the first set is taken whole.
   */
  #held: Set<number> | undefined;
  /**
   * Records overwritten while no cursor was behind them (`P-254`).
   *
   * Not `unread`: nobody with a cursor was waiting for them. But a sensor held at the restart that
   * has not drained yet reads from sequence 0, so it was behind every one of them, and the first
   * such drain moves this into `unread` — once a record, as `unread` always counts.
   */
  #unclaimed = 0;
  #nextSequence = 0;
  #overwritten = 0;
  #unread = 0;
  /** The lowest sequence any cursor has yet to read. Infinity while no sensor reads this ring. */
  #slowest = Number.POSITIVE_INFINITY;

  constructor(size: number, now: () => Date = () => new Date()) {
    this.#slots = new Array<ReceivedNotification | undefined>(Math.max(1, size));
    this.#now = now;
    this.#started = now();
  }

  push(notification: ReceivedNotification): void {
    const size = this.#slots.length;
    const slot = this.#nextSequence % size;
    if (this.#slots[slot] !== undefined) {
      this.#overwritten += 1;
      // The record leaving is the one `size` behind this. Some sensor had yet to read it when
      // its cursor is at or before it, and that sensor's next drain will say so as `dropped`.
      if (this.#slowest <= this.#nextSequence - size) this.#unread += 1;
      // No cursor was. A sensor held at the restart that has not drained yet would read from
      // sequence 0, so it was behind this one; whether there is such a sensor is known only when
      // it drains, and if none ever does this is never claimed.
      else this.#unclaimed += 1;
    }
    this.#slots[slot] = notification;
    this.#nextSequence += 1;
  }

  /**
   * Everything this sensor has not seen, and how much it missed.
   *
   * The cursor advances to *now* whether or not anything was read, so a sensor that has fallen
   * behind catches up in one scan instead of replaying the buffer for ever.
   *
   * A first call is one of the three cases in the class comment. A sensor the probe held when the
   * listener started reads from that start, with `since` the listener's start; any other sensor
   * registers its cursor here and is handed nothing, with `since` now, which is how the type
   * tells a sensor that has only just started listening apart from a quiet network.
   */
  drain(sensorId: number, listener: string): ReceivedBatch {
    const now = this.#now();
    let cursor = this.#cursors.get(sensorId);
    if (cursor === undefined) {
      if (this.#held !== undefined && !this.#held.has(sensorId)) {
        // New to a running probe, or back after `retain` removed it.
        this.#cursors.set(sensorId, { next: this.#nextSequence, since: now });
        this.#follow();
        return {
          listener,
          items: [],
          dropped: 0,
          since: now.toISOString(),
          until: now.toISOString(),
        };
      }
      // Held across the restart: it reads from the listener's start, and everything the ring
      // overwrote before now with no cursor behind it was this sensor's to lose.
      this.#held?.delete(sensorId);
      cursor = { next: 0, since: this.#started };
      this.#cursors.set(sensorId, cursor);
      this.#unread += this.#unclaimed;
      this.#unclaimed = 0;
    }

    const size = this.#slots.length;
    const oldest = Math.max(0, this.#nextSequence - size);
    // Whatever sat between this cursor and the oldest sequence still held has been overwritten.
    const dropped = Math.max(0, oldest - cursor.next);

    const items: ReceivedNotification[] = [];
    for (let sequence = Math.max(cursor.next, oldest); sequence < this.#nextSequence; sequence++) {
      const item = this.#slots[sequence % size];
      if (item !== undefined) items.push(item);
    }

    const since = cursor.since;
    cursor.next = this.#nextSequence;
    cursor.since = now;
    this.#follow();
    return { listener, items, dropped, since: since.toISOString(), until: now.toISOString() };
  }

  /**
   * Keeps only the cursors for sensors the probe still holds, so a deleted one stops costing.
   *
   * The first call is also how the ring learns what the probe held across a restart (`P-254`):
   * each of those sensors without a cursor yet will read from the listener's start. A sensor that
   * leaves stops being one of them, so it returns as new.
   */
  retain(sensorIds: Iterable<number>): void {
    const keep = new Set(sensorIds);
    for (const sensorId of [...this.#cursors.keys()]) {
      if (!keep.has(sensorId)) this.#cursors.delete(sensorId);
    }
    if (this.#held === undefined) {
      this.#held = keep;
    } else {
      for (const sensorId of [...this.#held]) {
        if (!keep.has(sensorId)) this.#held.delete(sensorId);
      }
    }
    this.#follow();
  }

  /** Finds the slowest cursor again, whenever one moved, arrived or left: never on a push. */
  #follow(): void {
    let slowest = Number.POSITIVE_INFINITY;
    for (const cursor of this.#cursors.values()) slowest = Math.min(slowest, cursor.next);
    this.#slowest = slowest;
  }

  get buffered(): number {
    return Math.min(this.#nextSequence, this.#slots.length);
  }

  get cursors(): number {
    return this.#cursors.size;
  }

  /**
   * Every record that left the ring to make room, read or not.
   *
   * On a ring that has filled once this rises with every push, because a full ring holding only
   * records every sensor has read still gives up its oldest for the next. It says how much has
   * passed through, and nothing about loss; `unread` is the count of what was lost.
   */
  get overwritten(): number {
    return this.#overwritten;
  }

  /**
   * Records overwritten while at least one sensor had yet to read them.
   *
   * Counted once a record, however many sensors were behind it, and equal to the `dropped` the
   * slowest sensor's next drain reports. A ring nobody reads loses nothing and counts nothing:
   * a record no sensor was waiting for is not a record a sensor missed. What a sensor held across
   * a restart lost before its first drain is counted at that drain, since only then is it known
   * that the sensor reads this ring (`P-254`).
   */
  get unread(): number {
    return this.#unread;
  }
}
