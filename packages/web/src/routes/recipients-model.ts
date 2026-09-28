import type { AccountChoice, TemplateRecipient, UserGroupView } from '../api/types';
import type { Session } from '../auth/session';

/**
 * What the recipients editor decides, kept out of the component so it can be tested as data
 * (`M-20`).
 */

export type RecipientKind = TemplateRecipient['kind'];

/** In the order the kind menu offers them. */
export const RECIPIENT_KINDS: readonly { readonly kind: RecipientKind; readonly label: string }[] =
  [
    { kind: 'address', label: 'Address' },
    { kind: 'user', label: 'User' },
    { kind: 'userGroup', label: 'Group' },
  ];

/**
 * Whether this session may choose users and groups.
 *
 * **An administrator's, because the lists are.** `GET /accounts` and `GET /groups` are `ADMIN`:
 * who is in the installation is the access-control structure, and a list of logins is a list of
 * what to guess passwords against. A writer who is not an administrator may still edit a template
 * and its addresses, and the users and groups already on it are kept exactly as they are. An
 * anonymous session is refused by both routes even with authentication off, so it cannot choose
 * either.
 */
export function mayChoosePeople(session: Session): boolean {
  return session.kind === 'signed-in' && session.principal.role === 'admin';
}

/** Something a picker offers: a unique name to type, and a line saying which one it is. */
export interface Choice {
  readonly id: number;
  /** Unique among its kind — a login, a group name — so typing it names exactly one. */
  readonly name: string;
  readonly detail: string;
  /** A one-word warning chip, when choosing this one would reach nobody. */
  readonly badge?: string;
}

export function accountChoices(accounts: readonly AccountChoice[]): Choice[] {
  return accounts.map((account) => {
    const warning = account.disabled ? 'disabled' : account.hasAddress ? undefined : 'no address';
    return {
      id: account.id,
      name: account.login,
      detail: account.displayName === '' ? `#${String(account.id)}` : account.displayName,
      ...(warning === undefined ? {} : { badge: warning }),
    };
  });
}

export function groupChoices(groups: readonly UserGroupView[]): Choice[] {
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    detail: group.memberCount === 1 ? '1 member' : `${String(group.memberCount)} members`,
    ...(group.memberCount === 0 ? { badge: 'empty' } : {}),
  }));
}

/** At most this many suggestions: past it, typing another letter is quicker than scrolling. */
export const MAX_SUGGESTIONS = 50;

/** The choices whose name or detail contains what was typed, ignoring case; all of them for none. */
export function matching(choices: readonly Choice[], typed: string): Choice[] {
  const needle = typed.trim().toLowerCase();
  const found =
    needle === ''
      ? choices
      : choices.filter(
          (choice) =>
            choice.name.toLowerCase().includes(needle) ||
            choice.detail.toLowerCase().includes(needle),
        );
  return found.slice(0, MAX_SUGGESTIONS);
}

/**
 * How a recipient reads, in words.
 *
 * A user or a group is stored by id, so without the list — a writer who is not an administrator,
 * or a list that has not loaded — the id is all there is to show, and the words say so rather
 * than inventing a name. An id nobody has any more reads as that: a send skips it, and the
 * notification log names it (`M-19`).
 */
export function describeRecipient(
  recipient: TemplateRecipient,
  accounts: readonly AccountChoice[] | null,
  groups: readonly UserGroupView[] | null,
): string {
  if (recipient.kind === 'address') return recipient.value;
  const noun = recipient.kind === 'user' ? 'account' : 'group';
  if (recipient.value === '') return `no ${noun} chosen yet`;
  const id = Number(recipient.value);
  const known = recipient.kind === 'user' ? accounts : groups;
  if (known === null) return `${noun} #${recipient.value}`;
  if (recipient.kind === 'user') {
    const account = accounts?.find((one) => one.id === id);
    if (account === undefined) return `account #${recipient.value}, which no longer exists`;
    return account.displayName === '' ? account.login : `${account.displayName} (${account.login})`;
  }
  const group = groups?.find((one) => one.id === id);
  return group === undefined ? `group #${recipient.value}, which no longer exists` : group.name;
}

/** The same recipient as another kind. What was in it meant something else, so it starts empty. */
export function withKind(recipient: TemplateRecipient, kind: RecipientKind): TemplateRecipient {
  return recipient.kind === kind ? recipient : { kind, value: '' };
}
