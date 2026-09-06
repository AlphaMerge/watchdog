import { useEffect, useRef, useState } from 'react';
import { ApiError, send } from '../api/client';
import { AuthPage } from './AuthPage';
import { feedbackFor, type LoginFeedback, type LoginStage } from './login-model';
import { useSession, type Principal } from './session';

const FIELD = 'mt-1 w-full border border-control bg-surface px-2 py-1.5 text-sm text-text';

/**
 * The login form (`U-17`).
 *
 * **Not a route.** It replaces the application in place, so the address bar still holds whatever
 * the operator was trying to reach and signing in puts them there rather than at the overview.
 * A `/login` route would have to remember where they were going and hand it back, which is a
 * thing to get wrong for no gain.
 */
export function LoginView(): React.JSX.Element {
  const { session, signedIn, askingToSignIn, askToSignIn } = useSession();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<LoginStage>('credentials');
  const [feedback, setFeedback] = useState<LoginFeedback | null>(null);
  const [busy, setBusy] = useState(false);
  const loginField = useRef<HTMLInputElement>(null);
  const codeField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loginField.current?.focus();
  }, []);

  // Focus follows the refusal: the field to fix is the one that gets the cursor, and on the
  // step from password to code that is a field which did not exist a moment ago.
  useEffect(() => {
    if (feedback === null) return;
    if (feedback.focus === 'code') codeField.current?.focus();
    else loginField.current?.select();
  }, [feedback]);

  /**
   * Every credential edit clears the refusal.
   *
   * **`stuck` disables the only submit control, and a disabled default button also swallows the
   * Enter key** — so a refusal that outlived the account it was about would leave the form dead
   * for every other account until the page was reloaded. `stuck` is a property of what was
   * typed, so it lasts exactly as long as what was typed.
   */
  const edit = (set: (value: string) => void) => (value: string) => {
    setFeedback(null);
    set(value);
  };

  const submit = (event: React.SyntheticEvent): void => {
    event.preventDefault();
    if (busy) return;

    // Both fields are `minLength: 1` in the route's body schema, so an empty submit is a 400
    // whose message is Ajv's JSON Pointer. Saying it here costs a round trip and reads like a
    // sentence.
    if (login === '' || password === '') {
      setFeedback({
        stage,
        message: 'Type a login and a password.',
        focus: 'login',
        retryAfterSeconds: 0,
        stuck: false,
      });
      return;
    }

    setBusy(true);
    // The password is sent again with the code, because `POST /auth/login` is one exchange and
    // not two: there is no half-authenticated state on the core to hold a password between them,
    // which is why there is nothing to expire and nothing to clean up.
    send<Principal>('POST', '/auth/login', {
      login,
      password,
      ...(stage === 'code' && code !== '' ? { code } : {}),
    })
      .then((principal) => {
        signedIn(principal);
      })
      .catch((error: unknown) => {
        const failure =
          error instanceof ApiError
            ? error
            : new ApiError(0, 'UNKNOWN', error instanceof Error ? error.message : String(error));
        const next = feedbackFor(failure, stage);
        setStage(next.stage);
        setFeedback(next);
        // Only the code is cleared, never the password. A password box emptied by a failed
        // second factor makes the operator retype a credential that was accepted.
        if (next.stage === 'code' && next.focus === 'code') setCode('');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const optional = session.kind === 'anonymous' && !session.requireAuthentication;

  return (
    <AuthPage title="Log in">
      <p className="mt-2 text-sm text-text-muted">
        {optional
          ? 'This installation does not require a login. Signing in names you in the audit log.'
          : 'This installation requires a login.'}
      </p>

      <form onSubmit={submit} className="mt-4">
        <div>
          <label htmlFor="login" className="ms-label">
            Login
          </label>
          <input
            id="login"
            ref={loginField}
            className={FIELD}
            value={login}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => {
              edit(setLogin)(event.target.value);
            }}
          />
        </div>

        <div className="mt-3">
          <label htmlFor="password" className="ms-label">
            Password
          </label>
          <input
            id="password"
            type="password"
            className={FIELD}
            value={password}
            autoComplete="current-password"
            disabled={busy}
            onChange={(event) => {
              edit(setPassword)(event.target.value);
            }}
          />
        </div>

        {stage === 'code' && (
          <div className="mt-3">
            <label htmlFor="code" className="ms-label">
              Authenticator code
            </label>
            <input
              id="code"
              ref={codeField}
              className={FIELD}
              value={code}
              /* `one-time-code` is what lets a phone offer the code from the notification. */
              autoComplete="one-time-code"
              inputMode="text"
              autoCapitalize="none"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => {
                edit(setCode)(event.target.value);
              }}
            />
          </div>
        )}

        {feedback !== null && (
          <p
            role="alert"
            className="mt-3 border border-down-border bg-down-bg px-3 py-2 text-sm text-down-fg"
          >
            {feedback.message}
          </p>
        )}

        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            /* Stuck means no attempt from this form can succeed; an enabled button would invite
               one anyway and answer the same way. */
            disabled={busy || feedback?.stuck === true}
            /* The app's primary button, spelled the way every other one is. Not `ms-label`:
               that class sets a colour of its own, and being unlayered it beats a Tailwind
               utility — `ms-label text-accent-contrast` renders muted grey on the accent, which
               measures 1.5:1. */
            className="border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Log in'}
          </button>
          {askingToSignIn && (
            <button
              type="button"
              className="ms-label border border-control px-3 py-1.5 text-text-muted hover:text-text"
              onClick={() => {
                askToSignIn(false);
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    </AuthPage>
  );
}
