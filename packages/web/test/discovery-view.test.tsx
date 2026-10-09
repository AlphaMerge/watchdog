import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryRun, ObjectSummary } from '../src/api/types';
import { DiscoveryView } from '../src/routes/DiscoveryView';
import { alertSaying, expectQuiet } from './support/refusal-region';

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

/** A refusal the core sends, or `null` for an attempt it accepts. */
type Answer = { readonly status: number; readonly message: string } | null;

function core({ starts = [], cancels = [] }: { starts?: Answer[]; cancels?: Answer[] }): void {
  const reply = (status: number, data: unknown): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const answer = (queue: Answer[], accepted: unknown): Promise<Response> => {
    const next = queue.shift() ?? null;
    return next === null
      ? reply(200, accepted)
      : reply(next.status, { error: { code: 'DISCOVERY_REFUSED', message: next.message } });
  };
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const path = url.replace(/^.*\/api\/v1/u, '');
    const method = init?.method ?? 'GET';
    if (method === 'POST' && path === '/discovery/preview') {
      const { range } =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as { range: string })
          : { range: '' };
      return range === '10.0.0.0/8'
        ? reply(400, { error: { code: 'DISCOVERY_RANGE_INVALID', message: TOO_BIG } })
        : reply(200, {
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
    if (path === '/discovery/7') return reply(200, RUN);
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
    expectQuiet(region, ['mt-2', 'empty:mt-0']);
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

describe('a start the core refused (U-54)', () => {
  it('is said in the region that was there before, again in the same words, and emptied by one accepted', async () => {
    core({
      starts: [{ status: 409, message: NO_START }, { status: 409, message: NO_START }, null],
    });
    const card = await open();
    const region = startRegion(card);
    expectQuiet(region, ['mt-4', 'empty:mt-0']);
    const start = await ready(card);

    fireEvent.click(start);
    expect(await alertSaying(NO_START)).toBe(region);
    expect(region.textContent).toBe(NO_START);
    await waitFor(() => {
      expect(start.disabled).toBe(false);
    });

    fireEvent.click(start);
    // Committed empty before the core answers: React did not fold the two into one.
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(region.textContent).toBe(NO_START);
    });
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
        { status: 409, message: NO_CANCEL },
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
    await within(panel).findByRole('button', { name: 'Cancel' });

    cancel();
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(region.textContent).toBe(NO_CANCEL);
    });
    expect(within(panel).getByRole('alert')).toBe(region);
    await within(panel).findByRole('button', { name: 'Cancel' });

    cancel();
    expect(region.matches(':empty')).toBe(true);
    await within(panel).findByRole('button', { name: 'Cancel' });
    expect(region.matches(':empty')).toBe(true);
  });
});
