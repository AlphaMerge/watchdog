import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObjectDetail, SensorTypeSummary } from '../src/api/types';
import { SchemaForm } from '../src/forms/SchemaForm';
import type { JsonSchema } from '../src/forms/schema';
import { AddSensor } from '../src/routes/AddSensor';
import { ParamsForm } from '../src/routes/detail/ParamsForm';

/**
 * The repeating control, driven the way an operator drives it (`U-12`).
 *
 * The path arithmetic is covered without React in `schema-form.test.ts`. What is here is what
 * only a rendered form can show: that adding, removing and reordering write the array the schema
 * asked for, that an entry's controls are labelled well enough to reach from a keyboard, and that
 * a nested array inside an entry works — which is the shape `rest.custom.extract` actually has,
 * and the reason this could not be a bespoke editor per sensor type.
 */

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      // Plural on the fieldset, singular on the entry — which is the distinction `items.title`
      // exists for, and giving both the same word here would let the fallback pass for it.
      title: 'Steps',
      maxItems: 2,
      items: {
        // The entry's own noun. Nothing can derive "Step" from "Steps" without guessing at
        // English plurals, so a type author writes it here and the buttons read "Remove Step 2"
        // instead of "Remove Steps 2".
        title: 'Step',
        type: 'object',
        properties: {
          method: { enum: ['GET', 'POST'], default: 'GET' },
          path: { type: 'string' },
          headers: { type: 'array', title: 'Headers', items: { type: 'string', title: 'Header' } },
        },
      },
    },
  },
};

/** The form with its own state, so a change round-trips exactly as the real page makes it. */
function Harness({
  initial = {},
  schema = SCHEMA,
}: {
  initial?: Record<string, unknown>;
  schema?: JsonSchema;
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
      />
      <pre data-testid="values">{JSON.stringify(values)}</pre>
    </>
  );
}

const stored = (): unknown => JSON.parse(screen.getByTestId('values').textContent);

describe('a repeating parameter', () => {
  it('starts empty and says so, rather than showing a blank fieldset', () => {
    render(<Harness />);
    expect(screen.getByText('Nothing here yet.')).toBeDefined();
    expect(stored()).toEqual({});
  });

  it('adds an entry seeded from the item schema’s defaults', () => {
    // The core applies and stores defaults at validation time; an entry that started somewhere
    // else would show one thing and save another.
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    expect(stored()).toEqual({ steps: [{ method: 'GET' }] });
  });

  it('writes an entry’s field into the array, not into an object keyed "0"', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    fireEvent.change(screen.getByLabelText('Path'), { target: { value: '/health' } });
    expect(stored()).toEqual({ steps: [{ method: 'GET', path: '/health' }] });
  });

  it('clears an optional field inside an entry with "—", and keeps the entry (U-39)', () => {
    // The walk used to stop at the array and hand the parameters back unchanged, so the choice
    // was ignored without a word and the select snapped back to what it held.
    render(<Harness initial={{ steps: [{ method: 'POST', path: '/a' }, { method: 'POST' }] }} />);
    const [, second] = within(screen.getByRole('group', { name: 'Steps' })).getAllByRole(
      'listitem',
    );
    if (second === undefined) throw new Error('two entries expected');
    const method = within(second).getByRole('combobox', { name: 'Method' });
    fireEvent.change(method, { target: { value: '' } });
    expect(stored()).toEqual({ steps: [{ method: 'POST', path: '/a' }, {}] });
    expect((method as HTMLSelectElement).value).toBe('');
    // Still two entries, the cleared one still there to fill in or remove.
    expect(screen.getByRole('button', { name: 'Remove Step 2' })).toBeDefined();
  });

  it('reorders by one position, from a button a keyboard can reach', () => {
    // Order is meaningful — a transaction's steps run in order — so it has to be changeable, and
    // `U-11`'s WCAG pass rules out a drag target as the only way to do it.
    render(<Harness initial={{ steps: [{ path: 'first' }, { path: 'second' }] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move Step 2 up' }));
    expect(stored()).toEqual({ steps: [{ path: 'second' }, { path: 'first' }] });
  });

  it('cannot move the first entry up or the last one down', () => {
    render(<Harness initial={{ steps: [{ path: 'a' }, { path: 'b' }] }} />);
    expect(screen.getByRole('button', { name: 'Move Step 1 up' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Move Step 2 down' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('removes the entry that was asked for, not the last one', () => {
    render(<Harness initial={{ steps: [{ path: 'a' }, { path: 'b' }, { path: 'c' }] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Step 2' }));
    expect(stored()).toEqual({ steps: [{ path: 'a' }, { path: 'c' }] });
  });

  it('drops the parameter entirely when the last entry goes', () => {
    // An absent optional array and an empty one are different things to the schema, and `params`
    // is replaced wholesale on save — so an emptied array must not be stored as `[]`.
    render(<Harness initial={{ steps: [{ path: 'a' }] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Step 1' }));
    expect(stored()).toEqual({});
  });

  it('stops at maxItems, and says why the button is off', () => {
    render(<Harness />);
    const add = screen.getByRole('button', { name: 'Add step' });
    fireEvent.click(add);
    fireEvent.click(add);
    expect(add.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('2 is the most this parameter takes.')).toBeDefined();
  });

  it('nests: an array inside an entry of an array', () => {
    // `rest.custom.extract` and `http.transaction.steps` are this shape, which is why the entry
    // renders through the same `Field` as everything else rather than through an editor of its
    // own — nesting falls out instead of being built.
    render(<Harness initial={{ steps: [{ path: 'a' }] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    fireEvent.change(screen.getByLabelText('Header 1'), { target: { value: 'accept: json' } });
    expect(stored()).toEqual({ steps: [{ path: 'a', headers: ['accept: json'] }] });
  });

  it('keeps two entries’ fields apart', () => {
    // The failure this catches is silent and total: entries sharing a path means every keystroke
    // in one lands in all of them.
    render(<Harness initial={{ steps: [{ path: 'a' }, { path: 'b' }] }} />);
    const items = screen.getAllByRole('listitem');
    fireEvent.change(within(items[1] as HTMLElement).getByLabelText('Path'), {
      target: { value: 'changed' },
    });
    expect(stored()).toEqual({ steps: [{ path: 'a' }, { path: 'changed' }] });
  });

  it('falls back to the parameter’s own label when the item names nothing', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { hosts: { type: 'array', title: 'Hosts', items: { type: 'string' } } },
    };
    render(<Harness schema={schema} initial={{ hosts: ['a'] }} />);
    expect(screen.getByRole('button', { name: 'Remove Hosts 1' })).toBeDefined();
  });

  it('renders an array of plain strings as a list of inputs', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        tags: { type: 'array', title: 'Tags', items: { type: 'string', title: 'Tag' } },
      },
    };
    render(<Harness schema={schema} initial={{ tags: ['one'] }} />);
    fireEvent.change(screen.getByLabelText('Tag 1'), { target: { value: 'two' } });
    expect(stored()).toEqual({ tags: ['two'] });
  });

  it('clears a tag to empty, and keeps the entry (U-41)', () => {
    // The control said "absent" and the entry cannot be absent, so the clear was ignored and the
    // last character came back under the caret.
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        args: { type: 'array', title: 'Arguments', items: { type: 'string', title: 'Argument' } },
      },
    };
    render(<Harness schema={schema} initial={{ args: ['x', '-v'] }} />);
    const box = screen.getByRole<HTMLInputElement>('textbox', { name: 'Argument 1' });
    fireEvent.change(box, { target: { value: '' } });
    expect(box.value).toBe('');
    expect(stored()).toStrictEqual({ args: ['', '-v'] });
    expect(screen.getByRole('button', { name: 'Remove Argument 1' })).toBeDefined();
    // No `minLength`: an empty argument is an argument, so leaving it says nothing.
    fireEvent.blur(box);
    expect(box.hasAttribute('aria-invalid')).toBe(false);
    expect(document.getElementById(`${box.id}-problem`)?.textContent).toBe('');
  });

  it('says a cleared entry its schema refuses cannot be empty, announced and tied to it', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        zones: {
          type: 'array',
          title: 'Blocklists',
          items: { type: 'string', title: 'Blocklist', minLength: 3 },
        },
      },
    };
    render(<Harness schema={schema} initial={{ zones: ['zen.spamhaus.org', 'bl.spamcop.net'] }} />);
    const box = screen.getByRole<HTMLInputElement>('textbox', { name: 'Blocklist 2' });
    // The live region is there, empty, before anything is wrong: one added with its text already
    // in it is not announced.
    const region = document.getElementById(`${box.id}-problem`);
    if (region === null) throw new Error('the problem region should exist before a problem');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');
    expect(box.getAttribute('aria-describedby') ?? '').not.toContain(region.id);

    fireEvent.change(box, { target: { value: '' } });
    fireEvent.blur(box);
    expect(box.value).toBe('');
    expect(stored()).toStrictEqual({ zones: ['zen.spamhaus.org', ''] });
    expect(document.getElementById(`${box.id}-problem`)).toBe(region);
    expect(region.textContent).toBe('cannot be empty: type a value, or remove the entry');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect((box.getAttribute('aria-describedby') ?? '').split(' ')).toContain(region.id);

    // Typed again, the problem goes and the description with it.
    fireEvent.change(box, { target: { value: 'b.barracudacentral.org' } });
    expect(region.textContent).toBe('');
    expect(box.hasAttribute('aria-invalid')).toBe(false);
    expect(box.getAttribute('aria-describedby') ?? '').not.toContain(region.id);
  });

  it.each([
    // [label, schema, initial, role, name, stored after the clear, typed again]
    [
      'a number entry',
      {
        type: 'object',
        properties: {
          ports: {
            type: 'array',
            title: 'Ports',
            items: { type: 'integer', title: 'Port', minimum: 1 },
          },
        },
      },
      { ports: [80, 443] },
      'spinbutton',
      'Port 2',
      { ports: [80, ''] },
      '8443',
    ],
    [
      'a JSON entry',
      {
        type: 'object',
        properties: {
          rows: { type: 'array', title: 'Rows', items: { type: 'object', title: 'Row' } },
        },
      },
      { rows: [{ a: 1 }, { b: 2 }] },
      'textbox',
      'Row 2',
      { rows: [{ a: 1 }, ''] },
      '{"c": 3}',
    ],
  ] as const)(
    'says what to do with %s cleared, announced and tied to it (U-44)',
    (_label, schema, initial, role, name, cleared, typed) => {
      // It used to read "required", which is true of every entry and says nothing to someone who
      // has just emptied the box.
      render(<Harness schema={schema as JsonSchema} initial={structuredClone(initial)} />);
      const box = screen.getByRole<HTMLInputElement>(role, { name });
      const region = document.getElementById(`${box.id}-problem`);
      if (region === null) throw new Error('the problem region should exist before a problem');
      expect(region.getAttribute('aria-live')).toBe('polite');
      expect(region.textContent).toBe('');

      fireEvent.change(box, { target: { value: '' } });
      fireEvent.blur(box);
      expect(stored()).toStrictEqual(cleared);
      expect(screen.getByRole('button', { name: `Remove ${name}` })).toBeDefined();
      // The same node, which existed empty before: a live region added with its text already in
      // it is not announced.
      expect(document.getElementById(`${box.id}-problem`)).toBe(region);
      expect(region.textContent).toBe('cannot be empty: type a value, or remove the entry');
      expect(screen.getByText('cannot be empty: type a value, or remove the entry')).toBe(region);
      expect(box.getAttribute('aria-invalid')).toBe('true');
      expect((box.getAttribute('aria-describedby') ?? '').split(' ')).toContain(region.id);

      fireEvent.change(box, { target: { value: typed } });
      expect(region.textContent).toBe('');
      expect(box.hasAttribute('aria-invalid')).toBe(false);
      expect(box.getAttribute('aria-describedby') ?? '').not.toContain(region.id);
    },
  );

  it('still shows a JSON box for an array whose entries are undescribed', () => {
    // Where "add an entry" has nothing to add, the honest control is the one that hands the
    // operator the value — the same rule a free-form object follows, and the reason `U-08`'s
    // fallback exists at all.
    const schema: JsonSchema = { type: 'object', properties: { loose: { type: 'array' } } };
    render(<Harness schema={schema} initial={{ loose: [1, 2] }} />);
    expect(screen.queryByRole('button', { name: /^Add / })).toBeNull();
    expect(screen.getByLabelText('Loose').textContent).toContain('[');
  });
});

describe('a cleared entry, saved (U-41)', () => {
  // The shapes `dns.blocklist`'s zones and `exe.script`'s arguments declare: the first refuses
  // `''`, the second takes it as an empty argument.
  const LISTS: JsonSchema = {
    type: 'object',
    required: ['zones'],
    properties: {
      zones: {
        type: 'array',
        minItems: 1,
        title: 'Blocklists',
        items: { title: 'Blocklist', type: 'string', minLength: 3, maxLength: 253 },
      },
      args: {
        type: 'array',
        default: [],
        title: 'Arguments',
        items: { title: 'Argument', type: 'string', maxLength: 1_000 },
      },
    },
  };

  const typeOf = (): SensorTypeSummary => ({
    id: 'test.lists',
    category: 'Custom',
    costHint: 'light',
    paramsSchema: LISTS as Record<string, unknown>,
    hasPreview: false,
  });

  const detailOf = (params: Record<string, unknown>): ObjectDetail =>
    ({
      id: 51,
      kind: 'sensor',
      name: 'Lists',
      version: 3,
      sensorType: 'test.lists',
      params,
      redactedParams: [],
    }) as unknown as ObjectDetail;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends an empty argument as one, where the schema accepts it', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', (_path: string, init?: RequestInit) => {
      bodies.push(typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined);
      return Promise.resolve(
        new Response(JSON.stringify({ id: 51, kind: 'sensor', version: 4 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    const saved = vi.fn();
    render(
      <ParamsForm
        detail={detailOf({ zones: ['zen.spamhaus.org'], args: ['x', '-v'] })}
        type={typeOf()}
        onSaved={saved}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Argument 1' }), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }));

    await waitFor(() => {
      expect(saved).toHaveBeenCalledTimes(1);
    });
    expect(bodies).toStrictEqual([
      { kind: 'sensor', params: { zones: ['zen.spamhaus.org'], args: ['', '-v'] } },
    ]);
  });

  it('does not send a cleared zone, and says which field needs attention', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(
      <ParamsForm
        detail={detailOf({ zones: ['zen.spamhaus.org', 'bl.spamcop.net'] })}
        type={typeOf()}
        onSaved={() => undefined}
      />,
    );
    const box = screen.getByRole<HTMLInputElement>('textbox', { name: 'Blocklist 2' });
    fireEvent.change(box, { target: { value: '' } });
    expect(box.value).toBe('');

    // Before the box is left: the check before submit already holds the save back.
    const save = screen.getByRole('button', { name: 'Save parameters' });
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('1 field needs attention')).toBeDefined();
    fireEvent.click(save);
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.blur(box);
    expect(document.getElementById(`${box.id}-problem`)?.textContent).toBe(
      'cannot be empty: type a value, or remove the entry',
    );

    // Removing the entry is the other way out, and it may then be saved.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Blocklist 2' }));
    expect(save.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText('1 field needs attention')).toBeNull();
  });
});

describe('the problem region, while it says nothing (U-45)', () => {
  // jsdom lays nothing out, so what is asserted is what the layout rests on: no stack around the
  // region to give it or its neighbour a margin, its own margin only while it has children, and
  // nothing that would take it out of the accessibility tree.
  const BOTH: JsonSchema = {
    type: 'object',
    properties: {
      host: { type: 'string', title: 'Host', minLength: 3, description: 'Where it is.' },
      zones: {
        type: 'array',
        title: 'Blocklists',
        items: { type: 'string', title: 'Blocklist', minLength: 3 },
      },
    },
  };

  const regionOf = (box: HTMLElement): HTMLElement => {
    const region = document.getElementById(`${box.id}-problem`);
    if (region === null) throw new Error('the problem region should always be rendered');
    return region;
  };

  it('is in the DOM, empty and taking no space, under a field and under an entry', () => {
    render(<Harness schema={BOTH} initial={{ host: 'core', zones: ['zen.spamhaus.org'] }} />);
    const boxes = [
      screen.getByRole('textbox', { name: 'Host' }),
      screen.getByRole('textbox', { name: 'Blocklist 1' }),
    ];
    for (const box of boxes) {
      const region = regionOf(box);
      // No children at all, not even an empty text node, or `empty:` would not match.
      expect(region.matches(':empty')).toBe(true);
      expect(region.classList.contains('mt-1')).toBe(true);
      expect(region.classList.contains('empty:mt-0')).toBe(true);
      // Outside any stack: `space-y-*` puts a margin on every child but the last.
      expect(region.parentElement?.className ?? '').not.toContain('space-y-');
      // Still there to be announced.
      expect(region.getAttribute('aria-live')).toBe('polite');
      expect(region.hidden).toBe(false);
      expect(region.hasAttribute('aria-hidden')).toBe(false);
      expect(region.classList.contains('hidden')).toBe(false);
      expect(region.classList.contains('sr-only')).toBe(false);
      expect(getComputedStyle(region).display).not.toBe('none');
    }
  });

  it('takes its margin while it says something, and gives it back after', () => {
    render(<Harness schema={BOTH} initial={{ host: 'core' }} />);
    const box = screen.getByRole<HTMLInputElement>('textbox', { name: 'Host' });
    const region = regionOf(box);
    fireEvent.change(box, { target: { value: 'ab' } });
    fireEvent.blur(box);
    expect(region.textContent).toBe('must be at least 3 characters');
    expect(region.matches(':empty')).toBe(false);

    fireEvent.change(box, { target: { value: 'core.example' } });
    expect(document.getElementById(`${box.id}-problem`)).toBe(region);
    expect(region.matches(':empty')).toBe(true);
  });
});

describe('a JSON entry’s text follows its value (U-47)', () => {
  // An object entry without properties is a JSON box per entry. Entries are keyed by position, so
  // a Move or a Remove keeps every box mounted and hands it another entry's value; and a form
  // mounted afresh builds each box's text from what is stored.
  const ROWS: JsonSchema = {
    type: 'object',
    properties: {
      rows: { type: 'array', title: 'Rows', items: { type: 'object', title: 'Row' } },
    },
  };
  const EMPTY = 'cannot be empty: type a value, or remove the entry';
  const box = (name: string): HTMLTextAreaElement =>
    screen.getByRole<HTMLTextAreaElement>('textbox', { name });
  const problemOf = (name: string): string | null | undefined =>
    document.getElementById(`${box(name).id}-problem`)?.textContent;
  const shown = (value: unknown): string => JSON.stringify(value, null, 2);

  it('shows a cleared entry, moved, as an empty box, and still says why', () => {
    render(<Harness schema={ROWS} initial={{ rows: [{ a: 1 }, { b: 2 }] }} />);
    fireEvent.change(box('Row 2'), { target: { value: '' } });
    fireEvent.blur(box('Row 2'));
    expect(problemOf('Row 2')).toBe(EMPTY);

    fireEvent.click(screen.getByRole('button', { name: 'Move Row 2 up' }));
    expect(stored()).toStrictEqual({ rows: ['', { a: 1 }] });
    // Not `""`, which the operator never typed; and the other box shows the entry now beside it.
    expect(box('Row 1').value).toBe('');
    expect(box('Row 2').value).toBe(shown({ a: 1 }));

    fireEvent.blur(box('Row 1'));
    expect(problemOf('Row 1')).toBe(EMPTY);
    expect(box('Row 1').getAttribute('aria-invalid')).toBe('true');
  });

  it('shows a cleared entry as an empty box in a form mounted afresh', () => {
    const first = render(<Harness schema={ROWS} initial={{ rows: [{ a: 1 }, { b: 2 }] }} />);
    fireEvent.change(box('Row 2'), { target: { value: '' } });
    const held = stored() as Record<string, unknown>;
    expect(held).toStrictEqual({ rows: [{ a: 1 }, ''] });
    first.unmount();

    render(<Harness schema={ROWS} initial={held} />);
    expect(box('Row 1').value).toBe(shown({ a: 1 }));
    expect(box('Row 2').value).toBe('');
    fireEvent.blur(box('Row 2'));
    expect(problemOf('Row 2')).toBe(EMPTY);
  });

  it('shows the entry now at its position after a Remove above it', () => {
    render(<Harness schema={ROWS} initial={{ rows: [{ a: 1 }, { b: 2 }] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Row 1' }));
    expect(stored()).toStrictEqual({ rows: [{ b: 2 }] });
    expect(box('Row 1').value).toBe(shown({ b: 2 }));
  });

  it('keeps what is typed, valid or not, through a render that leaves its value alone', () => {
    render(<Harness schema={ROWS} initial={{ rows: [{ a: 1 }, { b: 2 }] }} />);
    // Unparseable: the value stays the last valid one, and the text is the operator's.
    fireEvent.change(box('Row 1'), { target: { value: '{"a": ' } });
    // Valid, in a spelling of its own: kept as typed, not re-serialised.
    fireEvent.change(box('Row 2'), { target: { value: '{"b":3}' } });
    expect(stored()).toStrictEqual({ rows: [{ a: 1 }, { b: 3 }] });
    expect(box('Row 1').value).toBe('{"a": ');
    expect(box('Row 2').value).toBe('{"b":3}');
  });

  it('takes `""` typed into an entry as the cleared value it stores, and keeps the text', () => {
    // An entry cannot hold the JSON string "" apart from a clear: both store `''` (`U-41`), and
    // `U-44` judges an entry's `''` as emptied. The text stays as typed while it is typed.
    render(<Harness schema={ROWS} initial={{ rows: [{ a: 1 }] }} />);
    fireEvent.change(box('Row 1'), { target: { value: '""' } });
    fireEvent.blur(box('Row 1'));
    expect(stored()).toStrictEqual({ rows: [''] });
    expect(box('Row 1').value).toBe('""');
    expect(problemOf('Row 1')).toBe(EMPTY);
  });

  it('shows `""` outside an entry, where a clear removes the value and `\'\'` is a string', () => {
    const schema: JsonSchema = { type: 'object', properties: { extra: { title: 'Extra' } } };
    render(<Harness schema={schema} initial={{ extra: '' }} />);
    expect(box('Extra').value).toBe('""');
    fireEvent.change(box('Extra'), { target: { value: '' } });
    expect(stored()).toStrictEqual({});
    expect(box('Extra').value).toBe('');
  });

  it('keeps spaces and line breaks typed into an emptied entry (U-47 review)', () => {
    // The emptied box hands the form "absent", which an entry holds as `''`; the box used to read
    // that `''` as a new value and rebuild its text, eating each space or Enter as it was typed.
    render(<Harness schema={ROWS} initial={{ rows: [{ a: 1 }] }} />);
    fireEvent.change(box('Row 1'), { target: { value: '' } });
    fireEvent.change(box('Row 1'), { target: { value: ' ' } });
    expect(box('Row 1').value).toBe(' ');
    fireEvent.change(box('Row 1'), { target: { value: ' \n' } });
    expect(box('Row 1').value).toBe(' \n');
    expect(stored()).toStrictEqual({ rows: [''] });
    fireEvent.change(box('Row 1'), { target: { value: ' \n{"c": 3}' } });
    expect(stored()).toStrictEqual({ rows: [{ c: 3 }] });
    expect(box('Row 1').value).toBe(' \n{"c": 3}');
  });
});

describe('an entry keeps its controls wherever it goes (U-47 review)', () => {
  // Entries are keyed by identity, not position, so a control and what it holds beside the value
  // move with its entry — even past a neighbour holding the same value, which a box comparing
  // values alone cannot tell apart.
  const ROWS: JsonSchema = {
    type: 'object',
    properties: {
      rows: { type: 'array', title: 'Rows', items: { type: 'object', title: 'Row' } },
    },
  };
  const BROKEN = 'Not valid JSON — the last valid value will be saved.';
  const box = (name: string): HTMLTextAreaElement =>
    screen.getByRole<HTMLTextAreaElement>('textbox', { name });
  const brokenIn = (item: HTMLElement): boolean => within(item).queryByText(BROKEN) !== null;
  const rows = (): HTMLElement[] =>
    within(screen.getByRole('group', { name: 'Rows' })).getAllByRole('listitem');
  const button = (name: string): HTMLElement => screen.getByRole('button', { name });

  it('shows the surviving entry after a Remove above it, not the removed one’s typing', () => {
    render(<Harness schema={ROWS} />);
    fireEvent.click(button('Add row'));
    fireEvent.click(button('Add row'));
    expect(stored()).toStrictEqual({ rows: [{}, {}] });
    fireEvent.change(box('Row 1'), { target: { value: '{"x": ' } });
    expect(brokenIn(rows()[0] as HTMLElement)).toBe(true);

    fireEvent.click(button('Remove Row 1'));
    expect(stored()).toStrictEqual({ rows: [{}] });
    expect(box('Row 1').value).toBe('{}');
    expect(brokenIn(rows()[0] as HTMLElement)).toBe(false);
  });

  it('moves a box’s typing with its entry past a neighbour of the same value', () => {
    render(<Harness schema={ROWS} />);
    fireEvent.click(button('Add row'));
    fireEvent.click(button('Add row'));
    const typed = box('Row 2');
    fireEvent.change(typed, { target: { value: '{"x": ' } });

    fireEvent.click(button('Move Row 2 up'));
    expect(stored()).toStrictEqual({ rows: [{}, {}] });
    // The same box, now first, with its text and its warning; the untouched one second.
    expect(box('Row 1')).toBe(typed);
    expect(typed.value).toBe('{"x": ');
    expect(brokenIn(rows()[0] as HTMLElement)).toBe(true);
    expect(box('Row 2').value).toBe('{}');
    expect(brokenIn(rows()[1] as HTMLElement)).toBe(false);
  });

  it('keeps an object entry’s controls mounted through a Move', () => {
    render(<Harness initial={{ steps: [{ path: 'a' }, { path: 'b' }] }} />);
    const steps = (): HTMLElement[] =>
      within(screen.getByRole('group', { name: 'Steps' })).getAllByRole('listitem');
    const path = within(steps()[1] as HTMLElement).getByRole('textbox', { name: 'Path' });
    fireEvent.click(button('Move Step 2 up'));
    expect(stored()).toStrictEqual({ steps: [{ path: 'b' }, { path: 'a' }] });
    expect(within(steps()[0] as HTMLElement).getByRole('textbox', { name: 'Path' })).toBe(path);
  });

  it('keeps the controls of an object inside an entry mounted through a Move', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        hops: {
          type: 'array',
          title: 'Hops',
          items: {
            type: 'object',
            title: 'Hop',
            properties: {
              auth: { type: 'object', title: 'Auth', properties: { user: { type: 'string' } } },
            },
          },
        },
      },
    };
    render(<Harness schema={schema} initial={{ hops: [{ auth: { user: 'a' } }, { auth: {} }] }} />);
    const hops = (): HTMLElement[] =>
      within(screen.getByRole('group', { name: 'Hops' })).getAllByRole('listitem');
    const user = within(hops()[1] as HTMLElement).getByRole('textbox', { name: 'User' });
    fireEvent.click(button('Move Hop 2 up'));
    expect(stored()).toStrictEqual({ hops: [{ auth: {} }, { auth: { user: 'a' } }] });
    expect(within(hops()[0] as HTMLElement).getByRole('textbox', { name: 'User' })).toBe(user);
  });

  it.each([
    // [entries, pressed, focused after]
    [3, 'Move Row 1 down', 'Move Row 2 down'],
    [3, 'Move Row 3 up', 'Move Row 2 up'],
    // At the top "up" is disabled, so the entry's first enabled button.
    [2, 'Move Row 2 up', 'Move Row 1 down'],
    // At the bottom "down" is: "up" comes first.
    [2, 'Move Row 1 down', 'Move Row 2 up'],
    // The entry that took the removed one's place, or the last when the last went.
    [2, 'Remove Row 1', 'Remove Row 1'],
    [2, 'Remove Row 2', 'Remove Row 1'],
    [1, 'Remove Row 1', 'Add row'],
  ] as const)('with %i entries, %s leaves focus on %s', (count, pressed, after) => {
    render(<Harness schema={ROWS} initial={{ rows: Array.from({ length: count }, () => ({})) }} />);
    const target = button(pressed);
    target.focus();
    fireEvent.click(target);
    expect(document.activeElement).toBe(button(after));
  });

  it('leaves focus alone when the change came from outside the list', () => {
    render(<Harness schema={ROWS} initial={{ rows: [{}, {}] }} />);
    const outside = screen.getByTestId('values');
    outside.tabIndex = -1;
    outside.focus();
    fireEvent.click(button('Move Row 2 up'));
    expect(document.activeElement).toBe(outside);
  });
});

describe('a problem shown on an entry goes with the entry (U-49)', () => {
  // What the operator has left is kept by path, and a path carries its entry's position: a Move
  // used to leave the message with the position, on an entry nobody had touched, while the
  // emptied entry said nothing until it was left again.
  const ROWS: JsonSchema = {
    type: 'object',
    properties: {
      rows: { type: 'array', title: 'Rows', items: { type: 'object', title: 'Row' } },
    },
  };
  const EMPTY = 'cannot be empty: type a value, or remove the entry';
  const box = (name: string): HTMLTextAreaElement =>
    screen.getByRole<HTMLTextAreaElement>('textbox', { name });
  const problemIn = (control: HTMLElement): string | null | undefined =>
    document.getElementById(`${control.id}-problem`)?.textContent;
  const problemOf = (name: string): string | null | undefined => problemIn(box(name));
  const button = (name: string): HTMLElement => screen.getByRole('button', { name });
  const shown = (value: unknown): string => JSON.stringify(value, null, 2);

  it('moves the message with a cleared entry, and leaves none on the one now in its place', () => {
    render(<Harness schema={ROWS} initial={{ rows: [{ a: 1 }, { b: 2 }] }} />);
    const cleared = box('Row 1');
    fireEvent.change(cleared, { target: { value: '' } });
    fireEvent.blur(cleared);
    expect(problemOf('Row 1')).toBe(EMPTY);

    fireEvent.click(button('Move Row 1 down'));
    expect(stored()).toStrictEqual({ rows: [{ b: 2 }, ''] });
    // Without being left again: it was left, and it is the same entry.
    expect(box('Row 2')).toBe(cleared);
    expect(problemOf('Row 2')).toBe(EMPTY);
    expect(cleared.getAttribute('aria-invalid')).toBe('true');
    expect((cleared.getAttribute('aria-describedby') ?? '').split(' ')).toContain(
      `${cleared.id}-problem`,
    );
    // Row 1 now holds the entry that was never touched.
    expect(box('Row 1').value).toBe(shown({ b: 2 }));
    expect(problemOf('Row 1')).toBe('');
    expect(box('Row 1').hasAttribute('aria-invalid')).toBe(false);

    // And back up: it goes with the entry both ways.
    fireEvent.click(button('Move Row 2 up'));
    expect(problemOf('Row 1')).toBe(EMPTY);
    expect(problemOf('Row 2')).toBe('');
  });

  it('does not hand a removed entry’s message to the entry that takes its place', () => {
    render(<Harness schema={ROWS} initial={{ rows: [{ a: 1 }, { b: 2 }] }} />);
    fireEvent.change(box('Row 1'), { target: { value: '' } });
    fireEvent.blur(box('Row 1'));
    // Emptied too, but never left: nothing to say yet.
    fireEvent.change(box('Row 2'), { target: { value: '' } });
    expect(problemOf('Row 1')).toBe(EMPTY);
    expect(problemOf('Row 2')).toBe('');

    fireEvent.click(button('Remove Row 1'));
    expect(stored()).toStrictEqual({ rows: [''] });
    expect(problemOf('Row 1')).toBe('');
    expect(box('Row 1').hasAttribute('aria-invalid')).toBe(false);
    // It says so once it is left, as any entry does.
    fireEvent.blur(box('Row 1'));
    expect(problemOf('Row 1')).toBe(EMPTY);
  });

  it('keeps the message on an entry below a Remove, now one place up', () => {
    render(<Harness schema={ROWS} initial={{ rows: [{ a: 1 }, { b: 2 }] }} />);
    fireEvent.change(box('Row 2'), { target: { value: '' } });
    fireEvent.blur(box('Row 2'));
    fireEvent.click(button('Remove Row 1'));
    expect(stored()).toStrictEqual({ rows: [''] });
    expect(problemOf('Row 1')).toBe(EMPTY);
    expect(box('Row 1').getAttribute('aria-invalid')).toBe('true');
  });

  it('moves the message inside an entry’s own list with the outer entry', () => {
    // A path inside a nested array starts with the outer entry's position.
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          title: 'Steps',
          items: {
            type: 'object',
            title: 'Step',
            properties: {
              headers: {
                type: 'array',
                title: 'Headers',
                items: { type: 'string', title: 'Header', minLength: 1 },
              },
            },
          },
        },
      },
    };
    render(
      <Harness schema={schema} initial={{ steps: [{ headers: ['a'] }, { headers: ['b'] }] }} />,
    );
    const headerIn = (step: number): HTMLInputElement => {
      const group = screen.getAllByRole('group', { name: 'Headers' })[step];
      if (group === undefined) throw new Error(`no headers in step ${String(step + 1)}`);
      return within(group).getByRole<HTMLInputElement>('textbox', { name: 'Header 1' });
    };
    const first = headerIn(0);
    fireEvent.change(first, { target: { value: '' } });
    fireEvent.blur(first);
    expect(problemIn(first)).toBe(EMPTY);

    fireEvent.click(button('Move Step 1 down'));
    expect(stored()).toStrictEqual({ steps: [{ headers: ['b'] }, { headers: [''] }] });
    expect(headerIn(1)).toBe(first);
    expect(problemIn(first)).toBe(EMPTY);
    expect(problemIn(headerIn(0))).toBe('');
  });
});

describe('a problem the core named goes with its entry (U-50)', () => {
  // The core names a path in the values it was sent, and a path carries its entry's position: a
  // 400 on `steps.1.path` used to stay on Step 2 after Step 2 moved up, and pass to whatever
  // entry took the place of one removed. Each caller that shows the core's problems, rendered.
  const REFUSED = 'must start with "/"';
  const TYPE: SensorTypeSummary = {
    id: 'test.steps',
    category: 'Custom',
    costHint: 'light',
    paramsSchema: SCHEMA as Record<string, unknown>,
    hasPreview: false,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The core: `GET` answers from `reads`, and any write is refused naming `steps.1.path`. */
  function core(reads: Record<string, unknown> = {}): { writes: () => number } {
    let writes = 0;
    const answer = (status: number, body: unknown): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const path = url.replace(/^.*\/api\/v1/u, '');
      if ((init?.method ?? 'GET') === 'GET') {
        return path in reads
          ? answer(200, reads[path])
          : answer(404, { error: { code: 'NOT_FOUND', message: 'no' } });
      }
      writes += 1;
      return answer(400, {
        error: {
          code: 'VALIDATION',
          message: 'params are not valid',
          correlationId: 'c-50',
          details: { problems: [{ instancePath: '/steps/1/path', message: REFUSED }] },
        },
      });
    });
    return { writes: () => writes };
  }

  const paths = (): HTMLInputElement[] =>
    within(screen.getByRole('group', { name: 'Steps' })).getAllByRole<HTMLInputElement>('textbox', {
      name: 'Path',
    });
  const problemIn = (control: HTMLElement): string | null | undefined =>
    document.getElementById(`${control.id}-problem`)?.textContent;
  const button = (name: string): HTMLElement => screen.getByRole('button', { name });

  /** Step 2's path box, once the core's refusal is on it. */
  async function refusedOnStep2(save: string): Promise<HTMLInputElement> {
    fireEvent.click(button(save));
    const second = paths()[1];
    if (second === undefined) throw new Error('two steps expected');
    await waitFor(() => {
      expect(problemIn(second)).toBe(REFUSED);
    });
    return second;
  }

  /** It follows Step 2 up and back down, and the entry now in its old place says nothing. */
  function followsTheMove(second: HTMLInputElement): void {
    fireEvent.click(button('Move Step 2 up'));
    expect(paths()[0]).toBe(second);
    expect(second.value).toBe('/b');
    expect(problemIn(second)).toBe(REFUSED);
    expect(second.getAttribute('aria-invalid')).toBe('true');
    expect((second.getAttribute('aria-describedby') ?? '').split(' ')).toContain(
      `${second.id}-problem`,
    );
    const other = paths()[1];
    if (other === undefined) throw new Error('two steps expected');
    expect(other.value).toBe('/a');
    expect(problemIn(other)).toBe('');
    expect(other.hasAttribute('aria-invalid')).toBe(false);

    fireEvent.click(button('Move Step 1 down'));
    expect(paths()[1]).toBe(second);
    expect(problemIn(second)).toBe(REFUSED);
    expect(problemIn(other)).toBe('');
  }

  /** Step 2 removed: its problem goes with it, and a step added in its place says nothing. */
  function droppedWithItsEntry(): void {
    fireEvent.click(button('Remove Step 2'));
    expect(paths()).toHaveLength(1);
    expect(screen.queryByText(REFUSED)).toBeNull();
    fireEvent.click(button('Add step'));
    const added = paths()[1];
    if (added === undefined) throw new Error('an added step expected');
    expect(problemIn(added)).toBe('');
    expect(added.hasAttribute('aria-invalid')).toBe(false);
    expect(screen.queryByText(REFUSED)).toBeNull();
  }

  describe('in a sensor’s parameters', () => {
    const detail = {
      id: 51,
      kind: 'sensor',
      name: 'Steps',
      version: 3,
      sensorType: 'test.steps',
      params: {
        steps: [
          { method: 'GET', path: '/a' },
          { method: 'GET', path: '/b' },
        ],
      },
      redactedParams: [],
    } as unknown as ObjectDetail;

    function open(): void {
      render(<ParamsForm detail={detail} type={TYPE} onSaved={() => undefined} />);
      // Something to save: the method of Step 1.
      const [first] = within(screen.getByRole('group', { name: 'Steps' })).getAllByRole(
        'combobox',
        { name: 'Method' },
      );
      if (first === undefined) throw new Error('two steps expected');
      fireEvent.change(first, { target: { value: 'POST' } });
    }

    it('follows Step 2 when it moves up', async () => {
      core();
      open();
      followsTheMove(await refusedOnStep2('Save parameters'));
    });

    it('is dropped with a removed entry', async () => {
      core();
      open();
      await refusedOnStep2('Save parameters');
      droppedWithItsEntry();
    });
  });

  describe('in a sensor being added', () => {
    async function open(): Promise<void> {
      core({
        '/sensor-types': { items: [TYPE] },
        '/objects/4': { id: 4, parentId: 3, kind: 'device', name: 'edge-1', version: 1 },
      });
      render(
        <MemoryRouter initialEntries={['/objects/4/add-sensor']}>
          <Routes>
            <Route path="/objects/:id/add-sensor" element={<AddSensor />} />
          </Routes>
        </MemoryRouter>,
      );
      const type = await screen.findByLabelText('Sensor type');
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Steps' } });
      fireEvent.change(type, { target: { value: 'test.steps' } });
      fireEvent.click(button('Add step'));
      fireEvent.click(button('Add step'));
      const [first, second] = paths();
      if (first === undefined || second === undefined) throw new Error('two steps expected');
      fireEvent.change(first, { target: { value: '/a' } });
      fireEvent.change(second, { target: { value: '/b' } });
    }

    it('follows Step 2 when it moves up', async () => {
      await open();
      followsTheMove(await refusedOnStep2('Create sensor'));
    });

    it('is dropped with a removed entry', async () => {
      await open();
      await refusedOnStep2('Create sensor');
      droppedWithItsEntry();
    });
  });
});
