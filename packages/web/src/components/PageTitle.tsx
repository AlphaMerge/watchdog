import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { takeFocusOn } from './page-title-model';

const SITE = 'MonitoringSystem';

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
    if (takeFocusOn(pathname)) {
      // `preventScroll`, because the heading is already at the top of the page it belongs to and
      // a focus-driven jump would fight the router's own scroll restoration.
      heading.current?.focus({ preventScroll: true });
    }
  }, [pathname]);

  return (
    <h1 ref={heading} tabIndex={-1} className={className}>
      {children ?? title}
    </h1>
  );
}
