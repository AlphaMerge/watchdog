import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, onSessionLost, request, send } from '../api/client';
import { SessionContext, type Principal, type Session, type SessionReply } from './session';

/**
 * Asks the core who this browser is, once, before the application renders (`U-17`).
 *
 * **`GET /auth/session` and not `GET /auth/me`.** `/auth/me` refuses an anonymous caller with
 * 401, and that 401 carries two different meanings — "log in" and "you did not need to" — which
 * is the one distinction this whole component exists to make.
 */
export function SessionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [session, setSession] = useState<Session>({ kind: 'unknown' });
  const [askingToSignIn, setAskingToSignIn] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    request<SessionReply>('/auth/session', controller.signal)
      .then((reply) => {
        if (controller.signal.aborted) return;
        setSession(
          reply.authenticated && reply.principal !== undefined
            ? {
                kind: 'signed-in',
                requireAuthentication: reply.requireAuthentication,
                principal: reply.principal,
              }
            : { kind: 'anonymous', requireAuthentication: reply.requireAuthentication },
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // Nothing here is a login problem: the route is public and answers 200 to anybody. A
        // failure means the core is not answering, and a login form in front of an unreachable
        // core would invite somebody to type a password at a server that is not there.
        setSession({
          kind: 'unreachable',
          error:
            error instanceof ApiError
              ? error
              : new ApiError(0, 'UNKNOWN', error instanceof Error ? error.message : String(error)),
        });
      });
    return () => {
      controller.abort();
    };
  }, [nonce]);

  /**
   * A session that went away underneath a signed-in operator — expired, or ended from another
   * tab.
   *
   * **Only from `signed-in`.** An anonymous browser on an installation that does not require
   * authentication can still provoke `AUTH_REQUIRED` from a route about the caller's own
   * account, and treating that as a lost session would put a login form in front of somebody
   * who never had one and does not need one. `requireAuthentication` is carried across
   * unchanged rather than assumed: what the core last said is better evidence than a guess.
   */
  useEffect(() => {
    onSessionLost((ended) => {
      setSession((current) =>
        current.kind === 'signed-in'
          ? {
              kind: 'anonymous',
              requireAuthentication: current.requireAuthentication,
              ...(ended === undefined ? {} : { ended }),
            }
          : current,
      );
    });
    return () => {
      onSessionLost(undefined);
    };
  }, []);

  const signedIn = useCallback((principal: Principal) => {
    setAskingToSignIn(false);
    setSession((current) => ({
      kind: 'signed-in',
      // An anonymous state knows this; `unknown` and `unreachable` do not, and a login that
      // succeeded from one of those means the core is answering after all.
      requireAuthentication:
        current.kind === 'unknown' || current.kind === 'unreachable'
          ? true
          : current.requireAuthentication,
      principal,
    }));
  }, []);

  const signOut = useCallback(async () => {
    // `/auth/logout` is public and idempotent, so a session that already expired still clears
    // the cookie rather than answering 401. A failure here is the core being unreachable, and
    // staying "signed in" in that case would be a lie about a session that no longer exists.
    try {
      await send<undefined>('POST', '/auth/logout');
    } catch {
      // Reported by whatever the operator does next; the local state is the honest part.
    }
    setAskingToSignIn(false);
    setSession((current) => ({
      kind: 'anonymous',
      requireAuthentication:
        current.kind === 'unknown' || current.kind === 'unreachable'
          ? true
          : current.requireAuthentication,
    }));
  }, []);

  const refresh = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  const value = useMemo(
    () => ({
      session,
      signedIn,
      signOut,
      refresh,
      askingToSignIn,
      askToSignIn: setAskingToSignIn,
    }),
    [session, signedIn, signOut, refresh, askingToSignIn],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
