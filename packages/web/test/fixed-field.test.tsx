import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObjectDetail, SensorTypeSummary } from '../src/api/types';
import { SchemaForm } from '../src/forms/SchemaForm';
import {
  existingEntry,
  FIXED_REASON,
  fieldsOf,
  fixedState,
  type FieldModel,
  type JsonSchema,
} from '../src/forms/schema';
import { modeChangesOf } from '../src/routes/detail/model';
import { ParamsForm } from '../src/routes/detail/ParamsForm';
import { alertSaying } from './support/refusal-region';

/**
 * A parameter fixed once the sensor exists (`U-34`).
 *
 * `snmp.custom`'s `mode` and each `snmp.table` column's `mode` are refused by the core when an
 * edit would change them (`P-303`, `409 OBJECT_CHANNEL_MODE_FIXED`). The form used to leave them
 * open and show the refusal after submit. These hold it to the annotation both read
 * (`x-createOnly`, and `x-entryKey` for an array entry): read-only on an existing sensor, open
 * when adding one, the reason announced with the field, and the 409 said well when it still comes.
 *
 * The schemas are written out here in the shape the two types declare, not imported from
 * `packages/sensors`: the web package does not depend on it, and a test that shared the
 * declaration could not notice the form reading a keyword the catalogue does not write — the
 * catalogue's own test pins that the shipped types carry it.
 */

const MODE: JsonSchema = {
  enum: ['gauge', 'counter'],
  default: 'gauge',
  'x-createOnly': true,
  title: 'Reading type',
  description: 'A gauge is stored as it is read. A counter is stored as a rate.',
};

const CUSTOM: JsonSchema = {
  type: 'object',
  required: ['oid'],
  properties: {
    oid: { type: 'string', minLength: 1, title: 'OID' },
    mode: MODE,
    unit: { type: 'string', default: '', title: 'Unit' },
  },
};

const TABLE: JsonSchema = {
  type: 'object',
  required: ['tableOid', 'columns'],
  properties: {
    tableOid: { type: 'string', title: 'Table OID' },
    columns: {
      type: 'array',
      minItems: 1,
      title: 'Columns',
      items: {
        type: 'object',
        title: 'Column',
        required: ['column', 'name'],
        'x-entryKey': 'column',
        properties: {
          column: { type: 'string', title: 'Column' },
          name: { type: 'string', title: 'Channel name' },
          mode: MODE,
        },
      },
    },
  },
};

const STORED_TABLE = {
  tableOid: '1.3.6.1.2.1.2.2.1',
  columns: [
    { column: '10', name: 'In', mode: 'counter' },
    { column: '8', name: 'Status', mode: 'gauge' },
  ],
};

function Harness({
  schema,
  initial,
  existing,
}: {
  schema: JsonSchema;
  initial: Record<string, unknown>;
  existing?: Record<string, unknown>;
}): React.JSX.Element {
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  return (
    <>
      <SchemaForm
        schema={schema}
        values={values}
        redacted={[]}
        onChange={setValues}
        replacing={new Set()}
        onReplace={() => undefined}
        {...(existing === undefined ? {} : { existing })}
      />
      <pre data-testid="values">{JSON.stringify(values)}</pre>
    </>
  );
}

const values = (): unknown => JSON.parse(screen.getByTestId('values').textContent);
const columnEntries = (): HTMLElement[] =>
  within(screen.getByRole('group', { name: 'Columns' })).getAllByRole('listitem');

/** The read-only box a locked "Reading type" is shown as; throws if it is a select instead. */
const fixedBox = (scope: HTMLElement): HTMLInputElement =>
  within(scope).getByRole('textbox', { name: 'Reading type' });

const modeField = (): FieldModel => {
  const field = fieldsOf(CUSTOM).find((one) => one.name === 'mode');
  if (field === undefined) throw new Error('no mode field');
  return field;
};

describe('which entry a fixed field belongs to, and whether it is locked', () => {
  it('reads the annotation into the field model, and nothing else is fixed', () => {
    const fixed = fieldsOf(CUSTOM).filter((field) => field.createOnly);
    expect(fixed.map((field) => field.path)).toEqual(['mode']);
  });

  it.each([
    // [existing, value, expected kind]
    ['adding: nothing exists', undefined, 'counter', 'open'],
    ['the stored value', { mode: 'counter' }, 'counter', 'locked'],
    ['absent on both sides is the default on both', {}, undefined, 'locked'],
    ['stored absent, held at the default', {}, 'gauge', 'locked'],
    ['held differs from stored', { mode: 'gauge' }, 'counter', 'changed'],
  ] as const)('%s', (_label, existing, value, kind) => {
    expect(fixedState(modeField(), existing, value).kind).toBe(kind);
  });

  it('carries the value it compared when locked, so absent reads as the default', () => {
    expect(fixedState(modeField(), {}, undefined)).toEqual({ kind: 'locked', value: 'gauge' });
    expect(fixedState(modeField(), { mode: 'counter' }, 'counter')).toEqual({
      kind: 'locked',
      value: 'counter',
    });
  });

  it('says what is stored when the form holds something else', () => {
    expect(fixedState(modeField(), { mode: 'gauge' }, 'counter')).toEqual({
      kind: 'changed',
      stored: 'gauge',
    });
  });

  it('leaves an unannotated field open on an existing sensor', () => {
    const unit = fieldsOf(CUSTOM).find((one) => one.name === 'unit');
    if (unit === undefined) throw new Error('no unit field');
    expect(fixedState(unit, { unit: 'C' }, 'F').kind).toBe('open');
  });

  it('matches an array entry to the stored one by its key, not its position', () => {
    const items = TABLE.properties?.['columns']?.items ?? {};
    // Position 0 now, position 1 when stored: still the same column.
    expect(existingEntry(items, { column: '8' }, STORED_TABLE.columns)).toEqual(
      STORED_TABLE.columns[1],
    );
    expect(existingEntry(items, { column: '6' }, STORED_TABLE.columns)).toBeUndefined();
    expect(existingEntry(items, { name: 'no key yet' }, STORED_TABLE.columns)).toBeUndefined();
    // No `x-entryKey`: no entry can be told apart from a new one, so none is matched.
    const { 'x-entryKey': _key, ...unkeyed } = items;
    expect(existingEntry(unkeyed, { column: '8' }, STORED_TABLE.columns)).toBeUndefined();
  });
});

describe('a fixed scalar on an existing sensor (snmp.custom)', () => {
  const stored = { oid: '1.3.6.1.2.1.1.3.0', mode: 'counter', unit: 'octets' };

  it('is a read-only box with the reason as its description, not a select', () => {
    render(<Harness schema={CUSTOM} initial={stored} existing={stored} />);
    const box = screen.getByRole('textbox', { name: 'Reading type' });
    expect(box).toBeInstanceOf(HTMLInputElement);
    expect((box as HTMLInputElement).readOnly).toBe(true);
    expect((box as HTMLInputElement).value).toBe('counter');
    expect(screen.queryByRole('combobox', { name: 'Reading type' })).toBeNull();
  });

  it('is announced with its reason tied by aria-describedby, after the type’s own hint', () => {
    render(<Harness schema={CUSTOM} initial={stored} existing={stored} />);
    const box = screen.getByRole('textbox', { name: 'Reading type' });
    // The computed accessible description, as a screen reader gets it.
    expect(
      screen.getByRole('textbox', {
        name: 'Reading type',
        description: `${String(MODE.description)} ${FIXED_REASON}`,
      }),
    ).toBe(box);
    // Focusable: a disabled control would leave the tab order and its reason with it.
    expect(box.hasAttribute('disabled')).toBe(false);
    box.focus();
    expect(document.activeElement).toBe(box);
  });

  it('cannot be changed by typing into it, and the other fields still can', () => {
    render(<Harness schema={CUSTOM} initial={stored} existing={stored} />);
    const box = screen.getByRole('textbox', { name: 'Reading type' });
    fireEvent.change(box, { target: { value: 'gauge' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Unit' }), { target: { value: 'bits' } });
    expect(values()).toEqual({ ...stored, unit: 'bits' });
  });

  it('is an ordinary select when adding a sensor', () => {
    render(<Harness schema={CUSTOM} initial={{ mode: 'gauge' }} />);
    const select = screen.getByRole('combobox', { name: 'Reading type' });
    fireEvent.change(select, { target: { value: 'counter' } });
    expect(values()).toEqual({ mode: 'counter' });
    expect(screen.queryByText(FIXED_REASON)).toBeNull();
  });
});

describe('a fixed field in a table column (snmp.table)', () => {
  it('locks the columns the sensor has and leaves an added one open', () => {
    render(<Harness schema={TABLE} initial={STORED_TABLE} existing={STORED_TABLE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    const [first, second, added] = columnEntries();
    if (first === undefined || second === undefined || added === undefined) {
      throw new Error('three entries expected');
    }
    expect(fixedBox(first).readOnly).toBe(true);
    expect(fixedBox(first).value).toBe('counter');
    expect(fixedBox(second).value).toBe('gauge');
    const open = within(added).getByRole('combobox', { name: 'Reading type' });
    fireEvent.change(open, { target: { value: 'counter' } });
    expect((values() as typeof STORED_TABLE).columns[2]).toEqual({ mode: 'counter' });
  });

  it('keeps the lock with the column when the columns are reordered', () => {
    // The reason the entry names its key: by position, the move would lock the new first entry's
    // mode with the old first entry's reason and value.
    render(<Harness schema={TABLE} initial={STORED_TABLE} existing={STORED_TABLE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    fireEvent.change(
      within(columnEntries()[2] ?? document.body).getByRole('textbox', { name: 'Column' }),
      { target: { value: '6' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Move Column 3 up' }));
    const [, moved, pushed] = columnEntries();
    if (moved === undefined || pushed === undefined) throw new Error('entries expected');
    expect(within(moved).getByRole('combobox', { name: 'Reading type' })).toBeDefined();
    expect(fixedBox(pushed).value).toBe('gauge');
  });

  it('opens a column whose key is edited to one the sensor does not have', () => {
    render(<Harness schema={TABLE} initial={STORED_TABLE} existing={STORED_TABLE} />);
    const [first] = columnEntries();
    if (first === undefined) throw new Error('an entry expected');
    fireEvent.change(within(first).getByRole('textbox', { name: 'Column' }), {
      target: { value: '16' },
    });
    expect(within(first).getByRole('combobox', { name: 'Reading type' })).toBeDefined();
  });

  it('says what is stored when a key is edited to a column the sensor has as the other mode', () => {
    render(<Harness schema={TABLE} initial={STORED_TABLE} existing={STORED_TABLE} />);
    const [first] = columnEntries();
    if (first === undefined) throw new Error('an entry expected');
    // Column 10 (a counter) retyped as 8, which the sensor has as a gauge.
    fireEvent.change(within(first).getByRole('textbox', { name: 'Column' }), {
      target: { value: '8' },
    });
    const select = within(first).getByRole('combobox', {
      name: 'Reading type',
      description: /where it is “gauge”: saving another value is refused/,
    });
    select.focus();
    fireEvent.change(select, { target: { value: 'gauge' } });
    // Put back, it locks again — and focus moves with it to the read-only box rather than falling
    // to the page with the select it was on (WCAG 2.4.3).
    const box = fixedBox(first);
    expect(box.readOnly).toBe(true);
    expect(document.activeElement).toBe(box);
    // The sentence changed in place, in a polite live region, so the new state is announced.
    const reason = within(first).getByText(FIXED_REASON);
    expect(reason.getAttribute('aria-live')).toBe('polite');
    expect(box.getAttribute('aria-describedby')?.split(' ')).toContain(reason.id);
  });

  it('locks at the default, with focus on the box, when a changed field is set to "—" (U-39)', () => {
    // Column 10 (a counter) retyped as 8, which the sensor has as a gauge: `changed`. "—" is
    // absent, and absent is the default — a gauge — so it is put back, and locks. Until `U-39`
    // the "—" never reached the parameters inside an array and the select kept "counter".
    render(<Harness schema={TABLE} initial={STORED_TABLE} existing={STORED_TABLE} />);
    const [first] = columnEntries();
    if (first === undefined) throw new Error('an entry expected');
    fireEvent.change(within(first).getByRole('textbox', { name: 'Column' }), {
      target: { value: '8' },
    });
    const select = within(first).getByRole('combobox', { name: 'Reading type' });
    select.focus();
    fireEvent.change(select, { target: { value: '' } });
    // The key is gone from the entry, not written as anything; the entry and its neighbour stay.
    expect((values() as typeof STORED_TABLE).columns).toEqual([
      { column: '8', name: 'In' },
      STORED_TABLE.columns[1],
    ]);
    // The box shows the default it compared, not a blank announced as nothing.
    const box = fixedBox(first);
    expect(box.readOnly).toBe(true);
    expect(box.value).toBe('gauge');
    // Focus followed the field from the select to the box (WCAG 2.4.3), and the box carries the
    // reason, in the polite live region the changed sentence was in.
    expect(document.activeElement).toBe(box);
    const reason = within(first).getByText(FIXED_REASON);
    expect(reason.getAttribute('aria-live')).toBe('polite');
    expect(box.getAttribute('aria-describedby')?.split(' ')).toContain(reason.id);
  });

  it('clears an added column’s mode with "—", leaving the column (U-39)', () => {
    render(<Harness schema={TABLE} initial={STORED_TABLE} existing={STORED_TABLE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    const added = columnEntries()[2];
    if (added === undefined) throw new Error('an added entry expected');
    // Seeded at the default, as every added entry is.
    expect((values() as typeof STORED_TABLE).columns[2]).toEqual({ mode: 'gauge' });
    const select = within(added).getByRole('combobox', { name: 'Reading type' });
    fireEvent.change(select, { target: { value: '' } });
    expect((values() as typeof STORED_TABLE).columns).toEqual([...STORED_TABLE.columns, {}]);
    // Open still: nothing is stored for it, so "—" is a choice and not a lock.
    expect(
      within(added).getByRole<HTMLSelectElement>('combobox', { name: 'Reading type' }).value,
    ).toBe('');
  });

  it('leaves focus on a column key whose new value locks the mode', () => {
    // The other way to lock a field: retyping the key of an added column to one the sensor has,
    // holding the same mode. The operator is typing the key; the mode must not take focus.
    render(<Harness schema={TABLE} initial={STORED_TABLE} existing={STORED_TABLE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    const added = columnEntries()[2];
    if (added === undefined) throw new Error('an added entry expected');
    const key = within(added).getByRole('textbox', { name: 'Column' });
    key.focus();
    fireEvent.change(key, { target: { value: '8' } });
    expect(fixedBox(added).readOnly).toBe(true);
    expect(document.activeElement).toBe(key);
  });

  it('shows the default it compared, not a blank, when the form holds the field as absent', () => {
    // A column stored without a mode is a gauge: absent is the default on both sides, so it is
    // locked while the form holds nothing — and the box must read "gauge", not be an empty field
    // announced as nothing. (The core stores defaults; a row from before one was declared may not.)
    const stored = {
      tableOid: '1.3.6.1.2.1.2.2.1',
      columns: [{ column: '8', name: 'Status' }],
    };
    render(<Harness schema={TABLE} initial={stored} existing={stored} />);
    const [only] = columnEntries();
    if (only === undefined) throw new Error('an entry expected');
    expect(fixedBox(only).value).toBe('gauge');
    // Shown, not written: the parameters stay as stored.
    expect(values()).toEqual(stored);
  });

  it('shows the default at the top level too', () => {
    const stored = { oid: '1.3.6.1.2.1.1.3.0', unit: '' };
    render(<Harness schema={CUSTOM} initial={stored} existing={stored} />);
    expect(fixedBox(document.body).value).toBe('gauge');
  });
});

describe('the refusal, when the core still sends it', () => {
  const REFUSAL = {
    error: {
      code: 'OBJECT_CHANNEL_MODE_FIXED',
      message:
        'this edit would turn channel "col8" from a gauge into a counter, which is refused. Add ' +
        'a new sensor with these parameters instead; this one keeps its history',
      correlationId: 'req-77',
      details: {
        sensorType: 'snmp.table',
        channels: [{ key: 'col8', from: 'gauge', to: 'counter' }],
      },
    },
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the channels out of the 409 and nothing out of any other refusal', () => {
    const base = { status: 409, code: 'OBJECT_CHANNEL_MODE_FIXED' };
    expect(modeChangesOf({ ...base, details: REFUSAL.error.details })).toEqual([
      { key: 'col8', from: 'gauge', to: 'counter' },
    ]);
    expect(modeChangesOf({ ...base, details: { channels: [{ key: 'x' }, 'nonsense'] } })).toEqual(
      [],
    );
    expect(modeChangesOf({ ...base, details: {} })).toEqual([]);
    expect(modeChangesOf({ status: 409, code: 'OBJECT_VERSION_CONFLICT', details: {} })).toBeNull();
    expect(modeChangesOf({ status: 400, code: 'OBJECT_CHANNEL_MODE_FIXED', details: {} })).toBe(
      null,
    );
  });

  it('is shown as an alert naming the channel, with the core’s own sentence', async () => {
    // A column taken out by an earlier edit keeps its channel; put back as the other mode it is
    // an entry the stored parameters no longer name, so the form leaves it open and the core
    // refuses it. This is that save.
    const calls: { method: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', (_path: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
      return Promise.resolve(
        new Response(JSON.stringify(REFUSAL), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    const stored = { tableOid: '1.3.6.1.2.1.2.2.1', columns: [{ column: '10', name: 'In' }] };
    const detail = {
      id: 42,
      kind: 'sensor',
      name: 'Interface 3',
      version: 7,
      sensorType: 'snmp.table',
      params: stored,
      redactedParams: [],
    } as unknown as ObjectDetail;
    const type: SensorTypeSummary = {
      id: 'snmp.table',
      category: 'SNMP',
      costHint: 'medium',
      paramsSchema: TABLE as Record<string, unknown>,
      hasPreview: false,
    };
    render(<ParamsForm detail={detail} type={type} onSaved={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    const [, added] = columnEntries();
    if (added === undefined) throw new Error('an added entry expected');
    fireEvent.change(within(added).getByRole('textbox', { name: 'Column' }), {
      target: { value: '8' },
    });
    fireEvent.change(within(added).getByRole('textbox', { name: 'Channel name' }), {
      target: { value: 'Status' },
    });
    fireEvent.change(within(added).getByRole('combobox', { name: 'Reading type' }), {
      target: { value: 'counter' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }));

    const alert = await alertSaying('Not saved: this edit would change what a channel stores.');
    expect(calls.map((call) => call.method)).toEqual(['PATCH']);
    expect(within(alert).getByRole('listitem').textContent).toBe(
      'Channel col8: a gauge cannot become a counter.',
    );
    expect(alert.textContent).toContain(REFUSAL.error.message);
    expect(alert.textContent).toContain('req-77');
  });

  it('saves an snmp.table column set to "—" without a mode, so the core applies its default', async () => {
    // `U-39`: the "—" has to reach the request, not just the screen.
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', (_path: string, init?: RequestInit) => {
      calls.push(typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined);
      return Promise.resolve(
        new Response(JSON.stringify({ id: 44, kind: 'sensor', version: 2 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    const stored = {
      tableOid: '1.3.6.1.2.1.2.2.1',
      columns: [{ column: '10', name: 'In', mode: 'counter' }],
    };
    const detail = {
      id: 44,
      kind: 'sensor',
      name: 'Interface 4',
      version: 1,
      sensorType: 'snmp.table',
      params: stored,
      redactedParams: [],
    } as unknown as ObjectDetail;
    const type: SensorTypeSummary = {
      id: 'snmp.table',
      category: 'SNMP',
      costHint: 'medium',
      paramsSchema: TABLE as Record<string, unknown>,
      hasPreview: false,
    };
    const saved = vi.fn();
    render(<ParamsForm detail={detail} type={type} onSaved={saved} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    const [, added] = columnEntries();
    if (added === undefined) throw new Error('an added entry expected');
    fireEvent.change(within(added).getByRole('textbox', { name: 'Column' }), {
      target: { value: '6' },
    });
    fireEvent.change(within(added).getByRole('textbox', { name: 'Channel name' }), {
      target: { value: 'Errors' },
    });
    fireEvent.change(within(added).getByRole('combobox', { name: 'Reading type' }), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }));

    await waitFor(() => {
      expect(saved).toHaveBeenCalledTimes(1);
    });
    expect(calls).toEqual([
      {
        kind: 'sensor',
        params: {
          tableOid: '1.3.6.1.2.1.2.2.1',
          columns: [
            { column: '10', name: 'In', mode: 'counter' },
            { column: '6', name: 'Errors' },
          ],
        },
      },
    ]);
  });

  it('shows any other refusal as before, as an alert', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: 'OBJECT_VERSION_CONFLICT', message: 'stale' } }),
          { status: 412, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const stored = { oid: '1.3.6.1.2.1.1.3.0', mode: 'gauge', unit: '' };
    const detail = {
      id: 43,
      kind: 'sensor',
      version: 1,
      sensorType: 'snmp.custom',
      params: stored,
      redactedParams: [],
    } as unknown as ObjectDetail;
    const type: SensorTypeSummary = {
      id: 'snmp.custom',
      category: 'SNMP',
      costHint: 'medium',
      paramsSchema: CUSTOM as Record<string, unknown>,
      hasPreview: false,
    };
    render(<ParamsForm detail={detail} type={type} onSaved={() => undefined} />);
    expect(fixedBox(document.body).readOnly).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Unit' }), { target: { value: 'C' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }));
    const alert = await alertSaying('stale');
    expect(alert.textContent).toContain('somebody else changed this sensor');
    expect(within(alert).queryByRole('listitem')).toBeNull();
  });
});
