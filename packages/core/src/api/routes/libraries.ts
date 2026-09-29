// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';
import { AuthError } from '../../auth/errors.js';
import type { AccessRight } from '../../auth/access.js';
import type { LibraryRow } from '../../libraries/repository.js';
import type { LibraryInput, LibraryService, LibraryViewer } from '../../libraries/service.js';
import { LibraryError } from '../../libraries/errors.js';
import { MAX_NODES, refuseTooDeep } from '../../libraries/nodes.js';
import { actorFor } from '../authentication.js';
import { READS, writesIn } from '../authorization.js';
import { grantParams, idParams } from '../params.js';
import { etagFor } from '../preconditions.js';

/**
 * Libraries (`L-01`, `CAPABILITIES.MD §6`).
 *
 * **The map routes' shape, for the map routes' reasons.** The right on a library is decided in
 * `LibraryService`, because the route-level `onObject(...)` helper resolves rights against the
 * object tree and a library is not in it. Every change still declares `write`, which the hook
 * checks before anything is parsed (`A-14`), and says in its `rightsIn` where the rest of the
 * decision is made.
 *
 * **A library the caller cannot read answers 404, not 403**, so the error cannot be used to
 * enumerate which ids exist — and it reaches the wire as a 404 because `api/errors.ts` has a
 * branch for `LibraryError`, which catalogue entry 41 is about.
 *
 * What a library *shows* is `L-02`'s route. These serve the document: its nodes and their rules.
 */

export interface LibraryRouteOptions {
  libraries: LibraryService;
}

/** Every change to a library: `write` here, and the right on the library itself in the service. */
const LIBRARY_WRITES = writesIn('LibraryService');

/**
 * The version an edit was made against, from `If-Match` — as the map routes read it.
 *
 * Missing is 428 and not a version is 400 (`A-14`).
 */
function expectedVersion(header: string | undefined, libraryId: number): number {
  if (header === undefined || header.trim() === '') {
    throw new LibraryError(
      'LIBRARY_PRECONDITION_REQUIRED',
      'this request requires an If-Match header carrying the version the edit was based on',
      { context: { libraryId, phase: 'precondition' } },
    );
  }
  const version = Number(header.replace(/^W\/|"/g, ''));
  if (!Number.isInteger(version)) {
    throw new LibraryError(
      'LIBRARY_INVALID',
      `If-Match must carry a library version, got ${header}`,
      {
        context: { libraryId, phase: 'precondition' },
      },
    );
  }
  return version;
}

/**
 * Refuses a body nested past six levels before its schema is asked (`L-06`): `refuseTooDeep`
 * says why. On the route rather than the app, so it runs after the authorisation hook — a caller
 * who may not write a library learns nothing about the shape of one — and before validation.
 */
function nestingBounded(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  const body: unknown = request.body;
  try {
    if (typeof body === 'object' && body !== null && 'nodes' in body) refuseTooDeep(body.nodes);
  } catch (error) {
    done(error instanceof Error ? error : new Error(String(error)));
    return;
  }
  done();
}

const grantResponse = {
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
} as const;

function serialise(library: LibraryRow): Record<string, unknown> {
  return {
    id: library.id,
    name: library.name,
    description: library.description,
    priority: library.priority,
    nodes: library.nodes,
    version: library.version,
    createdAt: library.createdAt.toISOString(),
    updatedAt: library.updatedAt.toISOString(),
  };
}

export function libraryRoutes(app: FastifyInstance, options: LibraryRouteOptions): void {
  const { libraries } = options;

  /** The viewer, or a refusal. A library has no public route, so every one needs a principal. */
  const viewerOf = (request: {
    principal?: { userId: number; role: LibraryViewer['role']; scope?: AccessRight } | undefined;
  }): LibraryViewer => {
    const principal = request.principal;
    if (principal === undefined) {
      throw new AuthError('AUTH_REQUIRED', 'this request needs a session; log in first');
    }
    return principal.scope === undefined
      ? { userId: principal.userId, role: principal.role }
      : { userId: principal.userId, role: principal.role, scope: principal.scope };
  };

  app.get(
    '/libraries',
    {
      config: READS,
      schema: {
        tags: ['libraries'],
        summary: 'The libraries this account may see',
        description:
          'Highest priority first, then by name. An administrator sees every library; everybody ' +
          'else sees the ones a group they belong to has been granted.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: { $ref: 'ms:library' } } },
          },
        },
      },
    },
    async (request) => ({ items: (await libraries.list(viewerOf(request))).map(serialise) }),
  );

  app.get<{ Params: { id: number } }>(
    '/libraries/:id',
    {
      config: READS,
      schema: {
        params: idParams,
        tags: ['libraries'],
        summary: 'One library, with its nodes and their rules',
        description:
          'The document, not what it shows: each node’s rule is evaluated when the library is ' +
          'viewed, through the viewer’s own rights. A library this account may not read answers ' +
          '404 rather than 403, so the error cannot be used to enumerate which ids exist. The ' +
          '`ETag` is the version, to send back as `If-Match`.',
        response: { 200: { $ref: 'ms:library' } },
      },
    },
    async (request, reply) => {
      const library = await libraries.get(viewerOf(request), request.params.id);
      return reply.header('ETag', etagFor(library.version)).send(serialise(library));
    },
  );

  app.post<{ Body: LibraryInput }>(
    '/libraries',
    {
      config: LIBRARY_WRITES,
      preValidation: nestingBounded,
      schema: {
        tags: ['libraries'],
        summary: 'Create a library',
        description:
          'The creator’s primary group is granted full access in the same transaction — access ' +
          'is per group and a new library has no grants, so otherwise the person who made it ' +
          'could not see it. At most 200 nodes, six levels deep, each id used once: a document ' +
          'that does not fit is refused whole, naming the node that is wrong.',
        body: { $ref: 'ms:libraryInput' },
        response: { 201: { $ref: 'ms:library' } },
      },
    },
    async (request, reply) => {
      const created = await libraries.create(viewerOf(request), actorFor(request), request.body);
      return reply.code(201).header('ETag', etagFor(created.version)).send(serialise(created));
    },
  );

  app.patch<{
    Params: { id: number };
    Body: Partial<LibraryInput>;
    Headers: { 'if-match'?: string };
  }>(
    '/libraries/:id',
    {
      config: LIBRARY_WRITES,
      preValidation: nestingBounded,
      schema: {
        params: idParams,
        tags: ['libraries'],
        summary: 'Change a library',
        description:
          '`If-Match` carries the version this edit was made against, and without it the request ' +
          'is refused with 428: two people arranging one library is two people in a designer. ' +
          'One that has moved on is refused with 412 and `LIBRARY_CHANGED`. ' +
          '`nodes`, when sent, replaces every node — there is no merging of one tree into another.',
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            description: { type: 'string', maxLength: 1000 },
            priority: { type: 'integer', minimum: 1, maximum: 5 },
            nodes: { type: 'array', maxItems: MAX_NODES, items: { $ref: 'ms:libraryNode' } },
          },
        },
        response: { 200: { $ref: 'ms:library' } },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const updated = await libraries.update(
        viewerOf(request),
        actorFor(request),
        id,
        expectedVersion(request.headers['if-match'], id),
        request.body,
      );
      return reply.header('ETag', etagFor(updated.version)).send(serialise(updated));
    },
  );

  app.delete<{ Params: { id: number } }>(
    '/libraries/:id',
    {
      config: LIBRARY_WRITES,
      schema: {
        params: idParams,
        tags: ['libraries'],
        summary: 'Delete a library',
        description:
          'Needs full access. The grants on it go with it; no sensor does, because a library ' +
          'holds rules and never sensors.',
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      await libraries.remove(viewerOf(request), actorFor(request), request.params.id);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: number } }>(
    '/libraries/:id/access',
    {
      config: READS,
      schema: {
        params: idParams,
        tags: ['libraries'],
        summary: 'Which groups may see this library',
        description: 'Needs full access: who else can see a thing is not a read.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: grantResponse } },
          },
        },
      },
    },
    async (request) => {
      const grants = await libraries.grants(viewerOf(request), request.params.id);
      return {
        items: grants.map((grant) => ({ ...grant, grantedAt: grant.grantedAt.toISOString() })),
      };
    },
  );

  app.put<{ Params: { id: number; groupId: number }; Body: { right: AccessRight } }>(
    '/libraries/:id/access/:groupId',
    {
      config: LIBRARY_WRITES,
      schema: {
        params: grantParams,
        tags: ['libraries'],
        summary: 'Grant a group access to this library',
        description:
          'Needs full access, so a write holder may arrange the nodes without deciding who else ' +
          'sees them. Granting twice replaces rather than failing: it is a correction.',
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
      await libraries.grant(
        viewerOf(request),
        actorFor(request),
        request.params.id,
        request.params.groupId,
        request.body.right,
      );
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: number; groupId: number } }>(
    '/libraries/:id/access/:groupId',
    {
      config: LIBRARY_WRITES,
      schema: {
        params: grantParams,
        tags: ['libraries'],
        summary: 'Take a group’s access away',
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      await libraries.revoke(
        viewerOf(request),
        actorFor(request),
        request.params.id,
        request.params.groupId,
      );
      return reply.code(204).send();
    },
  );
}
