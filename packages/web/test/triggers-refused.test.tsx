import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriggerView } from '../src/api/types';
import { TriggersPanel } from '../src/routes/detail/TriggersPanel';
import { alertSaying, expectCorrelation, expectQuiet } from './support/refusal-region';

/**
 * A refused trigger delete, announced (`U-56`).
 *
 * The refusal comes a round trip after *Yes, delete*, with focus on it, so a live region is the
 * only thing that says the trigger is still there. It is in the row and empty before anything is
 * sent (`U-41`), the refusal lands in that same node with the core's id, and the next attempt
 * empties it as it starts so the same words are said again.
 */

const TRIGGER: TriggerView = {
  id: 31,
  kind: 'state',
  kindName: 'State change',
  settings: {},
  enabled: true,
  summary: 'when it goes Down',
  inherited: false,
  definedOn: { objectId: 5, name: 'Datacentre' },
  createdAt: '2026-10-09T00:00:00.000Z',
  updatedAt: '2026-10-09T00:00:00.000Z',
};

const REFUSED = 'the trigger is being edited elsewhere';

/** Refusals for each delete in turn, with an id when given; `'unreachable'` never answers. */
type Answer = { readonly id?: string } | 'unreachable';

function core(deletes: Answer[]): { deleted: () => number } {
  let count = 0;
  const reply = (status: number, data: unknown): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const path = url.replace(/^.*\/api\/v1/u, '');
    const method = init?.method ?? 'GET';
    if (method === 'DELETE' && path === '/triggers/31') {
      count += 1;
      const next = deletes.shift();
      if (next === 'unreachable') return Promise.reject(new TypeError('Failed to fetch'));
      if (next === undefined) return Promise.resolve(new Response(null, { status: 204 }));
      return reply(409, {
        error: {
          code: 'CONFLICT',
          message: REFUSED,
          ...(next.id === undefined ? {} : { correlationId: next.id }),
        },
      });
    }
    if (path === '/objects/5/triggers') return reply(200, { objectId: 5, items: [TRIGGER] });
    if (path === '/trigger-kinds' || path === '/templates') return reply(200, { items: [] });
    throw new Error(`no stub for ${method} ${path}`);
  });
  return { deleted: () => count };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function open(): Promise<{ row: HTMLElement; region: HTMLElement }> {
  render(
    <MemoryRouter>
      <TriggersPanel objectId={5} inheritsTriggers />
    </MemoryRouter>,
  );
  const row = (await screen.findByText('when it goes Down')).closest('li');
  if (row === null) throw new Error('no row for the trigger');
  return { row, region: within(row).getByRole('alert') };
}

describe('a refused trigger delete (U-56)', () => {
  it('is said in the row’s region with its id, and again in the same words', async () => {
    const api = core([{ id: 'req-56' }, { id: 'req-56b' }]);
    const { row, region } = await open();
    expectQuiet(region, ['mt-1', 'empty:mt-0']);

    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(region.matches(':empty')).toBe(true);
    const yes = within(row).getByRole('button', { name: 'Yes, delete' });

    fireEvent.click(yes);
    expect(await alertSaying(REFUSED)).toBe(region);
    expect(region.textContent).toBe(`${REFUSED} req-56`);
    expectCorrelation(region, 'req-56');

    fireEvent.click(yes);
    // Committed empty before the core answers: React did not fold the two into one.
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(region.textContent).toBe(`${REFUSED} req-56b`);
    });
    expect(within(row).getByRole('alert')).toBe(region);
    expect(api.deleted()).toBe(2);
  });

  it('empties as an accepted delete starts, and gives no id when the core never answered', async () => {
    const api = core(['unreachable']);
    const { row, region } = await open();
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    const yes = within(row).getByRole('button', { name: 'Yes, delete' });

    fireEvent.click(yes);
    expect(await alertSaying('the core is not reachable')).toBe(region);
    expectCorrelation(region, undefined);

    // Accepted: emptied as it starts, and the list is read again.
    fireEvent.click(yes);
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(api.deleted()).toBe(2);
    });
    expect(region.matches(':empty')).toBe(true);
  });
});
