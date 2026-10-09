import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
 * - **When a good read takes it away, focus goes to `focusAfter`**, only if *Try again* itself
 *   held focus as it went and focus then fell to the page (as `U-63` and `U-64` move it): an
 *   operator who went elsewhere while the read was out keeps their place, and a page whose focus
 *   was never on the button (opened by its address, read in browse mode) is not given focus by a
 *   re-read it made on its own (`U-67` review).
 *
 * `what` is the list, as it starts a sentence ("The channel list"). The History tab's series uses
 * it too, for a re-read the page asked for (`U-61`), and the channel table's readings, for a poll
 * that failed (`U-71`), which say what is held in words of their own (`held`).
 */
export function HeldListFailure({
  what,
  held = 'this is the one read before and may be out of date',
  error,
  reading,
  onRetry,
  focusAfter,
}: {
  what: string;
  /** What is shown meanwhile, as it ends that sentence after "so". */
  held?: string;
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
  // Whether *Try again* held focus as it was taken off the page (`RetryButton` says so before its
  // node goes). Not "focus is on the page now": it is there all along on a page opened by its
  // address and in a screen reader's browse mode, and a re-read the page made on its own would
  // then take focus nobody gave it.
  const hadFocus = useRef(false);
  useEffect(() => {
    if (offered && !showing) {
      const at = document.activeElement;
      if (hadFocus.current && (at === null || at === document.body)) after.current();
      hadFocus.current = false;
    }
    setOffered(showing);
  }, [offered, showing]);

  return (
    <div>
      <p role="status" className="mb-2 text-sm text-warning-fg empty:mb-0">
        {error !== null && (
          <>
            {what} could not be read again, so {held}: {error.message}
            <CorrelationId id={error.correlationId} />
          </>
        )}
      </p>
      {showing && (
        <RetryButton
          busy={error === null}
          onRetry={onRetry}
          onGone={(focused) => {
            hadFocus.current = focused;
          }}
        />
      )}
    </div>
  );
}

/**
 * *Try again*, which says as it goes whether it held focus.
 *
 * Its own component so that its layout effect's cleanup runs before its node is taken out of the
 * document (React runs a deleted component's layout cleanups, then removes its host nodes): at
 * that moment `document.activeElement` is still the button if it had focus. Blur is no help — a
 * browser may or may not fire it for a node removed while focused.
 */
function RetryButton({
  busy,
  onRetry,
  onGone,
}: {
  busy: boolean;
  onRetry: () => void;
  onGone: (focused: boolean) => void;
}): React.JSX.Element {
  const button = useRef<HTMLButtonElement>(null);
  const gone = useRef(onGone);
  useLayoutEffect(() => {
    gone.current = onGone;
  });
  useLayoutEffect(() => {
    const node = button.current;
    return () => {
      gone.current(node !== null && document.activeElement === node);
    };
  }, []);
  return (
    <button
      ref={button}
      type="button"
      aria-disabled={busy}
      onClick={() => {
        if (!busy) onRetry();
      }}
      className="ms-label mb-3 border border-control px-2 py-1 text-text-muted hover:text-text aria-disabled:opacity-50"
    >
      Try again
    </button>
  );
}
