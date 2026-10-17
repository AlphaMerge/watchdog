import { useEffect, useState, type ReactNode } from 'react';
import type { ApiError } from '../api/client';
import { PLACED_MS } from './HeldListFailure';
import { ErrorPanel } from './Panels';

/**
 * A read that failed, said in a region that was on the page before the failure was (`U-58`).
 *
 * **An `ErrorPanel` mounted with its text already in it is not reliably announced** (`U-41`),
 * and a page whose read failed used to be exactly that: the loading line went and an alert
 * holding the failure took its place. Now the read's loading line and its failure share one
 * region, a `role="status"` there from the moment the read starts, so the failure comes into a
 * node that existed, as `U-54` did for refusals and `U-60` for the channel list.
 *
 * - **Polite, not an alert**, as every read's failure before it was decided (`U-56`'s first read
 *   of a run, `U-60`'s channel list, `U-67`'s held lists): nothing the operator asked for was
 *   refused, and it is the same kind of news as the loading line it takes the place of. The
 *   status role says it whole, *Try again* and the correlation id included.
 * - **Empty as it mounts, when it mounts with a failure** (`U-78`'s rule, `PLACED_MS`): a page
 *   that cannot show the region before the read — one that draws nothing until a later read, or
 *   whose failure is of something it was not reading a moment ago — still gets the region a
 *   moment before the failure, rather than both at once and nothing said. One mounted while the
 *   read was out has had that moment by the time the read fails, unless it failed within it.
 * - **Try again** is the panel's own (`U-68`): the panel stays while it re-reads, emptying its
 *   message, and the next failure puts it back in this same region, so it is said again.
 *
 * `loading` is what is being read, as `Loading` says it ("Loading the tree…"), shown while there
 * is no failure; without it the region is empty until one. `children` are said with the failure,
 * before the panel: what it means for what is on the page. `className` is the region's margin,
 * with an `empty:` twin where it can be empty in a stack (`U-45`).
 */
export function ReadRegion({
  error,
  retry,
  loading,
  focusAfter,
  className,
  children,
}: {
  error: ApiError | null;
  retry?: () => void;
  loading?: string;
  /** Where focus goes when the panel goes with focus in it (`ErrorPanel`'s, `U-76`). */
  focusAfter?: string;
  className?: string;
  children?: ReactNode;
}): React.JSX.Element {
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setPlaced(true);
    }, PLACED_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  const panel = error !== null && placed && (
    <ErrorPanel
      error={error}
      inRegion
      {...(retry === undefined ? {} : { retry })}
      {...(focusAfter === undefined ? {} : { focusAfter })}
    />
  );
  return (
    <div role="status" className={className}>
      {panel !== false && children !== undefined ? (
        <div className="space-y-2">
          {children}
          {panel}
        </div>
      ) : (
        panel
      )}
      {error === null && loading !== undefined && (
        <p className="text-sm text-text-muted">Loading {loading}…</p>
      )}
    </div>
  );
}

/** What `ReadState` needs of a read: `useApi`'s answer, or a hook shaped as it is. */
export interface Read {
  readonly status: 'loading' | 'ready' | 'error';
  readonly error?: ApiError | null;
  readonly retry: () => void;
}

function isList(read: Read | readonly Read[]): read is readonly Read[] {
  return Array.isArray(read);
}

/**
 * A read's region while it is out or failed, and nothing once it has answered (`U-58`).
 *
 * In place of `{x.status === 'loading' && <Loading/>}{x.status === 'error' && <ErrorPanel/>}`,
 * and of the two early returns that say the same: one element from the read's start to its
 * failure, so the failure lands in the node the loading line was in. Taken away by the answer,
 * so the page's content follows the loading line as it did, and the panel's focus rule (`U-68`)
 * runs as the panel goes.
 *
 * **Several reads a page waits on together** are one region: loading while any is out, as the
 * pages' early returns had it, then the first failure in the order given.
 */
export function ReadState({
  read,
  what,
  focusAfter,
  className,
}: {
  read: Read | readonly Read[];
  /** What is being read, for the loading line; omit for none. */
  what?: string;
  focusAfter?: string;
  className?: string;
}): React.JSX.Element | null {
  const reads: readonly Read[] = isList(read) ? read : [read];
  const loading = reads.some((one) => one.status === 'loading');
  const failed = loading ? undefined : reads.find((one) => one.status === 'error');
  if (!loading && failed === undefined) return null;
  return (
    <ReadRegion
      error={failed?.error ?? null}
      {...(failed === undefined ? {} : { retry: failed.retry })}
      {...(what === undefined ? {} : { loading: what })}
      {...(focusAfter === undefined ? {} : { focusAfter })}
      {...(className === undefined ? {} : { className })}
    />
  );
}
