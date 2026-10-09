import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryRun, ObjectSummary } from '../src/api/types';
import { DiscoveryView } from '../src/routes/DiscoveryView';
import { SAY_AGAIN_MS } from '../src/components/refusal';
import { alertSaying, expectCorrelation, expectQuiet, speaking } from './support/refusal-region';

/**
 * The discovery page's three refusals, announced (`U-54`).
 *
 * A range the core will not sweep, a start it refuses and a cancel it refuses each come back
 * after the operator acted, with focus where they acted, so a live region is the only thing that
 * says so. Each is in the tree and empty before — a region added with its text already in it is
 * not reliably announced (`U-41`) — the refusal lands in that same node, the next attempt empties
 * it as it starts so the same words are said again, and one that is accepted leaves it empty.
 */

const object = (
  id: number,
  parentId: number | null,
  kind: 'probe' | 'group',
  name: string,
): ObjectSummary => ({
  id,
  parentId,
  kind,
  name,
  tags: [],
  priority: 3,
  version: 1,
  hasChildren: false,
});

const TOO_BIG = 'that is 16,777,214 addresses and one run may sweep 65,536';
const NO_START = 'a discovery is already running into this group';
const NO_CANCEL = 'the run has already finished';

const RUN: DiscoveryRun = {
  id: 7,
  groupId: 20,
  probeId: 10,
  range: '10.0.0.0/29',
  total: 6,
  cursor: 0,
  found: 0,
  failed: 0,
  // Queued: Cancel is offered, and the next read is five seconds away, past every case here.
  status: 'queued',
  level: 'ping',
  templates: [],
  identified: 0,
  identifyCursor: 0,
  scheduleId: null,
  snmpCommunity: '',
  devicesCreated: 0,
  devicesMatched: 0,
  sensorsCreated: 0,
  provisionedAt: null,
  message: '',
  timeoutMs: 1_000,
  concurrency: 32,
  ratePerSecond: 0,
  createdAt: '2026-10-09T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
};

/**
 * A refusal the core sends — with its correlation id when `id` is given — `null` for an attempt
 * it accepts, or `'unreachable'` for a core that never answered.
 */
type Answer =
  | { readonly status: number; readonly message: string; readonly id?: string }
  | null
  | 'unreachable';

/** Ranges the core will not sweep, all in `TOO_BIG`'s words; only the last with an id. */
const REFUSED_RANGES: Readonly<Record<string, string | undefined>> = {
  '10.0.0.0/8': undefined,
  '10.0.0.0/7': undefined,
  '10.0.0.0/6': 'req-range',
};

/**
 * A response read in promises alone, for the preview: a real `Response` reads its body through a
 * stream, which the fake-timer case below cannot count turns of.
 */
const answered = (status: number, data: unknown): Promise<Response> =>
  Promise.resolve({
    ok: status < 300,
    status,
    statusText: '',
    json: () => Promise.resolve(data),
  } as Response);

function core({
  starts = [],
  cancels = [],
  reads = [],
}: {
  starts?: Answer[];
  cancels?: Answer[];
  /** The run's reads in turn, each held until its promise settles; read as it is once spent. */
  reads?: Promise<Answer>[];
}): void {
  const reply = (status: number, data: unknown): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const said = (next: Answer, accepted: unknown): Promise<Response> => {
    if (next === 'unreachable') return Promise.reject(new TypeError('Failed to fetch'));
    return next === null
      ? reply(200, accepted)
      : reply(next.status, {
          error: {
            code: 'DISCOVERY_REFUSED',
            message: next.message,
            ...(next.id === undefined ? {} : { correlationId: next.id }),
          },
        });
  };
  const answer = (queue: Answer[], accepted: unknown): Promise<Response> =>
    said(queue.shift() ?? null, accepted);
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const path = url.replace(/^.*\/api\/v1/u, '');
    const method = init?.method ?? 'GET';
    if (method === 'POST' && path === '/discovery/preview') {
      const { range } =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as { range: string })
          : { range: '' };
      return range in REFUSED_RANGES
        ? answered(400, {
            error: {
              code: 'DISCOVERY_RANGE_INVALID',
              message: TOO_BIG,
              ...(REFUSED_RANGES[range] === undefined
                ? {}
                : { correlationId: REFUSED_RANGES[range] }),
            },
          })
        : answered(200, {
            range,
            total: 6,
            levels: [
              { id: 'ping', name: 'Ping', description: '', minSeconds: 1, maxSeconds: 2, ports: 0 },
            ],
          });
    }
    if (method === 'POST' && path === '/discovery') return answer(starts, RUN);
    if (method === 'POST' && path === '/discovery/7/cancel') return answer(cancels, RUN);
    if (path.startsWith('/objects?kind=probe')) {
      return reply(200, { items: [object(10, 1, 'probe', 'probe-a')] });
    }
    if (path.startsWith('/objects?kind=group')) {
      return reply(200, { items: [object(20, 10, 'group', 'Datacentre')] });
    }
    if (path === '/discovery/7') {
      const next = reads.shift();
      return next === undefined ? reply(200, RUN) : next.then((one) => said(one, RUN));
    }
    if (path.startsWith('/objects/20/discovery')) return reply(200, { items: [] });
    if (path === '/device-templates' || path === '/discovery/schedules' || path === '/schedules') {
      return reply(200, { items: [] });
    }
    throw new Error(`no stub for ${method} ${path}`);
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function open(): Promise<HTMLElement> {
  render(
    <MemoryRouter initialEntries={['/discovery']}>
      <DiscoveryView />
    </MemoryRouter>,
  );
  const heading = await screen.findByRole('heading', { name: 'Scan a range' });
  const card = heading.closest('section');
  if (card === null) throw new Error('no card for Scan a range');
  return card;
}

const range = (card: HTMLElement): HTMLInputElement =>
  within(card).getByLabelText<HTMLInputElement>('Range');
const rangeProblem = (): HTMLElement => {
  const found = document.getElementById('range-problem');
  if (found === null) throw new Error('no range problem region');
  return found;
};
/** The card's alert that is not the range's. */
const startRegion = (card: HTMLElement): HTMLElement => {
  const found = within(card)
    .getAllByRole('alert')
    .find((one) => one.id !== 'range-problem');
  if (found === undefined) throw new Error('no start region');
  return found;
};

/** The form filled in with a range the core accepts, once Start is offered. */
async function ready(card: HTMLElement): Promise<HTMLButtonElement> {
  fireEvent.change(within(card).getByLabelText('Probe'), { target: { value: '10' } });
  fireEvent.change(within(card).getByLabelText('Group'), { target: { value: '20' } });
  fireEvent.change(range(card), { target: { value: '10.0.0.0/29' } });
  const start = within(card).getByRole<HTMLButtonElement>('button', { name: 'Start discovery' });
  await waitFor(
    () => {
      expect(start.disabled).toBe(false);
    },
    { timeout: 3_000 },
  );
  return start;
}

describe('a range the core will not sweep (U-54)', () => {
  it('is said in the region that was there before, and emptied by one it accepts', async () => {
    core({});
    const card = await open();
    const region = rangeProblem();
    expectQuiet(region, ['mt-2', 'empty:mt-0'], 'polite');
    expect(range(card).getAttribute('aria-describedby') ?? '').not.toContain('range-problem');

    fireEvent.change(range(card), { target: { value: '10.0.0.0/8' } });
    await waitFor(
      () => {
        expect(region.textContent).toBe(TOO_BIG);
      },
      { timeout: 3_000 },
    );
    expect(rangeProblem()).toBe(region);
    // Named by the box while it says something, and the box marked.
    expect(range(card).getAttribute('aria-describedby')).toContain('range-problem');
    expect(range(card).getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(range(card), { target: { value: '10.0.0.0/29' } });
    await waitFor(
      () => {
        expect(region.matches(':empty')).toBe(true);
      },
      { timeout: 3_000 },
    );
    expect(rangeProblem()).toBe(region);
    expect(range(card).getAttribute('aria-describedby') ?? '').not.toContain('range-problem');
  });
});

/** Lets the event loop turn until `done`, at most `turns` times, inside `act`. */
async function turnUntil(done: () => boolean, what: string, turns = 200): Promise<void> {
  for (let turn = 0; turn < turns && !done(); turn += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    });
  }
  if (!done()) throw new Error(`${what} within ${String(turns)} turns`);
}

/**
 * A range refusal, polite and said again (`U-57`).
 *
 * The region answers the range as it is typed, so it waits its turn rather than cutting into the
 * operator's typing (`U-48`). Each answer is about a different range, so a second range refused in
 * the same words is a new refusal — but React would leave the same text alone, and a live region
 * that does not change says nothing. What is relied on is that the region is emptied as the answer
 * arrives and filled `SAY_AGAIN_MS` later, so it is seen empty in between however fast the core
 * answered.
 */
describe('a range refused in the same words as the last (U-57)', () => {
  it('is emptied as the answer arrives and said again a moment later, in the same node', async () => {
    core({});
    const card = await open();
    const region = rangeProblem();
    fireEvent.change(range(card), { target: { value: '10.0.0.0/8' } });
    await waitFor(
      () => {
        expect(region.textContent).toBe(TOO_BIG);
      },
      { timeout: 3_000 },
    );

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.change(range(card), { target: { value: '10.0.0.0/7' } });
      // Typed, not yet asked about: the last range's refusal stands until the next is answered.
      expect(region.textContent).toBe(TOO_BIG);

      // The debounce runs out, the core answers, and the region is emptied.
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      await turnUntil(() => region.matches(':empty'), 'the region was not emptied');
      act(() => {
        vi.advanceTimersByTime(SAY_AGAIN_MS - 1);
      });
      expect(region.matches(':empty')).toBe(true);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(region.textContent).toBe(TOO_BIG);
      expect(rangeProblem()).toBe(region);
      expect(region.getAttribute('aria-live')).toBe('polite');
      expect(region.getAttribute('role')).toBeNull();
      expectCorrelation(region, undefined);

      // A refusal the core gave an id says it, after the same words.
      fireEvent.change(range(card), { target: { value: '10.0.0.0/6' } });
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      await turnUntil(() => region.matches(':empty'), 'the region was not emptied');
      act(() => {
        vi.advanceTimersByTime(SAY_AGAIN_MS);
      });
      expect(region.textContent).toBe(`${TOO_BIG} req-range`);
      expectCorrelation(region, 'req-range');
      expect(rangeProblem()).toBe(region);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a start the core refused (U-54)', () => {
  it('is said in the region that was there before, again in the same words, and emptied by one accepted', async () => {
    core({
      starts: [
        { status: 409, message: NO_START, id: 'req-start' },
        { status: 409, message: NO_START },
        null,
      ],
    });
    const card = await open();
    const region = startRegion(card);
    expectQuiet(region, ['mt-4', 'empty:mt-0']);
    const start = await ready(card);

    fireEvent.click(start);
    expect(await alertSaying(NO_START)).toBe(region);
    expect(region.textContent).toBe(`${NO_START} req-start`);
    expectCorrelation(region, 'req-start');
    await waitFor(() => {
      expect(start.disabled).toBe(false);
    });

    fireEvent.click(start);
    // Committed empty before the core answers: React did not fold the two into one.
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(region.textContent).toBe(NO_START);
    });
    // The core gave this one no id, and none is shown.
    expectCorrelation(region, undefined);
    expect(startRegion(card)).toBe(region);
    await waitFor(() => {
      expect(start.disabled).toBe(false);
    });

    fireEvent.click(start);
    expect(region.matches(':empty')).toBe(true);
    await screen.findByRole('heading', { name: 'Run 7 — 10.0.0.0/29' });
    expect(region.matches(':empty')).toBe(true);
    expect(startRegion(card)).toBe(region);
  });
});

describe('a cancel the core refused (U-54)', () => {
  it('is said in the run’s region, again in the same words, and emptied by one accepted', async () => {
    core({
      cancels: [
        { status: 409, message: NO_CANCEL, id: 'req-cancel' },
        { status: 409, message: NO_CANCEL },
      ],
    });
    const card = await open();
    fireEvent.click(await ready(card));
    const heading = await screen.findByRole('heading', { name: 'Run 7 — 10.0.0.0/29' });
    const panel = heading.closest('section');
    if (panel === null) throw new Error('no run card');
    const region = within(panel).getByRole('alert');
    expectQuiet(region, ['mt-3', 'empty:mt-0']);
    const cancel = (): void => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    };

    cancel();
    expect(await alertSaying(NO_CANCEL)).toBe(region);
    expect(region.textContent).toBe(`${NO_CANCEL} req-cancel`);
    expectCorrelation(region, 'req-cancel');
    await within(panel).findByRole('button', { name: 'Cancel' });

    cancel();
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(region.textContent).toBe(NO_CANCEL);
    });
    expectCorrelation(region, undefined);
    expect(within(panel).getByRole('alert')).toBe(region);
    await within(panel).findByRole('button', { name: 'Cancel' });

    cancel();
    expect(region.matches(':empty')).toBe(true);
    await within(panel).findByRole('button', { name: 'Cancel' });
    expect(region.matches(':empty')).toBe(true);
  });
});

/**
 * The run card's two regions (`U-64`).
 *
 * A refused cancel and a failed poll shared one alert, so the next good poll emptied a refusal
 * the operator may not have heard yet, and a poll failure was assertive where the first read's is
 * polite. The cancel has its own alert, emptied only by the next cancel; the polls have their own
 * polite region, emptied by a read that succeeds, and a poll failing again in the same words keeps
 * the one shown (`U-59`). Under fake timers, so the polls come when the test says.
 */
describe('the run card’s refused cancel and its polls (U-64)', () => {
  /** The run's card, once its first read has been answered. */
  async function watching(start: HTMLButtonElement): Promise<{
    panel: HTMLElement;
    refusal: HTMLElement;
    polls: HTMLElement;
  }> {
    fireEvent.click(start);
    await turnUntil(
      () => screen.queryByRole('heading', { name: 'Run 7 — 10.0.0.0/29' }) !== null,
      'the run was not shown',
    );
    const panel = screen.getByRole('heading', { name: 'Run 7 — 10.0.0.0/29' }).closest('section');
    if (panel === null) throw new Error('no run card');
    const refusal = within(panel).getByRole('alert');
    const polls = within(panel).getByRole('status');
    expectQuiet(refusal, ['mt-3', 'empty:mt-0']);
    expectQuiet(polls, ['mt-3', 'empty:mt-0'], 'polite');
    return { panel, refusal, polls };
  }

  /** Five seconds on, until the read it sends has been answered and the next one is due. */
  async function nextPoll(reads: readonly unknown[], left: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await turnUntil(
      () => reads.length === left && vi.getTimerCount() === 1,
      `the poll leaving ${String(left)} reads was not answered`,
    );
  }

  it('keeps a refused cancel through the good poll that follows it', async () => {
    const reads = [Promise.resolve<Answer>(null), Promise.resolve<Answer>(null)];
    core({ cancels: [{ status: 409, message: NO_CANCEL, id: 'req-cancel' }], reads });
    const card = await open();
    const start = await ready(card);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { panel, refusal, polls } = await watching(start);
      fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
      await turnUntil(() => refusal.textContent !== '', 'the refusal was not said');
      expect(refusal.textContent).toBe(`${NO_CANCEL} req-cancel`);
      expectCorrelation(refusal, 'req-cancel');

      // The run is read again, and read well: the refusal stands, in the same node.
      await nextPoll(reads, 0);
      expect(refusal.textContent).toBe(`${NO_CANCEL} req-cancel`);
      expect(within(panel).getByRole('alert')).toBe(refusal);
      expect(polls.matches(':empty')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says a failed poll politely, once for the same words, and empties it on a good one', async () => {
    const reads = [
      Promise.resolve<Answer>(null),
      Promise.resolve<Answer>({ status: 503, message: 'the core is busy', id: 'req-poll' }),
      Promise.resolve<Answer>({ status: 503, message: 'the core is busy', id: 'req-poll-2' }),
      Promise.resolve<Answer>(null),
    ];
    core({ reads });
    const card = await open();
    const start = await ready(card);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { panel, refusal, polls } = await watching(start);

      await nextPoll(reads, 2);
      expect(polls.textContent).toBe('the core is busy req-poll');
      expectCorrelation(polls, 'req-poll');
      // Not an alert: nothing the operator asked for was refused.
      expect(speaking()).toEqual([]);
      expect(refusal.matches(':empty')).toBe(true);

      // Failing again in the same words, with the core's next id: what is shown stays.
      await nextPoll(reads, 1);
      expect(polls.textContent).toBe('the core is busy req-poll');

      // Read well: emptied, in the same node.
      await nextPoll(reads, 0);
      expect(polls.matches(':empty')).toBe(true);
      expect(within(panel).getByRole('status')).toBe(polls);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The run's first read failing (`U-56`).
 *
 * The card is drawn as the run is started and reads it at once; until that read succeeds there is
 * no run to show, and a failure was plain text in place of *Loading the run…*. It is said in a
 * region that was there, empty, before the read went out — polite, as the loading status it takes
 * the place of: the start was accepted and nothing the operator asked for was refused, and the
 * card asks again by itself. The core's id is shown when it answered, and a read that succeeds
 * replaces the card with the run's, which says nothing.
 */
describe('a run whose first read failed (U-56)', () => {
  it('is said politely in the region that was there before, with the id when the core answered', async () => {
    let unreachable: () => void = () => undefined;
    const held = new Promise<Answer>((resolve) => {
      unreachable = () => {
        resolve('unreachable');
      };
    });
    const reads = [
      held,
      Promise.resolve<Answer>({ status: 404, message: 'no such run', id: 'req-read' }),
      Promise.resolve<Answer>({ status: 404, message: 'no such run', id: 'req-read-again' }),
    ];
    core({ reads });
    const card = await open();
    const start = await ready(card);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(start);
      const runCard = (): HTMLElement | null =>
        screen.queryByRole('heading', { name: 'Run' })?.closest('section') ?? null;
      await turnUntil(() => runCard() !== null, 'the run card was not drawn');
      const panel = runCard();
      if (panel === null) throw new Error('no run card');
      const region = within(panel)
        .getAllByRole('status')
        .find((one) => !one.textContent.startsWith('Loading'));
      if (region === undefined) throw new Error('no first-read region');
      expectQuiet(region, [], 'polite');
      expect(within(panel).getByText('Loading the run…')).toBeDefined();

      // The core is not reached: said, with no id, in that node, and the loading line gone.
      unreachable();
      await turnUntil(() => region.textContent !== '', 'the failure was not said');
      expect(region.textContent).toBe('the core is not reachable');
      expectCorrelation(region, undefined);
      expect(within(panel).queryByText('Loading the run…')).toBeNull();
      expect(speaking()).toEqual([]);

      // Asked again five seconds on, and refused by the core: its id is said with it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      await turnUntil(
        () => region.textContent.startsWith('no such run'),
        'the refusal was not said',
      );
      expect(region.textContent).toBe('no such run req-read');
      expectCorrelation(region, 'req-read');

      // Refused again in the same words, with the core's next id: what is shown stays, so the
      // same failure is not said again every five seconds. The next read being scheduled is the
      // sign this answer was taken: it is the only timer there is.
      expect(vi.getTimerCount()).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      await turnUntil(
        () => reads.length === 0 && vi.getTimerCount() === 1,
        'the third read was not answered',
      );
      expect(region.textContent).toBe('no such run req-read');

      // Read at last: the run's own card, whose region says nothing.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      await turnUntil(
        () => screen.queryByRole('heading', { name: 'Run 7 — 10.0.0.0/29' }) !== null,
        'the run was not shown',
      );
      expect(screen.queryByRole('heading', { name: 'Run' })).toBeNull();
      expect(speaking()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
