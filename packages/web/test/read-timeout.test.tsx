import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  READ_TIMEOUT_MS,
  request,
  sameWords,
  setReadTimeout,
  useApi,
} from '../src/api/client';
import { ErrorPanel } from '../src/components/Panels';

/**
 * A read the core never answers is given up (`U-77`).
 *
 * `fetch` has no timeout, so a read that hung held its caller for ever: *Loading…* up for good, a
 * *Try again* busy for good. `request` now gives a read `READ_TIMEOUT_MS` — headers and body — and
 * says `NO_ANSWER`, naming what was asked. The bound is shortened here, so nothing waits half a
 * minute; the timers are real.
 */

const BOUND_MS = 60;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A `fetch` that never answers, and gives up only when its signal is aborted. */
const hangs = (_url: string, init?: RequestInit): Promise<Response> =>
  new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    });
  });

/** Waits past the bound, in real time. */
const pastTheBound = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, BOUND_MS * 3));

let restore: () => void = () => undefined;
beforeEach(() => {
  restore = setReadTimeout(BOUND_MS);
});
afterEach(() => {
  restore();
  vi.unstubAllGlobals();
});

describe('request', () => {
  it('is half a minute when nothing shortens it', () => {
    restore();
    expect(READ_TIMEOUT_MS).toBe(30_000);
  });

  it('gives up a read that never answers, and says what was asked', async () => {
    vi.stubGlobal('fetch', vi.fn(hangs));
    const failed = await request('/sensors/9/values').catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ApiError);
    expect(failed).toMatchObject({
      status: 0,
      code: 'NO_ANSWER',
      message: `the core did not answer GET /sensors/9/values within ${String(BOUND_MS)} ms`,
    });
  });

  it('aborts the fetch it gave up', async () => {
    let seen: AbortSignal | undefined;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return hangs(url, init);
    });
    await request('/x').catch(() => undefined);
    expect(seen?.aborted).toBe(true);
  });

  it('gives up even a fetch that does not honour its signal', async () => {
    vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined));
    await expect(request('/x')).rejects.toMatchObject({ code: 'NO_ANSWER' });
  });

  it('bounds the body as well as the headers', async () => {
    // The status line came; the body never does.
    const stalled = { ok: true, status: 200, json: () => new Promise(() => undefined) };
    vi.stubGlobal('fetch', () => Promise.resolve(stalled as unknown as Response));
    await expect(request('/x')).rejects.toMatchObject({ code: 'NO_ANSWER' });
  });

  it('answers as before inside the bound, and nothing fires after it', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(json({ items: [1] })));
    await expect(request('/x')).resolves.toEqual({ items: [1] });
    // An unhandled rejection from a timer left running would fail this file.
    await pastTheBound();
  });

  it('passes a refusal through as before', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(json({ error: { code: 'NOT_FOUND', message: 'no such sensor' } }, 404)),
    );
    await expect(request('/x')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('reports a caller’s own abort as before, not as a read that was not answered', async () => {
    vi.stubGlobal('fetch', vi.fn(hangs));
    const controller = new AbortController();
    const asked = request('/x', controller.signal).catch((error: unknown) => error);
    controller.abort();
    expect(await asked).toMatchObject({ code: 'UNREACHABLE' });
    await pastTheBound();
  });
});

/** A page that is only a read and its error panel, as most pages are while one fails. */
function Page(): React.JSX.Element {
  const read = useApi<{ name: string }>('/thing');
  if (read.status === 'error') return <ErrorPanel error={read.error} retry={read.retry} />;
  if (read.status === 'loading') return <p>Loading…</p>;
  return <p>{read.data.name}</p>;
}

describe('Try again', () => {
  it('is free again once its read has gone unanswered, says so, and asks again when pressed', async () => {
    let asked = 0;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      asked += 1;
      // Refused, then a read that hangs, then an answer.
      if (asked === 1) {
        return Promise.resolve(
          json({ error: { code: 'UNAVAILABLE', message: 'restarting' } }, 503),
        );
      }
      if (asked === 2) return hangs(url, init);
      return Promise.resolve(json({ name: 'Ping' }));
    });
    render(<Page />);
    const button = await screen.findByRole('button', { name: 'Try again' });
    act(() => {
      button.focus();
    });
    fireEvent.click(button);
    expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Trying again…' })).toBe(
      button,
    );

    // Given up: the panel says the core did not answer, and the same button is free and focused.
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('The core did not answer');
    });
    expect(screen.getByRole('alert').textContent).toContain(
      `the core did not answer GET /thing within ${String(BOUND_MS)} ms`,
    );
    expect(screen.getByRole('alert').textContent).not.toContain('not reachable');
    expect(button.textContent).toBe('Try again');
    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    await screen.findByText('Ping');
    expect(asked).toBe(3);
  });
});

describe('sameWords (U-59, shared since U-78)', () => {
  const said = (code: string, message: string, id: string): ApiError =>
    new ApiError(0, code, message, id);

  it('is the same failure whatever its correlation id', () => {
    expect(
      sameWords(said('UNREACHABLE', 'gone', 'req-1'), said('UNREACHABLE', 'gone', 'req-2')),
    ).toBe(true);
  });

  it('is not, in other words or under another code, whose panel is headed otherwise', () => {
    expect(sameWords(said('UNREACHABLE', 'gone', 'a'), said('UNREACHABLE', 'went', 'a'))).toBe(
      false,
    );
    expect(sameWords(said('UNREACHABLE', 'gone', 'a'), said('NO_ANSWER', 'gone', 'a'))).toBe(false);
  });
});
