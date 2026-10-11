import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryRun, ObjectSummary } from '../src/api/types';
import { DiscoveryView } from '../src/routes/DiscoveryView';
import { PROBE_ABOVE_LABEL } from '../src/routes/discovery-model';

/**
 * A writer granted a branch below a probe they cannot see starts a discovery (`A-80`).
 *
 * The probe picker lists the probes the reader can see and the group list hangs off the one
 * chosen, so a group whose probe is outside their view could not be chosen at all, although the
 * core takes a run with no `probeId` for exactly this writer (`A-77`). The form now offers the
 * probe above the group, and sends no probe for it.
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

/** What the core answered a start with: the run, and no `probeId`, as it does for this reader. */
const STARTED = {
  id: 7,
  groupId: 20,
  range: '10.0.0.0/29',
  total: 6,
  cursor: 0,
  found: 0,
  failed: 0,
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
  createdAt: '2026-10-11T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
} satisfies DiscoveryRun;

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The core as this reader sees it: `probes` and `groups` are what the object list answers, and
 * every start's body is kept.
 */
function core(
  probes: ObjectSummary[],
  groups: ObjectSummary[],
): { starts: Record<string, unknown>[] } {
  const starts: Record<string, unknown>[] = [];
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
    const body = (): Record<string, unknown> =>
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (method === 'POST' && path === '/discovery/preview') {
      return reply(200, {
        range: body()['range'],
        total: 6,
        levels: [
          { id: 'ping', name: 'Ping', description: '', minSeconds: 1, maxSeconds: 2, ports: 0 },
        ],
      });
    }
    if (method === 'POST' && path === '/discovery') {
      starts.push(body());
      return reply(201, STARTED);
    }
    if (path.startsWith('/objects?kind=probe')) return reply(200, { items: probes });
    if (path.startsWith('/objects?kind=group')) return reply(200, { items: groups });
    if (path === '/discovery/7') return reply(200, STARTED);
    if (path.startsWith('/objects/20/discovery')) return reply(200, { items: [] });
    if (path === '/device-templates' || path === '/discovery/schedules' || path === '/schedules') {
      return reply(200, { items: [] });
    }
    throw new Error(`no stub for ${method} ${path}`);
  });
  return { starts };
}

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

const optionsOf = (select: HTMLElement): string[] =>
  within(select)
    .getAllByRole('option')
    .map((option) => option.textContent);

describe('a group under a probe its reader cannot see (A-80)', () => {
  it('is offered under the probe above it, and started with no probe named', async () => {
    // The probe (10) is not in the reader's list; their group (20) and one below it (21) are.
    const { starts } = core(
      [],
      [object(20, 10, 'group', 'Customer A'), object(21, 20, 'group', 'Customer A racks')],
    );
    const card = await open();
    const probe = within(card).getByLabelText('Probe');
    expect(optionsOf(probe)).toEqual(['Choose a probe…', PROBE_ABOVE_LABEL]);

    fireEvent.change(probe, { target: { value: 'above' } });
    const group = within(card).getByLabelText('Group');
    expect(optionsOf(group)).toEqual(['Choose a group…', 'Customer A', 'Customer A racks']);
    fireEvent.change(group, { target: { value: '20' } });
    fireEvent.change(within(card).getByLabelText('Range'), { target: { value: '10.0.0.0/29' } });

    const start = within(card).getByRole<HTMLButtonElement>('button', { name: 'Start discovery' });
    await waitFor(
      () => {
        expect(start.disabled).toBe(false);
      },
      { timeout: 3_000 },
    );
    fireEvent.click(start);
    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });
    expect(starts[0]?.['groupId']).toBe(20);
    expect(starts[0] !== undefined && 'probeId' in starts[0]).toBe(false);
  });

  it('is not offered to a reader who can see the probe of every group', async () => {
    const { starts } = core(
      [object(10, 1, 'probe', 'probe-a')],
      [object(20, 10, 'group', 'Datacentre'), object(21, 20, 'group', 'Row 1')],
    );
    const card = await open();
    expect(optionsOf(within(card).getByLabelText('Probe'))).toEqual(['Choose a probe…', 'probe-a']);
    expect(starts).toEqual([]);
  });
});
