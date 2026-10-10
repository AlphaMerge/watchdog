import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { HeldListFailure, PLACED_MS } from '../src/components/HeldListFailure';

/**
 * A held list's failure region, coming onto the page with a failure already in hand (`U-78`).
 *
 * A region added with its text already in it is not reliably said (`U-41`). The sensor page's
 * readings can fail while the History tab is open, where nothing says so, and coming back to
 * Overview mounted the region with the failure in it. It now comes on empty and is filled
 * `PLACED_MS` later.
 */

const failure = new ApiError(503, 'UNAVAILABLE', 'restarting', 'req-78');

function Held({ error }: { error: ApiError | null }): React.JSX.Element {
  return (
    <HeldListFailure
      what="The list"
      error={error}
      reading={false}
      onRetry={() => undefined}
      focusAfter={() => undefined}
    />
  );
}

const region = (): HTMLElement => screen.getByRole('status');

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('HeldListFailure, mounted with a failure', () => {
  it('comes onto the page empty, and says the failure in the same region after', () => {
    render(<Held error={failure} />);
    const before = region();
    expect(before.textContent).toBe('');
    // *Try again* is there from the start: only the words wait.
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(PLACED_MS - 1);
    });
    expect(region().textContent).toBe('');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(region()).toBe(before);
    expect(region().textContent).toContain(
      'The list could not be read again, so this is the one read before and may be out of date: restarting',
    );
  });

  it('says a failure that comes after it is on the page at once', () => {
    const { rerender } = render(<Held error={null} />);
    act(() => {
      vi.advanceTimersByTime(PLACED_MS);
    });
    rerender(<Held error={failure} />);
    expect(region().textContent).toContain('restarting');
  });

  it('leaves nothing running when it goes before it has said anything', () => {
    const { unmount } = render(<Held error={failure} />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
