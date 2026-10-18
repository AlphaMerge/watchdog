// The module, not its named export: `dns.lookup` is read when a socket asks, as Node's own
// sockets read it, so one that is replaced (a test's) is the one asked.
import dns, { type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { excepts, refuses, unmapped, type TargetPolicy } from '@ms/shared';
import type { CheckTarget } from '../contract.js';
import { notAnswered, probeFailed, tooManyAddresses } from './lookups.js';
import { PhasedError } from './phased-error.js';
import {
  resolveBoundMs,
  resolveWithin,
  systemResolve,
  type PinnedAddress,
  type ResolveHost,
} from './pinned-target.js';

/**
 * The target policy, for every transport that connects to a device (`A-09`, `A-54`, `A-57`).
 *
 * `A-09` put the guard on the HTTP sensors, where the answer is stored and shown. `A-57` holds
 * every other transport that connects by name or address to the same rule: a probe is not made
 * to speak to an address the policy names, whatever protocol it would speak there.
 *
 * **One lookup, and the connection goes to an address it answered with** (`A-54`). `checkedTarget`
 * is the one place that resolves a name in order to check it against the policy. It asks the
 * resolver once, checks *every* answer, and hands back the addresses that were checked. A
 * transport then connects to one of those and never resolves the name again: a socket is given
 * `checkedLookup`, and a transport with no socket of its own to hook (SNMP's UDP session) is
 * given the address. Whoever runs the name's DNS cannot answer the check with
 * a harmless address and the connection with `169.254.169.254`.
 *
 * **A refusal here is an ordinary failed check**, not `CredentialsWithheldError`: no credential
 * set is behind it, the sensor reads Down, and the message names the device, the address and
 * the policy.
 *
 * **One device's exception is read here and nowhere else** (`A-64`): `CheckTarget.policyException`,
 * the addresses of that device an administrator let its sensors reach although the policy
 * refuses them. Every function below that judges an address asks `excepts` about it after the
 * policy has refused it, so the exception can only ever let through an address the lookup
 * answered with (or the device was given as) and the list names. A name is never in the list.
 */

/** Set by the probe from `probe.targetPolicy`, in the environment its workers inherit. */
export const TARGET_POLICY_ENV = 'MS_TARGET_POLICY';

/** What applies when nobody says: `A-09`'s default, and the reason it is the default is there. */
export const DEFAULT_TARGET_POLICY: TargetPolicy = 'link-local';

/**
 * The policy this probe was configured with. Anything that is not one of the three names is the
 * default: a typo must not be a way to turn the guard off.
 */
export function targetPolicyFrom(env: NodeJS.ProcessEnv = process.env): TargetPolicy {
  const declared = (env[TARGET_POLICY_ENV] ?? '').trim();
  return declared === 'none' || declared === 'private' || declared === 'link-local'
    ? declared
    : DEFAULT_TARGET_POLICY;
}

/** A device the target policy refused. Nothing was sent to it. */
export class TargetRefusedError extends Error {
  /** The device's host, as the device names it. */
  readonly target: string;
  /** The address that was refused: the host itself, or one it resolved to. */
  readonly address: string;
  readonly policy: TargetPolicy;
  readonly phase = 'check';

  constructor(message: string, context: { target: string; address: string; policy: TargetPolicy }) {
    super(message);
    this.name = 'TargetRefusedError';
    this.target = context.target;
    this.address = context.address;
    this.policy = context.policy;
  }
}

/**
 * Where a check may connect: the addresses that were checked, in the resolver's order.
 */
export interface CheckedTarget {
  readonly addresses: readonly PinnedAddress[];
  /** Resolved here by the guard, rather than pinned for a credential set (`A-41c`). */
  readonly byGuard: boolean;
}

export interface TargetCheck {
  /** The device's host: a name or a literal address. */
  readonly host: string;
  /**
   * The family the transport would connect over: 4, 6, or 0 for whichever the name has. The
   * resolver is asked for that family and only answers of it are used. **The device's, from
   * `familyOf`, for every transport but SNMP** (`A-85`), which reads `auto` as IPv4.
   */
  readonly family?: 0 | 4 | 6;
  /** The address `pinTarget` pinned for a credential set, when it did (`CheckTarget.pinned`). */
  readonly pinned?: PinnedAddress;
  /** `CheckTarget.policy`. Absent, the default. */
  readonly policy?: TargetPolicy;
  /** `CheckTarget.resolve`. Absent, the system's resolver. */
  readonly resolve?: ResolveHost;
  /** `CheckTarget.policyException` (`A-64`). Absent, nothing is excepted. */
  readonly exception?: readonly string[];
  /** What the transport has to connect in. The one lookup is given part of it (`resolveBoundMs`). */
  readonly timeoutMs?: number;
  readonly signal: AbortSignal;
  /** What is refused, as a verb: `connect to`, `request`, `scan`, `query`. */
  readonly verb: string;
  /** What was being done when the name would not resolve: `connecting to switch:22`. */
  readonly doing: string;
  /** The transport's own words for a name that does not resolve. Absent, this module's. */
  readonly unresolved?: (error: unknown) => Error;
}

/**
 * The family a device's checks connect over (`A-85`): 4 for `v4`, 6 for `v6`, and 0, whichever
 * the name has, for `auto`.
 *
 * **Asked of the guard and of the connect, both.** Handed to `checkedTarget` as `family`, it is
 * the family the resolver is asked for and the only one whose answers are judged, so an address
 * of the other family can neither refuse the check nor be connected to. Handed to `lookupFor`,
 * it holds the connection to that family where nothing was checked: under the `none` policy,
 * where `checkedTarget` returns null and the socket resolves the name itself, it is answered by
 * `familyLookup`. **The socket itself is never told the family**: see `familyLookup`. A device
 * given as an address connects to that address whatever this says, as `port.*` always has.
 * SNMP alone reads `auto` as IPv4, as it always has.
 */
export function familyOf(ipVersion: CheckTarget['ipVersion']): 0 | 4 | 6 {
  return ipVersion === 'v4' ? 4 : ipVersion === 'v6' ? 6 : 0;
}

/**
 * The family an answer is of, for holding a connection to the device's: 4, 6, or 0 for an
 * answer that is no address. **An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is IPv4**
 * (`A-85`'s second check). macOS answers a lookup for IPv6 alone, with no hints, with mapped
 * addresses for a name that has only A records, and a socket connecting to one goes over IPv4:
 * a `v6` device would be reached over the family it rules out.
 *
 * Only the family is read so. The answer is kept as it was spelled, which is what the policy's
 * refusal names and what the socket is handed: it connects to a mapped address as IPv6, and the
 * kernel carries it over IPv4, as it always did for a device that allows IPv4.
 */
export function familyOfAnswer(address: string): 0 | 4 | 6 {
  const version = isIP(unmapped(address));
  return version === 4 ? 4 : version === 6 ? 6 : 0;
}

/** An answer as a socket is handed it: as spelled, with the family `isIP` gives it. */
function asAnswered(address: string): PinnedAddress {
  return { address, family: isIP(address) === 6 ? 6 : 4 };
}

/**
 * What a name that did not resolve did not resolve to, for a sentence: `an IPv4 address`, `an
 * IPv6 address`, or `an address`. The guard's words, which a transport's own say too (`A-85`).
 */
export function anAddressOf(family: 0 | 4 | 6 | undefined): string {
  return family === 4 ? 'an IPv4 address' : family === 6 ? 'an IPv6 address' : 'an address';
}

/**
 * A name with no address the check would use, in a transport's words (`A-85`): `did not
 * resolve to an IPv6 address` for a device set to a family, as the guard says, and `did not
 * resolve` for one on `auto`, as each transport always has.
 */
export function noAddressSaid(family: 0 | 4 | 6 | undefined, doing: string): string {
  const to = family === 4 || family === 6 ? ` to ${anAddressOf(family)}` : '';
  return `the device’s host name did not resolve${to}, ${doing}`;
}

/**
 * What a socket's own lookup of the device's name said, in the guard's words (`A-85`), where
 * nothing checked the name first: under `none`, or for a driver that resolved a name it was
 * routed to. Undefined for any other failure.
 *
 * - **`ENOTFOUND`** is a name with no address the socket asked for: of the device's family,
 *   where it names one, which the sentence then says, so that a name with only the other
 *   family's records is not read as a name that does not exist.
 * - **`EAI_AGAIN`** is the resolver not answering, and says so, as the guard does (`P-426`):
 *   blaming a record of the family would send the operator to DNS records that are there.
 */
export function socketUnresolved(
  code: unknown,
  family: 0 | 4 | 6 | undefined,
  doing: string,
): string | undefined {
  if (code === 'ENOTFOUND') return noAddressSaid(family, doing);
  if (code === 'EAI_AGAIN') {
    return (
      `the device’s host name did not resolve, ${doing} — the probe’s resolver is not ` +
      'answering (EAI_AGAIN)'
    );
  }
  return undefined;
}

/** One address a connection tried, and the code it failed with. */
export interface ConnectAttempt {
  readonly address: string;
  readonly code: string;
}

/**
 * How far a connect got, furthest first: a refusal is a host that answered, a timeout is one
 * that may be there, and the rest never left this machine (`A-74`). What a name with several
 * addresses is diagnosed by, whichever order they were tried in. A code not here comes last.
 */
export const REACHED: readonly string[] = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'EAFNOSUPPORT',
];

/** The attempt of `attempts` that got furthest (`REACHED`), or undefined for none. */
export function furthestAttempt<T extends ConnectAttempt>(attempts: readonly T[]): T | undefined {
  const rank = (code: string): number => {
    const at = REACHED.indexOf(code);
    return at < 0 ? REACHED.length : at;
  };
  return [...attempts].sort((a, b) => rank(a.code) - rank(b.code))[0];
}

/** A connect's failure, read for a sentence (`connectFailure`). */
export interface ConnectFailure {
  /** The code to diagnose it by: of the attempt that got furthest, where there were several. */
  readonly code: string;
  /** What that attempt said, never empty. */
  readonly message: string;
  /** ` — every address it has was tried: 192.0.2.10 ETIMEDOUT, …`, or empty for one address. */
  readonly tried: string;
}

/** ` — every address it has was tried: …` for more than one attempt, and empty otherwise. */
export function triedSaid(attempts: readonly ConnectAttempt[]): string {
  if (attempts.length < 2) return '';
  const each = attempts.map(
    (one) => `${one.address === '' ? 'an address' : one.address} ${one.code || 'failed'}`,
  );
  return ` — every address it has was tried: ${each.join(', ')}`;
}

/**
 * What a socket's failure to connect was, for a transport to word (`A-85`'s second check).
 *
 * **A name with several addresses fails as an `AggregateError`**: Node walks them
 * (`autoSelectFamily`) and, when every one fails, ends the socket with one error per address,
 * an empty message, and the first attempt's code. A transport that read its message said
 * nothing after "could not connect to", and one that read its code diagnosed by the first
 * address tried. This reads the attempt that got furthest, as `describeDbError` does (`A-74`),
 * for the code and the words, and names every address tried with its code, so the one that
 * was not chosen is not lost. `attempts` are the transport's own, where it tried the addresses
 * one at a time (HTTP); absent, the error's.
 */
export function connectFailure(
  error: unknown,
  attempts: readonly ConnectAttempt[] = attemptsOf(error),
): ConnectFailure {
  const failures =
    error instanceof AggregateError
      ? (error.errors as unknown[]).filter((one) => one !== null)
      : [];
  const furthest = furthestAttempt(
    failures.map((one) => ({ ...attemptOf(one), error: one })),
  )?.error;
  const chosen = furthest ?? error;
  const code = codeOf(chosen) || codeOf(error);
  const said = chosen instanceof Error ? chosen.message : String(chosen);
  return {
    code: furthestAttempt(attempts)?.code ?? code,
    message: said !== '' ? said : code !== '' ? code : 'the connection failed',
    tried: triedSaid(attempts),
  };
}

/** Every address an `AggregateError` from Node's address walk tried, with its code. */
export function attemptsOf(error: unknown): ConnectAttempt[] {
  if (!(error instanceof AggregateError)) return [];
  return (error.errors as unknown[]).map(attemptOf);
}

function attemptOf(failed: unknown): ConnectAttempt {
  const address = (failed as { address?: unknown } | null)?.address;
  return { address: typeof address === 'string' ? address : '', code: codeOf(failed) };
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

/**
 * The device's name resolved once by the system's lookup, where nothing checked it (`none`),
 * for a check that connects to it many times (`port.range`, `A-85`'s second check): of the
 * device's family alone, and every address of it, each port's socket then answered from it
 * (`checkedLookup`), so a scan is of one device.
 *
 * **Bounded by `withinMs`, the time a socket's own lookup had**, and not by the guard's half
 * of it (`resolveBoundMs`): the guard asks the probe's resolver, which keeps an answer and
 * serves it while it refreshes, and this asks `getaddrinfo` every scan. A resolver that takes
 * longer than half a port's timeout answered every socket in time, and must not fail the scan
 * as one that does not answer (`A-85`'s third check).
 *
 * **A name that does not resolve fails the check**, in the `resolve` phase and the guard's
 * words (`socketUnresolved`): a port whose socket's lookup failed was counted closed, and a
 * name with no address of the family read as "0 of N open", a measurement of nothing.
 */
export async function resolvedUnchecked(check: {
  readonly host: string;
  readonly family: 0 | 4 | 6;
  /** How long the lookup may take: what each socket's own had. */
  readonly withinMs: number;
  readonly signal: AbortSignal;
  readonly doing: string;
  /** The platform the hints are Node's for (`process.platform`); a test's to name. */
  readonly platform?: NodeJS.Platform;
}): Promise<readonly PinnedAddress[]> {
  const where = { phase: 'resolve', host: check.host } as const;
  const boundMs = Math.max(1, check.withinMs);
  const lookup: LookupFunction =
    check.family === 0
      ? (hostname, options, callback) => {
          dns.lookup(hostname, options, callback);
        }
      : familyLookup(check.family);
  const answers = await new Promise<readonly LookupAddress[]>((resolve, reject) => {
    let settled = false;
    const settle = (): boolean => {
      clearTimeout(timer);
      check.signal.removeEventListener('abort', onAbort);
      if (settled) return false;
      settled = true;
      return true;
    };
    const onAbort = (): void => {
      if (settle()) reject(new PhasedError(`the check was cancelled while ${check.doing}`, where));
    };
    const timer = setTimeout(() => {
      if (!settle()) return;
      reject(
        new PhasedError(
          `the device’s host name did not resolve within ${String(boundMs)} ms, ` +
            `${check.doing} — the probe’s resolver is not answering`,
          where,
        ),
      );
    }, boundMs);
    if (check.signal.aborted) {
      onAbort();
      return;
    }
    check.signal.addEventListener('abort', onAbort, { once: true });
    // Asked as a socket asks, for every address, and with `ADDRCONFIG` where Node's sockets add
    // it: for either family, and not on Windows (`net.js`, `lookupAndConnect`, `!isWindows`).
    const addrconfig = check.family === 0 && (check.platform ?? process.platform) !== 'win32';
    lookup(
      check.host,
      { all: true, ...(addrconfig ? { hints: dns.ADDRCONFIG } : {}) },
      (error, address, got) => {
        if (!settle()) return;
        if (error !== null) {
          const message = error.message;
          reject(
            new PhasedError(
              socketUnresolved(error.code, check.family, check.doing) ??
                `the device’s host name could not be resolved, ${check.doing} — ${message}`,
              where,
              error,
            ),
          );
          return;
        }
        resolve(typeof address === 'string' ? [{ address, family: got ?? 0 }] : address);
      },
    );
  });
  // Of the device's family already, where it names one: `familyLookup` answers no other.
  const addresses = answers
    .filter((one) => isIP(one.address) !== 0)
    .map((one) => asAnswered(one.address));
  if (addresses.length === 0)
    throw new PhasedError(noAddressSaid(check.family, check.doing), where);
  return addresses;
}

/**
 * The part of a check that is the same for every transport: the device's host, and what the
 * catalogue put beside it. Spread into a `TargetCheck`, so no transport can pass the host and
 * forget the pin, the policy or the resolver. **Not the family**, which each transport passes
 * beside it (`familyOf`, `A-85`), since SNMP reads the device's `auto` as IPv4 and every other
 * transport as either.
 */
export function guardOf(
  target: CheckTarget,
): Pick<TargetCheck, 'host' | 'pinned' | 'policy' | 'resolve' | 'exception'> {
  return {
    host: target.host,
    ...(target.pinned === undefined ? {} : { pinned: target.pinned }),
    ...(target.policy === undefined ? {} : { policy: target.policy }),
    ...(target.resolve === undefined ? {} : { resolve: target.resolve }),
    ...(target.policyException === undefined ? {} : { exception: target.policyException }),
  };
}

/** A resolution the guard gave up on. Its message is already the whole diagnosis. */
class ResolveGivenUp extends PhasedError {}

function refusal(
  check: Pick<TargetCheck, 'host' | 'verb' | 'exception'>,
  policy: TargetPolicy,
  address: string,
  reason: string,
): Error {
  const what =
    address === check.host
      ? `${check.host}, which is ${reason}`
      : `${check.host}: it resolves to ${address}, which is ${reason}`;
  // Said only where the device has one, so that a refusal on a device with an exception says
  // why the exception did not cover it (`A-64`).
  const excepted =
    check.exception === undefined || check.exception.length === 0
      ? ''
      : `; this device’s exception (${check.exception.join(', ')}) does not cover ${address}`;
  return new TargetRefusedError(
    `refusing to ${check.verb} ${what}; this probe’s target policy (${policy}) refuses it, ` +
      'as it does every cloud instance-metadata address, and probe.targetPolicy “none” ' +
      `refuses nothing${excepted}`,
    { target: check.host, address, policy },
  );
}

/**
 * Whether the policy refuses this address for this device, and why: its reason, or null where
 * the policy allows it or the device's exception names it (`A-64`). The one judgement every
 * function here makes.
 */
function judged(
  policy: TargetPolicy,
  address: string,
  exception: readonly string[] | undefined,
): string | null {
  const reason = refuses(policy, address);
  return reason === null || excepts(exception, address) ? null : reason;
}

/**
 * Refuses a device given as an address the policy blocks. Nothing is resolved: a name passes.
 *
 * On its own, this is all a transport that cannot be held to an address is given: PowerShell
 * resolves a name itself, so a lookup made here would be one the connection never uses, and a
 * check that whoever runs the name's DNS answers as they like. The database drivers were here
 * too until `A-62` handed them a socket.
 */
export function refuseBlockedAddress(
  host: string,
  declared: TargetPolicy | undefined,
  verb: string,
  exception?: readonly string[],
): void {
  const policy = declared ?? DEFAULT_TARGET_POLICY;
  if (policy === 'none' || isIP(host) === 0) return;
  const reason = judged(policy, host, exception);
  if (reason !== null) {
    throw refusal(
      { host, verb, ...(exception === undefined ? {} : { exception }) },
      policy,
      host,
      reason,
    );
  }
}

/**
 * Refuses a Unix socket path where the policy refuses the probe's own machine (`A-70`).
 *
 * A path is not a network target, and it is not nowhere either: it is a socket on the machine
 * the probe runs on, which is what loopback is. A probe whose policy refuses `127.0.0.1` has
 * been told it must not be pointed at itself, and a device whose host is `/var/run/postgresql`
 * points it there as surely as one whose host is `127.0.0.1`: on a single-host installation,
 * at the core's own database.
 *
 * **The policy's own answer for loopback decides it**, asked of `refuses` and not kept as a
 * second list: wherever a policy refuses `127.0.0.1` it refuses a path, and where it allows
 * one it allows the other. A device whose exception names `127.0.0.1` (`A-64`) is allowed its
 * path for the same reason: the path is judged as that address, exception and all.
 */
export function refuseLocalSocket(
  path: string,
  declared: TargetPolicy | undefined,
  verb: string,
  exception?: readonly string[],
): void {
  const policy = declared ?? DEFAULT_TARGET_POLICY;
  const reason = judged(policy, '127.0.0.1', exception);
  if (reason === null) return;
  throw refusal(
    { host: path, verb, ...(exception === undefined ? {} : { exception }) },
    policy,
    path,
    `a socket on this probe’s own machine, as 127.0.0.1 is, and that is ${reason}`,
  );
}

/**
 * Refuses a host whose addresses the policy blocks, and says where the check may connect.
 *
 * Null when the transport is handed `host` as it is, because nothing would resolve it (an
 * address, which is checked as it stands) or nothing is checked (`none`).
 *
 * - **A pinned target** (`A-41c`) goes to one address and resolves nothing, so that address is
 *   the whole of what there is to check, and a second lookup here would be the one nobody
 *   checked.
 * - **A name** is resolved once and *every* address it answers with is checked: a name with a
 *   record inside the network and one pointing at metadata is refused on the second.
 * - **A name that does not resolve fails here**, and is not left to the socket to try again,
 *   which would be a second lookup.
 */
export async function checkedTarget(check: TargetCheck): Promise<CheckedTarget | null> {
  const host = check.host;
  const policy = check.policy ?? DEFAULT_TARGET_POLICY;
  // The policy, and then this device's exception to it (`A-64`), over one address at a time: the
  // pinned one, the one the device was given as, or each the lookup answered with.
  const judge = (address: string): void => {
    const reason = policy === 'none' ? null : judged(policy, address, check.exception);
    if (reason !== null) throw refusal(check, policy, address, reason);
  };

  if (check.pinned !== undefined) {
    judge(check.pinned.address);
    return { addresses: [check.pinned], byGuard: false };
  }
  if (policy === 'none') return null;
  if (isIP(host) !== 0) {
    judge(host);
    return null;
  }

  const family = check.family ?? 0;
  // A name that did not resolve, in the transport's own words where it has them. `undefined`
  // is a resolver that answered with no address the transport would use.
  const says = (error: unknown): Error =>
    check.unresolved === undefined ? unresolved(check, error) : check.unresolved(error);
  // Bounded, and ended with the check: `getaddrinfo` cannot be cancelled, and a resolver that
  // does not answer would otherwise hold the check until its runner gave up on it.
  const boundMs = resolveBoundMs(check.timeoutMs);
  // Where each of the guard's own failures was (`P-406`): the device's name, while resolving it.
  const resolving = { phase: 'resolve', host } as const;
  let answers: Awaited<ReturnType<ResolveHost>>;
  try {
    answers = await resolveWithin(
      (check.resolve ?? systemResolve)(host, family, { waitMs: boundMs }),
      check.signal,
      boundMs,
      {
        cancelled: () =>
          new ResolveGivenUp(`the check was cancelled while ${check.doing}`, resolving),
        timedOut: () =>
          new ResolveGivenUp(
            `the device’s host name did not resolve within ${String(boundMs)} ms, ` +
              `${check.doing} — the probe’s resolver is not answering`,
            resolving,
          ),
      },
    );
  } catch (error: unknown) {
    if (error instanceof ResolveGivenUp) throw error;
    // Not an answer about the name (`P-426`): the resolver did not answer it, or the probe failed
    // to ask (too busy, or its resolver's own fault), in the probe's words. Neither is worded as
    // a name that does not exist.
    const why = error instanceof Error ? error.message : String(error);
    if (notAnswered(error)) {
      throw new ResolveGivenUp(
        `the device’s host name did not resolve, ${check.doing} — the probe’s resolver is not ` +
          `answering (${why})`,
        resolving,
      );
    }
    if (probeFailed(error)) {
      throw new ResolveGivenUp(
        `the device’s host name could not be resolved, ${check.doing} — ${why}`,
        resolving,
      );
    }
    // An answer, and the opposite of none: the resolver's own words name the count. Ahead of a
    // transport's own words for a name that did not resolve, which would say the opposite.
    if (tooManyAddresses(error)) {
      throw new PhasedError(
        `the device’s host name could not be used, ${check.doing} — ${why}`,
        resolving,
      );
    }
    throw says(error);
  }

  // Every answer is checked before any is used. One that is not an address, or is of a family
  // the transport would not use, is never connected to, so there is nothing of it to check.
  // A mapped address is of the IPv4 family (`familyOfAnswer`), whatever `isIP` calls it.
  const addresses: PinnedAddress[] = [];
  for (const answer of answers) {
    const version = familyOfAnswer(answer.address);
    if (version === 0 || (family !== 0 && version !== family)) continue;
    judge(answer.address);
    addresses.push(asAnswered(answer.address));
  }
  if (addresses.length === 0) throw says(undefined);
  return { addresses, byGuard: true };
}

function unresolved(check: TargetCheck, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return new PhasedError(
    `the device’s host name did not resolve to ${anAddressOf(check.family)}, ${check.doing}` +
      (typeof code === 'string' && code !== '' ? ` (${code})` : ''),
    { phase: 'resolve', host: check.host },
  );
}

/** A name as it is compared: lower case, without one trailing dot. */
function nameOf(host: string): string {
  const lower = host.trim().toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

/**
 * The `lookup` a socket is given in place of the system resolver: it answers the device's name
 * with the addresses the guard checked, and nothing else with anything.
 *
 * **All of them, where the socket asks for all.** Node walks a name's addresses itself when it
 * connects (`autoSelectFamily`), moving on from one that refuses or does not answer, and a
 * device whose first address is dead was Up for that reason. Handing the socket the whole
 * checked list keeps that walk, over addresses that were every one of them checked. A socket
 * that asks for one address, or for one family, gets the first that fits.
 *
 * The socket still believes it is connecting to the name, so TLS sends the name as SNI and
 * checks the certificate against it. `pinnedLookup` is the same thing for the one address a
 * credential set was checked against, and keeps that refusal's class; this one fails the check.
 */
export function checkedLookup(host: string, addresses: readonly PinnedAddress[]): LookupFunction {
  return (hostname, options, callback) => {
    if (nameOf(hostname) !== nameOf(host)) {
      callback(
        new Error(
          `the connection for ${host} asked to resolve ${hostname}, which is not the name that ` +
            'was checked against the target policy, so nothing was sent',
        ),
        '',
      );
      return;
    }
    const wanted = options.family === 4 || options.family === 6 ? options.family : 0;
    const fitting = addresses.filter((one) => wanted === 0 || one.family === wanted);
    const first = fitting[0];
    if (first === undefined) {
      callback(
        Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }),
        '',
      );
      return;
    }
    if (options.all === true) {
      callback(
        null,
        fitting.map((one) => ({ address: one.address, family: one.family })),
      );
      return;
    }
    callback(null, first.address, first.family);
  };
}

/**
 * The lookup a socket is given for a device set to a family, where nothing checked the name
 * (`A-85`): under `none`, and for a server a driver is routed to there. The system's
 * `getaddrinfo`, asked for that family alone, and for **every** address of it when the socket
 * asks for all.
 *
 * **In place of telling the socket the family**, which is never done. A socket told `family`
 * asks its lookup for one address and connects to that alone, so a name whose first address
 * is dead fails, where a socket told nothing asks for all of them and walks them
 * (`autoSelectFamily`), passing the dead one as it does over the checked addresses (`A-54`).
 * Given this, the socket still asks for all, and is answered with that family's.
 *
 * **Without `ADDRCONFIG`**, which Node adds only when it is asking for either family: told one,
 * it asked without, and so does the guard.
 */
export function familyLookup(family: 4 | 6): LookupFunction {
  return (hostname, options, callback) => {
    const { hints, ...asked } = options;
    dns.lookup(
      hostname,
      {
        ...asked,
        all: true,
        family,
        ...(hints === undefined || hints === dns.ADDRCONFIG ? {} : { hints }),
      },
      (error, answers: LookupAddress[]) => {
        if (error !== null) {
          callback(error, '');
          return;
        }
        // **Of the family, an IPv4-mapped address being IPv4** (`familyOfAnswer`): what macOS
        // answers an IPv6 lookup with for a name with only A records, which a socket would
        // connect to over IPv4. None left is a name with no address of the family, as the
        // guard says.
        const fitting = answers
          .filter((one) => familyOfAnswer(one.address) === family)
          .map((one) => asAnswered(one.address));
        const [first] = fitting;
        if (first === undefined) {
          callback(
            Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
              code: 'ENOTFOUND',
              syscall: 'getaddrinfo',
              hostname,
            }),
            '',
          );
          return;
        }
        if (options.all === true) callback(null, fitting);
        else callback(null, first.address, first.family);
      },
    );
  };
}

/**
 * What a socket is given for a target: `checkedLookup` for the guard's addresses; where nothing
 * was checked, `familyLookup` for a device set to a family (`A-85`); and otherwise nothing, so
 * the transport connects as it always has. A target pinned for a credential set is not this
 * function's: its transport already answers with `pinnedLookup`.
 */
export function lookupFor(
  host: string,
  checked: CheckedTarget | null,
  family: 0 | 4 | 6 = 0,
): { lookup?: LookupFunction } {
  if (checked?.byGuard === true) return { lookup: checkedLookup(host, checked.addresses) };
  return checked === null && family !== 0 ? { lookup: familyLookup(family) } : {};
}
