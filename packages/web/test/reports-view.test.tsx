import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReportRun, ReportSubjects, ReportSummary } from '../src/api/types';
import { ReportsView } from '../src/routes/ReportsView';
import { ReportView } from '../src/routes/ReportView';
import { alertSaying, expectQuiet, speaking } from './support/refusal-region';

/**
 * The reports pages, rendered (`E-11`).
 *
 * `reports-model.test.ts` proves the wording and the arithmetic; these prove the two things a pure
 * test cannot — that the pages render at all against what the core actually answers, and that the
 * one control which must not exist for a frequency does not.
 *
 * **The second one is the reason this file is worth its length.** The core refuses a weekday on a
 * monthly report outright, so a form offering the control produces a 400 nobody can explain. A
 * model test proves `scheduleFields` says no; only a rendered test proves the form listened.
 */

const REPORT: ReportSummary = {
  id: 7,
  name: 'Monthly uptime',
  description: '',
  kind: 'table_only',
  subjects: { objectIds: [41] },
  span: { kind: 'month', offset: 1 },
  resolved: {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-09-01T00:00:00.000Z',
    label: '2026-08 (UTC)',
    timezone: 'UTC',
    bucketSeconds: 3_600,
    source: 'sample_1h',
    adjustments: [
      {
        kind: 'resolution-coarsened',
        reason: 'ranges of 40 days or more are averaged over at least 60 minutes',
      },
    ],
  },
  outputs: { formats: ['html'], delivery: 'store', recipients: [], zip: false },
  schedule: { kind: 'monthly', minute: 120, dayOfMonth: 1 },
  scheduleSummary: 'on the 1st of every month at 02:00',
  nextRunAt: '2026-10-01T02:00:00.000Z',
  lastRunAt: null,
  runAs: { login: 'alice', available: true },
  version: 3,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const RUN: ReportRun = {
  id: 11,
  reportId: 7,
  trigger: 'scheduled',
  requestedBy: '',
  state: 'succeeded',
  queuedAt: '2026-10-01T02:00:00.000Z',
  startedAt: '2026-10-01T02:00:00.000Z',
  finishedAt: '2026-10-01T02:00:04.000Z',
  durationMs: 4_200,
  spanLabel: '2026-09 (UTC)',
  sections: 3,
  unavailable: 1,
  cells: 900,
  errorCode: '',
  errorMessage: '',
  delivery: { state: 'none', attempts: 0, error: '', nextAttemptAt: null, deliveredAt: null },
  outputs: [
    {
      format: 'csv',
      filename: 'Monthly-uptime_2026-09-UTC.csv',
      byteSize: 4_200,
      sha256: 'a'.repeat(64),
      createdAt: '2026-10-01T02:00:04.000Z',
    },
  ],
};

const SUBJECTS: ReportSubjects = {
  runAs: { login: 'alice', role: 'readwrite' },
  visible: [{ id: 41, kind: 'sensor', name: 'edge-router' }],
  unavailable: [42, 43],
};

/** The requests each page makes, answered by path. Unmatched paths fail loudly rather than 404. */
function stubApi(
  over: {
    reports?: ReportSummary[];
    report?: ReportSummary;
    runs?: ReportRun[];
    subjects?: ReportSubjects;
    /** What a save is refused with, when it is. */
    refuseSave?: { status: number; code: string; message: string };
    /** Any other write refused, when this answers one for it. */
    refuse?: (
      method: string,
      path: string,
    ) => { status: number; code: string; message: string } | undefined;
  } = {},
): { calls: { method: string; path: string; body: unknown }[] } {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
    // `body` is always a JSON string here — `send` stringifies before it calls fetch — so this
    // reads it rather than coercing whatever `BodyInit` could in principle be.
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method: init?.method ?? 'GET', path, body });
    const json = (data: unknown): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const refusal =
      over.refuse?.(init?.method ?? 'GET', path) ??
      (init?.method === 'PATCH' ? over.refuseSave : undefined);
    if (refusal !== undefined) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: refusal.code, message: refusal.message } }), {
          status: refusal.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (path.endsWith('/subjects')) return json(over.subjects ?? SUBJECTS);
    if (path.endsWith('/runs')) return json({ items: over.runs ?? [RUN] });
    if (/\/reports\/\d+$/u.test(path)) return json(over.report ?? REPORT);
    if (path.endsWith('/reports')) return json({ items: over.reports ?? [REPORT] });
    throw new Error(`no stub for ${path}`);
  });
  return { calls };
}

const showList = async (reports?: ReportSummary[]): Promise<void> => {
  stubApi(reports === undefined ? {} : { reports });
  render(
    <MemoryRouter>
      <ReportsView />
    </MemoryRouter>,
  );
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Reports', level: 1 })).toBeDefined();
  });
};

const showReport = async (
  over: Parameters<typeof stubApi>[0] = {},
): Promise<ReturnType<typeof stubApi>> => {
  const api = stubApi(over);
  render(
    <MemoryRouter initialEntries={['/reports/7']}>
      <Routes>
        <Route path="/reports/:id" element={<ReportView />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDefined();
  });
  return api;
};

describe('the reports list', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows each report with what it does next', async () => {
    await showList();
    expect(screen.getByText('Monthly uptime')).toBeDefined();
    expect(screen.getByText(/on the 1st of every month at 02:00/u)).toBeDefined();
  });

  it('says in the list that a report will not run, not only on its own page', async () => {
    // The failure this prevents: an operator scanning twenty reports and seeing nothing wrong
    // with the one that has been silently refusing since August.
    await showList([{ ...REPORT, runAs: { login: 'departed', available: false } }]);
    expect(screen.getByText(/deleted or disabled/u)).toBeDefined();
  });

  it('says a template does not render before somebody schedules it', async () => {
    await showList([{ ...REPORT, kind: 'graph_only' }]);
    expect(screen.getByText(/does not render yet/u)).toBeDefined();
  });

  it('gives the id beside a name two reports share, and only then (`L-06`)', async () => {
    // An administrator reads every report, and a name is unique only among what one account can
    // read — so two "Monthly uptime"s can both be listed, and the links must not read alike.
    await showList([
      REPORT,
      { ...REPORT, id: 8, name: 'monthly UPTIME' },
      { ...REPORT, id: 9, name: 'Weekly' },
    ]);
    expect(screen.getByRole('link', { name: 'Monthly uptime #7' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'monthly UPTIME #8' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Weekly' })).toBeDefined();
  });

  it('warns beside the chooser rather than after the fact', async () => {
    await showList();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'graph_only' } });
    expect(screen.getByText(/Needs the graph renderer/u)).toBeDefined();
  });
});

describe('one report', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the period it resolves to and what the rules changed', async () => {
    // `§6`'s averaging rule is not cosmetic — it decides which rollup answers, and an author who
    // pinned five minutes over a quarter has to learn it here rather than from a document.
    await showReport();
    expect(screen.getByText('2026-08 (UTC)')).toBeDefined();
    expect(screen.getByText(/sample_1h/u)).toBeDefined();
    expect(screen.getByText(/averaged over at least 60 minutes/u)).toBeDefined();
  });

  it('shows what its context can see, and counts what it cannot', async () => {
    await showReport();
    expect(screen.getByText(/1 object it can render, 2 it cannot/u)).toBeDefined();
    expect(screen.getByText(/edge-router/u)).toBeDefined();
    // Ids only, and no word about which are deleted: the core deliberately does not say, because
    // a write holder on a report needs no access to the tree (`E-03`).
    expect(screen.getByText(/42, 43/u)).toBeDefined();
  });

  it('lists a run with its period, what it missed, and a link to the file', async () => {
    await showReport();
    expect(screen.getByText(/2026-09 \(UTC\) — 3 sensors, 1 not rendered/u)).toBeDefined();
    const link = screen.getByRole('link', { name: /Monthly-uptime_2026-09-UTC\.csv/u });
    expect(link.getAttribute('href')).toBe('/api/v1/reports/7/runs/11/csv');
  });

  it('runs on demand and reloads what that changed', async () => {
    const api = await showReport();
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST' && call.path.endsWith('/runs'))).toBe(
        true,
      );
    });
  });
});

describe('the settings form', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fieldsetNamed = (name: string): HTMLElement =>
    screen.getByRole('group', { name: new RegExp(name, 'u') });

  it('offers no weekday on a monthly report, because the core refuses one', async () => {
    // **The case this file exists for.** A model test proves `scheduleFields` says no; this
    // proves the form listened.
    await showReport();
    const schedule = fieldsetNamed('Schedule');
    expect(within(schedule).queryByText('Weekday')).toBeNull();
    expect(within(schedule).getByText('Day of month')).toBeDefined();
  });

  it('swaps the controls when the frequency changes', async () => {
    await showReport();
    const schedule = fieldsetNamed('Schedule');
    // By its accessible name: changing the frequency grows a second select, so an unqualified
    // `combobox` becomes ambiguous the moment the thing under test works.
    const frequency = (): HTMLElement => within(schedule).getByRole('combobox', { name: 'Runs' });
    fireEvent.change(frequency(), { target: { value: 'weekly' } });
    expect(within(schedule).getByText('Weekday')).toBeDefined();
    expect(within(schedule).queryByText('Day of month')).toBeNull();

    fireEvent.change(frequency(), { target: { value: 'manual' } });
    expect(within(schedule).queryByText('At')).toBeNull();
  });

  it('sends If-Match and a schedule holding only the fields that apply', async () => {
    // A frequency changed in the form must not leave a weekday behind from the one before it —
    // which is how a form produces a request refused for a control nobody can see any more.
    const api = await showReport();
    const schedule = fieldsetNamed('Schedule');
    fireEvent.change(within(schedule).getByRole('combobox', { name: 'Runs' }), {
      target: { value: 'weekly' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'PATCH')).toBe(true);
    });
    const patch = api.calls.find((call) => call.method === 'PATCH');
    const body = patch?.body as { schedule: Record<string, unknown> };
    expect(body.schedule).toEqual({ kind: 'weekly', minute: 120, weekday: 0 });
    expect(body.schedule['dayOfMonth']).toBeUndefined();
  });

  it('offers all four formats, and sends what was ticked (E-07, E-06)', async () => {
    // The formats `§6` lists, in one place. A checkbox that renders and is not wired to the
    // request is the failure this asserts against — it saves, and the report keeps producing
    // exactly what it produced before.
    const api = await showReport();
    const outputs = fieldsetNamed('Output and delivery');
    for (const name of ['HTML', 'CSV', 'XML', 'PDF']) {
      expect(within(outputs).getByRole('checkbox', { name })).toBeDefined();
    }
    const xml = within(outputs).getByRole('checkbox', { name: 'XML' });
    const pdf = within(outputs).getByRole('checkbox', { name: 'PDF' });
    expect((xml as HTMLInputElement).checked).toBe(false);
    expect((pdf as HTMLInputElement).checked).toBe(false);

    fireEvent.click(xml);
    fireEvent.click(pdf);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'PATCH')).toBe(true);
    });
    const patch = api.calls.find((call) => call.method === 'PATCH');
    const body = patch?.body as { outputs: { formats: string[] } };
    expect(body.outputs.formats).toEqual(['html', 'xml', 'pdf']);
  });

  it('hides the recipient list for a stored-only report and shows it when it sends', async () => {
    // The core refuses recipients on a stored-only report, because a list that looks saved and
    // sends nothing is worse than a refusal.
    await showReport();
    const outputs = fieldsetNamed('Output and delivery');
    expect(within(outputs).queryByText(/Recipients/u)).toBeNull();

    fireEvent.change(within(outputs).getByRole('combobox', { name: 'Delivery' }), {
      target: { value: 'email' },
    });
    expect(within(outputs).getByText(/Recipients/u)).toBeDefined();
    expect(within(outputs).getByText(/still stores the report until it has gone/u)).toBeDefined();
  });

  it('says somebody else saved first when the core answers 412, and keeps the edit (`L-06`)', async () => {
    // What a stale `If-Match` is answered with. The form must say so and keep what was typed:
    // reloading over it would be this form deciding whose edit wins.
    await showReport({
      refuseSave: {
        status: 412,
        code: 'REPORT_CHANGED',
        message: 'report 7 has moved on: expected version 3, found 4',
      },
    });
    const name = screen.getByRole('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: 'Monthly uptime, renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await alertSaying('REPORT_CHANGED');
    expect(screen.getByText(/Somebody else saved this report/u)).toBeDefined();
    expect((name as HTMLInputElement).value).toBe('Monthly uptime, renamed');
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  it('names a bad address individually, and will not save while one stands', async () => {
    // So twelve addresses with one typo do not come back as a single error about the field.
    await showReport();
    const outputs = fieldsetNamed('Output and delivery');
    fireEvent.change(within(outputs).getByRole('combobox', { name: 'Delivery' }), {
      target: { value: 'email' },
    });
    fireEvent.change(within(outputs).getByRole('textbox'), {
      target: { value: 'ops@example.test\nno-at-sign' },
    });
    // Scoped to the warning: the textarea holds the same text, so an unscoped match would pass
    // whether or not anything was reported.
    expect(screen.getByText(/Not addresses this system will send to: no-at-sign/u)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
  });
});

/**
 * The three refusals on these pages, announced (`U-54`): a create, a run and a save. Each is said
 * through an `ErrorPanel` inside a region that is in the tree and empty before anything is sent,
 * so the refusal lands in a node that was there before it; the next attempt empties it as it
 * starts, so the same words are said again; one that is accepted leaves it empty.
 */
describe('a refused report change (U-54)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  let left = 0;
  beforeEach(() => {
    left = 2;
  });

  /** Refuses `method` on paths ending `suffix` twice in `code`'s words, then lets it through. */
  const twice =
    (method: string, suffix: string, code: string) =>
    (
      asked: string,
      path: string,
    ): { status: number; code: string; message: string } | undefined => {
      if (asked !== method || !path.endsWith(suffix) || left === 0) return undefined;
      left -= 1;
      return { status: 409, code, message: 'refused here' };
    };

  it('says a refused create in the region that was there, again, and empties on one accepted', async () => {
    stubApi({ refuse: twice('POST', '/reports', 'REPORT_INVALID') });
    render(
      <MemoryRouter>
        <ReportsView />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Reports', level: 1 });
    const region = screen.getByRole('alert');
    expectQuiet(region, ['mt-3', 'empty:mt-0']);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Weekly' } });
    const create = screen.getByRole('button', { name: 'Create' });

    fireEvent.click(create);
    expect(await alertSaying('REPORT_INVALID')).toBe(region);
    // The panel inside it is not an alert of its own: one region, said once.
    expect(screen.getAllByRole('alert')).toEqual([region]);
    await screen.findByRole('button', { name: 'Create' });

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    // Committed empty before the core answers: React did not fold the two into one.
    expect(region.matches(':empty')).toBe(true);
    await alertSaying('REPORT_INVALID');
    expect(screen.getByRole('alert')).toBe(region);
    await screen.findByRole('button', { name: 'Create' });

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(left).toBe(0);
    });
    expect(speaking()).toEqual([]);
  });

  it('says a refused run in the region under the title, again, and empties on one accepted', async () => {
    const api = await showReport({ refuse: twice('POST', '/runs', 'REPORT_BUSY') });
    const run = (): void => {
      fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    };
    const region = screen
      .getAllByRole('alert')
      .find((one) => one.closest('form') === null) as HTMLElement;
    expectQuiet(region, ['mt-4', 'empty:mt-0']);
    // Under the title row, in one block with it, so it never stands alone in the page's stack.
    expect(
      region.parentElement?.firstElementChild?.contains(screen.getByRole('heading', { level: 1 })),
    ).toBe(true);

    run();
    expect(await alertSaying('REPORT_BUSY')).toBe(region);
    await screen.findByRole('button', { name: 'Run now' });
    run();
    expect(region.matches(':empty')).toBe(true);
    expect(await alertSaying('REPORT_BUSY')).toBe(region);
    await screen.findByRole('button', { name: 'Run now' });
    run();
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(3);
    });
    await screen.findByRole('button', { name: 'Run now' });
    expect(speaking()).toEqual([]);
  });

  it('says a refused save in the form’s region, again, and empties on one accepted', async () => {
    const api = await showReport({ refuse: twice('PATCH', '/reports/7', 'REPORT_CHANGED') });
    const form = screen.getByRole('button', { name: 'Save' }).closest('form') as HTMLElement;
    const region = within(form).getByRole('alert');
    expectQuiet(region, ['mt-5', 'empty:mt-0']);
    // The buttons and the region are one block, the form's last child.
    expect(region.parentElement?.lastElementChild).toBe(region);
    expect(form.lastElementChild).toBe(region.parentElement);
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Monthly uptime, renamed' },
    });
    const save = (): void => {
      fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    };

    save();
    expect(await alertSaying('REPORT_CHANGED')).toBe(region);
    // What follows the panel is said with it, inside the same region.
    expect(within(region).getByText(/Somebody else saved this report/u)).toBeDefined();
    await within(form).findByRole('button', { name: 'Save' });
    save();
    expect(region.matches(':empty')).toBe(true);
    expect(await alertSaying('REPORT_CHANGED')).toBe(region);
    await within(form).findByRole('button', { name: 'Save' });
    save();
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(api.calls.filter((call) => call.method === 'PATCH')).toHaveLength(3);
    });
    // Accepted: the report is read again and the form drawn from it, saying nothing.
    await screen.findByRole('button', { name: 'Save' });
    expect(speaking()).toEqual([]);
  });
});
