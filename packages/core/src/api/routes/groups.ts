import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import type { GroupService } from '../../auth/groups.js';
import { requireRole } from '../authentication.js';
import { ADMIN } from '../authorization.js';

export interface GroupRoutesOptions {
  groups: GroupService;
}

const groupSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'description', 'isAdmin', 'isDefault', 'isBuiltin', 'memberCount'],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    description: { type: 'string' },
    isAdmin: {
      type: 'boolean',
      description:
        'Members administer the whole installation. Kept as a flag rather than as a right on the ' +
        'root object, because "may do anything, including to objects that do not exist yet" is ' +
        'not a statement about a position in the tree.',
    },
    isDefault: { type: 'boolean', description: 'The group a new account joins.' },
    isBuiltin: {
      type: 'boolean',
      description: 'Cannot be deleted or renamed. Its description can be changed.',
    },
    memberCount: { type: 'integer' },
  },
} as const;

const membershipSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['groupId', 'name', 'isAdmin', 'isPrimary'],
  properties: {
    groupId: { type: 'integer' },
    name: { type: 'string' },
    isAdmin: { type: 'boolean' },
    isPrimary: {
      type: 'boolean',
      description:
        'The *default* group, not the strongest one: it answers which group owns an object this ' +
        'user creates, and nothing else. Access is the union of every group they are in.',
    },
  },
} as const;

const idParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

/**
 * Managing user groups (`A-02`).
 *
 * **Every route here needs an administrator**, because group membership *is* the access-control
 * mechanism `A-03` builds on — an account that can add itself to a group can grant itself
 * anything that group holds.
 */
export function groupRoutes(app: FastifyInstance, options: GroupRoutesOptions): void {
  const { groups } = options;
  const adminOnly = { preHandler: requireRole('admin') };

  app.get(
    '/groups',
    {
      config: ADMIN,
      ...adminOnly,
      schema: {
        tags: ['groups'],
        summary: 'Every user group, built-in ones first',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: groupSchema } },
          },
        },
      },
    },
    async () => ({ items: await groups.list() }),
  );

  app.post<{ Body: { name: string; description?: string; isAdmin?: boolean } }>(
    '/groups',
    {
      config: ADMIN,
      ...adminOnly,
      schema: {
        tags: ['groups'],
        summary: 'Create a user group',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            description: { type: 'string', maxLength: 1000 },
            isAdmin: { type: 'boolean', default: false },
          },
        },
        response: { 201: groupSchema },
      },
    },
    async (request, reply) => {
      const created = await groups.create(request.body);
      return reply.status(201).send(created);
    },
  );

  app.put<{
    Params: { id: number };
    Body: { name?: string; description?: string; isAdmin?: boolean };
  }>(
    '/groups/:id',
    {
      config: ADMIN,
      ...adminOnly,
      schema: {
        tags: ['groups'],
        summary: 'Rename a group, describe it, or change what it grants',
        description:
          'A built-in group accepts only a description. Renaming Administrators or clearing its ' +
          'admin flag is a one-way door out of your own installation.',
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            description: { type: 'string', maxLength: 1000 },
            isAdmin: { type: 'boolean' },
          },
        },
        response: { 200: groupSchema },
      },
    },
    async (request) => groups.update(request.params.id, request.body),
  );

  app.delete<{ Params: { id: number } }>(
    '/groups/:id',
    {
      config: ADMIN,
      ...adminOnly,
      schema: {
        tags: ['groups'],
        summary: 'Delete a group',
        description:
          'Members are not deleted with it, and anybody whose primary group this was is given ' +
          'another — a user with groups and no primary among them is a state object ownership ' +
          'has no answer for.',
        params: idParams,
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      await groups.delete(request.params.id);
      return reply.status(204).send();
    },
  );

  app.get<{ Params: { id: number } }>(
    '/groups/:id/members',
    {
      config: ADMIN,
      ...adminOnly,
      schema: {
        tags: ['groups'],
        summary: 'Who is in this group',
        params: idParams,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['userId', 'login', 'isPrimary'],
                  properties: {
                    userId: { type: 'integer' },
                    login: { type: 'string' },
                    isPrimary: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request) => ({ items: await groups.membersOf(request.params.id) }),
  );

  app.put<{ Params: { id: number; userId: number }; Body: { primary?: boolean } }>(
    '/groups/:id/members/:userId',
    {
      config: ADMIN,
      ...adminOnly,
      schema: {
        tags: ['groups'],
        summary: 'Add an account to a group',
        description:
          'Idempotent. The first group an account joins becomes its primary one; adding it to a ' +
          'second does not move that unless asked.',
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'userId'],
          properties: {
            id: { type: 'integer', minimum: 1 },
            userId: { type: 'integer', minimum: 1 },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { primary: { type: 'boolean', default: false } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: membershipSchema } },
          },
        },
      },
    },
    async (request) => {
      const { id, userId } = request.params;
      await groups.addMember(id, userId, request.body.primary ?? false);
      return { items: await groups.membershipsOf(userId) };
    },
  );

  app.delete<{ Params: { id: number; userId: number } }>(
    '/groups/:id/members/:userId',
    {
      config: ADMIN,
      ...adminOnly,
      schema: {
        tags: ['groups'],
        summary: 'Remove an account from a group',
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'userId'],
          properties: {
            id: { type: 'integer', minimum: 1 },
            userId: { type: 'integer', minimum: 1 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: membershipSchema } },
          },
        },
      },
    },
    async (request) => {
      const { id, userId } = request.params;
      await groups.removeMember(id, userId);
      return { items: await groups.membershipsOf(userId) };
    },
  );

  app.get<{ Params: { id: number } }>(
    '/accounts/:id/groups',
    {
      config: ADMIN,
      ...adminOnly,
      schema: {
        tags: ['groups'],
        summary: 'Every group an account belongs to, primary first',
        params: idParams,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: membershipSchema } },
          },
        },
      },
    },
    async (request) => ({ items: await groups.membershipsOf(request.params.id) }),
  );

  app.put<{ Params: { id: number; groupId: number } }>(
    '/accounts/:id/primary-group/:groupId',
    {
      config: ADMIN,
      ...adminOnly,
      schema: {
        tags: ['groups'],
        summary: 'Choose which of an account’s groups is its primary one',
        description:
          'Refused for a group the account does not belong to — a rule the schema cannot express, ' +
          'since a foreign key could not say "and they must be a member of it".',
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
            required: ['items'],
            properties: { items: { type: 'array', items: membershipSchema } },
          },
        },
      },
    },
    async (request) => {
      const { id, groupId } = request.params;
      await groups.setPrimary(groupId, id);
      return { items: await groups.membershipsOf(id) };
    },
  );
}
