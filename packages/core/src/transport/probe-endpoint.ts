import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type TLSSocket } from 'node:tls';
import type { AddressInfo } from 'node:net';
import {
  describeError,
  isProtocolCompatible,
  loadTlsMaterial,
  MessageConnection,
  parseProbeToCore,
  PROTOCOL_VERSION,
  withCorrelation,
  type ConnectionClose,
  type CoreConfig,
  type CoreToProbeMessage,
  type Logger,
  type ProbeToCoreMessage,
  type RejectCode,
  type SensorAssignment,
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

export interface DiscoverySink {
  /** A probe with this branch has connected, or reconnected. Offer it whatever it should run. */
  pump(probeObjectId: number): Promise<void>;
  progress(
    runId: number,
    cursor: number,
    found: readonly SweepHost[],
    failed: number,
  ): Promise<void>;
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
}

export interface ConnectedProbe {
  gid: string;
  displayName: string;
  agentVersion: string;
  remoteAddress: string;
  connectedAt: Date;
  lastHeartbeatAt: Date | null;
}

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
  /** The branch this probe owns, or null while its GID is unclaimed (R-01 enrols it). */
  probeObjectId: number | null;
  /**
   * The configuration this session has been told to run, and its fingerprint.
   *
   * Per session, deliberately not persisted: a delta is relative to state we know the peer has,
   * and we only know that while the connection is alive. After a disconnect the answer is a
   * snapshot or `config-unchanged`, never a delta against a guess.
   */
  sentVersion: string | null;
  sentSensors: readonly SensorAssignment[];
  /** The credential stamps that went with `sentSensors`; the delta needs them (`T-08`). */
  sentStamps: ReadonlyMap<number, string>;
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
export class ProbeEndpoint {
  readonly #options: ProbeEndpointOptions;
  readonly #logger: Logger;
  readonly #sessions = new Map<string, ProbeSession>();
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
          connection.send({ type: 'heartbeat-ack', seq: message.seq });
          return session;
        case 'results':
          this.#queueResults(message, connection, logger, session);
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
   * Returns false when that probe is not connected, which is not a failure: the run stays
   * queued and is offered again when it reconnects. That path is also how a probe restart
   * resumes a sweep, so it is the ordinary one rather than the exception.
   */
  sendSweep(probeObjectId: number, message: SweepStart | SweepCancel): boolean {
    for (const session of this.#sessions.values()) {
      if (session.probeObjectId !== probeObjectId) continue;
      if (session.protocolVersion < 4) {
        this.#options.logger.warn(
          { probeObjectId, protocolVersion: session.protocolVersion },
          'probe is too old to run a discovery sweep',
        );
        return false;
      }
      session.connection.send(
        message.kind === 'start'
          ? { type: 'sweep-start', job: message.job }
          : { type: 'sweep-cancel', runId: message.runId },
      );
      return true;
    }
    return false;
  }

  /**
   * Chains a results batch behind whatever is already in flight for this probe.
   *
   * Never awaited by the message loop: a write that takes a moment must not stop the same
   * probe's heartbeats from being answered, or the connection would be declared idle and torn
   * down by the very backlog we are working through.
   */
  #queueResults(
    message: Extract<ProbeToCoreMessage, { type: 'results' }>,
    connection: MessageConnection<ProbeToCoreMessage, CoreToProbeMessage>,
    logger: Logger,
    session: ProbeSession,
  ): void {
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

    // Version skew is reported, never silently tolerated (TASKS.md R-06).
    if (!isProtocolCompatible(hello.protocolVersion)) {
      reject(
        'protocol-version',
        `probe speaks protocol ${String(hello.protocolVersion)}, core speaks ${String(PROTOCOL_VERSION)}`,
      );
      return undefined;
    }

    if (config.accessKeys.length > 0 && !keyMatches(hello.accessKey, config.accessKeys)) {
      reject('bad-access-key', 'the access key was not accepted');
      return undefined;
    }

    // A probe connecting for the first time has no identity yet; the core issues one.
    const gid = hello.gid === '' ? randomUUID() : hello.gid;

    const existing = this.#sessions.get(gid);
    if (existing !== undefined) {
      // A reconnect after a network partition: the old socket is stale by definition.
      logger.info({ gid }, 'replacing an existing session for this probe');
      existing.connection.destroy('superseded by a newer connection');
      this.#sessions.delete(gid);
    }

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
      probeObjectId: null,
      sentVersion: null,
      sentSensors: [],
      sentStamps: new Map(),
    };
    this.#sessions.set(gid, session);

    connection.send({
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      coreVersion: context.coreVersion,
      gid,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
    });

    logger.info(
      {
        gid,
        displayName: hello.displayName,
        agentVersion: hello.agentVersion,
        assignedIdentity: hello.gid === '',
      },
      'probe connected',
    );

    // Fire and forget, chained behind anything already queued for this probe: the handshake
    // must not wait on a database round trip, and a heartbeat answered late is a connection
    // torn down for being idle.
    this.#queueConfig(session, logger, hello.configVersion ?? '');

    return session;
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
    if (session.protocolVersion < 3) {
      if (presented !== undefined) {
        logger.info(
          { protocolVersion: session.protocolVersion },
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
            await source.touch(session.probeObjectId);
            logger.info({ probeObjectId: session.probeObjectId }, 'probe claimed a branch');
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
          session.sentSensors = assignments.sensors;
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
        session.sentSensors = assignments.sensors;
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

        session.connection.send({
          type: 'config-set',
          version: assignments.version,
          sensors: [...assignments.sensors],
        });
        logger.info(
          { version: assignments.version, sensors: assignments.sensors.length },
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
    logger.info(
      { cause: close.cause, detail: close.detail, gid: session?.info.gid ?? null },
      'probe connection closed',
    );
  }
}
