import { Resolver } from 'node:dns/promises';
import type { IdentifyDeps } from './identify.js';

/**
 * Where identification's facts actually come from (`D-02`).
 *
 * Separate from `identify.ts` so the collection order and the error policy can be tested with no
 * network at all, and separate from the sensor package because these ask questions no sensor
 * asks: a sensor is pointed at a device somebody configured, and this is pointed at an address
 * nobody has said anything about yet.
 */

/** The system group. Three OIDs, one request, and the most informative answer available. */
const SYS_DESCR = '1.3.6.1.2.1.1.1.0';
const SYS_OBJECT_ID = '1.3.6.1.2.1.1.2.0';
const SYS_NAME = '1.3.6.1.2.1.1.5.0';

/**
 * A PTR record, or nothing.
 *
 * `tries: 1`, for the reason `T-23` found the hard way: Node's resolver retries four times by
 * default and `timeout` is per *try*, so a one-second budget takes four seconds — which across a
 * /24 is thirteen minutes of waiting for records that mostly do not exist.
 */
export function reverseLookup(address: string, timeoutMs: number): Promise<string | null> {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  return resolver
    .reverse(address)
    .then((names) => names[0] ?? null)
    .catch(() => null);
}

/**
 * The SNMP system group, over v2c with the community the run was given.
 *
 * **v2c and not v3**, because identification runs before an operator has told the system anything
 * about a host: v3 needs a username, an authentication protocol and a passphrase *per device*,
 * which is precisely the information discovery exists to make it possible to configure. A v3-only
 * agent reports nothing here and is identified from its ports and its name, which is the honest
 * outcome rather than a wrong one.
 *
 * A single `get` of three OIDs rather than three gets: one UDP round trip per host instead of
 * three, which on a /24 is the difference between a minute and three.
 */
export async function snmpSystem(
  address: string,
  community: string,
  timeoutMs: number,
): Promise<{ sysDescr?: string; sysObjectId?: string; sysName?: string } | null> {
  // Imported here rather than at the top: a probe that runs no discovery never loads the SNMP
  // stack, which is the same rule every sensor type follows.
  const { SnmpSession, isException, stringOf } = await import('@ms/sensors/snmp');

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const session = SnmpSession.open(
    { host: address, ipVersion: 'v4' },
    { version: 'v2c', community },
    { timeoutMs, retries: 0 },
  );
  try {
    const varbinds = await session.get([SYS_DESCR, SYS_OBJECT_ID, SYS_NAME], controller.signal);
    const found: { sysDescr?: string; sysObjectId?: string; sysName?: string } = {};
    for (const varbind of varbinds) {
      // A `noSuchObject` is a real answer from a real agent — a minimal one that implements
      // less than the system group — and reading it as a value would put the string
      // "noSuchObject" into a fingerprint and then into a template match.
      if (isException(varbind)) continue;
      const value = (stringOf(varbind) ?? '').trim();
      if (value === '') continue;
      if (varbind.oid === SYS_DESCR) found.sysDescr = value.slice(0, 1_000);
      if (varbind.oid === SYS_OBJECT_ID) found.sysObjectId = value;
      if (varbind.oid === SYS_NAME) found.sysName = value.slice(0, 255);
    }
    return Object.keys(found).length === 0 ? null : found;
  } catch {
    // No agent, the wrong community, or a firewall. All three mean "this told me nothing", and
    // none of them is a reason to fail the host.
    return null;
  } finally {
    clearTimeout(timer);
    session.close();
  }
}

/** The real sources, as `identify` takes them. */
export const LIVE_SOURCES: IdentifyDeps = { reverseLookup, snmpSystem };
