import { describeError, type Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';
import type { Visibility } from '../auth/access.js';
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
  /**
   * Subscribers told to start again because what their account may see changed underneath them
   * (`A-12`) — a grant revoked, a group left. Counted apart from `overflowed`, which is about a
   * client that cannot keep up; this is about the server knowing better than the client does.
   */
  readonly resynced: number;
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
  /**
   * Everything it holds is suspect and it must resubscribe: its own queue overflowed, or — with
   * a reason — what its account may see has changed (`A-12`).
   */
  overflow(reason?: string): void;
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

/**
 * What a subscriber may see, and how to ask again (`A-12`).
 *
 * Resolved when it subscribes and held for as long as it stays attached — which can be days, so
 * `resolve` is how the broadcaster finds out that the answer has gone stale. `key` names the
 * principal, so one grant change re-resolves each account once however many tabs it has open.
 */
export interface StreamSight {
  visibility: Visibility;
  readonly key: string;
  readonly resolve: () => Promise<Visibility>;
}

interface Attached {
  readonly subscriber: StateSubscriber;
  readonly objectId: ObjectId | null;
  readonly sight: StreamSight;
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
  #resynced = 0;

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
      resynced: this.#resynced,
    };
  }

  /** Whether anything is listening. The guard every publish path checks first. */
  get watching(): boolean {
    return this.#attached.size > 0;
  }

  get seq(): number {
    return this.#seq;
  }

  /**
   * Attaches a subscriber, scoped to a subtree or to everything, seeing what `sight` allows.
   * Returns how to detach it.
   *
   * **The sight is not optional** (`A-12`). A broadcaster that fanned every event out to every
   * socket is how `{"subscribe":{}}` streamed the whole installation to an account granted one
   * branch; a subscriber that genuinely sees everything says so with `Visibility.EVERYTHING`.
   */
  subscribe(
    subscriber: StateSubscriber,
    objectId: ObjectId | null,
    sight: StreamSight,
  ): () => void {
    const attached: Attached = { subscriber, objectId, sight };
    this.#attached.add(attached);
    return () => this.#attached.delete(attached);
  }

  /**
   * Whether this visibility can read the object a subscription would be scoped to.
   *
   * The same question `GET /objects/:id` asks, and refused the same way when the answer is no: a
   * subscription to a hidden object that streamed the visible sensors beneath it would say where
   * they sit in a branch the subscriber was never shown.
   */
  async canSee(q: Queryable, objectId: ObjectId, visibility: Visibility): Promise<boolean> {
    if (visibility.everything) return true;
    const values: unknown[] = [objectId];
    const visible = visibility.where('o.id', (value) => `$${String(values.push(value))}`);
    const rows = await q.query<{ visible: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM object o WHERE o.id = $1 AND ${visible}) AS visible`,
      values,
    );
    return rows[0]?.visible === true;
  }

  /**
   * Publishes the state changes a transaction has just committed.
   *
   * Reads the ancestry of the sensors involved, and only then, because that read is the whole
   * cost of the feature and an installation nobody is watching must not pay it.
   *
   * **This never rejects** (`P-91`). It is the body of an `afterCommit` hook, and
   * `Database.tx`'s hook loop try/catches only the *synchronous* call — so a rejection from the
   * `#ancestryOf` query, which runs on the pool outside any transaction, escaped to
   * `unhandledRejection`, whose lifecycle handler logs fatal and shuts ms-core down. A pool
   * timeout under ingestion load, or a Postgres failover, therefore stopped the monitoring at
   * the moment the database was unhealthy and monitoring mattered most — over a broadcast whose
   * transaction had already committed and whose failure costs a repaint, not a fact.
   *
   * The guarantee lives here rather than in the caller's `.catch` because there is nothing a
   * caller could usefully do with the error, and a second hook added later would have to
   * remember. What it costs is the live stream being behind until the next change.
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

    let ancestry: Map<ObjectId, { name: string; path: ObjectId[] }>;
    let epoch: number | null;
    try {
      ({ ancestry, epoch } = await this.#ancestryOf(
        q,
        changes.map((change) => change.sensorId),
      ));
    } catch (error) {
      this.#logger.error(
        { states: changes.length, err: describeError(error) },
        'could not read the ancestry of committed state changes; the live stream is behind',
      );
      return 0;
    }

    // **Grants change while sockets stay open** (`A-12`). The epoch came back with the ancestry,
    // so noticing costs no round trip; only a batch published after a grant change pays for
    // re-resolving, and only for the subscribers whose answer is older than it.
    if (epoch !== null) await this.#catchUp(epoch);

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
  async snapshot(
    q: Queryable,
    objectId: ObjectId | null,
    visibility: Visibility,
  ): Promise<StateSnapshot> {
    const values: unknown[] = [objectId, this.#snapshotLimit + 1];
    // Inside the query, so the limit counts only sensors the subscriber may see (`A-12`).
    const visible = visibility.where('covered.id', (value) => `$${String(values.push(value))}`);
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
        SELECT o.id, o.parent_id, ARRAY[o.id] AS prefix, 0 AS depth
        FROM object o
        WHERE ($1::bigint IS NULL AND o.parent_id IS NULL) OR o.id = $1
        UNION ALL
        SELECT p.id, p.parent_id, ARRAY[p.id] || up.prefix, up.depth + 1
        FROM object p JOIN up ON p.id = up.parent_id
        WHERE up.depth < ${String(MAX_WALK_DEPTH)}
      ),
      covered AS (
        SELECT o.id, (SELECT prefix FROM up WHERE parent_id IS NULL LIMIT 1) AS path, 0 AS depth
        FROM object o
        WHERE ($1::bigint IS NULL AND o.parent_id IS NULL) OR o.id = $1
        UNION ALL
        SELECT c.id, covered.path || c.id, covered.depth + 1
        FROM object c JOIN covered ON c.parent_id = covered.id
        WHERE covered.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT covered.id::text AS sensor_id, o.name, covered.path::text[] AS path,
             sr.state, sr.cause, sr.message, sr.since
      FROM covered
      JOIN object o ON o.id = covered.id
      JOIN sensor_runtime sr ON sr.object_id = covered.id
      WHERE o.kind = 'sensor' AND ${visible}
      ORDER BY covered.id
      LIMIT $2
      `,
      values,
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
        // The same steps an event for this sensor would carry, so a client matching one against
        // the other finds the same tree (`A-12`).
        path: visibility.trim(row.path.map(Number)),
        state: row.state,
        cause: row.cause,
        message: row.message,
        since: row.since.toISOString(),
      })),
    };
  }

  /**
   * Re-resolves every subscriber whose visibility is older than `epoch`, and sends back to the
   * start any whose answer changed.
   *
   * **A changed view is a resync, not a quiet swap.** The client has already painted sensors it
   * may no longer see, and patching events onto that tree would leave them there; `overflow` is
   * the frame that already means "everything you hold is suspect, subscribe again", and the
   * client already does exactly that with it.
   *
   * **A resolution that fails cuts the subscriber off rather than guessing.** It must not reject
   * — see `publish` — and the one answer that cannot leak is to stop sending until the client
   * has subscribed again, which resolves afresh or fails where the failure can be reported.
   */
  async #catchUp(epoch: number): Promise<void> {
    const stale = [...this.#attached].filter((attached) => {
      const seen = attached.sight.visibility.epoch;
      return seen !== null && seen < epoch;
    });
    if (stale.length === 0) return;

    const resolving = new Map<string, Promise<Visibility>>();
    await Promise.all(
      stale.map(async (attached) => {
        let pending = resolving.get(attached.sight.key);
        if (pending === undefined) {
          pending = attached.sight.resolve();
          resolving.set(attached.sight.key, pending);
        }

        let next: Visibility | null;
        try {
          next = await pending;
        } catch (error) {
          this.#logger.warn(
            { err: describeError(error) },
            'could not re-resolve what a stream subscriber may see; it must resubscribe',
          );
          next = null;
        }
        // Detached while this was being asked: nothing to update and nobody to tell.
        if (!this.#attached.has(attached)) return;
        if (next?.sameAs(attached.sight.visibility) === true) {
          attached.sight.visibility = next;
          return;
        }
        this.#attached.delete(attached);
        this.#resynced += 1;
        attached.subscriber.overflow(
          next === null
            ? 'could not confirm what this account may see; subscribe again'
            : 'what this account may see has changed; subscribe again',
        );
      }),
    );
  }

  /** Fans one event out to whoever asked for that subtree and may see it. */
  #deliver(event: StateEvent): number {
    let sent = 0;
    for (const attached of this.#attached) {
      if (attached.objectId !== null && !event.path.includes(attached.objectId)) continue;
      // Checked against the path the event already carries, so fanning out to a hundred
      // sockets is a hundred walks of a short array and not a hundred queries (`A-12`).
      const visibility = attached.sight.visibility;
      if (!visibility.sees(event.path)) continue;
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
      attached.subscriber.send(
        visibility.everything ? event : { ...event, path: visibility.trim(event.path) },
      );
      sent += 1;
      this.#delivered += 1;
    }
    return sent;
  }

  /**
   * Root-first ancestor paths for a batch of sensors, and the access epoch, in one query.
   *
   * The epoch rides along because this query already runs for every published batch, so a
   * stream learns that grants changed without paying a round trip to ask (`A-12`). Null when no
   * sensor survived to be placed — there is nothing to deliver, so nothing to be stale about.
   */
  async #ancestryOf(
    q: Queryable,
    sensorIds: readonly ObjectId[],
  ): Promise<{
    ancestry: Map<ObjectId, { name: string; path: ObjectId[] }>;
    epoch: number | null;
  }> {
    const rows = await q.query<{ sensor_id: string; name: string; path: string[]; epoch: string }>(
      `
      WITH RECURSIVE chain AS (
        SELECT o.id AS origin, o.id, o.parent_id, o.name AS origin_name, ARRAY[o.id] AS path,
               0 AS depth
        FROM object o WHERE o.id = ANY($1::bigint[])
        UNION ALL
        SELECT chain.origin, p.id, p.parent_id, chain.origin_name, ARRAY[p.id] || chain.path,
               chain.depth + 1
        FROM object p JOIN chain ON p.id = chain.parent_id
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT origin::text AS sensor_id, origin_name AS name, path::text[] AS path,
             (SELECT value::text FROM access_epoch) AS epoch
      FROM chain
      WHERE parent_id IS NULL
      `,
      [sensorIds],
    );
    const first = rows[0];
    return {
      ancestry: new Map(
        rows.map((row) => [Number(row.sensor_id), { name: row.name, path: row.path.map(Number) }]),
      ),
      epoch: first === undefined ? null : Number(first.epoch),
    };
  }
}
