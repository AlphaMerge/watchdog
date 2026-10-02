import type { CheckContext } from '../../contract.js';
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

  return withSsh(
    {
      host,
      port: options.port ?? Number(context.params['port'] ?? 22),
      ...(context.target.pinned === undefined ? {} : { pinned: context.target.pinned }),
    },
    readCredentials(stored),
    {
      connectTimeoutMs: Number(context.params['connectTimeoutMs'] ?? 15_000),
      commandTimeoutMs: Number(context.params['commandTimeoutMs'] ?? 30_000),
    },
    (session) => body(session, context.signal),
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
