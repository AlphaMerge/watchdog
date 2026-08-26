import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

const SITE = 'MonitoringSystem';

/**
 * Whether a heading that has just appeared on `next` should pull focus.
 *
 * Three cases, and only one of them moves focus:
 *
 * - `previous === null` — the first page of the session. The browser has focus at the top of the
 *   document, which is where it belongs; taking it would skip the skip link.
 * - `previous === next` — the same page re-rendered, which is what a tab switch, a filter change
 *   or a finished fetch looks like. Moving focus here would yank a keyboard user out of the
 *   control they are using every time data arrives.
 * - anything else — a navigation, so move.
 *
 * Search parameters are deliberately not part of `next`. `?tab=history` is the same page.
 */
export function shouldTakeFocus(previous: string | null, next: string): boolean {
  if (previous === null) return false;
  return previous !== next;
}

/**
 * Module scope on purpose: the route component unmounts on navigation, so a ref inside it would
 * be reset exactly when the answer is needed. This is the app's single "which page was I on".
 */
let focusedPath: string | null = null;

/** Test seam — a module-level value would otherwise leak between test cases. */
export function resetNavigationFocus(): void {
  focusedPath = null;
}

export interface PageTitleProps {
  /** Plain text, for the document title. Not the heading's markup. */
  readonly title: string;
  /** The heading's content, when it is richer than the title — defaults to the title. */
  readonly children?: React.ReactNode;
  readonly className?: string;
}

/**
 * The page's `h1`, its document title, and where focus goes when you arrive (`U-11`).
 *
 * **One component, because these are one thing.** A single-page app changes the page without
 * telling anybody: the document title stayed "MonitoringSystem" on all nine routes, which fails
 * WCAG 2.4.2, and focus stayed on whatever link was clicked, so a screen-reader user got no
 * announcement that anything had happened and had to hunt for the new content. The fix for both
 * is the heading, so the heading owns both — a route cannot set a title and forget the focus, or
 * the other way round, because it does not do either by hand.
 *
 * The heading takes focus rather than a wrapper or `main`, because it is the thing worth reading
 * on arrival: the announcement is the page's name. `tabIndex={-1}` makes it focusable
 * programmatically without adding a stop to the tab order.
 */
export function PageTitle({
  title,
  children,
  className = 'text-xl font-semibold text-text',
}: PageTitleProps): React.JSX.Element {
  const { pathname } = useLocation();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    document.title = title === '' ? SITE : `${title} — ${SITE}`;
  }, [title]);

  useEffect(() => {
    if (shouldTakeFocus(focusedPath, pathname)) {
      // `preventScroll`, because the heading is already at the top of the page it belongs to and
      // a focus-driven jump would fight the router's own scroll restoration.
      heading.current?.focus({ preventScroll: true });
    }
    focusedPath = pathname;
  }, [pathname]);

  return (
    <h1 ref={heading} tabIndex={-1} className={className}>
      {children ?? title}
    </h1>
  );
}
