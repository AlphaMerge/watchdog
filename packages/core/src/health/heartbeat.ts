import {
  ConfigError,
  describeError,
  heartbeatUrlProblem,
  type CoreConfig,
  type Logger,
} from '@ms/shared';

/** How long one request may take. Ten seconds, the same bound the runbook's outside check uses. */
export const HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * What the housekeeping loop tells about each pass it finishes (`H-18`).
 *
 * Both return at once and neither throws: the loop tells, and never waits to hear back.
 */
export interface PassWitness {
  /** A pass ran to its end. */
  passed(): void;
  /** A pass threw before its end — in practice, the database could not be reached. */
  failed(reason: string): void;
}

export interface HeartbeatOptions {
  /** `heartbeat.url`. Requested with `GET`, exactly as written. */
  url: string;
  /** `heartbeat.intervalSeconds`. */
  intervalSeconds: number;
  /** `housekeeping.intervalSeconds`: how often `passed` is called, which is what a beat rides. */
  passSeconds: number;
  /** This build's version, which is all the request says about the installation. */
  version: string;
  logger: Logger;
  /** Injectable so a test's hanging receiver costs milliseconds. */
  timeoutMs?: number;
  /** A monotonic clock in milliseconds, injectable so a test decides when a beat is due. */
  monotonicMs?: () => number;
}

/**
 * The heartbeat a configuration asks for, or none (`H-18`).
 *
 * **None unless a URL is set**, which is the default: a core nobody told where to send one sends
 * nothing, and Core Health's channel is a gap rather than a zero.
 */
export function heartbeatFor(
  config: Pick<CoreConfig, 'heartbeat' | 'housekeeping'>,
  version: string,
  logger: Logger,
  monotonicMs?: () => number,
): Heartbeat | undefined {
  if (config.heartbeat.url === '') return undefined;
  return new Heartbeat({
    url: config.heartbeat.url,
    intervalSeconds: config.heartbeat.intervalSeconds,
    passSeconds: config.housekeeping.intervalSeconds,
    version,
    logger,
    ...(monotonicMs === undefined ? {} : { monotonicMs }),
  });
}

/** Why a heartbeat that was due did not arrive. The log line's `phase`. */
type FailurePhase = 'request' | 'timeout' | 'refused' | 'withheld';

/**
 * The core's outbound heartbeat: a dead man's switch (`H-18`).
 *
 * The core is what raises alarms, so a core that has stopped is silent. An operator names a URL,
 * tells whatever serves it to expect a request every so often, and that receiver alarms when the
 * requests stop. Nothing here depends on the receiver being there.
 *
 * **It has no timer of its own, and that is the design.** A timer would go on firing in a process
 * whose housekeeping had wedged, and would report a core as working that had stopped rolling up,
 * compressing and dropping. `passed` is called by the housekeeping loop at the end of each pass,
 * so a stopped process, a pass that never returns and a database that cannot be reached all end
 * the requests.
 *
 * **The loop never waits for it.** `passed` starts the request and returns; the request has a
 * timeout and an `AbortSignal`, and a receiver that accepts the connection and says nothing costs
 * the pass nothing.
 *
 * **A failure is counted, not retried.** The next pass that is due sends the next one; a retry
 * loop would be the timer this deliberately does not have. Core Health's `heartbeatFailures`
 * reads the count, so a heartbeat that has quietly stopped reaching its receiver is visible while
 * the core is up to show it.
 */
export class Heartbeat implements PassWitness {
  readonly #url: string;
  /** The receiver's scheme, host and port: what a log line may name. The path is a token. */
  readonly #receiver: string;
  readonly #intervalMs: number;
  readonly #slackMs: number;
  readonly #timeoutMs: number;
  readonly #userAgent: string;
  readonly #logger: Logger;
  readonly #monotonicMs: () => number;
  readonly #stop = new AbortController();

  #lastDueAt: number | undefined;
  #inFlight: Promise<void> | undefined;
  #sent = 0;
  #failures = 0;

  constructor(options: HeartbeatOptions) {
    // Asked again here, as the listener asks about its proxies: a core built without loading a
    // file is held to the same rule.
    const problem = heartbeatUrlProblem(options.url);
    if (problem !== undefined) throw new ConfigError(problem);
    this.#url = options.url;
    this.#receiver = new URL(options.url).origin;
    this.#intervalMs = options.intervalSeconds * 1_000;
    // **Half a pass of slack.** Passes end a few milliseconds early or late of their period, and
    // with the interval equal to the period — the default — an exact comparison would skip every
    // pass that ended a millisecond early and send half as often as the receiver was told.
    this.#slackMs = (options.passSeconds * 1_000) / 2;
    this.#timeoutMs = options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.#userAgent = `ms-core/${options.version}`;
    this.#logger = options.logger.child({ component: 'heartbeat' });
    this.#monotonicMs = options.monotonicMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  }

  /** Sent and failed since the process started. Core Health takes the difference. */
  stats(): { sent: number; failures: number } {
    return { sent: this.#sent, failures: this.#failures };
  }

  passed(): void {
    if (!this.#due()) return;
    // One at a time. The one in flight ends inside its timeout and counts itself if it fails; a
    // second beside it would be a second request to a receiver that is already not answering.
    if (this.#inFlight !== undefined) return;
    this.#inFlight = this.#send().finally(() => {
      this.#inFlight = undefined;
    });
  }

  failed(reason: string): void {
    if (!this.#due()) return;
    // **Withheld, and counted.** A core that cannot reach its database cannot record a state or
    // queue a notification, so it is silent in the way this exists to catch, and the receiver
    // should hear nothing. Counted because Core Health's route still answers without a database,
    // and the operator reading it should see why the receiver is about to alarm.
    this.#fail('withheld', { reason });
  }

  /** Ends a request in flight and sends no more. A stop is not a failure, and is not counted. */
  stop(): void {
    this.#stop.abort();
  }

  /** Resolves when no request is in flight. For shutdown, and for a test to wait on. */
  async settled(): Promise<void> {
    await this.#inFlight;
  }

  /** Whether a beat is due now, and if so, notes that this one was it. */
  #due(): boolean {
    if (this.#stop.signal.aborted) return false;
    const now = this.#monotonicMs();
    if (this.#lastDueAt !== undefined && now - this.#lastDueAt < this.#intervalMs - this.#slackMs) {
      return false;
    }
    this.#lastDueAt = now;
    return true;
  }

  async #send(): Promise<void> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    try {
      const response = await fetch(this.#url, {
        method: 'GET',
        // Not followed: the operator named one address, and a redirect is somebody else naming
        // another for a request that carries the receiver's token.
        redirect: 'manual',
        headers: { 'user-agent': this.#userAgent },
        signal: AbortSignal.any([this.#stop.signal, timeout]),
      });
      // The body is nothing this needs, and an unread one holds its socket open.
      await response.body?.cancel();
      if (response.status >= 200 && response.status < 300) {
        this.#sent += 1;
        this.#logger.debug({ receiver: this.#receiver, status: response.status }, 'heartbeat sent');
        return;
      }
      this.#fail('refused', { status: response.status });
    } catch (error: unknown) {
      if (this.#stop.signal.aborted) return;
      if (timeout.aborted) {
        this.#fail('timeout', { timeoutMs: this.#timeoutMs });
        return;
      }
      // `fetch` says "fetch failed" and keeps the reason — ECONNREFUSED, a certificate, a name
      // that does not resolve — in `cause`, so the cause is what is logged.
      const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
      this.#fail('request', { err: describeError(cause) });
    }
  }

  #fail(phase: FailurePhase, detail: Record<string, unknown>): void {
    this.#failures += 1;
    this.#logger.warn(
      {
        receiver: this.#receiver,
        phase,
        intervalSeconds: this.#intervalMs / 1_000,
        failures: this.#failures,
        ...detail,
      },
      phase === 'withheld'
        ? 'heartbeat withheld: the housekeeping pass failed, and the receiver will report this ' +
            'core as stopped if the next one does too'
        : 'heartbeat did not reach its receiver, which will report this core as stopped if ' +
            'the next one does not either',
    );
  }
}
