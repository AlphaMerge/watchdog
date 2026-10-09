import { useEffect, useRef, useState } from 'react';
import { ApiError, send } from '../api/client';
import { CorrelationId } from '../components/Panels';
import { useRefusal } from '../components/refusal';
import { useSession } from './session';

const FIELD = 'mt-1 w-full border border-control bg-surface px-2 py-1.5 text-sm text-text';

/** The core's own floor, checked here too so a twelfth character is not a round trip. */
const MINIMUM = 12;

/** What the form says when a change is refused: the core's id with it, when the core refused. */
interface Refusal {
  readonly message: string;
  readonly correlationId: string | undefined;
}

/** A refusal the form decides itself, which no request was made for and so has no id. */
const own = (message: string): Refusal => ({ message, correlationId: undefined });

export interface PasswordChanged {
  readonly endedSessions: number;
}

/**
 * Changing your own password (`U-17`).
 *
 * Used in two frames: the one the application is replaced by when `mustChangePassword` is set,
 * and an ordinary page a signed-in operator can visit. The difference is `forced` and nothing
 * else — the request, the rules and the failures are the same, and having them in one place is
 * what stops the forced path from being the one nobody exercises.
 */
export function ChangePasswordForm({ forced = false }: { forced?: boolean }): React.JSX.Element {
  const { refresh } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [refusal, setRefusal, sayAgain] = useRefusal<Refusal>();
  const [done, setDone] = useState<PasswordChanged | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
  }, []);

  const submit = (event: React.SyntheticEvent): void => {
    event.preventDefault();
    if (busy) return;

    // Checked here as well as at the core. The confirmation field has no server side at all —
    // it exists so a typo in a password nobody can read back does not become a lockout. Each is
    // decided in this handler, which may have just said the same thing, so it is emptied now and
    // said a moment later (`U-54`).
    if (next.length < MINIMUM) {
      sayAgain(own(`A password must be at least ${String(MINIMUM)} characters.`));
      return;
    }
    if (next !== confirm) {
      sayAgain(own('Those two do not match.'));
      return;
    }
    if (next === current) {
      sayAgain(own('That is the password you are replacing.'));
      return;
    }

    setBusy(true);
    setRefusal(null);
    send<PasswordChanged>('POST', '/auth/password', {
      currentPassword: current,
      newPassword: next,
    })
      .then((result) => {
        setDone(result);
        setCurrent('');
        setNext('');
        setConfirm('');
        // The flag lives on the account, so the client's copy of the principal is now stale.
        // Asking the core again is the only thing that clears the forced form.
        refresh();
      })
      .catch((error: unknown) => {
        setRefusal(
          error instanceof ApiError
            ? { message: error.message, correlationId: error.correlationId }
            : own(error instanceof Error ? error.message : String(error)),
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  if (done !== null && !forced) {
    return (
      <div role="status" className="text-sm text-text">
        <p>Your password has been changed.</p>
        <p className="mt-2 text-text-muted">
          {done.endedSessions === 0
            ? 'No other sessions were open.'
            : `${String(done.endedSessions)} other session${
                done.endedSessions === 1 ? '' : 's'
              } signed out.`}
        </p>
      </div>
    );
  }

  return (
    <>
      {forced && (
        <p className="mt-2 text-sm text-text-muted">
          This password was set for you. Choose your own before going on — the file it was written
          to is a live credential until you do.
        </p>
      )}

      <form onSubmit={submit} className="mt-4">
        <div>
          <label htmlFor="current-password" className="ms-label">
            Current password
          </label>
          <input
            id="current-password"
            ref={first}
            type="password"
            className={FIELD}
            value={current}
            autoComplete="current-password"
            disabled={busy}
            onChange={(event) => {
              setCurrent(event.target.value);
            }}
          />
        </div>

        <div className="mt-3">
          <label htmlFor="new-password" className="ms-label">
            New password
          </label>
          <input
            id="new-password"
            type="password"
            className={FIELD}
            value={next}
            autoComplete="new-password"
            aria-describedby="new-password-rule"
            disabled={busy}
            onChange={(event) => {
              setNext(event.target.value);
            }}
          />
          <p id="new-password-rule" className="mt-1 text-xs text-text-muted">
            At least {MINIMUM} characters.
          </p>
        </div>

        <div className="mt-3">
          <label htmlFor="confirm-password" className="ms-label">
            New password again
          </label>
          <input
            id="confirm-password"
            type="password"
            className={FIELD}
            value={confirm}
            autoComplete="new-password"
            disabled={busy}
            onChange={(event) => {
              setConfirm(event.target.value);
            }}
          />
        </div>

        {/* **Always there, empty until a refusal** (`U-54`), as `LoginView`'s: a region added
            with its text already in it is not reliably announced (`U-41`). The box is inside it,
            and `empty:mt-0` gives back its margin while it says nothing (`U-45`). */}
        <div role="alert" className="mt-3 empty:mt-0">
          {refusal !== null && (
            <p className="border border-down-border bg-down-bg px-3 py-2 text-sm text-down-fg">
              {refusal.message}
              <CorrelationId id={refusal.correlationId} />
            </p>
          )}
        </div>

        <p className="mt-3 text-xs text-text-muted">
          Every other session this account has open will be signed out. The one you are using will
          not.
        </p>

        <button
          type="submit"
          disabled={busy}
          className="mt-4 border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50"
        >
          {busy ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </>
  );
}
