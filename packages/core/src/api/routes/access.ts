import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { DENIED, type AccessRight, type AccessService } from '../../auth/access.js';
import type { AccountService } from '../../auth/accounts.js';
import { AuthError } from '../../auth/errors.js';
import { actorFor, requireRole } from '../authentication.js';
import { ADMIN, READS } from '../authorization.js';

export interface AccessRoutesOptions {
  access: AccessService;
  accounts: AccountService;
}

const rightSchema = {
  type: 'string',
  enum: ['none', 'read', 'write', 'full'],
  description:
    'none cannot see it; read may look; write may edit, create and delete beneath it, ' +
    'acknowledge alarms and manage notifications; full adds editing that object’s own group ' +
    'rights. A stored `none` is not the same as no grant: it *overrides* what would be ' +
    'inherited, where revoking restores it.',
} as const;

const grantSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['groupId', 'groupName', 'right', 'grantedBy'],
  properties: {
    groupId: { type: 'integer' },
    groupName: { type: 'string' },
    right: rightSchema,
    grantedBy: { type: 'string' },
  },
} as const;

const idParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

/**
 * Reading and changing per-object access (`A-03`).
 *
 * **Changing a grant needs `full` on the object, not merely `write`** — that is what separates
 * the two rights. An account that could edit a device and also widen who may edit it could grant
 * itself anything by granting its own group `full` one level up.
 */
export function accessRoutes(app: FastifyInstance, options: AccessRoutesOptions): void {
  const { access, accounts } = options;

  app.get<{ Params: { id: number } }>(
    '/objects/:id/access',
    {
      config: ADMIN,
      preHandler: requireRole('admin'),
      schema: {
        tags: ['access'],
        summary: 'The grants sitting directly on this object',
        description:
          'Only the explicit ones. What an account may actually do here is the *resolved* right, ' +
          'which walks the ancestors — see /objects/:id/access/effective.',
        params: idParams,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: grantSchema } },
          },
        },
      },
    },
    async (request) => ({ items: await access.grantsOn(request.params.id) }),
  );

  app.get<{ Params: { id: number }; Querystring: { userId?: number } }>(
    '/objects/:id/access/effective',
    {
      // **Read, not `read` on the object.** "What may I do here?" has to be answerable when the
      // answer is "nothing" — refusing it would make a UI unable to tell a hidden object from a
      // broken request. **And a non-administrator's own "nothing" says nothing more** (`A-49`):
      // where the `none` came from is the id of a hole and whether an object sits inside it, so
      // the caller walking ids would list every object in every hole. It answers as an unused id
      // does. An administrator asking with `userId` still gets the whole answer, which is how a
      // refusal is debugged. Asking about *another* account is an administrator's question,
      // guarded below.
      config: READS,
      schema: {
        tags: ['access'],
        summary: 'What an account may actually do with this object',
        description:
          'Resolves the three rules — inheritance up the tree, explicit beats inherited, highest ' +
          'wins across groups — and reports where the winning grant came from, which is what ' +
          'makes a refusal debuggable. Without `userId` it answers about the calling account; ' +
          'asking about somebody else needs an administrator. **An account that is not an ' +
          'administrator, asking about itself, is told `none` with no source** wherever it ' +
          'holds nothing, as it is for an id that does not exist, so that an object hidden from ' +
          'it cannot be told from one that is not there (`A-49`).',
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { userId: { type: 'integer', minimum: 1 } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['right', 'inherited', 'viaAdminGroup'],
            properties: {
              right: rightSchema,
              sourceObjectId: { type: ['integer', 'null'] },
              sourceGroupId: { type: ['integer', 'null'] },
              inherited: { type: 'boolean' },
              viaAdminGroup: {
                type: 'boolean',
                description:
                  'The account administers everything, so no grant was consulted at all.',
              },
              cappedByRole: {
                type: 'boolean',
                description:
                  'The account’s role held the right below what its groups granted (A-04). ' +
                  'Reported rather than silent: "you have full on this device and may not edit ' +
                  'it" is incomprehensible without it.',
              },
              cappedByToken: {
                type: 'boolean',
                description: 'The API token used for this request held it below that (A-06).',
              },
            },
          },
        },
      },
    },
    async (request) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new AuthError('AUTH_REQUIRED', 'this request needs a session; log in first');
      }
      const asked = request.query.userId;
      // **Asking about somebody else is an administrator's question.** Otherwise any account
      // could map the whole permission structure one probe at a time.
      if (asked !== undefined && asked !== principal.userId && principal.role !== 'admin') {
        throw new AuthError(
          'AUTH_FORBIDDEN',
          'only an administrator may ask about another account',
        );
      }

      // **`resolveFor`, not `resolve`, and the difference is the whole meaning of "effective".**
      // `resolve` answers what an account's *groups* grant, which is what an administrator wants
      // when debugging a grant; this route answers what the account may actually *do*, which is
      // that capped by its role (`A-04`) and by the token in hand (`A-06`). Answering the first
      // here told a read-only account it held `full` on a device it could not edit.
      if (asked === undefined || asked === principal.userId) {
        const own = await access.resolveFor(
          {
            userId: principal.userId,
            role: principal.role,
            ...(principal.scope === undefined ? {} : { scope: principal.scope }),
          },
          request.params.id,
        );
        return own.right === 'none' && principal.role !== 'admin' ? DENIED : own;
      }

      const subject = await accounts.get(asked);
      if (subject === null) {
        throw new AuthError('ACCOUNT_NOT_FOUND', `no account with id ${String(asked)}`);
      }
      // No scope: a token belongs to the request in hand, not to the account being asked about.
      return access.resolveFor({ userId: subject.id, role: subject.role }, request.params.id);
    },
  );

  app.put<{ Params: { id: number; groupId: number }; Body: { right: AccessRight } }>(
    '/objects/:id/access/:groupId',
    {
      config: ADMIN,
      preHandler: requireRole('admin'),
      schema: {
        tags: ['access'],
        summary: 'Grant a group a right on this object',
        description:
          'Replaces any grant this group already had here. Everything beneath inherits it, until ' +
          'something lower overrides it for the same group.',
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'groupId'],
          properties: {
            id: { type: 'integer', minimum: 1 },
            groupId: { type: 'integer', minimum: 1 },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['right'],
          properties: { right: rightSchema },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: grantSchema } },
          },
        },
      },
    },
    async (request) => {
      const { id, groupId } = request.params;
      const actor = actorFor(request);
      await access.grant(id, groupId, request.body.right, actor);
      return { items: await access.grantsOn(id) };
    },
  );

  app.delete<{ Params: { id: number; groupId: number } }>(
    '/objects/:id/access/:groupId',
    {
      config: ADMIN,
      preHandler: requireRole('admin'),
      schema: {
        tags: ['access'],
        summary: 'Remove a grant, so the object falls back to what it inherits',
        description:
          'Not the same as granting `none`, which overrides inheritance rather than restoring it. ' +
          'An administrator needs both: one undoes a mistake, the other carves a hole in a branch ' +
          'somebody else has access to.',
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'groupId'],
          properties: {
            id: { type: 'integer', minimum: 1 },
            groupId: { type: 'integer', minimum: 1 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'removed'],
            properties: {
              removed: { type: 'boolean' },
              items: { type: 'array', items: grantSchema },
            },
          },
        },
      },
    },
    async (request) => {
      const { id, groupId } = request.params;
      const removed = await access.revoke(id, groupId, actorFor(request));
      return { removed, items: await access.grantsOn(id) };
    },
  );
}
