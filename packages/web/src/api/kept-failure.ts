import { useState } from 'react';
import { type ApiError, type Loadable, sameWords } from './client';

/**
 * The failure a page says for a read it makes on its own: **the first of a run in the same
 * words, kept, id and all, until a read answers** (`U-72`).
 *
 * Decided 2026-10-11: a repeat of the same failure from a read nobody asked for stays silent,
 * and a new or different failure is said. A read the page starts by itself — the channel list's
 * once-a-minute re-read, the templates' after a save, the readings' poll — used to empty the
 * region it was said in as it started and fill it as it failed, every failure a new error with a
 * new id: a core that stayed down was said again with every read, to nobody who asked. So the
 * failure is held through each read the page makes and through each repeat in the same words
 * (`sameWords`: code and message); a failure in other words replaces it, and is said; a good
 * read clears it. This is `U-59`'s rule for `RunPanel`'s polls and the readings' since `U-71`'s
 * review, which this now is.
 *
 * - **Filed with `path`**, the path it was read from, so it is never shown for another sensor's
 *   list; for a read whose path moves by itself, what it is a read of (the shared map's token,
 *   whose path carries the minute).
 * - **Only while `counts`**: while a list is held, for a failure said beside it (with none held
 *   the page shows its own error panel, which `useApi`'s `retry` keeps), or, on the shared map,
 *   while no map has been read for the link.
 * - **`readAgain` is *Try again*, the operator's**: it clears what is shown as its read starts,
 *   so the same failure after it is said again — they asked. The failure in hand when it is
 *   pressed is set aside, since the hook still holds it on the render the press makes, before
 *   its read starts, and filed again then it would never leave the region.
 *
 * Set during render from the answer in hand, as the shared map's 404 is, so never a render
 * behind it.
 */
export function useKeptFailure(
  read: Loadable<unknown> & { readonly reload: () => void },
  path: string | null,
  counts: boolean,
): {
  readonly failure: ApiError | null;
  /** A read is out, or *Try again*'s is starting: the hook is not `loading` yet on its render. */
  readonly reading: boolean;
  readonly readAgain: () => void;
} {
  const [kept, setKept] = useState<{ path: string; error: ApiError } | null>(null);
  const [setAside, setSetAside] = useState<ApiError | null>(null);
  const failedNow =
    read.status === 'error' && counts && path !== null && read.error !== setAside
      ? read.error
      : null;
  if (read.status === 'ready' && kept !== null) setKept(null);
  if (
    failedNow !== null &&
    path !== null &&
    (kept === null || kept.path !== path || !sameWords(kept.error, failedNow))
  ) {
    setKept({ path, error: failedNow });
  }
  const failure = kept !== null && kept.path === path ? kept.error : null;
  const readAgain = (): void => {
    setKept(null);
    if (read.status === 'error') setSetAside(read.error);
    read.reload();
  };
  const reading = read.status === 'loading' || (read.status === 'error' && read.error === setAside);
  return { failure, reading, readAgain };
}
