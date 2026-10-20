import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import type { Account, AccountService } from '../../auth/accounts.js';
import { requireRole } from '../authentication.js';
import { ADMIN } from '../authorization.js';

export interface AccountRoutesOptions {
  accounts: AccountService;
}

/** One account, as somebody choosing it sees it: who it is, and whether a message can reach it. */
const choiceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'login', 'displayName', 'disabled', 'hasAddress'],
  properties: {
    id: { type: 'integer' },
    login: { type: 'string' },
    displayName: { type: 'string' },
    // Skipped since `M-19`.
    disabled: {
      type: 'boolean',
      description: 'A disabled account is skipped when a notification is sent.',
    },
    hasAddress: {
      type: 'boolean',
      description:
        'Whether the account has an email address. One without is skipped when a notification ' +
        'is sent, and the log says so. The address itself is not listed.',
    },
  },
} as const;

interface AccountChoice {
  id: number;
  login: string;
  displayName: string;
  disabled: boolean;
  hasAddress: boolean;
}

/** What choosing an account needs, and nothing else a list of accounts could say. */
function choiceOf(account: Account): AccountChoice {
  return {
    id: account.id,
    login: account.login,
    displayName: account.displayName,
    disabled: account.disabled,
    hasAddress: account.email.trim() !== '',
  };
}

/**
 * The accounts, for choosing one (`M-20`).
 *
 * **An administrator's**, as the groups are, and for the same reason: a list of every login is a
 * list of what to try passwords against, and who is in the installation is the access-control
 * structure `A-02` keeps to administrators. It exists for the notification recipients editor,
 * whose user and group recipients are an administrator's choice for the same reason. A writer
 * who is not one is told so in the editor rather than being offered a list that fails to load.
 *
 * **The fields a picker needs and no others.** Role, address, sign-in history and lockout are an
 * account's own business, and choosing somebody to notify needs none of them.
 */
export function accountRoutes(app: FastifyInstance, options: AccountRoutesOptions): void {
  const { accounts } = options;

  app.get(
    '/accounts',
    {
      config: ADMIN,
      preHandler: requireRole('admin'),
      schema: {
        tags: ['accounts'],
        summary: 'Every account, for choosing one',
        description:
          'Listed by login, for the notification recipients editor. Only what choosing an ' +
          'account needs: the login, the display name, whether it is disabled and whether it ' +
          'has an address a message can go to. Its role, address and sign-in history are not ' +
          'listed.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: choiceSchema } },
          },
        },
      },
    },
    async () => ({ items: (await accounts.list()).map(choiceOf) }),
  );
}
