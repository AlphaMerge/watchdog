import { useCallback, useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObjectDetail, SensorTypeSummary } from '../src/api/types';
import { SchemaForm } from '../src/forms/SchemaForm';
import { fieldsOf, readAt, type JsonSchema } from '../src/forms/schema';
import { allProblems } from '../src/forms/validate';
import { ParamsForm } from '../src/routes/detail/ParamsForm';

/**
 * A secret that is not one string, drawn as what it is (`U-23` review).
 *
 * `writeOnly` was honoured for a scalar alone. The webhook's `secretHeaders` is an object of
 * header names and values, and was drawn as a password box: whatever was typed was held as a
 * string, which the core's schema refuses, so no value the box could take was one it would save.
 * The program method's `secretArgs` is a list, marked at the list, and was drawn as any other: a
 * stored one read "Nothing here yet.", and an entry added there, typed in clear, replaced every
 * stored one on save. The schemas here are the core's (`notifications/methods.ts`), as
 * `GET /notification-methods` sends them.
 *
 * **Clear sends `null`**, the API's unset for a secret of any type. That the core saves it — as
 * the schema's `[]` or `{}`, which is no secret — is the core's to hold, and its
 * `templates.test.ts` does, over the editor's own PUT (`U-23` review round 2): it refused both
 * before, the null meeting a schema that takes a list or an object there.
 */

const WEBHOOK: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: { type: 'string', minLength: 1, maxLength: 2000 },
    secretHeaders: {
      type: 'object',
      writeOnly: true,
      additionalProperties: { type: 'string', maxLength: 2000 },
      default: {},
    },
  },
};

const PROGRAM: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 1000 },
    args: {
      type: 'array',
      title: 'Arguments',
      maxItems: 16,
      items: { type: 'string', title: 'Argument', maxLength: 2000 },
      default: [],
    },
    secretArgs: {
      type: 'array',
      writeOnly: true,
      title: 'Secret arguments',
      maxItems: 16,
      items: { type: 'string', title: 'Secret argument', maxLength: 2000 },
      default: [],
    },
  },
};

/** The form with the state a page keeps for it, the values shown as JSON would send them. */
function Harness({
  schema,
  initial,
  redacted = [],
}: {
  schema: JsonSchema;
  initial: Record<string, unknown>;
  redacted?: readonly string[];
}): React.JSX.Element {
  const [values, setValues] = useState(initial);
  const [replacing, setReplacing] = useState<ReadonlySet<string>>(new Set());
  const onReplace = useCallback((path: string, on: boolean) => {
    setReplacing((held) => {
      const next = new Set(held);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);
  return (
    <>
      <SchemaForm
        schema={schema}
        values={values}
        redacted={redacted}
        onChange={setValues}
        replacing={replacing}
        onReplace={onReplace}
      />
      <pre data-testid="values">{JSON.stringify(values)}</pre>
    </>
  );
}

const sent = (): Record<string, unknown> =>
  JSON.parse(screen.getByTestId('values').textContent) as Record<string, unknown>;
const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name });

describe('a secret that is an object: the webhook’s secret headers', () => {
  it('is typed as JSON and held as the object typed, with what it wants said under the box', () => {
    render(
      <Harness schema={WEBHOOK} initial={{ url: 'https://hooks.example/x', secretHeaders: {} }} />,
    );
    const box = screen.getByRole('textbox', { name: 'Secret headers' });
    expect(box.tagName).toBe('TEXTAREA');
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(
      screen.getByText('Typed as JSON: an object of names and values, such as {"name": "value"}.'),
    ).toBeDefined();

    fireEvent.change(box, { target: { value: '{"Authorization": "Bearer x"}' } });
    expect(sent()['secretHeaders']).toEqual({ Authorization: 'Bearer x' });
    // Text that does not parse is said, and is never held as a string.
    fireEvent.change(box, { target: { value: '{"Authorization": ' } });
    expect(screen.getByText(/Not valid JSON/u)).toBeDefined();
    expect(sent()['secretHeaders']).toEqual({ Authorization: 'Bearer x' });
  });

  it('stored, is kept, replaced as JSON or cleared, never shown', () => {
    render(
      <Harness
        schema={WEBHOOK}
        initial={{ url: 'https://hooks.example/x' }}
        redacted={['secretHeaders']}
      />,
    );
    expect(screen.getByText('set, write-only')).toBeDefined();
    expect(screen.queryByRole('textbox', { name: 'Secret headers' })).toBeNull();

    const replace = button('Replace Secret headers');
    replace.focus();
    fireEvent.click(replace);
    const box = screen.getByRole('textbox', { name: 'Secret headers' });
    expect(document.activeElement).toBe(box);
    expect((box as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(box, { target: { value: '{"X-Token": "t"}' } });
    expect(sent()['secretHeaders']).toEqual({ 'X-Token': 't' });

    fireEvent.click(button('Keep the current one, Secret headers'));
    expect('secretHeaders' in sent()).toBe(false);
    fireEvent.click(button('Clear Secret headers'));
    expect(sent()['secretHeaders']).toBeNull();
    expect(screen.getByText('removed on save')).toBeDefined();
  });
});

describe('a secret that is a list: the program’s secret arguments', () => {
  it('stored, says so, and offers no entry to add until it is replaced', () => {
    render(
      <Harness
        schema={PROGRAM}
        initial={{ path: 'page.sh', args: [] }}
        redacted={['secretArgs']}
      />,
    );
    const list = screen.getByRole('group', { name: 'Secret arguments' });
    expect(within(list).queryByText('Nothing here yet.')).toBeNull();
    expect(within(list).getByText('set, write-only')).toBeDefined();
    expect(within(list).queryByRole('button', { name: /^Add/u })).toBeNull();
    expect(within(list).getByRole('button', { name: 'Clear Secret arguments' })).toBeDefined();
  });

  it('replaced, opens empty with Add focused, takes entries in password boxes, and says they replace the stored ones', () => {
    render(
      <Harness
        schema={PROGRAM}
        initial={{ path: 'page.sh', args: [] }}
        redacted={['secretArgs']}
      />,
    );
    const replace = button('Replace Secret arguments');
    replace.focus();
    fireEvent.click(replace);
    const add = button('Add secret argument');
    expect(document.activeElement).toBe(add);
    expect(
      screen.getByText('What is listed here replaces every stored one on save.'),
    ).toBeDefined();
    // Nothing added: the stored list is kept.
    expect('secretArgs' in sent()).toBe(false);

    fireEvent.click(add);
    const entry = screen.getByLabelText('Secret argument 1');
    expect(entry.getAttribute('type')).toBe('password');
    fireEvent.change(entry, { target: { value: 's3cret' } });
    expect(sent()['secretArgs']).toEqual(['s3cret']);

    const keep = button('Keep the current ones, Secret arguments');
    keep.focus();
    fireEvent.click(keep);
    expect('secretArgs' in sent()).toBe(false);
    expect(screen.getByText('set, write-only')).toBeDefined();
    expect(document.activeElement).toBe(button('Replace Secret arguments'));
  });

  it('cleared, says so at the list and sends null; kept again, sends nothing', () => {
    render(
      <Harness
        schema={PROGRAM}
        initial={{ path: 'page.sh', args: [] }}
        redacted={['secretArgs']}
      />,
    );
    const clear = button('Clear Secret arguments');
    clear.focus();
    fireEvent.click(clear);
    expect(sent()['secretArgs']).toBeNull();
    expect(screen.getByText('removed on save')).toBeDefined();
    const keep = button('Keep the current ones, Secret arguments');
    expect(document.activeElement).toBe(keep);

    fireEvent.click(keep);
    expect('secretArgs' in sent()).toBe(false);
    expect(document.activeElement).toBe(button('Clear Secret arguments'));

    // Replace after Clear starts from keeping, as a single secret's does.
    fireEvent.click(button('Clear Secret arguments'));
    fireEvent.click(button('Replace Secret arguments'));
    expect('secretArgs' in sent()).toBe(false);
  });

  it('not stored, is a list whose entries are typed in password boxes', () => {
    render(<Harness schema={PROGRAM} initial={{ path: 'page.sh', args: [], secretArgs: [] }} />);
    expect(screen.queryByText('set, write-only')).toBeNull();
    expect(screen.queryByRole('button', { name: /Keep the current/u })).toBeNull();
    fireEvent.click(button('Add secret argument'));
    expect(screen.getByLabelText('Secret argument 1').getAttribute('type')).toBe('password');
    // The visible arguments are still visible.
    fireEvent.click(button('Add argument'));
    expect(screen.getByRole('textbox', { name: 'Argument 1' }).getAttribute('type')).toBe('text');
  });
});

describe('a secret that is an object with properties', () => {
  const SCHEMA: JsonSchema = {
    type: 'object',
    properties: {
      login: {
        type: 'object',
        writeOnly: true,
        title: 'Login',
        required: ['user'],
        properties: { user: { type: 'string' }, pass: { type: 'string' } },
      },
    },
  };

  it('is one value, kept or replaced as JSON, and its properties are not missing fields while kept', () => {
    render(<Harness schema={SCHEMA} initial={{}} redacted={['login']} />);
    expect(screen.getByText('set, write-only')).toBeDefined();
    expect(screen.queryByLabelText('User')).toBeNull();
    expect(allProblems(fieldsOf(SCHEMA), {}, readAt, fieldsOf)).toEqual([]);

    fireEvent.click(button('Replace Login'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Login' }), {
      target: { value: '{"user": "u", "pass": "p"}' },
    });
    expect(sent()['login']).toEqual({ user: 'u', pass: 'p' });
  });
});

describe('a sensor’s stored secret, cleared and then replaced (U-23 review)', () => {
  const TYPE: SensorTypeSummary = {
    id: 'ssh.script',
    category: 'SSH',
    costHint: 'medium',
    hasPreview: false,
    paramsSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', title: 'Host' },
        password: { type: 'string', writeOnly: true, title: 'Password' },
      },
    },
  };
  const DETAIL = {
    id: 43,
    kind: 'sensor',
    name: 'Script',
    version: 1,
    sensorType: 'ssh.script',
    params: { host: 'a.example' },
    redactedParams: ['password'],
  } as unknown as ObjectDetail;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is kept by a save that leaves the box Replace opened empty, as after any Replace', async () => {
    const patches: { params: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      patches.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as never);
      return Promise.resolve(
        new Response(JSON.stringify({ ...DETAIL, version: 2 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    render(<ParamsForm detail={DETAIL} type={TYPE} onSaved={() => undefined} />);
    fireEvent.click(button('Clear Password'));
    expect(screen.getByText('removed on save')).toBeDefined();
    fireEvent.click(button('Replace Password'));
    expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('');
    expect(screen.queryByText('removed on save')).toBeNull();

    fireEvent.change(screen.getByRole('textbox', { name: 'Host' }), {
      target: { value: 'b.example' },
    });
    fireEvent.click(button('Save parameters'));
    await waitFor(() => {
      expect(patches).toHaveLength(1);
    });
    expect(patches[0]?.params).toEqual({ host: 'b.example' });
  });
});
