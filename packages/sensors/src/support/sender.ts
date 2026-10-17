import { isIP } from 'node:net';
import {
  nameLookups,
  notAnswered,
  probeFailed,
  tooManyAddresses,
  type LookupCount,
} from './lookups.js';
import { PhasedError } from './phased-error.js';
import {
  resolveBoundMs,
  resolveWithin,
  systemResolve,
  type ResolvedAddress,
  type ResolveHost,
} from './pinned-target.js';

/**
 * Whether a listener's sender is the device a sensor sits under (`P-246`).
 *
 * **A sender is an address, and a device's host is as often a name.** A listener records who sent
 * each datagram or connection as the socket reports it. The SNMP-trap type resolved the device's
 * name, and syslog and flow compared the two as strings — so a device addressed by name matched
 * nothing, for ever. syslog read Up at zero messages, where no limit can fire; flow read Down on
 * every scan while flows arrived. The three listener types share this one resolver now, so a fix
 * cannot reach one of them and miss the next.
 *
 * **Both sides are compared in one form**, `canonicalAddress`. A listener bound to `::` is
 * dual-stack, and reports an IPv4 sender as `::ffff:10.1.1.1`, which a device whose host is
 * `10.1.1.1` would otherwise never match; an operator may type an IPv6 address in a case or a
 * zero compression no socket will ever report.
 */

const MAPPED = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * An address in the one form a sender and a device are compared in.
 *
 * - **An IPv4-mapped IPv6 address becomes the IPv4 address it carries**, in any spelling of it.
 * - **Any other IPv6 address takes the URL standard's serialisation**: lower case, the longest run
 *   of zeros compressed. `2001:DB8:0:0::1` typed by an operator is `2001:db8::1` from a socket.
 * - **A zone is kept as written** (`fe80::1%eth0`), because it says which link, and two links may
 *   each have their own `fe80::1`.
 * - **Anything else is returned trimmed and otherwise untouched**: an IPv4 address the parser
 *   accepts is already canonical, and what is not an address will match nothing.
 */
export function canonicalAddress(address: string): string {
  const trimmed = address.trim();
  if (isIP(trimmed) !== 6) return trimmed;

  const zoneAt = trimmed.indexOf('%');
  const bare = zoneAt < 0 ? trimmed : trimmed.slice(0, zoneAt);
  // `[…]` in and out: the URL parser takes no zone, and serialises an IPv6 host in brackets.
  const compressed = new URL(`http://[${bare}]/`).hostname.slice(1, -1);

  const mapped = MAPPED.exec(compressed);
  if (mapped !== null) {
    const high = Number.parseInt(mapped[1] ?? '', 16);
    const low = Number.parseInt(mapped[2] ?? '', 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return zoneAt < 0 ? compressed : `${compressed}${trimmed.slice(zoneAt)}`;
}

/**
 * How a listener sensor's check resolves its device's name (`P-425`): the check's own resolver,
 * signal and deadline, as every other check that resolves a name to use it.
 */
export interface SenderLookup {
  /**
   * The check's resolver: on a probe, the probe's (`P-426`), which the catalogue hands every check
   * as `target.resolve`. The system's when nothing says.
   */
  readonly resolve?: ResolveHost | undefined;
  /** The check's signal: a check that is cancelled stops waiting for the name. */
  readonly signal?: AbortSignal | undefined;
  /** The check's own deadline, of which the lookup has half, ten seconds at most. */
  readonly timeoutMs?: number | undefined;
  /** Where the lookup is counted for Probe Health. This thread's `nameLookups` unless a test says. */
  readonly counted?: LookupCount;
}

/** A check's resolver, signal and deadline, as `fromDevice` takes them. */
export function senderLookup(context: {
  readonly target: { readonly resolve?: ResolveHost };
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}): SenderLookup {
  return { resolve: context.target.resolve, signal: context.signal, timeoutMs: context.timeoutMs };
}

/** The bound's failure, and a cancel's, as `resolveWithin` raises them: passed on as they are. */
class SenderGivenUp extends PhasedError {}

/**
 * A test for "this sender is the device", or a failed check naming a host that stands for nothing.
 *
 * Never a test that matches nothing: a device whose name will not resolve would then be
 * indistinguishable from a quiet one, which is the one failure a listener sensor must not have.
 * `counted` names what the sensor counts, for the message.
 *
 * **Resolved as every check resolves a name it uses** (`P-425`): through `resolveWithin`, with the
 * check's resolver, its signal and half its deadline. It used to be `dns.lookup` with none of them
 * and a five-minute cache of its own in each worker: a resolver that did not answer held the check
 * to the pool's timeout, read as a failed scan, and the worker was recycled when the check could
 * not be stopped; nothing counted the lookup. Now a silent resolver fails the check at the bound,
 * naming the resolver, and the lookup is in Probe Health's counts. Answers are kept by the probe's
 * resolver (`P-426`), not here.
 */
export async function fromDevice(
  host: string,
  counted: string,
  lookup: SenderLookup = {},
): Promise<(source: string) => boolean> {
  const name = host.trim();
  const where = { phase: 'resolve', host: name } as const;
  const unresolved = (what: string): PhasedError =>
    new PhasedError(
      `this sensor counts only ${counted} from ${host}, and that name ${what} — so nothing could ` +
        'be attributed to this device. Give the device a literal address, or turn off “only ' +
        'this device”',
      where,
    );
  if (name === '') throw unresolved('did not resolve to any address');
  if (isIP(name) !== 0) {
    const mine = canonicalAddress(name);
    return (source) => canonicalAddress(source) === mine;
  }

  const boundMs = resolveBoundMs(lookup.timeoutMs);
  let answers: readonly ResolvedAddress[];
  try {
    answers = await resolveWithin(
      (lookup.resolve ?? systemResolve)(name, 0, { waitMs: boundMs }),
      lookup.signal,
      boundMs,
      {
        cancelled: () =>
          new SenderGivenUp(
            `the check was cancelled while ${host} was being resolved to tell its ${counted} ` +
              'from any other sender’s',
            where,
          ),
        timedOut: () =>
          new SenderGivenUp(
            unresolved(
              `did not resolve within ${String(boundMs)} ms — the probe’s resolver is not answering`,
            ).message,
            where,
          ),
      },
      lookup.counted ?? nameLookups,
    );
  } catch (error: unknown) {
    if (error instanceof SenderGivenUp) throw error;
    const why = error instanceof Error ? error.message : String(error);
    // The resolver did not answer, or the probe failed to ask it (`P-426`): neither is an answer
    // that the name has no address, which is what the last sentence would say.
    if (notAnswered(error)) {
      throw unresolved(`did not resolve — the probe’s resolver is not answering (${why})`);
    }
    if (probeFailed(error)) throw unresolved(`could not be resolved (${why})`);
    // An answer with more addresses than the probe uses (`P-426`'s review): the resolver's words
    // name the count, and "no address" would say the opposite.
    if (tooManyAddresses(error)) throw unresolved(`could not be used (${why})`);
    const code = (error as { code?: unknown } | null | undefined)?.code;
    throw unresolved(
      'did not resolve to any address' +
        (typeof code === 'string' && code !== '' ? ` (${code})` : ''),
    );
  }
  const mine = new Set(answers.map(({ address }) => canonicalAddress(address)));
  if (mine.size === 0) throw unresolved('did not resolve to any address');
  return (source) => mine.has(canonicalAddress(source));
}
