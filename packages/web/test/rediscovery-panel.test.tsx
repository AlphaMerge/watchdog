import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObjectSummary, RediscoveryRule } from '../src/api/types';
import { RediscoveryPanel } from '../src/routes/RediscoveryPanel';
import {
  alertSaying,
  expectCorrelation,
  expectQuiet,
  speaking,
  statusSaying,
} from './support/refusal-region';

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
 * list, each write the next one, and accepted once the list is spent. `listing` answers the list's
 * reads by their number from 1 where it gives an answer: a refusal, or a read held until `hold`.
 */
function stubApi(
  rules: RediscoveryRule[],
  answer?: Answer | Answer[],
  listing?: (read: number) => Answer | { hold: Promise<void> } | undefined,
): { calls: Call[] } {
  const calls: Call[] = [];
  const queue = Array.isArray(answer) ? [...answer] : undefined;
  let reads = 0;
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
    if (path.endsWith('/discovery/schedules')) {
      reads += 1;
      const staged = listing?.(reads);
      if (staged === undefined) return reply(200, { items: rules });
      if ('hold' in staged) return staged.hold.then(() => reply(200, { items: rules }));
      return reply(staged.status, staged.body);
    }
    if (path.endsWith('/schedules'))
      return reply(200, { items: [{ id: 2, name: 'Change freeze', description: '' }] });
    throw new Error(`no stub for ${method} ${path}`);
  });
  return { calls };
}

const show = async (
  rules: RediscoveryRule[],
  answer?: Answer | Answer[],
  listing?: (read: number) => Answer | { hold: Promise<void> } | undefined,
) => {
  const api = stubApi(rules, answer, listing);
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
    const confirm = screen.getByRole('group', { name: 'Confirm deleting Nightly' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep' }));
    expect(writes(api.calls)).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Nightly' }));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Confirm deleting Nightly' })).getByRole('button', {
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
    // The core sent no id with this one, and none is shown (`U-59`).
    expectCorrelation(region, undefined);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Switch off Nightly' }).getAttribute('aria-disabled'),
      ).toBe('false');
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
      expect(
        screen.getByRole('button', { name: 'Switch off Nightly' }).getAttribute('aria-disabled'),
      ).toBe('false');
    });
    switchOff();
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Switch off Nightly' }).getAttribute('aria-disabled'),
      ).toBe('false');
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
      expect(save.getAttribute('aria-disabled')).toBe('false');
    });

    fireEvent.click(save);
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(region.textContent).toBe('that range is not valid');
    });
    expect(within(form).getByRole('alert')).toBe(region);
    await waitFor(() => {
      expect(save.getAttribute('aria-disabled')).toBe('false');
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

/**
 * The core's correlation id, said with each refusal (`U-59`), in the `ml-2 font-mono` span
 * `ParamsForm` uses, so a refusal can be found in the core's log.
 */
describe('a refused rule change, with the core’s id (U-59)', () => {
  const withId = (status: number, code: string, message: string, id: string) => ({
    status,
    body: { error: { code, message, correlationId: id } },
  });

  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says the id after a refused switch, in the panel’s region', async () => {
    await show([RULE], [withId(404, 'NOT_FOUND', 'no such rule', 'req-59')]);
    const region = screen.getByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Switch off Nightly' }));
    expect(await alertSaying('no such rule')).toBe(region);
    expect(region.textContent).toBe('no such rule req-59');
    expectCorrelation(region, 'req-59');
  });

  it('says the id after a refused save, in the form’s region', async () => {
    await show(
      [RULE],
      [withId(400, 'DISCOVERY_SCHEDULE_INVALID', 'that range is not valid', 'req-59b')],
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Nightly' }));
    const form = screen.getByRole('form', { name: 'Edit Nightly' });
    const region = within(form).getByRole('alert');
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Mine' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await alertSaying('that range is not valid')).toBe(region);
    expect(region.textContent).toBe('that range is not valid req-59b');
    expectCorrelation(region, 'req-59b');
  });
});

describe('a rule whose probe its reader cannot see (A-80)', () => {
  // The reader's lists hold no probe 10, and the core answers the rule without `probeId`.
  const UNSEEN: RediscoveryRule = { ...RULE };
  delete UNSEEN.probeId;
  const ONLY_THEIRS = [object(20, 10, 'group', 'Datacentre')];

  it('says it runs from the probe above its group, and an edit sends no probe', async () => {
    const api = stubApi([UNSEEN]);
    render(<RediscoveryPanel probes={[]} groups={ONLY_THEIRS} templates={[]} />);
    const list = await screen.findByRole('list', { name: 'Rediscovery rules' });
    expect(within(list).getByText(/into Datacentre, from the probe above it/u)).toBeDefined();
    expect(list.textContent).not.toMatch(/probe 10|undefined/u);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Nightly' }));
    const form = screen.getByRole('form', { name: 'Edit Nightly' });
    const probe = within(form).getByLabelText<HTMLSelectElement>('Probe');
    expect(probe.value).toBe('above');
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Nightly, later' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(writes(api.calls)).toHaveLength(1);
    });
    expect(writes(api.calls)[0]?.body).toEqual({ name: 'Nightly, later' });
  });
});

/**
 * Focus through every action on the rules (`U-23` review, WCAG 2.4.3).
 *
 * The panel did nothing with focus, so after nearly every action it fell to the page: the button
 * pressed was taken away (New rule, a row's Delete, Keep, the form's Cancel and Save), disabled
 * as it was pressed (a switch, the confirmed Delete, Save), or went with the whole list while it
 * was read again after a change. A keyboard user started the page again each time, and a screen
 * reader said nothing of the form that opened or the question a Delete asked.
 */
describe('focus through the rules (U-23 review)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const press = (element: HTMLElement): void => {
    act(() => {
      element.focus();
    });
    fireEvent.click(element);
  };
  const button = (name: string): HTMLButtonElement =>
    screen.getByRole<HTMLButtonElement>('button', { name });
  const reads = (calls: Call[]): number =>
    calls.filter((call) => call.method === 'GET' && call.path.endsWith('/discovery/schedules'))
      .length;

  it('puts focus on a new rule’s form as it opens, and back on New rule when it is cancelled', async () => {
    await show([RULE]);
    press(button('New rule'));
    const heading = screen.getByRole('heading', { name: 'New rule' });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    expect(heading.getAttribute('tabindex')).toBe('-1');

    press(button('Cancel'));
    await waitFor(() => {
      expect(document.activeElement).toBe(button('New rule'));
    });
  });

  it('puts focus on an edit’s form as it opens, and back on that rule’s Edit when it is cancelled', async () => {
    const other: RediscoveryRule = { ...RULE, id: 6, name: 'Weekly' };
    await show([RULE, other]);
    press(button('Edit Weekly'));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Editing Weekly' }));
    });
    press(button('Cancel'));
    await waitFor(() => {
      expect(document.activeElement).toBe(button('Edit Weekly'));
    });
  });

  it('puts focus on the question a Delete asks, and back on Delete when the rule is kept', async () => {
    await show([RULE]);
    press(button('Delete Nightly'));
    const group = screen.getByRole('group', { name: 'Confirm deleting Nightly' });
    await waitFor(() => {
      expect(document.activeElement).toBe(group);
    });
    expect(group.getAttribute('tabindex')).toBe('-1');
    expect(group.textContent).toContain('Delete Nightly?');

    press(within(group).getByRole('button', { name: 'Keep' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(button('Delete Nightly'));
    });
  });

  it('keeps focus on the confirmed Delete while it is out, then says the rule went and puts focus there', async () => {
    const rules = [RULE];
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = await show(rules, { status: 204, body: null }, (read) =>
      read === 2 ? { hold } : undefined,
    );
    press(button('Delete Nightly'));
    const group = screen.getByRole('group', { name: 'Confirm deleting Nightly' });
    const confirmed = within(group).getByRole<HTMLButtonElement>('button', { name: 'Delete' });
    rules.length = 0;
    press(confirmed);
    expect(confirmed.disabled).toBe(false);
    expect(confirmed.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(confirmed);

    const notice = await statusSaying('Deleted Nightly.');
    await waitFor(() => {
      expect(document.activeElement).toBe(notice);
    });
    expect(notice.getAttribute('tabindex')).toBe('-1');
    expect(writes(api.calls)).toHaveLength(1);
    // Read again, the rule is gone, and focus stays on what was said.
    release();
    await screen.findByText('No rules.');
    expect(document.activeElement).toBe(notice);
  });

  it('leaves focus where the operator moved it while the delete was out', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubApi([RULE]);
    const answering = globalThis.fetch;
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'GET'
        ? answering(path, init)
        : hold.then(() => new Response(null, { status: 204 })),
    );
    render(
      <>
        <RediscoveryPanel probes={PROBES} groups={GROUPS} templates={[]} />
        <button type="button">Elsewhere</button>
      </>,
    );
    press(await screen.findByRole('button', { name: 'Delete Nightly' }));
    press(
      within(screen.getByRole('group', { name: 'Confirm deleting Nightly' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    const elsewhere = button('Elsewhere');
    act(() => {
      elsewhere.focus();
    });
    release();
    await statusSaying('Deleted Nightly.');
    expect(document.activeElement).toBe(elsewhere);
  });

  it('gives focus back to the row’s Delete when the core refuses the delete', async () => {
    await show([RULE], {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'no such rule' } },
    });
    press(button('Delete Nightly'));
    press(
      within(screen.getByRole('group', { name: 'Confirm deleting Nightly' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    await alertSaying('no such rule');
    await waitFor(() => {
      expect(document.activeElement).toBe(button('Delete Nightly'));
    });
  });

  it('keeps focus on a switch while it is out, through the list being read again', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = await show([RULE], undefined, (read) => (read === 2 ? { hold } : undefined));
    const pressed = button('Switch off Nightly');
    press(pressed);
    expect(pressed.disabled).toBe(false);
    expect(pressed.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(pressed);
    // A second press while it is out sends nothing.
    fireEvent.click(pressed);

    // Accepted, and the list read again: held, and the list stays on screen with focus in it.
    await waitFor(() => {
      expect(reads(api.calls)).toBe(2);
    });
    expect(screen.queryByText('Loading rediscovery rules…')).toBeNull();
    expect(pressed.isConnected).toBe(true);
    expect(document.activeElement).toBe(pressed);
    release();
    await waitFor(() => {
      expect(pressed.getAttribute('aria-disabled')).toBe('false');
    });
    expect(pressed.isConnected).toBe(true);
    expect(document.activeElement).toBe(pressed);
    expect(writes(api.calls)).toHaveLength(1);
  });

  it('keeps the list and the focus when it cannot be read again, and says so', async () => {
    const api = await show([RULE], undefined, (read) =>
      read === 2
        ? { status: 500, body: { error: { code: 'INTERNAL', message: 'the database went away' } } }
        : undefined,
    );
    const pressed = button('Switch off Nightly');
    press(pressed);
    await statusSaying('could not be read again');
    expect(pressed.isConnected).toBe(true);
    expect(document.activeElement).toBe(pressed);
    expect(screen.getByRole('list', { name: 'Rediscovery rules' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(reads(api.calls)).toBe(3);
    });
    await waitFor(() => {
      expect(screen.queryByText(/could not be read again/u)).toBeNull();
    });
  });

  it('keeps focus on Save while a save is out and when it is refused', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refused = {
      status: 400,
      body: { error: { code: 'DISCOVERY_SCHEDULE_INVALID', message: 'that range is not valid' } },
    };
    stubApi([RULE]);
    // Reads as the stub answers them; the save held, then refused.
    const answering = globalThis.fetch;
    let saves = 0;
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return answering(path, init);
      saves += 1;
      return hold.then(
        () =>
          new Response(JSON.stringify(refused.body), {
            status: refused.status,
            headers: { 'content-type': 'application/json' },
          }),
      );
    });
    render(<RediscoveryPanel probes={PROBES} groups={GROUPS} templates={[]} />);
    press(await screen.findByRole('button', { name: 'Edit Nightly' }));
    const form = screen.getByRole('form', { name: 'Edit Nightly' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Mine' } });
    const save = within(form).getByRole<HTMLButtonElement>('button', { name: 'Save changes' });
    press(save);
    expect(save.textContent).toBe('Saving…');
    expect(save.disabled).toBe(false);
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(save);
    // Pressed again, or Enter in a box, while it is out: nothing more is sent.
    fireEvent.click(save);
    fireEvent.submit(form);
    expect(saves).toBe(1);
    // Cancel is unavailable too, so the form is not closed under the save.
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('form', { name: 'Edit Nightly' })).toBe(form);

    release();
    await alertSaying('that range is not valid');
    await waitFor(() => {
      expect(save.getAttribute('aria-disabled')).toBe('false');
    });
    expect(document.activeElement).toBe(save);
  });

  it('says a save was made and puts focus there, for an edit and for a new rule', async () => {
    await show([RULE]);
    press(button('Edit Nightly'));
    const form = screen.getByRole('form', { name: 'Edit Nightly' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Nightly, later' } });
    press(within(form).getByRole('button', { name: 'Save changes' }));
    const saved = await statusSaying('Saved Nightly, later.');
    await waitFor(() => {
      expect(document.activeElement).toBe(saved);
    });
    expect(screen.queryByRole('form')).toBeNull();

    press(button('New rule'));
    // Opening the form takes what was said away.
    expect(saved.textContent).toBe('');
    const next = screen.getByRole('form', { name: 'New rediscovery rule' });
    fireEvent.change(within(next).getByLabelText('Name'), { target: { value: 'Weekly sweep' } });
    fireEvent.change(within(next).getByLabelText('Range'), { target: { value: '10.1.0.0/24' } });
    fireEvent.change(within(next).getByLabelText('Probe'), { target: { value: '10' } });
    fireEvent.change(within(next).getByLabelText('Group'), { target: { value: '20' } });
    press(within(next).getByRole('button', { name: 'Create the rule (off)' }));
    const created = await statusSaying(
      'Created Weekly sweep. It is off until it is switched on from its row.',
    );
    expect(created).toBe(saved);
    await waitFor(() => {
      expect(document.activeElement).toBe(created);
    });
  });

  it('gives focus back to the rule’s Edit when the form gives way to the rule as it is now', async () => {
    await show([RULE], {
      status: 412,
      body: { error: { code: 'DISCOVERY_SCHEDULE_CHANGED', message: 'this rule has changed' } },
    });
    press(button('Edit Nightly'));
    const form = screen.getByRole('form', { name: 'Edit Nightly' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Mine' } });
    press(within(form).getByRole('button', { name: 'Save changes' }));
    const alert = await alertSaying(/Somebody else changed this rule/u);
    press(within(alert).getByRole('button', { name: 'Show the rule as it is now' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(button('Edit Nightly'));
    });
  });
});
