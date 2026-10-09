import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Alarm, AlarmPage } from '../src/api/types';
import { AlarmsView } from '../src/routes/AlarmsView';
import { alertSaying, expectCorrelation, expectQuiet, speaking } from './support/refusal-region';

/**
 * A refused action on an alarm's row, announced (`U-56`).
 *
 * Acknowledge, un-acknowledge and pause are answered a round trip after the click, with focus on
 * the row's button, so a live region is the only thing that says the core refused. It is in the
 * row and empty before anything is sent — one added with its text already in it is not reliably
 * announced (`U-41`) — the refusal lands in that same node with the core's correlation id, the
 * next attempt empties it as it starts so the same words are said again, and one accepted leaves
 * it empty.
 */

const LIST = '/api/v1/alarms?limit=200&sort=priority';
const ACK = '/api/v1/objects/10/acknowledge';
const REFUSED = 'the sensor is no longer in an alarm state';

const ROW: Alarm = {
  sensorId: 10,
  sensorName: 'Ping',
  state: 'down',
  cause: 'scan',
  message: '',
  since: '2026-10-09T11:50:00.000Z',
  priority: 3,
  path: [1, 2, 7, 10],
  pathNames: ['Root', 'probe-1', 'probe-box', 'Ping'],
  acknowledged: false,
  acknowledgedUntil: null,
  consecutiveFailures: 2,
  recovering: null,
};

const PAGE: AlarmPage = {
  items: [ROW],
  total: 1,
  counts: { down: 1 },
  now: '2026-10-09T12:00:00.000Z',
};

/** How the core answers an acknowledge: refused with or without an id, accepted, or never. */
type Answer = { readonly id?: string } | 'accepted' | 'unreachable';

function core(answers: Answer[]): void {
  const reply = (status: number, data: unknown): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url === LIST) return reply(200, PAGE);
    if (method === 'POST' && url === ACK) {
      const next = answers.shift() ?? 'accepted';
      if (next === 'unreachable') return Promise.reject(new TypeError('Failed to fetch'));
      if (next === 'accepted') return reply(200, {});
      return reply(409, {
        error: {
          code: 'NOT_IN_ALARM',
          message: REFUSED,
          ...(next.id === undefined ? {} : { correlationId: next.id }),
        },
      });
    }
    throw new Error(`no stub for ${method} ${url}`);
  });
}

/** A socket that never opens: no state frame arrives, so any reload is the list's own. */
class QuietSocket {
  onopen = null;
  onclose = null;
  onerror = null;
  onmessage = null;
  send(): void {}
  close(): void {}
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('WebSocket', QuietSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function open(): Promise<{ row: HTMLElement; region: HTMLElement }> {
  render(
    <MemoryRouter>
      <AlarmsView />
    </MemoryRouter>,
  );
  const row = (await screen.findByText('Ping')).closest('li');
  if (row === null) throw new Error('no row for Ping');
  return { row, region: within(row).getByRole('alert') };
}

const acknowledge = async (row: HTMLElement): Promise<void> => {
  const button = within(row).getByRole<HTMLButtonElement>('button', { name: 'Acknowledge' });
  await waitFor(() => {
    expect(button.disabled).toBe(false);
  });
  fireEvent.click(button);
};

describe('a refused action on an alarm (U-56)', () => {
  it('is said in the row’s region with its id, again in the same words, and emptied by one accepted', async () => {
    core([{ id: 'req-56' }, { id: 'req-56b' }, 'accepted']);
    const { row, region } = await open();
    expectQuiet(region, ['mt-1', 'empty:mt-0']);

    await acknowledge(row);
    expect(await alertSaying(REFUSED)).toBe(region);
    expect(region.textContent).toBe(`${REFUSED} req-56`);
    expectCorrelation(region, 'req-56');

    await acknowledge(row);
    // Committed empty before the core answers: React did not fold the two into one.
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(region.textContent).toBe(`${REFUSED} req-56b`);
    });
    expect(within(row).getByRole('alert')).toBe(region);

    await acknowledge(row);
    expect(region.matches(':empty')).toBe(true);
    // Accepted: the list is asked again, and the row says nothing.
    await waitFor(() => {
      expect(
        within(row).getByRole<HTMLButtonElement>('button', { name: 'Acknowledge' }).disabled,
      ).toBe(false);
    });
    expect(region.matches(':empty')).toBe(true);
    expect(speaking()).toEqual([]);
  });

  it('gives no id when the core never answered', async () => {
    core(['unreachable']);
    const { row, region } = await open();

    await acknowledge(row);
    expect(await alertSaying('the core is not reachable')).toBe(region);
    expect(region.textContent).toBe('the core is not reachable');
    expectCorrelation(region, undefined);
  });
});
