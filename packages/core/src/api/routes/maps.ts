// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { AuthError } from '../../auth/errors.js';
import type { AccessRight } from '../../auth/access.js';
import type { MapLayout, MapRow } from '../../maps/repository.js';
import type { MapService, MapViewer } from '../../maps/service.js';
import { READS } from '../authorization.js';

/**
 * Maps (`G-01`, `CAPABILITIES.MD §6`).
 *
 * **Every route is `READS` and the real check happens in the service.** The route-level
 * `onObject(...)` helper resolves rights against the *object tree*, and a map is not in it — so
 * pointing it at a map id would ask the wrong table a question it cannot answer. `MapService`
 * holds the one place that decides, which is also what `G-06`'s public route will need when it
 * arrives with no principal at all.
 *
 * **A map the caller cannot read answers 404, not 403.** Deliberate, and the reasoning is in
 * `maps/errors.ts`: distinguishing the two turns the error into an oracle for enumerating ids.
 */

export interface MapRouteOptions {
  maps: MapService;
}

interface MapBody {
  name: string;
  description?: string;
  priority?: number;
  layout?: MapLayout;
}

const mapResponse = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'name',
    'description',
    'priority',
    'layout',
    'version',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    description: { type: 'string' },
    priority: { type: 'integer', minimum: 1, maximum: 5 },
    layout: { type: 'object', additionalProperties: true },
    version: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const mapBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    description: { type: 'string', maxLength: 1000 },
    priority: { type: 'integer', minimum: 1, maximum: 5 },
    layout: { type: 'object', additionalProperties: true },
  },
} as const;

function serialise(map: MapRow): Record<string, unknown> {
  return {
    id: map.id,
    name: map.name,
    description: map.description,
    priority: map.priority,
    layout: map.layout,
    version: map.version,
    createdAt: map.createdAt.toISOString(),
    updatedAt: map.updatedAt.toISOString(),
  };
}

export function mapRoutes(app: FastifyInstance, options: MapRouteOptions): void {
  const { maps } = options;

  /** The viewer, or a refusal. Every route needs one; `G-06` is the only caller that will not. */
  const viewerOf = (request: {
    principal?: { userId: number; role: MapViewer['role']; scope?: AccessRight } | undefined;
  }): MapViewer => {
    const principal = request.principal;
    if (principal === undefined) {
      throw new AuthError('AUTH_REQUIRED', 'this request needs a session; log in first');
    }
    return principal.scope === undefined
      ? { userId: principal.userId, role: principal.role }
      : { userId: principal.userId, role: principal.role, scope: principal.scope };
  };

  app.get(
    '/maps',
    {
      config: READS,
      schema: {
        tags: ['maps'],
        summary: 'The maps this account may see',
        description:
          'Highest priority first, then by name. An administrator sees every map; everybody ' +
          'else sees the ones a group they belong to has been granted.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: mapResponse } },
          },
        },
      },
    },
    async (request) => ({ items: (await maps.list(viewerOf(request))).map(serialise) }),
  );

  app.get<{ Params: { id: string } }>(
    '/maps/:id',
    {
      config: READS,
      schema: {
        tags: ['maps'],
        summary: 'One map, with its canvas',
        description:
          'A map this account may not read answers 404 rather than 403, so the error cannot be ' +
          'used to enumerate which ids exist.',
        response: { 200: mapResponse },
      },
    },
    async (request) => serialise(await maps.get(viewerOf(request), Number(request.params.id))),
  );

  app.post<{ Body: MapBody }>(
    '/maps',
    {
      config: READS,
      schema: {
        tags: ['maps'],
        summary: 'Create a map',
        description:
          'The creator’s primary group is granted full access in the same transaction — access ' +
          'is per group and a new map has no grants, so otherwise the person who made it could ' +
          'not see it.',
        body: mapBody,
        response: { 201: mapResponse },
      },
    },
    async (request, reply) => {
      const viewer = viewerOf(request);
      const created = await maps.create(viewer, request.body, request.principal?.login ?? '');
      return reply.code(201).send(serialise(created));
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<MapBody>; Headers: { 'if-match'?: string } }>(
    '/maps/:id',
    {
      config: READS,
      schema: {
        tags: ['maps'],
        summary: 'Change a map',
        description:
          '`If-Match` carries the version this edit was made against. Without it the request is ' +
          'refused: a designer is a thing two people open at once, and last-write-wins there ' +
          'means somebody’s afternoon disappears without a message.',
        body: { ...mapBody, required: [] },
        response: { 200: mapResponse },
      },
    },
    async (request) => {
      const viewer = viewerOf(request);
      const expected = Number(request.headers['if-match']?.replace(/^W\/|"/g, ''));
      if (!Number.isInteger(expected)) {
        throw new AuthError('AUTH_REQUIRED', 'If-Match must carry the version being edited');
      }
      const updated = await maps.update(
        viewer,
        Number(request.params.id),
        expected,
        request.body,
        request.principal?.login ?? '',
      );
      return serialise(updated);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/maps/:id',
    {
      config: READS,
      schema: {
        tags: ['maps'],
        summary: 'Delete a map',
        description: 'Needs full access. The grants on it go with it.',
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      await maps.remove(
        viewerOf(request),
        Number(request.params.id),
        request.principal?.login ?? '',
      );
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    '/maps/:id/access',
    {
      config: READS,
      schema: {
        tags: ['maps'],
        summary: 'Which groups may see this map',
        description: 'Needs full access: who else can see a thing is not a read.',
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
                  required: ['groupId', 'groupName', 'right', 'grantedAt', 'grantedBy'],
                  properties: {
                    groupId: { type: 'integer' },
                    groupName: { type: 'string' },
                    right: { type: 'string', enum: ['none', 'read', 'write', 'full'] },
                    grantedAt: { type: 'string', format: 'date-time' },
                    grantedBy: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const grants = await maps.grants(viewerOf(request), Number(request.params.id));
      return {
        items: grants.map((grant) => ({ ...grant, grantedAt: grant.grantedAt.toISOString() })),
      };
    },
  );

  app.put<{ Params: { id: string; groupId: string }; Body: { right: AccessRight } }>(
    '/maps/:id/access/:groupId',
    {
      config: READS,
      schema: {
        tags: ['maps'],
        summary: 'Grant a group access to this map',
        description:
          'Needs full access, so a write holder may edit the canvas without deciding who else ' +
          'sees it. Granting twice replaces rather than failing: it is a correction.',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['right'],
          properties: { right: { type: 'string', enum: ['none', 'read', 'write', 'full'] } },
        },
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      await maps.grant(
        viewerOf(request),
        Number(request.params.id),
        Number(request.params.groupId),
        request.body.right,
        request.principal?.login ?? '',
      );
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string; groupId: string } }>(
    '/maps/:id/access/:groupId',
    {
      config: READS,
      schema: {
        tags: ['maps'],
        summary: 'Take a group’s access away',
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      await maps.revoke(
        viewerOf(request),
        Number(request.params.id),
        Number(request.params.groupId),
        request.principal?.login ?? '',
      );
      return reply.code(204).send();
    },
  );
}
