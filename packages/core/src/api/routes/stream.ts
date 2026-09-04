// Side-effect imports: @fastify/swagger augments FastifySchema with `description`, and
// @fastify/websocket augments the route options with `websocket` and the handler's socket.
import '@fastify/swagger';
import '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { describeError } from '@ms/shared';
import type { Database } from '../../db/pool.js';
import type { StateBroadcaster, StateEvent, StateSnapshot } from '../../state/stream.js';

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
/**
 * How far behind a WebSocket is, discounting a snapshot still on its way out (`P-66`).
 *
 * **The snapshot travels down the same socket the cut-off measures**, and it is the one frame
 * big enough to trip it: up to `snapshotLimit` sensors, megabytes on a large installation, handed
 * to `ws` in one call. `P-60` read `bufferedAmount` raw, so the first state event after
 * subscribing saw the whole snapshot still buffered and detached a client that was keeping up
 * perfectly — which sent it back to resubscribe, take another snapshot, and be detached again.
 *
 * So a snapshot buys an allowance for its own bytes, and the allowance **only ever shrinks**: it
 * is clamped to whatever is still buffered on every reading, so once those bytes are on the wire
 * it is gone and the guard is armed at full strength. What is left over is the part of the
 * backlog this connection did not ask for — the events — which is the quantity the cut-off is
 * about.
 */
export function socketBacklog(socket: { readonly bufferedAmount: number }): {
  report: () => number;
  allow: (bytes: number) => void;
} {
  let allowance = 0;
  return {
    allow: (bytes: number): void => {
      allowance += bytes;
    },
    report: (): number => {
      const buffered = socket.bufferedAmount;
      // Never more than is actually still queued. A snapshot that has gone out forgives nothing.
      if (allowance > buffered) allowance = buffered;
      return buffered - allowance;
    },
  };
}

export function streamRoutes(app: FastifyInstance, options: StreamRouteOptions): void {
  const { db, stream } = options;

  app.get(
    '/stream',
    {
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
          'up to date.',
        // No `response`: the route upgrades rather than answering, and a schema describing a
        // 101 would be a shape no client ever parses.
        response: {},
      },
    },
    (socket, request) => {
      let detach: (() => void) | undefined;
      let closed = false;

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

      const subscribe = async (objectId: number | null): Promise<void> => {
        unsubscribe();
        // Attached first. Anything that commits from here on is queued for this subscriber, so
        // the snapshot below cannot miss a change that happens while it is being read.
        detach = stream.subscribe(
          {
            send: (event) => {
              send({ type: 'state', ...event });
            },
            overflow: () => {
              detach = undefined;
              send({ type: 'overflow', reason: 'too far behind; subscribe again' });
            },
            // What `ws` has accepted and not yet written, less a snapshot still going out. The
            // one number that actually grows when a client stops reading — a browser tab
            // suspended in the background does exactly that, and nothing else here would notice
            // (`P-60`) — but counting our own snapshot against it cuts off healthy clients on a
            // large installation (`P-66`).
            backlog: backlog.report,
          },
          objectId,
        );
        // The snapshot's own bytes are not this client falling behind, so they are forgiven
        // until they have gone out. See `socketBacklog`.
        backlog.allow(send({ type: 'snapshot', ...(await stream.snapshot(db, objectId)) }));
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
