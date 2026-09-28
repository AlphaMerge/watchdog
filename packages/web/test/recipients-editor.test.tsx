import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountChoice, TemplateRecipient, UserGroupView } from '../src/api/types';
import { RecipientsEditor } from '../src/routes/RecipientsEditor';

/**
 * The recipients editor, rendered (`M-20`).
 *
 * `recipients-model.test.ts` proves what it decides; these prove what somebody using it gets. An
 * administrator chooses users and groups by name and the template stores their ids. A writer who
 * is not one never asks for the lists, is told why, and keeps the users and groups already there
 * exactly as they were. Every control has a name a screen reader can say.
 */

const ACCOUNTS: AccountChoice[] = [
  { id: 4, login: 'ada', displayName: 'Ada Lovelace', disabled: false, hasAddress: true },
  { id: 5, login: 'bob', displayName: 'Bob', disabled: false, hasAddress: false },
];
const GROUPS: UserGroupView[] = [
  {
    id: 7,
    name: 'On-call',
    description: '',
    isAdmin: false,
    isDefault: false,
    isBuiltin: false,
    memberCount: 3,
  },
];

/** Answers the two lists, or refuses them all with `refuse`. Records every path asked for. */
function stubApi(refuse?: { status: number; code: string; message: string }): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', (path: string) => {
    asked.push(path);
    const reply = (status: number, data: unknown): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(data), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (refuse !== undefined) {
      return reply(refuse.status, { error: { code: refuse.code, message: refuse.message } });
    }
    if (path.endsWith('/accounts')) return reply(200, { items: ACCOUNTS });
    if (path.endsWith('/groups')) return reply(200, { items: GROUPS });
    throw new Error(`no stub for ${path}`);
  });
  return asked;
}

/** The editor is controlled, so the test holds its value the way the template form does. */
function Harness({
  initial,
  choosePeople,
  seen,
}: {
  initial: TemplateRecipient[];
  choosePeople: boolean;
  seen: TemplateRecipient[][];
}): React.JSX.Element {
  const [items, setItems] = useState(initial);
  return (
    <RecipientsEditor
      items={items}
      choosePeople={choosePeople}
      onChange={(next) => {
        seen.push(next);
        setItems(next);
      }}
    />
  );
}

const show = (initial: TemplateRecipient[], choosePeople: boolean) => {
  const seen: TemplateRecipient[][] = [];
  render(<Harness initial={initial} choosePeople={choosePeople} seen={seen} />);
  return seen;
};

/** Type into a combobox and choose the first suggestion with the keyboard. */
const chooseByKeyboard = (box: HTMLElement, typed: string): void => {
  act(() => {
    box.focus();
  });
  fireEvent.change(box, { target: { value: typed } });
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  fireEvent.keyDown(box, { key: 'Enter' });
};

describe('the recipients editor', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lets an administrator choose a user and a group, and stores their ids', async () => {
    stubApi();
    const seen = show([{ kind: 'address', value: 'ops@example.test' }], true);

    fireEvent.click(screen.getByRole('button', { name: 'Add a recipient' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Recipient 2: kind' }), {
      target: { value: 'user' },
    });
    expect(seen.at(-1)?.[1]).toEqual({ kind: 'user', value: '' });
    expect(screen.getByText('no account chosen yet')).toBeDefined();

    const account = await screen.findByRole('combobox', { name: 'Recipient 2: account' });
    await waitFor(() => {
      expect(account.getAttribute('placeholder')).toBe('Search to change…');
    });
    chooseByKeyboard(account, 'love');
    expect(seen.at(-1)?.[1]).toEqual({ kind: 'user', value: '4' });
    // Said beside the box, and by the box: it is what describes it.
    expect(
      screen.getByRole('combobox', {
        name: 'Recipient 2: account',
        description: 'Ada Lovelace (ada)',
      }),
    ).toBe(account);

    fireEvent.click(screen.getByRole('button', { name: 'Add a recipient' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Recipient 3: kind' }), {
      target: { value: 'userGroup' },
    });
    const group = await screen.findByRole('combobox', { name: 'Recipient 3: group' });
    await waitFor(() => {
      expect(group.getAttribute('placeholder')).toBe('Search to change…');
    });
    chooseByKeyboard(group, 'on');
    expect(seen.at(-1)).toEqual([
      { kind: 'address', value: 'ops@example.test' },
      { kind: 'user', value: '4' },
      { kind: 'userGroup', value: '7' },
    ]);
    expect(
      screen.getByRole('combobox', { name: 'Recipient 3: group', description: 'On-call' }),
    ).toBe(group);
  });

  it('warns in the list about an account a message would not reach', async () => {
    stubApi();
    show([{ kind: 'user', value: '' }], true);
    const account = await screen.findByRole('combobox', { name: 'Recipient 1: account' });
    await waitFor(() => {
      expect(account.getAttribute('placeholder')).toBe('Search to change…');
    });
    act(() => {
      account.focus();
    });
    fireEvent.change(account, { target: { value: 'bob' } });
    expect(screen.getByRole('option', { name: /bob/u }).textContent).toMatch(/no address/u);
  });

  it('never asks a writer’s behalf for the lists, says why, and keeps what is there', () => {
    const asked = stubApi();
    const seen = show(
      [
        { kind: 'user', value: '4' },
        { kind: 'address', value: 'ops@example.test' },
        { kind: 'userGroup', value: '7' },
      ],
      false,
    );

    expect(asked).toEqual([]);
    expect(screen.getByText(/Users and groups are chosen by an administrator/u)).toBeDefined();
    expect(screen.getByText('account #4')).toBeDefined();
    expect(screen.getByText('group #7')).toBeDefined();
    expect(screen.queryByRole('combobox')).toBeNull();

    // Editing an address leaves the people exactly as they were.
    fireEvent.change(screen.getByRole('textbox', { name: 'Recipient 2: address' }), {
      target: { value: 'noc@example.test' },
    });
    expect(seen.at(-1)).toEqual([
      { kind: 'user', value: '4' },
      { kind: 'address', value: 'noc@example.test' },
      { kind: 'userGroup', value: '7' },
    ]);

    // And a writer may still take one off; a new one is an address.
    fireEvent.click(screen.getByRole('button', { name: 'Remove recipient 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a recipient' }));
    expect(seen.at(-1)).toEqual([
      { kind: 'address', value: 'noc@example.test' },
      { kind: 'userGroup', value: '7' },
      { kind: 'address', value: '' },
    ]);
    expect(asked).toEqual([]);
  });

  it('says so when a list cannot be loaded, rather than offering an empty one', async () => {
    stubApi({ status: 403, code: 'AUTH_FORBIDDEN', message: 'this action needs one of: admin' });
    show([{ kind: 'user', value: '4' }], true);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Could not load the list: this action needs one of: admin/u);
    expect(screen.queryByRole('combobox', { name: 'Recipient 1: account' })).toBeNull();
  });

  it('gives every control a name', async () => {
    stubApi();
    show(
      [
        { kind: 'address', value: 'ops@example.test' },
        { kind: 'user', value: '4' },
      ],
      true,
    );
    await screen.findByText('Ada Lovelace (ada)');
    // The accessible name as a screen reader computes it — a `<label>`, `aria-label` or the
    // text — and every control of each role has one.
    for (const role of ['combobox', 'textbox', 'button'] as const) {
      expect(screen.getAllByRole(role, { name: /\S/u })).toHaveLength(
        screen.getAllByRole(role).length,
      );
    }
    expect(screen.getByRole('textbox', { name: 'Recipient 1: address' })).toBeDefined();
    expect(screen.getByRole('combobox', { name: 'Recipient 2: account' })).toBeDefined();
  });
});
