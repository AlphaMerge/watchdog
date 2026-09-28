import type { SessionService } from './sessions.js';
import type { TokenService } from './tokens.js';

/**
 * What authenticated a connection that outlives its request, and whether it still does (`A-34`).
 *
 * **Every ordinary request asks again.** The authentication hook resolves its session or token on
 * every request, and that lookup refuses a session that was ended or has expired, a token that was
 * revoked, and an account that was disabled. A WebSocket is one request that lives for days: it is
 * authenticated once, at the upgrade, and nothing after that asked — so a stream opened before a
 * logout, a revocation or a disable went on streaming to whoever held it.
 *
 * This is the same question, asked of connections rather than requests, and it is asked here
 * rather than told by the services that end a credential: a pull catches a session deleted by
 * hand in `psql` as surely as one ended through `/auth/logout`, a session that simply expired
 * (which nothing announces), and a service added next year that forgets to announce anything.
 */
export type Credential =
  | { readonly kind: 'session'; readonly id: string; readonly userId: number }
  | { readonly kind: 'token'; readonly id: number; readonly userId: number };

/**
 * Why a credential no longer authenticates.
 *
 * - `ended`: the session is gone — a logout, a password change ending the others, an administrator.
 * - `expired`: the session reached its idle or absolute timeout, or the token its expiry.
 * - `revoked`: the token was revoked.
 * - `disabled`: the account was disabled, or removed. Checked first, because it is the one that
 *   says the most: every credential the account holds lapsed with it.
 */
export type Lapse = 'ended' | 'expired' | 'revoked' | 'disabled';

export const LAPSES: readonly Lapse[] = ['ended', 'expired', 'revoked', 'disabled'];

/** One string per credential, so two sockets on one session are asked about once. */
export function credentialKey(credential: Credential): string {
  return `${credential.kind}:${String(credential.id)}`;
}

export interface CredentialCheck {
  /**
   * The credentials among these that no longer authenticate, by `credentialKey`, with why. One
   * that is absent from the answer still authenticates. Rejects when it cannot tell, which is not
   * the same answer as "lapsed" and must not be treated as one.
   */
  lapsed(credentials: readonly Credential[]): Promise<ReadonlyMap<string, Lapse>>;
}

/**
 * The check, asked of the services that issue the credentials — each asks with the condition its
 * own `resolve` uses, so the two cannot come to disagree about what "still signed in" means.
 */
export function credentialCheck(sessions: SessionService, tokens?: TokenService): CredentialCheck {
  return {
    async lapsed(credentials) {
      const sessionsAsked = new Map<string, { id: string; userId: number }>();
      const tokensAsked = new Map<number, { id: number; userId: number }>();
      for (const credential of credentials) {
        if (credential.kind === 'session') sessionsAsked.set(credential.id, credential);
        else tokensAsked.set(credential.id, credential);
      }
      const [sessionLapses, tokenLapses] = await Promise.all([
        sessions.lapsed([...sessionsAsked.values()]),
        tokensAsked.size === 0 || tokens === undefined
          ? new Map<number, Lapse>()
          : tokens.lapsed([...tokensAsked.values()]),
      ]);
      const lapsed = new Map<string, Lapse>();
      for (const [id, lapse] of sessionLapses) lapsed.set(`session:${id}`, lapse);
      for (const [id, lapse] of tokenLapses) lapsed.set(`token:${String(id)}`, lapse);
      // A token presented to a build with no token service cannot be vouched for, and "cannot be
      // vouched for" is not "still good". Unreachable today — the hook resolves tokens only when
      // there is a service — and stated so the day it is reachable is not a quiet hole.
      if (tokens === undefined) {
        for (const id of tokensAsked.keys()) lapsed.set(`token:${String(id)}`, 'revoked');
      }
      return lapsed;
    },
  };
}
