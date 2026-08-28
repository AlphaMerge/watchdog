import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import type { AccessRight, AccessService } from '../../auth/access.js';
import { AuthError } from '../../auth/errors.js';
import { actorFor, requireRole } from '../authentication.js';

export interface AccessRoutesOptions {
  access: AccessService;
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
  const { access } = options;

  app.get<{ Params: { id: number } }>(
    '/objects/:id/access',
    {
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
      schema: {
        tags: ['access'],
        summary: 'What an account may actually do with this object',
        description:
          'Resolves the three rules — inheritance up the tree, explicit beats inherited, highest ' +
          'wins across groups — and reports where the winning grant came from, which is what ' +
          'makes a refusal debuggable. Without `userId` it answers about the calling account; ' +
          'asking about somebody else needs an administrator.',
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
        throw new AuthError('AUTH_FORBIDDEN', 'only an administrator may ask about another account');
      }
      return access.resolve(asked ?? principal.userId, request.params.id);
    },
  );

  app.put<{ Params: { id: number; groupId: number }; Body: { right: AccessRight } }>(
    '/objects/:id/access/:groupId',
    {
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
      await access.grant(
        id,
        groupId,
        request.body.right,
        actor.kind === 'user' ? actor.login : actor.kind,
      );
      return { items: await access.grantsOn(id) };
    },
  );

  app.delete<{ Params: { id: number; groupId: number } }>(
    '/objects/:id/access/:groupId',
    {
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
      const removed = await access.revoke(id, groupId);
      return { removed, items: await access.grantsOn(id) };
    },
  );
}
