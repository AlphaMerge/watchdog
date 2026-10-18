import { lookup } from 'node:dns/promises';

/**
 * `getaddrinfo`, exactly as a socket handed the name would call it (`P-426`, `P-432`): every
 * address for the family asked, hints 0, in the order `dns.getDefaultResultOrder()` gives.
 *
 * **One function for both of the processes that ask it.** `systemResolve` is this call in the
 * probe, and the probe's lookup helper (`P-432`), a child process that asks `getaddrinfo` for the
 * names the probe will not ask on its own lanes, makes this call and nothing else. Both answers
 * must be the system's, so they come from one line.
 *
 * **Its own subpath (`@ms/sensors/system-lookup`)** so the helper imports nothing else of this
 * package: the root pulls in the catalogue, whose import `P-258` measured at 0.45–14.8 s under load.
 * It imports only `node:*` for the same reason.
 */

/** One address `getaddrinfo` answered with. */
export interface SystemAddress {
  readonly address: string;
  readonly family: number;
}

/** 4, 6, or 0 for both, as `getaddrinfo` is asked. */
export type SystemFamily = 0 | 4 | 6;

/** Every address `getaddrinfo` gives the name for the family. Rejects with its code when it fails. */
export function systemLookup(
  host: string,
  family: SystemFamily,
): Promise<readonly SystemAddress[]> {
  return lookup(host, { all: true, family });
}
