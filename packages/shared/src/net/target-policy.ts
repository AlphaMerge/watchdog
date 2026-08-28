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
 * server with a webhook feature is exactly the thing that can be persuaded to ask.
 */
export type TargetPolicy =
  /** Link-local only. Cloud metadata is unreachable; the rest of the network is not. */
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
 * Whether an address is link-local.
 *
 * `169.254.0.0/16` and `fe80::/10`. The IPv6 form matters as much as the IPv4 one: a cloud
 * metadata service is reachable at `fd00:ec2::254` on some providers, and an allowlist that only
 * knew the famous IPv4 address would be a guard in name.
 */
export function isLinkLocal(address: string): boolean {
  const parts = octets(address);
  if (parts !== null) return parts[0] === 169 && parts[1] === 254;
  if (!isIPv6(address)) return false;
  const lower = address.toLowerCase();
  // fe80::/10 is fe80 through febf.
  return /^fe[89ab][0-9a-f]:/.test(lower);
}

/** Loopback, RFC1918, carrier-grade NAT, unique-local, and the IPv6 equivalents. */
export function isPrivate(address: string): boolean {
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
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  // An IPv4-mapped address is the IPv4 address wearing a hat, and must be judged as one.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  return mapped?.[1] !== undefined ? isPrivate(mapped[1]) : false;
}

/**
 * Whether this policy refuses an address, and why.
 *
 * Multicast and broadcast are refused under every policy including `none`: they are not a webhook
 * endpoint under any reading, and a POST to one is a mistake rather than a configuration.
 */
export function refuses(policy: TargetPolicy, address: string): string | null {
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
