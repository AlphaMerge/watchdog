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
  type ProbeHealthReport,
  type NackReason,
  type CheckResult,
  type SweepJob,
  type IdentifyJob,
} from '@ms/shared';
import type { ConfigUpdate } from '../scheduler/assignments.js';
import { Backoff } from './backoff.js';
import {
  EMPTY_IDENTITY,
  identityPath,
  readIdentity,
  writeIdentity,
  type ProbeIdentity,
} from './identity.js';

export type LinkState = 'disconnected' | 'connecting' | 'handshaking' | 'connected';

export interface CoreClientOptions {
  config: ProbeConfig;
  logger: Logger;
  agentVersion: string;
  /** Reported on Probe Health (P-13) and used by the spool to decide whether to drain. */
  onStateChange?: (state: LinkState) => void;
  /**
   * What to scan, as the core sees it (R-04).
   *
   * The client applies nothing itself — it owns the socket, not the scheduler. It hands over
   * what arrived and reports back how many assignments the scheduler ended up holding, which is
   * what the core acknowledges against.
   */
  onConfig?: (config: ConfigUpdate) => number;
  /**
   * A discovery sweep to start, resume or stop (`D-01`).
   *
   * Same division as `onConfig`: the client owns the socket, not the work. Absent means this
   * build has no sweep runner wired, and a `sweep-start` is answered with a `failed` finish
   * saying so — silence would leave the core waiting for progress that never comes.
   */
  onSweep?: (message: SweepCommand) => void;
  /**
   * The probe's own numbers, gathered at the moment a heartbeat goes out (`P-13`).
   *
   * A callback rather than an object, because these are counters that move between heartbeats
   * and a snapshot handed over at construction would report the probe as it was at start-up for
   * ever. Absent means this build reports nothing, and Probe Health then shows only what the
   * core knows — which is the same shape as a probe too old to send any of it.
   */
  health?: () => ProbeHealthReport;
  random?: () => number;
}

/** What the core asked for. Flattened from the wire so the runner takes one shape. */
/** What the core asked for. Flattened from the wire so the runners take one shape. */
export type SweepCommand =
  | { kind: 'start'; job: SweepJob }
  | { kind: 'cancel'; runId: number }
  | { kind: 'identify'; job: IdentifyJob }
  | { kind: 'identify-cancel'; runId: number };

export type { ConfigUpdate } from '../scheduler/assignments.js';

/** What the core said about a batch of results. */
export type ResultsOutcome =
  | { kind: 'ack'; storedSamples: number; retryAfterMs: number }
  | { kind: 'nack'; reason: NackReason; retryAfterMs: number };

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
  /**
   * What this probe is, as last told by the core (`R-01`).
   *
   * Loaded from disk on the first connect and written back whenever the core changes it, so a
   * restart presents the same identity instead of enrolling again and filling the approval
   * queue with a row per restart.
   */
  #identity: ProbeIdentity = { ...EMPTY_IDENTITY };
  #identityLoaded = false;
  /** Whether the core has approved this probe. False means it is in somebody's queue. */
  #approved = false;
  /** In memory only — see the comment where it is sent. */
  #configVersion = '';
  /** Batches offered and not yet answered. Rejected together when the link drops. */
  readonly #inFlight = new Map<string, (outcome: ResultsOutcome) => void>();
  #batchSeq = 0;
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

  /**
   * Whether the core has approved this probe (`R-01`).
   *
   * False means the link is up and the probe is doing nothing on purpose: it holds an identity
   * and heartbeats while it waits in an administrator's queue. `P-13` reports it, because
   * "connected but scanning nothing" is otherwise indistinguishable from a broken probe.
   */
  get approved(): boolean {
    return this.#approved;
  }

  start(): void {
    this.#stopped = false;
    // The identity is read before the first dial rather than in the constructor, so a caller
    // that builds a client and never starts it touches no disk. Awaited by nothing: the connect
    // is chained behind it, and a read that fails leaves an empty identity, which enrols.
    void this.#loadIdentity().then(() => {
      if (!this.#stopped) this.#connectNow();
    });
  }

  /** Reads the stored identity once, and prefers it to whatever the config file says. */
  async #loadIdentity(): Promise<void> {
    if (this.#identityLoaded) return;
    this.#identityLoaded = true;
    const stored = await readIdentity(
      identityPath(this.#options.config.probe.spoolDir),
      this.#logger,
    );
    // **The stored identity wins over the config file**, because it is the one the core knows.
    // A config file naming a GID is an operator claiming an identity by hand, which `R-04`
    // supported and `R-01` replaces with enrolment — so it is only a starting point, and only
    // while nothing has been stored.
    if (stored.gid !== '') this.#gid = stored.gid;
    this.#identity = stored;
  }

  /** Writes the identity back when the core has changed it. */
  async #rememberIdentity(gid: string, issuedKey: string | undefined): Promise<void> {
    const accessKey = issuedKey ?? this.#identity.accessKey;
    if (gid === this.#identity.gid && accessKey === this.#identity.accessKey) return;
    this.#identity = { gid, accessKey };
    await writeIdentity(
      identityPath(this.#options.config.probe.spoolDir),
      this.#identity,
      this.#logger,
    );
    this.#logger.info(
      { gid, issuedKey: issuedKey !== undefined },
      'stored this probe’s identity',
    );
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
      // The key the core issued to this probe alone, once it has one; the shared enrolment key
      // until then. A probe that has been approved never presents the shared key again, which
      // is what lets an operator revoke this one machine without rotating everybody's (`R-01`).
      accessKey: this.#identity.accessKey === '' ? config.core.accessKey : this.#identity.accessKey,
      // What this process is already running. Empty after a restart, which is correct: there is
      // no configuration in memory to keep, so claiming to be current would mean scanning
      // nothing while telling the core everything was fine.
      configVersion: this.#configVersion,
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
        // Absent from a version-5 core, which had no notion of approval and trusted whatever
        // presented the key. Reading that as approved is what keeps an older core working.
        this.#approved = message.approved ?? true;
        this.#backoff.reset();
        this.#setState('connected');
        this.#logger.info(
          { gid: message.gid, coreVersion: message.coreVersion, approved: this.#approved },
          this.#approved
            ? 'connected to core'
            : 'connected to core and waiting for an administrator to approve this probe',
        );
        // Fire and forget: a disk write must not delay the heartbeat that keeps this connection
        // from being declared idle, and a failed write costs a re-enrolment rather than a link.
        void this.#rememberIdentity(message.gid, message.accessKey);
        this.#startHeartbeat(message.heartbeatIntervalMs);
        return;
      }

      case 'results-ack': {
        this.#settleBatch(message.batchId, {
          kind: 'ack',
          storedSamples: message.storedSamples,
          retryAfterMs: message.retryAfterMs,
        });
        return;
      }

      case 'results-nack': {
        this.#settleBatch(message.batchId, {
          kind: 'nack',
          reason: message.reason,
          retryAfterMs: message.retryAfterMs,
        });
        return;
      }

      case 'config-unchanged': {
        this.#configVersion = message.version;
        this.#logger.info({ version: message.version }, 'configuration is already current');
        return;
      }

      case 'config-set': {
        this.#applyConfig({ kind: 'set', version: message.version, sensors: message.sensors });
        return;
      }

      case 'config-delta': {
        this.#applyConfig({
          kind: 'delta',
          version: message.version,
          upserted: message.upserted,
          removed: message.removed,
        });
        return;
      }

      case 'sweep-start': {
        const handler = this.#options.onSweep;
        if (handler === undefined) {
          // Answered rather than ignored. A core waiting on a run that will never report is a
          // discovery stuck at 0% with nothing anywhere saying why.
          this.#connection?.send({
            type: 'sweep-finished',
            runId: message.job.runId,
            ending: 'failed',
            cursor: message.job.cursor,
            message: 'this probe has no discovery runner',
          });
          return;
        }
        handler({ kind: 'start', job: message.job });
        return;
      }

      case 'sweep-cancel': {
        this.#options.onSweep?.({ kind: 'cancel', runId: message.runId });
        return;
      }

      case 'identify-start': {
        const handler = this.#options.onSweep;
        if (handler === undefined) {
          this.#connection?.send({
            type: 'identify-finished',
            runId: message.job.runId,
            ending: 'failed',
            cursor: message.job.cursor,
            message: 'this probe has no discovery runner',
          });
          return;
        }
        handler({ kind: 'identify', job: message.job });
        return;
      }

      case 'identify-cancel': {
        this.#options.onSweep?.({ kind: 'identify-cancel', runId: message.runId });
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
      // Gathered here rather than on a timer of its own: the heartbeat is already the periodic
      // "I am here and this is how I am", and a second cadence would be a second thing to keep
      // in step with the first.
      const health = this.#options.health?.();
      connection.send({
        type: 'heartbeat',
        seq: this.#heartbeatSeq,
        sentAt: new Date().toISOString(),
        ...(health === undefined ? {} : { health }),
      });
    }, intervalMs);
    this.#heartbeatTimer.unref();
  }

  get connected(): boolean {
    return this.#state === 'connected';
  }

  /**
   * Offers a batch of results and resolves with what the core said about it.
   *
   * Rejects rather than resolving when the link drops mid-flight: the caller is the spool
   * drain, and "we do not know whether it was stored" has to keep the batch, not discard it.
   * A duplicate write costs nothing — the core's unique index on `(channel_id, time)` makes it
   * a no-op — while a discarded batch is a reading nothing can recover.
   */
  /**
   * Reports a sweep's progress or its end (`D-01`).
   *
   * Fire-and-forget and **not spooled**, unlike a check result. A sweep's progress is only
   * useful while the run is alive, and the run's durable record is the core's row: a probe that
   * loses the link stops the sweep and resumes from the cursor when it comes back, which is
   * simpler and more correct than replaying stale progress against a run that may have been
   * cancelled in the meantime.
   */
  sendSweep(
    message: Extract<ProbeToCoreMessage, { type: `sweep-${string}` | `identify-${string}` }>,
  ): boolean {
    if (this.#connection === undefined) return false;
    this.#connection.send(message);
    return true;
  }

  async sendResults(results: readonly CheckResult[], backlog = 0): Promise<ResultsOutcome> {
    const connection = this.#connection;
    if (connection === undefined || this.#state !== 'connected') {
      throw new Error('not connected to the core');
    }

    this.#batchSeq += 1;
    const batchId = `${this.#gid}-${String(this.#batchSeq)}`;

    return new Promise<ResultsOutcome>((resolve, reject) => {
      this.#inFlight.set(batchId, resolve);
      try {
        // The core cannot tell a live batch from a replay without this, so it would have to
        // slow both alike — which is how one probe's catch-up stalls everyone's live data.
        connection.send({ type: 'results', batchId, results: [...results], backlog });
      } catch (error: unknown) {
        this.#inFlight.delete(batchId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Hands a configuration change to the scheduler and tells the core what came of it.
   *
   * The acknowledgement carries the count the scheduler ended up holding, not the count that was
   * sent: if the two disagree the core logs it, which is how a delta applied against a different
   * starting state stops being invisible.
   */
  #applyConfig(update: ConfigUpdate): void {
    const apply = this.#options.onConfig;
    if (apply === undefined) return;

    let scheduled: number;
    try {
      scheduled = apply(update);
    } catch (error: unknown) {
      // Refusing to update the version is what makes this recoverable: the next reconnect
      // presents the old fingerprint, the core sees a mismatch, and a full snapshot is sent.
      this.#logger.error(
        { ...describeError(error), version: update.version },
        'could not apply the configuration',
      );
      return;
    }

    this.#configVersion = update.version;
    this.#connection?.send({ type: 'config-ack', version: update.version, scheduled });
    this.#logger.info(
      { version: update.version, scheduled, kind: update.kind },
      'applied configuration',
    );
  }

  #failInFlight(reason: string): void {
    if (this.#inFlight.size === 0) return;
    this.#logger.warn({ batches: this.#inFlight.size, reason }, 'result batches left unanswered');
    for (const settle of this.#inFlight.values()) {
      // Resolved as a retryable nack rather than rejected: the drain's job is to try again, and
      // an exception would make "the link dropped" look like a bug rather than a Tuesday.
      settle({ kind: 'nack', reason: 'unavailable', retryAfterMs: 0 });
    }
    this.#inFlight.clear();
  }

  #settleBatch(batchId: string, outcome: ResultsOutcome): void {
    const waiting = this.#inFlight.get(batchId);
    if (waiting === undefined) {
      // A batch answered twice, or one from a previous connection. Neither is worth acting on,
      // but neither is silent: an acknowledgement nobody is waiting for means the drain and the
      // core disagree about what is outstanding.
      this.#logger.warn({ batchId }, 'the core answered a batch nobody was waiting for');
      return;
    }
    this.#inFlight.delete(batchId);
    waiting(outcome);
  }

  #handleClose(close: ConnectionClose): void {
    this.#clearHeartbeat();
    // Every batch still in flight is now unanswerable. Failing them is what keeps them in the
    // spool: an outstanding batch whose fate is unknown must be re-offered, not dropped.
    this.#failInFlight('the connection closed before the core answered');
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
