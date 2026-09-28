import { describe, expect, it } from 'vitest';
import type { AccountChoice, UserGroupView } from '../src/api/types';
import type { Session } from '../src/auth/session';
import {
  accountChoices,
  describeRecipient,
  groupChoices,
  matching,
  MAX_SUGGESTIONS,
  mayChoosePeople,
  withKind,
} from '../src/routes/recipients-model';

/**
 * What the recipients editor decides about users and groups (`M-20`), as data.
 */

const signedIn = (role: 'admin' | 'readwrite' | 'readonly'): Session => ({
  kind: 'signed-in',
  requireAuthentication: true,
  principal: { userId: 1, login: 'someone', role, mustChangePassword: false },
});

const ADA: AccountChoice = {
  id: 4,
  login: 'ada',
  displayName: 'Ada Lovelace',
  disabled: false,
  hasAddress: true,
};
const BOB: AccountChoice = {
  id: 5,
  login: 'bob',
  displayName: '',
  disabled: false,
  hasAddress: false,
};
const EVE: AccountChoice = {
  id: 6,
  login: 'eve',
  displayName: 'Eve',
  disabled: true,
  hasAddress: true,
};

const group = (id: number, name: string, memberCount: number): UserGroupView => ({
  id,
  name,
  description: '',
  isAdmin: false,
  isDefault: false,
  isBuiltin: false,
  memberCount,
});
const ONCALL = group(7, 'On-call', 3);
const EMPTY = group(8, 'Nobody yet', 0);

describe('who may choose users and groups', () => {
  it.each([
    ['an administrator', signedIn('admin'), true],
    ['a writer', signedIn('readwrite'), false],
    ['a reader', signedIn('readonly'), false],
    [
      'nobody signed in, with sign-in optional',
      { kind: 'anonymous', requireAuthentication: false },
      false,
    ],
    ['nobody signed in', { kind: 'anonymous', requireAuthentication: true }, false],
    ['a session not known yet', { kind: 'unknown' }, false],
  ] as const)('%s', (_who, session, expected) => {
    expect(mayChoosePeople(session)).toBe(expected);
  });
});

describe('what the pickers offer', () => {
  it('names an account by its login, and warns when a message to it would reach nobody', () => {
    expect(accountChoices([ADA, BOB, EVE])).toEqual([
      { id: 4, name: 'ada', detail: 'Ada Lovelace' },
      { id: 5, name: 'bob', detail: '#5', badge: 'no address' },
      { id: 6, name: 'eve', detail: 'Eve', badge: 'disabled' },
    ]);
  });

  it('names a group, counts its members, and warns when it has none', () => {
    expect(groupChoices([ONCALL, EMPTY, group(9, 'Solo', 1)])).toEqual([
      { id: 7, name: 'On-call', detail: '3 members' },
      { id: 8, name: 'Nobody yet', detail: '0 members', badge: 'empty' },
      { id: 9, name: 'Solo', detail: '1 member' },
    ]);
  });

  it('matches what was typed against the name or the detail, ignoring case', () => {
    const choices = accountChoices([ADA, BOB, EVE]);
    expect(matching(choices, 'LOVE').map((one) => one.name)).toEqual(['ada']);
    expect(matching(choices, ' b ').map((one) => one.name)).toEqual(['bob']);
    expect(matching(choices, '').map((one) => one.name)).toEqual(['ada', 'bob', 'eve']);
    expect(matching(choices, 'zzz')).toEqual([]);
  });

  it('suggests at most a screenful', () => {
    const many = Array.from({ length: MAX_SUGGESTIONS + 20 }, (_, index) => ({
      id: index + 1,
      name: `user${String(index)}`,
      detail: '',
    }));
    expect(matching(many, 'user')).toHaveLength(MAX_SUGGESTIONS);
  });
});

describe('how a recipient reads', () => {
  it('names a user or a group from the list, and says which id it is without one', () => {
    expect(describeRecipient({ kind: 'user', value: '4' }, [ADA], [])).toBe('Ada Lovelace (ada)');
    expect(describeRecipient({ kind: 'user', value: '5' }, [BOB], [])).toBe('bob');
    expect(describeRecipient({ kind: 'userGroup', value: '7' }, [], [ONCALL])).toBe('On-call');
    // A writer who may not read the lists sees the id and nothing invented.
    expect(describeRecipient({ kind: 'user', value: '4' }, null, null)).toBe('account #4');
    expect(describeRecipient({ kind: 'userGroup', value: '7' }, null, null)).toBe('group #7');
  });

  it('says so when the one it names is gone, or none has been chosen', () => {
    expect(describeRecipient({ kind: 'user', value: '99' }, [ADA], [])).toBe(
      'account #99, which no longer exists',
    );
    expect(describeRecipient({ kind: 'userGroup', value: '99' }, [], [ONCALL])).toBe(
      'group #99, which no longer exists',
    );
    expect(describeRecipient({ kind: 'user', value: '' }, [ADA], [])).toBe('no account chosen yet');
  });

  it('reads an address as itself', () => {
    expect(describeRecipient({ kind: 'address', value: 'ops@example.test' }, null, null)).toBe(
      'ops@example.test',
    );
  });
});

describe('changing a recipient’s kind', () => {
  it('starts empty, because what was in it meant something else', () => {
    expect(withKind({ kind: 'address', value: 'ops@example.test' }, 'user')).toEqual({
      kind: 'user',
      value: '',
    });
    const same = { kind: 'user' as const, value: '4' };
    expect(withKind(same, 'user')).toBe(same);
  });
});
