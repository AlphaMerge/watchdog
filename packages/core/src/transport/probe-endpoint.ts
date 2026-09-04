import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import { createServer, type Server, type TLSSocket } from 'node:tls';
import type { AddressInfo } from 'node:net';
import {
  capabilitiesFor,
  describeError,
  describeSkew,
  explainSkew,
  isProtocolCompatible,
  loadTlsMaterial,
  MessageConnection,
  parseProbeToCore,
  PROTOCOL_VERSION,
  versionFor,
  withCorrelation,
  type CheckResult,
  type ConnectionClose,
  type CoreConfig,
  type CoreToProbeMessage,
  type Logger,
  type ProbeQuery,
  type ProbeToCoreMessage,
  type ProbeHealthReport,
  type QueryFailure,
  type RejectCode,
  type SensorAssignment,
  type IdentifyJob,
  type SweepEnding,
  type SweepHost,
  type SweepJob,
} from '@ms/shared';
import { diffAssignments, EMPTY_ASSIGNMENTS, type ProbeAssignments } from '../probes/config.js';

/**
 * Whatever stores check results. `IngestionService` is it; the endpoint takes the interface so
 * the transport stays testable without a database, and so ingestion never learns about sockets.
 */
export interface ResultReceiver {
  acceptResults(
    source: string,
    message: Extract<ProbeToCoreMessage, { type: 'results' }>,
  ): Promise<CoreToProbeMessage>;
}

/**
 * Where a probe's assignments come from (R-04). An interface for the same reason as
 * `ResultReceiver`: the transport stays testable without a database, and the config service
 * never learns about sockets.
 */
export interface ProbeConfigSource {
  /** The probe object this GID owns, or null while it is unclaimed. */
  probeObjectFor(gid: string): Promise<number | null>;
  assignmentsFor(probeObjectId: number): Promise<ProbeAssignments>;
  touch(objectId: number): Promise<void>;
}

/**
 * What the transport tells the discovery service, and nothing more (`D-01`).
 *
 * Same reasoning as `ResultReceiver` and `ProbeConfigSource`: the endpoint stays testable
 * without a database, and the discovery service never learns about sockets.
 */
/** A sweep the core wants started; `job` is the wire shape, built by the discovery service. */
export interface SweepStart {
  kind: 'start';
  job: SweepJob;
}

export interface SweepCancel {
  kind: 'cancel';
  runId: number;
}

/** The second stage (`D-02`), dispatched down the same path for the same reasons. */
export interface IdentifyStart {
  kind: 'identify';
  job: IdentifyJob;
}

export interface IdentifyCancel {
  kind: 'identify-cancel';
  runId: number;
}

export type SweepMessage = SweepStart | SweepCancel | IdentifyStart | IdentifyCancel;

/**
 * What happened to a sweep message, in the three cases the caller acts on differently (`R-06`).
 *
 * `offline` is not a failure — the run waits and is offered again on reconnect. `too-old` is
 * final for as long as that probe runs that build, and the run has to be failed with a reason
 * rather than left queued against a probe that will never answer.
 */
export type SweepDelivery =
  | { kind: 'sent' }
  | { kind: 'offline' }
  | { kind: 'too-old'; protocolVersion: number; needs: number };

export interface DiscoverySink {
  /** A probe with this branch has connected, or reconnected. Offer it whatever it should run. */
  pump(probeObjectId: number): Promise<void>;
  progress(
    runId: number,
    cursor: number,
    found: readonly SweepHost[],
    failed: number,
  ): Promise<void>;
  /** Fingerprints from `D-02`. `unknown[]` here; the service validates the shape. */
  identified(runId: number, cursor: number, found: readonly unknown[]): Promise<void>;
  identifyFinished(runId: number, ending: SweepEnding, message: string): Promise<void>;
  finished(runId: number, ending: SweepEnding, cursor: number, message: string): Promise<void>;
  probeDisconnected(probeObjectId: number): Promise<void>;
}

export interface ProbeEndpointOptions {
  config: CoreConfig['probeEndpoint'];
  logger: Logger;
  coreVersion: string;
  /** Absent until ingestion is wired up; results are then refused with `unavailable`. */
  results?: ResultReceiver;
  /** Absent until R-04 is wired; probes then receive nothing and scan nothing. */
  probeConfig?: ProbeConfigSource;
  /** Absent until D-01 is wired; sweeps are then never dispatched and never reported. */
  discovery?: DiscoverySink;
  /**
   * Who is allowed in (`R-01`).
   *
   * Absent means the old behaviour: whoever presents the shared access key is trusted. Kept as
   * an option rather than made mandatory so the transport's own tests can drive a handshake
   * without a database — but `main.ts` always passes one, and an installation without one has
   * no approval queue at all.
   */
  registry?: ProbeAdmission;
  /**
   * Told when a probe's link comes and goes, so its sensors read Unknown rather than Down
   * (`R-05`). Absent means nothing tells the state machine, which is the pre-`R-05` behaviour:
   * the sensors keep their last reading for ever.
   */
  reachability?: ProbeReachabilitySink;
  /**
   * Where an on-demand answer goes (`R-09`). Absent means nothing here can be asked anything —
   * `sendQuery` still refuses politely, so a caller gets a reason rather than a hang.
   */
  queries?: ProbeQuerySink;
}

/** What the transport tells `R-09`, and nothing more. */
export interface ProbeQuerySink {
  deliver(message: {
    queryId: string;
    result?: CheckResult;
    failure?: QueryFailure;
    message?: string;
  }): void;
  probeDisconnected(probeObjectId: number): void;
}

/** What the transport tells `R-05`, and nothing more. */
export interface ProbeReachabilitySink {
  lost(probeObjectId: number): Promise<number>;
  found(probeObjectId: number): Promise<number>;
}

/**
 * The admission decision, as far as the transport cares (`R-01`).
 *
 * An interface for the same reason as `ResultReceiver` and `ProbeConfigSource`: the transport
 * stays testable without a database, and the registry never learns about sockets.
 */
export interface ProbeAdmission {
  admit(hello: {
    gid: string;
    displayName: string;
    agentVersion: string;
    protocolVersion: number;
    accessKey: string;
    remoteAddress: string;
  }): Promise<
    | { kind: 'approved'; gid: string; objectId: number | null; issuedKey?: string }
    | { kind: 'pending'; gid: string }
    | {
        kind: 'refused';
        code: 'revoked' | 'source-not-allowed' | 'bad-access-key' | 'protocol-version';
        detail: string;
      }
  >;
}

export interface ConnectedProbe {
  gid: string;
  displayName: string;
  agentVersion: string;
  remoteAddress: string;
  connectedAt: Date;
  lastHeartbeatAt: Date | null;
}

/**
 * One probe's link as the core sees it (`P-13`).
 *
 * A discriminated shape rather than a bag of nullables: `connected: false` is a complete answer,
 * and everything else is meaningless beside it. That is also the answer Probe Health most needs
 * to be able to give, because it is the one the probe itself can never send.
 */
export type ProbeLink =
  | { connected: false }
  | {
      connected: true;
      protocolVersion: number;
      connectedAt: Date;
      lastHeartbeatAt: Date | null;
      approved: boolean;
      agentVersion: string;
      /**
       * What this probe was told to scan, and when anything last arrived from it (`P-74`).
       *
       * Here rather than on `ConnectedProbe` because it is a fact about the *link*, and because
       * the delivery watchdog is the only reader: a probe that is connected and silent is not
       * carrying its sensors, and nothing else in the core can tell.
       */
      assignedSensors: number;
      cadenceSeconds: number | null;
      lastResultsAt: Date | null;
      configSentAt: Date | null;
      /**
       * The same three facts as monotonic ages in milliseconds, for the delivery rule (`P-81`).
       *
       * The `Date`s above are for display and the API; these are for arithmetic. A duration
       * computed by subtracting wall-clock instants is wrong across a clock step in both
       * directions — blind going backwards, indistinguishable from silence going forwards — and
       * `CLAUDE.md` says as much: time is monotonic for scheduling, wall-clock for data. Computed
       * here rather than by the reader because this is the only place that holds both the stamps
       * and a monotonic clock.
       */
      connectedForMs: number;
      sinceResultsMs: number | null;
      sinceConfigMs: number | null;
      /** Whether the core has worked out this probe's assignments on this session (`P-82`). */
      configured: boolean;
      /** Whether it is new enough to be sent them at all (`R-06`). */
      configurable: boolean;
      /** Absent from a probe below protocol 7, which cannot report its own numbers. */
      health?: ProbeHealthReport;
    };

interface ProbeSession {
  connection: MessageConnection<ProbeToCoreMessage, CoreToProbeMessage>;
  info: ConnectedProbe;
  /**
   * Result batches from one probe are handled strictly in arrival order.
   *
   * A replaying probe streams its spool oldest-first (R-03), and the acknowledgements are what
   * it trims that spool by; handling batches concurrently would let a later one be acknowledged
   * while an earlier one was still in flight. It also bounds each probe to one write in
   * progress, which is backpressure that costs nothing to implement.
   */
  pending: Promise<void>;
  /** What this peer speaks. Config is only sent to version 3 and above. */
  protocolVersion: number;
  /**
   * Whether an administrator has approved this probe (`R-01`).
   *
   * False until the registry says otherwise, and while it is false the probe is given no
   * configuration at all — it heartbeats, it appears in the approval queue, and it scans
   * nothing. Every path that would send it work checks this rather than assuming the handshake
   * settled it, because the handshake is exactly where the decision is still in flight.
   */
  approved: boolean;
  /** The branch this probe owns, or null while its GID is unclaimed (R-01 enrols it). */
  probeObjectId: number | null;
  /** The last health report this probe sent, or undefined if it has sent none (`P-13`). */
  health?: ProbeHealthReport;
  /**
   * The configuration this session has been told to run, and its fingerprint.
   *
   * Per session, deliberately not persisted: a delta is relative to state we know the peer has,
   * and we only know that while the connection is alive. After a disconnect the answer is a
   * snapshot or `config-unchanged`, never a delta against a guess.
   */
  sentVersion: string | null;
  sentSensors: readonly SensorAssignment[];
  /**
   * When a results batch last **arrived**, on this core's wall clock (`P-74`).
   *
   * Deliberately not `result.at`: that is the probe's own timestamp for the check, and a probe
   * replaying an hour of spool sends rows stamped an hour ago while the batches themselves land
   * now. A watchdog over the probe's clock fires hardest on the probe that is recovering.
   */
  lastResultsAt: Date | null;
  /** When this probe was last given its assignments — it cannot be late with work it lacks. */
  configSentAt: Date | null;
  /**
   * The same three instants on the **monotonic** clock (`P-81`).
   *
   * The `Date`s above answer "when", which is data. These answer "how long ago", which is
   * scheduling — and a duration taken from wall-clock instants is wrong across a clock step in
   * both directions. Kept side by side rather than replacing them, because the API and the
   * `resultAge` channel genuinely want the wall-clock answer.
   */
  connectedAtNs: bigint;
  lastResultsAtNs: bigint | null;
  configSentAtNs: bigint | null;
  /** The median assigned scan interval, so the window is the probe's own cadence (`P-74`). */
  cadenceSeconds: number | null;
  /** The credential stamps that went with `sentSensors`; the delta needs them (`T-08`). */
  sentStamps: ReadonlyMap<number, string>;
}

/** Milliseconds between two readings of the monotonic clock. */
function msSinceNs(fromNs: bigint, nowNs: bigint): number {
  return Number((nowNs - fromNs) / 1_000_000n);
}

/** Constant-time comparison, so a wrong key cannot be found one character at a time. */
function keyMatches(presented: string, accepted: readonly string[]): boolean {
  const presentedBuf = Buffer.from(presented, 'utf8');
  let matched = false;
  for (const candidate of accepted) {
    const candidateBuf = Buffer.from(candidate, 'utf8');
    // Compare every candidate even after a match, so timing does not reveal which one hit.
    const equal =
      candidateBuf.byteLength === presentedBuf.byteLength &&
      timingSafeEqual(candidateBuf, presentedBuf);
    matched = matched || equal;
  }
  return matched;
}

/**
 * The core's side of the probe channel (WORKFLOW.MD §10).
 *
 * Probes dial out to us over mutual TLS and present a versioned hello. Phase 0 carries the
 * handshake and the heartbeat only; approval queues, source-IP allowlists and per-GID
 * revocation arrive with R-01, and check results with R-03. Everything an unauthenticated peer
 * can reach is bounded: the TLS client certificate, then a frame-size cap, then a handshake
 * deadline.
 */
/**
 * Sensors per configuration message.
 *
 * Two bounds sit above this and a chunk has to clear both: `config-set` refuses more than 5,000
 * sensors, and the frame decoder refuses a message over 4 MB. A thousand assignments measured
 * about 120 KB on the tree this was found on, so a chunk has roughly thirty times the headroom it
 * needs there — which is the margin that matters, because an assignment is as large as its
 * parameters and a `rest.custom` with many mappings or an `exe.script.advanced` carrying a script
 * is worth many times an `icmp.ping`.
 */
/**
 * The middle scan interval of what a probe was assigned (`P-74`).
 *
 * The median rather than the mean, because one daily sensor among five hundred ten-second ones
 * must not drag the window out to where a real stall goes unnoticed for hours — and the reverse,
 * one fast sensor pulling the window in under a slow probe's own period, would call a probe late
 * for keeping exactly to the schedule it was given.
 */
function medianInterval(sensors: readonly SensorAssignment[]): number | null {
  if (sensors.length === 0) return null;
  const seconds = sensors.map((one) => one.intervalSeconds).sort((a, b) => a - b);
  return seconds[Math.floor(seconds.length / 2)] ?? null;
}

const CONFIG_CHUNK_SENSORS = 1_000;

/**
 * How long a probe has to answer `bye` before its socket is taken from under it (`P-67`).
 *
 * Long enough for a frame and a FIN to cross a WAN link to a remote probe, short enough that an
 * operator restarting the core does not think it has wedged. A well-behaved probe closes in
 * milliseconds and never sees this.
 */
const SHUTDOWN_GRACE_MS = 1_000;

/** `items` in runs of `size`, the last one short. Never an empty chunk, even for no items. */
function chunked<T>(items: readonly T[], size: number): (readonly T[])[] {
  if (items.length === 0) return [[]];
  const out: (readonly T[])[] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

export class ProbeEndpoint {
  readonly #options: ProbeEndpointOptions;
  readonly #logger: Logger;
  readonly #sessions = new Map<string, ProbeSession>();
  /**
   * Every accepted socket, so shutdown cannot be held open by one that will not answer (`P-67`).
   *
   * `#sessions` is not this set and never was: it holds approved sessions only, so a peer
   * mid-handshake, one left pending approval, and one whose session was superseded are all live
   * sockets that nothing in it points at. `Server.close()` waits for every one of them.
   */
  readonly #sockets = new Set<Socket>();
  #server: Server | undefined;

  constructor(options: ProbeEndpointOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: 'probe-endpoint' });
  }

  get connectedProbes(): ConnectedProbe[] {
    return [...this.#sessions.values()].map((session) => ({ ...session.info }));
  }

  /** Resolves once the listener is accepting connections. */
  async start(): Promise<AddressInfo> {
    const { config } = this.#options;

    const tls = loadTlsMaterial(config.tls, 'probeEndpoint.tls');

    const server = createServer({
      cert: tls.cert,
      key: tls.key,
      ca: tls.ca,
      // Mutual TLS: a probe must present a certificate our CA signed.
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });

    // **Tracked at `connection`, not `secureConnection`** (`P-70`). `P-67` did the latter, which
    // leaves out the connection that matters most: a peer that opens a TCP socket and never
    // starts a TLS handshake is never handed to `secureConnection`, so nothing knew about it and
    // `server.close()` waited on it for ever — the very hang `P-67` was fixing, through the one
    // door it left open. `connection` fires for every accepted socket, and destroying the raw
    // socket takes the TLS one with it.
    server.on('connection', (socket: Socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => {
        this.#sockets.delete(socket);
      });
    });
    server.on('secureConnection', (socket) => {
      this.#accept(socket);
    });
    server.on('tlsClientError', (error, socket) => {
      this.#logger.warn(
        { err: describeError(error), remoteAddress: socket.remoteAddress ?? 'unknown' },
        'TLS handshake with a probe failed',
      );
    });
    server.on('error', (error) => {
      this.#logger.error({ err: describeError(error) }, 'probe endpoint error');
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    this.#server = server;
    const address = server.address() as AddressInfo;
    this.#logger.info(
      { host: address.address, port: address.port, requireAccessKey: config.accessKeys.length > 0 },
      'probe endpoint listening',
    );
    return address;
  }

  async stop(): Promise<void> {
    for (const [gid, session] of this.#sessions) {
      session.connection.close('core shutting down', { type: 'bye', reason: 'core shutting down' });
      this.#sessions.delete(gid);
    }

    const server = this.#server;
    if (server === undefined) return;
    this.#server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      // **`close()` waits for every open connection, and `close()` above only asks.** A session
      // is ended, not destroyed, so a probe that never answers our FIN keeps its half of the
      // socket open for ever and the shutdown never completes — a service that has to be
      // SIGKILLed, on the restart where a probe is wedged, which is the restart most likely to
      // be happening because a probe is wedged. The grace is for the `bye` to reach a probe that
      // *is* listening; after it, anything still here is not coming back (`P-67`).
      const grace = setTimeout(() => {
        for (const socket of this.#sockets) socket.destroy();
        this.#sockets.clear();
      }, SHUTDOWN_GRACE_MS);
      grace.unref();
    });
    this.#logger.info('probe endpoint stopped');
  }

  #accept(socket: TLSSocket): void {
    const remoteAddress = socket.remoteAddress ?? 'unknown';
    const connectionLogger = this.#logger.child({ remoteAddress });
    const { config, coreVersion } = this.#options;

    let session: ProbeSession | undefined;

    // A peer that opens a socket and says nothing must not hold resources indefinitely.
    const handshakeTimer = setTimeout(() => {
      if (session === undefined) {
        connectionLogger.warn(
          { handshakeTimeoutMs: config.handshakeTimeoutMs },
          'probe did not complete the handshake in time',
        );
        connection.destroy('handshake timeout');
      }
    }, config.handshakeTimeoutMs);
    handshakeTimer.unref();

    const connection: MessageConnection<ProbeToCoreMessage, CoreToProbeMessage> =
      new MessageConnection<ProbeToCoreMessage, CoreToProbeMessage>({
        socket,
        logger: connectionLogger,
        parse: parseProbeToCore,
        // Three missed heartbeats and the probe is gone as far as we are concerned.
        idleTimeoutMs: config.heartbeatIntervalMs * 3,
        onMessage: (message) => {
          session = this.#handleMessage(message, connection, connectionLogger, session, {
            remoteAddress,
            coreVersion,
            handshakeTimer,
          });
        },
        onClose: (close) => {
          clearTimeout(handshakeTimer);
          this.#handleClose(close, session, connectionLogger);
        },
      });
  }

  #handleMessage(
    message: ProbeToCoreMessage,
    connection: MessageConnection<ProbeToCoreMessage, CoreToProbeMessage>,
    logger: Logger,
    session: ProbeSession | undefined,
    context: { remoteAddress: string; coreVersion: string; handshakeTimer: NodeJS.Timeout },
  ): ProbeSession | undefined {
    if (message.type === 'hello') {
      if (session !== undefined) {
        logger.warn('probe sent a second hello');
        connection.destroy('duplicate hello');
        return session;
      }
      clearTimeout(context.handshakeTimer);
      return this.#handleHello(message, connection, logger, context);
    }

    if (session === undefined) {
      logger.warn({ type: message.type }, 'probe sent a message before the handshake');
      connection.destroy('message before handshake');
      return undefined;
    }

    return withCorrelation({ probeGid: session.info.gid }, () => {
      switch (message.type) {
        case 'heartbeat':
          session.info.lastHeartbeatAt = new Date();
          // The probe's own numbers, when it is new enough to send them (`P-13`). Held in memory
          // beside the link, never persisted: this is a live fact about a process that is
          // currently running, and a value read back from a table after a restart would be a
          // claim about a probe this core has not spoken to yet.
          if (message.health !== undefined) session.health = message.health;
          connection.send({ type: 'heartbeat-ack', seq: message.seq });
          return session;
        case 'results':
          this.#queueResults(message, connection, logger, session);
          return session;
        case 'query-result':
          // Straight through, and never queued behind `pending`: a query has a caller holding a
          // deadline, and chaining it behind a results batch that is mid-write would spend that
          // deadline waiting for work nobody is watching.
          this.#options.queries?.deliver(message);
          return session;
        case 'config-ack':
          if (message.version !== session.sentVersion) {
            // Not fatal — the next push corrects it — but a probe running a configuration the
            // core did not send is worth a line rather than a silent divergence.
            logger.warn(
              { acked: message.version, sent: session.sentVersion },
              'probe acknowledged a configuration version the core did not send',
            );
          } else {
            logger.info(
              { version: message.version, scheduled: message.scheduled },
              'probe applied its configuration',
            );
          }
          return session;
        case 'sweep-progress':
          // Never awaited by the message loop, for the same reason results are not: a database
          // round trip must not delay the heartbeat that keeps this connection alive.
          this.#queueDiscovery(session, logger, (sink) =>
            sink.progress(message.runId, message.cursor, message.found, message.failed),
          );
          return session;
        case 'sweep-finished':
          this.#queueDiscovery(session, logger, (sink) =>
            sink.finished(message.runId, message.ending, message.cursor, message.message),
          );
          return session;
        case 'identify-progress':
          this.#queueDiscovery(session, logger, (sink) =>
            sink.identified(message.runId, message.cursor, message.found),
          );
          return session;
        case 'identify-finished':
          this.#queueDiscovery(session, logger, (sink) =>
            sink.identifyFinished(message.runId, message.ending, message.message),
          );
          return session;
        case 'bye':
          logger.info({ reason: message.reason }, 'probe disconnecting');
          connection.close(`peer said bye: ${message.reason}`);
          return session;
      }
    });
  }

  /**
   * Chains a discovery message behind whatever is already in flight for this probe (`D-01`).
   *
   * The same queue the results take, on purpose: a sweep's progress and a batch of readings
   * from the same probe are both writes, and letting them race would let a `sweep-finished`
   * land before the `sweep-progress` carrying the last hosts it found.
   */
  #queueDiscovery(
    session: ProbeSession,
    logger: Logger,
    run: (sink: DiscoverySink) => Promise<void>,
  ): void {
    const sink = this.#options.discovery;
    if (sink === undefined) return;
    session.pending = session.pending.then(async () => {
      try {
        await run(sink);
      } catch (error) {
        // A discovery write that fails must not take the connection with it: the probe is still
        // delivering readings, which matter more than a sweep does.
        logger.error(describeError(error), 'a discovery message could not be recorded');
      }
    });
  }

  /**
   * Sends a sweep message to a connected probe, by the *object* id its branch owns.
   *
   * **`offline` and `too-old` are different answers and the caller has to be able to tell them
   * apart** (`R-06`). Both used to be `false`, and the consequences diverge completely: an
   * offline probe is the ordinary case — the run stays queued and is offered again when it
   * reconnects, which is also how a probe restart resumes a sweep — while a probe that is too
   * old will never accept this message however long the run waits. Collapsing the two left such
   * a run queued forever with nothing said, which is exactly what `R-06` exists to stop.
   */
  sendSweep(probeObjectId: number, message: SweepMessage): SweepDelivery {
    for (const session of this.#sessions.values()) {
      if (session.probeObjectId !== probeObjectId) continue;
      const capability =
        message.kind === 'start' || message.kind === 'cancel' ? 'discoverySweep' : 'identification';
      if (!capabilitiesFor(session.protocolVersion)[capability]) {
        const needs = versionFor(capability);
        this.#options.logger.warn(
          { probeObjectId, protocolVersion: session.protocolVersion, needs },
          'probe is too old for this discovery stage',
        );
        return { kind: 'too-old', protocolVersion: session.protocolVersion, needs };
      }
      session.connection.send(wireFor(message));
      return { kind: 'sent' };
    }
    return { kind: 'offline' };
  }

  /**
   * Sends one on-demand query, or says why it could not (`R-09`).
   *
   * The same three answers as `sendSweep`, and for the same reason — `offline` waits, `too-old`
   * never will — with one difference that matters: nothing here queues. A sweep offered to an
   * offline probe stays queued and is offered again on reconnect, because a discovery run is
   * work the system owes. A query is a person waiting, and work nobody is waiting for any more
   * is not work.
   */
  sendQuery(
    probeObjectId: number,
    message:
      | { kind: 'ask'; queryId: string; query: ProbeQuery; timeoutMs: number }
      | { kind: 'cancel'; queryId: string },
  ): { kind: 'sent' } | { kind: 'offline' } | { kind: 'too-old'; protocolVersion: number } {
    for (const session of this.#sessions.values()) {
      if (session.probeObjectId !== probeObjectId) continue;
      if (!capabilitiesFor(session.protocolVersion).onDemandQuery) {
        return { kind: 'too-old', protocolVersion: session.protocolVersion };
      }
      session.connection.send(
        message.kind === 'ask'
          ? {
              type: 'query',
              queryId: message.queryId,
              query: message.query,
              timeoutMs: message.timeoutMs,
            }
          : { type: 'query-cancel', queryId: message.queryId },
      );
      return { kind: 'sent' };
    }
    return { kind: 'offline' };
  }

  /**
   * Chains a results batch behind whatever is already in flight for this probe.
   *
   * Never awaited by the message loop: a write that takes a moment must not stop the same
   * probe's heartbeats from being answered, or the connection would be declared idle and torn
   * down by the very backlog we are working through.
   */
  /**
   * What this probe was told to scan, and the two clocks that go with it.
   *
   * One place, because `sentSensors` is set from two branches and a cadence that disagreed with
   * the list it was derived from would give a window for work the probe is not doing (`P-74`).
   */
  #noteAssignments(
    session: ProbeSession,
    sensors: readonly SensorAssignment[],
    sent: boolean,
  ): void {
    session.sentSensors = sensors;
    session.cadenceSeconds = medianInterval(sensors);
    // **Only when the probe was actually given something** (`P-77`). `pushAllConfigs` runs on any
    // change anywhere in the tree — a schedule window opening, a dependency pausing — and most of
    // those recompute to the version the probe already has. Stamping the clock there postponed
    // the delivery window on every connected probe every time anything moved, so on an
    // installation with ordinary config churn the watchdog could never fire.
    if (sent) {
      session.configSentAt = new Date();
      session.configSentAtNs = process.hrtime.bigint();
    }
  }

  #queueResults(
    message: Extract<ProbeToCoreMessage, { type: 'results' }>,
    connection: MessageConnection<ProbeToCoreMessage, CoreToProbeMessage>,
    logger: Logger,
    session: ProbeSession,
  ): void {
    // **Stamped on arrival, before anything is written.** The clock is when the batch landed, not
    // when it finished being ingested, so a slow write cannot make a delivering probe look silent.
    if (message.results.length > 0) {
      session.lastResultsAt = new Date();
      session.lastResultsAtNs = process.hrtime.bigint();
    }
    const receiver = this.#options.results;
    if (receiver === undefined) {
      logger.warn({ batchId: message.batchId }, 'results arrived before ingestion was wired up');
      connection.send({
        type: 'results-nack',
        batchId: message.batchId,
        reason: 'unavailable',
        retryAfterMs: 5_000,
      });
      return;
    }

    session.pending = session.pending.then(async () => {
      // Chained behind the admission, so this reads the settled answer rather than racing it.
      // An unapproved probe has no assignments and so nothing to report — this is defence in
      // depth rather than an expected path, and `invalid` because retrying will not help: what
      // the probe needs is a person, not a longer backoff.
      if (!session.approved) {
        logger.warn(
          { batchId: message.batchId },
          'results arrived from a probe that has not been approved',
        );
        connection.send({
          type: 'results-nack',
          batchId: message.batchId,
          reason: 'invalid',
          retryAfterMs: 0,
        });
        return;
      }
      try {
        connection.send(await receiver.acceptResults(session.info.gid, message));
      } catch (error: unknown) {
        // The receiver is not supposed to throw. If it does, the probe still needs an answer —
        // an unanswered batch is one the probe holds for ever.
        logger.error(
          { err: describeError(error), batchId: message.batchId },
          'storing a results batch failed unexpectedly',
        );
        connection.send({
          type: 'results-nack',
          batchId: message.batchId,
          reason: 'storage-error',
          retryAfterMs: 5_000,
        });
      }
    });
  }

  #handleHello(
    hello: Extract<ProbeToCoreMessage, { type: 'hello' }>,
    connection: MessageConnection<ProbeToCoreMessage, CoreToProbeMessage>,
    logger: Logger,
    context: { remoteAddress: string; coreVersion: string },
  ): ProbeSession | undefined {
    const { config } = this.#options;

    const reject = (code: RejectCode, detail: string): void => {
      logger.warn({ code, detail, gid: hello.gid }, 'rejecting probe');
      connection.close(`rejected: ${code}`, { type: 'reject', code, message: detail });
    };

    const { registry } = this.#options;

    // Without a registry the endpoint keeps the pre-`R-01` behaviour: whoever presents the
    // shared key is trusted. `main.ts` always passes one; this path is what the transport's own
    // tests drive, and leaving it in means those tests are not secretly testing the registry.
    if (registry === undefined) {
      // **The version check lives in the registry now** (`R-06`), because a refusal that leaves
      // no row is the one that takes a day to find. There is nothing to write a row against
      // here, so this branch keeps the check itself — the asymmetry is the point rather than an
      // oversight.
      if (!isProtocolCompatible(hello.protocolVersion)) {
        reject('protocol-version', explainSkew(describeSkew(hello.protocolVersion)));
        return undefined;
      }
      if (config.accessKeys.length > 0 && !keyMatches(hello.accessKey, config.accessKeys)) {
        reject('bad-access-key', 'the access key was not accepted');
        return undefined;
      }
      const gid = hello.gid === '' ? randomUUID() : hello.gid;
      // **One session per probe here too** (`P-65`). `#openSession` overwrites the map entry, so
      // without this the old connection is merely orphaned: nothing points at it and nothing
      // closes it, and it lives on until its idle timer fires three heartbeats later. The
      // registry branch below has always done this; the asymmetry was invisible because the test
      // that names the behaviour drives *this* branch, and passed on that idle timer instead.
      const superseded = this.#sessions.get(gid);
      if (superseded !== undefined) {
        logger.info({ gid }, 'replacing an existing session for this probe');
        superseded.connection.destroy('superseded by a newer connection');
      }
      const session = this.#openSession(gid, hello, connection, context, true);
      this.#welcome(session, connection, context, true);
      logger.info(
        { gid, displayName: hello.displayName, assignedIdentity: hello.gid === '' },
        'probe connected',
      );
      this.#queueConfig(session, logger, hello.configVersion ?? '');
      return session;
    }

    // **The session exists before the decision does, and it has to.** Asking the registry is a
    // database round trip, and messages keep arriving during it — a probe that says hello and
    // then heartbeats would otherwise be torn down for "a message before the handshake". So the
    // session is opened unapproved, every later message is chained behind the admission through
    // `pending`, and nothing is sent to the probe until the answer is in.
    const session = this.#openSession(hello.gid, hello, connection, context, false);

    session.pending = (async () => {
      let decision: Awaited<ReturnType<ProbeAdmission['admit']>>;
      try {
        decision = await registry.admit({
          gid: hello.gid,
          displayName: hello.displayName,
          agentVersion: hello.agentVersion,
          protocolVersion: hello.protocolVersion,
          accessKey: hello.accessKey,
          remoteAddress: context.remoteAddress,
        });
      } catch (error) {
        // A registry that cannot answer is not permission to come in. The probe retries, which
        // is the right behaviour for a core whose database is briefly unreachable.
        logger.error(describeError(error), 'the probe registry could not be asked');
        reject('internal-error', 'this core cannot check probe registrations right now');
        return;
      }

      if (decision.kind === 'refused') {
        reject(decision.code, decision.detail);
        return;
      }

      session.info.gid = decision.gid;
      session.approved = decision.kind === 'approved';

      // **The socket may have gone while `admit` was in flight** (`P-80`). `admit` is three
      // database round trips, and `MessageConnection.destroy` runs `onClose` synchronously — so
      // `#handleClose` has already fired, with `probeObjectId` still null and the session not yet
      // in `#sessions`, which means it removed nothing and told reachability nothing. Installing
      // the dead session here left it reported `connected: true` for ever, `found()` putting its
      // sensors back to Up for a probe with no socket, and `#handleClose` never running again:
      // `R-05`'s one promise — that the core reports a probe's absence because the probe cannot —
      // broken permanently for that probe.
      if (connection.closed) {
        logger.info({ gid: decision.gid }, 'the probe disconnected while it was being admitted');
        return;
      }

      const existing = this.#sessions.get(decision.gid);
      if (existing !== undefined && existing !== session) {
        // A reconnect after a network partition: the old socket is stale by definition.
        logger.info({ gid: decision.gid }, 'replacing an existing session for this probe');
        existing.connection.destroy('superseded by a newer connection');
        this.#sessions.delete(decision.gid);
      }
      this.#sessions.set(decision.gid, session);

      this.#welcome(
        session,
        connection,
        context,
        session.approved,
        decision.kind === 'approved' ? decision.issuedKey : undefined,
      );

      logger.info(
        {
          gid: decision.gid,
          displayName: hello.displayName,
          agentVersion: hello.agentVersion,
          approved: session.approved,
          assignedIdentity: hello.gid === '',
        },
        session.approved ? 'probe connected' : 'probe connected and is waiting for approval',
      );

      // **An unapproved probe is sent nothing**, which is the whole of what approval means
      // here: it holds an identity and a heartbeat and no work at all.
      if (session.approved) this.#queueConfig(session, logger, hello.configVersion ?? '');
    })();

    return session;
  }

  /** The session object, before anyone has decided whether it may do anything. */
  #openSession(
    gid: string,
    hello: Extract<ProbeToCoreMessage, { type: 'hello' }>,
    connection: MessageConnection<ProbeToCoreMessage, CoreToProbeMessage>,
    context: { remoteAddress: string },
    approved: boolean,
  ): ProbeSession {
    const session: ProbeSession = {
      connection,
      info: {
        gid,
        displayName: hello.displayName,
        agentVersion: hello.agentVersion,
        remoteAddress: context.remoteAddress,
        connectedAt: new Date(),
        lastHeartbeatAt: null,
      },
      pending: Promise.resolve(),
      protocolVersion: hello.protocolVersion,
      approved,
      probeObjectId: null,
      sentVersion: null,
      sentSensors: [],
      lastResultsAt: null,
      configSentAt: null,
      connectedAtNs: process.hrtime.bigint(),
      lastResultsAtNs: null,
      configSentAtNs: null,
      cadenceSeconds: null,
      sentStamps: new Map(),
    };
    if (approved && gid !== '') this.#sessions.set(gid, session);
    return session;
  }

  #welcome(
    session: ProbeSession,
    connection: MessageConnection<ProbeToCoreMessage, CoreToProbeMessage>,
    context: { coreVersion: string },
    approved: boolean,
    issuedKey?: string,
  ): void {
    connection.send({
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      coreVersion: context.coreVersion,
      gid: session.info.gid,
      heartbeatIntervalMs: this.#options.config.heartbeatIntervalMs,
      approved,
      ...(issuedKey === undefined ? {} : { accessKey: issuedKey }),
    });
  }

  /**
   * Works out what this probe should be scanning and sends it whatever it does not already have.
   *
   * One path for both cases. `presented` is the fingerprint from a handshake, or `undefined`
   * when this is a push into a live session — the only differences being that a handshake gets
   * an explicit `config-unchanged` where a push stays silent, and that a session with nothing
   * sent yet gets a snapshot because there is nothing to diff against.
   *
   * Never awaited by the message loop: a database round trip must not delay the heartbeat that
   * keeps the connection from being declared idle.
   */
  #queueConfig(session: ProbeSession, logger: Logger, presented?: string): void {
    const source = this.#options.probeConfig;
    if (source === undefined) return;
    // **The approval check lives here rather than at each call site** (`R-01`). Configuration
    // reaches a probe from four places — the handshake, a config change, a credential change and
    // the periodic sweep — and a check repeated four times is a check three of them can be
    // written without. An unapproved probe scans nothing because this is the only door.
    if (!session.approved) return;
    // **A probe that cannot be sent configuration scans nothing, and that has to be loud**
    // (`R-06`). It connects, it heartbeats, and every health signal says the link is fine while
    // no sensor under it is ever checked — the quietest failure this system has. `warn` rather
    // than `info` because nothing about it is routine, and the skew is recorded against the
    // registration as well, so it is answerable from the probes page and not only from a log
    // somebody would have to already suspect.
    if (!capabilitiesFor(session.protocolVersion).configPush) {
      if (presented !== undefined) {
        logger.warn(
          {
            protocolVersion: session.protocolVersion,
            needs: versionFor('configPush'),
            skew: explainSkew(describeSkew(session.protocolVersion)),
          },
          'probe is too old for configuration push; it will scan nothing',
        );
      }
      return;
    }

    session.pending = session.pending.then(async () => {
      try {
        // Re-resolved while unclaimed, because enrolment happens *after* a probe connects
        // (R-01): a session that found no branch at the handshake is exactly the one that might
        // have been given one since. Once claimed, it is not looked up again.
        if (session.probeObjectId === null) {
          session.probeObjectId = await source.probeObjectFor(session.info.gid);
          if (session.probeObjectId !== null) {
            // Best-effort, and its own catch (`P-80`). `touch` is one `UPDATE ... last_seen_at`
            // documented as unable to fail a handshake, but a rejection landed in the outer catch
            // — skipping `found()` below. Because the guard that re-runs this block is
            // `probeObjectId === null` and the field is already set, `found()` would never be
            // called again for the life of the session: the probe's sensors stayed Unknown with
            // reason 'link' while it delivered normally, every arriving result re-decided against
            // an overlay saying its probe was unreachable. The delivery sweep cannot rescue that
            // either — it reads `marked === 'link'` and correctly leaves `R-05`'s probes alone.
            try {
              await source.touch(session.probeObjectId);
            } catch (error: unknown) {
              logger.warn(
                { probeObjectId: session.probeObjectId, ...describeError(error) },
                'could not record this probe’s last-seen time; continuing',
              );
            }
            logger.info({ probeObjectId: session.probeObjectId }, 'probe claimed a branch');
            // Its sensors go back to their last reading (`R-05`). Here rather than at the
            // handshake, because this is the moment the *branch* is known — a session without
            // one was never carrying sensors, so there is nothing to bring back.
            const reachability = this.#options.reachability;
            if (reachability !== undefined) {
              void reachability.found(session.probeObjectId).catch((error: unknown) => {
                logger.error(describeError(error), 'could not restore this probe’s sensors');
              });
            }
            // A probe that has just claimed its branch may have a sweep waiting, and a
            // reconnecting one almost certainly does — a run left `queued` by the disconnect
            // below. Offering it here rather than on a timer is what makes a resume immediate.
            this.#offerSweep(session.probeObjectId, logger);
          } else if (presented !== undefined) {
            // Not an error: an unenrolled probe is the ordinary state of a freshly installed
            // one. Saying so once at the handshake beats silence, which a probe cannot tell
            // apart from a core that never answered.
            logger.info(
              { gid: session.info.gid },
              'no probe object claims this GID; sending an empty configuration',
            );
          }
        }

        const assignments =
          session.probeObjectId === null
            ? EMPTY_ASSIGNMENTS
            : await source.assignmentsFor(session.probeObjectId);

        const held = presented ?? session.sentVersion;
        if (assignments.version === held) {
          session.sentVersion = assignments.version;
          this.#noteAssignments(session, assignments.sensors, false);
          session.sentStamps = assignments.stamps;
          if (presented !== undefined) {
            session.connection.send({ type: 'config-unchanged', version: assignments.version });
            logger.info({ version: assignments.version }, 'probe configuration is already current');
          }
          return;
        }

        // Nothing sent on this connection yet means nothing to diff against: a delta is only
        // ever relative to state we know the peer has.
        const delta =
          session.sentVersion === null
            ? null
            : diffAssignments(
                session.sentSensors,
                assignments.sensors,
                session.sentStamps,
                assignments.stamps,
              );

        session.sentVersion = assignments.version;
        this.#noteAssignments(session, assignments.sensors, true);
        session.sentStamps = assignments.stamps;

        // Only the upserts are weighed against the snapshot: a removal is an integer, an upsert
        // is a whole assignment, and counting them alike would turn "one sensor deleted from a
        // set of three" into a full resend.
        const worthADelta =
          delta !== null &&
          !(delta.upserted.length >= assignments.sensors.length && assignments.sensors.length > 0);

        if (delta !== null && worthADelta) {
          session.connection.send({ type: 'config-delta', version: assignments.version, ...delta });
          logger.info(
            {
              version: assignments.version,
              upserted: delta.upserted.length,
              removed: delta.removed.length,
            },
            'sent a configuration delta',
          );
          return;
        }

        // **A full push is chunked, and at the v1 target it has to be.** `config-set` caps
        // `sensors` at 5,000 and the frame decoder refuses anything over 4 MB — and
        // `CAPABILITIES.MD` §13 puts the v1 target at 5,000 sensors, so an installation *at its
        // own documented size* produced a message its probe refused. The failure was not a bad
        // message but a wedge: reconnect, receive the same oversized set, close on a protocol
        // violation, reconnect — 426 closures in three minutes, and a probe that could never come
        // back. It needed a probe restart to show, which is why 24 hours of soak with the same
        // 5,047 sensors never hit it.
        //
        // No protocol change: the probe already applies a `config-set` as a replacement and a
        // `config-delta` as an upsert, so the first chunk is the set and the rest are deltas
        // carrying the same version. The end state is identical to one oversized message.
        const chunks = chunked(assignments.sensors, CONFIG_CHUNK_SENSORS);
        const [first = [], ...rest] = chunks;
        session.connection.send({
          type: 'config-set',
          version: assignments.version,
          sensors: [...first],
        });
        for (const chunk of rest) {
          session.connection.send({
            type: 'config-delta',
            version: assignments.version,
            upserted: [...chunk],
            removed: [],
          });
        }
        logger.info(
          {
            version: assignments.version,
            sensors: assignments.sensors.length,
            ...(rest.length === 0 ? {} : { messages: chunks.length }),
          },
          'sent probe configuration',
        );
      } catch (error: unknown) {
        // A probe with no configuration scans nothing, which is visible; a probe that never
        // learns why is not. The connection stays up: results and heartbeats are unaffected.
        logger.error(
          { ...describeError(error), gid: session.info.gid },
          'could not build this probe\u2019s configuration',
        );
      }
    });
  }

  /** Every connected probe. Unchanged configurations send nothing at all. */
  /**
   * What the core knows about one probe's link, right now (`P-13`).
   *
   * **Answers for a probe that is not connected**, and that is the point of it: the whole reason
   * Probe Health is evaluated by the core rather than run on the probe is that a probe cannot
   * report its own absence. A missing session is not an error here — it is the most important
   * answer this method gives.
   */
  linkFor(probeObjectId: number): ProbeLink {
    const nowNs = process.hrtime.bigint();
    for (const session of this.#sessions.values()) {
      if (session.probeObjectId !== probeObjectId) continue;
      return {
        connected: true,
        protocolVersion: session.protocolVersion,
        connectedAt: session.info.connectedAt,
        lastHeartbeatAt: session.info.lastHeartbeatAt,
        approved: session.approved,
        agentVersion: session.info.agentVersion,
        assignedSensors: session.sentSensors.length,
        cadenceSeconds: session.cadenceSeconds,
        lastResultsAt: session.lastResultsAt,
        configSentAt: session.configSentAt,
        connectedForMs: msSinceNs(session.connectedAtNs, nowNs),
        sinceResultsMs:
          session.lastResultsAtNs === null ? null : msSinceNs(session.lastResultsAtNs, nowNs),
        sinceConfigMs:
          session.configSentAtNs === null ? null : msSinceNs(session.configSentAtNs, nowNs),
        // `sentVersion` rather than `sentSensors.length`: the empty set a session opens with is
        // indistinguishable from a probe that legitimately has nothing, and telling those two
        // apart is the whole of `P-82`.
        configured: session.sentVersion !== null,
        configurable: capabilitiesFor(session.protocolVersion).configPush,
        ...(session.health === undefined ? {} : { health: session.health }),
      };
    }
    return { connected: false };
  }

  pushAllConfigs(): void {
    for (const session of this.#sessions.values()) {
      this.#queueConfig(session, this.#options.logger.child({ probeGid: session.info.gid }));
    }
  }

  /** One branch, for a caller that knows which one changed. */
  pushConfig(probeObjectId: number): void {
    for (const session of this.#sessions.values()) {
      if (session.probeObjectId !== probeObjectId) continue;
      this.#queueConfig(session, this.#options.logger.child({ probeGid: session.info.gid }));
    }
  }

  /** Fire-and-forget, because the config push it sits inside must not wait on discovery. */
  #offerSweep(probeObjectId: number, logger: Logger): void {
    const sink = this.#options.discovery;
    if (sink === undefined) return;
    void sink.pump(probeObjectId).catch((error: unknown) => {
      logger.error(describeError(error), 'could not offer a discovery sweep to this probe');
    });
  }

  #handleClose(close: ConnectionClose, session: ProbeSession | undefined, logger: Logger): void {
    if (session !== undefined && this.#sessions.get(session.info.gid) === session) {
      this.#sessions.delete(session.info.gid);
    }
    // A run this probe was doing goes back to `queued`, not `failed`: a probe that dropped is
    // coming back, and its sweep is a cursor away from continuing. Marking it failed would make
    // an operator restart a sweep that only needed to wait.
    const sink = this.#options.discovery;
    if (sink !== undefined && session?.probeObjectId != null) {
      void sink.probeDisconnected(session.probeObjectId).catch((error: unknown) => {
        logger.error(describeError(error), 'could not release this probe’s discovery runs');
      });
    }

    // The sensors this probe carried are Unknown from now on, not Down: nobody has asked them
    // anything (`R-05`). Only for a probe that had actually claimed a branch — an unapproved or
    // unclaimed session was never carrying anything.
    const reachability = this.#options.reachability;
    if (reachability !== undefined && session?.probeObjectId != null) {
      void reachability.lost(session.probeObjectId).catch((error: unknown) => {
        logger.error(describeError(error), 'could not mark this probe’s sensors as Unknown');
      });
    }
    // Anyone waiting on this probe learns now rather than at their own deadline: the socket
    // that would have carried the answer has gone, and waiting out a timeout for a fact the
    // core already knows is the slowest possible way to be told it (`R-09`).
    if (session?.probeObjectId != null) {
      this.#options.queries?.probeDisconnected(session.probeObjectId);
    }
    logger.info(
      { cause: close.cause, detail: close.detail, gid: session?.info.gid ?? null },
      'probe connection closed',
    );
  }
}

/** One place that knows what a dispatch means on the wire, so no caller has to. */
function wireFor(message: SweepMessage): CoreToProbeMessage {
  switch (message.kind) {
    case 'start':
      return { type: 'sweep-start', job: message.job };
    case 'cancel':
      return { type: 'sweep-cancel', runId: message.runId };
    case 'identify':
      return { type: 'identify-start', job: message.job };
    case 'identify-cancel':
      return { type: 'identify-cancel', runId: message.runId };
  }
}
