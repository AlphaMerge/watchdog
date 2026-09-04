import type { Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import type { ObjectId } from '../objects/types.js';
import type { SensorState, SensorStateCause } from './tables.js';

/** One committed state change, as a subscriber receives it. */
export interface StateEvent {
  /** Monotonic within a process. A gap means this subscriber missed something. */
  readonly seq: number;
  readonly sensorId: ObjectId;
  readonly sensorName: string;
  /**
   * Root first, sensor last.
   *
   * Not overhead: it is how a subscription scoped to a subtree is matched without a query per
   * event, and it is also what a tree needs in order to roll a colour up to the ancestor an
   * operator is actually looking at.
   */
  readonly path: readonly ObjectId[];
  readonly state: SensorState;
  readonly previousState: SensorState | null;
  readonly cause: SensorStateCause;
  readonly message: string;
  readonly at: string;
}

/** One sensor's state as it stands, which is what a subscriber is handed on connect. */
export interface StateSnapshotEntry {
  readonly sensorId: ObjectId;
  readonly sensorName: string;
  readonly path: readonly ObjectId[];
  readonly state: SensorState;
  readonly cause: SensorStateCause;
  readonly message: string;
  readonly since: string;
}

export interface StateSnapshot {
  /** The sequence the snapshot was taken at; every event after it carries a higher one. */
  readonly seq: number;
  readonly objectId: ObjectId | null;
  readonly entries: readonly StateSnapshotEntry[];
  /** True when the subtree has more sensors than one snapshot may carry. */
  readonly truncated: boolean;
}

export interface StreamStats {
  /** Subscribers currently attached. */
  readonly subscribers: number;
  /** Events published since start, counted once however many subscribers saw them. */
  readonly published: number;
  readonly delivered: number;
  /**
   * Subscribers cut off because they could not keep up.
   *
   * Counted, never silent (`CLAUDE.md`). Dropping individual events instead would leave a client
   * quietly showing a state the system has moved on from, which is worse than telling it to
   * start again.
   */
  readonly overflowed: number;
  /** State changes that were published while nobody was listening, and so cost nothing. */
  readonly unwatched: number;
}

export interface StateBroadcasterOptions {
  logger: Logger;
  /**
   * How many bytes one subscriber may have accepted but not yet put on the wire before it is
   * cut off. Bytes rather than events because that is the quantity the transport can actually
   * measure — see `StateSubscriber.backlog`.
   */
  backlogLimitBytes?: number;
  /** How many sensors a snapshot may carry. */
  snapshotLimit?: number;
}

/**
 * 1 MiB, which is thousands of state frames.
 *
 * Deliberately forgiving. Cutting a subscriber off costs it a fresh snapshot of up to 20,000
 * sensors, so a limit tight enough to fire on an ordinary network stall would be worse than the
 * backlog it prevents. What it has to stop is the unbounded case — a suspended browser tab that
 * never reads again — and any finite number does that.
 */
const DEFAULT_BACKLOG_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_SNAPSHOT_LIMIT = 20_000;

/** What a subscriber does with an event, and what it is told when it falls behind. */
export interface StateSubscriber {
  send(event: StateEvent): void;
  /** Its own queue overflowed; everything it holds is suspect and it must resubscribe. */
  overflow(): void;
  /**
   * Bytes this subscriber has accepted and not yet delivered, if it can say.
   *
   * The broadcaster cannot work this out for itself, and `P-60` is what happened when it tried:
   * `send` returns `void` and returns *immediately* — a WebSocket's does, because it buffers
   * internally — so a counter the broadcaster raised and lowered around the call was zero every
   * time it was read, and the cut-off below it could never fire. The transport is the only thing
   * that knows, so the transport is asked. A subscriber that consumes synchronously has no
   * backlog and may leave this out.
   */
  backlog?(): number;
}

interface Attached {
  readonly subscriber: StateSubscriber;
  readonly objectId: ObjectId | null;
}

/**
 * Live state changes, pushed rather than polled (`U-02`).
 *
 * **Published after the commit, never inside it.** A frame announcing a state change, sent from
 * inside the transaction that decided it, is an outage on an operator's screen that may never
 * have happened — the transaction can still roll back. `Queryable.afterCommit` is the seam, and
 * `writeStateHistory` is where it is used, because that one function is what every state change
 * in the system goes through: ingestion, a pause, an acknowledgement, a simulated error, a
 * dependency cascade and a schedule window all end up there.
 *
 * **Nobody listening costs one comparison.** The ancestry read that scopes an event to a subtree
 * only happens when there is a subscriber, which is the same guard `M-09` and `N-02` put in
 * front of their sweeps: an installation with no browser open pays nothing for the feature.
 *
 * **A subscriber that cannot keep up is cut off, not quietly trimmed.** Dropping events from the
 * middle of a stream leaves a client showing a state the system has moved on from and no way to
 * know it. Overflow tells it to resubscribe — which takes a fresh snapshot — and is counted.
 */
export class StateBroadcaster {
  readonly #logger: Logger;
  readonly #backlogLimit: number;
  readonly #snapshotLimit: number;
  readonly #attached = new Set<Attached>();
  #seq = 0;
  #published = 0;
  #delivered = 0;
  #overflowed = 0;
  #unwatched = 0;

  constructor(options: StateBroadcasterOptions) {
    this.#logger = options.logger.child({ component: 'stream' });
    this.#backlogLimit = options.backlogLimitBytes ?? DEFAULT_BACKLOG_LIMIT_BYTES;
    this.#snapshotLimit = options.snapshotLimit ?? DEFAULT_SNAPSHOT_LIMIT;
  }

  get stats(): StreamStats {
    return {
      subscribers: this.#attached.size,
      published: this.#published,
      delivered: this.#delivered,
      overflowed: this.#overflowed,
      unwatched: this.#unwatched,
    };
  }

  /** Whether anything is listening. The guard every publish path checks first. */
  get watching(): boolean {
    return this.#attached.size > 0;
  }

  get seq(): number {
    return this.#seq;
  }

  /** Attaches a subscriber, scoped to a subtree or to everything. Returns how to detach it. */
  subscribe(subscriber: StateSubscriber, objectId: ObjectId | null): () => void {
    const attached: Attached = { subscriber, objectId };
    this.#attached.add(attached);
    return () => this.#attached.delete(attached);
  }

  /**
   * Publishes the state changes a transaction has just committed.
   *
   * Reads the ancestry of the sensors involved, and only then, because that read is the whole
   * cost of the feature and an installation nobody is watching must not pay it.
   */
  async publish(
    q: Queryable,
    changes: readonly {
      readonly sensorId: ObjectId;
      readonly state: SensorState;
      readonly previousState: SensorState | null;
      readonly cause: SensorStateCause;
      readonly message: string;
      readonly at: Date;
    }[],
  ): Promise<number> {
    if (changes.length === 0) return 0;
    if (!this.watching) {
      this.#unwatched += changes.length;
      return 0;
    }

    const ancestry = await this.#ancestryOf(
      q,
      changes.map((change) => change.sensorId),
    );

    let sent = 0;
    for (const change of changes) {
      const found = ancestry.get(change.sensorId);
      // A sensor deleted between the commit and this read. Nothing to say about it, and the
      // deletion is its own event as far as a tree is concerned.
      if (found === undefined) continue;
      this.#seq += 1;
      this.#published += 1;
      const event: StateEvent = {
        seq: this.#seq,
        sensorId: change.sensorId,
        sensorName: found.name,
        path: found.path,
        state: change.state,
        previousState: change.previousState,
        cause: change.cause,
        message: change.message,
        at: change.at.toISOString(),
      };
      sent += this.#deliver(event);
    }
    return sent;
  }

  /**
   * The current state of a subtree.
   *
   * Taken *after* the subscriber is attached, so nothing can happen in the gap: an event that
   * lands between the two is queued and delivered afterwards, and applying it a second time sets
   * the state it already has. The alternative ordering loses changes and looks fine.
   */
  async snapshot(q: Queryable, objectId: ObjectId | null): Promise<StateSnapshot> {
    const rows = await q.query<{
      sensor_id: string;
      name: string;
      path: string[];
      state: SensorState;
      cause: SensorStateCause;
      message: string;
      since: Date;
    }>(
      `
      -- Two walks. Up first, to get the subtree root's own ancestors, then down. The paths a
      -- snapshot carries have to be the same absolute paths the events carry — a client that
      -- matched one against the other would find the tree it drew and the tree it updates are
      -- rooted differently.
      WITH RECURSIVE up AS (
        SELECT o.id, o.parent_id, ARRAY[o.id] AS prefix
        FROM object o
        WHERE ($1::bigint IS NULL AND o.parent_id IS NULL) OR o.id = $1
        UNION ALL
        SELECT p.id, p.parent_id, ARRAY[p.id] || up.prefix
        FROM object p JOIN up ON p.id = up.parent_id
      ),
      covered AS (
        SELECT o.id, (SELECT prefix FROM up WHERE parent_id IS NULL LIMIT 1) AS path
        FROM object o
        WHERE ($1::bigint IS NULL AND o.parent_id IS NULL) OR o.id = $1
        UNION ALL
        SELECT c.id, covered.path || c.id
        FROM object c JOIN covered ON c.parent_id = covered.id
      )
      SELECT covered.id::text AS sensor_id, o.name, covered.path::text[] AS path,
             sr.state, sr.cause, sr.message, sr.since
      FROM covered
      JOIN object o ON o.id = covered.id
      JOIN sensor_runtime sr ON sr.object_id = covered.id
      WHERE o.kind = 'sensor'
      ORDER BY covered.id
      LIMIT $2
      `,
      [objectId, this.#snapshotLimit + 1],
    );

    const truncated = rows.length > this.#snapshotLimit;
    if (truncated) {
      this.#logger.warn(
        { objectId, limit: this.#snapshotLimit },
        'a subtree has more sensors than one snapshot carries',
      );
    }
    return {
      seq: this.#seq,
      objectId,
      truncated,
      entries: rows.slice(0, this.#snapshotLimit).map((row) => ({
        sensorId: Number(row.sensor_id),
        sensorName: row.name,
        path: row.path.map(Number),
        state: row.state,
        cause: row.cause,
        message: row.message,
        since: row.since.toISOString(),
      })),
    };
  }

  /** Fans one event out to whoever asked for that subtree. */
  #deliver(event: StateEvent): number {
    let sent = 0;
    for (const attached of this.#attached) {
      if (attached.objectId !== null && !event.path.includes(attached.objectId)) continue;
      // Asked, not inferred. See `StateSubscriber.backlog`.
      const backlog = attached.subscriber.backlog?.() ?? 0;
      if (backlog >= this.#backlogLimit) {
        this.#attached.delete(attached);
        this.#overflowed += 1;
        this.#logger.warn(
          { objectId: attached.objectId, backlog, limit: this.#backlogLimit },
          'a subscriber fell too far behind and was cut off; it must resubscribe',
        );
        attached.subscriber.overflow();
        continue;
      }
      attached.subscriber.send(event);
      sent += 1;
      this.#delivered += 1;
    }
    return sent;
  }

  /** Root-first ancestor paths for a batch of sensors, in one query. */
  async #ancestryOf(
    q: Queryable,
    sensorIds: readonly ObjectId[],
  ): Promise<Map<ObjectId, { name: string; path: ObjectId[] }>> {
    const rows = await q.query<{ sensor_id: string; name: string; path: string[] }>(
      `
      WITH RECURSIVE chain AS (
        SELECT o.id AS origin, o.id, o.parent_id, o.name AS origin_name, ARRAY[o.id] AS path
        FROM object o WHERE o.id = ANY($1::bigint[])
        UNION ALL
        SELECT chain.origin, p.id, p.parent_id, chain.origin_name, ARRAY[p.id] || chain.path
        FROM object p JOIN chain ON p.id = chain.parent_id
      )
      SELECT origin::text AS sensor_id, origin_name AS name, path::text[] AS path
      FROM chain
      WHERE parent_id IS NULL
      `,
      [sensorIds],
    );
    return new Map(
      rows.map((row) => [Number(row.sensor_id), { name: row.name, path: row.path.map(Number) }]),
    );
  }
}
