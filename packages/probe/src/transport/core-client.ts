import { connect, type TLSSocket } from 'node:tls';
import {
  capabilitiesFor,
  describeError,
  healthForPeer,
  isProtocolCompatible,
  loadTlsMaterial,
  MessageConnection,
  negotiatedVersion,
  parseCoreToProbe,
  PROTOCOL_VERSION,
  rejectionStopsMonitoring,
  type ConnectionClose,
  type CoreToProbeMessage,
  type Logger,
  type ProbeConfig,
  type ProbeToCoreMessage,
  type ProbeHealthReport,
  type ProbeQuery,
  type QueryFailure,
  type NackReason,
  type RejectCode,
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
  staleKeyAction,
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
  /**
   * A query to run right now, with the core waiting on the answer (`R-09`).
   *
   * Same division as `onConfig` and `onSweep`: the client owns the socket, not the work. Absent
   * means this build has no query runner, and a `query` is answered `unsupported` at once —
   * silence would spend the core's whole deadline before it learned a fact available
   * immediately.
   */
  onQuery?: (message: QueryCommand) => void;
  random?: () => number;
}

/** What the core asked for. Flattened from the wire so the runner takes one shape. */
/** What the core asked for. Flattened from the wire so the runners take one shape. */
/** What the core asked for, flattened from the wire the way `SweepCommand` is (`R-09`). */
export type QueryCommand =
  | { kind: 'run'; queryId: string; query: ProbeQuery; timeoutMs: number }
  | { kind: 'cancel'; queryId: string };

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
  #coreProtocolVersion = 0;
  /** Batches offered and not yet answered. Rejected together when the link drops. */
  readonly #inFlight = new Map<string, (outcome: ResultsOutcome) => void>();
  #batchSeq = 0;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #heartbeatSeq = 0;
  #stopped = false;
  /** Set when the core rejects us for a reason retrying cannot fix. */
  #fatalRejection: string | undefined;
  /**
   * Whether the stored key has already been given up on after a refusal (`P-38`).
   *
   * Once per stale key, not once per reconnect: retrying the enrolment key against a core that
   * has genuinely revoked this probe would be a machine hammering a door it has been told to
   * stop knocking on. Cleared when a handshake succeeds, so a probe that is refused again later
   * — a second re-approval, a second restored backup — may try again.
   */
  #abandonedStoredKey = false;

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
    this.#logger.info({ gid, issuedKey: issuedKey !== undefined }, 'stored this probe’s identity');
  }

  /**
   * Falls back to the configured enrolment key after a refusal (`P-38`).
   *
   * **The core forgets keys in ordinary circumstances**, and re-approving a probe is one of
   * them: the hash is cleared on purpose, so a key that leaked before a revocation cannot
   * survive the decision to let the machine back in. But the probe went on presenting the key it
   * still had, which the core no longer knows — so the remedy an operator reaches for first left
   * the probe *less* recoverable, and the only exit was deleting `identity.json` on its own
   * disk. On a remote probe that means logging into the machine, which is the thing enrolment
   * exists to avoid.
   *
   * **Why the probe and not the core.** Accepting an unknown key for an approved GID because the
   * core has no hash would let anyone who can reach the port claim an approved probe's identity
   * by presenting anything at all. Proving possession of the enrolment key is the point, and only
   * the probe can do that.
   *
   * Nothing is written to disk here. The stored identity is dropped from memory and the next
   * handshake presents the configured key; the core issues a fresh one and `writeIdentity`
   * persists *that*, which is the same path a first enrolment takes. If it fails, `P-37`'s
   * fallback means the probe can still come back.
   */
  /**
   * Drops everything this probe was scanning, because the core has refused it (`R-01`).
   *
   * An empty snapshot rather than a new mechanism: `config-set` with no sensors is already how
   * the core says "you own nothing", it already empties the wheel, and reusing it means there is
   * one path that stops checks rather than two that have to agree.
   *
   * The fingerprint is cleared with it, and that is the load-bearing half. It is what the next
   * `hello` presents, so leaving it set would have a re-approved probe claim to be running a
   * configuration it had just thrown away — and the core would answer `config-unchanged` and
   * send nothing, leaving it connected, approved and scanning nothing at all.
   */
  #stopMonitoring(code: RejectCode): void {
    const apply = this.#options.onConfig;
    if (apply === undefined) return;
    this.#configVersion = '';
    try {
      const scheduled = apply({ kind: 'set', version: '', sensors: [] });
      this.#logger.warn({ code, scheduled }, 'stopped scanning: this core has refused this probe');
    } catch (error: unknown) {
      // Loud, and nothing else to do: the scheduler is the only thing that can stop itself, and
      // a probe still checking after a revocation is the one outcome worth shouting about.
      this.#logger.error(
        { ...describeError(error), code },
        'could not stop scanning after the core refused this probe',
      );
    }
  }

  #giveUpOnStoredKey(): void {
    const action = staleKeyAction({
      stored: this.#identity.accessKey,
      configured: this.#options.config.core.accessKey,
      alreadyTried: this.#abandonedStoredKey,
    });

    switch (action) {
      case 'already-tried':
      case 'nothing-to-retry':
        return;

      case 'no-enrolment-key':
        // **The case a probe cannot fix by itself**, and the one worth a sentence rather than a
        // loop: no enrolment key to fall back on, so somebody has to either re-issue at the core
        // or clear this probe's stored identity.
        this.#abandonedStoredKey = true;
        this.#logger.error(
          { gid: this.#gid },
          'the core does not know this probe’s key and no enrolment key is configured; ' +
            'set core.accessKey or clear the probe’s stored identity',
        );
        return;

      case 'retry-with-enrolment':
        this.#abandonedStoredKey = true;
        this.#identity = { gid: this.#identity.gid, accessKey: '' };
        this.#logger.warn(
          { gid: this.#gid },
          'the core does not know the key this probe holds; falling back to the enrolment key',
        );
        return;
    }
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
        // **Only a core below the floor gets here now** (`P-178`). This used to refuse any core
        // *newer* than the probe, which meant bumping `PROTOCOL_VERSION` took every deployed
        // probe offline: it destroyed the socket, reconnected a minute later, and was refused
        // again — while the core, which had accepted the hello, opened a session, restored every
        // sensor under it and sent a full configuration push each time round. A newer core is
        // now negotiated down instead, and the pair speaks this probe's version.
        if (!isProtocolCompatible(message.protocolVersion)) {
          this.#fatalRejection = `core speaks protocol ${String(message.protocolVersion)}, probe speaks ${String(PROTOCOL_VERSION)}`;
          this.#logger.error({ detail: this.#fatalRejection }, 'protocol version skew');
          this.#connection?.destroy('protocol version skew');
          return;
        }
        // Kept so the probe can gate what it *sends*: every core-side schema carries
        // `additionalProperties: false`, so a field an older core does not know is a rejected
        // batch rather than an ignored key (`P-169`). Negotiated rather than taken as sent, for
        // the reason the core negotiates too — the gate has to answer for the pair (`P-178`).
        this.#coreProtocolVersion = negotiatedVersion(message.protocolVersion);
        this.#gid = message.gid;
        // Absent from a version-5 core, which had no notion of approval and trusted whatever
        // presented the key. Reading that as approved is what keeps an older core working.
        this.#approved = message.approved ?? true;
        this.#backoff.reset();
        // A handshake got through, so whatever key this probe is holding is one the core knows.
        // Arming the fallback again matters because the core can forget a key more than once —
        // a second re-approval, a second restored backup (`P-38`).
        this.#abandonedStoredKey = false;
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
        this.#applyConfig(
          { kind: 'set', version: message.version, sensors: message.sensors },
          message.final,
        );
        return;
      }

      case 'config-delta': {
        this.#applyConfig(
          {
            kind: 'delta',
            version: message.version,
            upserted: message.upserted,
            removed: message.removed,
          },
          message.final,
        );
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

      case 'query': {
        const handler = this.#options.onQuery;
        if (handler === undefined) {
          this.#connection?.send({
            type: 'query-result',
            queryId: message.queryId,
            failure: 'unsupported',
            message: 'this probe has no query runner',
          });
          return;
        }
        handler({
          kind: 'run',
          queryId: message.queryId,
          query: message.query,
          timeoutMs: message.timeoutMs,
        });
        return;
      }

      case 'query-cancel': {
        this.#options.onQuery?.({ kind: 'cancel', queryId: message.queryId });
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
        if (message.code === 'bad-access-key') this.#giveUpOnStoredKey();
        // **And for some of them, stop scanning.** Dropping the link is a condition this probe
        // is built to survive — it keeps checking and spools to disk, so an outage costs no data
        // — and that is exactly wrong when the core has said who it is and refused it. `P-189`
        // closes the connection to make a decision land, so a bare close is indistinguishable
        // from a blip; the code is what carries the difference. A revoked machine that kept its
        // assignments would carry on probing devices on somebody else's network for as long as
        // its process happened to live, which is precisely what the operator revoked it to stop.
        if (rejectionStopsMonitoring(message.code)) this.#stopMonitoring(message.code);
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
      // in step with the first. Memory is the one exception (`P-218`): its channels are the
      // lowest of a window, which is filled every two seconds between heartbeats and only read
      // here.
      const health = this.#options.health?.();
      connection.send({
        type: 'heartbeat',
        seq: this.#heartbeatSeq,
        sentAt: new Date().toISOString(),
        // Gated since `P-208`: an older core's health schema refuses a field it does not know, and
        // that would be every heartbeat rather than one.
        ...(health === undefined
          ? {}
          : { health: healthForPeer(health, this.#coreProtocolVersion) }),
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

  /**
   * Answers one query (`R-09`).
   *
   * Not awaited and not acknowledged: the core is holding a deadline, and a probe that is no
   * longer connected has nothing useful to say about an answer nobody can receive. The core's
   * own disconnect handling settles those callers immediately, which is faster and more honest
   * than anything this end could retry.
   */
  sendQueryResult(message: {
    queryId: string;
    result?: CheckResult;
    failure?: QueryFailure;
    message?: string;
  }): void {
    this.#connection?.send({ type: 'query-result', ...message });
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
        connection.send({
          type: 'results',
          batchId,
          results: [...results],
          backlog,
          // **This probe's own clock, so the core can judge a replay in one frame** (`P-169`).
          // Gated: an older core's results schema refuses an unknown field outright.
          ...(capabilitiesFor(this.#coreProtocolVersion).resultSendTime
            ? { sentAt: new Date().toISOString() }
            : {}),
        });
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
  #applyConfig(update: ConfigUpdate, final: boolean | undefined): void {
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

    // **Stamped only when the whole push has landed** (`R18`). A push above the message cap is
    // one `config-set` plus N-1 deltas at the same version, and stamping on the first of them
    // meant a link that dropped between chunks left this probe holding part of the change under
    // a fingerprint that says it is current — so the reconnect matched, the core answered
    // `config-unchanged`, and the missing half was never sent. Not stamping is what makes it
    // recoverable, exactly as the apply failure above is: the next handshake presents the old
    // version, the fingerprint mismatches, and a full snapshot arrives.
    //
    // Absent means final, so an older core that does not send the flag is unaffected.
    if (final !== false) this.#configVersion = update.version;
    // The ack is sent for every message either way: the core counts them to know when a chunked
    // push is complete (`P-150`), and its count check is the second line under this one.
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
