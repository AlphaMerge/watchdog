import { useEffect, useRef, useState } from 'react';
import type { ApiError } from '../api/client';
import { CorrelationId } from './Panels';

/**
 * A list held on the page whose re-read failed (`U-67`).
 *
 * A page that keeps the list it last read while it reads it again (`ObjectDetailView`'s channel
 * list, `U-55`; `TemplatesView`'s templates, `U-64`) used to keep it with no sign, when that read
 * failed, that what is shown may no longer be what the core holds. This says so, beside the list,
 * with *Try again*.
 *
 * - **A region that is always there, empty until a re-read fails** (`U-41`, `U-54`), and polite
 *   (`role="status"`, said whole): nothing the operator asked for was refused, and the list they
 *   were reading is still there to read (`U-60`'s first read is polite for the same reason). The
 *   caller passes the failure only while a list is held; with none held the page has its own
 *   error panel. Emptied as each read starts — the caller's `error` is null while one is out — so
 *   the same failure twice is said twice; the next good read leaves it empty.
 * - ***Try again* is one element from the failure until a read answers**, outside the region so
 *   the region can be empty while it stays (`U-63`'s `RetryCheck`): `aria-disabled`, not
 *   `disabled`, while the read is out, since a disabled control can lose the focus it holds, and
 *   a press then does nothing. It also stays through a read the page starts on its own while it
 *   is offered (the channel list's once-a-minute re-read), so that read cannot take it from under
 *   a focused finger either.
 * - **When a good read takes it away, focus goes to `focusAfter`**, only if it fell to the page
 *   (as `U-63` and `U-64` move it): an operator who went elsewhere while the read was out keeps
 *   their place.
 *
 * `what` is the list, as it starts a sentence ("The channel list").
 */
export function HeldListFailure({
  what,
  error,
  reading,
  onRetry,
  focusAfter,
}: {
  what: string;
  /** The last read's failure, only while a list is held; null while a read is out. */
  error: ApiError | null;
  /** A read of the list is out. */
  reading: boolean;
  /** Reads the list again. */
  onRetry: () => void;
  /** Where focus goes when *Try again* is taken away by a good read and focus fell to the page. */
  focusAfter: () => void;
}): React.JSX.Element {
  const [offered, setOffered] = useState(false);
  const showing = error !== null || (reading && offered);
  // The latest `focusAfter`, so a caller need not hold one function across renders for it.
  const after = useRef(focusAfter);
  useEffect(() => {
    after.current = focusAfter;
  });
  useEffect(() => {
    if (offered && !showing) {
      const at = document.activeElement;
      if (at === null || at === document.body) after.current();
    }
    setOffered(showing);
  }, [offered, showing]);

  return (
    <div>
      <p role="status" className="mb-2 text-sm text-warning-fg empty:mb-0">
        {error !== null && (
          <>
            {what} could not be read again, so this is the one read before and may be out of date:{' '}
            {error.message}
            <CorrelationId id={error.correlationId} />
          </>
        )}
      </p>
      {showing && (
        <button
          type="button"
          aria-disabled={error === null}
          onClick={() => {
            if (error !== null) onRetry();
          }}
          className="ms-label mb-3 border border-control px-2 py-1 text-text-muted hover:text-text aria-disabled:opacity-50"
        >
          Try again
        </button>
      )}
    </div>
  );
}
