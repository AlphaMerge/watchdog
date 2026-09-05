// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../db/pool.js';
import type { DeliveryHealthReader } from '../../notifications/health.js';
import { NotificationLogReader } from '../../notifications/log.js';
import { READS } from '../authorization.js';

export interface NotificationRoutesOptions {
  db: Database;
  health: DeliveryHealthReader;
  log?: NotificationLogReader;
}

/** The statuses a request can be in, which are also the filter values. */
const STATUSES = ['pending', 'sent', 'failed', 'discarded'] as const;

function repeatable(values: readonly string[]): Record<string, unknown> {
  return {
    oneOf: [
      { enum: [...values] },
      { type: 'array', items: { enum: [...values] }, maxItems: values.length },
    ],
  };
}

const methodHealthSchema = {
  $id: 'ms:deliveryMethodHealth',
  type: 'object',
  additionalProperties: false,
  required: [
    'method',
    'pending',
    'retrying',
    'failed',
    'discarded',
    'oldestPendingAt',
    'lastDeliveredAt',
    'lastError',
  ],
  properties: {
    method: { type: 'string' },
    pending: { type: 'integer' },
    retrying: { type: 'integer' },
    failed: { type: 'integer' },
    discarded: { type: 'integer' },
    oldestPendingAt: { type: ['string', 'null'] },
    lastDeliveredAt: { type: ['string', 'null'] },
    lastError: { type: ['string', 'null'] },
  },
} as const;

const healthSchema = {
  $id: 'ms:deliveryHealth',
  type: 'object',
  additionalProperties: false,
  required: [
    'status',
    'problems',
    'pending',
    'retrying',
    'failed',
    'discarded',
    'oldestPendingAt',
    'oldestPendingAgeMs',
    'lastDeliveredAt',
    'windowMs',
    'staleAfterMs',
    'methods',
  ],
  properties: {
    status: { type: 'string', enum: ['ok', 'warning', 'down'] },
    problems: { type: 'array', items: { type: 'string' } },
    pending: { type: 'integer' },
    retrying: { type: 'integer' },
    failed: { type: 'integer' },
    discarded: { type: 'integer' },
    oldestPendingAt: { type: ['string', 'null'] },
    oldestPendingAgeMs: { type: 'integer' },
    lastDeliveredAt: { type: ['string', 'null'] },
    windowMs: { type: 'integer' },
    staleAfterMs: { type: 'integer' },
    methods: { type: 'array', items: { $ref: 'ms:deliveryMethodHealth' } },
  },
} as const;

const entrySchema = {
  $id: 'ms:notificationRequest',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'at',
    'sensorId',
    'sensorName',
    'templateId',
    'templateName',
    'method',
    'triggerKind',
    'reason',
    'state',
    'message',
    'status',
    'disposition',
    'attempts',
    'deliveredAt',
    'nextAttemptAt',
    'lastError',
  ],
  properties: {
    id: { type: 'integer' },
    at: { type: 'string' },
    sensorId: { type: 'integer' },
    sensorName: { type: ['string', 'null'] },
    templateId: { type: ['integer', 'null'] },
    templateName: { type: ['string', 'null'] },
    method: { type: ['string', 'null'] },
    triggerKind: { type: 'string' },
    reason: { type: 'string' },
    state: { type: ['string', 'null'] },
    message: { type: 'string' },
    status: { type: 'string' },
    disposition: { type: 'string' },
    attempts: { type: 'integer' },
    deliveredAt: { type: ['string', 'null'] },
    nextAttemptAt: { type: ['string', 'null'] },
    lastError: { type: ['string', 'null'] },
  },
} as const;

export const NOTIFICATION_SCHEMAS = [methodHealthSchema, healthSchema, entrySchema];

interface LogQuery {
  status?: string | string[];
  sensorId?: number;
  templateId?: number;
  before?: number;
  limit?: number;
}

/**
 * Whether the alarms are getting out, and what happened to each one (`N-13`).
 *
 * `WORKFLOW.MD §6`: a delivery failure is itself an alarm, and a dead SMTP relay must surface
 * rather than disappearing into a log file. These two routes are that surface until `P-12` turns
 * the same numbers into channels on the Core Health sensor — the reader is shared, so the sensor
 * and the API cannot end up disagreeing about whether delivery is working.
 */
export function notificationRoutes(app: FastifyInstance, options: NotificationRoutesOptions): void {
  const { db, health } = options;
  const log = options.log ?? new NotificationLogReader();

  app.get(
    '/notification-health',
    {
      config: READS,
      schema: {
        tags: ['notifications'],
        summary: 'Whether notifications are actually being delivered',
        description:
          'Read from the queue rather than counted in memory, deliberately: a core that ' +
          'restarted five minutes ago would otherwise report a clean sheet over a queue full ' +
          'of undelivered alarms. `down` means an alarm was given up on, or one has been ' +
          'undeliverable long enough that the relay is not coming back on its own; `warning` ' +
          'means something is being retried.',
        response: { 200: { $ref: 'ms:deliveryHealth' } },
      },
    },
    async () => {
      const report = await health.read(db);
      return {
        ...report,
        oldestPendingAt: iso(report.oldestPendingAt),
        lastDeliveredAt: iso(report.lastDeliveredAt),
        staleAfterMs: health.staleAfterMs,
        methods: report.methods.map((method) => ({
          ...method,
          oldestPendingAt: iso(method.oldestPendingAt),
          lastDeliveredAt: iso(method.lastDeliveredAt),
        })),
      };
    },
  );

  app.get<{ Querystring: LogQuery }>(
    '/notification-requests',
    {
      config: READS,
      schema: {
        tags: ['notifications'],
        summary: 'What happened to each notification',
        description:
          'Newest first, paged by `before` rather than by offset — notifications arrive while ' +
          'somebody is reading, and an offset page would show a row twice or not at all. ' +
          '`failed` is an alarm nobody received; `discarded` is one an activation schedule ' +
          'threw away on purpose (`N-12`), which is not the same thing.',
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: repeatable(STATUSES),
            sensorId: { type: 'integer', minimum: 1 },
            templateId: { type: 'integer', minimum: 1 },
            before: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'nextBefore'],
            properties: {
              items: { type: 'array', items: { $ref: 'ms:notificationRequest' } },
              /** The `before` for the next page, or null at the end of the log. */
              nextBefore: { type: ['integer', 'null'] },
            },
          },
        },
      },
    },
    async (request) => {
      const query = request.query;
      const limit = query.limit ?? 50;
      const status = query.status === undefined ? [] : [query.status].flat();
      const entries = await log.list(db, {
        status,
        ...(query.sensorId === undefined ? {} : { sensorId: query.sensorId }),
        ...(query.templateId === undefined ? {} : { templateId: query.templateId }),
        ...(query.before === undefined ? {} : { before: query.before }),
        limit,
      });
      const last = entries.at(-1);
      return {
        items: entries.map((entry) => ({
          ...entry,
          at: entry.at.toISOString(),
          deliveredAt: iso(entry.deliveredAt),
          nextAttemptAt: iso(entry.nextAttemptAt),
        })),
        // Null at the end, so a client stops rather than asking for a page that is always empty.
        nextBefore: entries.length < limit || last === undefined ? null : last.id,
      };
    },
  );
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}
