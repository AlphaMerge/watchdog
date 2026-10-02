import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Alarm, AlarmPage } from '../src/api/types';
import { AlarmsView } from '../src/routes/AlarmsView';

const LIST = '/api/v1/alarms?limit=200&sort=priority';

/** Answers the list from `page`, and records every time it is asked. */
function stubList(page: () => AlarmPage): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    asked.push(url);
    if (url !== LIST) return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify(page()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return asked;
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

function row(sensorId: number, name: string, overrides: Partial<Alarm>): Alarm {
  return {
    sensorId,
    sensorName: name,
    state: 'down',
    cause: 'scan',
    message: '',
    since: '2026-09-29T11:50:00.000Z',
    priority: 3,
    path: [1, 2, 7, sensorId],
    pathNames: ['Root', 'probe-1', 'probe-box', name],
    acknowledged: false,
    acknowledgedUntil: null,
    consecutiveFailures: 2,
    recovering: null,
    ...overrides,
  };
}

/**
 * A held return on the alarms list (`M-18`), as an operator sees it.
 *
 * The rest of the list is `alarms-view.test.ts`'s and the core's; this is the row the hold adds,
 * and the one reload no state frame prompts.
 */
describe('a held return on the alarms list', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('WebSocket', QuietSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows it as Recovering, with when it is over, below a Down and without an acknowledge', async () => {
    const now = new Date().toISOString();
    const confirmsAt = new Date(Date.now() + 240_000).toISOString();
    stubList(() => ({
      items: [
        row(10, 'Ping', {}),
        row(11, 'Probe Health', {
          state: 'up',
          priority: 5,
          recovering: { since: now, confirmsAt },
        }),
      ],
      total: 2,
      counts: { down: 1, recovering: 1 },
      now,
    }));
    render(
      <MemoryRouter>
        <AlarmsView />
      </MemoryRouter>,
    );

    const held = (await screen.findByText('Probe Health')).closest('li');
    expect(held).not.toBeNull();
    if (held === null) return;
    const inRow = within(held);
    expect(inRow.getByText('Recovering')).toBeDefined();
    expect(inRow.getByText(/^Back since .*; over at .* unless it fails again$/)).toBeDefined();
    // Nothing is Down to acknowledge: the sensor is back.
    expect(inRow.queryByRole('button', { name: 'Acknowledge' })).toBeNull();

    const down = screen.getByText('Ping').closest('li');
    expect(down).not.toBeNull();
    if (down === null) return;
    expect(within(down).getByRole('button', { name: 'Acknowledge' })).toBeDefined();

    const chip = within(screen.getByRole('group', { name: 'Severity' }))
      .getByText('Recovering')
      .closest('button');
    expect(chip?.textContent).toContain('1');
  });

  it('asks again when the hold ends, with no state frame to prompt it', async () => {
    // The core holds the return for a second and a half, and answers as the core would: held
    // until then, and gone after. The socket stays silent, so what takes the row away is the
    // list's own timer.
    const since = new Date().toISOString();
    const end = Date.now() + 1_500;
    const confirmsAt = new Date(end).toISOString();
    const times: number[] = [];
    const asked = stubList(() => {
      const now = Date.now();
      times.push(now);
      return now < end
        ? {
            items: [row(11, 'Probe Health', { state: 'up', recovering: { since, confirmsAt } })],
            total: 1,
            counts: { recovering: 1 },
            now: new Date(now).toISOString(),
          }
        : { items: [], total: 0, counts: {}, now: new Date(now).toISOString() };
    });
    render(
      <MemoryRouter>
        <AlarmsView />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Probe Health')).toBeDefined();
    await waitFor(
      () => {
        expect(screen.getByText('Nothing is in an alarm state.')).toBeDefined();
      },
      { timeout: 5_000 },
    );
    const last = times[times.length - 1] ?? 0;
    expect(last).toBeGreaterThanOrEqual(end);
    expect(last).toBeLessThan(end + 1_000 + 500);
    // Asked on mount and once at the end: never in a loop, and not again for the stream's own
    // subscribe (`U-22`).
    expect(asked.length).toBe(2);
    expect(asked.every((url) => url === LIST)).toBe(true);
  });
});
