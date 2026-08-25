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
} from '@ms/shared';

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

export interface ProbeEndpointOptions {
  config: CoreConfig['probeEndpoint'];
  logger: Logger;
  coreVersion: string;
  /** Absent until ingestion is wired up; results are then refused with `unavailable`. */
  results?: ResultReceiver;
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
        case 'bye':
          logger.info({ reason: message.reason }, 'probe disconnecting');
          connection.close(`peer said bye: ${message.reason}`);
          return session;
      }
    });
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
    return session;
  }

  #handleClose(close: ConnectionClose, session: ProbeSession | undefined, logger: Logger): void {
    if (session !== undefined && this.#sessions.get(session.info.gid) === session) {
      this.#sessions.delete(session.info.gid);
    }
    logger.info(
      { cause: close.cause, detail: close.detail, gid: session?.info.gid ?? null },
      'probe connection closed',
    );
  }
}
