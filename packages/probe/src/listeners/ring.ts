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
 * - **The sensor is new to a running probe**, in a later push and not the first (`P-269`). It
 *   resumes from **its assignment**: where the ring stood when a push first named it. Its first
 *   scan reads what the listener heard from then on — the device an operator has just added is
 *   often the one sending — and what the ring overwrote of that is its `dropped`. A first scan
 *   comes within an interval of the assignment, so this is never further back than a restart
 *   reads; one that came later still reads one interval back, with the rest `earlier`. What
 *   arrived before the assignment is not its: not read, not `earlier`, not a loss.
 * - **A complete push left it out** (deleted, paused, moved away) **and it came back.** It is new
 *   again, and resumes from its return: what arrived while the probe did not hold it is not its
 *   loss, and a sensor that never drained before it left does not claim a restart on its return.
 *
 * A new sensor's loss before its first scan is counted on Probe Health at that scan, as a
 * restart's is, by claiming it from the running total of uncounted overwrites (`P-273`). Only the
 * last `size` overwrites are dated record by record, so if the ring overwrote more than twice its
 * size between the assignment and the first scan, the part beyond that is counted by none: an
 * undercount, never more. The assignment is not noted record by record as a parked sensor's resume
 * point is, because `retain` names every sensor of every type: a ping sensor assigned here would
 * never drain, and would keep the claimed ranges from ever being folded away.
 *
 * **Why one interval, and what happens to the rest.** A trap or syslog sensor's channels are
 * counts per scan, and a limit on them is set per interval. A probe that waited two hours for its
 * core would otherwise hand every sensor's first scan two hours of traffic as one reading, and
 * every sensor with a limit would alarm at once on the reconnect, though no interval's rate was
 * exceeded — many alarms for one outage. Nor is what came before the window `dropped`: that fails
 * the scan of every sensor that does not tolerate a loss, the same storm by another channel. It is
 * `earlier`, a count the type names in its message and Probe Health counts apart from every loss,
 * once a record (`P-270`). What the ring overwrote *inside* the window is
 * `dropped`, as it is on any scan. What it overwrote before it could tell when it arrived is
 * `undated`: the type names it too, and Probe Health counts it as a loss, because a loss it
 * cannot date is still a loss — but not as this scan's, which would be the outage as one reading
 * on the Missed channel.
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
  /**
   * How many overwrites no cursor was behind had happened to records before `floor` (`P-273`):
   * where this sensor's share of that running total begins. 0 after a restart. When parked, set
   * by `push` as the ring overwrites the record just before `floor`, or at once if it already has;
   * `undefined` until then.
   */
  uncountedBefore: number | undefined;
}

/** Where a resuming sensor's first read begins, and how what precedes it is reported. */
interface Placed {
  /** The first sequence read, or counted `dropped` if the ring overwrote it. */
  readonly first: number;
  /** Before the window, known by when it arrived. */
  readonly earlier: number;
  /** Overwritten before the ring could tell when it arrived; just before `first`. */
  readonly undated: number;
  readonly sinceMono: number;
}

/**
 * How many disjoint ranges of `earlier` sequences the ring keeps apart (`P-270`). Past this the
 * lowest two are joined, the gap between them taken as counted: a later claim reaching into that
 * gap then counts less than it named, never more. Ranges are apart only across separate cut
 * pushes, so a probe meets this after 32 of them on one listener, and only a sensor resuming from
 * before all of them could reach the gap.
 */
const MAX_EARLIER_RANGES = 32;

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
   * whether a cursor was behind it when it left (`P-254`).
   *
   * A resuming sensor reads one interval back, and some of what the ring overwrote may fall inside
   * it: those are that sensor's `dropped`, the rest are `earlier`. Telling them apart needs when
   * each arrived. What is older than these `size` cannot be dated, and is `undated`. The flag is
   * never changed after the push that sets it: it says where in the running total of uncounted
   * overwrites a sequence inside these `size` falls (`P-273`).
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
  /**
   * Sensors a push named after the first complete one, with no cursor yet, and where each resumes:
   * the ring as it stood when it was named (`P-269`). `uncountedBefore` is left unset, and these
   * are not parked: see the class comment.
   */
  readonly #assigned = new Map<number, Resume>();
  /** Parked sensors whose `uncountedBefore` waits for the ring to reach `floor`, lowest first. */
  #awaiting: Resume[] = [];
  #nextSequence = 0;
  #overwritten = 0;
  #unread = 0;
  /**
   * Every record that left with no cursor behind it, since the listener started: `unread` did not
   * count it then. It only rises.
   *
   * Records leave in sequence order, so the uncounted ones are numbered by this total as they go,
   * and the ones from any sequence on are a range of those numbers: from the total as it stood
   * when that sequence was about to leave, to the total now. A resuming sensor claims the range
   * from where it resumes, and `#claimed` keeps what has been claimed, so a record two sensors
   * were waiting for is counted once whichever resumes first, and a record no resuming sensor was
   * waiting for — read by every cursor before it left — is counted by none (`P-273`). A single
   * count drawn down by each claim could not tell those apart: it handed a parked sensor records
   * below its own position.
   */
  #uncounted = 0;
  /** Claimed ranges of that numbering, disjoint and in order, as `[from, to)` (`P-273`). */
  #claimed: [number, number][] = [];
  /** How many claimed numbers `#claimed` no longer lists: all below every claim still to come. */
  #claimedPruned = 0;
  /** Where the ranges folded into `#claimedPruned` begin and end. */
  #prunedFrom = 0;
  #prunedTo = 0;
  /**
   * Every record some resuming sensor's first scan named as `earlier`, since the listener started,
   * once a record (`P-270`). Kept as sequence ranges, disjoint and in order, as `[from, to)`, so a
   * record two sensors both named is counted by the first.
   */
  #earlierRanges: [number, number][] = [];
  #earlier = 0;
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
      // A parked sensor's share of the uncounted total starts here once its floor's predecessor
      // has left (`P-273`). Nothing to check while no sensor is parked.
      const left = this.#nextSequence - size;
      for (let next = this.#awaiting[0]; next !== undefined && next.floor <= left + 1;) {
        next.uncountedBefore = this.#uncounted;
        this.#awaiting.shift();
        next = this.#awaiting[0];
      }
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
   * restart, parked by a cut push, or assigned by a later push (`P-269`) — reads `windowMs` back,
   * its interval, and no further than where it resumes from, with `since` where it began reading
   * and `earlier` what came before. A sensor no push has named registers its cursor here and is
   * handed nothing, with `since` now.
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
    let resumed: Placed | undefined;
    if (cursor === undefined) {
      const resume = this.#resumeOf(sensorId);
      if (resume === undefined) {
        // A sensor no push has named since the restart set: it scans before the push that names
        // it reaches the ring, which the scheduler does not do. It starts here.
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
      resumed = this.#place(resume, nowMono - windowMs);
      cursor = { next: resumed.first, sinceMono: resumed.sinceMono };
      this.#cursors.set(sensorId, cursor);
      // Everything this sensor lost from where it resumes, dated or not, is a loss on Probe Health.
      this.#countLostFrom(resumed.first - resumed.undated, resume);
      // What it left out before its window is not, and is counted apart (`P-270`).
      this.#countEarlier(resume.floor, resume.floor + resumed.earlier);
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
      ...(resumed === undefined
        ? {}
        : {
            earlier: resumed.earlier,
            ...(resumed.undated === 0 ? {} : { undated: resumed.undated }),
          }),
    };
  }

  /**
   * Where a resuming sensor's read begins, given the window opens at `from` (`P-254`).
   *
   * Three answers, and `since` is the window's true start in each:
   *
   * - **The window reaches back past where it resumes.** Everything from `floor` on arrived inside
   *   it: nothing is earlier, and whatever the ring overwrote is `dropped`.
   * - **The ring can date the boundary.** It is the first record at or after `from`; what came
   *   before it is `earlier`. That includes the boundary being `floor` itself — a ring quiet from
   *   the resume point until inside the window — where `since` is still `from`, not the resume
   *   point hours back.
   * - **It cannot.** The oldest record it can date is already inside the window, and what is
   *   older left the ring before anything recorded when it arrived. The read begins at that
   *   oldest dated record, and what the ring overwrote from there is `dropped`: at most a buffer,
   *   all of it inside the window. What is older is `undated` — neither read nor this scan's
   *   loss, since it may have arrived hours before the window — and Probe Health counts it as a
   *   loss, once, because some sensor was waiting for it. Counting it as `dropped` instead put
   *   the whole outage on a Missed channel, several intervals as one reading again.
   */
  #place(resume: Resume, from: number): Placed {
    if (from <= resume.fromMono) {
      return { first: resume.floor, earlier: 0, undated: 0, sinceMono: resume.fromMono };
    }
    const size = this.#slots.length;
    const known = Math.max(resume.floor, this.#nextSequence - 2 * size, 0);
    let low = known;
    let high = this.#nextSequence;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.#arrivedAt(middle) >= from) high = middle;
      else low = middle + 1;
    }
    if (low === known && known > resume.floor) {
      return { first: known, earlier: 0, undated: known - resume.floor, sinceMono: from };
    }
    return { first: low, earlier: low - resume.floor, undated: 0, sinceMono: from };
  }

  /** Where a sensor with no cursor resumes from, or `undefined` if it starts now. */
  #resumeOf(sensorId: number): Resume | undefined {
    const parked = this.#parked.get(sensorId);
    if (parked !== undefined) {
      this.#unpark(sensorId);
      this.#held?.delete(sensorId);
      return parked;
    }
    const assigned = this.#assigned.get(sensorId);
    if (assigned !== undefined) {
      this.#assigned.delete(sensorId);
      return assigned;
    }
    if (this.#held === undefined || this.#held.has(sensorId)) {
      this.#held?.delete(sensorId);
      return { floor: 0, fromMono: this.#startedMono, uncountedBefore: 0 };
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
   * Counts on Probe Health what a resuming sensor lost and nobody had counted yet.
   *
   * Those were overwritten while no cursor was behind them, so `push` could not know a sensor was
   * waiting; this one was, for every record from `start` on — what it reports as `dropped` or
   * `undated`. It claims their numbers in the running total of uncounted overwrites, and what an
   * earlier claim took is not counted again, so `unread` stays once a record however many sensors
   * were behind it. A record below `start` is not this sensor's, whoever else counted it: a parked
   * sensor had read it, and one it reports as `earlier` is not a loss (`P-273`).
   */
  #countLostFrom(start: number, resume: Resume): void {
    this.#unread += this.#claim(this.#uncountedBefore(start, resume));
  }

  /**
   * Counts on Probe Health the records from `from` to `to` that a resuming sensor named as
   * `earlier`, less those an earlier claim already counted (`P-270`).
   *
   * `#place` puts a resuming sensor's `earlier` just below where its read begins and from where it
   * resumes, so it is always one range. Whether another sensor read some of it does not change the
   * count: this is what a restart or a cut push kept out of some sensor's reading, as `unread` is
   * what some sensor lost, and a sensor whose interval is longer may still read a record a shorter
   * one named as earlier, so "out of every reading" could not be known when the scan is counted.
   */
  #countEarlier(from: number, to: number): void {
    if (to <= from) return;
    let fresh = to - from;
    let low = from;
    let high = to;
    const kept: [number, number][] = [];
    for (const range of this.#earlierRanges) {
      const [start, end] = range;
      // Apart, and not touching: kept as it is. Touching ranges are joined.
      if (end < from || start > to) {
        kept.push(range);
        continue;
      }
      fresh -= Math.max(0, Math.min(end, to) - Math.max(start, from));
      low = Math.min(low, start);
      high = Math.max(high, end);
    }
    kept.push([low, high]);
    kept.sort((a, b) => a[0] - b[0]);
    while (kept.length > MAX_EARLIER_RANGES) {
      const [first, second] = kept;
      if (first === undefined || second === undefined) break;
      kept.splice(0, 2, [first[0], second[1]]);
    }
    this.#earlierRanges = kept;
    this.#earlier += fresh;
  }

  /**
   * The uncounted total as it stood when the record at `sequence` was about to leave: the number
   * its share of that total starts at (`P-273`).
   *
   * Inside the last `size` overwritten, the flags count back from the total now. Below them the
   * ring keeps nothing per record, and only the resume point is ever asked for there — a
   * restart's 0, or the number `push` noted for a parked sensor as the ring reached its floor.
   */
  #uncountedBefore(sequence: number, resume: Resume): number {
    const size = this.#slots.length;
    const oldest = Math.max(0, this.#nextSequence - size);
    const dated = Math.max(0, this.#nextSequence - 2 * size);
    if (sequence < dated) {
      // `#place` starts a read below `dated` only at the resume point, which `push` has passed.
      // Were the number ever not noted, the total now claims nothing: an undercount, never more.
      return resume.uncountedBefore ?? this.#uncounted;
    }
    let before = this.#uncounted;
    for (let left = sequence; left < oldest; left++) {
      if (this.#leftCounted[left % size] === 0) before -= 1;
    }
    return before;
  }

  /**
   * Claims the uncounted overwrites numbered from `from` to the total now, and says how many of
   * them no earlier claim had (`P-273`).
   */
  #claim(from: number): number {
    const to = this.#uncounted;
    if (from >= to) return 0;
    let fresh = to - from;
    let start = from;
    if (this.#claimedPruned > 0 && from < this.#prunedTo) {
      // Only a claim from below everything folded away reaches it — a restart's, from 0 — and
      // that covers all of it.
      fresh -= this.#claimedPruned;
      start = Math.min(start, this.#prunedFrom);
      this.#claimedPruned = 0;
    }
    const kept: [number, number][] = [];
    for (const range of this.#claimed) {
      const [low, high] = range;
      if (high < from) {
        kept.push(range);
        continue;
      }
      fresh -= high - Math.max(low, from);
      start = Math.min(start, low);
    }
    kept.push([start, to]);
    this.#claimed = kept;
    this.#prune();
    return fresh;
  }

  /**
   * Folds into one count the claimed ranges no later claim can reach, so `#claimed` stays a few
   * ranges however long the listener runs (`P-273`).
   *
   * A later claim starts at 0 (a restart's, which reaches everything and needs only the count), at
   * a parked sensor's noted number, at one `push` has yet to note (at least the total now), or
   * inside the last `size` overwritten (at least the total now less `size`).
   */
  #prune(): void {
    let reach = this.#uncounted - this.#slots.length;
    for (const parked of this.#parked.values()) {
      if (parked.uncountedBefore !== undefined) reach = Math.min(reach, parked.uncountedBefore);
    }
    for (let range = this.#claimed[0]; range !== undefined && range[1] <= reach;) {
      this.#claimed.shift();
      if (this.#claimedPruned === 0) this.#prunedFrom = range[0];
      this.#claimedPruned += range[1] - range[0];
      this.#prunedTo = range[1];
      range = this.#claimed[0];
    }
  }

  /** Parks a sensor where its cursor stood (`P-254`), noting where its share of the total begins. */
  #park(sensorId: number, cursor: Cursor): void {
    const oldest = Math.max(0, this.#nextSequence - this.#slots.length);
    // When the ring has overwritten up to its cursor already, what it overwrote from the cursor on
    // went while this cursor was behind it and was counted then, so its share begins at the total
    // now. Otherwise `push` notes it when the record just before its cursor leaves: until then
    // what the ring overwrites is what this sensor had read.
    const resume: Resume = {
      floor: cursor.next,
      fromMono: cursor.sinceMono,
      uncountedBefore: cursor.next <= oldest ? this.#uncounted : undefined,
    };
    this.#parked.set(sensorId, resume);
    if (resume.uncountedBefore === undefined) {
      this.#awaiting.push(resume);
      this.#awaiting.sort((a, b) => a.floor - b.floor);
    }
  }

  /** Forgets a parked sensor, and the number `push` was to note for it. */
  #unpark(sensorId: number): void {
    const parked = this.#parked.get(sensorId);
    if (parked === undefined) return;
    this.#parked.delete(sensorId);
    this.#awaiting = this.#awaiting.filter((resume) => resume !== parked);
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
      if (!complete) this.#park(sensorId, cursor);
    }
    if (complete) {
      for (const sensorId of [...this.#parked.keys()]) {
        if (!keep.has(sensorId)) this.#unpark(sensorId);
      }
      for (const sensorId of [...this.#assigned.keys()]) {
        if (!keep.has(sensorId)) this.#assigned.delete(sensorId);
      }
    }
    // A sensor named for the first time since the restart set was taken resumes from here
    // (`P-269`). Before that set, every sensor is a restart candidate, so none is new; a cut push's
    // sensors are being scanned, so they are assigned as a complete push's are.
    if (this.#held !== undefined) {
      const fromMono = this.#monotonic();
      for (const sensorId of keep) {
        if (
          this.#cursors.has(sensorId) ||
          this.#parked.has(sensorId) ||
          this.#held.has(sensorId) ||
          this.#assigned.has(sensorId)
        ) {
          continue;
        }
        this.#assigned.set(sensorId, {
          floor: this.#nextSequence,
          fromMono,
          uncountedBefore: undefined,
        });
      }
    }
    if (complete) {
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
   * Counted once a record, however many sensors were behind it: when it leaves, if a cursor stood
   * at or before it; otherwise at the first drain of a sensor that resumes from at or before it
   * and reports it as `dropped` or `undated` — only then is it known that the sensor reads this
   * ring (`P-254`). So with one sensor reading the ring this is the sum of what it reported
   * `dropped` and `undated`; with several, a record each of them missed is in it once. A record no
   * sensor was waiting for is not counted — one every cursor and every parked sensor had read, or
   * one a resuming sensor reports as `earlier` — and a ring nobody reads counts nothing (`P-273`).
   */
  get unread(): number {
    return this.#unread;
  }

  /**
   * Records a sensor's first scan after a probe restart, or after a cut push took it off the
   * scheduler, named as `earlier`: they arrived before its window, which reaches one interval
   * back, so that scan neither read them nor counted them as `dropped` (`P-254`, `P-270`).
   *
   * Counted at that scan, once a record however many sensors named it, and never taken back. Not
   * a loss and not in `unread`: what the ring overwrote before it could tell when it arrived is
   * `undated`, which is a loss and is counted there. A record one sensor named and another read,
   * or lost, is counted here and in that sensor's reading or in `unread`, as a record one sensor
   * read and another lost is in both.
   */
  get earlier(): number {
    return this.#earlier;
  }
}
