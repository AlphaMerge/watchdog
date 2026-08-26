// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { ObjectError } from '../../objects/errors.js';
import type { SensorState, SensorStateCause } from '../../state/tables.js';
import {
  StateLogError,
  STATE_LOG_CAUSES,
  STATE_LOG_STATES,
  type StateLogQuery,
  type StateLogService,
} from '../../timeseries/state-log.js';

export interface StateLogRoutesOptions {
  log: StateLogService;
}

const logQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    /** Scope to one object and everything beneath it. */
    objectId: { type: 'integer', minimum: 1 },
    from: { type: 'string', maxLength: 64 },
    to: { type: 'string', maxLength: 64 },
    // One occurrence arrives as a string and several as an array, so both shapes are declared
    // and both are validated. A top-level `enum` beside `items` would check the array itself
    // against the list and reject every repeat — which is exactly what `/objects?kind=` did.
    state: repeatable(STATE_LOG_STATES),
    cause: repeatable(STATE_LOG_CAUSES),
    /** `nextBefore` from the previous page. */
    before: { type: 'string', maxLength: 40 },
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
  },
} as const;

function repeatable(values: readonly string[]): Record<string, unknown> {
  return {
    oneOf: [
      { enum: [...values] },
      { type: 'array', items: { enum: [...values] }, maxItems: values.length },
    ],
  };
}

const entrySchema = {
  $id: 'ms:stateLogEntry',
  type: 'object',
  additionalProperties: false,
  required: [
    'at',
    'sensorId',
    'sensorName',
    'state',
    'previousState',
    'cause',
    'message',
    'durationMs',
  ],
  properties: {
    at: { type: 'string' },
    sensorId: { type: 'integer' },
    /** Empty when the sensor has since been deleted; its history outlives it. */
    sensorName: { type: 'string' },
    state: { enum: [...STATE_LOG_STATES] },
    previousState: { enum: [...STATE_LOG_STATES, null] },
    cause: { enum: [...STATE_LOG_CAUSES] },
    message: { type: 'string' },
    /** `null` on the state a sensor is still in. */
    durationMs: { type: ['integer', 'null'] },
  },
} as const;

const pageSchema = {
  $id: 'ms:stateLogPage',
  type: 'object',
  additionalProperties: false,
  required: ['items', 'nextBefore'],
  properties: {
    items: { type: 'array', items: { $ref: 'ms:stateLogEntry' } },
    nextBefore: { type: ['string', 'null'] },
  },
} as const;

export const STATE_LOG_SCHEMAS = [entrySchema, pageSchema];

interface LogQueryString {
  objectId?: number;
  from?: string;
  to?: string;
  state?: SensorState | SensorState[];
  cause?: SensorStateCause | SensorStateCause[];
  before?: string;
  limit: number;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/**
 * The state-change log (`M-15`).
 *
 * `CAPABILITIES.MD §8`'s Logs view and the sensor detail page's log tab, which are the same
 * query scoped differently — so they are one route with an `objectId`, rather than two that
 * would drift apart. Newest first, keyset-paged on `(time, sensorId)`.
 *
 * Never conditional and never cached: this is history that grows on its own, and a validator
 * that moved whenever a sensor changed state would move once a minute for every sensor in the
 * installation.
 */
export function stateLogRoutes(app: FastifyInstance, options: StateLogRoutesOptions): void {
  const { log } = options;

  app.get<{ Querystring: LogQueryString }>(
    '/state-log',
    {
      schema: {
        tags: ['state'],
        summary: 'Every state change, newest first',
        description:
          'What changed, when, from what, why, and how long it lasted. Scope to a branch with ' +
          '`objectId` — a sensor id gives that sensor’s log. Filter with `state` and `cause`, ' +
          'both repeatable. Page with `before`, using `nextBefore` from the previous page. ' +
          '`durationMs` is null on the state a sensor is still in, and is measured against the ' +
          'real next transition rather than the next one on this page.',
        querystring: logQuery,
        response: { 200: { $ref: 'ms:stateLogPage' } },
      },
    },
    async (request, reply) => {
      const { objectId, from, to, state, cause, before, limit } = request.query;
      void reply.header('cache-control', 'no-store');

      const query: StateLogQuery = {
        limit,
        ...(objectId === undefined ? {} : { objectId }),
        ...(from === undefined ? {} : { from: parseInstant(from, 'from') }),
        ...(to === undefined ? {} : { to: parseInstant(to, 'to') }),
        ...(state === undefined ? {} : { states: asArray(state) }),
        ...(cause === undefined ? {} : { causes: asArray(cause) }),
        ...(before === undefined ? {} : { before }),
      };

      try {
        return await log.list(query);
      } catch (error: unknown) {
        if (error instanceof StateLogError) {
          throw new ObjectError('CURSOR_INVALID', error.message, {
            context: { phase: 'state-log' },
          });
        }
        throw error;
      }
    },
  );
}

function parseInstant(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ObjectError('OBJECT_INVALID', `"${value}" is not a date`, {
      context: { phase: 'state-log' },
      details: { field },
    });
  }
  return parsed;
}
