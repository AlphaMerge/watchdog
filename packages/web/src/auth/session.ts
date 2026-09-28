import { createContext, useContext } from 'react';
import type { ApiError } from '../api/client';

/**
 * Who this browser is, and whether it has to be anybody (`U-17`).
 *
 * The types and the hook live here rather than beside the provider so this file exports no
 * component: a module that exports both a component and a hook cannot be hot-reloaded, which is
 * what `react-refresh/only-export-components` is about.
 */

export type AccountRole = 'admin' | 'readwrite' | 'readonly';

export interface Principal {
  readonly userId: number;
  readonly login: string;
  readonly role: AccountRole;
  /**
   * The password was set by somebody else — the bootstrap that created the first administrator,
   * or an administrator resetting it. Nothing on the core refuses a request because of this
   * flag; sending the operator to a change-password form is the client's job, and this is the
   * only place the core says so.
   */
  readonly mustChangePassword: boolean;
}

/** What `GET /auth/session` answers. Public, and the first call this app makes. */
export interface SessionReply {
  readonly requireAuthentication: boolean;
  readonly authenticated: boolean;
  readonly principal?: Principal;
}

/**
 * **`requireAuthentication` is carried on the anonymous case too, and that is the point.**
 * "Nobody is logged in" and "a login is needed" are two facts, and an installation running with
 * `api.requireAuthentication` off is usable by an anonymous caller — so a client that collapsed
 * them would put a login form in front of an operator the core is perfectly happy to serve.
 */
export type Session =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'unreachable'; readonly error: ApiError }
  | {
      readonly kind: 'anonymous';
      readonly requireAuthentication: boolean;
      /**
       * Why the session this tab had went away, in the core's words, when it said (`A-34`): the
       * live stream is closed with the reason, and the login form shows it, so somebody whose
       * session expired on a wall display is not left wondering what they did.
       */
      readonly ended?: string;
    }
  | {
      readonly kind: 'signed-in';
      readonly requireAuthentication: boolean;
      readonly principal: Principal;
    };

export interface SessionContextValue {
  readonly session: Session;
  /** A login succeeded, and this is who it was. */
  readonly signedIn: (principal: Principal) => void;
  /** Ends the session at the core, then here. Idempotent at both ends. */
  readonly signOut: () => Promise<void>;
  /** Ask the core again — after a password change, whose whole point is to clear a flag. */
  readonly refresh: () => void;
  /**
   * Whether the login form is up because somebody asked for it rather than because the core
   * insists. Only reachable with `requireAuthentication` off, where signing in is optional and
   * still worth doing: an anonymous operator's changes are audited as `anonymous`.
   */
  readonly askingToSignIn: boolean;
  readonly askToSignIn: (asking: boolean) => void;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error('useSession outside a SessionProvider');
  }
  return value;
}

/**
 * Whether the application is replaced by the login form.
 *
 * Pure, and separate from the component, because it is the one decision in this feature that is
 * wrong in two opposite directions: demand a login the core does not want, or render an
 * application whose every request will be refused.
 */
export function showsLoginForm(session: Session, askingToSignIn: boolean): boolean {
  if (session.kind !== 'anonymous') return false;
  return session.requireAuthentication || askingToSignIn;
}

/**
 * Whether the application is replaced by the change-password form.
 *
 * Forced, not offered: the flag means the password in use was chosen by somebody other than the
 * person holding it — the generated one in `first-admin-password`, most often — and every hour
 * it stays in use is an hour that file is a live credential.
 */
export function mustChangePassword(session: Session): boolean {
  return session.kind === 'signed-in' && session.principal.mustChangePassword;
}
