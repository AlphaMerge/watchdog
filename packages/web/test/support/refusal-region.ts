import { screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';

/**
 * What a refusal region is held to (`U-41`, `U-45`, `U-48`, `U-52`, `U-54`).
 *
 * A refusal is said by a region that is in the tree, empty, before the attempt it answers — one
 * added with its text already in it is not reliably announced — and the refusal lands in that same
 * node. So a page has alerts that say nothing, and the alert to look at is the one that says
 * something; these find it. jsdom lays nothing out, so what is asserted about an empty one is what
 * the layout rests on.
 */

/** Every alert on the page that says something. */
export function speaking(): HTMLElement[] {
  return screen.queryAllByRole('alert').filter((one) => one.textContent !== '');
}

/** The alert that says `text`, once one does. */
export async function alertSaying(text: string | RegExp): Promise<HTMLElement> {
  return waitFor(() => {
    const found = screen
      .getAllByRole('alert')
      .find((one) =>
        typeof text === 'string' ? one.textContent.includes(text) : text.test(one.textContent),
      );
    if (found === undefined) throw new Error(`no alert says ${String(text)}`);
    return found;
  });
}

/**
 * An empty region, as it must be while it says nothing: `:empty`, an alert by its role, in the
 * accessibility tree, and taking no space. `spacing` is what does that: its margin and the
 * `empty:` twin that takes it away (`mt-3`, `empty:mt-0`), or `empty:absolute` for one that has
 * no margin but sits in a row whose `gap-*` would open for it. Its parent does not space its
 * children itself — `space-y-*` margins every child but the last, and a `gap-*` opens for an empty
 * child too — unless the region is taken out of the flow while empty.
 *
 * `live` is `'polite'` for a region that waits its turn (`U-48`, `U-57`): not an alert, polite by
 * `aria-live` or by `role="status"`, and said whole — `aria-atomic`, or the status role's own —
 * so a change to part of it is not read as that part alone.
 */
export function expectQuiet(
  region: HTMLElement,
  spacing: readonly string[],
  live: 'alert' | 'polite' = 'alert',
): void {
  if (live === 'alert') {
    expect(region.getAttribute('role')).toBe('alert');
  } else {
    const status = region.getAttribute('role') === 'status';
    expect(region.getAttribute('role')).not.toBe('alert');
    expect(region.getAttribute('aria-live') ?? (status ? 'polite' : null)).toBe('polite');
    expect(region.getAttribute('aria-atomic') ?? (status ? 'true' : null)).toBe('true');
  }
  expect(region.matches(':empty')).toBe(true);
  for (const one of spacing) expect(region.classList.contains(one)).toBe(true);
  const parent = region.parentElement?.className ?? '';
  expect(parent).not.toMatch(/(^|\s)space-y-/u);
  if (!spacing.includes('empty:absolute')) expect(parent).not.toMatch(/(^|\s)gap-/u);
  expect(region.hidden).toBe(false);
  expect(region.hasAttribute('aria-hidden')).toBe(false);
  expect(region.classList.contains('hidden')).toBe(false);
  expect(region.classList.contains('sr-only')).toBe(false);
  expect(getComputedStyle(region).display).not.toBe('none');
}

/**
 * The correlation id `region` says after its message (`U-51`, `U-59`): one `ml-2 font-mono` span
 * holding the core's id, after a space so a screen reader does not run it into the message — or,
 * for a refusal the page decided itself or a core that never answered (`undefined`), none.
 */
export function expectCorrelation(region: HTMLElement, id: string | undefined): void {
  const spans = [...region.querySelectorAll('span.font-mono')];
  if (id === undefined) {
    expect(spans).toEqual([]);
    return;
  }
  expect(spans).toHaveLength(1);
  expect(spans[0]?.classList.contains('ml-2')).toBe(true);
  expect(spans[0]?.textContent).toBe(` ${id}`);
}
