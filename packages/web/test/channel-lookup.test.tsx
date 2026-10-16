import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Stream from '../src/api/stream';
import type { ChannelRecord, LookupSummary, ObjectDetail } from '../src/api/types';
import { SessionContext, type Session, type SessionContextValue } from '../src/auth/session';
import { ChannelTable } from '../src/routes/detail/ChannelTable';
import type { LookupEditing } from '../src/routes/detail/LookupControl';
import { lookupOptions } from '../src/routes/detail/lookup-model';
import { ObjectDetailView } from '../src/routes/ObjectDetailView';
import { expectCorrelation, expectQuiet } from './support/refusal-region';

// The page opens a socket for its live state, and none of that is what this file is about.
vi.mock('../src/api/stream', async (importOriginal) => ({
  ...(await importOriginal<typeof Stream>()),
  useStateStream: (): Stream.LiveStates => ({ status: 'offline', states: new Map(), frames: 0 }),
}));

/**
 * A channel's lookup, set from the channel table (`U-82`).
 *
 * Until `U-82` the table showed a channel's lookup and setting one took
 * `PATCH /objects/{id}/channels/{key}`, which is what the list of channels without their declared
 * lookup (`P-308`) told an operator to call. The table now offers the declared lookup first, to an
 * account that may write the sensor, and sets nothing until asked.
 */

const STATUS_LOOKUP = 'ms.snmp.if-oper-status';

const NO_LIMITS: ChannelRecord['limits'] = {
  enabled: true,
  upperError: null,
  upperWarning: null,
  lowerWarning: null,
  lowerError: null,
  errorMessage: '',
  warningMessage: '',
};

function channel(id: number, key: string, over: Partial<ChannelRecord> = {}): ChannelRecord {
  return {
    id,
    key,
    name: key === 'status' ? 'Interface status' : `Channel ${key}`,
    unit: '',
    isPrimary: id === 1,
    limits: NO_LIMITS,
    scaleMul: '1',
    scaleDiv: '1',
    decimals: null,
    spikeMin: null,
    spikeMax: null,
    lookupId: null,
    declaredLookup: null,
    retired: false,
    ...over,
  };
}

const lookup = (id: string, name: string): LookupSummary => ({
  id,
  name,
  type: 'singleInt',
  undefinedState: 'warning',
  entryCount: 2,
  source: 'built-in',
});
const LOOKUPS: LookupSummary[] = [
  lookup('ms.probe.link', 'Probe link'),
  lookup(STATUS_LOOKUP, 'Interface operational status'),
  lookup('custom.door', 'Door contact'),
];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  method: string;
  url: string;
  body: unknown;
  ifMatch: string | null;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what a channel’s lookup can be set to (U-82)', () => {
  it('offers the declared lookup first, then none, then every other loaded one by name', () => {
    expect(
      lookupOptions({ lookupId: null, declaredLookup: STATUS_LOOKUP }, LOOKUPS).map(
        (option) => option.value,
      ),
    ).toEqual([STATUS_LOOKUP, '', 'custom.door', 'ms.probe.link']);
    expect(lookupOptions({ lookupId: null, declaredLookup: STATUS_LOOKUP }, LOOKUPS)[0]).toEqual({
      value: STATUS_LOOKUP,
      label: `Interface operational status (${STATUS_LOOKUP}), declared by its type`,
    });
    expect(lookupOptions({ lookupId: null, declaredLookup: null }, LOOKUPS)[0]).toEqual({
      value: '',
      label: 'None: judged by its limits',
    });
  });

  it('offers what the channel has although it is not loaded, marked, so the list shows it', () => {
    const options = lookupOptions(
      { lookupId: 'vendor.gone', declaredLookup: STATUS_LOOKUP },
      LOOKUPS,
    );
    expect(options.slice(0, 3)).toEqual([
      {
        value: STATUS_LOOKUP,
        label: `Interface operational status (${STATUS_LOOKUP}), declared by its type`,
      },
      { value: 'vendor.gone', label: 'vendor.gone, not loaded' },
      { value: '', label: 'None: judged by its limits' },
    ]);
    // A declared one nobody loaded is offered too: the core takes an id it has not loaded.
    expect(lookupOptions({ lookupId: null, declaredLookup: 'vendor.new' }, LOOKUPS)[0]).toEqual({
      value: 'vendor.new',
      label: 'vendor.new, not loaded, declared by its type',
    });
  });

  it('offers no loaded list while the lookups are not read, and calls nothing unloaded', () => {
    expect(lookupOptions({ lookupId: 'vendor.gone', declaredLookup: STATUS_LOOKUP }, null)).toEqual(
      [
        { value: STATUS_LOOKUP, label: `${STATUS_LOOKUP}, declared by its type` },
        { value: 'vendor.gone', label: 'vendor.gone' },
        { value: '', label: 'None: judged by its limits' },
      ],
    );
  });
});

/** The table as the page draws it for a writer: a re-read after a set, with the table kept. */
function Table({
  start,
  editing,
  reread,
}: {
  start: ChannelRecord[];
  editing?: Pick<LookupEditing, 'sensorId' | 'version'> & { pending?: boolean };
  /** What the page's re-read of the list answers after a set. */
  reread?: (channels: ChannelRecord[]) => ChannelRecord[];
}): React.JSX.Element {
  const [channels, setChannels] = useState(start);
  const [version, setVersion] = useState(editing?.version ?? 0);
  return (
    <MemoryRouter>
      <ChannelTable
        channels={channels}
        values={null}
        lookups={LOOKUPS}
        now={Date.now()}
        hideRetired={false}
        onHideRetiredChange={() => undefined}
        editing={
          editing === undefined
            ? undefined
            : {
                sensorId: editing.sensorId,
                version,
                pending: editing.pending ?? false,
                onSaved: () => {
                  setVersion((was) => was + 1);
                  if (reread !== undefined) setChannels(reread);
                },
              }
        }
      />
    </MemoryRouter>
  );
}

/** The core: each `PATCH` answered by `answer`, and every call kept. */
function core(answer: (body: { lookupId: string | null }) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      lookupId: string | null;
    };
    calls.push({
      method: init?.method ?? 'GET',
      url,
      body,
      ifMatch: new Headers(init?.headers).get('if-match'),
    });
    return Promise.resolve(answer(body));
  });
  return calls;
}

const WITHOUT = channel(2, 'status', { declaredLookup: STATUS_LOOKUP });
const ROWS = [channel(1, 'in'), WITHOUT];

describe('setting a channel’s lookup in the channel table (U-82)', () => {
  it('offers nothing to set where the page gives it no editing', () => {
    render(<Table start={ROWS} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Set lookup/u })).toBeNull();
  });

  it('sets the declared lookup when asked, and not before, held to the sensor’s version', async () => {
    const calls = core((body) => json({ ...WITHOUT, lookupId: body.lookupId }));
    render(
      <Table
        start={ROWS}
        editing={{ sensorId: 7, version: 4 }}
        reread={(rows) =>
          rows.map((row) => (row.key === 'status' ? { ...row, lookupId: STATUS_LOOKUP } : row))
        }
      />,
    );
    const list = screen.getByRole('combobox', { name: 'Lookup for Interface status' });
    const set = screen.getByRole('button', { name: 'Set lookup for Interface status' });
    expect((list as HTMLSelectElement).value).toBe('');
    expect(set.getAttribute('aria-disabled')).toBe('true');
    expect(within(list).getAllByRole('option')[0]?.textContent).toBe(
      `Interface operational status (${STATUS_LOOKUP}), declared by its type`,
    );

    fireEvent.change(list, { target: { value: STATUS_LOOKUP } });
    expect(calls).toEqual([]);
    expect(set.getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(set);

    const row = screen.getByText('Interface status').closest('tr');
    if (row === null) throw new Error('no row');
    await waitFor(() => {
      expect(within(row).getByRole('status').textContent).toBe(
        `Set. ${STATUS_LOOKUP} judges it from its next reading.`,
      );
    });
    expect(calls).toEqual([
      {
        method: 'PATCH',
        url: '/api/v1/objects/7/channels/status',
        body: { lookupId: STATUS_LOOKUP },
        ifMatch: 'W/"4"',
      },
    ]);
    // The re-read list says it has it now: shown, and nothing left to set.
    expect(within(row).getByText(STATUS_LOOKUP, { selector: 'span.font-mono' })).toBeDefined();
    expect((list as HTMLSelectElement).value).toBe(STATUS_LOOKUP);
    expect(set.getAttribute('aria-disabled')).toBe('true');
    expectQuiet(within(row).getByRole('alert'), ['mt-1', 'empty:mt-0']);
  });

  it('keeps focus on the button while it sets and after it, and a press then sends nothing more', async () => {
    const calls: Call[] = [];
    const held: { release: (() => void) | null } = { release: null };
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        url,
        body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as unknown,
        ifMatch: new Headers(init?.headers).get('if-match'),
      });
      return new Promise<Response>((resolve) => {
        held.release = () => {
          resolve(json({ ...WITHOUT, lookupId: STATUS_LOOKUP }));
        };
      });
    });
    render(
      <Table
        start={ROWS}
        editing={{ sensorId: 7, version: 4 }}
        reread={(rows) =>
          rows.map((row) => (row.key === 'status' ? { ...row, lookupId: STATUS_LOOKUP } : row))
        }
      />,
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Lookup for Interface status' }), {
      target: { value: STATUS_LOOKUP },
    });
    const pressed = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Set lookup for Interface status',
    });
    const form = pressed.closest('form');
    if (form === null) throw new Error('no form');
    pressed.focus();
    fireEvent.click(pressed);

    // Out: the same button, saying so in its name too, unavailable but not disabled, focused.
    expect(pressed.textContent).toBe('Setting lookup…');
    expect(pressed.getAttribute('aria-label')).toBe('Setting lookup for Interface status');
    expect(pressed.getAttribute('aria-disabled')).toBe('true');
    expect(pressed.disabled).toBe(false);
    expect(document.activeElement).toBe(pressed);
    fireEvent.click(pressed);
    fireEvent.submit(form);
    expect(calls).toHaveLength(1);

    held.release?.();
    const row = pressed.closest('tr');
    if (row === null) throw new Error('no row');
    await waitFor(() => {
      expect(within(row).getByRole('status').textContent).toBe(
        `Set. ${STATUS_LOOKUP} judges it from its next reading.`,
      );
    });
    // Set, and nothing left to set: unavailable still, and focus where it was.
    expect(pressed.getAttribute('aria-disabled')).toBe('true');
    expect(pressed.disabled).toBe(false);
    expect(document.activeElement).toBe(pressed);
    fireEvent.click(pressed);
    expect(calls).toHaveLength(1);
  });

  it('holds a set while the page reads the sensor again, which would send the version before', () => {
    const calls = core(() => json(WITHOUT));
    render(<Table start={ROWS} editing={{ sensorId: 7, version: 4, pending: true }} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Lookup for Interface status' }), {
      target: { value: STATUS_LOOKUP },
    });
    const pressed = screen.getByRole('button', { name: 'Set lookup for Interface status' });
    expect(pressed.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(pressed);
    expect(calls).toEqual([]);
  });

  it('clears one to none, and the next set is held to the version the first moved', async () => {
    const calls = core((body) => json({ ...WITHOUT, lookupId: body.lookupId }));
    const held = channel(3, 'admin', { lookupId: 'custom.door' });
    render(
      <Table
        start={[...ROWS, held]}
        editing={{ sensorId: 7, version: 4 }}
        reread={(rows) =>
          rows.map((row) => (row.key === 'admin' ? { ...row, lookupId: null } : row))
        }
      />,
    );
    const list = screen.getByRole('combobox', { name: 'Lookup for Channel admin' });
    expect((list as HTMLSelectElement).value).toBe('custom.door');
    fireEvent.change(list, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set lookup for Channel admin' }));
    const row = screen.getByText('Channel admin').closest('tr');
    if (row === null) throw new Error('no row');
    await waitFor(() => {
      expect(within(row).getByRole('status').textContent).toBe(
        'Cleared. Its limits judge it from its next reading.',
      );
    });

    fireEvent.change(screen.getByRole('combobox', { name: 'Lookup for Interface status' }), {
      target: { value: STATUS_LOOKUP },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set lookup for Interface status' }));
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(calls.map((call) => [call.url, call.body, call.ifMatch])).toEqual([
      ['/api/v1/objects/7/channels/admin', { lookupId: null }, 'W/"4"'],
      ['/api/v1/objects/7/channels/status', { lookupId: STATUS_LOOKUP }, 'W/"5"'],
    ]);
  });

  it('names the channel in the address as a path segment', async () => {
    const calls = core(() => json(WITHOUT));
    render(
      <Table
        start={[channel(4, 'a/b c', { declaredLookup: STATUS_LOOKUP })]}
        editing={{ sensorId: 7, version: 4 }}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: STATUS_LOOKUP } });
    fireEvent.click(screen.getByRole('button', { name: /Set lookup/u }));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.url).toBe('/api/v1/objects/7/channels/a%2Fb%20c');
  });

  it('says a refusal under the row, with its id, and what a changed sensor needs', async () => {
    core(() =>
      json(
        {
          error: {
            code: 'OBJECT_VERSION_CONFLICT',
            message: 'object 7 is at version 5, not 4',
            correlationId: 'req-82',
            context: {},
            details: {},
          },
        },
        412,
      ),
    );
    render(<Table start={ROWS} editing={{ sensorId: 7, version: 4 }} />);
    const row = screen.getByText('Interface status').closest('tr');
    if (row === null) throw new Error('no row');
    const alert = within(row).getByRole('alert');
    expectQuiet(alert, ['mt-1', 'empty:mt-0']);
    fireEvent.change(within(row).getByRole('combobox'), { target: { value: STATUS_LOOKUP } });
    fireEvent.click(within(row).getByRole('button', { name: /Set lookup/u }));
    await waitFor(() => {
      expect(alert.textContent).toContain('object 7 is at version 5, not 4');
    });
    expect(alert.textContent).toContain('somebody else changed this sensor');
    expectCorrelation(alert, 'req-82');
    expect(within(row).getByRole('status').textContent).toBe('');
    // Still the choice made, to set again after a reload.
    expect(within(row).getByRole<HTMLSelectElement>('combobox').value).toBe(STATUS_LOOKUP);
  });
});

// ── on the page ─────────────────────────────────────────────────────────────────────────────

const SENSOR: ObjectDetail = {
  id: 9,
  parentId: 4,
  kind: 'sensor',
  name: 'Uplink',
  tags: [],
  priority: 3,
  version: 1,
  hasChildren: false,
  sensorType: 'snmp.traffic',
  comments: '',
  inheritsTriggers: true,
  childCount: 0,
  createdAt: '2026-10-17T08:00:00.000Z',
  updatedAt: '2026-10-17T08:00:00.000Z',
  params: {},
  redactedParams: [],
};

const pathOf = (url: string): string => url.replace(/^\/api\/v1/u, '').replace(/\?.*$/u, '');

/** The page's reads, answered; `right` is what `…/access/effective` says. */
function page(right: string | null): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url, body: undefined, ifMatch: null });
    return read(pathOf(url), right);
  });
  return calls;
}

/** Every read the page makes but the sensor and its channels, which a test may answer itself. */
function read(path: string, right: string | null): Promise<Response> {
  if (path === '/objects/9') return Promise.resolve(json(SENSOR));
  if (path === '/objects/9/channels') return Promise.resolve(json({ items: ROWS }));
  if (path === '/lookups') return Promise.resolve(json({ items: LOOKUPS, problems: [] }));
  if (path === '/objects/9/access/effective') {
    return Promise.resolve(json({ right, inherited: false, viaAdminGroup: false }));
  }
  if (path === '/sensors/9/values') {
    return Promise.resolve(
      json({
        sensorId: 9,
        readAt: new Date().toISOString(),
        notBefore: new Date().toISOString(),
        intervalSeconds: 60,
        channels: [],
      }),
    );
  }
  return Promise.resolve(
    json({ error: { code: 'NOT_FOUND', message: 'not here', context: {}, details: {} } }, 404),
  );
}

function onPage(session: Session | null): void {
  const view = (
    <MemoryRouter initialEntries={['/objects/9']}>
      <Routes>
        <Route path="/objects/:id" element={<ObjectDetailView />} />
      </Routes>
    </MemoryRouter>
  );
  if (session === null) {
    render(view);
    return;
  }
  const value: SessionContextValue = {
    session,
    signedIn: () => undefined,
    signOut: () => Promise.resolve(),
    refresh: () => undefined,
    askingToSignIn: false,
    askToSignIn: () => undefined,
  };
  render(<SessionContext.Provider value={value}>{view}</SessionContext.Provider>);
}

const SIGNED_IN: Session = {
  kind: 'signed-in',
  requireAuthentication: true,
  principal: { userId: 7, login: 'pat', role: 'readwrite', mustChangePassword: false },
};

describe('who the page offers it to (U-82)', () => {
  it('an account with write on the sensor, as the core answers for it', async () => {
    const calls = page('write');
    onPage(SIGNED_IN);
    expect(
      await screen.findByRole('combobox', { name: 'Lookup for Interface status' }),
    ).toBeDefined();
    expect(calls.some((call) => call.url === '/api/v1/objects/9/access/effective')).toBe(true);
  });

  it('not an account that may only read it, which is shown the lookup and no list', async () => {
    page('read');
    onPage(SIGNED_IN);
    await screen.findByText('Interface status');
    await waitFor(() => {
      expect(screen.queryByRole('combobox', { name: /^Lookup for/u })).toBeNull();
    });
    expect(screen.queryByRole('button', { name: /Set lookup/u })).toBeNull();
  });

  it('anybody where sign-in is off', async () => {
    page(null);
    onPage({ kind: 'anonymous', requireAuthentication: false });
    expect(
      await screen.findByRole('combobox', { name: 'Lookup for Interface status' }),
    ).toBeDefined();
  });

  it('nobody on a page drawn with no session', async () => {
    page(null);
    onPage(null);
    await screen.findByText('Interface status');
    expect(screen.queryByRole('combobox', { name: /^Lookup for/u })).toBeNull();
  });
});

describe('a set on the page (U-82)', () => {
  it('reads the sensor and its channels again, and holds the next set until the sensor is read', async () => {
    let version = 1;
    let status: string | null = null;
    let holding = false;
    const held: { release: (() => void) | null } = { release: null };
    const patches: Call[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const path = pathOf(url);
      if (init?.method === 'PATCH') {
        const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
          lookupId: string | null;
        };
        patches.push({
          method: 'PATCH',
          url,
          body,
          ifMatch: new Headers(init.headers).get('if-match'),
        });
        version += 1;
        if (path.endsWith('/status')) status = body.lookupId;
        return Promise.resolve(json({ ...WITHOUT, lookupId: status }));
      }
      if (path === '/objects/9') {
        const answer = json({ ...SENSOR, version });
        if (!holding) return Promise.resolve(answer);
        return new Promise<Response>((resolve) => {
          held.release = () => {
            resolve(answer);
          };
        });
      }
      if (path === '/objects/9/channels') {
        return Promise.resolve(
          json({ items: [channel(1, 'in'), { ...WITHOUT, lookupId: status }] }),
        );
      }
      return read(path, 'write');
    });
    onPage(SIGNED_IN);
    const list = await screen.findByRole('combobox', { name: 'Lookup for Interface status' });

    holding = true;
    fireEvent.change(list, { target: { value: STATUS_LOOKUP } });
    fireEvent.click(screen.getByRole('button', { name: 'Set lookup for Interface status' }));
    await waitFor(() => {
      expect(held.release).not.toBeNull();
    });
    // The channels read again: the lookup is shown where it judges.
    const row = screen.getByText('Interface status').closest('tr');
    if (row === null) throw new Error('no row');
    await waitFor(() => {
      expect(within(row).getByText(STATUS_LOOKUP, { selector: 'span.font-mono' })).toBeDefined();
    });

    // The sensor not yet read again: a set on another row would carry the version before.
    fireEvent.change(screen.getByRole('combobox', { name: 'Lookup for Channel in' }), {
      target: { value: 'custom.door' },
    });
    const other = screen.getByRole('button', { name: 'Set lookup for Channel in' });
    expect(other.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(other);
    expect(patches).toHaveLength(1);

    held.release?.();
    await waitFor(() => {
      expect(other.getAttribute('aria-disabled')).toBe('false');
    });
    fireEvent.click(other);
    await waitFor(() => {
      expect(patches).toHaveLength(2);
    });
    expect(patches.map((call) => [call.url, call.body, call.ifMatch])).toEqual([
      ['/api/v1/objects/9/channels/status', { lookupId: STATUS_LOOKUP }, 'W/"1"'],
      ['/api/v1/objects/9/channels/in', { lookupId: 'custom.door' }, 'W/"2"'],
    ]);
  });
});
