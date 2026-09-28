// Side-effect imports: @fastify/swagger augments FastifySchema with `description`, and
// @fastify/websocket augments the route options with `websocket` and the handler's socket.
import '@fastify/swagger';
import '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { describeError } from '@ms/shared';
import type { Database } from '../../db/pool.js';
import type { StateBroadcaster, StateEvent, StateSnapshot } from '../../state/stream.js';
import { READS, sightOf } from '../authorization.js';

export interface StreamRouteOptions {
  db: Database;
  stream: StateBroadcaster;
}

/** What a client sends. Anything else is answered with a `problem` frame and ignored. */
interface ClientFrame {
  readonly subscribe?: { readonly objectId?: number | null };
}

/** What the server sends. A discriminated union, so a client switches rather than sniffs. */
type ServerFrame =
  | { readonly type: 'hello'; readonly seq: number; readonly protocol: number }
  | ({ readonly type: 'snapshot' } & StateSnapshot)
  | ({ readonly type: 'state' } & StateEvent)
  | { readonly type: 'overflow'; readonly reason: string }
  | { readonly type: 'problem'; readonly reason: string };

/**
 * The protocol version, so a client that has been open across a deploy can tell.
 *
 * One number rather than a negotiation: this stream carries state changes and nothing else, and
 * a client that does not understand the version reconnects and reloads rather than guessing.
 */
const PROTOCOL = 1;

/**
 * How much of what a WebSocket still holds is *events* rather than its own snapshot.
 *
 * **The snapshot travels down the same socket the cut-off measures**, and it is the one frame big
 * enough to trip it: up to `snapshotLimit` sensors, megabytes on a large installation, handed to
 * `ws` in one call. `P-60` read `bufferedAmount` raw, so the first state event after subscribing
 * saw the whole snapshot still buffered and detached a client that was keeping up perfectly —
 * which sent it back to resubscribe, take another snapshot, and be detached again.
 *
 * **A socket is FIFO, and that is the whole trick.** The snapshot was queued first, so every byte
 * of it leaves before any event byte does. Counting the event bytes written since the snapshot
 * gives `min(bufferedAmount, sent)`: while any of the snapshot is still queued the buffer exceeds
 * `sent` and the answer is `sent` — every event byte, none of the snapshot; once the snapshot has
 * gone the buffer is events alone and the answer is the buffer. Both cases fall out of the one
 * expression, and the snapshot's size never has to be known.
 *
 * `P-66` tried to do this by forgiving the snapshot's bytes and clamping that allowance to
 * whatever was still buffered. That was wrong, and `ws` is why: `bufferedAmount` is
 * `_writableState.length + _sender._bufferedBytes`, and Node clears `_writableState.length` only
 * when a whole write completes — measured, a 3 MiB write to a peer that is not reading still
 * reads 3,145,728 three seconds later. So the buffer does not decay as the snapshot drains, it
 * drops in one step; the clamp then pulled the allowance down onto the *events* queued behind it
 * and forgave those instead, leaving a client that stalled mid-snapshot permanently uncuttable.
 */
export function socketBacklog(socket: { readonly bufferedAmount: number }): {
  report: () => number;
  /** A snapshot resets the accounting: everything before it has been superseded. */
  snapshot: () => void;
  /** Event bytes handed to `ws`, which is what the cut-off is actually about. */
  wrote: (bytes: number) => void;
} {
  let sent = 0;
  return {
    snapshot: (): void => {
      sent = 0;
    },
    wrote: (bytes: number): void => {
      sent += bytes;
    },
    report: (): number => Math.min(socket.bufferedAmount, sent),
  };
}

/**
 * Live state changes over a WebSocket (`U-02`).
 *
 * **Push, not polling.** `PLAN.md`'s Phase 5 exit criterion is a tree that stays responsive at
 * 5,000 sensors and updates within a second; polling that tree is a full re-read per client per
 * second, and polling it *less* often is the same thing arriving late.
 *
 * **Subscribe, then snapshot, then stream — in that order, and the order is the whole design.**
 * The subscriber is attached before its snapshot is read, so a change landing in between is
 * queued and delivered afterwards rather than falling into the gap. Applying it a second time
 * sets the state it already has, which is why this ordering is safe and the intuitive one is
 * not.
 *
 * **Resync is "subscribe again".** There is no replay log and no `since` cursor: a client that
 * reconnects, or that is told it overflowed, resubscribes and is handed a fresh snapshot. A
 * cursor would mean keeping a buffer whose length is a guess about how long a browser tab can be
 * asleep, and getting that guess wrong shows somebody a stale tree with no way to tell.
 */
export function streamRoutes(app: FastifyInstance, options: StreamRouteOptions): void {
  const { db, stream } = options;

  app.get(
    '/stream',
    {
      config: READS,
      websocket: true,
      schema: {
        tags: ['stream'],
        summary: 'Live sensor state changes',
        description:
          'A WebSocket. Send `{"subscribe":{"objectId":42}}` to scope to a subtree, or ' +
          '`{"subscribe":{}}` for everything; the server answers with a `snapshot` frame and ' +
          'then a `state` frame per change. Subscribing again replaces the subscription and ' +
          'takes a fresh snapshot, which is also how a client resyncs — there is no cursor. ' +
          'A client that cannot keep up is sent `overflow` and detached rather than being ' +
          'quietly trimmed, because a tree missing a change looks exactly like a tree that is ' +
          'up to date.\n\n' +
          '"Everything" is everything the caller can read: sensors it cannot are neither in the ' +
          'snapshot nor streamed, and every `path` carries only the steps it can read. ' +
          'Subscribing to an object it cannot read is answered with a `problem` frame. When ' +
          'what the caller may see changes — a grant revoked, a group left — the socket is sent ' +
          '`overflow` with that reason, and subscribing again takes a snapshot of the new view.',
        // No `response`: the route upgrades rather than answering, and a schema describing a
        // 101 would be a shape no client ever parses.
        response: {},
      },
    },
    (socket, request) => {
      let detach: (() => void) | undefined;
      let closed = false;
      /**
       * Which subscription is current. Resolving the caller's visibility is a query, so a second
       * `subscribe` can arrive while the first is still asking — and without this both would
       * attach, and only the second could ever be detached.
       */
      let generation = 0;
      // Afresh for every subscription (`A-12`): the socket can outlive the grants it opened with.
      const sight = sightOf(request);

      const backlog = socketBacklog(socket);

      /** Returns the bytes handed to `ws`, so a snapshot can be discounted from the backlog. */
      const send = (frame: ServerFrame): number => {
        if (closed || socket.readyState !== socket.OPEN) return 0;
        const text = JSON.stringify(frame);
        socket.send(text);
        return Buffer.byteLength(text);
      };

      const unsubscribe = (): void => {
        detach?.();
        detach = undefined;
      };

      send({ type: 'hello', seq: stream.seq, protocol: PROTOCOL });

      // A function rather than an inline test: `closed` changes in a callback across the awaits
      // below, and a condition written out twice is narrowed to its first answer.
      const superseded = (mine: number): boolean => mine !== generation || closed;

      const subscribe = async (objectId: number | null): Promise<void> => {
        unsubscribe();
        const mine = (generation += 1);
        const visibility = await sight();
        if (superseded(mine)) return;
        if (objectId !== null && !(await stream.canSee(db, objectId, visibility))) {
          if (superseded(mine)) return;
          // The same answer `GET /objects/:id` gives, as a frame: a subscription to a hidden
          // object would stream the visible sensors beneath it, which says where they sit.
          send({ type: 'problem', reason: 'this account may not read that object' });
          return;
        }
        if (superseded(mine)) return;
        // Attached first. Anything that commits from here on is queued for this subscriber, so
        // the snapshot below cannot miss a change that happens while it is being read.
        // Set if the cut-off gives up on this socket while the snapshot below is being read.
        // A holder rather than a bare `let`: both `detach` and a plain boolean get narrowed to
        // their initial value here, because the compiler cannot see the callback that changes
        // them run. A property read after an intervening call is not narrowed away.
        const cutOff = { dropped: false };
        detach = stream.subscribe(
          {
            send: (event) => {
              backlog.wrote(send({ type: 'state', ...event }));
            },
            overflow: (reason) => {
              cutOff.dropped = true;
              detach = undefined;
              send({ type: 'overflow', reason: reason ?? 'too far behind; subscribe again' });
            },
            // What `ws` has accepted and not yet written, less a snapshot still going out. The
            // one number that actually grows when a client stops reading — a browser tab
            // suspended in the background does exactly that, and nothing else here would notice
            // (`P-60`) — but counting our own snapshot against it cuts off healthy clients on a
            // large installation (`P-66`).
            backlog: backlog.report,
          },
          objectId,
          { visibility, key: sight.key, resolve: sight },
        );
        // A snapshot supersedes everything before it, so the event accounting starts again from
        // here and its own bytes are never counted. See `socketBacklog`.
        const frame = {
          type: 'snapshot' as const,
          ...(await stream.snapshot(db, objectId, visibility)),
        };
        // Detached while the snapshot was being read — sending it now would append megabytes to a
        // socket the cut-off has already given up on, which is the amplification `P-70` closes.
        if (cutOff.dropped) return;
        backlog.snapshot();
        send(frame);
      };

      socket.on('message', (raw: Buffer) => {
        let frame: ClientFrame;
        try {
          frame = JSON.parse(raw.toString('utf8')) as ClientFrame;
        } catch {
          send({ type: 'problem', reason: 'that was not JSON' });
          return;
        }
        if (frame.subscribe === undefined) {
          send({ type: 'problem', reason: 'the only message this stream takes is "subscribe"' });
          return;
        }
        const objectId = frame.subscribe.objectId ?? null;
        if (objectId !== null && (!Number.isInteger(objectId) || objectId < 1)) {
          send({ type: 'problem', reason: 'objectId must be a positive integer, or absent' });
          return;
        }
        void subscribe(objectId).catch((error: unknown) => {
          // A failed snapshot leaves the client attached but with nothing to apply the events
          // to, which is worse than telling it to try again.
          unsubscribe();
          request.log.error({ err: describeError(error) }, 'a stream subscription failed');
          send({ type: 'problem', reason: 'the snapshot could not be read; subscribe again' });
        });
      });

      socket.on('close', () => {
        closed = true;
        unsubscribe();
      });
      socket.on('error', () => {
        closed = true;
        unsubscribe();
      });
    },
  );
}
