// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { actorFor } from '../authentication.js';
import { triggerKinds } from '../../triggers/definition.js';
import type { TriggerInput, TriggerService } from '../../triggers/service.js';

export interface TriggerRouteOptions {
  triggers: TriggerService;
}

const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const triggerViewSchema = {
  $id: 'ms:trigger',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'kind',
    'kindName',
    'settings',
    'enabled',
    'summary',
    'inherited',
    'definedOn',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'integer' },
    kind: { type: 'string' },
    kindName: { type: 'string' },
    /** Shaped by the kind's own schema; served as it was validated and stored. */
    settings: { type: 'object', additionalProperties: true },
    enabled: { type: 'boolean' },
    /** One line for the tab, built from the settings by the kind itself. */
    summary: { type: 'string' },
    inherited: { type: 'boolean' },
    /** The object the trigger is defined on — the only place it can be edited or removed. */
    definedOn: {
      type: 'object',
      additionalProperties: false,
      required: ['objectId', 'name'],
      properties: { objectId: { type: 'integer' }, name: { type: 'string' } },
    },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const triggerKindSchema = {
  $id: 'ms:triggerKind',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'description', 'settingsSchema'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    /** The JSON Schema a UI builds the form from, and the API validates against. */
    settingsSchema: { type: 'object', additionalProperties: true },
  },
} as const;

const triggerInputSchema = {
  $id: 'ms:triggerInput',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'settings'],
  properties: {
    kind: { type: 'string', minLength: 1, maxLength: 40 },
    settings: { type: 'object', additionalProperties: true },
    enabled: { type: 'boolean', default: true },
  },
} as const;

export const TRIGGER_SCHEMAS = [triggerViewSchema, triggerKindSchema, triggerInputSchema];

/**
 * Notification triggers (`N-01`).
 *
 * The effective set hangs off the object, because that is the question — "what would notify
 * anybody about this sensor" — and the answer includes triggers defined several levels up. One
 * trigger is edited and deleted by its own id, because that is where it lives, and the effective
 * set names it so a UI can navigate there.
 */
export function triggerRoutes(app: FastifyInstance, options: TriggerRouteOptions): void {
  const { triggers } = options;

  app.get(
    '/trigger-kinds',
    {
      schema: {
        tags: ['triggers'],
        summary: 'The kinds of trigger this build understands',
        description:
          'Each carries the JSON Schema its settings are validated against, which is also what ' +
          'a UI builds the form from — one declaration rather than a form and a validator that ' +
          'can disagree.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: { $ref: 'ms:triggerKind' } } },
          },
        },
      },
    },
    () => ({
      items: triggerKinds.all().map((kind) => ({
        id: kind.id,
        name: kind.name,
        description: kind.description,
        settingsSchema: kind.settingsSchema,
      })),
    }),
  );

  app.get<{ Params: { id: number } }>(
    '/objects/:id/triggers',
    {
      schema: {
        tags: ['triggers'],
        summary: 'Every trigger in effect on an object, its own first',
        description:
          'Own and inherited together, nearest first, each naming the object it is defined on ' +
          '— which is the only place it can be edited or removed. A trigger on the root applies ' +
          'to every sensor in the installation. Unlike an inherited *setting*, an inherited ' +
          'trigger does not displace a nearer one: both fire.',
        params: idParams,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['objectId', 'items'],
            properties: {
              objectId: { type: 'integer' },
              items: { type: 'array', items: { $ref: 'ms:trigger' } },
            },
          },
        },
      },
    },
    async (request, reply) => {
      // Never cached: the set changes when any ancestor is edited, and an ETag built from this
      // object alone would not move.
      void reply.header('cache-control', 'no-store');
      return {
        objectId: request.params.id,
        items: await triggers.effectiveFor(request.params.id),
      };
    },
  );

  app.post<{ Params: { id: number }; Body: TriggerInput }>(
    '/objects/:id/triggers',
    {
      schema: {
        tags: ['triggers'],
        summary: 'Add a trigger to an object',
        description:
          'The settings are validated against the kind’s own schema, with its defaults filled ' +
          'in — so a state trigger with only a state is a complete trigger that notifies ' +
          'immediately and never escalates.',
        params: idParams,
        body: { $ref: 'ms:triggerInput' },
        response: { 201: { $ref: 'ms:trigger' } },
      },
    },
    async (request, reply) => {
      const created = await triggers.create(actorFor(request), request.params.id, request.body);
      await reply.status(201).send(created);
    },
  );

  app.put<{ Params: { id: number }; Body: TriggerInput }>(
    '/triggers/:id',
    {
      schema: {
        tags: ['triggers'],
        summary: 'Replace a trigger',
        description:
          'Whole-document: a latency without the notification it delays is not half a trigger, ' +
          'it is a broken one.',
        params: idParams,
        body: { $ref: 'ms:triggerInput' },
        response: { 200: { $ref: 'ms:trigger' } },
      },
    },
    async (request) => triggers.update(actorFor(request), request.params.id, request.body),
  );

  app.delete<{ Params: { id: number } }>(
    '/triggers/:id',
    {
      schema: {
        tags: ['triggers'],
        summary: 'Remove a trigger',
        description:
          'From the object it is defined on. Deleting an inherited trigger means deleting it ' +
          'where it lives, which the effective set names.',
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
      await triggers.delete(actorFor(request), request.params.id);
      return { id: request.params.id, deleted: true };
    },
  );
}
