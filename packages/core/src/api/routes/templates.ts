// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { actorFor } from '../authentication.js';
import { notificationMethods } from '../../notifications/methods.js';
import { describePlaceholders } from '../../notifications/placeholders.js';
import { WHEN_INACTIVE } from '../../notifications/activation.js';
import type { NotificationTester } from '../../notifications/test-send.js';
import {
  DEFAULT_SUMMARISATION,
  describeSummarisationModes,
  SUMMARISATION_MODES,
} from '../../notifications/summarisation.js';
import type {
  TemplateInput,
  TemplateService,
  TemplateWriter,
} from '../../notifications/templates.js';
import {
  READS,
  WRITES,
  computesOn,
  clears,
  every,
  onBodyObject,
  onQueryObject,
  visibilityOf,
  notAudited,
} from '../authorization.js';

/**
 * What this caller may write into a template (`A-44`): an account or a group only as an
 * administrator, the one caller `M-20` lets list them.
 */
function writerOf(request: FastifyRequest): TemplateWriter {
  return { namesAccounts: clears(request, 'admin') };
}

export interface TemplateRouteOptions {
  templates: TemplateService;
  /**
   * What actually sends a test message (`N-14`).
   *
   * Optional like the rest of the notification wiring: absent, the route is not registered, so a
   * build with no transports 404s rather than reporting that the test succeeded.
   */
  tester?: NotificationTester;
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
     * somehow put it in the object. Which settings are secret is the method's `writeOnly`
     * (`P-344`).
     */
    settings: {
      type: 'object',
      additionalProperties: true,
      description:
        'The method’s settings, shaped by its `settingsSchema` (`GET /notification-methods`), ' +
        'with every setting that schema marks `writeOnly` removed on every read.',
    },
    /** The dotted paths that were removed, so a form can say "set, not shown". */
    redactedSettings: {
      type: 'array',
      items: { type: 'string' },
      description:
        'The dotted paths of the `writeOnly` settings that hold a value and were removed from ' +
        '`settings`, so a form can say "set, not shown". Never the values.',
    },
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
    /** Null for a draft that has never been saved. */
    templateId: { type: ['integer', 'null'] },
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
          triggerKind: {
            // A string, as everywhere a trigger kind is served (`P-352`, `ms:trigger.kind`).
            type: 'string',
            description:
              'One of the ids `GET /trigger-kinds` lists. A trigger of a kind this build does ' +
              'not know cannot be read for the templates it names, so it is not listed here.',
          },
          objectId: { type: 'integer' },
          objectName: { type: 'string' },
          summary: { type: 'string' },
        },
      },
    },
  },
} as const;

const testSendSchema = {
  $id: 'ms:templateTestResult',
  type: 'object',
  additionalProperties: false,
  required: [
    'templateId',
    'templateName',
    'method',
    'methodName',
    'sensorId',
    'sensorName',
    'subject',
    'body',
    'recipients',
    'unknownPlaceholders',
    'delivered',
    'detail',
    'error',
    'retryable',
    'durationMs',
    'notes',
  ],
  properties: {
    templateId: { type: 'integer' },
    templateName: { type: 'string' },
    method: { type: 'string' },
    methodName: { type: 'string' },
    sensorId: { type: ['integer', 'null'] },
    sensorName: { type: 'string' },
    subject: { type: 'string' },
    body: { type: 'string' },
    recipients: { type: 'array', items: recipientSchema },
    unknownPlaceholders: { type: 'array', items: { type: 'string' } },
    delivered: { type: 'boolean' },
    detail: { type: ['string', 'null'] },
    error: { type: ['string', 'null'] },
    retryable: { type: ['boolean', 'null'] },
    durationMs: { type: 'integer' },
    /** What would have been different for a real notification. */
    notes: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const TEMPLATE_SCHEMAS = [
  templateSchema,
  methodSchema,
  templateInputSchema,
  summarisationModeSchema,
  testSendSchema,
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
  const { templates, tester } = options;

  app.get(
    '/notification-methods',
    {
      config: READS,
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
      config: READS,
      schema: {
        tags: ['templates'],
        summary: 'How eagerly a template may send during a storm',
        description:
          'The six summarisation modes. The distinction that matters is between ' +
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
      config: READS,
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
      config: READS,
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
      config: READS,
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
      config: READS,
      schema: {
        tags: ['templates'],
        summary: 'Which triggers name this template',
        description:
          'A trigger’s reference to its templates, read backwards, and the reason a delete can ' +
          'be refused with a list rather than a shrug. A trigger names its templates inside a ' +
          'JSON document, so no foreign key can enforce the reference — this is the query that ' +
          'stands in for one. Only triggers on objects the caller can read are listed.',
        params: idParams,
        response: { 200: { $ref: 'ms:templateUsedBy' } },
      },
    },
    async (request) => ({
      templateId: request.params.id,
      items: await templates.usedBy(request.params.id, await visibilityOf(request)),
    }),
  );

  app.get<{ Params: { id: number }; Querystring: { sensorId: number } }>(
    '/templates/:id/preview',
    {
      // Read on the sensor the preview renders against, for the same reason as the draft one.
      config: onQueryObject('read', 'sensorId'),
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
    async (request) =>
      templates.preview(request.params.id, request.query.sensorId, await visibilityOf(request)),
  );

  app.post<{ Body: { template: TemplateInput; sensorId: number } }>(
    '/templates/preview',
    {
      // Renders an unsaved draft against one sensor: nothing is sent and nothing is written, so
      // the bar is read — but read *on that sensor*, because the rendering puts the sensor's own
      // facts into the text.
      config: computesOn(onBodyObject('read', 'sensorId')),
      schema: {
        tags: ['templates'],
        summary: 'What an unsaved draft would say about one sensor',
        // For `U-10`'s editor.
        description:
          'The same rendering as the saved preview, against a template that does not exist yet ' +
          '— what an editor needs to show the text in the box rather than the text on disk. ' +
          'The draft goes through the same validation a write does, so one that could ' +
          'not be saved is refused here rather than previewing something the operator cannot ' +
          'keep. Nothing is sent, nothing is written, and no template is created.',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['template', 'sensorId'],
          properties: {
            template: { $ref: 'ms:templateInput' },
            sensorId: { type: 'integer', minimum: 1 },
          },
        },
        response: { 200: { $ref: 'ms:templatePreview' } },
      },
    },
    async (request) =>
      templates.previewDraft(
        request.body.template,
        request.body.sensorId,
        await visibilityOf(request),
      ),
  );

  if (tester !== undefined) {
    app.post<{ Params: { id: number }; Body: { sensorId?: number } }>(
      '/templates/:id/test',
      {
        // A template is a library object with no place in the tree, so `write` is the honest
        // bar for editing one — but this route renders against a *sensor* the caller names, and
        // that sensor is in the tree. Optional because rendering against the example sensor
        // names nothing to have a right on (`R07`).
        config: {
          ...every(WRITES, onBodyObject('read', 'sensorId', { optional: true })),
          ...notAudited('sends one message and changes nothing it is sent through'),
        },
        schema: {
          tags: ['templates'],
          summary: 'Send a test notification through this template',
          // Recipients counted for a reader who is not an administrator since `A-44`, and the
          // message in the caller's view since `A-16`.
          description:
            '**This really sends.** The same rendering, the same transport, the same settings ' +
            'and the same recipients — testing an on-call template at three in the morning ' +
            'pages whoever is on call, which is why it is written to the audit log. What it ' +
            'skips is the queue: nothing is retried, summarised or suppressed by an activation ' +
            'schedule, because those would each turn "did my relay work" into "wait fifteen ' +
            'minutes and find out". `notes` reports what a real notification would have run ' +
            'into instead, so a green test on a template that is switched off cannot be ' +
            'mistaken for a working alarm. Without `sensorId` the message is rendered against ' +
            'an example sensor, which is what an installation with no sensors yet needs. ' +
            'Anybody the template names and the send missed is named in `detail` or `error` ' +
            'for an administrator, and counted by reason for anybody else — ' +
            '`not sent to 2 recipients (1 disabled, 1 no email address)` — because the names ' +
            'are the account and group lists, which are an administrator’s. ' +
            '**`subject` and `body` are the message as the caller may read it**: ' +
            '`%probe`, `%group`, `%device` and `%host` for a container outside the caller’s ' +
            'view read `(outside your view)`, as in a preview, and `notes` says so. What is sent ' +
            'is the real message.',
          params: idParams,
          body: {
            type: 'object',
            additionalProperties: false,
            properties: { sensorId: { type: 'integer', minimum: 1 } },
          },
          response: { 200: { $ref: 'ms:templateTestResult' } },
        },
      },
      async (request) =>
        tester.send(actorFor(request), {
          templateId: request.params.id,
          // Who the test missed, by name, only for whoever may list the accounts (`A-44`).
          namesAccounts: clears(request, 'admin'),
          // And the message echoed as this caller may read it (`A-16`).
          seenBy: await visibilityOf(request),
          ...(request.body.sensorId === undefined ? {} : { sensorId: request.body.sensorId }),
        }),
    );
  }

  app.post<{ Body: TemplateInput }>(
    '/templates',
    {
      config: WRITES,
      schema: {
        tags: ['templates'],
        summary: 'Create a template',
        // Account and group recipients are `M-20`'s, an administrator's since `A-44`.
        description:
          'Only an administrator may name an account or a group as a recipient; ' +
          'anybody else gets 403 `AUTH_FORBIDDEN` for one, and may name addresses.',
        body: { $ref: 'ms:templateInput' },
        response: { 201: { $ref: 'ms:template' } },
      },
    },
    async (request, reply) => {
      const created = await templates.create(actorFor(request), request.body, writerOf(request));
      await reply.status(201).send(created);
    },
  );

  app.put<{ Params: { id: number }; Body: TemplateInput }>(
    '/templates/:id',
    {
      config: WRITES,
      schema: {
        tags: ['templates'],
        summary: 'Replace a template',
        // Account and group recipients are `M-20`'s, an administrator's since `A-44`.
        description:
          'Whole-document, with one exception: a secret the request does not carry is **kept**, ' +
          'because the form it came from was rendered without it. Send an explicit `null` to ' +
          'clear one. **A secret is kept only while it goes where it went:** a request that ' +
          "changes a webhook's `url`, or a program's `path` or any of its `args`, clears the " +
          'secrets sent there unless it carries them again, so re-pointing a template never ' +
          'sends a token somebody else set to a new destination. A field left out counts as ' +
          'its default: a program with no `args` keeps its `secretArgs` through an edit that ' +
          'sends none. **Only an administrator may add an account or a group recipient**: ' +
          'anybody else may keep or remove the ones the template has, and ' +
          'gets 403 `AUTH_FORBIDDEN` for one it did not have.',
        params: idParams,
        body: { $ref: 'ms:templateInput' },
        response: { 200: { $ref: 'ms:template' } },
      },
    },
    async (request) =>
      templates.update(actorFor(request), request.params.id, request.body, writerOf(request)),
  );

  app.delete<{ Params: { id: number } }>(
    '/templates/:id',
    {
      config: WRITES,
      schema: {
        tags: ['templates'],
        summary: 'Remove a template',
        // Listed and counted in the caller's view since `A-16`.
        description:
          'Refused while a trigger still names it, with the list of triggers to fix: deleting ' +
          'one out from under a trigger would leave that trigger firing into nothing. **Only ' +
          'triggers on objects the caller can see are listed or counted**; ' +
          '`details.outsideView` is true when others outside the caller’s view use it too, and ' +
          'says nothing of how many. An administrator is shown every one.',
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
      await templates.delete(actorFor(request), request.params.id, await visibilityOf(request));
      return { id: request.params.id, deleted: true };
    },
  );
}
