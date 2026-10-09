import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { alertSaying } from './refusal-region';

/**
 * *Try again* keeps focus (`U-68`): a scripted core, a focus watcher, and the round every caller
 * of an error panel is held to. Shared by `try-again-focus.test.tsx` and
 * `try-again-pages.test.tsx`.
 */

export const FAILED = 'the database went away';

/** One answer from the core: a body, or a refusal in the core's envelope. */
export type Reply = { readonly ok: unknown } | { readonly fail: number; readonly id?: string };
export const fail = (id?: string): Reply => ({ fail: 500, ...(id === undefined ? {} : { id }) });

/**
 * The core, scripted per path prefix: each read of a path takes the next reply in its list, and
 * the last one repeats. Answers what nothing scripted with a 404.
 */
export function core(script: Record<string, Reply[]>): { asked: (prefix: string) => number } {
  const asked: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    const path = url.replace(/^.*\/api\/v1/u, '');
    asked.push(path);
    const key = Object.keys(script)
      .filter((prefix) => path === prefix || path.startsWith(`${prefix}?`))
      .sort((a, b) => b.length - a.length)[0];
    const replies = key === undefined ? undefined : script[key];
    const reply =
      replies === undefined ? undefined : replies.length > 1 ? replies.shift() : replies[0];
    const [status, body] =
      reply === undefined
        ? [404, { error: { code: 'NOT_FOUND', message: 'no' } }]
        : 'ok' in reply
          ? [200, reply.ok]
          : [
              reply.fail,
              {
                error: {
                  code: 'INTERNAL',
                  message: FAILED,
                  ...(reply.id === undefined ? {} : { correlationId: reply.id }),
                },
              },
            ];
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return { asked: (prefix) => asked.filter((path) => path.startsWith(prefix)).length };
}

/**
 * Every time the page changes, whether focus was on it: the count of changes after which
 * `document.activeElement` was the body. Observed from the press on, after React's commit.
 */
export function watchFocus(): { lost: () => number; stop: () => void } {
  let lost = 0;
  const observer = new MutationObserver(() => {
    if (document.activeElement === null || document.activeElement === document.body) lost += 1;
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  return {
    lost: () => lost,
    stop: () => {
      observer.disconnect();
    },
  };
}

/** Whether a node holding `text` was added inside `region` among `records`. */
function added(records: MutationRecord[], region: HTMLElement, text: string): boolean {
  return records.some(
    (record) =>
      region.contains(record.target) &&
      [...record.addedNodes].some((node) => (node.textContent ?? '').includes(text)),
  );
}

/**
 * The whole round, from a page whose read failed: *Try again* re-reads with the same button
 * focused and unavailable, the message out of the alert and no loading line; a second failure in
 * the same words puts the message back in the same alert, focus still on the button; and a
 * read that succeeds puts focus on the page's heading, or on `landsOn` for a panel that names
 * something nearer (`U-76`). Never the body, from the first press on.
 */
export async function roundTrip({
  heading,
  landsOn,
  answered,
  reads,
}: {
  heading: string;
  /** Where focus goes when the panel goes, when that is not the heading. */
  landsOn?: () => HTMLElement | null;
  answered: () => HTMLElement;
  reads: () => number;
}): Promise<void> {
  const alert = await alertSaying(FAILED);
  const button = within(alert).getByRole('button', { name: 'Try again' });
  act(() => {
    button.focus();
  });
  const focus = watchFocus();
  const records: MutationRecord[] = [];
  const said = new MutationObserver((batch) => {
    records.push(...batch);
  });
  said.observe(alert, { subtree: true, childList: true, characterData: true });
  const before = reads();

  fireEvent.click(button);
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(button.textContent).toBe('Trying again…');
  expect(alert.textContent).not.toContain(FAILED);
  expect(screen.queryByText(/^Loading /u)).toBeNull();
  // A press while it re-reads asks nothing more.
  fireEvent.click(button);

  // The second failure, in the same words: the same alert says them again.
  await waitFor(() => {
    expect(alert.textContent).toContain(FAILED);
  });
  expect(reads()).toBe(before + 1);
  expect(alert.isConnected).toBe(true);
  expect(within(alert).getByRole('button', { name: 'Try again' })).toBe(button);
  expect(button.getAttribute('aria-disabled')).toBe('false');
  expect(document.activeElement).toBe(button);
  await waitFor(() => {
    expect(added(records, alert, FAILED)).toBe(true);
  });
  said.disconnect();

  // And one that succeeds takes the panel away, and focus goes to the heading (or nearer).
  fireEvent.click(button);
  expect(document.activeElement).toBe(button);
  await waitFor(() => {
    expect(answered()).toBeDefined();
  });
  expect(alert.isConnected).toBe(false);
  await waitFor(() => {
    const target =
      landsOn === undefined ? screen.getByRole('heading', { level: 1, name: heading }) : landsOn();
    expect(target).not.toBeNull();
    expect(document.activeElement).toBe(target);
  });
  expect(focus.lost()).toBe(0);
  focus.stop();
}
