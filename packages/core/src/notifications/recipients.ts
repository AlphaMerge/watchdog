import type { Database, Queryable } from '../db/pool.js';
import type { AccessService } from '../auth/access.js';
import type { AccountRole } from '../auth/accounts.js';
import type { Recipient } from './templates.js';

/**
 * Who a message goes to, worked out when it is sent (`M-19`, `CAPABILITIES.MD §5.2`).
 *
 * **A template names users and user groups as well as addresses, and until this nothing turned
 * them into addresses.** The API accepted all three kinds from `N-05` on; delivery resolved only
 * `address`. A template naming nothing but people failed every send as "cannot be resolved until
 * accounts exist" — accounts have had an `email` since `A-01` — and one naming people *and* an
 * address sent to the address and dropped the people without a word, which is the worse of the
 * two because it looks like it worked.
 *
 * **At send time, not when the template is saved.** A group is its members on the day the alarm
 * fires: somebody who joined the on-call group last week is paged, somebody who left is not, and
 * nobody has to re-save a template for that to be true.
 *
 * **Nobody is paged about a sensor they may not see.** A-12's rule is that an object somebody
 * cannot see is absent — from lists, counts, the stream, the notification log — and an email is
 * the one place a sensor's name, host, message and link leave the system altogether. A template's
 * author chose a *group*; they did not choose every member's rights across every branch, and the
 * group's membership moves after the template is saved. Sending anyway fails invisibly and cannot
 * be taken back: a customer reads another customer's outage. Skipping fails visibly — the member
 * is named in the delivery result, and a message nobody may read fails outright. So a member who
 * cannot read every sensor a message names is skipped. The rule is `AccessService.resolveManyFor`,
 * the same resolver every read in the API is checked against, not a copy of it. A raw address is
 * not an account, has no rights to check, and was typed by somebody allowed to edit the template;
 * it is sent to as written.
 *
 * **Exported for every sender of mail to people** — the ticket emails `K-05` will send included —
 * so that "who is in this group, and may they read this?" is answered in one place.
 */

/** Why somebody a template names was not sent to. Each is named in the delivery result. */
export type SkipReason =
  | 'no such account'
  | 'no such group'
  | 'no members'
  | 'disabled'
  | 'no email address'
  | 'may not see this sensor';

export interface SkippedRecipient {
  /** Who, as a person would recognise them: `user "alice"`, `"bob" in group "NOC"`. */
  readonly who: string;
  readonly reason: SkipReason;
}

export interface ResolvedRecipients {
  /** Every address to send to, once each, in the order the template names them. */
  readonly addresses: readonly string[];
  readonly skipped: readonly SkippedRecipient[];
}

/** What a sender needs from this: the answer, and nothing about how it is reached. */
export interface RecipientSource {
  /**
   * @param about every sensor the message names — one for an alarm, all of a digest's, none for
   *   a test send built from example values. A recipient is sent to only if they may read all.
   */
  resolve(recipients: readonly Recipient[], about: readonly number[]): Promise<ResolvedRecipients>;
}

export interface RecipientResolverOptions {
  db: Database;
  access: AccessService;
}

interface Account {
  readonly id: number;
  readonly login: string;
  readonly email: string;
  readonly disabled: boolean;
  readonly role: AccountRole;
}

/** A user or group recipient's value is the id, as a decimal string. */
export function recipientId(value: string): number | null {
  return /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : null;
}

export class RecipientResolver implements RecipientSource {
  readonly #db: Database;
  readonly #access: AccessService;

  constructor(options: RecipientResolverOptions) {
    this.#db = options.db;
    this.#access = options.access;
  }

  async resolve(
    recipients: readonly Recipient[],
    about: readonly number[],
    q: Queryable = this.#db,
  ): Promise<ResolvedRecipients> {
    const addresses: string[] = [];
    const seen = new Set<string>();
    const skipped: SkippedRecipient[] = [];
    const skippedKeys = new Set<string>();
    const add = (address: string): void => {
      // Folded for the comparison only: the domain is case-insensitive and a mailbox that is not
      // is vanishingly rare, while the same person listed twice in two spellings is common.
      const key = address.trim().toLowerCase();
      if (key === '' || seen.has(key)) return;
      seen.add(key);
      addresses.push(address.trim());
    };
    const skip = (who: string, reason: SkipReason): void => {
      const key = `${who}\u0000${reason}`;
      if (skippedKeys.has(key)) return;
      skippedKeys.add(key);
      skipped.push({ who, reason });
    };

    const userIds: number[] = [];
    const groupIds: number[] = [];
    for (const recipient of recipients) {
      if (recipient.kind === 'address') continue;
      const id = recipientId(recipient.value);
      if (id === null) {
        skip(
          `${recipient.kind === 'user' ? 'user' : 'group'} "${recipient.value}"`,
          recipient.kind === 'user' ? 'no such account' : 'no such group',
        );
      } else if (recipient.kind === 'user') userIds.push(id);
      else groupIds.push(id);
    }

    const accounts = await this.#accounts(q, userIds);
    const groups = await this.#groups(q, groupIds);
    const permitted = new Map<number, boolean>();
    const mayRead = async (account: Account): Promise<boolean> => {
      if (about.length === 0) return true;
      const known = permitted.get(account.id);
      if (known !== undefined) return known;
      const rights = await this.#access.resolveManyFor(
        { userId: account.id, role: account.role },
        about,
        q,
      );
      const answer = about.every((id) => (rights.get(id) ?? 'none') !== 'none');
      permitted.set(account.id, answer);
      return answer;
    };
    const consider = async (account: Account, who: string): Promise<void> => {
      if (account.disabled) skip(who, 'disabled');
      else if (account.email.trim() === '') skip(who, 'no email address');
      else if (!(await mayRead(account))) skip(who, 'may not see this sensor');
      else add(account.email);
    };

    // In the template's order, so the addresses read the way the template does.
    for (const recipient of recipients) {
      if (recipient.kind === 'address') {
        add(recipient.value);
        continue;
      }
      const id = recipientId(recipient.value);
      if (id === null) continue;
      if (recipient.kind === 'user') {
        const account = accounts.get(id);
        if (account === undefined) skip(`user ${String(id)}`, 'no such account');
        else await consider(account, `user "${account.login}"`);
        continue;
      }
      const group = groups.get(id);
      if (group === undefined) {
        skip(`group ${String(id)}`, 'no such group');
      } else if (group.members.length === 0) {
        skip(`group "${group.name}"`, 'no members');
      } else {
        for (const member of group.members) {
          await consider(member, `"${member.login}" in group "${group.name}"`);
        }
      }
    }
    return { addresses, skipped };
  }

  async #accounts(q: Queryable, ids: readonly number[]): Promise<Map<number, Account>> {
    const found = new Map<number, Account>();
    if (ids.length === 0) return found;
    const rows = await q.query<AccountRow>(
      `SELECT id::text AS id, login, email, disabled, role
       FROM user_account WHERE id = ANY($1::bigint[])`,
      [[...ids]],
    );
    for (const row of rows) found.set(Number(row.id), accountOf(row));
    return found;
  }

  async #groups(
    q: Queryable,
    ids: readonly number[],
  ): Promise<Map<number, { name: string; members: Account[] }>> {
    const found = new Map<number, { name: string; members: Account[] }>();
    if (ids.length === 0) return found;
    const rows = await q.query<{ group_id: string; group_name: string } & Partial<AccountRow>>(
      `SELECT g.id::text AS group_id, g.name AS group_name,
              a.id::text AS id, a.login, a.email, a.disabled, a.role
       FROM user_group g
       LEFT JOIN user_group_member m ON m.group_id = g.id
       LEFT JOIN user_account a ON a.id = m.user_id
       WHERE g.id = ANY($1::bigint[])
       ORDER BY g.id, lower(a.login)`,
      [[...ids]],
    );
    for (const row of rows) {
      const groupId = Number(row.group_id);
      const group = found.get(groupId) ?? { name: row.group_name, members: [] };
      found.set(groupId, group);
      if (row.id != null && row.login != null && row.role != null) {
        group.members.push(
          accountOf({
            id: row.id,
            login: row.login,
            email: row.email ?? '',
            disabled: row.disabled ?? false,
            role: row.role,
          }),
        );
      }
    }
    return found;
  }
}

interface AccountRow extends Record<string, unknown> {
  id: string;
  login: string;
  email: string;
  disabled: boolean;
  role: AccountRole;
}

function accountOf(row: AccountRow): Account {
  return {
    id: Number(row.id),
    login: row.login,
    email: row.email,
    disabled: row.disabled,
    role: row.role,
  };
}

/** The skipped, as one clause a delivery result can carry: `skipped user "bob" (disabled)`. */
export function describeSkipped(skipped: readonly SkippedRecipient[]): string {
  return skipped.map((one) => `${one.who} (${one.reason})`).join(', ');
}
