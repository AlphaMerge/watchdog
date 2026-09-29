/**
 * Path parameters for the entities outside the object tree: maps, reports and libraries (`L-06`).
 *
 * **Declared, so that a bad id is a 400.** These routes had no params schema, so `Number('abc')`
 * reached PostgreSQL as `NaN` (22P02) and an id past bigint arrived whole (22003), and both
 * answered 500. Declaring them also makes Fastify coerce the id, so the handlers' types are honest
 * about what they receive.
 *
 * Bounded as `objects.ts`' `idParams` is: the columns are bigint, but a JS number is only exact
 * below 2^53. Here rather than in each route file because three files share every shape.
 */
export const pathId = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;

/** `/maps/:id`, `/reports/:id`, `/libraries/:id` and everything beneath them with no second id. */
export const idParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: pathId },
} as const;

/** `…/:id/access/:groupId`. */
export const grantParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'groupId'],
  properties: { id: pathId, groupId: pathId },
} as const;
