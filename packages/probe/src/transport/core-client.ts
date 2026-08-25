import { connect, type TLSSocket } from 'node:tls';
import {
  describeError,
  isProtocolCompatible,
  loadTlsMaterial,
  MessageConnection,
  parseCoreToProbe,
  PROTOCOL_VERSION,
  type ConnectionClose,
  type CoreToProbeMessage,
  type Logger,
  type ProbeConfig,
  type ProbeToCoreMessage,
} from '@ms/shared';
import { Backoff } from './backoff.js';

export type LinkState = 'disconnected' | 'connecting' | 'handshaking' | 'connected';

export interface CoreClientOptions {
  config: ProbeConfig;
  logger: Logger;
  agentVersion: string;
  /** Reported on Probe Health (P-13) and used by the spool to decide whether to drain. */
  onStateChange?: (state: LinkState) => void;
  random?: () => number;
}

/**
 * The probe's side of the channel. The probe always dials **out** (WORKFLOW.MD §10), so a
 * remote site needs no inbound firewall rule.
 *
 * Losing the core is a normal condition, not an error: the probe keeps scanning and spools
 * results to disk (R-02), then reconnects with backoff and replays (R-03). Phase 0 establishes
 * and holds the link; the spool arrives with Phase 8.
 */
export class CoreClient {
  readonly #options: CoreClientOptions;
  readonly #logger: Logger;
  readonly #backoff: Backoff;

  #connection: MessageConnection<CoreToProbeMessage, ProbeToCoreMessage> | undefined;
  #socket: TLSSocket | undefined;
  #state: LinkState = 'disconnected';
  #gid: string;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #heartbeatSeq = 0;
  #stopped = false;
  /** Set when the core rejects us for a reason retrying cannot fix. */
  #fatalRejection: string | undefined;

  constructor(options: CoreClientOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: 'core-client' });
    this.#gid = options.config.probe.gid;
    this.#backoff = new Backoff({
      minDelayMs: options.config.core.reconnectMinDelayMs,
      maxDelayMs: options.config.core.reconnectMaxDelayMs,
      ...(options.random === undefined ? {} : { random: options.random }),
    });
  }

  get state(): LinkState {
    return this.#state;
  }

  /** The identity the core assigned, once known. */
  get gid(): string {
    return this.#gid;
  }

  start(): void {
    this.#stopped = false;
    this.#connectNow();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#clearTimers();

    const connection = this.#connection;
    if (connection !== undefined && !connection.closed) {
      connection.close('probe shutting down', { type: 'bye', reason: 'probe shutting down' });
      // Give the bye a moment to leave the socket before the process exits.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        timer.unref();
      });
    }
    this.#socket?.destroy();
    this.#setState('disconnected');
  }

  #setState(state: LinkState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#options.onStateChange?.(state);
  }

  #connectNow(): void {
    if (this.#stopped) return;
    const { core } = this.#options.config;
    this.#setState('connecting');

    // Unreadable certificates are an operator problem that an operator can fix while we are
    // running. Retry rather than exiting: a probe that gives up needs a human to notice.
    let tls;
    try {
      tls = loadTlsMaterial(core.tls, 'core.tls');
    } catch (error) {
      this.#logger.error({ err: describeError(error) }, 'cannot load the probe certificates');
      this.#setState('disconnected');
      this.#scheduleReconnect();
      return;
    }

    const socket = connect({
      host: core.host,
      port: core.port,
      cert: tls.cert,
      key: tls.key,
      ca: tls.ca,
      // The core must prove itself too — a probe streams monitoring data outward and must not
      // hand it to whoever answers the port.
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
    this.#socket = socket;

    socket.once('secureConnect', () => {
      if (!socket.authorized) {
        this.#logger.error(
          { reason: describeError(socket.authorizationError).message },
          'core presented an untrusted certificate',
        );
        socket.destroy();
        return;
      }
      this.#onSecureConnect(socket);
    });

    socket.once('error', (error) => {
      this.#logger.warn(
        { err: describeError(error), core: `${core.host}:${String(core.port)}` },
        'connection to core failed',
      );
      // 'close' follows and schedules the retry; nothing else to do here.
    });

    socket.once('close', () => {
      if (this.#connection === undefined) this.#scheduleReconnect();
    });
  }

  #onSecureConnect(socket: TLSSocket): void {
    const { config, agentVersion } = this.#options;
    this.#setState('handshaking');

    const connection = new MessageConnection<CoreToProbeMessage, ProbeToCoreMessage>({
      socket,
      logger: this.#logger,
      parse: parseCoreToProbe,
      idleTimeoutMs: config.core.heartbeatIntervalMs * 3,
      onMessage: (message) => {
        this.#handleMessage(message);
      },
      onClose: (close) => {
        this.#handleClose(close);
      },
    });
    this.#connection = connection;

    connection.send({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      gid: this.#gid,
      displayName: config.probe.displayName,
      agentVersion,
      accessKey: config.core.accessKey,
    });
  }

  #handleMessage(message: CoreToProbeMessage): void {
    switch (message.type) {
      case 'welcome': {
        if (!isProtocolCompatible(message.protocolVersion)) {
          this.#fatalRejection = `core speaks protocol ${String(message.protocolVersion)}, probe speaks ${String(PROTOCOL_VERSION)}`;
          this.#logger.error({ detail: this.#fatalRejection }, 'protocol version skew');
          this.#connection?.destroy('protocol version skew');
          return;
        }
        this.#gid = message.gid;
        this.#backoff.reset();
        this.#setState('connected');
        this.#logger.info(
          { gid: message.gid, coreVersion: message.coreVersion },
          'connected to core',
        );
        this.#startHeartbeat(message.heartbeatIntervalMs);
        return;
      }

      case 'reject': {
        // Retrying will not fix a bad key or a revoked probe; say so once, loudly, and keep
        // retrying slowly rather than silently giving up — an operator may fix it at the core.
        this.#fatalRejection = `${message.code}: ${message.message}`;
        this.#logger.error(
          { code: message.code, detail: message.message },
          'core rejected this probe',
        );
        return;
      }

      case 'heartbeat-ack':
        this.#logger.trace({ seq: message.seq }, 'heartbeat acknowledged');
        return;

      case 'bye':
        this.#logger.info({ reason: message.reason }, 'core is closing the connection');
        return;
    }
  }

  #startHeartbeat(intervalMs: number): void {
    this.#clearHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      const connection = this.#connection;
      if (connection === undefined || connection.closed) return;
      this.#heartbeatSeq += 1;
      connection.send({
        type: 'heartbeat',
        seq: this.#heartbeatSeq,
        sentAt: new Date().toISOString(),
      });
    }, intervalMs);
    this.#heartbeatTimer.unref();
  }

  #handleClose(close: ConnectionClose): void {
    this.#clearHeartbeat();
    this.#connection = undefined;
    this.#setState('disconnected');
    this.#logger.info({ cause: close.cause, detail: close.detail }, 'link to core closed');
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer !== undefined) return;
    const delayMs = this.#backoff.nextDelayMs();
    this.#logger.info(
      {
        delayMs,
        attempt: this.#backoff.attempt,
        ...(this.#fatalRejection === undefined ? {} : { blockedBy: this.#fatalRejection }),
      },
      'reconnecting to core',
    );
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connectNow();
    }, delayMs);
    this.#reconnectTimer.unref();
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
  }

  #clearTimers(): void {
    this.#clearHeartbeat();
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
  }
}
