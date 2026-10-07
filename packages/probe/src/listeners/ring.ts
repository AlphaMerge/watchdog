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
 * cursor. The ring tells four cases apart, and each is handled on purpose:
 *
 * - **The probe restarted.** The sensor was held when the listener started: it is in the first
 *   complete push the probe handed `retain`, or it drains before any was handed. Its first drain
 *   reads **one interval back** (`windowMs`), and no further back than the listener's start —
 *   what a scan an interval before this one would have left it, had there been one. A device
 *   rebooting alongside the probe sends exactly in that window, and `H-15` lost three traps there
 *   that `trapReceived` had counted.
 * - **A push was cut and took it off the wheel.** A link that drops after chunk one of a full
 *   push leaves the scheduler holding chunk one, and `retain` is told the push is incomplete. The
 *   sensors it does not name are *parked*, not forgotten: when the whole push brings them back,
 *   each reads one interval back as a restart does, from where its cursor stood.
 * - **The sensor is new to a running probe**, in a later push and not the first. It starts at its
 *   first drain, with nothing and nothing dropped. It does not read what arrived between its
 *   assignment and that scan: starting it at its assignment would need `retain` to say which held
 *   sensors are this ring's, so that the drops before a first drain could be counted on Probe
 *   Health as they happen, and it is not told.
 * - **A complete push left it out** (deleted, paused, moved away) **and it came back.** It is new
 *   again, and starts at its first drain: what arrived while the probe did not hold it is not its
 *   loss, and a sensor that never drained before it left does not claim a restart on its return.
 *
 * **Why one interval, and what happens to the rest.** A trap or syslog sensor's channels are
 * counts per scan, and a limit on them is set per interval. A probe that waited two hours for its
 * core would otherwise hand every sensor's first scan two hours of traffic as one reading, and
 * every sensor with a limit would alarm at once on the reconnect, though no interval's rate was
 * exceeded — many alarms for one outage. Nor is what came before the window `dropped`: that fails
 * the scan of every sensor that does not tolerate a loss, the same storm by another channel. It is
 * `earlier`, a count the type names in its message. What the ring overwrote *inside* the window is
 * `dropped`, as it is on any scan — and whatever the ring cannot place, it counts as `dropped`
 * too, because a loss it cannot date is still a loss.
 *
 * **The window is measured on a monotonic clock.** Arrivals, the listener's start and each
 * cursor's last drain are stamped with it; the wall clock is read only for `at`, `since` and
 * `until`. A probe that starts before time sync and has its clock stepped back an hour would
 * otherwise put every arrival outside the window and hand its first scans nothing (CLAUDE.md:
 * monotonic for scheduling, clock jumps handled explicitly).
 *
 * The ring is not told which held sensors are its own: `retain` is handed every sensor the probe
 * holds, of every type. So the first push is remembered as candidates rather than as cursors, and a
 * candidate that never drains here (a ping sensor in a trap ring) costs one number and claims
 * nothing.
 */

/** Where a sensor without a cursor resumes, if it resumes rather than starts: `P-254`. */
interface Resume {
  /** The first sequence that is this sensor's: 0 after a restart, its cursor's when parked. */
  readonly floor: number;
  /** On the monotonic clock: the listener's start after a restart, its last drain when parked. */
  readonly fromMono: number;
}

interface Cursor {
  next: number;
  /** On the monotonic clock, so `since` and the window survive a step of the wall clock. */
  sinceMono: number;
}

export class NotificationRing {
  /** Slot is `sequence % size`, so a cursor can tell it has been overtaken. */
  readonly #slots: (ReceivedNotification | undefined)[];
  /** When each record held in a slot arrived, on the monotonic clock. */
  readonly #arrived: Float64Array;
  /**
   * When each of the last `size` overwritten records arrived, at the same index as its slot, and
   * whether `unread` already counted it (`P-254`).
   *
   * A resuming sensor reads one interval back, and some of what the ring overwrote may fall inside
   * it: those are that sensor's `dropped`, the rest are `earlier`. Telling them apart needs when
   * each arrived. What is older than these `size` cannot be dated, and is `dropped`.
   */
  readonly #leftArrived: Float64Array;
  readonly #leftCounted: Uint8Array;
  readonly #now: () => Date;
  readonly #monotonic: () => number;
  readonly #cursors = new Map<number, Cursor>();
  /** When the ring was built, which is when its listener was, on the monotonic clock. */
  readonly #startedMono: number;
  /**
   * The sensors held when the listener started that have not drained here yet (`P-254`).
   *
   * `undefined` until a complete push is swept: until then the probe has not been told what it
   * holds, and every sensor that drains is one it held across the restart. After that, the first
   * complete push less every sensor that has since drained here for the first time or left.
   */
  #held: Set<number> | undefined;
  /** Sensors a cut push took off the wheel, and where each resumes (`P-254`). */
  readonly #parked = new Map<number, Resume>();
  #nextSequence = 0;
  #overwritten = 0;
  #unread = 0;
  /**
   * Overwritten records `unread` has not counted: no cursor was behind them when they left.
   *
   * A running total, so that what a resuming sensor lost is counted once on Probe Health however
   * far back it reaches, without depending on the side arrays that date the last `size`.
   */
  #uncounted = 0;
  /** The lowest sequence any cursor has yet to read. Infinity while no sensor reads this ring. */
  #slowest = Number.POSITIVE_INFINITY;

  constructor(
    size: number,
    now: () => Date = () => new Date(),
    monotonic: () => number = () => performance.now(),
  ) {
    const slots = Math.max(1, size);
    this.#slots = new Array<ReceivedNotification | undefined>(slots);
    this.#arrived = new Float64Array(slots);
    this.#leftArrived = new Float64Array(slots);
    this.#leftCounted = new Uint8Array(slots);
    this.#now = now;
    this.#monotonic = monotonic;
    this.#startedMono = monotonic();
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
      else this.#uncounted += 1;
      // Kept for a sensor that resumes later, which decides by when it arrived whether it was
      // that sensor's to lose (`P-254`).
      this.#leftArrived[slot] = this.#arrived[slot] ?? 0;
      this.#leftCounted[slot] = counted ? 1 : 0;
    }
    this.#slots[slot] = notification;
    this.#arrived[slot] = this.#monotonic();
    this.#nextSequence += 1;
  }

  /**
   * Everything this sensor has not seen, and how much it missed.
   *
   * The cursor advances to *now* whether or not anything was read, so a sensor that has fallen
   * behind catches up in one scan instead of replaying the buffer for ever.
   *
   * A first call is one of the cases in the class comment. A sensor that resumes — held across a
   * restart, or parked by a cut push — reads `windowMs` back, its interval, and no further than
   * where it resumes from, with `since` where it began reading and `earlier` what came before; any
   * other sensor registers its cursor here and is handed nothing, with `since` now, which is how
   * the type tells a sensor that has only just started listening apart from a quiet network.
   */
  drain(
    sensorId: number,
    listener: string,
    windowMs: number = Number.POSITIVE_INFINITY,
  ): ReceivedBatch {
    // Monotonic first: `since` is now less the monotonic time elapsed, so it is never after `until`.
    const nowMono = this.#monotonic();
    const now = this.#now();
    let cursor = this.#cursors.get(sensorId);
    let earlier: number | undefined;
    if (cursor === undefined) {
      const resume = this.#resumeOf(sensorId);
      if (resume === undefined) {
        // New to a running probe, or back after a complete push left it out.
        this.#cursors.set(sensorId, { next: this.#nextSequence, sinceMono: nowMono });
        this.#follow();
        return {
          listener,
          items: [],
          dropped: 0,
          since: now.toISOString(),
          until: now.toISOString(),
        };
      }
      // A window reaching back past where it resumes needs no clamp: everything from `floor` on
      // arrived after that, so the search answers `floor` and nothing is earlier.
      const from = nowMono - windowMs;
      const first = this.#firstFrom(from, resume.floor);
      earlier = first - resume.floor;
      cursor = { next: first, sinceMono: first === resume.floor ? resume.fromMono : from };
      this.#cursors.set(sensorId, cursor);
      this.#countLostFrom(first);
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

    const since = new Date(now.getTime() - Math.max(0, nowMono - cursor.sinceMono));
    cursor.next = this.#nextSequence;
    cursor.sinceMono = nowMono;
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

  /** Where a sensor with no cursor resumes from, or `undefined` if it starts now. */
  #resumeOf(sensorId: number): Resume | undefined {
    const parked = this.#parked.get(sensorId);
    if (parked !== undefined) {
      this.#parked.delete(sensorId);
      this.#held?.delete(sensorId);
      return parked;
    }
    if (this.#held === undefined || this.#held.has(sensorId)) {
      this.#held?.delete(sensorId);
      return { floor: 0, fromMono: this.#startedMono };
    }
    return undefined;
  }

  /** When the record at this sequence arrived, held or among the last `size` overwritten. */
  #arrivedAt(sequence: number): number {
    const size = this.#slots.length;
    const oldest = Math.max(0, this.#nextSequence - size);
    const at = (sequence >= oldest ? this.#arrived : this.#leftArrived)[sequence % size];
    return at ?? 0;
  }

  /**
   * The first sequence at or after `floor` that arrived at or after `from`.
   *
   * Searched over what the ring can date — what it holds, and the last `size` it overwrote — on
   * the monotonic clock, where arrivals rise with the sequence. When the oldest it can date is
   * already inside the window, the answer is `floor`: either the window reaches back past where
   * the sensor resumes, so nothing is earlier, or what lies before cannot be placed, and a loss
   * that cannot be dated is counted as `dropped`, never as `earlier`.
   */
  #firstFrom(from: number, floor: number): number {
    const size = this.#slots.length;
    const known = Math.max(floor, this.#nextSequence - 2 * size, 0);
    let low = known;
    let high = this.#nextSequence;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.#arrivedAt(middle) >= from) high = middle;
      else low = middle + 1;
    }
    return low === known ? floor : low;
  }

  /**
   * Counts on Probe Health what a resuming sensor lost and nobody had counted yet.
   *
   * Those were overwritten while no cursor was behind them, so `push` could not know a sensor was
   * waiting; this one was. Where the ring still dates the record, its flag says whether it was
   * counted, and is set; before that, the running total of uncounted overwrites is what is left to
   * count, all of it older than anything dated. `unread` stays once a record, however many sensors
   * were behind it.
   */
  #countLostFrom(first: number): void {
    const size = this.#slots.length;
    const oldest = Math.max(0, this.#nextSequence - size);
    const dated = Math.max(0, this.#nextSequence - 2 * size);
    for (let sequence = Math.max(first, dated); sequence < oldest; sequence++) {
      const slot = sequence % size;
      if (this.#leftCounted[slot] === 0) {
        this.#leftCounted[slot] = 1;
        this.#unread += 1;
        this.#uncounted -= 1;
      }
    }
    if (first < dated) {
      const undated = Math.min(dated - first, this.#uncounted);
      this.#unread += undated;
      this.#uncounted -= undated;
    }
  }

  /**
   * Keeps only the cursors for sensors the probe still holds, so a deleted one stops costing.
   *
   * `complete` says whether `sensorIds` is all the probe holds or the part of a push a dropped
   * link delivered (`P-254`). A complete push's absentees are gone. A cut push's are parked: the
   * scheduler has stopped scanning them, the whole push will bring them back, and each then
   * resumes one interval back rather than with every hour the link was down as one reading.
   *
   * The first complete push is also how the ring learns what the probe held across a restart:
   * each of those sensors without a cursor yet resumes one interval back at its first drain.
   */
  retain(sensorIds: Iterable<number>, complete = true): void {
    const keep = new Set(sensorIds);
    for (const [sensorId, cursor] of [...this.#cursors]) {
      if (keep.has(sensorId)) continue;
      this.#cursors.delete(sensorId);
      if (!complete) this.#parked.set(sensorId, { floor: cursor.next, fromMono: cursor.sinceMono });
    }
    if (complete) {
      for (const sensorId of [...this.#parked.keys()]) {
        if (!keep.has(sensorId)) this.#parked.delete(sensorId);
      }
      if (this.#held === undefined) {
        this.#held = keep;
      } else {
        for (const sensorId of [...this.#held]) {
          if (!keep.has(sensorId)) this.#held.delete(sensorId);
        }
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
   * a record no sensor was waiting for is not a record a sensor missed. What a resuming sensor
   * lost inside its first window is counted at its first drain, since only then is it known that
   * the sensor reads this ring (`P-254`).
   */
  get unread(): number {
    return this.#unread;
  }
}
