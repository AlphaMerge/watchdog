import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SchemaForm } from '../src/forms/SchemaForm';
import type { JsonSchema } from '../src/forms/schema';

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
