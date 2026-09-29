import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

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

/**
 * How long a resolved device address is reused.
 *
 * A check per scan interval per listener sensor is not much DNS, but it is DNS on a path that
 * otherwise does no I/O at all, and the answer changes about as often as a device is renumbered.
 */
export const RESOLVE_TTL_MS = 300_000;

/** Every address a name stands for. Rejects, or answers none, when it stands for nothing. */
export type Lookup = (name: string) => Promise<readonly string[]>;

const systemLookup: Lookup = async (name) =>
  (await lookup(name, { all: true })).map((entry) => entry.address);

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

interface Resolved {
  readonly addresses: ReadonlySet<string>;
  readonly at: number;
}

/** Turns a device's host into the addresses it stands for, and remembers each answer a while. */
export class DeviceAddresses {
  readonly #lookup: Lookup;
  readonly #ttlMs: number;
  readonly #resolved = new Map<string, Resolved>();

  constructor(options: { readonly lookup?: Lookup; readonly ttlMs?: number } = {}) {
    this.#lookup = options.lookup ?? systemLookup;
    this.#ttlMs = options.ttlMs ?? RESOLVE_TTL_MS;
  }

  /**
   * Every address a device's host stands for, including the host itself when it is already one.
   *
   * Empty when the name does not resolve, and that is not remembered: the next scan asks again,
   * and each one fails naming the host until the name resolves.
   */
  async of(host: string): Promise<ReadonlySet<string>> {
    const trimmed = host.trim();
    if (trimmed === '') return new Set();
    if (isIP(trimmed) !== 0) return new Set([canonicalAddress(trimmed)]);

    // A name is case-insensitive, so `Core-SW1` and `core-sw1` share one answer.
    const key = trimmed.toLowerCase();
    const cached = this.#resolved.get(key);
    if (cached !== undefined && Date.now() - cached.at < this.#ttlMs) return cached.addresses;

    let addresses: Set<string>;
    try {
      addresses = new Set((await this.#lookup(trimmed)).map(canonicalAddress));
    } catch {
      return new Set();
    }
    if (addresses.size > 0) this.#resolved.set(key, { addresses, at: Date.now() });
    return addresses;
  }
}

/** Worker-local, so a busy probe resolves each device once per five minutes per worker. */
const perWorker = new DeviceAddresses();

/**
 * A test for "this sender is the device", or a failed check naming a host that stands for nothing.
 *
 * Never a test that matches nothing: a device whose name will not resolve would then be
 * indistinguishable from a quiet one, which is the one failure a listener sensor must not have.
 * `counted` names what the sensor counts, for the message.
 */
export async function fromDevice(
  host: string,
  counted: string,
  addresses: DeviceAddresses = perWorker,
): Promise<(source: string) => boolean> {
  const mine = await addresses.of(host);
  if (mine.size === 0) {
    throw new Error(
      `this sensor counts only ${counted} from ${host}, and that name did not resolve to any ` +
        'address — so nothing could be attributed to this device. Give the device a literal ' +
        'address, or turn off “only this device”',
    );
  }
  return (source) => mine.has(canonicalAddress(source));
}
