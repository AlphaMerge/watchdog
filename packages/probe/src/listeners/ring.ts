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
 * - **The probe restarted.** The sensor was held when the listener started: it is in the first
 *   complete push the probe handed `retain`, or it drains before any was handed. Its first drain
 *   reads **one interval back** (`windowMs`), and no further back than the listener's start —
 *   what a scan an interval before this one would have left it, had there been one. A device
 *   rebooting alongside the probe sends exactly in that window, and `H-15` lost three traps there
 *   that `trapReceived` had counted. What the ring overwrote inside the window is `dropped`.
 * - **The sensor is new to a running probe**, in a later push and not the first. It starts at its
 *   first drain, with nothing and nothing dropped. It does not read what arrived between its
 *   assignment and that scan: starting it at its assignment would need `retain` to say which held
 *   sensors are this ring's, so that the drops before a first drain could be counted on Probe
 *   Health as they happen, and it is not told.
 * - **`retain` removed its cursor** (deleted, paused, moved away) **and it came back.** It is new
 *   again, and starts at its first drain: what arrived while the probe did not hold it is not its
 *   loss, and a sensor that never drained before it left does not claim a restart on its return.
 *
 * **Why one interval and not the listener's start.** A trap or syslog sensor's channels are
 * counts per scan, and a limit on them is set per interval. A probe that started and could not
 * reach its core for two hours would otherwise hand every sensor's first scan two hours of
 * traffic as one reading, and every sensor with a limit would alarm at once on the reconnect,
 * though no interval's rate was exceeded — many alarms for one outage. Nor is the part before the
 * window `dropped`: that fails the scan of every sensor that does not tolerate a loss, which is
 * the same storm by another channel. It is `earlier`, a count the type names in its message: the
 * listener received it and counted it, and no scan of this sensor was there to cover it.
 *
 * The ring is not told which held sensors are its own: `retain` is handed every sensor the probe
 * holds, of every type. So the first push is remembered as candidates rather than as cursors, and a
 * candidate that never drains here (a ping sensor in a trap ring) costs one number and claims
 * nothing.
 */
export class NotificationRing {
  /** Slot is `sequence % size`, so a cursor can tell it has been overtaken. */
  readonly #slots: (ReceivedNotification | undefined)[];
  /** When each record held in a slot arrived, in epoch milliseconds, read once at its push. */
  readonly #arrived: Float64Array;
  /**
   * When each of the last `size` overwritten records arrived, at the same index as its slot, and
   * whether `unread` already counted it (`P-254`).
   *
   * A restart reads one interval back, and some of what the ring overwrote may fall inside it:
   * those are that sensor's `dropped`, the rest are `earlier`. Telling them apart needs when each
   * arrived, and counting the dropped ones on Probe Health once needs to know which are counted.
   */
  readonly #leftArrived: Float64Array;
  readonly #leftCounted: Uint8Array;
  readonly #now: () => Date;
  readonly #cursors = new Map<number, { next: number; since: Date }>();
  /** When the ring was built, which is when its listener was: no restart reads before this. */
  readonly #started: Date;
  /**
   * The sensors held when the listener started that have not drained here yet (`P-254`).
   *
   * `undefined` until `retain` is first called, and `retain` is called only once a push is
   * complete: until then the probe has not been told what it holds, and every sensor that drains
   * is one it held across the restart. After that, the first push less every sensor that has
   * since drained here for the first time or left. A sensor that already has a cursor never looks
   * here, so the first push is taken whole.
   */
  #held: Set<number> | undefined;
  #nextSequence = 0;
  #overwritten = 0;
  #unread = 0;
  /** The lowest sequence any cursor has yet to read. Infinity while no sensor reads this ring. */
  #slowest = Number.POSITIVE_INFINITY;

  constructor(size: number, now: () => Date = () => new Date()) {
    const slots = Math.max(1, size);
    this.#slots = new Array<ReceivedNotification | undefined>(slots);
    this.#arrived = new Float64Array(slots);
    this.#leftArrived = new Float64Array(slots);
    this.#leftCounted = new Uint8Array(slots);
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
      const counted = this.#slowest <= this.#nextSequence - size;
      if (counted) this.#unread += 1;
      // Kept for a restart that has not drained yet, which decides by when it arrived whether
      // it was that sensor's to lose (`P-254`).
      this.#leftArrived[slot] = this.#arrived[slot] ?? 0;
      this.#leftCounted[slot] = counted ? 1 : 0;
    }
    this.#slots[slot] = notification;
    this.#arrived[slot] = Date.parse(notification.at);
    this.#nextSequence += 1;
  }

  /**
   * Everything this sensor has not seen, and how much it missed.
   *
   * The cursor advances to *now* whether or not anything was read, so a sensor that has fallen
   * behind catches up in one scan instead of replaying the buffer for ever.
   *
   * A first call is one of the three cases in the class comment. A sensor the probe held when the
   * listener started reads `windowMs` back — its interval — and no further than the listener's
   * start, with `since` where it began reading and `earlier` what arrived before that; any other
   * sensor registers its cursor here and is handed nothing, with `since` now, which is how the
   * type tells a sensor that has only just started listening apart from a quiet network.
   */
  drain(
    sensorId: number,
    listener: string,
    windowMs: number = Number.POSITIVE_INFINITY,
  ): ReceivedBatch {
    const now = this.#now();
    let cursor = this.#cursors.get(sensorId);
    let earlier: number | undefined;
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
      // Held across the restart: it reads one interval back, as a scan an interval ago would
      // have left it.
      this.#held?.delete(sensorId);
      const from = Math.max(this.#started.getTime(), now.getTime() - windowMs);
      const first = this.#firstArrivedAtOrAfter(from);
      earlier = first;
      cursor = { next: first, since: new Date(from) };
      this.#cursors.set(sensorId, cursor);
      this.#countLeftFrom(first);
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
    return {
      listener,
      items,
      dropped,
      since: since.toISOString(),
      until: now.toISOString(),
      ...(earlier === undefined ? {} : { earlier }),
    };
  }

  /** When the record at this sequence arrived, held or among the last `size` overwritten. */
  #arrivedAt(sequence: number): number {
    const size = this.#slots.length;
    const oldest = Math.max(0, this.#nextSequence - size);
    const at = (sequence >= oldest ? this.#arrived : this.#leftArrived)[sequence % size];
    return at ?? 0;
  }

  /**
   * The first sequence that arrived at or after `from`: where a restart begins reading.
   *
   * Searched over what the ring still knows the arrival of — what it holds, and the last `size`
   * it overwrote. Arrivals rise with the sequence, since each is the listener's clock at its push;
   * a clock stepped backwards misplaces the boundary by what arrived across the step, and nothing
   * worse. A window that reaches past everything known — a flood of more than twice the buffer
   * within one interval — begins at the oldest known: the scan still fails on the buffer's worth
   * it reports dropped, and what is older is `earlier`.
   */
  #firstArrivedAtOrAfter(from: number): number {
    const size = this.#slots.length;
    let low = Math.max(0, this.#nextSequence - 2 * size);
    let high = this.#nextSequence;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.#arrivedAt(middle) >= from) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  /**
   * Counts on Probe Health what a restart lost inside its window and nobody had counted yet.
   *
   * Those were overwritten while no cursor was behind them, so `push` could not know any sensor
   * was waiting; this one was. Marked as counted, so a second restart that lost the same records
   * does not count them again: `unread` is once a record, however many sensors were behind it.
   */
  #countLeftFrom(first: number): void {
    const size = this.#slots.length;
    const oldest = Math.max(0, this.#nextSequence - size);
    for (let sequence = first; sequence < oldest; sequence++) {
      const slot = sequence % size;
      if (this.#leftCounted[slot] === 0) {
        this.#leftCounted[slot] = 1;
        this.#unread += 1;
      }
    }
  }

  /**
   * Keeps only the cursors for sensors the probe still holds, so a deleted one stops costing.
   *
   * The first call is also how the ring learns what the probe held across a restart (`P-254`):
   * each of those sensors without a cursor yet will read one interval back at its first drain. A
   * sensor that leaves stops being one of them, so it returns as new. The caller sweeps only once
   * a push is complete (`core-handlers.ts`): the first set must be the whole of what the probe
   * holds, or a sensor in a chunk a dropped link never delivered would return as new.
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
   * a restart lost inside its first window is counted at its first drain, since only then is it
   * known that the sensor reads this ring (`P-254`).
   */
  get unread(): number {
    return this.#unread;
  }
}
