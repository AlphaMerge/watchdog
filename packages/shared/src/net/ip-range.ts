import { AppError } from '../errors/app-error.js';

/**
 * The addresses a discovery run sweeps (`D-01`).
 *
 * **Pure, shared, and in `@ms/shared` because both ends need the same answer.** The core
 * validates what an operator typed and tells them how long it will take; the probe enumerates it
 * and reports progress against it. Two implementations would disagree about the size of a range
 * on the day somebody wrote `10.0.0.1-10.0.1.5`, and the disagreement would show up as a
 * progress bar that never reaches the end.
 *
 * **IPv4 only, and that is a decision rather than an omission.** A sweep enumerates addresses
 * and pings each one; the smallest IPv6 subnet anybody assigns is a /64, which is 18 million
 * million million addresses. Sweeping IPv6 is not slow, it is impossible, and the discovery that
 * works there is neighbour-cache and DNS-based — `D-02`'s territory, and not a range at all. An
 * IPv6 literal here is refused with that sentence rather than accepted and silently truncated.
 */

export class IpRangeError extends AppError {
  constructor(message: string) {
    super('IP_RANGE_INVALID', message, { context: {} });
    this.name = 'IpRangeError';
  }
}

/**
 * The largest range one run may name.
 *
 * PRTG accepts 65,536 and warns that it may take days; this accepts the same number for the same
 * reason — an operator sweeping a /16 knows what they are asking for — and refuses more, because
 * a typo turning a /24 into a /8 is sixteen million pings nobody meant to start.
 */
export const MAX_ADDRESSES = 65_536;

/** One contiguous run of addresses, held as numbers so the enumeration is arithmetic. */
export interface IpSpan {
  readonly first: number;
  readonly last: number;
}

export interface IpRange {
  readonly spans: readonly IpSpan[];
  /** How many addresses in total, after overlaps are merged. */
  readonly size: number;
  /** What the operator typed, normalised — echoed back so a saved run says what it swept. */
  readonly text: string;
}

/**
 * Reads the range spellings an operator actually types.
 *
 * Four forms, comma-separated in any mix:
 *
 *   `10.0.0.0/24`          CIDR
 *   `10.0.0.1-10.0.0.50`   a pair of addresses
 *   `10.0.0.1-50`          shorthand for the last octet, which is what everybody writes
 *   `10.0.0.7`             one address
 *
 * **A CIDR's network and broadcast addresses are excluded**, and this is the one piece of
 * cleverness here. `10.0.0.0/24` means the 254 hosts, not 256 — pinging `.0` and `.255` produces
 * a reply from every host on some networks and from none on others, so including them makes a
 * sweep's results depend on the subnet's behaviour rather than on what is there. A /31 and a /32
 * are the exceptions: both are entirely host addresses (RFC 3021 for the /31, which is what
 * point-to-point links use), so nothing is excluded.
 */
export function parseIpRange(text: string): IpRange {
  const trimmed = text.trim();
  if (trimmed === '') throw new IpRangeError('no addresses were given');
  if (trimmed.includes(':')) {
    throw new IpRangeError(
      'this is an IPv6 address, and a sweep cannot enumerate IPv6: the smallest subnet anybody ' +
        'assigns is a /64, which is eighteen million million million addresses. Discovering ' +
        'IPv6 hosts means asking the routers and the DNS, not pinging a range',
    );
  }

  const spans: IpSpan[] = [];
  for (const part of trimmed.split(',')) {
    const piece = part.trim();
    if (piece === '') continue;
    spans.push(parsePiece(piece));
  }
  if (spans.length === 0) throw new IpRangeError('no addresses were given');

  const merged = merge(spans);
  const size = merged.reduce((total, span) => total + (span.last - span.first + 1), 0);
  if (size > MAX_ADDRESSES) {
    throw new IpRangeError(
      `that is ${size.toLocaleString('en')} addresses and one run may sweep ` +
        `${MAX_ADDRESSES.toLocaleString('en')} — a /16. Split it, or check the mask: the ` +
        'usual cause is a /8 where a /24 was meant',
    );
  }
  return { spans: merged, size, text: trimmed };
}

function parsePiece(piece: string): IpSpan {
  const slash = piece.indexOf('/');
  if (slash >= 0) return fromCidr(piece.slice(0, slash), piece.slice(slash + 1), piece);

  const dash = piece.indexOf('-');
  if (dash < 0) {
    const one = toNumber(piece);
    return { first: one, last: one };
  }

  const left = piece.slice(0, dash).trim();
  const right = piece.slice(dash + 1).trim();
  const first = toNumber(left);
  // `10.0.0.1-50` is what everybody writes and no tool should make them write it out.
  const last = right.includes('.') ? toNumber(right) : lastOctet(left, right, piece);
  if (last < first) {
    throw new IpRangeError(
      `"${piece}" ends before it starts — ${toText(last)} is below ${toText(first)}`,
    );
  }
  return { first, last };
}

function lastOctet(left: string, right: string, piece: string): number {
  if (!/^\d{1,3}$/.test(right) || Number(right) > 255) {
    throw new IpRangeError(`"${piece}" ends with "${right}", which is not an address or an octet`);
  }
  const base = toNumber(left);
  return (base & 0xffffff00) + Number(right);
}

function fromCidr(address: string, bits: string, piece: string): IpSpan {
  if (!/^\d{1,2}$/.test(bits)) {
    throw new IpRangeError(`"${piece}" has "${bits}" where a prefix length should be`);
  }
  const prefix = Number(bits);
  if (prefix > 32) throw new IpRangeError(`"${piece}" has a prefix longer than 32 bits`);

  const value = toNumber(address);
  // **The unsigned coercion happens where a value leaves, not where it is computed.** JavaScript's
  // bitwise operators work on signed 32-bit integers, so `0xffffffff << 16` is negative and
  // `10.0.0.0 & mask` is negative too — which is harmless while it stays inside this expression
  // and catastrophic the moment it becomes an address, because a negative sorts below every
  // real one. `>>> 0` on `network` and `broadcast` is what makes that impossible; putting a
  // third one on `mask` looks careful and does nothing, which a mutation run confirmed by
  // deleting it without a single test noticing.
  //
  // `prefix === 0` is separate and is not redundant: `0xffffffff << 32` shifts by zero in
  // JavaScript, giving -1 where a /0 needs a mask of 0.
  const mask = prefix === 0 ? 0 : 0xffffffff << (32 - prefix);
  const network = (value & mask) >>> 0;
  const broadcast = (network | ~mask) >>> 0;

  // A /31 is two host addresses (RFC 3021, point-to-point links) and a /32 is one. Everything
  // wider excludes its network and broadcast addresses: pinging them draws a reply from every
  // host on some networks and none on others, which would make a sweep's results depend on the
  // subnet's behaviour rather than on what is actually there.
  if (prefix >= 31) return { first: network, last: broadcast };
  return { first: network + 1, last: broadcast - 1 };
}

/** Overlapping and adjacent spans become one, so a size is a count of distinct addresses. */
function merge(spans: readonly IpSpan[]): IpSpan[] {
  const sorted = [...spans].sort((a, b) => a.first - b.first || a.last - b.last);
  const out: IpSpan[] = [];
  for (const span of sorted) {
    const previous = out[out.length - 1];
    // `+ 1` merges adjacency as well as overlap: `10.0.0.1-10` and `10.0.0.11-20` are one run of
    // twenty addresses, and counting them as two spans would only make the arithmetic below
    // harder for no gain.
    if (previous !== undefined && span.first <= previous.last + 1) {
      if (span.last > previous.last)
        out[out.length - 1] = { first: previous.first, last: span.last };
      continue;
    }
    out.push(span);
  }
  return out;
}

export function toNumber(address: string): number {
  const parts = address.trim().split('.');
  if (parts.length !== 4) {
    throw new IpRangeError(`"${address}" is not an IPv4 address`);
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) throw new IpRangeError(`"${address}" is not an IPv4 address`);
    const octet = Number(part);
    if (octet > 255) throw new IpRangeError(`"${address}" has an octet above 255`);
    value = value * 256 + octet;
  }
  return value >>> 0;
}

export function toText(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

/**
 * The address at a position in the range, or null past the end.
 *
 * **Indexed rather than iterated, and that is what makes a sweep resumable.** A run's progress is
 * one integer — how many addresses have been offered — which survives a probe restart, a
 * reconnect and a core failover, where an iterator survives none of them. `D-01` requires
 * resumability; this is the whole mechanism.
 */
export function addressAt(range: IpRange, index: number): number | null {
  if (index < 0) return null;
  let remaining = index;
  for (const span of range.spans) {
    const count = span.last - span.first + 1;
    if (remaining < count) return (span.first + remaining) >>> 0;
    remaining -= count;
  }
  return null;
}

/** Whether an address falls inside the range. */
export function contains(range: IpRange, value: number): boolean {
  return range.spans.some((span) => value >= span.first && value <= span.last);
}

/**
 * The same spellings, read as a *permission* rather than as a list of addresses to visit
 * (`R-01`).
 *
 * **Two differences from `parseIpRange`, and both follow from that.** There is no size cap: an
 * operator whose probes live anywhere in `10.0.0.0/8` is stating a fact about their network, not
 * asking anything to enumerate sixteen million addresses, and refusing it would push them to
 * write no allowlist at all. And a CIDR keeps its network and broadcast addresses, because
 * excluding them is a statement about which addresses will *answer a ping* — true for a sweep,
 * meaningless for "may this identity connect from here".
 *
 * Everything else is deliberately the same code, so an operator who has learnt to write a range
 * for a discovery already knows how to write one here.
 */
export function parseAddressFilter(text: string): IpRange {
  const trimmed = text.trim();
  if (trimmed === '') throw new IpRangeError('no addresses were given');
  if (trimmed.includes(':')) {
    throw new IpRangeError('an address filter is IPv4 only, and this looks like IPv6');
  }

  const spans: IpSpan[] = [];
  for (const part of trimmed.split(',')) {
    const piece = part.trim();
    if (piece === '') continue;
    spans.push(parseFilterPiece(piece));
  }
  if (spans.length === 0) throw new IpRangeError('no addresses were given');

  const merged = merge(spans);
  return {
    spans: merged,
    size: merged.reduce((total, span) => total + (span.last - span.first + 1), 0),
    text: trimmed,
  };
}

function parseFilterPiece(piece: string): IpSpan {
  const slash = piece.indexOf('/');
  if (slash < 0) return parsePiece(piece);

  const bits = piece.slice(slash + 1);
  if (!/^\d{1,2}$/.test(bits)) {
    throw new IpRangeError(`"${piece}" has "${bits}" where a prefix length should be`);
  }
  const prefix = Number(bits);
  if (prefix > 32) throw new IpRangeError(`"${piece}" has a prefix longer than 32 bits`);

  const value = toNumber(piece.slice(0, slash));
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { first: (value & mask) >>> 0, last: ((value & mask) | (~mask >>> 0)) >>> 0 };
}

/**
 * Whether an address is allowed by a filter, an empty filter allowing everything.
 *
 * **Empty means any, and it is the default.** An allowlist nobody has written is not a mistake:
 * most installations have their probes on networks they cannot enumerate in advance, and a
 * default of "nothing may connect" would mean the first probe is refused for being the first.
 * The security this buys is real but it is opt-in — a stolen key is worth much less when it
 * only works from one subnet, and that is a statement only the operator can make.
 */
export function addressAllowed(address: string, filters: readonly string[]): boolean {
  if (filters.length === 0) return true;
  let value: number;
  try {
    value = toNumber(address);
  } catch {
    // Not an IPv4 address at all — an IPv6 peer, or a unix socket. A filter is a list of IPv4
    // ranges, so it cannot say yes to something it cannot express, and refusing is the only
    // answer that keeps the filter meaning what it says.
    return false;
  }
  return filters.some((filter) => {
    try {
      return contains(parseAddressFilter(filter), value);
    } catch {
      // A filter that will not parse allows nothing rather than everything. It reached the
      // column through validation, so this is unreachable in practice — and a corrupted row
      // opening the door is the wrong way for it to be unreachable.
      return false;
    }
  });
}
