/**
 * Where focus goes when the app changes page, and the single piece of state that decides it.
 *
 * Separate from the heading because the interesting half is the judgement about when *not* to
 * move focus, which `test/tree-keyboard.test.ts` exercises directly — and because a module that
 * exports both a component and a function cannot Fast Refresh.
 */

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

/**
 * Whether arriving at `pathname` should move focus, recording it as the page we are now on.
 *
 * One call rather than a read and a write, because the two must not come apart: the answer is
 * only right on the first render of a route, and it is the recording that makes it so.
 */
export function takeFocusOn(pathname: string): boolean {
  const take = shouldTakeFocus(focusedPath, pathname);
  focusedPath = pathname;
  return take;
}

/** Test seam — a module-level value would otherwise leak between test cases. */
export function resetNavigationFocus(): void {
  focusedPath = null;
}
