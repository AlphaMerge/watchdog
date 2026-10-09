// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import {
  ALARM_KINDS,
  type AlarmKind,
  type AlarmService,
  type AlarmSort,
} from '../../state/alarms.js';
import { SENSOR_STATES } from '../../state/tables.js';
import { onQueryObject, visibilityOf } from '../authorization.js';

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
        { enum: [...ALARM_KINDS] },
        { type: 'array', items: { enum: [...ALARM_KINDS] }, maxItems: ALARM_KINDS.length },
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
  state?: AlarmKind | AlarmKind[];
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
    'recovering',
  ],
  properties: {
    sensorId: { type: 'integer' },
    sensorName: { type: 'string' },
    state: {
      // Every sensor state, not `ALARM_KINDS` (`P-335`): it is read from `sensor_runtime`, so a
      // held return carries whatever state its sensor is in, and `recovering` is never a state.
      type: 'string',
      enum: [...SENSOR_STATES],
      description:
        "The sensor's state now. For a held return (`recovering` is not null) that is the " +
        'state it came back to, usually `up`; `recovering` is a `state` filter value, not a state.',
    },
    cause: { type: 'string' },
    message: { type: 'string' },
    since: { type: 'string' },
    priority: { type: 'integer' },
    path: { type: 'array', items: { type: 'integer' } },
    pathNames: { type: 'array', items: { type: 'string' } },
    acknowledged: { type: 'boolean' },
    acknowledgedUntil: { type: ['string', 'null'] },
    consecutiveFailures: { type: 'integer' },
    recovering: {
      description:
        'The return its alarm is holding (`M-18`), or null. `confirmsAt` is when the alarm is ' +
        'over if the sensor does not fail again.',
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['since', 'confirmsAt'],
      properties: {
        since: { type: 'string' },
        confirmsAt: { type: ['string', 'null'] },
      },
    },
  },
} as const;

export const alarmPageSchema = {
  $id: 'ms:alarmPage',
  type: 'object',
  additionalProperties: false,
  required: ['items', 'total', 'counts', 'now'],
  properties: {
    items: { type: 'array', items: { $ref: 'ms:alarm' } },
    total: { type: 'integer' },
    counts: { type: 'object', additionalProperties: { type: 'integer' } },
    now: {
      type: 'string',
      description:
        "The core's clock when the list was read. A held return's end is not a state change, " +
        'so a client that wants to see it go asks again at `confirmsAt`, measured from this.',
    },
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
      // What the caller can see, and nothing it cannot (`A-12`). A scope has to be an object the
      // caller can read; the visible alarms beneath a hidden one would say where they sit in a
      // branch the caller was not shown.
      config: onQueryObject('read', 'objectId', { optional: true }),
      schema: {
        tags: ['state'],
        summary:
          'Every sensor that is currently in an alarm state, worst first, and every held return',
        description:
          'Down, Down (Partial), Down (Acknowledged), Warning and Unusual — the five states ' +
          '`WORKFLOW.MD §7` names. **Paused and Unknown are absent by design**: a paused sensor ' +
          'is deliberately silent, and Unknown means nothing has scanned it yet, which is a gap ' +
          'in coverage rather than a fault. Reporting either as an alarm is how a list becomes ' +
          'one an operator scrolls past. `objectId` scopes to that object and everything ' +
          'beneath it. `counts` is per state across the whole scope and ignores the `state` ' +
          'filter, so a severity chip can still say how many it is hiding.\n\n' +
          'A sensor that is back while its alarm waits to see the return last (`M-18`) is ' +
          'listed too, after everything still happening, with `recovering` saying when it is ' +
          'over. It counts as `recovering` rather than as its state, unless that state is one ' +
          "of the five, and `state=recovering` filters to those. `now` is the core's clock, " +
          'to time the moment a hold ends against: that is not a state change, and the state ' +
          'stream does not announce it.\n\n' +
          'Only sensors the caller can read are listed or counted, and `path` and `pathNames` ' +
          'carry only the steps the caller can read.',
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
        visibility: await visibilityOf(request),
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
