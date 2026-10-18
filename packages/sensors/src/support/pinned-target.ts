import { BlockList, isIP, type LookupFunction } from 'node:net';
import { targetVerdict, unmapped } from '@ms/shared';
import { restrictionOf } from '../credentials/index.js';
import {
  nameLookups,
  notAnswered,
  probeFailed,
  tooManyAddresses,
  type LookupCount,
} from './lookups.js';
import { systemLookup } from './system-lookup.js';

/**
 * A device named by host name, checked against a credential set's address targets (`A-41c`).
 *
 * A set whose `allowedTargets` name only addresses and ranges says nothing about a host *name*:
 * `A-41b` had the core withhold it, because the obvious thing a probe could do is wrong. Resolve
 * the name, check the address, connect to the name — and the connection resolves the name again.
 * The device's writer picks the name and can run its DNS, so they answer the check with an
 * address inside the targets and the connection with a machine of their own.
 *
 * **So the name is resolved once, here, and the check connects to an address this checked.**
 * `pinTarget` is the one place that resolves and checks. It asks the resolver once, checks
 * *every* address it answers with for the device's address family against the targets, and hands
 * back one of them. Each transport that can be held to an address takes it from the check's
 * target (`CheckTarget.pinned`) and never resolves the name itself: SNMP and SSH connect to the
 * address, HTTP and mail answer their socket's `lookup` with it (`pinnedLookup`) so that SNI, the
 * `Host` header and the certificate check stay on the name.
 *
 * Every address, not the one chosen, for the reason `A-09`'s guard reads them all: a name with
 * one record inside and one outside is a name whose owner chooses, per connection, which is used.
 *
 * **In `@ms/sensors` and called by the catalogue**, which every check on a probe passes through,
 * whichever runner it is in. A type cannot forget it, and a type that does not say it honours
 * the pin (`SensorType.pinnedKinds`) is refused here rather than run by name.
 */

/** The address a check connects to, in place of resolving its device's name. */
export interface PinnedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** One answer from a resolver. */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** What a caller tells the resolver about its lookup (`P-426`). */
export interface ResolveOptions {
  /**
   * How long the check will wait for the answer: its `resolveBoundMs`. The probe's resolver stops
   * holding a waiter past it, and a worker asking it settles its own wait shortly after.
   */
  readonly waitMs?: number;
}

/**
 * Every address a name has for a family: 4, 6, or 0 for both. Rejects when the name does not
 * resolve. On a probe, the probe's resolver (`P-426`); elsewhere the system's; a test hands in its
 * own.
 */
export type ResolveHost = (
  host: string,
  family: 0 | 4 | 6,
  options?: ResolveOptions,
) => Promise<readonly ResolvedAddress[]>;

/**
 * `getaddrinfo`, the resolver a socket handed the name would have used, so that the hosts file
 * and the search list mean here what they mean everywhere else on the probe's machine. The same
 * call the probe's lookup helper makes (`systemLookup`, `P-432`).
 */
export const systemResolve: ResolveHost = (host, family) => systemLookup(host, family);

/** Where a refusal happened. */
export type WithheldPhase = 'check' | 'resolve' | 'connect';

/** How a runner recognises a refusal without importing this package. Structural, like `UNKNOWN_SENSOR_TYPE`. */
export const CREDENTIALS_WITHHELD = 'CREDENTIALS_WITHHELD';

/**
 * A check refused because of where its credentials may go. **Not a failure of the device**:
 * nothing was sent to it. The probe marks the result `withheld`, and the core holds the sensor
 * Unknown with the message.
 */
export class CredentialsWithheldError extends Error {
  readonly code = CREDENTIALS_WITHHELD;
  readonly sensorId: number | undefined;
  /** The device's host, as the device names it. */
  readonly target: string;
  readonly phase: WithheldPhase;
  /** The credential kind whose targets refused it. */
  readonly kind: string | undefined;

  constructor(
    message: string,
    context: { sensorId?: number; target: string; phase: WithheldPhase; kind?: string },
  ) {
    super(message);
    this.name = 'CredentialsWithheldError';
    this.sensorId = context.sensorId;
    this.target = context.target;
    this.phase = context.phase;
    this.kind = context.kind;
  }

  /** The same refusal, naming the sensor: a transport that raises one does not know it. */
  forSensor(sensorId: number): CredentialsWithheldError {
    if (this.sensorId !== undefined) return this;
    return new CredentialsWithheldError(this.message, {
      sensorId,
      target: this.target,
      phase: this.phase,
      ...(this.kind === undefined ? {} : { kind: this.kind }),
    });
  }
}

export function isCredentialsWithheld(error: unknown): error is CredentialsWithheldError {
  return error instanceof CredentialsWithheldError;
}

const FIX =
  'Every address the name has must be inside them: correct the name’s records, add the ' +
  'address to the targets where the credentials are stored, or give the device its address.';

/** What a refused check says. Each names the host and the kind, and never the secret. */
export const PIN_REFUSALS = {
  outside: (host: string, kind: string): string =>
    `Not scanned: ${host} is outside the allowed targets of the ${kind} credentials it would ` +
    'use, so they are not sent to it. Adding the device to the targets where the credentials ' +
    'are stored, or pointing it back inside them, sends them again.',
  unpinnable: (host: string, kind: string): string =>
    `Not scanned: ${host} is a host name, the allowed targets of the ${kind} credentials it ` +
    'would use name only addresses and ranges, and this kind of sensor cannot be held to an ' +
    'address checked against them. Giving the device its address, or adding its name or ' +
    '*.domain to the targets, sends them again.',
  resolvedOutside: (host: string, kind: string, address: string): string =>
    `Not scanned: ${host} resolves to ${address}, which is outside the allowed targets of the ` +
    `${kind} credentials it would use, so they are not sent. ${FIX}`,
  resolvedNothing: (host: string, kind: string, family: string, why: string): string =>
    `Not scanned: ${host} did not resolve to any ${family}address${why}, so it could not be ` +
    `checked against the allowed targets of the ${kind} credentials it would use, and they ` +
    'are not sent. It is scanned again when the name resolves inside them.',
  resolveTimedOut: (host: string, kind: string, ms: number): string =>
    `Not scanned: ${host} did not resolve within ${String(ms)} ms, so it could not be checked ` +
    `against the allowed targets of the ${kind} credentials it would use, and they are not ` +
    'sent. The probe’s resolver is not answering; it is scanned again when the name resolves ' +
    'inside them.',
  resolveNotAnswered: (host: string, kind: string, why: string): string =>
    `Not scanned: ${host} did not resolve (${why}), so it could not be checked against the ` +
    `allowed targets of the ${kind} credentials it would use, and they are not sent. The ` +
    'probe’s resolver is not answering; it is scanned again when the name resolves inside them.',
  resolvedTooMany: (host: string, kind: string, why: string): string =>
    `Not scanned: ${why}, so ${host} could not be checked against the allowed targets of the ` +
    `${kind} credentials it would use, and they are not sent. Giving the device one of its ` +
    'addresses, or a name with fewer, sends them again.',
  resolveBusy: (host: string, kind: string, why: string): string =>
    `Not scanned: ${host} could not be resolved (${why}), so it could not be checked against ` +
    `the allowed targets of the ${kind} credentials it would use, and they are not sent. It is ` +
    'scanned again when the name resolves inside them.',
  cancelled: (host: string): string =>
    `Not scanned: the check was cancelled while ${host} was being resolved to check it against ` +
    'the allowed targets of the credentials it would use.',
  otherName: (host: string, asked: string): string =>
    `Not scanned: the connection for ${host} asked to resolve ${asked}, which is not the name ` +
    'that was checked against the allowed targets of the credentials it would use, so nothing ' +
    'was sent. A proxy or a redirect between the probe and the device does this.',
  redirected: (host: string, other: string): string =>
    `Not scanned: ${host} handed the connection on to ${other}, which is not the address ` +
    'checked against the allowed targets of the database credentials it would use, so they ' +
    'are not sent there. Giving the device the name or address of the server that answers, ' +
    'inside those targets, sends them again.',
  otherPeer: (host: string, pinned: string, actual: string): string =>
    `Not scanned: the connection for ${host} went to ${actual}, not to ${pinned}, the address ` +
    'checked against the allowed targets of the credentials it would use, so its answer is ' +
    'not used.',
} as const;

export interface PinRequest {
  readonly sensorId: number;
  readonly target: { readonly host: string; readonly ipVersion: 'auto' | 'v4' | 'v6' };
  /** The sets the check was handed, by kind, public fields included. */
  readonly credentials: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** The kinds this sensor type connects to a pinned address for (`SensorType.pinnedKinds`). */
  readonly pinnedKinds: readonly string[];
  readonly signal?: AbortSignal;
  /**
   * The check's own deadline, when the runner says. The resolution is given part of it: see
   * `resolveBoundMs`.
   */
  readonly timeoutMs?: number;
}

/** What a resolution may take when the check does not say how long it has. */
const DEFAULT_RESOLVE_MS = 5_000;
/** And the most it may take whatever the check has: a resolver that slow is not answering. */
const MAX_RESOLVE_MS = 10_000;

/**
 * How long the one lookup may take: half the check's time, and never more than ten seconds.
 *
 * **Shorter than the check's own timeout, so that the refusal is what the runner hears.**
 * `getaddrinfo` cannot be cancelled, and against a resolver that does not answer it outlasts the
 * check. The pool then settled the check as a plain timeout, a failed scan, and the sensor read
 * Down for a device nothing had been sent to, where the same resolver answering "no such name"
 * read Unknown. Half leaves the transport the other half once the name does resolve.
 */
export function resolveBoundMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_RESOLVE_MS;
  }
  return Math.max(1, Math.min(MAX_RESOLVE_MS, Math.floor(timeoutMs / 2)));
}

/**
 * The address this check must connect to, or null when it may connect as it always has.
 *
 * Null, **with no lookup made**, unless a set the check holds has targets that the host is
 * undecided against: a name that no name entry covers, facing address or range entries. A set
 * with no targets, a device given as an address, and a name a name entry covers are all decided
 * without resolving anything, and behave exactly as before.
 *
 * Throws `CredentialsWithheldError` when the set must not be used: the host is outside the
 * targets, the type cannot pin, the name resolves to nothing, or any address it resolves to for
 * the device's family is outside the targets of any set that needs the check.
 */
export async function pinTarget(
  request: PinRequest,
  resolve: ResolveHost = systemResolve,
): Promise<PinnedAddress | null> {
  const { sensorId, signal } = request;
  const host = request.target.host;
  const refuse = (message: string, phase: WithheldPhase, kind?: string): never => {
    throw new CredentialsWithheldError(message, {
      sensorId,
      target: host,
      phase,
      ...(kind === undefined ? {} : { kind }),
    });
  };

  // Sorted, so that which kind a refusal names does not depend on the order of a map.
  const undecided: { kind: string; targets: readonly string[] }[] = [];
  for (const kind of Object.keys(request.credentials).sort()) {
    const targets = restrictionOf(kind, request.credentials[kind] ?? {}).targets;
    if (targets.length === 0) continue;
    const verdict = targetVerdict(host, targets);
    // The core does not send a set to a host outside its targets. Checked again because this is
    // the last place that can: a probe that trusted the core here would be the only check.
    if (verdict === 'outside') refuse(PIN_REFUSALS.outside(host, kind), 'check', kind);
    if (verdict === 'undecided') undecided.push({ kind, targets });
  }
  if (undecided.length === 0) return null;

  for (const { kind } of undecided) {
    if (!request.pinnedKinds.includes(kind)) {
      refuse(PIN_REFUSALS.unpinnable(host, kind), 'check', kind);
    }
  }
  const first = undecided[0]?.kind ?? '';

  const family = request.target.ipVersion === 'v4' ? 4 : request.target.ipVersion === 'v6' ? 6 : 0;
  const familyName = family === 4 ? 'IPv4 ' : family === 6 ? 'IPv6 ' : '';
  let answers: readonly ResolvedAddress[];
  try {
    const boundMs = resolveBoundMs(request.timeoutMs);
    const refusal = (message: string, withKind: boolean): CredentialsWithheldError =>
      new CredentialsWithheldError(message, {
        sensorId,
        target: host,
        phase: 'resolve',
        ...(withKind ? { kind: first } : {}),
      });
    answers = await resolveWithin(resolve(host, family, { waitMs: boundMs }), signal, boundMs, {
      cancelled: () => refusal(PIN_REFUSALS.cancelled(host), false),
      timedOut: () => refusal(PIN_REFUSALS.resolveTimedOut(host, first, boundMs), true),
    });
  } catch (error: unknown) {
    if (isCredentialsWithheld(error)) throw error;
    // The resolver did not answer, or the probe failed to ask it (`P-426`): neither says
    // the name resolves to nothing, which is what the refusal below would claim.
    const why = error instanceof Error ? error.message : String(error);
    if (notAnswered(error))
      refuse(PIN_REFUSALS.resolveNotAnswered(host, first, why), 'resolve', first);
    if (probeFailed(error)) refuse(PIN_REFUSALS.resolveBusy(host, first, why), 'resolve', first);
    if (tooManyAddresses(error)) {
      refuse(PIN_REFUSALS.resolvedTooMany(host, first, why), 'resolve', first);
    }
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return refuse(
      PIN_REFUSALS.resolvedNothing(
        host,
        first,
        familyName,
        typeof code === 'string' && code !== '' ? ` (${code})` : '',
      ),
      'resolve',
      first,
    );
  }

  // Of the device's family only. A resolver asked for one family answers with that family; one
  // that answers with more is not believed about the rest, and they are never connected to.
  // **An IPv4-mapped address is of the IPv4 family** (`A-85`'s second check): macOS answers a
  // lookup for IPv6 alone with them for a name with only A records, and a connection to one goes
  // over IPv4. It is kept as spelled, as `checkedTarget` keeps it.
  const candidates = answers.filter((answer) => {
    const version = isIP(unmapped(answer.address));
    return version !== 0 && (family === 0 || version === family);
  });
  if (candidates.length === 0) {
    refuse(PIN_REFUSALS.resolvedNothing(host, first, familyName, ''), 'resolve', first);
  }

  for (const candidate of candidates) {
    for (const { kind, targets } of undecided) {
      if (targetVerdict(candidate.address, targets) !== 'inside') {
        refuse(PIN_REFUSALS.resolvedOutside(host, kind, candidate.address), 'check', kind);
      }
    }
  }

  // Every candidate is inside, so any of them may be used. IPv4 first when the device does not
  // say, which is what SNMP has always done with `auto`; then the resolver's own order.
  const chosen =
    (family === 0 ? candidates.find((candidate) => isIP(candidate.address) === 4) : undefined) ??
    candidates[0];
  if (chosen === undefined) {
    return refuse(PIN_REFUSALS.resolvedNothing(host, first, familyName, ''), 'resolve', first);
  }
  return { address: chosen.address, family: isIP(chosen.address) === 6 ? 6 : 4 };
}

/**
 * The resolution, or the caller's own error as soon as the check is cancelled or the
 * resolution's time is up: `getaddrinfo` cannot be cancelled, so it is left behind.
 *
 * Shared by the two places that resolve a name in order to check it: `pinTarget` above, and the
 * HTTP transport's target-policy guard (`A-54`). Each says what its own refusal reads as.
 *
 * **And counted here, for Probe Health** (`A-66`, `P-426`): a lookup made outside the probe's
 * resolver is in flight until it is answered, whether or not the check still waits, and a check
 * that stops waiting, or whose lookup ends with the resolver not answering (`notAnswered`), is
 * given up, once. `nameLookups` says what each number is.
 */
export function resolveWithin(
  pending: Promise<readonly ResolvedAddress[]>,
  signal: AbortSignal | undefined,
  boundMs: number,
  errors: { readonly cancelled: () => Error; readonly timedOut: () => Error },
  counted: LookupCount = nameLookups,
): Promise<readonly ResolvedAddress[]> {
  counted.track(pending);
  if (signal?.aborted === true) {
    // Nobody is waiting for it any more, and a rejection nobody handles ends the worker.
    pending.catch(() => undefined);
    counted.gaveUp();
    return Promise.reject(errors.cancelled());
  }
  return new Promise((resolve, reject) => {
    // Settled once, whichever comes first: a late answer or failure after the check stopped
    // waiting is the resolver's business, and counting it again would count one check twice.
    let settled = false;
    const done = (): boolean => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (settled) return false;
      settled = true;
      return true;
    };
    const onAbort = (): void => {
      if (!done()) return;
      counted.gaveUp();
      reject(errors.cancelled());
    };
    const timer = setTimeout(() => {
      if (!done()) return;
      counted.gaveUp();
      reject(errors.timedOut());
    }, boundMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (answers) => {
        if (done()) resolve(answers);
      },
      (error: unknown) => {
        if (!done()) return;
        // The resolver said it did not answer (`P-426`): this check fails for want of an answer
        // as surely as one that waited out its bound, and sooner.
        if (notAnswered(error)) counted.gaveUp();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** A name as it is compared: lower case, without one trailing dot. */
function nameOf(host: string): string {
  const lower = host.trim().toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

/**
 * The `lookup` a socket is given in place of the system resolver (`A-41c`): it answers the
 * device's name with the address that was checked, and nothing else with anything.
 *
 * The socket still believes it is connecting to the name, so TLS sends the name as SNI and
 * checks the certificate against it, and HTTP sends it as `Host`. Only the address comes from
 * here. A lookup for any other name is refused before a byte is sent: it means something between
 * the check and the socket chose another destination, a proxy for one.
 */
export function pinnedLookup(host: string, pinned: PinnedAddress): LookupFunction {
  return (hostname, options, callback) => {
    if (nameOf(hostname) !== nameOf(host)) {
      callback(
        new CredentialsWithheldError(PIN_REFUSALS.otherName(host, hostname), {
          target: host,
          phase: 'connect',
        }),
        '',
      );
      return;
    }
    if (options.all === true) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

/**
 * The refusal for a connection whose far end is not the address that was checked, or null when
 * it is. Asked of a connected socket's `remoteAddress`, where a transport has one to ask.
 *
 * A connection with no remote address is refused: it is closed already, or is not a network
 * socket, and neither is a connection to the address that was checked.
 */
export function pinnedPeerRefusal(
  host: string,
  pinned: PinnedAddress,
  remoteAddress: string | undefined,
): CredentialsWithheldError | null {
  const actual = remoteAddress ?? '';
  const version = isIP(actual);
  if (version !== 0) {
    // A `BlockList`, as the targets are matched: an IPv4 peer reported in its IPv6-mapped
    // spelling is the same peer.
    const list = new BlockList();
    list.addAddress(pinned.address, pinned.family === 6 ? 'ipv6' : 'ipv4');
    if (list.check(actual, version === 6 ? 'ipv6' : 'ipv4')) return null;
  }
  return new CredentialsWithheldError(
    PIN_REFUSALS.otherPeer(host, pinned.address, actual === '' ? 'no address' : actual),
    { target: host, phase: 'connect' },
  );
}
