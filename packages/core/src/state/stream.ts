import { describeError, type Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';
import type { Visibility } from '../auth/access.js';
import type { ObjectId } from '../objects/types.js';
import type { SensorState, SensorStateCause } from './tables.js';

/**
 * One committed state change, as a subscriber receives it.
 *
 * **Unnumbered, deliberately** (`A-21`). A number given here would be the installation's, one per
 * change, and a subscriber that sees a tenth of the tree would read the other nine tenths in the
 * gaps between its own — how many changes, and when. What a socket was sent is numbered where it
 * is sent, in the stream route, and counts nothing else.
 */
export interface StateEvent {
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
  readonly objectId: ObjectId | null;
  readonly entries: readonly StateSnapshotEntry[];
  /** True when the subtree has more sensors than one snapshot may carry. */
  readonly truncated: boolean;
}

/**
 * A snapshot, and the access epoch it was read at (`A-30`).
 *
 * **Apart, so the epoch is never sent.** It counts every grant change in the installation, and a
 * subscriber who could watch it move would learn when grants change in branches it cannot see —
 * `A-21`'s lesson about a number that belongs to the installation rather than to the socket.
 */
export interface SnapshotRead {
  readonly snapshot: StateSnapshot;
  readonly epoch: number | null;
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
  /**
   * Sockets the stream route closed rather than answer again (`A-30`): one that stopped reading
   * what it was sent, one subscribing faster than any client needs to, one that kept sending
   * frames it had been told were wrong. Beside `overflowed` on Core Health, because both are a
   * client the core stopped serving to protect everybody else.
   */
  readonly severed: number;
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
  /** When it attached, in attachments: what `#catchUp` compares with its horizon (`A-30`). */
  readonly order: number;
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
  /**
   * Resolutions in flight, by principal and the epoch that sent for them (`A-30`). Publishes run
   * concurrently — every committed batch is one — and each noticed the same grant change and asked
   * again for every account on its own, so one change under ingestion load cost an account one
   * resolution per batch in flight rather than one.
   */
  readonly #resolving = new Map<string, Promise<Visibility>>();
  #attachments = 0;
  #published = 0;
  #delivered = 0;
  #overflowed = 0;
  #unwatched = 0;
  #resynced = 0;
  #severed = 0;

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
      severed: this.#severed,
    };
  }

  /** Counts a socket the stream route closed to protect the core (`A-30`). See `StreamStats`. */
  severed(): void {
    this.#severed += 1;
  }

  /** Whether anything is listening. The guard every publish path checks first. */
  get watching(): boolean {
    return this.#attached.size > 0;
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
    this.#attachments += 1;
    const attached: Attached = { subscriber, objectId, sight, order: this.#attachments };
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
    // re-resolving, and only for the subscribers whose answer was read at another epoch.
    const horizon = epoch === null ? this.#attachments : await this.#catchUp(epoch);

    let sent = 0;
    for (const change of changes) {
      const found = ancestry.get(change.sensorId);
      // A sensor deleted between the commit and this read. Nothing to say about it, and the
      // deletion is its own event as far as a tree is concerned.
      if (found === undefined) continue;
      this.#published += 1;
      const event: StateEvent = {
        sensorId: change.sensorId,
        sensorName: found.name,
        path: found.path,
        state: change.state,
        previousState: change.previousState,
        cause: change.cause,
        message: change.message,
        at: change.at.toISOString(),
      };
      sent += this.#deliver(event, horizon);
    }
    return sent;
  }

  /**
   * The current state of a subtree, and the access epoch it was read at.
   *
   * Taken *after* the subscriber is attached, so nothing can happen in the gap: an event that
   * lands between the two is held by the route until this has been sent, and delivered after it
   * (`A-30`), where applying it a second time sets the state it already has. The alternative
   * ordering loses changes and looks fine.
   *
   * **The epoch is read in the same statement as the rows** (`A-30`), so the two are one moment.
   * `visibility` was resolved in an earlier one, and a grant revoked in between would otherwise
   * be read straight past: the sensors it hid are in the snapshot, and nothing sends the socket
   * back until some later change happens to be published. `confirm` is what the caller does with
   * it.
   */
  async snapshot(
    q: Queryable,
    objectId: ObjectId | null,
    visibility: Visibility,
  ): Promise<SnapshotRead> {
    const values: unknown[] = [objectId, this.#snapshotLimit + 1];
    // Inside the query, so the limit counts only sensors the subscriber may see (`A-12`).
    const visible = visibility.where('covered.id', (value) => `$${String(values.push(value))}`);
    const read = await q.query<{
      sensor_id: string | null;
      name: string;
      path: string[];
      state: SensorState;
      cause: SensorStateCause;
      message: string;
      since: Date;
      epoch: string;
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
      ),
      picked AS (
        SELECT covered.id, o.name, covered.path, sr.state, sr.cause, sr.message, sr.since
        FROM covered
        JOIN object o ON o.id = covered.id
        JOIN sensor_runtime sr ON sr.object_id = covered.id
        WHERE o.kind = 'sensor' AND ${visible}
        ORDER BY covered.id
        LIMIT $2
      )
      -- One row even when nothing is picked, so an empty snapshot still says when it was read.
      SELECT picked.id::text AS sensor_id, picked.name, picked.path::text[] AS path,
             picked.state, picked.cause, picked.message, picked.since,
             (SELECT value::text FROM access_epoch) AS epoch
      FROM (SELECT 1) AS one
      LEFT JOIN picked ON true
      ORDER BY picked.id
      `,
      values,
    );
    const first = read[0];
    const epoch = first === undefined ? null : Number(first.epoch);
    const rows = read.filter(
      (row): row is typeof row & { sensor_id: string } => row.sensor_id !== null,
    );

    const truncated = rows.length > this.#snapshotLimit;
    if (truncated) {
      this.#logger.warn(
        { objectId, limit: this.#snapshotLimit },
        'a subtree has more sensors than one snapshot carries',
      );
    }
    return {
      epoch,
      snapshot: {
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
      },
    };
  }

  /**
   * Whether a snapshot read at `epoch` may still be sent through `sight` (`A-30`).
   *
   * True when nothing moved between resolving the sight and reading the snapshot, or when it
   * moved and asking again gives the same answer — in which case the sight is brought up to date,
   * so the next published batch does not ask a third time. False when the answer changed: the
   * snapshot was read through a view this account no longer has, and must not be sent. That is a
   * resync, counted as one, and the caller says so the way `#catchUp` does.
   *
   * Rejects when the resolution fails; the caller already treats a snapshot it could not read as
   * a subscription to refuse.
   */
  async confirm(sight: StreamSight, epoch: number | null): Promise<boolean> {
    const seen = sight.visibility.epoch;
    if (epoch === null || seen === null || seen === epoch) return true;
    const next = await this.#resolve(sight, epoch);
    if (next.sameAs(sight.visibility)) {
      sight.visibility = next;
      return true;
    }
    this.#resynced += 1;
    return false;
  }

  /**
   * What `sight` may see now, asked once per principal however many batches noticed the same
   * epoch at the same time (`A-30`).
   *
   * Keyed by the epoch as well as the principal: an answer being fetched for an older epoch may
   * already be stale for a newer one, and waiting on it would carry the staleness forward.
   */
  #resolve(sight: StreamSight, epoch: number): Promise<Visibility> {
    const key = `${sight.key}@${String(epoch)}`;
    const inFlight = this.#resolving.get(key);
    if (inFlight !== undefined) return inFlight;
    const pending = sight.resolve();
    this.#resolving.set(key, pending);
    const settle = (): void => {
      if (this.#resolving.get(key) === pending) this.#resolving.delete(key);
    };
    pending.then(settle, settle);
    return pending;
  }

  /**
   * Re-resolves every subscriber whose visibility was read at another epoch, and sends back to the
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
   *
   * Returns its horizon, the last attachment it looked at, which is how `#deliver` knows the ones
   * it did not (`A-30`): a subscriber that attached while this was waiting was never examined,
   * and is skipped for this batch rather than sent it through a view resolved before the grants
   * moved.
   */
  async #catchUp(epoch: number): Promise<number> {
    const horizon = this.#attachments;
    const stale = [...this.#attached].filter((attached) => {
      const seen = attached.sight.visibility.epoch;
      // Different, not older (`A-25`): the counter only rises in a running database, but a
      // restore or a rollback can put it back, and a socket resolved at the higher number would
      // then never be told again until the counter passed it.
      return seen !== null && seen !== epoch;
    });
    if (stale.length === 0) return horizon;

    await Promise.all(
      stale.map(async (attached) => {
        let next: Visibility | null;
        try {
          next = await this.#resolve(attached.sight, epoch);
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
    return horizon;
  }

  /**
   * Fans one event out to whoever asked for that subtree and may see it.
   *
   * **Not to a subscriber that attached after `horizon`** (`A-30`). `#catchUp` never examined it
   * — it attached while the check waited on a resolution, or between its return and this — and
   * its view may have been resolved before the grants moved. Skipping it loses nothing: it
   * attached after this batch committed, so the snapshot it is about to read already holds the
   * change, and the next batch examines it. Its epoch is not the test: a subscriber attached long
   * ago can have had its sight brought forward by a concurrent batch, and skipping that one would
   * lose the change.
   */
  #deliver(event: StateEvent, horizon: number): number {
    let sent = 0;
    for (const attached of this.#attached) {
      if (attached.order > horizon) continue;
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
