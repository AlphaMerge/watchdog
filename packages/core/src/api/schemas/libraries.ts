import { SENSOR_TYPE_ID, SENSOR_TYPE_ID_MESSAGE } from '@ms/sensors';
import {
  MAX_NODES,
  MAX_NODE_NAME,
  MAX_ROOTS,
  MAX_TAG,
  MAX_TAGS,
  MAX_TYPES,
  NODE_ID_MESSAGE,
  NODE_ID_PATTERN,
} from '../../libraries/nodes.js';
import { SENSOR_STATES } from '../../state/tables.js';

/**
 * A library on the wire (`L-01`).
 *
 * **Built from `nodes.ts`'s limits, never restating them.** The schema refuses what it can express
 * — a field of the wrong type, a list too long, a name out of bounds — and `validateNodes` refuses
 * what it cannot: the node count across every level, the depth, an id used twice, a tag listed
 * twice in different case. A bound written in both places would one day be written differently,
 * and the same request would be refused with two different messages depending on which it met
 * first.
 *
 * **One node schema, referring to itself**, for the body and the response alike. The response
 * needs it as much as the body does: `fast-json-stringify` drops what a response schema does not
 * name, and a loosely declared node would come back without its children.
 */

export const libraryNodeSchema = {
  $id: 'ms:libraryNode',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name'],
  properties: {
    /** Stable within the library, so a view can be matched back to the node that asked. */
    id: { type: 'string', pattern: NODE_ID_PATTERN, 'x-patternMessage': NODE_ID_MESSAGE },
    name: { type: 'string', minLength: 1, maxLength: MAX_NODE_NAME },
    /**
     * What the node shows, or null for a heading that only groups the nodes under it.
     *
     * Nullable rather than a `oneOf` of null and a referenced rule: a mistake inside the rule then
     * reports that field, not both branches of a union (`objects.ts` gives the same reason).
     */
    rule: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        /** Object ids whose subtrees the node draws from. Empty or absent is everything. */
        roots: { type: 'array', maxItems: MAX_ROOTS, items: { type: 'integer', minimum: 1 } },
        /** Sensor type ids, any of. */
        types: {
          type: 'array',
          maxItems: MAX_TYPES,
          items: {
            type: 'string',
            pattern: SENSOR_TYPE_ID.source,
            'x-patternMessage': SENSOR_TYPE_ID_MESSAGE,
          },
        },
        /** Effective tags, all of, compared folded — as the tree's tag box means them. */
        tags: {
          type: 'array',
          maxItems: MAX_TAGS,
          items: { type: 'string', minLength: 1, maxLength: MAX_TAG },
        },
        /** Current states, any of. */
        states: {
          type: 'array',
          maxItems: SENSOR_STATES.length,
          items: { enum: [...SENSOR_STATES] },
        },
      },
    },
    children: { type: 'array', maxItems: MAX_NODES, items: { $ref: 'ms:libraryNode' } },
  },
} as const;

export const librarySchema = {
  $id: 'ms:library',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'description', 'priority', 'nodes', 'version', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    description: { type: 'string' },
    priority: { type: 'integer', minimum: 1, maximum: 5 },
    nodes: { type: 'array', items: { $ref: 'ms:libraryNode' } },
    /** What `If-Match` carries back on an edit. */
    version: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const libraryInputSchema = {
  $id: 'ms:libraryInput',
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    description: { type: 'string', maxLength: 1000 },
    priority: { type: 'integer', minimum: 1, maximum: 5 },
    nodes: { type: 'array', maxItems: MAX_NODES, items: { $ref: 'ms:libraryNode' } },
  },
} as const;

export const LIBRARY_SCHEMAS = [libraryNodeSchema, librarySchema, libraryInputSchema];
