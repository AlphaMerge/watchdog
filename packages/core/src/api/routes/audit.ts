// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import type { AuditRepository } from '../../audit/store.js';
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
          'Sensor parameters are listed in `summary.paramsChanged` by key only — never by ' +
          'value — because a parameter can hold a credential until P-05 lands redaction.',
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

  await Promise.resolve();
}
