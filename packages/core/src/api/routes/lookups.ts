// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import type { LookupCatalogue } from '../../lookups/catalogue.js';
import { ObjectError } from '../../objects/errors.js';

export interface LookupRouteOptions {
  lookups: LookupCatalogue;
}

/**
 * What this installation can judge a channel by (`M-06`).
 *
 * Read-only, and modelled on `GET /sensor-types` for the same reason: lookups are files and
 * modules, not rows, so the API's job is to say what loaded rather than to accept edits. A
 * definition added to `<dataDir>/lookups` is picked up at the next start — deliberately, since
 * reloading one under a running system means re-judging every channel that uses it, which is a
 * decision worth making explicitly rather than as a side effect of saving a file.
 */
export function lookupRoutes(app: FastifyInstance, options: LookupRouteOptions): void {
  const { lookups } = options;

  app.get(
    '/lookups',
    {
      schema: {
        tags: ['lookups'],
        summary: 'List the lookups this installation has loaded',
        description:
          'Every definition available to a channel, plus every one that was refused and why. ' +
          'A refused lookup leaves its channels judged by nothing, so the failures are served ' +
          'beside the successes rather than left in the journal.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'problems'],
            properties: {
              items: { type: 'array', items: { $ref: 'ms:lookupSummary' } },
              problems: { type: 'array', items: { $ref: 'ms:lookupProblem' } },
            },
          },
        },
      },
    },
    () => ({ items: lookups.summaries(), problems: lookups.problems() }),
  );

  app.get<{ Params: { id: string } }>(
    '/lookups/:id',
    {
      schema: {
        tags: ['lookups'],
        summary: 'One lookup, with every entry',
        description:
          'What each value maps to. `undefinedState` is what a value no entry covers becomes — ' +
          'it has no default, because whether an undocumented status code is fine or a problem ' +
          'depends entirely on the device.',
        params: {
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: { id: { type: 'string', minLength: 1, maxLength: 100 } },
        },
        response: { 200: { $ref: 'ms:lookupDetail' } },
      },
    },
    (request) => {
      const definition = lookups.get(request.params.id);
      if (definition === undefined) {
        throw new ObjectError('OBJECT_NOT_FOUND', `no lookup "${request.params.id}" is loaded`, {
          context: { phase: 'lookups' },
          details: { lookupId: request.params.id },
        });
      }
      return { description: '', ...definition };
    },
  );
}
