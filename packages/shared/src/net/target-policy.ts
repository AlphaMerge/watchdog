import { isIPv4, isIPv6 } from 'node:net';

/**
 * What a user-supplied URL is allowed to reach (`N-08`, widened to sensors by `A-09`).
 *
 * **In `@ms/shared` because both services need it.** It began beside the webhook client in
 * `@ms/core`, which meant the *sensor* HTTP path — the other place this system fetches a URL
 * somebody typed — had no guard at all. A guard that covers one of two callers is a guard whose
 * absence is invisible, so it moved here, where `@ms/sensors` can reach it too.
 *
 * **The default is not "block everything private", and that is deliberate.** A monitoring system
 * lives *inside* the network it watches: an internal ticketing system, a self-hosted Mattermost,
 * a script on the same machine are all ordinary webhook targets, and a guard that refused them
 * would be turned off within the hour — which is a worse outcome than a narrower guard nobody
 * disables.
 *
 * So the default blocks the one range that is never a legitimate target and is a known
 * credential-theft vector: **link-local**, where every cloud provider parks its instance-metadata
 * service. `169.254.169.254` hands out IAM credentials to anything that asks, and a monitoring
 * server with a webhook feature is exactly the thing that can be persuaded to ask. With it, the
 * metadata addresses that are not link-local (`isMetadataAddress`), and every one of them however
 * it is spelt: inside an IPv4-mapped IPv6 address it is the same destination (`unmapped`).
 */
export type TargetPolicy =
  /** Link-local, and the metadata addresses outside it. Cloud metadata is unreachable; the rest
   *  of the network is not. */
  | 'link-local'
  /** Also loopback, RFC1918, carrier-grade NAT and unique-local. For an installation that only
   *  ever posts to the public internet. */
  | 'private'
  /** Nothing is blocked. For a closed network where the guard is noise. */
  | 'none';

export interface TargetRefusal {
  readonly address: string;
  readonly reason: string;
}

/** A parsed IPv4 address, or null. */
function octets(address: string): number[] | null {
  if (!isIPv4(address)) return null;
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part)) ? parts : null;
}

/**
 * The eight 16-bit groups of an IPv6 address, or null when it is not one. A zone (`%eth0`) is
 * not part of the address and is dropped; a dotted tail is read as the two groups it is.
 */
function groups(address: string): number[] | null {
  const zone = address.indexOf('%');
  const bare = zone === -1 ? address : address.slice(0, zone);
  if (!isIPv6(bare)) return null;
  const [head = '', tail] = bare.toLowerCase().split('::');
  const read = (part: string): number[] => {
    if (part === '') return [];
    const out: number[] = [];
    for (const piece of part.split(':')) {
      const dotted = octets(piece);
      if (dotted === null) out.push(Number.parseInt(piece, 16));
      else {
        const [a = 0, b = 0, c = 0, d = 0] = dotted;
        out.push(a * 256 + b, c * 256 + d);
      }
    }
    return out;
  };
  const front = read(head);
  if (tail === undefined) return front.length === 8 ? front : null;
  const back = read(tail);
  const gap = 8 - front.length - back.length;
  return gap < 0 ? null : [...front, ...new Array<number>(gap).fill(0), ...back];
}

/**
 * An address as it is judged: an IPv4-mapped IPv6 address (`::ffff:0:0/96`) becomes the IPv4
 * address it carries, in whichever spelling it arrived, and anything else is returned as it is.
 *
 * **The one unwrap, used by every test below** (`A-54`). `::ffff:169.254.169.254`, or the same
 * thing written `::ffff:a9fe:a9fe`, is the IPv4 metadata address wearing a hat: a socket handed
 * it connects to 169.254.169.254. `isPrivate` knew that for the dotted spelling only, and
 * `isLinkLocal` for neither, so the default policy let both through.
 */
export function unmapped(address: string): string {
  const parts = groups(address);
  if (parts === null) return address;
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = parts;
  if (g0 !== 0 || g1 !== 0 || g2 !== 0 || g3 !== 0 || g4 !== 0 || g5 !== 0xffff) return address;
  return `${String(g6 >> 8)}.${String(g6 & 0xff)}.${String(g7 >> 8)}.${String(g7 & 0xff)}`;
}

/**
 * Whether an address is link-local: `169.254.0.0/16` and `fe80::/10`, and either inside an
 * IPv4-mapped IPv6 address.
 */
export function isLinkLocal(address: string): boolean {
  const plain = unmapped(address);
  const parts = octets(plain);
  if (parts !== null) return parts[0] === 169 && parts[1] === 254;
  const wide = groups(plain);
  // fe80::/10 is fe80 through febf.
  return wide !== null && ((wide[0] ?? 0) & 0xffc0) === 0xfe80;
}

/**
 * Metadata addresses that are not link-local, as groups. One today: `fd00:ec2::254`, where AWS
 * answers instance metadata over IPv6. It is a unique-local address, so "link-local" alone never
 * covered it, though the comment here said for a long time that it mattered.
 */
const METADATA: readonly (readonly number[])[] = [[0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254]];

/**
 * Whether an address is a cloud instance-metadata service's: anything link-local, and the
 * addresses outside that range that are known to be one. Compared as numbers, so that
 * `fd00:0ec2:0:0:0:0:0:254` is the address `fd00:ec2::254` is.
 */
export function isMetadataAddress(address: string): boolean {
  if (isLinkLocal(address)) return true;
  const wide = groups(unmapped(address));
  return wide !== null && METADATA.some((known) => known.every((group, at) => group === wide[at]));
}

/** Loopback, RFC1918, carrier-grade NAT, unique-local, and the IPv6 equivalents. */
export function isPrivate(given: string): boolean {
  // An IPv4-mapped address is the IPv4 address wearing a hat, and is judged as one.
  const address = unmapped(given);
  const parts = octets(address);
  if (parts !== null) {
    const [a = 0, b = 0] = parts;
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    // 100.64.0.0/10, which an ISP or a container runtime hands out and which is not the public
    // internet whatever it looks like.
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 0) return true;
    return false;
  }
  if (!isIPv6(address)) return false;
  const lower = address.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // fc00::/7 — unique-local.
  return /^f[cd][0-9a-f]{2}:/.test(lower);
}

/**
 * Whether this policy refuses an address, and why.
 *
 * Multicast and broadcast are refused under every policy including `none`: they are not a webhook
 * endpoint under any reading, and a POST to one is a mistake rather than a configuration.
 */
export function refuses(policy: TargetPolicy, given: string): string | null {
  const address = unmapped(given);
  const parts = octets(address);
  if (parts !== null) {
    const [a = 0] = parts;
    if (a >= 224) return 'multicast or reserved';
  } else if (isIPv6(address) && address.toLowerCase().startsWith('ff')) {
    return 'multicast';
  }

  if (policy === 'none') return null;
  if (isLinkLocal(address)) {
    return 'link-local — this is where cloud instance metadata lives';
  }
  // Under `link-local` too: the policy is named for the range, and is there for what lives in
  // it. A metadata address outside the range is refused for the same reason.
  if (isMetadataAddress(address)) return 'a cloud instance-metadata address';
  if (policy === 'private' && isPrivate(address)) return 'a private address';
  return null;
}

/**
 * Checks every address a hostname resolved to.
 *
 * All of them, not the first: a name that resolves to one public address and one link-local one
 * is a name that will reach the link-local one as soon as the resolver reorders them, and a guard
 * that checked only what it happened to connect to would pass on Tuesday and fail on Wednesday.
 */
export function refusedAddresses(
  policy: TargetPolicy,
  addresses: readonly string[],
): TargetRefusal[] {
  const refusals: TargetRefusal[] = [];
  for (const address of addresses) {
    const reason = refuses(policy, address);
    if (reason !== null) refusals.push({ address, reason });
  }
  return refusals;
}

/**
 * Whether a redirect may carry the request's secret headers with it.
 *
 * Only to the same origin. A webhook whose bearer token follows a redirect to somebody else's
 * host has handed that host the token — which is the distinction `curl` draws between
 * `--location` and `--location-trusted`, and it defaults to the safe one for the same reason.
 */
export function sameOrigin(from: URL, to: URL): boolean {
  return from.protocol === to.protocol && from.host === to.host;
}

/** Only HTTP. A webhook that could name `file:` or `gopher:` is not a webhook. */
export function schemeAllowed(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}
