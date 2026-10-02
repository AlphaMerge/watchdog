import snmp from 'net-snmp';
import type { PinnedAddress } from '../pinned-target.js';
import { credentialFingerprint, describeCredentials, type SnmpCredentials } from './credentials.js';
import { compareOids, formatOid, isPrefixOf, normaliseOid, parseOid } from './oid.js';

/**
 * A session against one agent (`T-01`).
 *
 * **The only file in `packages/` that imports `net-snmp`.** ADR-001 Decision 6 chose it and
 * recorded the risk as "single maintainer"; the mitigation it names is vendoring a fork. That is
 * not what this does, and the reasoning is in `docs/ADR-001-architecture.md` — three pure-JS
 * packages with no transitive dependencies, actively maintained, are not worth carrying in-tree
 * today. What makes vendoring cheap *later* is this boundary plus `net-snmp.d.ts`: the whole
 * dependency is one import and about eighty lines of declared surface, so replacing it is a
 * change to one file rather than an archaeology exercise.
 */

/** What net-snmp names each ASN.1 type. Ours, so a sensor type never sees a bare number. */
export type SnmpType =
  | 'Boolean'
  | 'Integer'
  | 'BitString'
  | 'OctetString'
  | 'Null'
  | 'OID'
  | 'IpAddress'
  | 'Counter'
  | 'Gauge'
  | 'TimeTicks'
  | 'Opaque'
  | 'Counter64'
  | 'NoSuchObject'
  | 'NoSuchInstance'
  | 'EndOfMibView';

const TYPE_NAMES: Readonly<Record<number, SnmpType>> = {
  1: 'Boolean',
  2: 'Integer',
  3: 'BitString',
  4: 'OctetString',
  5: 'Null',
  6: 'OID',
  64: 'IpAddress',
  65: 'Counter',
  66: 'Gauge',
  67: 'TimeTicks',
  68: 'Opaque',
  70: 'Counter64',
  128: 'NoSuchObject',
  129: 'NoSuchInstance',
  130: 'EndOfMibView',
};

/** The three types that mean "the agent has no such thing" rather than carrying a value. */
const EXCEPTIONS = new Set<SnmpType>(['NoSuchObject', 'NoSuchInstance', 'EndOfMibView']);

/**
 * One value from an agent.
 *
 * **`Counter64` stays a `bigint` and an `OctetString` stays a `Buffer`**, and both matter.
 * A 64-bit interface counter past 2^53 loses its low bits as a `number`, which is precisely the
 * range `ifHCInOctets` exists to reach — `T-02` computes deltas across wraps from these and
 * would produce quiet nonsense on a busy link. An `OctetString` is bytes, not text: a MAC
 * address and an `ifPhysAddress` are not UTF-8, and decoding them here would corrupt them before
 * the caller could say otherwise.
 */
export interface SnmpVarbind {
  readonly oid: string;
  readonly type: SnmpType;
  readonly value: number | bigint | string | Buffer | null;
}

export interface SnmpTarget {
  readonly host: string;
  readonly port?: number;
  readonly ipVersion?: 'auto' | 'v4' | 'v6';
  /**
   * The address to send to in place of resolving `host` (`A-41c`): the one checked against the
   * credential set's targets. `host` stays the name every message uses.
   */
  readonly pinned?: PinnedAddress;
}

export interface SnmpSessionOptions {
  /**
   * Per *attempt*, not for the request.
   *
   * net-snmp retries a lost datagram itself, so the wall-clock ceiling for one call is
   * `timeoutMs × (retries + 1)` — 5,000 ms with two retries is fifteen seconds, not five. The
   * default here is deliberately smaller than a check's usual deadline for that reason, and
   * `worstCaseMs` below is the number to compare against a timeout.
   */
  readonly timeoutMs?: number;
  readonly retries?: number;
  /** Varbinds per GetBulk. Higher is fewer round trips and a larger datagram to lose. */
  readonly maxRepetitions?: number;
  /**
   * The most varbinds a single walk may collect.
   *
   * A bound rather than a nicety: `walk` on a mistyped OID can be handed an agent's entire MIB,
   * and an unbounded collect on a probe holding thousands of sensors is a heap it does not get
   * back. Hitting it is an error, not a truncated success — a table silently missing its tail
   * would be read as a device that lost interfaces.
   */
  readonly maxVarbinds?: number;
}

const DEFAULTS = {
  timeoutMs: 5_000,
  retries: 1,
  maxRepetitions: 20,
  maxVarbinds: 10_000,
} as const;

/** The longest one call can take before it gives up, given the timeout and retry settings. */
export function worstCaseMs(options: SnmpSessionOptions = {}): number {
  const timeout = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const retries = options.retries ?? DEFAULTS.retries;
  return timeout * (retries + 1);
}

export type SnmpPhase = 'connect' | 'get' | 'getNext' | 'getBulk' | 'walk';

/** Why a walk stopped. Only `end` is success; the other two are the agent misbehaving. */
type WalkOutcome =
  | { readonly reason: 'end' }
  | { readonly reason: 'overflow' }
  | { readonly reason: 'backwards'; readonly at: string };

/**
 * A failure with enough in it to diagnose without the device in front of you.
 *
 * CLAUDE.md: "ETIMEDOUT" alone is not a diagnosis. Which agent, which SNMP version, which phase
 * and which OID are the four things that separate "the community string is wrong" from "the
 * interface index moved" — and nothing here ever carries the credential itself.
 */
export class SnmpError extends Error {
  readonly host: string;
  readonly phase: SnmpPhase;
  readonly oid: string | undefined;

  constructor(
    message: string,
    context: { host: string; phase: SnmpPhase; oid?: string; cause?: unknown },
  ) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = 'SnmpError';
    this.host = context.host;
    this.phase = context.phase;
    this.oid = context.oid;
  }
}

function versionOf(credentials: SnmpCredentials): number {
  switch (credentials.version) {
    case 'v1':
      return snmp.Version1;
    case 'v2c':
      return snmp.Version2c;
    case 'v3':
      return snmp.Version3;
  }
}

/** `Counter64` arrives as eight big-endian bytes; anything else would be a decode we lost. */
function counter64(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (Buffer.isBuffer(value)) {
    let total = 0n;
    for (const byte of value) total = (total << 8n) | BigInt(byte);
    return total;
  }
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
}

function normalise(raw: snmp.Varbind): SnmpVarbind {
  const type = TYPE_NAMES[raw.type] ?? 'Opaque';
  if (EXCEPTIONS.has(type)) return { oid: raw.oid, type, value: null };
  if (type === 'Counter64') return { oid: raw.oid, type, value: counter64(raw.value) };
  return { oid: raw.oid, type, value: raw.value };
}

/** Whether a varbind carries a value at all, as opposed to one of SNMP's three "no" answers. */
export function isException(varbind: SnmpVarbind): boolean {
  return EXCEPTIONS.has(varbind.type);
}

/**
 * A varbind's value as a number, or null when it is not one.
 *
 * Null rather than zero or a throw: "the agent has no such object" and "the counter is zero" are
 * different facts, and CLAUDE.md is explicit that a missing reading is not a zero one. The
 * caller decides whether an absent value is a failed check.
 */
export function numberOf(varbind: SnmpVarbind): number | null {
  const { value } = varbind;
  if (isException(varbind) || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A varbind's value as text. An `OctetString` is decoded here and nowhere earlier. */
export function stringOf(varbind: SnmpVarbind, encoding: BufferEncoding = 'utf8'): string | null {
  const { value } = varbind;
  if (isException(varbind) || value === null) return null;
  if (Buffer.isBuffer(value)) return value.toString(encoding);
  if (typeof value === 'bigint') return value.toString();
  return String(value);
}

export class SnmpSession {
  readonly #session: snmp.Session;
  readonly #host: string;
  readonly #options: Required<SnmpSessionOptions>;
  #closed = false;
  /** The last socket error, kept so a timeout that followed one can say what really happened. */
  #socketError: Error | undefined;

  private constructor(session: snmp.Session, host: string, options: Required<SnmpSessionOptions>) {
    this.#session = session;
    this.#host = host;
    this.#options = options;
    // An EventEmitter with no 'error' listener throws on the next tick and takes the worker
    // down — one unreachable agent would kill a worker running checks for hundreds of others.
    session.on('error', (error?: Error) => {
      this.#socketError = error;
    });
  }

  static open(
    target: SnmpTarget,
    credentials: SnmpCredentials,
    options: SnmpSessionOptions = {},
  ): SnmpSession {
    if (target.host.trim() === '') {
      throw new SnmpError('the device has no host to query', { host: '', phase: 'connect' });
    }

    const resolved: Required<SnmpSessionOptions> = {
      timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
      retries: options.retries ?? DEFAULTS.retries,
      maxRepetitions: options.maxRepetitions ?? DEFAULTS.maxRepetitions,
      maxVarbinds: options.maxVarbinds ?? DEFAULTS.maxVarbinds,
    };

    const base: snmp.SessionOptions = {
      port: target.port ?? 161,
      version: versionOf(credentials),
      timeout: resolved.timeoutMs,
      retries: resolved.retries,
      // 'auto' is not a transport. A hostname that resolves to both is asked over IPv4, which is
      // what the system resolver would have preferred anyway; a device that is v6-only is
      // configured as such, on the device, where every sensor under it inherits the answer.
      // A pinned address says its own family: it was chosen from what the name resolved to.
      transport:
        target.pinned === undefined
          ? target.ipVersion === 'v6'
            ? 'udp6'
            : 'udp4'
          : target.pinned.family === 6
            ? 'udp6'
            : 'udp4',
    };
    // **The checked address, never the name, when there is one** (`A-41c`). `net-snmp` resolves
    // whatever it is given each time it sends, and a name resolved again is a name whoever runs
    // its DNS can point elsewhere after the check.
    const peer = target.pinned?.address ?? target.host;

    try {
      if (credentials.version === 'v3') {
        const level =
          credentials.level === 'noAuthNoPriv'
            ? (snmp.SecurityLevel['noAuthNoPriv'] ?? 1)
            : credentials.level === 'authNoPriv'
              ? (snmp.SecurityLevel['authNoPriv'] ?? 2)
              : (snmp.SecurityLevel['authPriv'] ?? 3);

        const user: snmp.V3User = {
          name: credentials.username,
          level,
          ...(credentials.authProtocol === undefined
            ? {}
            : { authProtocol: snmp.AuthProtocols[credentials.authProtocol] ?? 0 }),
          ...(credentials.authKey === undefined ? {} : { authKey: credentials.authKey }),
          ...(credentials.privProtocol === undefined
            ? {}
            : { privProtocol: snmp.PrivProtocols[credentials.privProtocol] ?? 0 }),
          ...(credentials.privKey === undefined ? {} : { privKey: credentials.privKey }),
        };
        const withContext: snmp.SessionOptions =
          credentials.context === undefined ? base : { ...base, context: credentials.context };
        return new SnmpSession(
          snmp.createV3Session(peer, user, withContext),
          target.host,
          resolved,
        );
      }

      return new SnmpSession(
        snmp.createSession(peer, credentials.community, base),
        target.host,
        resolved,
      );
    } catch (error) {
      throw new SnmpError(
        `could not open an SNMP ${describeCredentials(credentials)} session to ${target.host}: ` +
          describe(error),
        { host: target.host, phase: 'connect', cause: error },
      );
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  async get(oids: readonly string[], signal: AbortSignal): Promise<SnmpVarbind[]> {
    const asked = oids.map((oid) => normaliseOid(oid));
    const varbinds = await this.#call<snmp.Varbind[]>(
      'get',
      asked[0],
      (done) => {
        this.#session.get(asked, done);
      },
      signal,
    );
    return varbinds.map(normalise);
  }

  async getNext(oids: readonly string[], signal: AbortSignal): Promise<SnmpVarbind[]> {
    const asked = oids.map((oid) => normaliseOid(oid));
    const varbinds = await this.#call<snmp.Varbind[]>(
      'getNext',
      asked[0],
      (done) => {
        this.#session.getNext(asked, done);
      },
      signal,
    );
    return varbinds.map(normalise);
  }

  /**
   * One GetBulk. `nonRepeaters` leading OIDs are fetched once, the rest are repeated.
   *
   * Exposed alongside `walk` because a table read that knows its columns is one round trip and a
   * walk is many — `T-04` reads a whole row this way rather than walking each column.
   */
  async getBulk(
    oids: readonly string[],
    signal: AbortSignal,
    nonRepeaters = 0,
    maxRepetitions = this.#options.maxRepetitions,
  ): Promise<SnmpVarbind[][]> {
    const asked = oids.map((oid) => normaliseOid(oid));
    const rows = await this.#call<snmp.Varbind[][]>(
      'getBulk',
      asked[0],
      (done) => {
        this.#session.getBulk(asked, nonRepeaters, maxRepetitions, done);
      },
      signal,
    );
    return rows.map((row) => row.map(normalise));
  }

  /**
   * Every varbind under `baseOid`, in order.
   *
   * Three things stop it, and only one of them is success. It ends when the agent walks out of
   * the subtree; it *fails* on `maxVarbinds`, because a truncated table read as a complete one
   * is a device that appears to have lost half its interfaces; and it fails on an OID that did
   * not increase, which is a broken agent and otherwise an infinite loop holding a worker for
   * ever. `EndOfMibView` from a v2c agent at the top of its MIB is an ordinary end.
   */
  async walk(baseOid: string, signal: AbortSignal): Promise<SnmpVarbind[]> {
    const base = parseOid(baseOid);
    const root = formatOid(base);
    const collected: SnmpVarbind[] = [];
    let previous: number[] | null = null;

    // The outcome travels back through the promise rather than through variables read after the
    // await. `subtree`'s feed runs inside net-snmp, so anything it assigns is invisible to the
    // checker out here — reading a flag after the await would be reading what the compiler still
    // believes is its initial value.
    const outcome = await this.#call<WalkOutcome>(
      'walk',
      root,
      (done) => {
        let stopped: WalkOutcome = { reason: 'end' };
        this.#session.subtree(
          root,
          this.#options.maxRepetitions,
          (varbinds) => {
            for (const raw of varbinds) {
              const varbind = normalise(raw);
              if (isException(varbind)) continue;

              let current: number[];
              try {
                current = parseOid(varbind.oid);
              } catch {
                continue;
              }
              if (!isPrefixOf(base, current)) return true;
              if (previous !== null && compareOids(current, previous) <= 0) {
                stopped = { reason: 'backwards', at: varbind.oid };
                return true;
              }
              previous = current;

              if (collected.length >= this.#options.maxVarbinds) {
                stopped = { reason: 'overflow' };
                return true;
              }
              collected.push(varbind);
            }
            return false;
          },
          (error) => {
            done(error, stopped);
          },
        );
      },
      signal,
    );

    if (outcome.reason === 'overflow') {
      throw new SnmpError(
        `walking ${root} on ${this.#host} passed ${String(this.#options.maxVarbinds)} values ` +
          'without leaving the subtree — narrow the OID, or raise the limit if the table really ' +
          'is this large',
        { host: this.#host, phase: 'walk', oid: root },
      );
    }
    if (outcome.reason === 'backwards') {
      throw new SnmpError(
        `${this.#host} answered a walk of ${root} with ${outcome.at}, which does not come ` +
          'after the previous value — the agent is not walking its MIB in order',
        { host: this.#host, phase: 'walk', oid: root },
      );
    }
    return collected;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#session.close();
    } catch {
      // Closing twice, or closing a socket that already died, is not worth a failed check.
    }
  }

  /**
   * One request, raced against the check's abort.
   *
   * **Abort does not close the session**, and that is the whole subtlety of pooling: the socket
   * belongs to every sensor on this device, so tearing it down because *this* check ran out of
   * time would fail the other checks in flight on it. Instead the wait is abandoned and
   * net-snmp's callback lands later on a promise that has already settled, which costs one
   * ignored datagram and nothing else.
   */
  async #call<T>(
    phase: SnmpPhase,
    oid: string | undefined,
    start: (done: (error: Error | null | undefined, result: T) => void) => void,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) {
      throw new SnmpError(`the check was cancelled before querying ${this.#host}`, {
        host: this.#host,
        phase,
        ...(oid === undefined ? {} : { oid }),
      });
    }
    if (this.#closed) {
      throw new SnmpError(`the SNMP session to ${this.#host} is closed`, {
        host: this.#host,
        phase,
        ...(oid === undefined ? {} : { oid }),
      });
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        reject(
          new SnmpError(`the check was cancelled while querying ${this.#host}`, {
            host: this.#host,
            phase,
            ...(oid === undefined ? {} : { oid }),
          }),
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });

      start((error, result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (error !== null && error !== undefined) {
          reject(this.#failure(phase, oid, error));
          return;
        }
        resolve(result);
      });
    });
  }

  #failure(phase: SnmpPhase, oid: string | undefined, error: unknown): SnmpError {
    const where = oid === undefined ? '' : ` for ${oid}`;
    const socket = this.#socketError === undefined ? '' : ` (socket: ${this.#socketError.message})`;
    const name = error instanceof Error ? error.name : '';

    // A timeout is the one an operator will see most, and on SNMP it has three ordinary causes
    // that look identical on the wire. Naming them beats the library's "Request timed out".
    if (name === 'RequestTimedOutError') {
      return new SnmpError(
        `${this.#host} did not answer SNMP${where} within ` +
          `${String(worstCaseMs(this.#options))} ms — it may be unreachable, not running an ` +
          'agent, or refusing these credentials silently, which is what an agent does with a ' +
          `wrong community string${socket}`,
        { host: this.#host, phase, ...(oid === undefined ? {} : { oid }), cause: error },
      );
    }
    return new SnmpError(`SNMP ${phase} on ${this.#host}${where} failed: ${describe(error)}`, {
      host: this.#host,
      phase,
      ...(oid === undefined ? {} : { oid }),
      cause: error,
    });
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export { credentialFingerprint };
