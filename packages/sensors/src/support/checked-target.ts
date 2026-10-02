import { isIP, type LookupFunction } from 'node:net';
import { refuses, type TargetPolicy } from '@ms/shared';
import type { CheckTarget } from '../contract.js';
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
   * resolver is asked for that family and only answers of it are used.
   */
  readonly family?: 0 | 4 | 6;
  /** The address `pinTarget` pinned for a credential set, when it did (`CheckTarget.pinned`). */
  readonly pinned?: PinnedAddress;
  /** `CheckTarget.policy`. Absent, the default. */
  readonly policy?: TargetPolicy;
  /** `CheckTarget.resolve`. Absent, the system's resolver. */
  readonly resolve?: ResolveHost;
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
 * The part of a check that is the same for every transport: the device's host, and what the
 * catalogue put beside it. Spread into a `TargetCheck`, so no transport can pass the host and
 * forget the pin, the policy or the resolver.
 */
export function guardOf(
  target: CheckTarget,
): Pick<TargetCheck, 'host' | 'pinned' | 'policy' | 'resolve'> {
  return {
    host: target.host,
    ...(target.pinned === undefined ? {} : { pinned: target.pinned }),
    ...(target.policy === undefined ? {} : { policy: target.policy }),
    ...(target.resolve === undefined ? {} : { resolve: target.resolve }),
  };
}

/** A resolution the guard gave up on. Its message is already the whole diagnosis. */
class ResolveGivenUp extends Error {}

function refusal(
  check: Pick<TargetCheck, 'host' | 'verb'>,
  policy: TargetPolicy,
  address: string,
  reason: string,
): Error {
  const what =
    address === check.host
      ? `${check.host}, which is ${reason}`
      : `${check.host}: it resolves to ${address}, which is ${reason}`;
  return new TargetRefusedError(
    `refusing to ${check.verb} ${what}; this probe’s target policy (${policy}) refuses it, ` +
      'as it does every cloud instance-metadata address, and probe.targetPolicy “none” ' +
      'refuses nothing',
    { target: check.host, address, policy },
  );
}

/**
 * Refuses a device given as an address the policy blocks. Nothing is resolved: a name passes.
 *
 * On its own, this is all a transport that cannot be held to an address is given: a database
 * driver or PowerShell resolves a name itself, so a lookup made here would be one the
 * connection never uses, and a check that whoever runs the name's DNS answers as they like.
 */
export function refuseBlockedAddress(
  host: string,
  declared: TargetPolicy | undefined,
  verb: string,
): void {
  const policy = declared ?? DEFAULT_TARGET_POLICY;
  if (policy === 'none' || isIP(host) === 0) return;
  const reason = refuses(policy, host);
  if (reason !== null) throw refusal({ host, verb }, policy, host, reason);
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
  const judge = (address: string): void => {
    const reason = policy === 'none' ? null : refuses(policy, address);
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
  let answers: Awaited<ReturnType<ResolveHost>>;
  try {
    answers = await resolveWithin(
      (check.resolve ?? systemResolve)(host, family),
      check.signal,
      boundMs,
      {
        cancelled: () => new ResolveGivenUp(`the check was cancelled while ${check.doing}`),
        timedOut: () =>
          new ResolveGivenUp(
            `the device’s host name did not resolve within ${String(boundMs)} ms, ` +
              `${check.doing} — the probe’s resolver is not answering`,
          ),
      },
    );
  } catch (error: unknown) {
    if (error instanceof ResolveGivenUp) throw error;
    throw says(error);
  }

  // Every answer is checked before any is used. One that is not an address, or is of a family
  // the transport would not use, is never connected to, so there is nothing of it to check.
  const addresses: PinnedAddress[] = [];
  for (const answer of answers) {
    const version = isIP(answer.address);
    if (version === 0 || (family !== 0 && version !== family)) continue;
    judge(answer.address);
    addresses.push({ address: answer.address, family: version === 6 ? 6 : 4 });
  }
  if (addresses.length === 0) throw says(undefined);
  return { addresses, byGuard: true };
}

function unresolved(check: TargetCheck, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  const family = check.family === 4 ? 'an IPv4 ' : check.family === 6 ? 'an IPv6 ' : 'an ';
  return new Error(
    `the device’s host name did not resolve to ${family}address, ${check.doing}` +
      (typeof code === 'string' && code !== '' ? ` (${code})` : ''),
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
 * What a socket is given for a checked target: nothing when the transport connects as it always
 * has, `checkedLookup` for the guard's addresses. A target pinned for a credential set is not
 * this function's: its transport already answers with `pinnedLookup`.
 */
export function lookupFor(
  host: string,
  checked: CheckedTarget | null,
): { lookup?: LookupFunction } {
  return checked?.byGuard === true ? { lookup: checkedLookup(host, checked.addresses) } : {};
}
