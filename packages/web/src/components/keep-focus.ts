import { createContext } from 'react';

/**
 * Where focus goes when an error panel that held it is removed (`U-68`, `U-76`).
 *
 * Its own module because both `ErrorPanel` and `PageTitle` use it, and a module that exports both
 * a component and a function cannot Fast Refresh.
 *
 * **A nearer target first, when the panel has one** (`U-76`): the element named by the panel's
 * `focusAfter`, or else by the `NearerFocus` around it. The sensor page's tab panels put theirs
 * around everything in them, so a panel on the History tab or in an Overview card that goes
 * leaves focus on the tab it was in, not at the top of the page above the header, the tabs and
 * every card before it. Used only while it is on the page and not inside the panel going.
 *
 * **Otherwise the page's heading**, `PageTitle`'s `h1`, focusable for this and where focus goes on
 * arriving at a page (`U-11`). Two cases:
 * - **It is on the page as the panel goes** (a panel inside a page): focus goes to it then, in
 *   the same commit, so it is never on the body.
 * - **It comes with the answer** (a page that is only the panel until its read succeeds): focus
 *   is *owed*, and the heading takes it as it is put on the page, in its layout effect, which runs
 *   in that same commit. A heading that is not `PageTitle`'s is looked for once the commit is done.
 */

/**
 * The id of the element an error panel inside it hands focus to as it goes, nearer than the
 * page's heading (`U-76`). Null where there is none.
 */
export const NearerFocus = createContext<string | null>(null);

/** Set while a panel that held focus has gone and no heading has taken it yet. */
let owed = false;

/** The page's own heading, if it has one outside `leaving`. */
function pageHeading(leaving: HTMLElement): HTMLElement | null {
  const heading = document.querySelector<HTMLElement>('h1[tabindex="-1"]');
  return heading !== null && !leaving.contains(heading) ? heading : null;
}

/** The nearer target `id` names, if it is on the page and outside `leaving`. */
function nearerTarget(leaving: HTMLElement, id: string | null): HTMLElement | null {
  if (id === null) return null;
  const target = document.getElementById(id);
  return target !== null && !leaving.contains(target) ? target : null;
}

function lost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/** Focus is in `leaving`, which is being removed. `nearer` is the id of a target before the h1. */
export function keepFocusOnThePage(leaving: HTMLElement, nearer: string | null = null): void {
  const target = nearerTarget(leaving, nearer) ?? pageHeading(leaving);
  if (target === null) owed = true;
  else target.focus({ preventScroll: true });
  // And once the commit is done, if it fell to the page after all: the target was removed with
  // the panel (a tab panel going with it), or the heading that came is not `PageTitle`'s.
  queueMicrotask(() => {
    owed = false;
    if (lost()) {
      (nearerTarget(leaving, nearer) ?? pageHeading(leaving))?.focus({ preventScroll: true });
    }
  });
}

/** For a heading being put on the page: whether a panel that went is owed focus, which it takes. */
export function takeOwedFocus(): boolean {
  const was = owed && lost();
  owed = false;
  return was;
}
