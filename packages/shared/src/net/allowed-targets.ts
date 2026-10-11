import { BlockList, isIP } from 'node:net';

/**
 * Where a credential set may be sent (`A-41b`): a set's `allowedTargets`, and whether a device's
 * host is inside them.
 *
 * **In `@ms/shared` because the vault checks the entries when a set is written and the probe
 * configuration asks the question every time it is built**, and a second copy of the matching
 * rules is a second answer.
 *
 * An entry is one of four things:
 * - a host name, `db1.example.com`, matched whole, ignoring case and a trailing dot;
 * - `*.example.com`, matching every name *below* `example.com`, and not `example.com` itself;
 * - an address, IPv4 or IPv6;
 * - a CIDR range, `10.20.0.0/16` or `fd00:1::/64`.
 *
 * **A host is compared with the entries of its own sort, and the core decides only those.** A
 * name host is inside a name or a pattern that covers it. An address host is inside an address
 * or a range that covers it. An address never matches a name: that would take a reverse lookup,
 * and a PTR record is written by whoever holds the address. A name host facing only addresses
 * and ranges is `undecided`: the core does not resolve names. **The probe decides it** (`A-41c`),
 * by resolving the name once, asking this same function about every address it has, and
 * connecting to one of them, never to the name. Where that cannot be done, because the probe is
 * older than the check or the transport resolves the name itself, undecided is refused, like
 * outside.
 */

/** One parsed entry. */
export type AllowedTarget =
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'suffix'; readonly suffix: string }
  | { readonly kind: 'address'; readonly address: string; readonly family: 'ipv4' | 'ipv6' }
  | {
      readonly kind: 'range';
      readonly network: string;
      readonly prefix: number;
      readonly family: 'ipv4' | 'ipv6';
    };

/** Whether a host is inside a set's targets, as far as the core can tell. */
export type TargetVerdict = 'inside' | 'outside' | 'undecided';

/** At most this many entries in one set: a longer list is a range nobody wrote down. */
export const MAX_ALLOWED_TARGETS = 64;

const LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;

/** Lower-case, without one trailing dot, without an IPv6 zone. The form a host is compared in. */
function normalised(text: string): string {
  const lower = text.trim().toLowerCase();
  const undotted = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  const zone = undotted.indexOf('%');
  return zone >= 0 && isIP(undotted.slice(0, zone)) === 6 ? undotted.slice(0, zone) : undotted;
}

/**
 * An IPv4 address written as IPv6 (`::ffff:10.0.0.1`) is the IPv4 address it is, so the two
 * spellings are one entry when a write is compared with the last (`widenedFields`). `BlockList`
 * matches the two against each other either way, so no verdict depends on it.
 *
 * **Only for addresses.** A mapped range, `::ffff:10.0.0.0/104`, is an IPv6 range whose prefix
 * counts all 128 bits, and it stays one: unmapping its network would leave a prefix no IPv4 range
 * can have. `BlockList` matches IPv4 hosts against it as it is.
 */
function unmapped(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  return mapped?.[1] ?? address;
}

function familyOf(address: string): 'ipv4' | 'ipv6' | null {
  const version = isIP(address);
  return version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : null;
}

function isHostName(name: string): boolean {
  return name.length > 0 && name.length <= 253 && name.split('.').every((l) => LABEL.test(l));
}

/**
 * One entry, parsed, or the sentence saying what is wrong with it. The sentence is for an
 * operator reading a refused write, so it says what the entry may be.
 */
export function parseAllowedTarget(text: string): AllowedTarget | string {
  const entry = normalised(text);
  if (entry === '') return 'an allowed target cannot be empty';
  if (entry === '*') {
    return (
      '"*" would allow everything, which is what no targets at all already means; name the ' +
      'hosts, a *.domain, the addresses or the ranges this set is for'
    );
  }

  const slash = entry.indexOf('/');
  if (slash >= 0) {
    const network = entry.slice(0, slash);
    const bits = entry.slice(slash + 1);
    const family = familyOf(network);
    const prefix = /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
    const most = family === 'ipv4' ? 32 : 128;
    if (family === null || !Number.isInteger(prefix) || prefix > most) {
      return `"${text}" is not a CIDR range: an address, a slash and a prefix length, as in 10.20.0.0/16`;
    }
    return { kind: 'range', network, prefix, family };
  }

  const address = unmapped(entry);
  const family = familyOf(address);
  if (family !== null) return { kind: 'address', address, family };

  if (entry.startsWith('*.')) {
    const suffix = entry.slice(2);
    if (!isHostName(suffix) || !suffix.includes('.')) {
      return `"${text}" is not a pattern this understands: *. followed by a domain, as in *.example.com`;
    }
    return { kind: 'suffix', suffix };
  }
  if (entry.includes('*')) {
    return `"${text}" puts * somewhere other than the start; only *.domain is a pattern`;
  }
  if (!isHostName(entry)) {
    return `"${text}" is not a host name, a *.domain, an address or a CIDR range`;
  }
  return { kind: 'name', name: entry };
}

/**
 * The problems with a list of entries, each with its index, for a refused write. Empty when the
 * list is sound. Duplicates are not a problem: they allow nothing more.
 */
export function allowedTargetProblems(
  entries: readonly string[],
): { index: number; message: string }[] {
  const problems: { index: number; message: string }[] = [];
  for (const [index, entry] of entries.entries()) {
    const parsed = parseAllowedTarget(entry);
    if (typeof parsed === 'string') problems.push({ index, message: parsed });
  }
  return problems;
}

/**
 * Whether a device's host is inside these targets (`A-41b`).
 *
 * Entries that do not parse are skipped. A write refuses them, so only a row written some other
 * way holds one, and an entry that means nothing allows nothing. **Empty targets are not asked
 * about**: a set with none is unrestricted, which the caller decides before it asks.
 */
export function targetVerdict(host: string, entries: readonly string[]): TargetVerdict {
  // **A host that begins with `/` is a PostgreSQL socket directory on the probe's own machine**
  // (`A-74`), and is judged as that machine is: inside where the targets cover a loopback
  // address or `localhost`, and outside otherwise. As an address-free name it was undecided
  // against address targets, so the core sent the set to the probe to resolve and pin, and a
  // path resolves to nothing: the sensor read Unknown, as a name that does not resolve. The
  // probe holds the same path to its target policy's word on loopback (`A-70`).
  //
  // **Not a path that begins `//` or holds a `\`** (`A-74`'s review). Windows reads `//host/…`
  // and `/\host\…` as a pipe on another machine, so the premise holds only on POSIX, and this
  // is asked with no platform. Such a host is a name like any other here: undecided against
  // address targets, left to a pin that cannot resolve it, and so withheld. A probe on Windows
  // refuses every socket path besides (`runDbCheck`).
  if (host.startsWith('/') && !host.startsWith('//') && !host.includes('\\')) {
    const local =
      targetVerdict('127.0.0.1', entries) === 'inside' ||
      targetVerdict('::1', entries) === 'inside' ||
      targetVerdict('localhost', entries) === 'inside';
    return local ? 'inside' : 'outside';
  }
  const parsed = entries
    .map(parseAllowedTarget)
    .filter((entry): entry is AllowedTarget => typeof entry !== 'string');
  const wanted = unmapped(normalised(host));
  const family = familyOf(wanted);

  if (family !== null) {
    const list = new BlockList();
    for (const entry of parsed) {
      if (entry.kind === 'address') list.addAddress(entry.address, entry.family);
      if (entry.kind === 'range') list.addSubnet(entry.network, entry.prefix, entry.family);
    }
    return list.check(wanted, family) ? 'inside' : 'outside';
  }

  for (const entry of parsed) {
    if (entry.kind === 'name' && entry.name === wanted) return 'inside';
    if (entry.kind === 'suffix' && wanted.endsWith(`.${entry.suffix}`)) return 'inside';
  }
  // A name that no name entry covers is outside unless an address could still let it in, and
  // only resolving it would say — which the core does not do.
  return parsed.some((entry) => entry.kind === 'address' || entry.kind === 'range')
    ? 'undecided'
    : 'outside';
}
