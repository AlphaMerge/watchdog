// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../db/pool.js';
import type { DeliveryHealthReader } from '../../notifications/health.js';
import { NOTIFICATION_REASONS } from '../../notifications/chain.js';
import {
  NOTIFICATION_STATUSES,
  NotificationLogReader,
  type NotificationStatus,
} from '../../notifications/log.js';
import { REQUEST_DISPOSITIONS } from '../../notifications/summarisation.js';
import { SENSOR_STATES } from '../../state/tables.js';
import { INSTALLATION, clears, onQueryObject, visibilityOf } from '../authorization.js';

export interface NotificationRoutesOptions {
  db: Database;
  health: DeliveryHealthReader;
  log?: NotificationLogReader;
}

/**
 * One value or several. A repeat is taken on purpose (`P-365`): the filter is `= ANY(…)`, so it
 * answers what one does — see `KIND_FILTER` in `objects.ts`.
 */
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
    'parked',
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
    parked: { type: 'integer' },
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
    'parked',
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
    /**
     * Queued but deliberately not sent yet — collecting into an open digest window, or held
     * because the template is outside its activation schedule (`P-125`, `R06`).
     *
     * **Declared here or it does not exist.** `additionalProperties: false` means
     * fast-json-stringify removes any key the schema does not list, silently, so a count the
     * report computes and the route spreads was deleted on its way out. Requests that used to
     * appear in `pending` appeared in neither — forty alarms collecting into a digest window
     * answered `pending: 0` with no other number anywhere, which is the opposite of what the
     * ticket that added it set out to do.
     */
    parked: { type: 'integer' },
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
    triggerKind: {
      // Deliberately not an enum, and the column deliberately has no CHECK (`P-342`, `P-352`):
      // a trigger kind is a registry entry, not a schema change. A row queued by a newer build is
      // still listed after a downgrade, as its trigger is (`P-139`), and an enum it broke would be
      // served anyway and claim it could not occur (`P-313`). `ms:trigger.kind` says the rest.
      type: 'string',
      description:
        'The kind of trigger that queued it, kept when the trigger is deleted: `state` or ' +
        '`threshold` in this version. Not an enum on purpose: one queued by a newer build is ' +
        'still listed after a downgrade. `GET /trigger-kinds` lists the kinds this build knows.',
    },
    // These four are what the table lets the code write: the reason, status and disposition
    // CHECKs, and `sensor_state_kind NOT NULL` (`P-335`, `P-342`).
    reason: { type: 'string', enum: [...NOTIFICATION_REASONS] },
    state: { type: 'string', enum: [...SENSOR_STATES] },
    message: { type: 'string' },
    status: { type: 'string', enum: [...NOTIFICATION_STATUSES] },
    disposition: {
      type: 'string',
      enum: [...REQUEST_DISPOSITIONS],
      description:
        'Sent on its own (`immediate`) or folded into a digest (`held`); `undecided` until the ' +
        "template's summarisation has decided.",
    },
    attempts: { type: 'integer' },
    deliveredAt: { type: ['string', 'null'] },
    nextAttemptAt: { type: ['string', 'null'] },
    lastError: { type: ['string', 'null'] },
    skippedRecipients: {
      type: 'string',
      description:
        'Who a message named and did not reach, and why — a disabled account, one with no ' +
        'address, one that may not see the sensor. Empty when it reached everybody (`M-19`). ' +
        'By name for an administrator; for anybody else, by count and reason only — ' +
        '`2 recipients (1 disabled, 1 may not see this sensor)` — because the names are the ' +
        'account and group lists, which are an administrator’s (`A-44`).',
    },
  },
} as const;

export const NOTIFICATION_SCHEMAS = [methodHealthSchema, healthSchema, entrySchema];

interface LogQuery {
  status?: NotificationStatus | NotificationStatus[];
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
      // Every queue and every relay's last error: the installation's, not a branch's (`A-12`).
      config: INSTALLATION,
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
      // The caller's sensors only (`A-12`), and `sensorId` has to be one the caller can read.
      config: onQueryObject('read', 'sensorId', { optional: true }),
      schema: {
        tags: ['notifications'],
        summary: 'What happened to each notification',
        description:
          'Newest first, paged by `before` rather than by offset — notifications arrive while ' +
          'somebody is reading, and an offset page would show a row twice or not at all. ' +
          '`failed` is an alarm nobody received; `discarded` is one nobody was meant to ' +
          'receive any more, which is not the same thing. That is either a notification an ' +
          'activation schedule threw away on purpose (`N-12`), or a recovery or clear dropped ' +
          'because a newer alarm of the same sensor and trigger was delivered first (`N-22`); ' +
          '`lastError` says which. Only notifications about sensors the caller can read appear.',
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: repeatable(NOTIFICATION_STATUSES),
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
        visibility: await visibilityOf(request),
        // Who a message missed, by name, only for whoever may list the accounts (`A-44`).
        namesAccounts: clears(request, 'admin'),
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
