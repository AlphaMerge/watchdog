import { isIP } from 'node:net';

/**
 * What a client's address counts as, for the login throttle and the rate limit (`A-47`).
 *
 * **An IPv6 client is its /64.** One ordinary connection is handed a whole /64, and a client that
 * picks a fresh address from it for every attempt was a fresh client to anything keyed on the
 * address: twenty failures allowed per address became twenty per address times 2^64. The /64 is
 * what a subscriber, a server or a VM is given, so it is the smallest unit one attacker holds.
 *
 * **An IPv4 address is itself**, and so is one written as IPv4-mapped IPv6 (`::ffff:192.0.2.7`),
 * which is how a dual-stack socket reports an IPv4 peer: the same client must not count twice,
 * once under each spelling, and must never be widened to the /64 of `::ffff:0:0`. Anything that is
 * not an address is returned as it is.
 *
 * **No address at all is `''`.** Fastify types `request.ip` as a string, and it is `undefined` for
 * a socket that has already closed, and under `injectWS`; a key that threw there answered 500.
 */
export function addressKey(address: string | undefined): string {
  if (address === undefined) return '';
  const bare = address.split('%')[0] ?? address;
  if (isIP(bare) === 4) return bare;
  if (isIP(bare) !== 6) return address;
  const groups = expand(bare);
  if (groups === null) return address;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [high = 0, low = 0] = groups.slice(6);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

/** An IPv6 address as its eight 16-bit groups, or null when it does not parse. */
function expand(address: string): number[] | null {
  let text = address.toLowerCase();
  // A dotted quad at the end is the last two groups.
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  const tail: number[] = [];
  if (dotted !== null) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    tail.push((a << 8) | b, (c << 8) | d);
    text = text.slice(0, dotted.index);
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string | undefined): number[] =>
    part === undefined || part === '' ? [] : part.split(':').map((group) => parseInt(group, 16));
  const head = parse(halves[0]);
  const rest = [...parse(halves[1]), ...tail];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...new Array<number>(Math.max(0, missing)).fill(0), ...rest];
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : null;
}
