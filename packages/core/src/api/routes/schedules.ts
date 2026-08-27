// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { actorFor } from '../authentication.js';
import type { ScheduleInput, ScheduleService } from '../../schedules/service.js';

export interface ScheduleRouteOptions {
  schedules: ScheduleService;
}

const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

/**
 * The schedule library (`M-09`).
 *
 * Full CRUD, unlike `/lookups`: a lookup is a file an operator edits with a text editor and a
 * restart, while a schedule is something they change at 08:55 because the maintenance window
 * moved. Assigning one is *not* here — that is `PUT /objects/:id/settings/schedule.id`, because
 * a schedule assignment is an ordinary inheritable setting and giving it a second endpoint
 * would give it a second set of rules to keep in step with the first.
 */
export function scheduleRoutes(app: FastifyInstance, options: ScheduleRouteOptions): void {
  const { schedules } = options;

  app.get(
    '/schedules',
    {
      schema: {
        tags: ['schedules'],
        summary: 'Every schedule, with what it means right now',
        description:
          '`active` and `nextChangeAt` are evaluated at the moment the request is served, so a ' +
          'list is also the answer to "what is suspended at the moment".',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: { $ref: 'ms:schedule' } } },
          },
        },
      },
    },
    async () => ({ items: await schedules.list() }),
  );

  app.get<{ Params: { id: number } }>(
    '/schedules/:id',
    {
      schema: {
        tags: ['schedules'],
        summary: 'One schedule',
        params: idParams,
        response: { 200: { $ref: 'ms:schedule' } },
      },
    },
    async (request) => schedules.get(request.params.id),
  );

  app.post<{ Body: ScheduleInput }>(
    '/schedules',
    {
      schema: {
        tags: ['schedules'],
        summary: 'Create a schedule',
        description:
          'Give either `periods` (`fr:19:00-mo:06:00`, space or comma separated) or `grid` ' +
          '(7 × 24 booleans, Monday first) — never both. `polarity` says which one the periods ' +
          'describe: `active` is when monitoring runs, `inactive` is when it is suspended.',
        body: { $ref: 'ms:scheduleInput' },
        response: { 201: { $ref: 'ms:schedule' } },
      },
    },
    async (request, reply) => {
      const created = await schedules.create(actorFor(request), request.body);
      await reply.status(201).send(created);
    },
  );

  app.put<{ Params: { id: number }; Body: ScheduleInput }>(
    '/schedules/:id',
    {
      schema: {
        tags: ['schedules'],
        summary: 'Replace a schedule',
        description:
          'Whole-document: a partial update of a period list is a merge nobody can define. ' +
          'Sensors under this schedule are re-evaluated in the same transaction, so a window ' +
          'that has just closed pauses them before the response is sent.',
        params: idParams,
        body: { $ref: 'ms:scheduleInput' },
        response: { 200: { $ref: 'ms:schedule' } },
      },
    },
    async (request) => schedules.update(actorFor(request), request.params.id, request.body),
  );

  app.delete<{ Params: { id: number } }>(
    '/schedules/:id',
    {
      schema: {
        tags: ['schedules'],
        summary: 'Delete a schedule',
        description:
          'Refused while any object still assigns it — the refusal names them — and refused ' +
          'outright for the schedules this build ships.',
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
      await schedules.delete(actorFor(request), request.params.id);
      return { id: request.params.id, deleted: true };
    },
  );
}
