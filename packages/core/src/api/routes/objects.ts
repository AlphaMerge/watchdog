// Side-effect import: @fastify/swagger augments FastifySchema with `description`, which the
// generated OpenAPI document carries into the API reference (H-07).
import '@fastify/swagger';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ObjectError } from '../../objects/errors.js';
import type { ObjectService } from '../../objects/service.js';
import type { Actor } from '../../objects/audit.js';
import { settingRegistry } from '../../settings/registry.js';
import type {
  CreateObjectInput,
  DeleteExpectation,
  ListSort,
  ObjectKind,
  SiblingMove,
  UpdateObjectInput,
} from '../../objects/types.js';
import { channelLimitsPatchSchema, channelProcessingPatchSchema } from '../schemas/objects.js';
import {
  acknowledgeRequestSchema,
  ACK_PRESETS,
  pauseRequestSchema,
  PAUSE_PRESETS,
} from '../schemas/pause.js';
import type { ChannelLimitsPatch } from '../../state/limits.js';
import type { ChannelProcessing } from '../../objects/types.js';
import { decodeCursor } from '../pagination.js';
import { etagFor, optionalIfMatch, requireIfMatch } from '../preconditions.js';

export interface ObjectRoutesOptions {
  service: ObjectService;
  /**
   * Folded into the cache validator for inheritance-bearing responses. The last input to a
   * resolved setting is its registry default, which lives in code — so an upgrade has to
   * invalidate the caches even when no row changed.
   */
  buildVersion: string;
}

interface ListQuery {
  parentId?: number;
  kind?: string | string[];
  tag?: string | string[];
  q?: string;
  host?: string;
  priorityMin?: number;
  sort?: ListSort;
  effective?: string | string[];
  cursor?: string;
  limit?: number;
}

const asArray = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** Until accounts exist (A-01), every actor is the caller's address — in exactly one place. */
function actorFor(request: FastifyRequest): Actor {
  return { kind: 'anonymous', remoteAddress: request.ip };
}

function assertKnownSettingKeys(keys: readonly string[]): void {
  for (const key of keys) {
    if (!settingRegistry.has(key)) {
      throw new ObjectError('OBJECT_INVALID', `unknown setting key "${key}"`, {
        context: { phase: 'validate-query' },
        details: { knownKeys: settingRegistry.keys },
      });
    }
  }
}

/**
 * Path and query parameters are validated at the boundary like every other input. Declaring
 * them also makes Fastify coerce `?limit=100` to a number, so the handler's types are honest
 * about what it actually receives.
 */
const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  // `object.id` is bigint, but a JS number is only exact below 2^53 and PostgreSQL rejects
  // anything past bigint outright. Bounding it here turns a driver-level 500 into a 400.
  properties: { id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
} as const;

const settingKeyParams = {
  type: 'object',
  required: ['id', 'key'],
  additionalProperties: false,
  properties: {
    id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    key: { type: 'string', minLength: 1, maxLength: 100 },
  },
} as const;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    parentId: { type: 'integer', minimum: 1 },
    // Enumerated here so an unknown kind is a 400 from the boundary rather than a 500 from
    // PostgreSQL failing to cast it to object_kind.
    kind: {
      type: ['string', 'array'],
      items: { enum: ['root', 'probe', 'group', 'device', 'sensor'] },
      enum: ['root', 'probe', 'group', 'device', 'sensor'],
    },
    tag: { type: ['string', 'array'], items: { type: 'string' }, maxLength: 100 },
    q: { type: 'string', maxLength: 500 },
    host: { type: 'string', maxLength: 255 },
    priorityMin: { type: 'integer', minimum: 1, maximum: 5 },
    sort: { enum: ['name', 'id', 'manual'], default: 'name' },
    effective: { type: ['string', 'array'], items: { type: 'string' } },
    cursor: { type: 'string', maxLength: 2048 },
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
  },
} as const;

const treeQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    maxDepth: { type: 'integer', minimum: 1, maximum: 20, default: 3 },
    limit: { type: 'integer', minimum: 1, maximum: 5000, default: 1000 },
    kind: {
      type: ['string', 'array'],
      items: { enum: ['root', 'probe', 'group', 'device', 'sensor'] },
      enum: ['root', 'probe', 'group', 'device', 'sensor'],
    },
    effective: { type: ['string', 'array'], items: { type: 'string' } },
  },
} as const;

const INCLUDE_TOKENS = ['settings', 'channels', 'credentials', 'ancestors'] as const;
type IncludeToken = (typeof INCLUDE_TOKENS)[number];

function parseInclude(raw: string | undefined): Set<IncludeToken> {
  const out = new Set<IncludeToken>();
  if (raw === undefined || raw === '') return out;
  for (const token of raw.split(',').map((t) => t.trim())) {
    if (!(INCLUDE_TOKENS as readonly string[]).includes(token)) {
      throw new ObjectError('OBJECT_INVALID', `unknown include token "${token}"`, {
        context: { phase: 'validate-query' },
        details: { known: [...INCLUDE_TOKENS] },
      });
    }
    out.add(token as IncludeToken);
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins are async by contract
export async function objectRoutes(
  app: FastifyInstance,
  options: ObjectRoutesOptions,
): Promise<void> {
  const { service, buildVersion } = options;

  const sendDetail = async (
    reply: FastifyReply,
    id: number,
    include: Set<IncludeToken>,
    status = 200,
  ): Promise<void> => {
    const object = await service.get(id);
    const body: Record<string, unknown> = { ...object };

    if (include.has('settings')) body['settings'] = await service.settings(id);
    if (include.has('channels') && object.kind === 'sensor') {
      body['channels'] = await service.channels(id);
    }
    if (include.has('credentials')) body['credentials'] = await service.credentials(id, true);
    if (include.has('ancestors')) body['ancestors'] = await service.ancestors(id);

    // A response carrying inherited content needs a validator that covers what it inherited,
    // or the next conditional request gets a 304 built from this object's version alone.
    const chain = include.size === 0 ? undefined : await validatorFor(id);
    await reply.status(status).header('ETag', etagFor(object.version, chain)).send(body);
  };

  /** Undefined rather than null, so `etagFor` falls back to the plain version tag. */
  const validatorFor = async (id: number): Promise<string | undefined> =>
    (await service.chainValidator(id, buildVersion)) ?? undefined;

  // ── 1. list ──────────────────────────────────────────────────────────────────────────────
  app.get<{ Querystring: ListQuery }>(
    '/objects',
    {
      schema: {
        querystring: listQuery,
        description:
          'Flat filtered listing, keyset-paginated. Note: under sort=name an object renamed ' +
          'mid-pagination can be returned twice or missed — inherent to keyset paging and ' +
          'acceptable for a UI. Anything that must be exact (bulk selection, config export) ' +
          'must use sort=id, which is immutable.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'nextCursor'],
            properties: {
              items: { type: 'array', items: { $ref: 'ms:objectSummary' } },
              nextCursor: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const query = request.query;
      const sort: ListSort =
        query.sort === 'id' ? 'id' : query.sort === 'manual' ? 'manual' : 'name';
      // A manual arrangement is a fact about one parent's children. Ordering a filtered slice of
      // the whole tree by it would interleave positions from unrelated groups into something
      // deterministic and meaningless, so it is refused rather than served.
      if (sort === 'manual' && query.parentId === undefined) {
        throw new ObjectError(
          'OBJECT_INVALID',
          'sort=manual needs a parentId to be manual within',
          {
            context: { phase: 'validate-query' },
          },
        );
      }
      const limit = query.limit ?? 100;
      const effective = asArray(query.effective);
      assertKnownSettingKeys(effective);

      const page = await service.list(
        {
          ...(query.parentId === undefined ? {} : { parentId: query.parentId }),
          ...(asArray(query.kind).length === 0
            ? {}
            : { kinds: asArray(query.kind) as ObjectKind[] }),
          ...(asArray(query.tag).length === 0 ? {} : { tags: asArray(query.tag) }),
          ...(query.q === undefined ? {} : { q: query.q }),
          ...(query.host === undefined ? {} : { host: query.host }),
          ...(query.priorityMin === undefined
            ? {}
            : { priorityMin: query.priorityMin as 1 | 2 | 3 | 4 | 5 }),
        },
        {
          limit,
          sort,
          cursor: query.cursor === undefined ? null : decodeCursor(query.cursor, sort),
        },
        effective,
      );

      await reply.send(page);
    },
  );

  // ── 3. root ──────────────────────────────────────────────────────────────────────────────
  app.get<{ Querystring: { include?: string } }>(
    '/objects/root',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { include: { type: 'string', maxLength: 200 } },
        },
        response: { 200: { $ref: 'ms:objectDetail' } },
      },
    },
    async (request, reply) => {
      const root = await service.getRoot();
      await sendDetail(reply, root.id, parseInclude(request.query.include));
    },
  );

  // ── 16. setting definitions ──────────────────────────────────────────────────────────────
  app.get(
    '/setting-definitions',
    {
      schema: {
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
                  required: ['key', 'schema', 'default', 'description'],
                  properties: {
                    key: { type: 'string' },
                    schema: { type: 'object', additionalProperties: true },
                    default: {},
                    description: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      await reply.send({
        items: settingRegistry.definitions().map((d) => ({
          key: d.key,
          schema: d.schema,
          default: d.default,
          description: d.description,
        })),
      });
    },
  );

  // ── 2. create ────────────────────────────────────────────────────────────────────────────
  app.post<{ Body: CreateObjectInput }>(
    '/objects',
    {
      schema: { body: { $ref: 'ms:createObject' }, response: { 201: { $ref: 'ms:objectDetail' } } },
    },
    async (request, reply) => {
      const created = await service.create(actorFor(request), request.body);
      await reply
        .status(201)
        .header('Location', `/api/v1/objects/${String(created.id)}`)
        .header('ETag', etagFor(created.version))
        .send(created);
    },
  );

  // ── 4. read ──────────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: number }; Querystring: { include?: string } }>(
    '/objects/:id',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { include: { type: 'string', maxLength: 200 } },
        },
        response: { 200: { $ref: 'ms:objectDetail' } },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const include = parseInclude(request.query.include);
      const ifNoneMatch = request.headers['if-none-match'];

      // Answered before the read, which is the point: the validator is one recursive walk of
      // (id, version) up the ancestor chain, against a full render that resolves every
      // inherited setting and credential for every level of it.
      //
      // `?include=settings` and `?include=credentials` show values inherited from ancestors, and
      // an ancestor's change does not bump *this* object's version — so a tag built from the
      // version alone would let a 304 hide a revoked credential or a changed scan interval from
      // a client doing exactly what the protocol tells it to. The chain digest is what closes
      // that (S-13), and it covers a re-parenting as well as an edit.
      if (ifNoneMatch !== undefined) {
        const object = await service.get(id);
        const chain = include.size === 0 ? undefined : await validatorFor(id);
        const current = etagFor(object.version, chain);
        if (ifNoneMatch === current) {
          await reply.status(304).header('ETag', current).send();
          return;
        }
      }

      await sendDetail(reply, id, include);
    },
  );

  // ── 5. update ────────────────────────────────────────────────────────────────────────────
  app.patch<{ Params: { id: number }; Body: UpdateObjectInput }>(
    '/objects/:id',
    {
      schema: {
        params: idParams,
        body: { $ref: 'ms:updateObject' },
        response: { 200: { $ref: 'ms:objectDetail' } },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const pre = requireIfMatch(request.headers['if-match']);
      const updated = await service.update(actorFor(request), id, request.body, pre);
      await reply.header('ETag', etagFor(updated.version)).send(updated);
    },
  );

  // ── 6. delete ────────────────────────────────────────────────────────────────────────────
  app.delete<{ Params: { id: number }; Querystring: { expectedDescendants?: number } }>(
    '/objects/:id',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { expectedDescendants: { type: 'integer', minimum: 0 } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'kind', 'name', 'deleted'],
            properties: {
              id: { type: 'integer' },
              kind: { type: 'string' },
              name: { type: 'string' },
              deleted: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const expected = request.query.expectedDescendants;
      const expectation: DeleteExpectation =
        expected === undefined ? { kind: 'leafOnly' } : { kind: 'exact', descendants: expected };

      const report = await service.delete(
        actorFor(request),
        id,
        expectation,
        optionalIfMatch(request.headers['if-match']),
      );

      // Always 200 with a receipt, never 204: uniform for clients, and the operator gets to
      // see what was destroyed.
      await reply.send({
        id: report.id,
        kind: report.kind,
        name: report.name,
        deleted: report.deleted,
      });
    },
  );

  // ── 6b. reorder among siblings ────────────────────────────────────────────────────────────
  app.post<{ Params: { id: number }; Body: { move: SiblingMove } }>(
    '/objects/:id/order',
    {
      schema: {
        description:
          "Moves an object within its parent's children, the way PRTG's move up / move down " +
          'does. Siblings nobody has arranged keep sorting by name, so a tree that has never ' +
          'been ordered by hand reads exactly as it did before. Listings honour the ' +
          'arrangement through `GET /objects?parentId=…&sort=manual` and through the tree ' +
          'endpoint, which always does. A move that changes nothing is a no-op, not an error.',
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['move'],
          properties: { move: { enum: ['up', 'down', 'first', 'last'] } },
        },
        response: { 200: { $ref: 'ms:objectDetail' } },
      },
    },
    async (request, reply) => {
      const reordered = await service.reorder(
        actorFor(request),
        request.params.id,
        request.body.move,
        optionalIfMatch(request.headers['if-match']),
      );
      await reply.header('ETag', etagFor(reordered.version)).send(reordered);
    },
  );

  // ── 7. move ──────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: number }; Body: { targetParentId: number } }>(
    '/objects/:id/move',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['targetParentId'],
          properties: { targetParentId: { type: 'integer', minimum: 1 } },
        },
        response: { 200: { $ref: 'ms:moveResult' } },
      },
    },
    async (request, reply) => {
      const result = await service.move(
        actorFor(request),
        request.params.id,
        request.body.targetParentId,
        optionalIfMatch(request.headers['if-match']),
      );
      await reply.header('ETag', etagFor(result.object.version)).send(result);
    },
  );

  // ── 8. clone ─────────────────────────────────────────────────────────────────────────────
  app.post<{
    Params: { id: number };
    // A clone with no options is a legitimate request, so the body may be absent entirely.
    Body: { targetParentId?: number; name?: string } | undefined;
  }>(
    '/objects/:id/clone',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            targetParentId: { type: 'integer', minimum: 1 },
            name: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
        response: { 201: { $ref: 'ms:cloneResult' } },
      },
    },
    async (request, reply) => {
      const result = await service.clone(actorFor(request), request.params.id, request.body ?? {});
      await reply
        .status(201)
        .header('Location', `/api/v1/objects/${String(result.object.id)}`)
        .header('ETag', etagFor(result.object.version))
        .send(result);
    },
  );

  // ── 9. subtree ───────────────────────────────────────────────────────────────────────────
  app.get<{
    Params: { id: number };
    Querystring: {
      maxDepth?: number;
      limit?: number;
      kind?: string | string[];
      effective?: string | string[];
    };
  }>(
    '/objects/:id/tree',
    {
      schema: {
        params: idParams,
        querystring: treeQuery,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'truncated'],
            properties: {
              items: { type: 'array', items: { $ref: 'ms:objectSummary' } },
              truncated: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const effective = asArray(request.query.effective);
      assertKnownSettingKeys(effective);
      const result = await service.subtree(
        request.params.id,
        {
          maxDepth: request.query.maxDepth ?? 3,
          limit: request.query.limit ?? 1000,
          ...(asArray(request.query.kind).length === 0
            ? {}
            : { kinds: asArray(request.query.kind) as ObjectKind[] }),
        },
        effective,
      );
      await reply.send(result);
    },
  );

  // ── 10. ancestors ────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: number } }>(
    '/objects/:id/ancestors',
    {
      schema: {
        params: idParams,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: { $ref: 'ms:objectRef' } } },
          },
        },
      },
    },
    async (request, reply) => {
      await reply.send({ items: await service.ancestors(request.params.id) });
    },
  );

  // ── 11. channels ─────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: number } }>(
    '/objects/:id/channels',
    {
      schema: {
        params: idParams,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: { $ref: 'ms:channelRecord' } } },
          },
        },
      },
    },
    async (request, reply) => {
      await reply.send({ items: await service.channels(request.params.id) });
    },
  );

  /**
   * How a channel is judged: its limits (`M-04`), its lookup (`M-06`), or both.
   *
   * `PATCH` on the channel rather than a resource per field, because `M-07` adds scaling
   * factors, decimals and the spike filter to the same row and they should not each grow an
   * endpoint. `additionalProperties: false` says plainly which fields exist today rather than
   * ignoring the rest.
   */
  app.patch<{
    Params: { id: number; key: string };
    Body: {
      limits?: ChannelLimitsPatch;
      lookupId?: string | null;
      processing?: Partial<ChannelProcessing>;
    };
  }>(
    '/objects/:id/channels/:key',
    {
      schema: {
        description:
          'Sets a channel’s error and warning limits, the lookup that decides its state, or ' +
          'both. `limits` is a patch: `null` clears one threshold, an absent field leaves it ' +
          'alone. Both are immediate — a reading past an error limit, or one a lookup maps to ' +
          'an error, sets the sensor Down on the very first sample with no two-step rule. A ' +
          'channel with a lookup is judged by it *instead of* its limits. Limits that ' +
          'contradict each other are refused with the reason; a `lookupId` this installation ' +
          'has not loaded is accepted and reported, because a sensor type may ship ahead of ' +
          'its lookup file. `processing` sets the scaling factors, the spike filter and the ' +
          'decimal places — scaling is applied before anything judges the reading, and before ' +
          'the spike filter, so both bounds and limits are numbers in the channel’s own unit. ' +
          'Changing a factor does not rewrite readings already stored, so the graph steps at ' +
          'the moment of the change.',
        params: {
          type: 'object',
          required: ['id', 'key'],
          additionalProperties: false,
          properties: {
            id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            key: { type: 'string', minLength: 1, maxLength: 100 },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            limits: channelLimitsPatchSchema,
            lookupId: { type: ['string', 'null'], minLength: 1, maxLength: 100 },
            processing: channelProcessingPatchSchema,
          },
        },
        response: { 200: { $ref: 'ms:channelRecord' } },
      },
    },
    async (request, reply) => {
      const updated = await service.patchChannel(
        actorFor(request),
        request.params.id,
        request.params.key,
        request.body,
        optionalIfMatch(request.headers['if-match']),
      );
      await reply.send(updated);
    },
  );

  // ── 11b. pause (M-08) ────────────────────────────────────────────────────────────────────

  app.post<{
    Params: { id: number };
    Body: { minutes?: number; until?: string; from?: string; message?: string };
  }>(
    '/objects/:id/pause',
    {
      schema: {
        description:
          'Pauses an object and every sensor beneath it. Give `minutes` for a duration, `until` ' +
          'for a moment, or neither to pause indefinitely — until a person says otherwise. ' +
          `A UI offers ${PAUSE_PRESETS.join(', ')} minutes as presets, but any duration is ` +
          'accepted. Takes effect immediately: the sensors change state in this request, and ' +
          'their probe stops being told to scan them. Pausing an already-paused object replaces ' +
          'the reason and the deadline rather than stacking, which is what extending a ' +
          'maintenance window means. ' +
          'Give `from` with `until` for a **maintenance window** — the same pause, scheduled ' +
          'rather than immediate. Nothing is paused until it starts; the object reads `pending` ' +
          'until then and can be cancelled at any point by resuming it.',
        params: idParams,
        body: pauseRequestSchema,
        response: { 200: { $ref: 'ms:pauseView' } },
      },
    },
    async (request, reply) => {
      const { minutes, until, from, message } = request.body;
      const pause =
        from !== undefined && until !== undefined
          ? ({ kind: 'window', from: new Date(from), until: new Date(until) } as const)
          : minutes !== undefined
            ? ({ kind: 'duration', minutes } as const)
            : until !== undefined
              ? ({ kind: 'until', until: new Date(until) } as const)
              : ({ kind: 'indefinite' } as const);

      const view = await service.pause(
        actorFor(request),
        request.params.id,
        pause,
        message ?? '',
        optionalIfMatch(request.headers['if-match']),
      );
      await reply.send(view);
    },
  );

  app.delete<{ Params: { id: number } }>(
    '/objects/:id/pause',
    {
      schema: {
        description:
          'Resumes an object, or cancels a maintenance window it has not reached yet. Only the ' +
          'object that was directly paused can be resumed — a sensor paused because its device ' +
          'is paused has nothing of its own to clear, and the 409 names the object to resume ' +
          'instead. A resumed sensor reads Unknown until its next scan, never the state it had ' +
          'before the pause, which the system has not checked since.',
        params: idParams,
        response: { 200: { $ref: 'ms:pauseView' } },
      },
    },
    async (request, reply) => {
      const view = await service.resume(
        actorFor(request),
        request.params.id,
        optionalIfMatch(request.headers['if-match']),
      );
      await reply.send(view);
    },
  );

  app.get<{ Params: { id: number } }>(
    '/objects/:id/pause',
    {
      schema: {
        description:
          'Whether this object is paused, why, until when, and whether this is the one that can ' +
          'be resumed.',
        params: idParams,
        response: { 200: { $ref: 'ms:pauseView' } },
      },
    },
    async (request, reply) => {
      // Never cached: a timed pause expires on its own, with no write for a validator to move.
      void reply.header('cache-control', 'no-store');
      await reply.send(await service.pauseState(request.params.id));
    },
  );

  // ── 11d. acknowledgement (M-13) ──────────────────────────────────────────────────────────

  app.post<{
    Params: { id: number };
    Body: { minutes?: number; until?: string; message?: string };
  }>(
    '/objects/:id/acknowledge',
    {
      schema: {
        description:
          'Acknowledges a Down alarm: the sensor reads Down (Acknowledged), notifications stop, ' +
          'and monitoring carries on exactly as before. Give `minutes` for a duration, `until` ' +
          'for a moment, or neither to acknowledge indefinitely. ' +
          `A UI offers ${ACK_PRESETS.join(', ')} minutes as presets. ` +
          'On a device or a group this acknowledges every sensor beneath it that is Down **at ' +
          'this moment** — a snapshot, not a rule, so a sensor that fails later is a new alarm. ' +
          'The message becomes the sensor’s last message. It clears on recovery, on expiry, on ' +
          'pause-then-resume, or by DELETE.',
        params: idParams,
        body: acknowledgeRequestSchema,
        response: { 200: { $ref: 'ms:acknowledgementView' } },
      },
    },
    async (request, reply) => {
      const { minutes, until, message } = request.body;
      const acknowledgement =
        minutes !== undefined
          ? ({ kind: 'duration', minutes } as const)
          : until !== undefined
            ? ({ kind: 'until', until: new Date(until) } as const)
            : ({ kind: 'indefinite' } as const);

      await reply.send(
        await service.acknowledge(actorFor(request), request.params.id, acknowledgement, message),
      );
    },
  );

  app.delete<{ Params: { id: number } }>(
    '/objects/:id/acknowledge',
    {
      schema: {
        description:
          'Withdraws an acknowledgement, so the alarm reads Down again and notifications ' +
          'resume. The three things that clear one on their own — recovery, expiry and ' +
          'pause-then-resume — are all events; this is the one for "I acknowledged the wrong ' +
          'sensor".',
        params: idParams,
        response: { 200: { $ref: 'ms:acknowledgementView' } },
      },
    },
    async (request, reply) => {
      await reply.send(await service.clearAcknowledgement(actorFor(request), request.params.id));
    },
  );

  // ── 11e. simulated error (M-14) ──────────────────────────────────────────────────────────

  app.post<{ Params: { id: number }; Body: { message?: string } }>(
    '/objects/:id/simulate-error',
    {
      schema: {
        description:
          'Forces sensors Down so a notification chain can be tested end to end. ' +
          '**This fires the real chain at real people** — which is the point, since a chain ' +
          'nobody has seen fire is a chain nobody knows works. The sensor reads Down with cause ' +
          '`simulated`, never `scan`, so a forced outage cannot be mistaken for a real one; the ' +
          'message becomes its last message; the action is audited. On a device or a group this ' +
          'forces **every** sensor beneath it, whatever state it was in. Pausing still wins, so ' +
          'a sensor somebody switched off will not start paging anyone.',
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { message: { type: 'string', maxLength: 500 } },
        },
        response: { 200: { $ref: 'ms:simulatedErrorView' } },
      },
    },
    async (request, reply) => {
      await reply.send(
        await service.simulateError(
          actorFor(request),
          request.params.id,
          true,
          request.body.message,
        ),
      );
    },
  );

  app.delete<{ Params: { id: number } }>(
    '/objects/:id/simulate-error',
    {
      schema: {
        description:
          'Lifts a simulated error. The sensors return to what they actually measure straight ' +
          'away — unlike a resume, which yields Unknown, because a forced sensor never stopped ' +
          'being scanned: the force changes what its readings *mean*, not whether it takes any.',
        params: idParams,
        response: { 200: { $ref: 'ms:simulatedErrorView' } },
      },
    },
    async (request, reply) => {
      await reply.send(await service.simulateError(actorFor(request), request.params.id, false));
    },
  );

  // ── 11c. dependency (M-11) ───────────────────────────────────────────────────────────────

  app.put<{
    Params: { id: number };
    Body: {
      mode: 'parent' | 'object' | 'device' | 'none';
      masterId?: number;
      delaySeconds?: number;
    };
  }>(
    '/objects/:id/dependency',
    {
      schema: {
        description:
          'Sets what this object depends on. `parent` inherits from above, `object` names a ' +
          'master sensor, `none` depends on nothing, and `device` makes **this sensor** the ' +
          'master for its parent device — which is what auto-discovery sets on a Ping sensor, ' +
          'and what pauses the rest of a device when it stops answering. ' +
          'A master pauses its dependents only when it is genuinely Down or Down (Acknowledged); ' +
          'pausing a master by hand or by schedule does not. `delaySeconds` keeps dependents ' +
          'paused after the master recovers, so a flapping link does not alarm on every bounce. ' +
          'A dependency that would form a loop is refused: a loop of masters can never recover.',
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['mode'],
          properties: {
            mode: { enum: ['parent', 'object', 'device', 'none'] },
            masterId: { type: 'integer', minimum: 1 },
            delaySeconds: { type: 'integer', minimum: 0, maximum: 86_400 },
          },
        },
        response: { 200: { $ref: 'ms:pauseView' } },
      },
    },
    async (request, reply) => {
      const { mode, masterId, delaySeconds } = request.body;
      const view = await service.setDependency(
        actorFor(request),
        request.params.id,
        mode,
        masterId,
        delaySeconds,
        optionalIfMatch(request.headers['if-match']),
      );
      await reply.send(view);
    },
  );

  // ── 12. settings ─────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: number }; Querystring: { asChildOf?: number } }>(
    '/objects/:id/settings',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { asChildOf: { type: 'integer', minimum: 1 } },
        },
        description:
          'Effective and own values together. ?asChildOf=<parentId> projects what the object ' +
          'would resolve to under a different parent — the move confirmation dialog, without ' +
          'performing the move.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['objectId', 'asChildOf', 'settings'],
            properties: {
              objectId: { type: 'integer' },
              asChildOf: { type: ['integer', 'null'] },
              settings: { type: 'array', items: { $ref: 'ms:settingView' } },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const asChildOf = request.query.asChildOf;
      await reply.send({
        objectId: id,
        asChildOf: asChildOf ?? null,
        settings: await service.settings(id, asChildOf),
      });
    },
  );

  // ── 13. set a setting ────────────────────────────────────────────────────────────────────
  app.put<{ Params: { id: number; key: string }; Body: { value: unknown } }>(
    '/objects/:id/settings/:key',
    {
      schema: {
        params: settingKeyParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['value'],
          properties: { value: {} },
        },
        response: { 200: { $ref: 'ms:settingView' } },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const key = request.params.key;
      assertKnownSettingKeys([key]);

      await service.setSetting(
        actorFor(request),
        id,
        key,
        request.body.value,
        optionalIfMatch(request.headers['if-match']),
      );
      const view = (await service.settings(id)).find((s) => s.key === key);
      await reply.send(view);
    },
  );

  // ── 14. revert a setting ─────────────────────────────────────────────────────────────────
  app.delete<{ Params: { id: number; key: string } }>(
    '/objects/:id/settings/:key',
    {
      schema: {
        params: settingKeyParams,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'reverted', 'effective', 'own'],
            properties: {
              key: { type: 'string' },
              reverted: { type: 'boolean' },
              effective: {
                type: 'object',
                additionalProperties: false,
                required: ['value', 'source'],
                properties: { value: {}, source: { $ref: 'ms:settingSource' } },
              },
              own: { type: 'null' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const key = request.params.key;
      assertKnownSettingKeys([key]);

      const reverted = await service.clearSetting(
        actorFor(request),
        id,
        key,
        optionalIfMatch(request.headers['if-match']),
      );
      const view = (await service.settings(id)).find((s) => s.key === key);
      // The newly effective value comes back with the response, so the form repaints without
      // a second round trip.
      await reply.send({ key, reverted, effective: view?.effective, own: null });
    },
  );

  // ── 15. credentials ──────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: number }; Querystring: { effective?: string } }>(
    '/objects/:id/credentials',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { effective: { type: 'string', enum: ['true', 'false'] } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: { $ref: 'ms:credentialView' } } },
          },
        },
      },
    },
    async (request, reply) => {
      const includeInherited = request.query.effective !== 'false';
      await reply.send({
        items: await service.credentials(request.params.id, includeInherited),
      });
    },
  );
}
