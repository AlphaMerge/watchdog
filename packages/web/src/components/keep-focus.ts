/**
 * Where focus goes when an error panel that held it is removed (`U-68`).
 *
 * Its own module because both `ErrorPanel` and `PageTitle` use it, and a module that exports both
 * a component and a function cannot Fast Refresh.
 *
 * **The page's heading**, `PageTitle`'s `h1`, focusable for this and where focus goes on arriving
 * at a page (`U-11`). Two cases:
 * - **It is on the page as the panel goes** (a panel inside a page): focus goes to it then, in
 *   the same commit, so it is never on the body.
 * - **It comes with the answer** (a page that is only the panel until its read succeeds): focus
 *   is *owed*, and the heading takes it as it is put on the page, in its layout effect, which runs
 *   in that same commit. A heading that is not `PageTitle`'s is looked for once the commit is done.
 */

/** Set while a panel that held focus has gone and no heading has taken it yet. */
let owed = false;

/** The page's own heading, if it has one outside `leaving`. */
function pageHeading(leaving: HTMLElement): HTMLElement | null {
  const heading = document.querySelector<HTMLElement>('h1[tabindex="-1"]');
  return heading !== null && !leaving.contains(heading) ? heading : null;
}

function lost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/** Focus is in `leaving`, which is being removed. */
export function keepFocusOnThePage(leaving: HTMLElement): void {
  const heading = pageHeading(leaving);
  if (heading === null) owed = true;
  else heading.focus({ preventScroll: true });
  // And once the commit is done, if it fell to the page after all: the heading was removed with
  // the panel, or the one that came is not `PageTitle`'s.
  queueMicrotask(() => {
    owed = false;
    if (lost()) pageHeading(leaving)?.focus({ preventScroll: true });
  });
}

/** For a heading being put on the page: whether a panel that went is owed focus, which it takes. */
export function takeOwedFocus(): boolean {
  const was = owed && lost();
  owed = false;
  return was;
}
