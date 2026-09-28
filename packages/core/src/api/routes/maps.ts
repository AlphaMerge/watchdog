// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { AuthError } from '../../auth/errors.js';
import type { AccessRight } from '../../auth/access.js';
import type { MapLayout, MapRow, MapShare } from '../../maps/repository.js';
import type { MapResolver } from '../../maps/resolver.js';
import type { MapService, MapViewer } from '../../maps/service.js';
import { MapError } from '../../maps/errors.js';
import { MAX_IMAGE_BYTES } from '../../maps/images.js';
import { actorFor } from '../authentication.js';
import { READS, writesIn } from '../authorization.js';

/**
 * Maps (`G-01`, `CAPABILITIES.MD §6`).
 *
 * **The right on a map is decided in the service, and only that part.** The route-level
 * `onObject(...)` helper resolves rights against the *object tree*, and a map is not in it — so
 * pointing it at a map id would ask the wrong table a question it cannot answer. `MapService`
 * holds the one place that decides, which is also what `G-06`'s public route will need when it
 * arrives with no principal at all.
 *
 * **Every change still declares `write`, which the hook checks** (`A-14`). These routes used to
 * declare `READS` throughout, and the service did decide — for a right on a map that exists.
 * Creating one has no such right, so a read-only account and a read-scoped token made maps and
 * were handed `full` on each. `MAP_WRITES` refuses both before anything is parsed, and says in its
 * `rightsIn` where the rest of the decision is made.
 *
 * **A map the caller cannot read answers 404, not 403.** Deliberate, and the reasoning is in
 * `maps/errors.ts`: distinguishing the two turns the error into an oracle for enumerating ids.
 */

export interface MapRouteOptions {
  maps: MapService;
  /**
   * Fills the widgets in (`G-02`), for the view route (`G-10`).
   *
   * Optional for the same reason `maps` is optional on the server: a build without one serves the
   * canvas document and not the resolved map, which is a different statement from serving an
   * empty one.
   */
  resolver?: MapResolver;
  /** What an operator configured, if anything (`G-08`, `ADR-004` Decision 1). */
  tiles?: { urlTemplate: string; attribution: string };
}

/** Every change to a map: `write` here, and the right on the map itself in `MapService`. */
const MAP_WRITES = writesIn('MapService');

/**
 * The version an edit was made against, from `If-Match`.
 *
 * `W/"3"`, `"3"` and a bare `3` are all accepted, because the web client sends the last. Missing
 * is 428 and not a version is 400, as the object API answers them (`A-14`) — it was a 401, which
 * told a signed-in caller to sign in.
 */
function expectedVersion(header: string | undefined, mapId: number): number {
  if (header === undefined || header.trim() === '') {
    throw new MapError(
      'MAP_PRECONDITION_REQUIRED',
      'this request requires an If-Match header carrying the version the edit was based on',
      { context: { mapId, phase: 'precondition' } },
    );
  }
  const version = Number(header.replace(/^W\/|"/g, ''));
  if (!Number.isInteger(version)) {
    throw new MapError('MAP_INVALID', `If-Match must carry a map version, got ${header}`, {
      context: { mapId, phase: 'precondition' },
    });
  }
  return version;
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

const backgroundResponse = {
  type: 'object',
  additionalProperties: false,
  required: ['mediaType', 'digest', 'width', 'height', 'bytes', 'uploadedAt', 'uploadedBy'],
  properties: {
    mediaType: { type: 'string' },
    /** The SHA-256 the serving route answers as a strong `ETag` (`ADR-003` Decision 4). */
    digest: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    bytes: { type: 'integer' },
    uploadedAt: { type: 'string', format: 'date-time' },
    uploadedBy: { type: 'string' },
  },
} as const;

/**
 * The types the upload route will *parse*, which is not the same as the types it accepts.
 *
 * Fastify needs a parser matched to the declared content type before a handler ever runs, so this
 * list decides what reaches the sniffer. `application/octet-stream` is here because a client that
 * declines to guess is being more honest than one that guesses wrong — and nothing downstream
 * believes any of it: `readImage` decides the format from the bytes (`ADR-003` Decision 2).
 */
const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'];

const shareResponse = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'label',
    'prefix',
    'expiresAt',
    'lastUsedAt',
    'revokedAt',
    'createdAt',
    'createdBy',
  ],
  properties: {
    id: { type: 'integer' },
    label: { type: 'string' },
    /** Never enough to use — the token itself is stored only as a hash. */
    prefix: { type: 'string' },
    expiresAt: { type: 'string', format: 'date-time' },
    lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
    revokedAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    createdBy: { type: 'string' },
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

function serialiseShare(share: MapShare): Record<string, unknown> {
  return {
    id: share.id,
    label: share.label,
    prefix: share.prefix,
    expiresAt: share.expiresAt.toISOString(),
    lastUsedAt: share.lastUsedAt?.toISOString() ?? null,
    revokedAt: share.revokedAt?.toISOString() ?? null,
    createdAt: share.createdAt.toISOString(),
    createdBy: share.createdBy,
  };
}

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
  const { maps, resolver } = options;
  const tiles = options.tiles ?? { urlTemplate: '', attribution: '' };

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

  if (resolver !== undefined) {
    app.get<{ Params: { id: string } }>(
      '/maps/:id/view',
      {
        config: READS,
        schema: {
          tags: ['maps'],
          summary: 'One map with its widgets filled in',
          description:
            'What a map draws, rather than the document it is stored as. A widget naming an ' +
            'object that has been deleted, or one this account may not see, comes back as ' +
            '`unavailable` and stays on the canvas — a dashboard that quietly stops mentioning ' +
            'what failed is worse than one with a hole in it. **Which of the two it is, is told ' +
            'to nobody**: anybody who may write can make a map, so telling its author would ' +
            'answer "does this id exist?" for any id they chose.',
          response: {
            200: {
              type: 'object',
              additionalProperties: false,
              required: ['map', 'widgets', 'connectors', 'problems'],
              properties: {
                map: mapResponse,
                // Loose on purpose: a resolved widget is a discriminated union whose arms differ
                // by kind, and a response schema that enumerated them would strip a field the
                // day a new widget kind arrives rather than failing loudly.
                widgets: { type: 'array', items: { type: 'object', additionalProperties: true } },
                connectors: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['id', 'from', 'to'],
                    properties: {
                      id: { type: 'string' },
                      from: { type: 'string' },
                      to: { type: 'string' },
                    },
                  },
                },
                problems: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['id', 'problem'],
                    properties: { id: { type: 'string' }, problem: { type: 'string' } },
                  },
                },
                geo: {
                  type: ['object', 'null'],
                  additionalProperties: false,
                  required: ['lat', 'lon', 'zoom', 'publicTiles'],
                  properties: {
                    lat: { type: 'number' },
                    lon: { type: 'number' },
                    zoom: { type: 'integer' },
                    publicTiles: { type: 'boolean' },
                  },
                },
                tiles: {
                  type: ['object', 'null'],
                  additionalProperties: false,
                  required: ['urlTemplate', 'attribution'],
                  properties: {
                    urlTemplate: { type: 'string' },
                    attribution: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      async (request) => {
        const viewer = viewerOf(request);
        const map = await maps.get(viewer, Number(request.params.id));
        const resolved = await resolver.resolve(map.layout, { kind: 'viewer', viewer });
        return {
          map: serialise(map),
          widgets: resolved.widgets,
          connectors: resolved.connectors,
          geo: resolved.geo,
          // A signed-in viewer gets whatever the operator configured; `ADR-004` Decision 4 is
          // about the *public* route, where the viewer is a stranger. Absent on a map that is
          // not geographical, because the tile source travels with the thing it draws under —
          // a plain canvas has nothing to put tiles behind.
          tiles: resolved.geo === null || tiles.urlTemplate === '' ? null : tiles,
          problems: resolved.problems,
        };
      },
    );
  }

  app.post<{ Body: MapBody }>(
    '/maps',
    {
      config: MAP_WRITES,
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
      const created = await maps.create(viewer, request.body, actorFor(request));
      return reply.code(201).send(serialise(created));
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<MapBody>; Headers: { 'if-match'?: string } }>(
    '/maps/:id',
    {
      config: MAP_WRITES,
      schema: {
        tags: ['maps'],
        summary: 'Change a map',
        description:
          '`If-Match` carries the version this edit was made against. Without it the request is ' +
          'refused with 428: a designer is a thing two people open at once, and last-write-wins ' +
          'there means somebody’s afternoon disappears without a message.',
        body: { ...mapBody, required: [] },
        response: { 200: mapResponse },
      },
    },
    async (request) => {
      const viewer = viewerOf(request);
      const id = Number(request.params.id);
      const updated = await maps.update(
        viewer,
        id,
        expectedVersion(request.headers['if-match'], id),
        request.body,
        actorFor(request),
      );
      return serialise(updated);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/maps/:id/shares',
    {
      config: READS,
      schema: {
        tags: ['maps'],
        summary: 'The public share links on this map',
        description:
          'Needs full access: a share link is a grant to everybody, and `full` is the right ' +
          'that decides a map’s audience. The tokens themselves are not here and cannot be — ' +
          'only their hashes are stored, so a URL is shown once when it is made.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: shareResponse } },
          },
        },
      },
    },
    async (request) => ({
      items: (await maps.shares(viewerOf(request), Number(request.params.id))).map(serialiseShare),
    }),
  );

  app.post<{ Params: { id: string }; Body: { label: string; expiresAt: string } }>(
    '/maps/:id/shares',
    {
      config: MAP_WRITES,
      schema: {
        tags: ['maps'],
        summary: 'Make a public share link',
        description:
          'Answers with the URL’s token **once**. Only its hash is stored, so it cannot be ' +
          'shown again — which is what keeps a database backup from being a set of working ' +
          'share links. An expiry is required (`ADR-002`): a link without one is a permanent ' +
          'unauthenticated route nobody remembers creating.',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'expiresAt'],
          properties: {
            label: { type: 'string', minLength: 1, maxLength: 100 },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
        response: {
          201: {
            type: 'object',
            additionalProperties: false,
            required: ['share', 'token'],
            properties: { share: shareResponse, token: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const expiresAt = new Date(request.body.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) {
        throw new MapError('MAP_INVALID', 'expiresAt must be a date', {
          context: { phase: 'share' },
        });
      }
      const made = await maps.createShare(
        viewerOf(request),
        Number(request.params.id),
        { label: request.body.label, expiresAt },
        actorFor(request),
      );
      return reply.code(201).send({ share: serialiseShare(made.share), token: made.token });
    },
  );

  app.delete<{ Params: { id: string; shareId: string } }>(
    '/maps/:id/shares/:shareId',
    {
      config: MAP_WRITES,
      schema: {
        tags: ['maps'],
        summary: 'Revoke a share link',
        description:
          'The link stops working immediately. The row stays, revoked, so the record of what ' +
          'existed outlives the decision to stop it.',
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      await maps.revokeShare(
        viewerOf(request),
        Number(request.params.id),
        Number(request.params.shareId),
        actorFor(request),
      );
      return reply.code(204).send();
    },
  );

  app.addContentTypeParser(UPLOAD_TYPES, { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.post<{ Params: { id: string } }>(
    '/maps/:id/background',
    {
      config: MAP_WRITES,
      // Refused by the framework before a byte of it is buffered, rather than after. The service
      // checks the same ceiling against what it received, because a limit enforced in one place
      // is a limit that moves when somebody adds a second caller.
      bodyLimit: MAX_IMAGE_BYTES,
      schema: {
        tags: ['maps'],
        summary: 'Put a background image behind a map',
        description:
          'PNG, JPEG or WebP, at most 2 MiB and 4096 pixels on a side. The format is decided by ' +
          'reading the file’s own header — the declared content type is a claim by the client ' +
          'and is never trusted. SVG is refused: it is a document rather than an image, and a ' +
          'background is drawn in the application’s own page (`ADR-003`). Needs `write`, the ' +
          'same right as moving a widget. The body is the file itself, not JSON.',
        // **No body schema on purpose.** The body is a `Buffer`, and every JSON Schema that
        // could be written here — `type: string` included — is a claim AJV would check against
        // an object that is not one, refusing every upload. What validates this body is
        // `readImage`, which is the only thing that can: a schema cannot read a PNG header.
        response: { 200: backgroundResponse },
      },
    },
    async (request) => {
      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        throw new MapError('MAP_INVALID', 'the request body must be image bytes', {
          context: { phase: 'upload-background' },
        });
      }
      const stored = await maps.setBackground(
        viewerOf(request),
        Number(request.params.id),
        body,
        actorFor(request),
      );
      return { ...stored, uploadedAt: stored.uploadedAt.toISOString() };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/maps/:id/background',
    {
      config: MAP_WRITES,
      schema: {
        tags: ['maps'],
        summary: 'Take the background off a map',
        description: 'Silent when there was none: the map ends up without one either way.',
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      await maps.removeBackground(viewerOf(request), Number(request.params.id), actorFor(request));
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/maps/:id',
    {
      config: MAP_WRITES,
      schema: {
        tags: ['maps'],
        summary: 'Delete a map',
        description: 'Needs full access. The grants on it go with it.',
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      await maps.remove(viewerOf(request), Number(request.params.id), actorFor(request));
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
      config: MAP_WRITES,
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
        actorFor(request),
      );
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string; groupId: string } }>(
    '/maps/:id/access/:groupId',
    {
      config: MAP_WRITES,
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
        actorFor(request),
      );
      return reply.code(204).send();
    },
  );
}

/**
 * Serving the bytes (`G-05`, `ADR-003` Decisions 3 and 4).
 *
 * **Registered apart from the rest**, because this is the one map route that does not answer JSON
 * and so cannot declare a response schema for `fast-json-stringify` to filter — the server's
 * `onRoute` guard requires one, and the exemption is granted around this call the same way it is
 * around the static plugin and the Prometheus endpoint. Keeping it to one function keeps the
 * exemption to one route rather than to the eight beside it.
 */
export function mapBackgroundRoute(app: FastifyInstance, options: { maps: MapService }): void {
  const { maps } = options;

  app.get<{ Params: { id: string }; Headers: { 'if-none-match'?: string } }>(
    '/maps/:id/background',
    {
      config: READS,
      schema: {
        tags: ['maps'],
        summary: 'The background image behind a map',
        description:
          'The stored bytes, with the SHA-256 of them as a strong ETag. Send `If-None-Match` ' +
          'and a wall display re-opens without downloading the floor plan again.',
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw new AuthError('AUTH_REQUIRED', 'this request needs a session; log in first');
      }
      const viewer: MapViewer =
        principal.scope === undefined
          ? { userId: principal.userId, role: principal.role }
          : { userId: principal.userId, role: principal.role, scope: principal.scope };

      const id = Number(request.params.id);
      // Metadata first, and the bytes only if they are actually needed: answering a conditional
      // request should not cost a two-megabyte read.
      const stored = await maps.backgroundOf(viewer, id);
      if (stored === undefined) {
        throw new MapError('MAP_NOT_FOUND', `map ${String(id)} has no background`, {
          context: { mapId: id, phase: 'read-background' },
        });
      }

      const etag = `"${stored.digest}"`;
      // **Not awaited.** A Fastify reply is thenable — `await reply` waits for the response to be
      // *sent*, which is a request that never finishes when nothing has sent one yet. Setting
      // headers is synchronous and returns the reply for chaining, and awaiting that chain hung
      // every conditional request until a test sat on it for two minutes.
      reply
        .header('etag', etag)
        // Stable URL across a replacement, so a long max-age would leave somebody looking at the
        // plan they just replaced. A revalidation is one small request and is right on the day
        // it matters.
        .header('cache-control', 'private, max-age=0, must-revalidate')
        // Defence in depth for a file an operator supplied: the browser may not decide this is
        // something other than the type we sniffed, and if it somehow reaches an executing
        // context there is nothing for it to reach.
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'")
        // No filename: the stored one is an operator's string and does not belong in a header.
        .header('content-disposition', 'inline');

      if (request.headers['if-none-match'] === etag) return reply.code(304).send();

      const bytes = await maps.backgroundBytes(viewer, id);
      /* c8 ignore next -- the metadata row was read in the same request */
      if (bytes === undefined)
        throw new MapError('MAP_NOT_FOUND', 'the background has gone', {
          context: { mapId: id, phase: 'read-background' },
        });
      return reply.type(stored.mediaType).send(bytes);
    },
  );
}
