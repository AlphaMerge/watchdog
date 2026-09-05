// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { ALARM_STATES, type AlarmService, type AlarmSort } from '../../state/alarms.js';
import type { SensorState } from '../../state/tables.js';
import { READS } from '../authorization.js';

export interface AlarmRouteOptions {
  alarms: AlarmService;
}

const alarmQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    objectId: { type: 'integer', minimum: 1 },
    state: {
      oneOf: [
        { enum: [...ALARM_STATES] },
        { type: 'array', items: { enum: [...ALARM_STATES] }, maxItems: ALARM_STATES.length },
      ],
    },
    priorityMin: { type: 'integer', minimum: 1, maximum: 5 },
    includeAcknowledged: { type: 'boolean', default: true },
    sort: { enum: ['priority', 'duration'], default: 'priority' },
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
  },
} as const;

interface AlarmQueryString {
  objectId?: number;
  state?: SensorState | SensorState[];
  priorityMin?: number;
  includeAcknowledged?: boolean;
  sort?: AlarmSort;
  limit?: number;
}

export const alarmSchema = {
  $id: 'ms:alarm',
  type: 'object',
  additionalProperties: false,
  required: [
    'sensorId',
    'sensorName',
    'state',
    'cause',
    'message',
    'since',
    'priority',
    'path',
    'pathNames',
    'acknowledged',
    'acknowledgedUntil',
    'consecutiveFailures',
  ],
  properties: {
    sensorId: { type: 'integer' },
    sensorName: { type: 'string' },
    state: { type: 'string' },
    cause: { type: 'string' },
    message: { type: 'string' },
    since: { type: 'string' },
    priority: { type: 'integer' },
    path: { type: 'array', items: { type: 'integer' } },
    pathNames: { type: 'array', items: { type: 'string' } },
    acknowledged: { type: 'boolean' },
    acknowledgedUntil: { type: ['string', 'null'] },
    consecutiveFailures: { type: 'integer' },
  },
} as const;

export const alarmPageSchema = {
  $id: 'ms:alarmPage',
  type: 'object',
  additionalProperties: false,
  required: ['items', 'total', 'counts'],
  properties: {
    items: { type: 'array', items: { $ref: 'ms:alarm' } },
    total: { type: 'integer' },
    counts: { type: 'object', additionalProperties: { type: 'integer' } },
  },
} as const;

export const ALARM_SCHEMAS = [alarmSchema, alarmPageSchema];

/**
 * The alarms list (`U-06`).
 *
 * One route, because "what is wrong right now" is one question. It is deliberately not a filter
 * on `GET /objects`: that route lists configuration and pages by name or manual order, while
 * this one reads current runtime state, sorts by priority then duration, and counts by severity.
 * Bolting the second onto the first would give a general-purpose list route an alarm-shaped
 * index and an alarm-shaped sort nobody else wants.
 */
export function alarmRoutes(app: FastifyInstance, options: AlarmRouteOptions): void {
  const { alarms } = options;

  app.get<{ Querystring: AlarmQueryString }>(
    '/alarms',
    {
      config: READS,
      schema: {
        tags: ['state'],
        summary: 'Every sensor that is currently in an alarm state, worst first',
        description:
          'Down, Down (Partial), Down (Acknowledged), Warning and Unusual — the five states ' +
          '`WORKFLOW.MD §7` names. **Paused and Unknown are absent by design**: a paused sensor ' +
          'is deliberately silent, and Unknown means nothing has scanned it yet, which is a gap ' +
          'in coverage rather than a fault. Reporting either as an alarm is how a list becomes ' +
          'one an operator scrolls past. `objectId` scopes to that object and everything ' +
          'beneath it. `counts` is per state across the whole scope and ignores the `state` ' +
          'filter, so a severity chip can still say how many it is hiding.',
        querystring: alarmQuery,
        response: { 200: { $ref: 'ms:alarmPage' } },
      },
    },
    async (request, reply) => {
      // Never cached: this is the one view whose whole purpose is to be current, and an ETag
      // built from anything cheaper than the query itself would be a guess.
      void reply.header('cache-control', 'no-store');
      const { state, objectId, priorityMin, includeAcknowledged, sort, limit } = request.query;
      const states = state === undefined ? undefined : Array.isArray(state) ? state : [state];
      return alarms.list({
        ...(objectId === undefined ? {} : { objectId }),
        ...(states === undefined ? {} : { states }),
        ...(priorityMin === undefined ? {} : { priorityMin }),
        ...(includeAcknowledged === undefined ? {} : { includeAcknowledged }),
        ...(sort === undefined ? {} : { sort }),
        limit: limit ?? 100,
      });
    },
  );
}
