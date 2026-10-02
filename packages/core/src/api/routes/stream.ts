// Side-effect imports: @fastify/swagger augments FastifySchema with `description`, and
// @fastify/websocket augments the route options with `websocket` and the handler's socket.
import '@fastify/swagger';
import '@fastify/websocket';
import { Ajv } from 'ajv';
import type { FastifyInstance } from 'fastify';
import { describeError } from '@ms/shared';
import type { CredentialCheck, Lapse } from '../../auth/credentials.js';
import type { Database } from '../../db/pool.js';
import type {
  Admission,
  StateBroadcaster,
  StateEvent,
  StateSnapshot,
  StreamSight,
} from '../../state/stream.js';
import { credentialOf, READS, sightOf } from '../authorization.js';

export interface StreamRouteOptions {
  db: Database;
  stream: StateBroadcaster;
  /** The bounds below, narrowed by a test that needs to reach them (`A-30`). */
  limits?: Partial<StreamLimits>;
  /**
   * How to ask whether a socket's session or token still authenticates (`A-34`). Present whenever
   * the server has accounts; asked only about sockets that presented a credential, which is only
   * when authentication is required.
   */
  credentials?: CredentialCheck;
}

/**
 * What one stream socket may cost the core before it is closed (`A-30`).
 *
 * **The outbound side had no bound at all.** `P-217` capped what a client may send in one frame,
 * and `P-60` cut off a subscriber whose *events* backed up — but every frame goes through one
 * `send`, and a client that stopped reading while it kept sending could make the core queue
 * replies without limit: a full snapshot per `{"subscribe":{}}`, each resetting the event
 * accounting that would have noticed, or a `problem` twenty times the size of a seven-byte frame.
 * The kernel buffers what it can and Node the rest, in the core's own memory, until `MemoryMax`
 * ends it — `P-217`'s outcome by another route, from any account that may read.
 */
export interface StreamLimits {
  /**
   * Bytes a socket may hold unsent. Past it the socket is closed outright — a frame telling it
   * why would queue behind everything it is not reading. Room for the largest snapshot
   * (`snapshotLimit` sensors, about 5 MiB at 20,000) and the event backlog behind it, three
   * times over, so a client that is reading is never near it.
   */
  readonly socketBytes: number;
  /** Subscriptions in any minute. The web client makes one per socket and one per resync. */
  readonly subscribesPerMinute: number;
  /** Frames refused as malformed before the socket stops being answered and is closed. */
  readonly problems: number;
  /**
   * Frames a signed-in socket may have sent and not yet had read (`U-25`). Each waits for the
   * socket's credential to be asked about, one at a time, so a client sending faster than that
   * is answered would otherwise queue them without limit.
   */
  readonly unread: number;
}

export const STREAM_LIMITS: StreamLimits = {
  socketBytes: 16 * 1024 * 1024,
  subscribesPerMinute: 30,
  problems: 5,
  unread: 16,
};

/**
 * The close code for a socket whose session, token or account no longer authenticates (`A-34`).
 *
 * In the range RFC 6455 leaves to applications, and chosen to read as the 401 it is. **A client
 * must not reconnect on it**: the upgrade would be refused, and a browser hides a refused upgrade
 * behind the same 1006 a pulled cable produces, so a client that treated this like any other close
 * would retry for ever with the header still saying somebody is signed in. The web client goes to
 * the login form instead.
 */
export const STREAM_SIGNED_OUT = 4401;

/** What the close frame says, by why. Under the 123 bytes a close reason may hold. */
const SIGNED_OUT: Readonly<Record<Lapse, string>> = {
  ended: 'this session has ended; sign in again',
  expired: 'this session has expired; sign in again',
  revoked: 'this token has been revoked',
  disabled: 'this account can no longer sign in',
};

/**
 * What a client sends. Anything else is answered with a `problem` frame and ignored.
 *
 * `objectId` is a subtree's sensors; `probeId` is one probe's own link and report, and none of
 * the sensors beneath it (`U-24`). Never both: they are two subscriptions, and a socket has one.
 */
interface ClientFrame {
  readonly subscribe: { readonly objectId?: number; readonly probeId?: number };
}

/**
 * The one shape a client frame may have, checked before anything reads it (`P-217`).
 *
 * The frame used to be cast to `ClientFrame` and read, and `null` and `{"subscribe":null}` are
 * both JSON: each threw from a property read on `null`. `ws` emits `message` synchronously from
 * the socket's data path, so the throw was an `uncaughtException` and the lifecycle shut the core
 * down — one frame from any account that may read, or from anybody with authentication off.
 */
const clientFrameSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['subscribe'],
  properties: {
    subscribe: {
      type: 'object',
      additionalProperties: false,
      properties: {
        objectId: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        probeId: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
      not: { required: ['objectId', 'probeId'] },
    },
  },
} as const;

// First error only: this runs on whatever a client sends, and a report of every way a frame of
// junk is wrong is work nobody reads.
const isClientFrame = new Ajv({ allErrors: false, strict: false }).compile<ClientFrame>(
  clientFrameSchema,
);

/**
 * The largest frame the handler reads (`P-217`). A subscription is under fifty bytes; anything
 * past this is answered with a `problem` frame without being parsed.
 */
const MAX_CLIENT_FRAME_BYTES = 1024;

/**
 * The largest frame `ws` will buffer at all, for `@fastify/websocket`'s `maxPayload` (`P-217`).
 *
 * `ws` defaults to 100 MiB, buffered whole and then handed over — per frame, per socket, from any
 * account that may read. Past this the library closes the socket with 1009 before the handler
 * sees anything; between `MAX_CLIENT_FRAME_BYTES` and this, the client is told why.
 */
export const STREAM_MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * A socket event handler that nothing thrown inside can escape (`P-217`).
 *
 * `ws` calls its listeners synchronously, so a throw in one is an `uncaughtException`, and the core
 * treats one of those as fatal. Validating the frame closes the hole that was found; this is for
 * the next one, so that it costs a connection rather than the service.
 */
export function contained<A extends unknown[]>(
  handler: (...args: A) => void,
  onThrow: (error: unknown) => void,
): (...args: A) => void {
  return (...args: A): void => {
    try {
      handler(...args);
    } catch (error: unknown) {
      onThrow(error);
    }
  };
}

/**
 * What the server sends. A discriminated union, so a client switches rather than sniffs.
 *
 * **`seq` is this socket's own count of the `state` frames it has been sent** (`A-21`): 1, 2, 3
 * and on across every subscription the socket makes, with a snapshot carrying the number of the
 * last one before it and `hello` carrying 0. So a gap still means a frame went missing — which is
 * what a sequence number is for — and a gap no longer means that something changed where the
 * caller cannot see, which is what a process-wide counter told every account granted a branch.
 */
type ServerFrame =
  | { readonly type: 'hello'; readonly seq: number; readonly protocol: number }
  | ({ readonly type: 'snapshot'; readonly seq: number } & StateSnapshot)
  | ({ readonly type: 'state'; readonly seq: number } & StateEvent)
  /** The answer to `{"subscribe":{"probeId":N}}`: the watch stands, and `probe` frames follow. */
  | { readonly type: 'watching'; readonly probeId: number }
  /**
   * That probe's link came or went, or what its report leaves out changed (`U-24`).
   *
   * **The id and nothing else.** It is sent only on a watch the socket asked for by that id and
   * was allowed, so the id tells it nothing; and it carries no value, so what a reader learns
   * about the probe is still decided by `GET /probes/{id}/health` and nowhere else. Unnumbered:
   * these are coalesced, and a count with holes in it would say a frame was lost when none was.
   */
  | { readonly type: 'probe'; readonly probeId: number }
  | { readonly type: 'overflow'; readonly reason: string }
  | { readonly type: 'problem'; readonly reason: string };

/**
 * The protocol version, so a client that has been open across a deploy can tell.
 *
 * One number rather than a negotiation: this stream carries state changes and nothing else, and
 * a client that does not understand the version reconnects and reloads rather than guessing.
 *
 * The end of a held return (`M-18`) is the only change to the alarms list with no state change
 * behind it, and the list covers it with a timer at the hold's end rather than a frame here.
 *
 * **Not raised for `watching` and `probe`** (`U-24`). Both are sent only on a subscription that
 * names a `probeId`, which a client written before them cannot make, so no socket is ever sent a
 * frame of a kind it did not ask for.
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
 * One probe watch's frames, coalesced (`U-24`).
 *
 * **A `probe` frame says "ask again" and nothing else, so two of them unread are one.** A link
 * that flaps is an edge every few hundred milliseconds for as long as it flaps, and a browser tab
 * in the background reads none of them: queued one per edge, that is a backlog with no bound and
 * nothing in it. So at most one frame is ever outstanding per watch — while one has been handed
 * to the socket and not yet written out, or while the answer to the subscription has not gone, a
 * further change is counted and folded into it. The frame that does arrive is read after the
 * last change, and is answered with whatever is true then.
 *
 * `send` hands a frame to the socket and returns whether it took it; `written` is called once
 * the socket has put it on the wire. Apart from the route so the rule can be driven without one.
 */
export function probeFrames(options: {
  send: (written: () => void) => boolean;
  coalesced: () => void;
}): {
  /** The probe changed. */
  changed: () => void;
  /** The answer to the subscription has gone: a change held behind it follows it. */
  open: () => void;
} {
  let live = false;
  let held = false;
  let unsent = false;
  const put = (): void => {
    unsent = true;
    const taken = options.send(() => {
      unsent = false;
    });
    // Refused — the socket is closed — so nothing will ever call `written`.
    if (!taken) unsent = false;
  };
  return {
    changed: (): void => {
      if (!live) {
        if (held) options.coalesced();
        held = true;
        return;
      }
      if (unsent) {
        options.coalesced();
        return;
      }
      put();
    },
    open: (): void => {
      live = true;
      if (!held) return;
      held = false;
      put();
    },
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
  const limits: StreamLimits = { ...STREAM_LIMITS, ...options.limits };

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
          '`overflow` with that reason, and subscribing again takes a snapshot of the new view.' +
          '\n\nSend `{"subscribe":{"probeId":7}}` to watch one probe itself rather than the ' +
          'sensors beneath it. The server answers `{"type":"watching","probeId":7}` and then ' +
          'sends `{"type":"probe","probeId":7}` whenever that probe connects, drops, or sends a ' +
          'report that differs in which listeners it says are running. The frame carries no ' +
          'value: it means "ask `GET /probes/7/health` again", which is where what the caller ' +
          'may know about the probe is decided. It is sent only to a caller who can read that ' +
          'probe, and a watch on a probe the caller cannot read — or on an id that is not a ' +
          'probe — is answered with `problem`. Changes that arrive faster than the socket takes ' +
          'them are folded into one frame, so a `probe` frame means "at least once since the ' +
          'last", and the frames are not numbered. `objectId` and `probeId` together are refused. ' +
          'A watch whose caller loses the probe is sent nothing when the probe next changes; it ' +
          'is sent `overflow` within seconds of the grant changing, on a timer of the core’s ' +
          'own, so that when it arrives says nothing about the probe.' +
          '\n\n`seq` numbers the `state` frames this socket has been sent, from 1 and across ' +
          'every subscription it makes; `hello` carries 0 and a `snapshot` the number of the last ' +
          '`state` frame before it. It is the socket’s own count, so a gap means a frame was ' +
          'lost and never that something changed outside what the caller can see.' +
          `\n\nA socket is closed with 1008 when it subscribes more than ` +
          `${String(STREAM_LIMITS.subscribesPerMinute)} times in a minute, or sends more than ` +
          `${String(STREAM_LIMITS.problems)} frames the stream cannot use — each of those is ` +
          'answered with `problem` — and closed outright when it stops reading and ' +
          `${String(STREAM_LIMITS.socketBytes / 1024 / 1024)} MiB queue up unsent.` +
          `\n\nA socket is closed with ${String(STREAM_SIGNED_OUT)} when what authenticated it ` +
          'no longer does — its session ended or expired, its token was revoked or expired, or ' +
          'its account was disabled. Nothing that changed after that is sent to it: from the ' +
          'first change the core would have sent, the socket is sent nothing at all, and it is ' +
          'closed on a timer of the core’s own, within five seconds, so that when the close ' +
          'arrives says nothing about what changed or when. A frame the client sends in that ' +
          'time is not answered, and closes the socket at once. Do not reconnect on ' +
          `${String(STREAM_SIGNED_OUT)}: sign in again. An open stream does not count as ` +
          'activity, so a session used for nothing else reaches its idle timeout.',
        // No `response`: the route upgrades rather than answering, and a schema describing a
        // 101 would be a shape no client ever parses.
        response: {},
      },
    },
    (socket, request) => {
      let detach: (() => void) | undefined;
      let closed = false;
      /**
       * Its credential lapsed, found where a change was about to be sent (`U-25`). Open still,
       * and sent nothing: every frame goes through `send`, which lets none out from here on.
       */
      let silenced = false;
      /**
       * Which subscription is current. Resolving the caller's visibility is a query, so a second
       * `subscribe` can arrive while the first is still asking — and without this both would
       * attach, and only the second could ever be detached.
       */
      let generation = 0;
      // Afresh for every subscription (`A-12`): the socket can outlive the grants it opened with.
      const sight = sightOf(request);

      const backlog = socketBacklog(socket);

      const unsubscribe = (): void => {
        detach?.();
        detach = undefined;
      };

      /**
       * Stops sending to a socket whose credential lapsed, and leaves it open (`U-25`). Called
       * synchronously from the check a published batch or a probe's change runs, and detaching
       * here is what keeps that batch from delivering to it (`A-34`).
       *
       * **Not closed here**, because here is the instant something changed — a sensor's state, a
       * probe's link, anywhere in the installation — and a close frame arriving now would say so
       * to an account that has just been signed out or disabled. The broadcaster's sweep closes
       * it, on its own timer, and until then a frame from the client does: see `receive`.
       *
       * **A subscription in flight is not abandoned here.** It goes on to ask about the
       * credential before it answers, as it always did (`A-34`), and that closes the socket —
       * exactly as it does for a socket that lapsed and was *not* silenced, so the two cannot be
       * told apart by which of them a subscribe was answered with a close. Whatever it would
       * send on the way there, `send` lets none of it out.
       */
      const silence = (lapse: Lapse): void => {
        if (closed || silenced) return;
        silenced = true;
        unsubscribe();
        request.log.info(
          { login: request.principal?.login, lapse },
          'a stream socket lost its credential; it is sent nothing more and closed on the sweep',
        );
      };

      /**
       * Closes a socket whose credential lapsed (`A-34`). Called from the sweep, or from the check
       * a frame of the client's own asked for — never from the check a published change runs,
       * which is `silence` (`U-25`).
       */
      const signOut = (lapse: Lapse): void => {
        if (closed) return;
        closed = true;
        unsubscribe();
        request.log.info(
          { login: request.principal?.login, lapse },
          'a stream socket was signed out',
        );
        socket.close(STREAM_SIGNED_OUT, SIGNED_OUT[lapse]);
      };
      // Absent when there is nothing to check: authentication is off, or the route is public.
      const credential = credentialOf(request);
      // **Never admitted unchecked.** A signed-in socket with nothing to ask about it is exactly the
      // stream that outlives a logout, so a server wired that way closes the socket instead.
      if (credential !== null && options.credentials === undefined) {
        request.log.error('a signed-in stream socket has no credential check to answer for it');
        closed = true;
        socket.close(1011, 'internal error');
        return;
      }
      const admission: Admission | undefined =
        credential === null || options.credentials === undefined
          ? undefined
          : stream.admit({ credential, silence, signOut }, options.credentials);

      /**
       * Stops serving this socket, and counts it on Core Health (`A-30`). `terminate` when it is not
       * reading — a close frame would only queue behind the rest — and `close` with the reason
       * otherwise, so a client that is listening learns why.
       */
      const sever = (reason: string, how: 'close' | 'terminate'): void => {
        if (closed) return;
        closed = true;
        unsubscribe();
        stream.severed();
        request.log.warn({ login: request.principal?.login, reason }, 'a stream socket was closed');
        if (how === 'terminate') socket.terminate();
        else socket.close(1008, reason);
      };

      /**
       * Returns the bytes handed to `ws`, so a snapshot can be discounted from the backlog.
       *
       * **Every frame is bounded here, whatever it is** (`A-30`): a snapshot, an event, a reply.
       */
      const send = (frame: ServerFrame, written?: () => void): number => {
        // **Nothing, to a socket whose credential lapsed** (`U-25`): not a frame, not `overflow`,
        // not a `problem`. One gate, so a frame added later cannot forget.
        if (closed || silenced || socket.readyState !== socket.OPEN) return 0;
        if (socket.bufferedAmount > limits.socketBytes) {
          sever('it is not reading what it is sent', 'terminate');
          return 0;
        }
        const text = JSON.stringify(frame);
        // `written` is told when `ws` has put the frame on the wire, or failed to: either way it
        // is no longer waiting in this process, which is all a caller counts (`U-24`).
        if (written === undefined) socket.send(text);
        else socket.send(text, written);
        return Buffer.byteLength(text);
      };

      /** When each recent subscription arrived, oldest first, for `limits.subscribesPerMinute`. */
      const subscribed: number[] = [];
      /** Frames refused as malformed so far, for `limits.problems`. */
      let refused = 0;
      /** Answers a malformed frame, until there have been too many to go on answering. */
      const refuse = (reason: string): void => {
        refused += 1;
        if (refused > limits.problems) {
          sever('too many frames it could not use', 'close');
          return;
        }
        send({ type: 'problem', reason });
      };

      // The `state` frames this socket has been sent, and nothing else (`A-21`). See `ServerFrame`.
      let numbered = 0;

      send({ type: 'hello', seq: numbered, protocol: PROTOCOL });

      // A function rather than an inline test: `closed` changes in a callback across the awaits
      // below, and a condition written out twice is narrowed to its first answer.
      const superseded = (mine: number): boolean => mine !== generation || closed;

      const open = async (mine: number, objectId: number | null): Promise<void> => {
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
        /**
         * **Held until the snapshot has gone, then sent after it** (`A-30`). A change committed
         * while the snapshot was being read used to be sent straight away — *before* the snapshot
         * frame — and the client replaces its whole state on a snapshot, so the snapshot, read a
         * moment earlier, painted over it and the sensor showed its older state until it next
         * changed. The order `U-02` chose, attach and then read, only works if the wire keeps it.
         * What is held counts against the backlog, so a snapshot slow enough to hold a flood cuts
         * the socket off rather than growing without bound.
         */
        const held: { events: StateEvent[] | null; bytes: number } = { events: [], bytes: 0 };
        const deliver = (event: StateEvent): void => {
          numbered += 1;
          backlog.wrote(send({ type: 'state', seq: numbered, ...event }));
        };
        const seeing: StreamSight = { visibility, key: sight.key, resolve: sight };
        detach = stream.subscribe(
          {
            send: (event) => {
              if (held.events === null) {
                deliver(event);
                return;
              }
              held.events.push(event);
              held.bytes += Buffer.byteLength(JSON.stringify(event));
            },
            overflow: (reason) => {
              cutOff.dropped = true;
              held.events = [];
              held.bytes = 0;
              detach = undefined;
              send({ type: 'overflow', reason: reason ?? 'too far behind; subscribe again' });
            },
            // What `ws` has accepted and not yet written, less a snapshot still going out, plus
            // what is held for after it. The one number that actually grows when a client stops
            // reading — a browser tab suspended in the background does exactly that, and nothing
            // else here would notice (`P-60`) — but counting our own snapshot against it cuts off
            // healthy clients on a large installation (`P-66`).
            backlog: () => backlog.report() + held.bytes,
          },
          objectId,
          seeing,
        );
        // Whether this subscription is still the one to answer. A function for the reason
        // `superseded` is: `cutOff.dropped` read inline is narrowed to its first answer.
        const gone = (): boolean => superseded(mine) || cutOff.dropped;
        const { snapshot, epoch } = await stream.snapshot(db, objectId, visibility);
        // Replaced while the snapshot was being read (`A-30`): the newer subscription has its own
        // snapshot coming, and this one arriving after it would put the old scope back on screen.
        // Or cut off while it was being read — sending it now would append megabytes to a socket
        // the cut-off has already given up on, which is the amplification `P-70` closes.
        if (gone()) return;
        // Read through a view that grants have since changed (`A-30`): the snapshot would paint
        // what this account may no longer see. Sent back to the start, as `#catchUp` would.
        if (!(await stream.confirm(seeing, epoch))) {
          if (gone()) return;
          unsubscribe();
          send({
            type: 'overflow',
            reason: 'what this account may see has changed; subscribe again',
          });
          return;
        }
        if (gone()) return;
        // Signed out while the snapshot was read (`A-34`). No published batch vouches for a
        // snapshot, and the sweep may be seconds away; asked here, it is closed and not sent.
        if (admission !== undefined && !(await admission.confirm())) return;
        if (gone()) return;
        // Numbered once it has been read: every `state` frame sent before it is counted in it, and
        // every one after it — the held ones first — carries a higher number.
        const frame = { type: 'snapshot' as const, seq: numbered, ...snapshot };
        // A snapshot supersedes everything before it, so the event accounting starts again from
        // here and its own bytes are never counted. See `socketBacklog`.
        backlog.snapshot();
        send(frame);
        const waiting = held.events ?? [];
        held.events = null;
        held.bytes = 0;
        for (const event of waiting) deliver(event);
      };

      /**
       * A watch on one probe itself (`U-24`): `open`, without a snapshot, because there is no
       * state here to hand over — what the frames prompt for is asked of the probe's own route.
       *
       * **Attached first and judged after**, as `open` attaches before it reads: a change that
       * lands while the checks below are out is held by `frames` and follows `watching`.
       * Attaching decides nothing — the broadcaster sends a frame only through a view that sees
       * the probe, and nothing reaches the socket before the checks have passed.
       */
      const watch = async (mine: number, probeId: number): Promise<void> => {
        const visibility = await sight();
        if (superseded(mine)) return;
        const cutOff = { dropped: false };
        const frames = probeFrames({
          send: (written) => send({ type: 'probe', probeId }, written) > 0,
          coalesced: () => {
            stream.coalesced();
          },
        });
        const seeing: StreamSight = { visibility, key: sight.key, resolve: sight };
        detach = stream.watchProbe(
          {
            changed: frames.changed,
            overflow: (reason) => {
              cutOff.dropped = true;
              detach = undefined;
              send({ type: 'overflow', reason: reason ?? 'subscribe again' });
            },
          },
          probeId,
          seeing,
        );
        const gone = (): boolean => superseded(mine) || cutOff.dropped;
        const { visible, epoch } = await stream.canWatchProbe(db, probeId, visibility);
        if (gone()) return;
        if (!visible) {
          unsubscribe();
          // What a subscription to a hidden object is told, and for the same reason: one answer
          // for a probe it may not read, an id nobody used and an object that is not a probe.
          send({ type: 'problem', reason: 'this account may not read a probe with that id' });
          return;
        }
        // Judged through a view that grants have since changed (`A-30`). Back to the start.
        if (!(await stream.confirm(seeing, epoch))) {
          if (gone()) return;
          unsubscribe();
          send({
            type: 'overflow',
            reason: 'what this account may see has changed; subscribe again',
          });
          return;
        }
        if (gone()) return;
        // Signed out while that was asked (`A-34`): closed, and told nothing.
        if (admission !== undefined && !(await admission.confirm())) return;
        if (gone()) return;
        send({ type: 'watching', probeId });
        frames.open();
      };

      const subscribe = (scope: ClientFrame['subscribe']): void => {
        // **Paced** (`A-30`). Each one reads a snapshot, and one replacing another before it has
        // been read still costs the read; a client subscribing this often is not a tree.
        const now = performance.now();
        while (subscribed.length > 0 && now - (subscribed[0] ?? now) >= 60_000) subscribed.shift();
        if (subscribed.length >= limits.subscribesPerMinute) {
          sever('it subscribed too often', 'close');
          return;
        }
        subscribed.push(now);
        unsubscribe();
        const mine = (generation += 1);
        const opening =
          scope.probeId === undefined
            ? open(mine, scope.objectId ?? null)
            : watch(mine, scope.probeId);
        void opening.catch((error: unknown) => {
          // **Only the subscription that failed** (`A-30`). One replaced while it was reading has
          // nothing left on this socket; detaching here would detach its replacement, which is
          // healthy, and tell the client to resubscribe for no reason it could act on.
          if (superseded(mine)) {
            request.log.warn(
              { err: describeError(error) },
              'a replaced stream subscription failed; its replacement stands',
            );
            return;
          }
          // A failed snapshot leaves the client attached but with nothing to apply the events
          // to, which is worse than telling it to try again.
          unsubscribe();
          request.log.error({ err: describeError(error) }, 'a stream subscription failed');
          send({
            type: 'problem',
            reason:
              scope.probeId === undefined
                ? 'the snapshot could not be read; subscribe again'
                : 'the probe could not be read; subscribe again',
          });
        });
      };

      const read = (raw: Buffer): void => {
        if (closed) return;
        if (raw.length > MAX_CLIENT_FRAME_BYTES) {
          refuse('that frame is larger than any subscription');
          return;
        }
        let frame: unknown;
        try {
          frame = JSON.parse(raw.toString('utf8'));
        } catch {
          refuse('that was not JSON');
          return;
        }
        if (!isClientFrame(frame)) {
          refuse(
            'the only message this stream takes is {"subscribe":{}}, ' +
              '{"subscribe":{"objectId":<a positive integer>}} or ' +
              '{"subscribe":{"probeId":<a positive integer>}}',
          );
          return;
        }
        subscribe(frame.subscribe);
      };

      const hang = (): void => {
        closed = true;
        unsubscribe();
        admission?.release();
      };

      // This socket, and only this socket: whatever went wrong, the next frame on it cannot be
      // trusted to find the subscription in a state it expects.
      const fault = (error: unknown): void => {
        request.log.error(
          { err: describeError(error), login: request.principal?.login },
          'a stream socket handler threw; closing that socket',
        );
        hang();
        socket.close(1011, 'internal error');
      };

      /** Frames a signed-in socket has sent that are waiting to be read, for `limits.unread`. */
      let unread = 0;
      let reading: Promise<void> = Promise.resolve();
      /**
       * **A signed-in socket's frame is read once its credential has been asked about** (`U-25`),
       * whatever the frame is — a subscription, or junk that would be answered with `problem`.
       *
       * A socket silenced by a published change must not subscribe, and must not be answered. It
       * could simply be closed when it next sends a frame; but a socket that lapsed and has *not*
       * been silenced — nothing was published since — would then be answered instead, and a
       * signed-out client could send one frame to learn which it is: whether anything changed
       * state, anywhere, since it was signed out. So the same thing is done for both. The
       * credential is asked about, and a socket whose credential lapsed is closed with
       * `STREAM_SIGNED_OUT` there, silenced or not, having been sent nothing. That instant is the
       * client's own frame's, which tells it nothing it did not choose.
       *
       * One at a time and in order, so a subscription cannot overtake the one before it. A check
       * that cannot answer closes nothing (`A-34`): the frame is read as before.
       */
      const receive = (raw: Buffer): void => {
        if (closed) return;
        if (admission === undefined) {
          read(raw);
          return;
        }
        if (unread >= limits.unread) {
          sever('it sent frames faster than they could be read', 'close');
          return;
        }
        unread += 1;
        // Nothing past the bound is ever parsed, so nothing past it is kept while it waits.
        const frame = raw.length > MAX_CLIENT_FRAME_BYTES ? null : raw;
        reading = reading
          .then(async () => {
            let signedIn = true;
            try {
              signedIn = await admission.confirm();
            } catch (error: unknown) {
              request.log.warn(
                { err: describeError(error) },
                'could not check a stream socket’s credential before reading its frame',
              );
            }
            unread -= 1;
            if (!signedIn || closed) return;
            if (frame === null) refuse('that frame is larger than any subscription');
            else read(frame);
          })
          .catch(fault);
      };

      socket.on('message', contained(receive, fault));
      socket.on('close', contained(hang, fault));
      socket.on('error', contained(hang, fault));
    },
  );
}
