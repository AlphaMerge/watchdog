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
 */
export class NotificationRing {
  /** Slot is `sequence % size`, so a cursor can tell it has been overtaken. */
  readonly #slots: (ReceivedNotification | undefined)[];
  readonly #now: () => Date;
  readonly #cursors = new Map<number, { next: number; since: Date }>();
  #nextSequence = 0;
  #overwritten = 0;
  #unread = 0;
  /** The lowest sequence any cursor has yet to read. Infinity while no sensor reads this ring. */
  #slowest = Number.POSITIVE_INFINITY;

  constructor(size: number, now: () => Date = () => new Date()) {
    this.#slots = new Array<ReceivedNotification | undefined>(Math.max(1, size));
    this.#now = now;
  }

  push(notification: ReceivedNotification): void {
    const size = this.#slots.length;
    const slot = this.#nextSequence % size;
    if (this.#slots[slot] !== undefined) {
      this.#overwritten += 1;
      // The record leaving is the one `size` behind this. Some sensor had yet to read it when
      // its cursor is at or before it, and that sensor's next drain will say so as `dropped`.
      if (this.#slowest <= this.#nextSequence - size) this.#unread += 1;
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
   * A first call registers the cursor and returns nothing. That is the honest answer rather than
   * a convenience: a sensor's first scan after a probe restart has genuinely received nothing,
   * and `since` is how the type tells that apart from a quiet network.
   */
  drain(sensorId: number, listener: string): ReceivedBatch {
    const now = this.#now();
    const cursor = this.#cursors.get(sensorId);
    if (cursor === undefined) {
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

  /** Keeps only the cursors for sensors the probe still holds, so a deleted one stops costing. */
  retain(sensorIds: Iterable<number>): void {
    const keep = new Set(sensorIds);
    for (const sensorId of [...this.#cursors.keys()]) {
      if (!keep.has(sensorId)) this.#cursors.delete(sensorId);
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
   * a record no sensor was waiting for is not a record a sensor missed.
   */
  get unread(): number {
    return this.#unread;
  }
}
