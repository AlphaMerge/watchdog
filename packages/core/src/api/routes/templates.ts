// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Actor } from '../../objects/audit.js';
import { notificationMethods } from '../../notifications/methods.js';
import { describePlaceholders } from '../../notifications/placeholders.js';
import { WHEN_INACTIVE } from '../../notifications/activation.js';
import {
  DEFAULT_SUMMARISATION,
  describeSummarisationModes,
  SUMMARISATION_MODES,
} from '../../notifications/summarisation.js';
import type { TemplateInput, TemplateService } from '../../notifications/templates.js';

export interface TemplateRouteOptions {
  templates: TemplateService;
}

/** Until accounts exist (A-01), every actor is the caller's address — in exactly one place. */
function actorFor(request: FastifyRequest): Actor {
  return { kind: 'anonymous', remoteAddress: request.ip };
}

const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const recipientSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'value'],
  properties: {
    kind: { enum: ['address', 'user', 'userGroup'] },
    value: { type: 'string', minLength: 1, maxLength: 320 },
  },
} as const;

const templateSchema = {
  $id: 'ms:template',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'name',
    'description',
    'method',
    'methodName',
    'settings',
    'redactedSettings',
    'subject',
    'body',
    'recipients',
    'priority',
    'enabled',
    'summary',
    'summarisable',
    'summarisation',
    'summaryWindowSeconds',
    'scheduleId',
    'scheduleName',
    'whenInactive',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    description: { type: 'string' },
    method: { type: 'string' },
    methodName: { type: 'string' },
    /**
     * The method's settings **with every secret removed**.
     *
     * Serialised against this schema by `fast-json-stringify`, which is the structural half of
     * the defence: a field the schema does not name cannot reach the wire even if the service
     * somehow put it in the object.
     */
    settings: { type: 'object', additionalProperties: true },
    /** The dotted paths that were removed, so a form can say "set, not shown". */
    redactedSettings: { type: 'array', items: { type: 'string' } },
    subject: { type: 'string' },
    body: { type: 'string' },
    recipients: { type: 'array', items: recipientSchema },
    priority: { type: 'integer' },
    enabled: { type: 'boolean' },
    summary: { type: 'string' },
    summarisable: { type: 'boolean' },
    /** Always `always-immediate` for a method that is never summarised — forced, not ignored. */
    summarisation: { type: 'string', enum: [...SUMMARISATION_MODES] },
    summaryWindowSeconds: { type: 'integer' },
    /** The `M-09` schedule this template is active during, or null for always (`N-12`). */
    scheduleId: { type: ['integer', 'null'] },
    scheduleName: { type: ['string', 'null'] },
    whenInactive: { type: 'string', enum: [...WHEN_INACTIVE] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const methodSchema = {
  $id: 'ms:notificationMethod',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'description', 'settingsSchema', 'usesRecipients', 'summarisable'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    /** The JSON Schema a UI builds the form from. `writeOnly` marks the fields never returned. */
    settingsSchema: { type: 'object', additionalProperties: true },
    usesRecipients: { type: 'boolean' },
    summarisable: { type: 'boolean' },
  },
} as const;

const templateInputSchema = {
  $id: 'ms:templateInput',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'method', 'settings'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 1000 },
    method: { type: 'string', minLength: 1, maxLength: 40 },
    settings: { type: 'object', additionalProperties: true },
    subject: { type: 'string', maxLength: 500 },
    body: { type: 'string', maxLength: 20_000 },
    recipients: { type: 'array', maxItems: 200, items: recipientSchema },
    priority: { type: 'integer', minimum: 1, maximum: 5 },
    enabled: { type: 'boolean' },
    summarisation: { type: 'string', enum: [...SUMMARISATION_MODES] },
    // The column's own bounds. A window under a minute is a digest of one, and one over a day is
    // a notification nobody will connect to the outage that caused it.
    summaryWindowSeconds: { type: 'integer', minimum: 60, maximum: 86_400 },
    // Absent keeps what is stored; an explicit null clears it, which means "always active".
    scheduleId: { type: ['integer', 'null'], minimum: 1 },
    whenInactive: { type: 'string', enum: [...WHEN_INACTIVE] },
  },
} as const;

const summarisationModeSchema = {
  $id: 'ms:summarisationMode',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'description'],
  properties: {
    id: { type: 'string' },
    description: { type: 'string' },
  },
} as const;

const placeholderSchema = {
  $id: 'ms:placeholder',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'description'],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
  },
} as const;

const previewSchema = {
  $id: 'ms:templatePreview',
  type: 'object',
  additionalProperties: false,
  required: ['templateId', 'sensorId', 'subject', 'body', 'unknown'],
  properties: {
    templateId: { type: 'integer' },
    sensorId: { type: 'integer' },
    subject: { type: 'string' },
    body: { type: 'string' },
    unknown: { type: 'array', items: { type: 'string' } },
  },
} as const;

const usedBySchema = {
  $id: 'ms:templateUsedBy',
  type: 'object',
  additionalProperties: false,
  required: ['templateId', 'items'],
  properties: {
    templateId: { type: 'integer' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['triggerId', 'triggerKind', 'objectId', 'objectName', 'summary'],
        properties: {
          triggerId: { type: 'integer' },
          triggerKind: { type: 'string' },
          objectId: { type: 'integer' },
          objectName: { type: 'string' },
          summary: { type: 'string' },
        },
      },
    },
  },
} as const;

export const TEMPLATE_SCHEMAS = [
  templateSchema,
  methodSchema,
  templateInputSchema,
  summarisationModeSchema,
  placeholderSchema,
  previewSchema,
  usedBySchema,
];

/**
 * Notification templates (`N-05`).
 *
 * A template says what is sent and how; a trigger (`N-01`) says when. **No route here returns a
 * secret**: the webhook URLs and the secret headers are stripped in `TemplateService`, and the
 * response schemas above are the second lock — `fast-json-stringify` serialises only the fields
 * they name.
 */
export function templateRoutes(app: FastifyInstance, options: TemplateRouteOptions): void {
  const { templates } = options;

  app.get(
    '/notification-methods',
    {
      schema: {
        tags: ['templates'],
        summary: 'The delivery methods this build understands',
        description:
          'Each carries the JSON Schema its settings are validated against, which is also what ' +
          'a UI builds the form from. Fields marked `writeOnly` are credentials: they are ' +
          'accepted, stored and used, and never returned by any route, to anyone.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: { $ref: 'ms:notificationMethod' } } },
          },
        },
      },
    },
    () => ({
      items: notificationMethods.all().map((method) => ({
        id: method.id,
        name: method.name,
        description: method.description,
        settingsSchema: method.settingsSchema,
        usesRecipients: method.usesRecipients,
        summarisable: method.summarisable,
      })),
    }),
  );

  app.get(
    '/summarisation-modes',
    {
      schema: {
        tags: ['templates'],
        summary: 'How eagerly a template may send during a storm',
        description:
          'The six modes of `CAPABILITIES.MD §5.2`. The distinction that matters is between ' +
          'the *first* modes and the *all* modes: "first Down immediately" turns a forty-sensor ' +
          'outage into one message and a digest, while "all Downs immediately" sends forty. ' +
          'A method whose `summarisable` is false ignores all of this and is stored as ' +
          '`always-immediate`.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'default'],
            properties: {
              items: { type: 'array', items: { $ref: 'ms:summarisationMode' } },
              default: { type: 'string' },
            },
          },
        },
      },
    },
    () => ({ items: describeSummarisationModes(), default: DEFAULT_SUMMARISATION }),
  );

  app.get(
    '/notification-placeholders',
    {
      schema: {
        tags: ['templates'],
        summary: 'The placeholders a template’s subject and body may use',
        description:
          'Case-insensitive: `%Sensor` and `%SENSOR` are `%sensor`. A name this build does not ' +
          'know is refused when the template is saved rather than blanked when it is sent — a ' +
          'message that quietly loses a fact reads perfectly and says nothing. Write `%%` for a ' +
          'literal per cent sign.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: { $ref: 'ms:placeholder' } } },
          },
        },
      },
    },
    () => ({ items: describePlaceholders() }),
  );

  app.get(
    '/templates',
    {
      schema: {
        tags: ['templates'],
        summary: 'Every notification template',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: { $ref: 'ms:template' } } },
          },
        },
      },
    },
    async () => ({ items: await templates.list() }),
  );

  app.get<{ Params: { id: number } }>(
    '/templates/:id',
    {
      schema: {
        tags: ['templates'],
        summary: 'One template',
        params: idParams,
        response: { 200: { $ref: 'ms:template' } },
      },
    },
    async (request) => templates.get(request.params.id),
  );

  app.get<{ Params: { id: number } }>(
    '/templates/:id/used-by',
    {
      schema: {
        tags: ['templates'],
        summary: 'Which triggers name this template',
        description:
          '`CAPABILITIES.MD §5.2`’s reverse lookup, and the reason a delete can be refused with ' +
          'a list rather than a shrug. A trigger names its templates inside a JSON document, so ' +
          'no foreign key can enforce the reference — this is the query that stands in for one.',
        params: idParams,
        response: { 200: { $ref: 'ms:templateUsedBy' } },
      },
    },
    async (request) => ({
      templateId: request.params.id,
      items: await templates.usedBy(request.params.id),
    }),
  );

  app.get<{ Params: { id: number }; Querystring: { sensorId: number } }>(
    '/templates/:id/preview',
    {
      schema: {
        tags: ['templates'],
        summary: 'What this template would say about one sensor, right now',
        description:
          'Rendered against the sensor’s actual state, not an invented one. An operator writing ' +
          '`%device / %sensor: %lastmessage` has no way to know whether that reads well until ' +
          'they see it against something real, and finding out from the first genuine outage is ' +
          'finding out too late. Nothing is sent and nothing is written.',
        params: idParams,
        querystring: {
          type: 'object',
          required: ['sensorId'],
          additionalProperties: false,
          properties: { sensorId: { type: 'integer', minimum: 1 } },
        },
        response: { 200: { $ref: 'ms:templatePreview' } },
      },
    },
    async (request) => templates.preview(request.params.id, request.query.sensorId),
  );

  app.post<{ Body: TemplateInput }>(
    '/templates',
    {
      schema: {
        tags: ['templates'],
        summary: 'Create a template',
        body: { $ref: 'ms:templateInput' },
        response: { 201: { $ref: 'ms:template' } },
      },
    },
    async (request, reply) => {
      const created = await templates.create(actorFor(request), request.body);
      await reply.status(201).send(created);
    },
  );

  app.put<{ Params: { id: number }; Body: TemplateInput }>(
    '/templates/:id',
    {
      schema: {
        tags: ['templates'],
        summary: 'Replace a template',
        description:
          'Whole-document, with one exception: a secret the request does not carry is **kept**, ' +
          'because the form it came from was rendered without it. Send an explicit `null` to ' +
          'clear one.',
        params: idParams,
        body: { $ref: 'ms:templateInput' },
        response: { 200: { $ref: 'ms:template' } },
      },
    },
    async (request) => templates.update(actorFor(request), request.params.id, request.body),
  );

  app.delete<{ Params: { id: number } }>(
    '/templates/:id',
    {
      schema: {
        tags: ['templates'],
        summary: 'Remove a template',
        description:
          'Refused while a trigger still names it, with the list of triggers to fix: deleting ' +
          'one out from under a trigger would leave that trigger firing into nothing.',
        params: idParams,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'deleted'],
            properties: { id: { type: 'integer' }, deleted: { type: 'boolean' } },
          },
        },
      },
    },
    async (request) => {
      await templates.delete(actorFor(request), request.params.id);
      return { id: request.params.id, deleted: true };
    },
  );
}
