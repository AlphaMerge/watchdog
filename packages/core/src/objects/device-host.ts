import { ObjectError } from './errors.js';
import type { ObjectId } from './types.js';

/**
 * A device's host may not begin with `-` (`S-20`).
 *
 * **No DNS name and no IPv4 or IPv6 address does**, so refusing one costs nothing legitimate. A
 * host is handed to programs as an argument — `ping` today — and one beginning with `-` is read as
 * an option. Through `ping` that is not exploitable: the option takes the only destination slot,
 * so the program sends nothing and fails with "Destination address required", which is the
 * confusing Down this replaces. But the next type that shells out may not be safe by the same
 * accident, and a check here, where every write of a host passes, covers it before it exists.
 *
 * In the service rather than only the route's schema, so a create that never saw a route — a
 * discovery run, a created tree — is held to it too. A device stored before this rule is refused
 * by the probe instead, naming the host, before any program sees it.
 */
export function assertDeviceHost(
  host: string,
  context: { readonly phase: 'create' | 'createTree' | 'update'; readonly objectId?: ObjectId },
): void {
  if (!host.startsWith('-')) return;
  throw new ObjectError(
    'OBJECT_INVALID',
    `host "${host}" begins with "-", which no address or name does — a program handed it ` +
      'would read it as an option',
    {
      context: {
        phase: context.phase,
        ...(context.objectId === undefined ? {} : { objectId: context.objectId }),
      },
      details: { field: 'host' },
    },
  );
}
