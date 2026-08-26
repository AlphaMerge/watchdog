// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { AUDIT_CATEGORIES, type AuditRepository } from '../../audit/store.js';
import type { Database } from '../../db/pool.js';

export interface AuditRoutesOptions {
  db: Database;
  audit: AuditRepository;
}

const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
} as const;

const auditQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // The id of the oldest entry already seen. Audit ids are monotonic, so this is a keyset
    // cursor that happens to be readable — there is nothing to hide in it, and an operator
    // debugging a paging problem can see where they are.
    before: { type: 'string', pattern: '^[0-9]{1,19}$' },
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
  },
} as const;

interface AuditQueryString {
  before?: string;
  limit: number;
}

/** The global list's own filters, on top of paging. */
const logQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    objectId: { type: 'integer', minimum: 1 },
    category: {
      oneOf: [
        { enum: [...AUDIT_CATEGORIES] },
        {
          type: 'array',
          items: { enum: [...AUDIT_CATEGORIES] },
          maxItems: AUDIT_CATEGORIES.length,
        },
      ],
    },
    actorKind: {
      oneOf: [
        { type: 'string', maxLength: 40 },
        { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 10 },
      ],
    },
    from: { type: 'string', maxLength: 64 },
    to: { type: 'string', maxLength: 64 },
    before: { type: 'string', pattern: '^[0-9]{1,19}$' },
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
  },
} as const;

interface LogQueryString extends AuditQueryString {
  objectId?: number;
  category?: string | string[];
  actorKind?: string | string[];
  from?: string;
  to?: string;
}

/** Accepts one or several, because a query string spells both the same way. */
function many(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/** A date that parsed, or undefined — the filter is dropped rather than the request refused. */
function when(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

export async function auditRoutes(
  app: FastifyInstance,
  options: AuditRoutesOptions,
): Promise<void> {
  const { db, audit } = options;

  app.get<{ Params: { id: number }; Querystring: AuditQueryString }>(
    '/objects/:id/audit',
    {
      schema: {
        description:
          "An object's configuration history, newest first: who changed it, when, and what " +
          'changed. Page with `before`, using the `nextBefore` from the previous page. ' +
          'Sensor parameters changed are listed in `summary.paramsChanged` by key. Values ' +
          'appear in `diff` for parameters the sensor type does not mark `writeOnly`; a ' +
          'credential never appears in either, in any entry, at any age.',
        params: idParams,
        querystring: auditQuery,
        response: { 200: { $ref: 'ms:auditPage' } },
      },
    },
    async (request) => {
      const { before, limit } = request.query;

      // Deliberately no existence check, and therefore no 404. The entry most worth reading is
      // the one recording a deletion, and it is written about an object that no longer exists;
      // refusing to serve history for something that has been deleted would hide exactly the
      // change someone came here to find.
      const items = await db.tx((q) =>
        audit.list(q, {
          objectId: request.params.id,
          ...(before === undefined ? {} : { before }),
          limit,
        }),
      );

      return {
        items,
        nextBefore: items.length < limit ? null : (items.at(-1)?.id ?? null),
      };
    },
  );

  app.get<{ Querystring: LogQueryString }>(
    '/audit',
    {
      schema: {
        description:
          'Configuration history across the whole installation, newest first — the object ' +
          'history third of the Logs view (`CAPABILITIES.MD §6`). Filter by `category` (the ' +
          "action's first segment), by `actorKind`, by time, or to one object. **`objectId` is " +
          'that object exactly, never its subtree**: the entry most worth reading is the one ' +
          'recording a deletion, and an object that has been deleted has no parent left to be ' +
          'found through, so a subtree walk would drop precisely those. Page with `before`.',
        querystring: logQuery,
        response: { 200: { $ref: 'ms:auditPage' } },
      },
    },
    async (request) => {
      const { objectId, category, actorKind, from, to, before, limit } = request.query;
      const categories = many(category);
      const actorKinds = many(actorKind);
      const since = when(from);
      const until = when(to);

      const items = await db.tx((q) =>
        audit.list(q, {
          ...(objectId === undefined ? {} : { objectId }),
          ...(categories === undefined ? {} : { categories }),
          ...(actorKinds === undefined ? {} : { actorKinds }),
          ...(since === undefined ? {} : { from: since }),
          ...(until === undefined ? {} : { to: until }),
          ...(before === undefined ? {} : { before }),
          limit,
        }),
      );

      return {
        items,
        nextBefore: items.length < limit ? null : (items.at(-1)?.id ?? null),
      };
    },
  );

  await Promise.resolve();
}
