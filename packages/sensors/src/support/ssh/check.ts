import type { CheckContext } from '../../contract.js';
import { checkedTarget, familyOf, guardOf } from '../checked-target.js';
import { readCredentials } from './credentials.js';
import { withSsh } from './pool.js';
import { describeVerdict } from './host-key.js';
import type { SshSession } from './session.js';

/**
 * The preamble every SSH sensor type shares (`T-07`).
 *
 * The same thing `support/snmp/check.ts` is and for the same reason: four things that are
 * identical for every type — the device has a host, the credential set exists and parses, the
 * transport parameters come out of `params`, the connection is borrowed and released — written
 * once because the failure of writing them five times is *drift*, where the fifth type says
 * "authentication failed" and the first names the missing credential kind.
 */
export interface SshCheckOptions {
  /** Overrides the port from `params`, for a type that talks to a shell somewhere else. */
  readonly port?: number;
}

export async function sshCheck<T>(
  context: CheckContext,
  body: (session: SshSession, signal: AbortSignal) => Promise<T>,
  options: SshCheckOptions = {},
): Promise<T> {
  const host = context.target.host;
  if (host === '') throw new Error('the device has no host to connect to');

  const stored = context.credentials['ssh'];
  if (stored === undefined) {
    // Names the thing to go and do. "Authentication failed" thirty seconds later reads like a
    // broken account, and an operator goes and looks at the account.
    throw new Error(
      'no SSH credentials are set on this device or any group above it — add an SSH credential ' +
        'set to the device and every SSH sensor under it will use it',
    );
  }

  const port = options.port ?? Number(context.params['port'] ?? 22);
  const connectTimeoutMs = Number(context.params['connectTimeoutMs'] ?? 15_000);
  return withSsh(
    {
      host,
      port,
      // The family every connection to it is made over (`A-85`), and part of the pool's key.
      ipVersion: context.target.ipVersion,
      ...(context.target.pinned === undefined ? {} : { pinned: context.target.pinned }),
      // What the guard below excepts (`A-64`), so that a connection is keyed by it.
      ...(context.target.policyException === undefined
        ? {}
        : { exception: context.target.policyException }),
      // **Only when a connection has to be opened** (`A-57`): the name is resolved once and
      // checked against the probe's target policy, and the connection is made to an address
      // that lookup answered with. A connection the pool already holds is used with no lookup,
      // as it always was: the address it is connected to was checked when it was opened, and
      // an SSH sensor must not start failing because the probe's resolver has. A target a
      // credential set pinned (`A-41c`) is checked at that address and resolves nothing.
      //
      // The lookup runs under the signal the pool hands it (`A-69`), which is the open's and
      // not this check's: the open may be waited for by another check, and this one being
      // cancelled ends its own wait and nothing of theirs.
      guard: async (opening) => {
        const checked = await checkedTarget({
          ...guardOf(context.target),
          // Of the device's family only (`A-85`): the other is never connected to.
          family: familyOf(context.target.ipVersion),
          timeoutMs: connectTimeoutMs,
          signal: opening ?? context.signal,
          verb: 'connect to',
          doing: `connecting to ${host}:${String(port)} over SSH`,
        });
        return checked?.byGuard === true ? checked.addresses : undefined;
      },
    },
    readCredentials(stored),
    {
      connectTimeoutMs,
      commandTimeoutMs: Number(context.params['commandTimeoutMs'] ?? 30_000),
    },
    (session) => body(session, context.signal),
    undefined,
    // Cancelled while the connection is being opened, the check ends then and not at the
    // connect timeout (`A-69`).
    context.signal,
  );
}

/**
 * What the sensor message should say about the host key, or null when there is nothing to say.
 *
 * Only `accept-any` produces a line, and it produces one on *every* scan deliberately: a
 * connection that authenticates the server not at all is a standing decision, and one that is
 * visible in the sensor message is one somebody can notice and revisit. A note that appeared
 * once at configuration time would be a note nobody ever sees again.
 */
export function hostKeyNote(session: SshSession, host: string): string | null {
  const verdict = session.hostKey;
  if (verdict.kind !== 'unchecked') return describeVerdict(host, verdict);
  return `host key not checked (${verdict.presented || 'accept-any'})`;
}
