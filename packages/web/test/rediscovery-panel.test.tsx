import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObjectSummary, RediscoveryRule } from '../src/api/types';
import { RediscoveryPanel } from '../src/routes/RediscoveryPanel';
import { alertSaying, expectQuiet, speaking } from './support/refusal-region';

/**
 * The rediscovery rules on the discovery page, rendered (`D-11`).
 *
 * `rediscovery-model.test.ts` proves what the form would send; these prove it is sent — that a
 * new rule goes out with no switch in it, that an edit carries its version and only what changed,
 * and that a save refused because somebody else saved first says so and offers the rule as it is.
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

const PROBES = [object(10, 1, 'probe', 'probe-a'), object(11, 1, 'probe', 'probe-b')];
const GROUPS = [object(20, 10, 'group', 'Datacentre'), object(21, 11, 'group', 'Branch')];

const RULE: RediscoveryRule = {
  id: 5,
  groupId: 20,
  probeId: 10,
  name: 'Nightly',
  enabled: true,
  range: '10.0.0.0/29',
  level: 'standard',
  templates: [],
  timeoutMs: 1_000,
  concurrency: 32,
  ratePerSecond: 0,
  cadence: 'daily',
  cadenceMinute: 180,
  cadenceWeekday: 0,
  timezone: null,
  autoProvision: false,
  scheduleId: null,
  lastRunAt: null,
  lastRunId: null,
  lastProblem: '',
  nextRunAt: '2026-09-29T03:00:00.000Z',
  description: 'every day at 03:00',
  version: 3,
};

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

type Answer = { status: number; body: unknown };

/**
 * Answers by path; a write answers `answer` when given, so a refusal can be staged — or, given a
 * list, each write the next one, and accepted once the list is spent.
 */
function stubApi(rules: RediscoveryRule[], answer?: Answer | Answer[]): { calls: Call[] } {
  const calls: Call[] = [];
  const queue = Array.isArray(answer) ? [...answer] : undefined;
  vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const reply = (status: number, data: unknown): Promise<Response> =>
      Promise.resolve(
        new Response(status === 204 ? null : JSON.stringify(data), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (method !== 'GET') {
      const next = queue === undefined ? answer : queue.shift();
      const one = Array.isArray(next) ? undefined : next;
      return reply(one?.status ?? 200, one?.body ?? RULE);
    }
    if (path.endsWith('/discovery/schedules')) return reply(200, { items: rules });
    if (path.endsWith('/schedules'))
      return reply(200, { items: [{ id: 2, name: 'Change freeze', description: '' }] });
    throw new Error(`no stub for ${method} ${path}`);
  });
  return { calls };
}

const show = async (rules: RediscoveryRule[], answer?: Answer | Answer[]) => {
  const api = stubApi(rules, answer);
  render(<RediscoveryPanel probes={PROBES} groups={GROUPS} templates={[]} />);
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'New rule' })).toBeDefined();
  });
  return api;
};

const writes = (calls: Call[]): Call[] => calls.filter((call) => call.method !== 'GET');

describe('the rediscovery rules', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists each rule with where it goes, when it runs, and whether it creates anything', async () => {
    await show([RULE]);
    const list = screen.getByRole('list', { name: 'Rediscovery rules' });
    expect(within(list).getByRole('heading', { name: 'Nightly' })).toBeDefined();
    expect(
      within(list).getByText(/10\.0\.0\.0\/29, every day at 03:00, into Datacentre, from probe-a/u),
    ).toBeDefined();
    expect(within(list).getByText(/creates nothing/u)).toBeDefined();
  });

  it('says a rule was refused when it last fired, where somebody looks', async () => {
    await show([{ ...RULE, lastProblem: 'a discovery runs from the probe its group is under' }]);
    expect(
      screen.getByText(/did not start: a discovery runs from the probe its group is under/u),
    ).toBeDefined();
  });

  it('says so when there are none', async () => {
    await show([]);
    expect(screen.getByText('No rules.')).toBeDefined();
  });

  it('creates a rule off, with nothing in the request that would switch it on', async () => {
    const api = await show([]);
    fireEvent.click(screen.getByRole('button', { name: 'New rule' }));
    const form = screen.getByRole('form', { name: 'New rediscovery rule' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Weekly sweep' } });
    fireEvent.change(within(form).getByLabelText('Range'), { target: { value: '10.1.0.0/24' } });
    fireEvent.change(within(form).getByLabelText('Probe'), { target: { value: '10' } });
    fireEvent.change(within(form).getByLabelText('Group'), { target: { value: '20' } });
    fireEvent.change(within(form).getByLabelText('Every'), { target: { value: 'weekly' } });
    fireEvent.change(within(form).getByLabelText('On'), { target: { value: '6' } });
    fireEvent.change(within(form).getByLabelText('At'), { target: { value: '02:30' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create the rule (off)' }));

    await waitFor(() => {
      expect(writes(api.calls)).toHaveLength(1);
    });
    const [post] = writes(api.calls);
    expect(post?.method).toBe('POST');
    expect(post?.path).toMatch(/\/discovery\/schedules$/u);
    expect(post?.body).toMatchObject({
      name: 'Weekly sweep',
      groupId: 20,
      probeId: 10,
      cadence: 'weekly',
      cadenceWeekday: 6,
      cadenceMinute: 150,
      autoProvision: false,
    });
    expect(post?.body).not.toHaveProperty('enabled');
  });

  it('offers only the groups under the chosen probe', async () => {
    await show([]);
    fireEvent.click(screen.getByRole('button', { name: 'New rule' }));
    const form = screen.getByRole('form', { name: 'New rediscovery rule' });
    fireEvent.change(within(form).getByLabelText('Probe'), { target: { value: '11' } });
    const group = within(form).getByLabelText('Group');
    expect(within(group).queryByText('Datacentre')).toBeNull();
    expect(within(group).getByText('Branch')).toBeDefined();
  });

  it('edits with the version it read, sends only what changed, and never a community it was not given', async () => {
    const api = await show([RULE]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Nightly' }));
    const form = screen.getByRole('form', { name: 'Edit Nightly' });
    const save = within(form).getByRole('button', { name: 'Save changes' });
    expect((save as HTMLButtonElement).disabled, 'nothing has changed yet').toBe(true);

    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Nightly, later' } });
    fireEvent.click(save);
    await waitFor(() => {
      expect(writes(api.calls)).toHaveLength(1);
    });
    const [patch] = writes(api.calls);
    expect(patch?.method).toBe('PATCH');
    expect(patch?.path).toMatch(/\/discovery\/schedules\/5$/u);
    expect(patch?.headers['if-match']).toBe('W/"3"');
    expect(patch?.body).toEqual({ name: 'Nightly, later' });
  });

  it('says so when somebody else saved first, and offers the rule as it is now', async () => {
    const api = await show([RULE], {
      status: 412,
      body: { error: { code: 'DISCOVERY_SCHEDULE_CHANGED', message: 'this rule has changed' } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Nightly' }));
    const form = screen.getByRole('form', { name: 'Edit Nightly' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Mine' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));

    const alert = await alertSaying(/Somebody else changed this rule/u);
    const reads = api.calls.filter((call) => call.path.endsWith('/discovery/schedules')).length;
    fireEvent.click(within(alert).getByRole('button', { name: 'Show the rule as it is now' }));
    await waitFor(() => {
      expect(api.calls.filter((call) => call.path.endsWith('/discovery/schedules')).length).toBe(
        reads + 1,
      );
    });
    expect(screen.queryByRole('form', { name: 'Edit Nightly' })).toBeNull();
  });

  it('switches a rule off from its row', async () => {
    const api = await show([RULE]);
    fireEvent.click(screen.getByRole('button', { name: 'Switch off Nightly' }));
    await waitFor(() => {
      expect(writes(api.calls)).toHaveLength(1);
    });
    expect(writes(api.calls)[0]).toMatchObject({
      method: 'POST',
      body: { enabled: false },
    });
    expect(writes(api.calls)[0]?.path).toMatch(/\/discovery\/schedules\/5\/enabled$/u);
  });

  it('asks before deleting, and deletes only when told to', async () => {
    const api = await show([RULE], { status: 204, body: null });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Nightly' }));
    expect(writes(api.calls)).toHaveLength(0);
    const confirm = screen.getByRole('group', { name: 'Confirm' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep' }));
    expect(writes(api.calls)).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Nightly' }));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Confirm' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    await waitFor(() => {
      expect(writes(api.calls)).toHaveLength(1);
    });
    expect(writes(api.calls)[0]?.method).toBe('DELETE');
  });
});

/**
 * The two refusals, announced (`U-54`): each region in the tree and empty before anything is
 * sent, the refusal in that same node, emptied as the next attempt starts so the same words are
 * said again, and empty after one that is accepted.
 */
describe('a refused rule change (U-54)', () => {
  const GONE = { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no such rule' } } };
  const INVALID = {
    status: 400,
    body: { error: { code: 'DISCOVERY_SCHEDULE_INVALID', message: 'that range is not valid' } },
  };

  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const switchOff = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'Switch off Nightly' }));
  };

  it('says a refused switch in the panel’s region, and says it again on the next attempt', async () => {
    await show([RULE], [GONE, GONE]);
    const region = screen.getByRole('alert');
    expectQuiet(region, ['mt-3', 'empty:mt-0']);

    switchOff();
    expect(await alertSaying('no such rule')).toBe(region);
    expect(region.textContent).toBe('no such rule');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Switch off Nightly' })).toHaveProperty(
        'disabled',
        false,
      );
    });
    switchOff();
    // Committed empty before the core answers: React did not fold the two into one.
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(region.textContent).toBe('no such rule');
    });
    expect(screen.getAllByRole('alert')).toEqual([region]);
  });

  it('empties the panel’s region on an attempt that is accepted', async () => {
    await show([RULE], [GONE]);
    const region = screen.getByRole('alert');
    switchOff();
    await waitFor(() => {
      expect(region.textContent).toBe('no such rule');
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Switch off Nightly' })).toHaveProperty(
        'disabled',
        false,
      );
    });
    switchOff();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Switch off Nightly' })).toHaveProperty(
        'disabled',
        false,
      );
    });
    expect(region.matches(':empty')).toBe(true);
    expect(speaking()).toEqual([]);
  });

  it('says a refused save in the form’s region, again on the next attempt, and empties on one accepted', async () => {
    await show([RULE], [INVALID, INVALID]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Nightly' }));
    const form = screen.getByRole('form', { name: 'Edit Nightly' });
    const region = within(form).getByRole('alert');
    expectQuiet(region, ['mt-4', 'empty:mt-0']);
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Mine' } });
    const save = within(form).getByRole('button', { name: 'Save changes' });

    fireEvent.click(save);
    expect(await alertSaying('that range is not valid')).toBe(region);
    await waitFor(() => {
      expect(save).toHaveProperty('disabled', false);
    });

    fireEvent.click(save);
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(region.textContent).toBe('that range is not valid');
    });
    expect(within(form).getByRole('alert')).toBe(region);
    await waitFor(() => {
      expect(save).toHaveProperty('disabled', false);
    });

    // Accepted: the form closes, and nothing on the panel says anything.
    fireEvent.click(save);
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(screen.queryByRole('form', { name: 'Edit Nightly' })).toBeNull();
    });
    expect(speaking()).toEqual([]);
  });
});
