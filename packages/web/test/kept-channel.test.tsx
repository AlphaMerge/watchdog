import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelRecord,
  DeclaredChannel,
  ObjectDetail,
  SensorTypeSummary,
} from '../src/api/types';
import {
  fieldsOf,
  FIXED_REASON,
  fixedReason,
  fixedState,
  type FieldModel,
  type JsonSchema,
  type KeptChannel,
} from '../src/forms/schema';
import { keptAsks, keptId, keptOf } from '../src/routes/detail/kept-channels';
import { ParamsForm } from '../src/routes/detail/ParamsForm';

/**
 * A column put back after an earlier edit took it out (`U-40`).
 *
 * The edit that removed the column kept its channel: the row, its history and what it stores
 * (`P-310`). An entry putting the column back is not in the stored parameters, so `U-34`'s lock
 * left it open, and the core refused the save with a 409 when it came back as the other mode
 * (`P-303`). The form now asks the core which channel the entry lands on
 * (`POST /sensor-types/{id}/channels`), reads the sensor's channel rows for what that channel
 * stores, and holds the entry's mode to it.
 *
 * The schema is `snmp.table`'s shape, written out as `fixed-field.test.tsx` writes it. The stubbed
 * core answers the dry run as `snmp.table` does: column `6` is channel `col6`, a counter when the
 * column says so.
 */

const MODE: JsonSchema = {
  enum: ['gauge', 'counter'],
  default: 'gauge',
  'x-createOnly': true,
  title: 'Reading type',
};

const COLUMN: JsonSchema = {
  type: 'object',
  title: 'Column',
  required: ['column', 'name'],
  'x-entryKey': 'column',
  properties: {
    column: { type: 'string', title: 'Column' },
    name: { type: 'string', minLength: 1, title: 'Channel name' },
    mode: MODE,
  },
};

const TABLE: JsonSchema = {
  type: 'object',
  required: ['tableOid', 'columns'],
  properties: {
    tableOid: { type: 'string', title: 'Table OID' },
    columns: { type: 'array', minItems: 1, title: 'Columns', items: COLUMN },
  },
};

/** What the sensor has now: column 10. Column 6, a counter, was taken out by an earlier edit. */
const STORED = {
  tableOid: '1.3.6.1.2.1.2.2.1',
  columns: [{ column: '10', name: 'In', mode: 'counter' }],
};

const row = (id: number, key: string, counterBits: number | null): ChannelRecord => ({
  id,
  key,
  name: key,
  unit: '',
  isPrimary: key === 'col10',
  limits: {
    enabled: false,
    upperError: null,
    upperWarning: null,
    lowerWarning: null,
    lowerError: null,
    errorMessage: '',
    warningMessage: '',
  },
  scaleMul: '1',
  scaleDiv: '1',
  decimals: null,
  spikeMin: null,
  spikeMax: null,
  lookupId: null,
  counterBits,
  declaredLookup: null,
  retired: key !== 'col10',
});

/** Column 10's row, and column 6's, kept as a counter. */
const ROWS: ChannelRecord[] = [row(1, 'col10', 64), row(2, 'col6', 64)];

const DETAIL = {
  id: 42,
  kind: 'sensor',
  name: 'Interface 3',
  version: 7,
  sensorType: 'snmp.table',
  params: STORED,
  redactedParams: [],
} as unknown as ObjectDetail;

const TYPE: SensorTypeSummary = {
  id: 'snmp.table',
  category: 'SNMP',
  costHint: 'medium',
  paramsSchema: TABLE as Record<string, unknown>,
  hasPreview: false,
};

/** `snmp.table`'s answer, as the core gives it for these parameters. */
function declare(params: Record<string, unknown>): DeclaredChannel[] {
  const columns = (params['columns'] ?? []) as Record<string, unknown>[];
  return columns.map((column, at) => ({
    key: `col${String(column['column']).replace(/\./g, '_')}`,
    name: String(column['name']),
    unit: '',
    isPrimary: at === 0,
    lookupId: null,
    counterBits: column['mode'] === 'counter' ? 64 : null,
  }));
}

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
}

/**
 * The core: answers the dry run as `snmp.table` would, refuses an entry with no name as a create
 * would, and accepts a save. `held` keeps every dry-run answer back until `release` is called.
 */
function core({ held = false }: { held?: boolean } = {}): {
  sent: Sent[];
  release: () => void;
} {
  const sent: Sent[] = [];
  const waiting: (() => void)[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const path = url.replace(/^.*\/api\/v1/u, '');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    sent.push({ method: init?.method ?? 'GET', path, body });
    const reply = (status: number, payload: unknown): Response =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (path === '/sensor-types/snmp.table/channels') {
      const params = body['params'] as Record<string, unknown>;
      const columns = (params['columns'] ?? []) as Record<string, unknown>[];
      const named = (column: Record<string, unknown>): boolean =>
        typeof column['name'] === 'string' && column['name'] !== '';
      const answer = columns.every(named)
        ? reply(200, { sensorType: 'snmp.table', channels: declare(params) })
        : reply(400, { error: { code: 'OBJECT_INVALID', message: 'params are not valid' } });
      if (!held) return Promise.resolve(answer);
      return new Promise<Response>((resolve) => {
        waiting.push(() => {
          resolve(answer);
        });
      });
    }
    return Promise.resolve(reply(200, { ...DETAIL, version: 8 }));
  });
  return {
    sent,
    release: () => {
      for (const one of waiting.splice(0)) one();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const columnEntries = (): HTMLElement[] =>
  within(screen.getByRole('group', { name: 'Columns' })).getAllByRole('listitem');

/** Adds a column and fills in its key and name, as an operator would. */
function addColumn(column: string, name: string): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
  const added = columnEntries().at(-1);
  if (added === undefined) throw new Error('an added entry expected');
  fireEvent.change(within(added).getByRole('textbox', { name: 'Column' }), {
    target: { value: column },
  });
  fireEvent.change(within(added).getByRole('textbox', { name: 'Channel name' }), {
    target: { value: name },
  });
  return added;
}

const dryRuns = (sent: readonly Sent[]): Sent[] =>
  sent.filter((one) => one.path === '/sensor-types/snmp.table/channels');

const REFUSED =
  'Fixed once the sensor exists: it still has channel “col6” (a counter) from an earlier edit, ' +
  'and this value would make it a gauge, which is refused. Choose the value that keeps it a ' +
  'counter, or add a new sensor to change it.';
const KEPT =
  'Fixed once the sensor exists: it still has channel “col6” (a counter) from an earlier edit; ' +
  'add a new sensor to change it.';

describe('what is kept, and what the field is then (U-40)', () => {
  const mode = (): FieldModel => {
    const field = fieldsOf(COLUMN).find((one) => one.name === 'mode');
    if (field === undefined) throw new Error('no mode field');
    return field;
  };
  const counter: KeptChannel = { key: 'col6', stores: 'counter', declares: 'counter' };
  const turned: KeptChannel = { key: 'col6', stores: 'counter', declares: 'gauge' };

  it.each([
    // [label, kept, value, kind]
    ['nothing said yet', undefined, 'gauge', 'open'],
    ['a column the sensor never had', [], 'gauge', 'open'],
    ['kept, and the value keeps it', [counter], 'counter', 'locked'],
    ['kept, and the value would turn it', [turned], 'gauge', 'refused'],
  ] as const)('%s', (_label, kept, value, kind) => {
    expect(fixedState(mode(), undefined, value, kept).kind).toBe(kind);
  });

  it('locks at the value it holds, and a stored entry is still judged by what is stored', () => {
    expect(fixedState(mode(), undefined, undefined, [counter])).toEqual({
      kind: 'locked',
      value: 'gauge',
      kept: [counter],
    });
    // `existing` wins: an entry the stored parameters name is `U-34`'s, whatever is kept.
    expect(fixedState(mode(), { mode: 'counter' }, 'counter', [turned])).toEqual({
      kind: 'locked',
      value: 'counter',
    });
  });

  it('says which channel and what it stores, and the way to the other value', () => {
    expect(fixedReason({ kind: 'locked', value: 'counter', kept: [counter] })).toBe(KEPT);
    expect(fixedReason({ kind: 'refused', channels: [turned] })).toBe(REFUSED);
    expect(fixedReason({ kind: 'locked', value: 'counter' })).toBe(FIXED_REASON);
    expect(fixedReason({ kind: 'open' })).toBeNull();
    expect(
      fixedReason({
        kind: 'refused',
        channels: [turned, { key: 'col7', stores: 'gauge', declares: 'counter' }],
      }),
    ).toBe(
      'Fixed once the sensor exists: it still has channels “col6” (a counter) and “col7” (a ' +
        'gauge) from an earlier edit, and this value would change what they store, which is ' +
        'refused. Choose the values that keep them as they are, or add a new sensor to change it.',
    );
  });

  it('asks about each entry the stored parameters do not name, with the stored ones', () => {
    const values = {
      ...STORED,
      tableOid: 'half-typed',
      columns: [
        ...STORED.columns,
        { column: '6', name: 'Errors' },
        { column: '6', name: 'Errors again', mode: 'gauge' },
        { name: 'no key yet' },
      ],
    };
    const asks = keptAsks(TABLE, STORED, values);
    // Column 10 is stored, so `U-34`'s; the two 6s are one question (absent is the default);
    // the entry with no key has nothing to ask about.
    expect(asks).toEqual([
      {
        array: 'columns',
        id: JSON.stringify(['columns', '6', ['gauge']]),
        params: { ...STORED, columns: [{ column: '6', name: 'Errors' }] },
      },
    ]);
    expect(keptId('columns', COLUMN, { column: '6', mode: 'counter', name: 'x' })).toBe(
      JSON.stringify(['columns', '6', ['counter']]),
    );
    // Nothing to ask of an array whose entries are not keyed, or hold nothing fixed.
    const { 'x-entryKey': _key, ...unkeyed } = COLUMN;
    expect(
      keptAsks({ properties: { columns: { type: 'array', items: unkeyed } } }, STORED, values),
    ).toEqual([]);
  });

  it('keeps only the declared channels the sensor has a row for', () => {
    const declared = declare({ columns: [{ column: '6' }, { column: '7', mode: 'counter' }] });
    expect(keptOf(declared, ROWS)).toEqual([{ key: 'col6', stores: 'counter', declares: 'gauge' }]);
    expect(keptOf(declared, [])).toEqual([]);
  });
});

describe('the parameters form, with the sensor’s channel rows (U-40)', () => {
  it('holds a column put back to what its kept channel stores, and locks it when it matches', async () => {
    const { sent } = core();
    render(<ParamsForm detail={DETAIL} type={TYPE} channels={ROWS} onSaved={() => undefined} />);
    const added = addColumn('6', 'Errors');
    // The field's region is there and empty while the core is asked (`U-41`): what it then says
    // comes into a region that existed before it.
    const region = added.querySelector<HTMLElement>('p[id$="-fixed"]');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.matches(':empty')).toBe(true);

    // Added at the default, a gauge: the core says it lands on col6, which stores a counter.
    const select = await within(added).findByRole('combobox', {
      name: 'Reading type',
      description: REFUSED,
    });
    expect(dryRuns(sent)).toEqual([
      {
        method: 'POST',
        path: '/sensor-types/snmp.table/channels',
        body: { params: { ...STORED, columns: [{ column: '6', name: 'Errors', mode: 'gauge' }] } },
      },
    ]);
    const reason = within(added).getByText(REFUSED);
    expect(reason).toBe(region);

    // Put to a counter, from the select with focus on it: once the core says that keeps col6 as
    // it is, the field is a read-only box, focus is on it, and the same region says so.
    select.focus();
    fireEvent.change(select, { target: { value: 'counter' } });
    const box = await within(added).findByRole('textbox', { name: 'Reading type' });
    expect((box as HTMLInputElement).readOnly).toBe(true);
    expect((box as HTMLInputElement).value).toBe('counter');
    expect(document.activeElement).toBe(box);
    expect(reason.isConnected).toBe(true);
    expect(reason.textContent).toBe(KEPT);
    expect(box.getAttribute('aria-describedby')?.split(' ')).toContain(reason.id);
    expect(dryRuns(sent)).toHaveLength(2);

    // Its name typed on asks nothing more: the key and the mode are what decide the channel.
    fireEvent.change(within(added).getByRole('textbox', { name: 'Channel name' }), {
      target: { value: 'Errors in' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }));
    await waitFor(() => {
      expect(sent.some((one) => one.method === 'PATCH')).toBe(true);
    });
    expect(dryRuns(sent)).toHaveLength(2);
    expect(sent.find((one) => one.method === 'PATCH')?.body).toEqual({
      kind: 'sensor',
      params: {
        ...STORED,
        columns: [...STORED.columns, { column: '6', name: 'Errors in', mode: 'counter' }],
      },
    });
  });

  it('leaves a column the sensor never had open, and a stored one to what is stored', async () => {
    const { sent } = core();
    render(<ParamsForm detail={DETAIL} type={TYPE} channels={ROWS} onSaved={() => undefined} />);
    const added = addColumn('7', 'Discards');
    await waitFor(() => {
      expect(dryRuns(sent)).toHaveLength(1);
    });
    // Answered (col7), and no row has that key: an ordinary select, nothing said.
    await act(async () => {
      await Promise.resolve();
    });
    const select = within(added).getByRole<HTMLSelectElement>('combobox', {
      name: 'Reading type',
    });
    fireEvent.change(select, { target: { value: 'counter' } });
    expect(select.value).toBe('counter');
    expect(within(added).queryByText(/Fixed once the sensor exists/u)).toBeNull();
    // Column 10 is the stored entry's lock, asked about by nobody.
    const [stored] = columnEntries();
    if (stored === undefined) throw new Error('the stored column expected');
    expect(within(stored).getByRole('textbox', { name: 'Reading type' })).toBeDefined();
    expect(dryRuns(sent).every((one) => !JSON.stringify(one.body).includes('"10"'))).toBe(true);
  });

  it('asks once the entry settles, and again only when an entry the core refused changes', async () => {
    vi.useFakeTimers();
    const { sent } = core();
    render(<ParamsForm detail={DETAIL} type={TYPE} channels={ROWS} onSaved={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    const added = columnEntries()[1];
    if (added === undefined) throw new Error('an added entry expected');
    const key = within(added).getByRole('textbox', { name: 'Column' });
    for (const typed of ['1', '', '6']) fireEvent.change(key, { target: { value: typed } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(dryRuns(sent)).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    // One question, for what settled: column 6 with no name, which the core refuses.
    expect(dryRuns(sent).map((one) => one.body)).toEqual([
      { params: { ...STORED, columns: [{ column: '6', mode: 'gauge' }] } },
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(dryRuns(sent)).toHaveLength(1);
    expect(within(added).queryByText(/Fixed once the sensor exists/u)).toBeNull();

    // Named, the question is a new one, and its answer holds the column.
    fireEvent.change(within(added).getByRole('textbox', { name: 'Channel name' }), {
      target: { value: 'Errors' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(dryRuns(sent)).toHaveLength(2);
    expect(within(added).getByText(REFUSED)).toBeDefined();
  });

  it('does not pull focus back to a field that locks after the operator moved on', async () => {
    const { sent, release } = core({ held: true });
    render(<ParamsForm detail={DETAIL} type={TYPE} channels={ROWS} onSaved={() => undefined} />);
    const added = addColumn('6', 'Errors');
    const select = within(added).getByRole('combobox', { name: 'Reading type' });
    select.focus();
    fireEvent.change(select, { target: { value: 'counter' } });
    await waitFor(() => {
      expect(dryRuns(sent)).toHaveLength(1);
    });
    // On to the name while the core thinks.
    const name = within(added).getByRole('textbox', { name: 'Channel name' });
    name.focus();
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const box = await within(added).findByRole('textbox', { name: 'Reading type' });
    expect((box as HTMLInputElement).readOnly).toBe(true);
    expect(document.activeElement).toBe(name);
  });

  it('asks nothing without the channel rows, or with none', async () => {
    vi.useFakeTimers();
    const { sent } = core();
    const { unmount } = render(
      <ParamsForm detail={DETAIL} type={TYPE} onSaved={() => undefined} />,
    );
    addColumn('6', 'Errors');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    unmount();
    render(<ParamsForm detail={DETAIL} type={TYPE} channels={[]} onSaved={() => undefined} />);
    addColumn('6', 'Errors');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(sent).toEqual([]);
  });
});
