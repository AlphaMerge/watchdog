import type { Session } from '../../auth/session';

/**
 * A device's exception to its probe's target policy, as the device page shows and edits it
 * (`A-79`). The core is the guard (`A-64`); this decides what to offer.
 */

/**
 * Whether to offer the editor: the bar the core's route holds, an administrator, or anybody when
 * the authorisation layer is off, where every bar is cleared. Unknown, unreachable or with no
 * session at all, nothing is offered: offering a control and then refusing it is the worse
 * mistake.
 */
export function mayExcept(session: Session | undefined): boolean {
  if (session === undefined) return false;
  if (session.kind !== 'signed-in' && session.kind !== 'anonymous') return false;
  if (!session.requireAuthentication) return true;
  return session.kind === 'signed-in' && session.principal.role === 'admin';
}

/**
 * The addresses typed into the editor: one per line, or separated by commas or spaces, trimmed,
 * with the empty ones dropped. Judged by the core, which names the entry it refuses and why.
 */
export function addressesFrom(text: string): string[] {
  return text
    .split(/[\s,]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** The editor's text for a list: one address per line. */
export function textOf(addresses: readonly string[]): string {
  return addresses.join('\n');
}
