import type { CheckContext } from '../../contract.js';
import { readCredentials } from './credentials.js';
import { withSnmp } from './pool.js';
import type { SnmpSession } from './session.js';

/**
 * The preamble every SNMP sensor type shares (`T-03`).
 *
 * Four things, all of them the same for `snmp.traffic`, `snmp.custom` and everything `T-04`…
 * `T-06` will add: the device has a host, the credential set exists and parses, the transport
 * parameters come out of `params`, and the session is borrowed and released. Written once because
 * the failure of writing it five times is not duplication but *drift* — the fifth type says
 * "authentication failed" where the first says which credential kind is missing, and an operator
 * learns that some SNMP sensors explain themselves and some do not.
 *
 * Deliberately not a base class or a wrapper around `execute`: a sensor type is one file with one
 * exported object (`docs/adding-a-sensor-type.md`), and a type that inherited half its behaviour
 * from somewhere else would stop being readable on its own.
 */
export interface SnmpCheckOptions {
  /** Overrides the port from `params`, for a type that puts the agent somewhere else. */
  readonly port?: number;
}

export async function snmpCheck<T>(
  context: CheckContext,
  body: (session: SnmpSession, signal: AbortSignal) => Promise<T>,
  options: SnmpCheckOptions = {},
): Promise<T> {
  const host = context.target.host;
  if (host === '') throw new Error('the device has no host to query');

  const stored = context.credentials['snmp'];
  if (stored === undefined) {
    // Names the thing to go and do. "Authentication failed" twenty seconds later reads like a
    // broken device, and an operator goes and looks at the device.
    throw new Error(
      'no SNMP credentials are set on this device or any group above it — add an SNMP ' +
        'credential set to the device and every SNMP sensor under it will use it',
    );
  }

  return withSnmp(
    {
      host,
      port: options.port ?? Number(context.params['port'] ?? 161),
      ipVersion: context.target.ipVersion,
    },
    readCredentials(stored),
    {
      timeoutMs: Number(context.params['timeoutMs'] ?? 5_000),
      retries: Number(context.params['retries'] ?? 1),
    },
    (session) => body(session, context.signal),
  );
}
