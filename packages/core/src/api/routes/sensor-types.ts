import type { SensorCatalogue } from '@ms/sensors';
import type { FastifyInstance } from 'fastify';

export interface SensorTypeRouteOptions {
  catalogue: SensorCatalogue;
}

const sensorTypeListSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'category', 'costHint', 'paramsSchema'],
        properties: {
          id: { type: 'string' },
          category: { type: 'string' },
          costHint: { enum: ['light', 'medium', 'heavy'] },
          paramsSchema: { type: 'object', additionalProperties: true },
        },
      },
    },
  },
} as const;

/**
 * What the add-sensor form is built from (ADR-001 Decision 7: `paramsSchema` generates the UI).
 *
 * The catalogue is read-only at runtime, so there is nothing here but a GET. Parameters marked
 * `writeOnly` keep that annotation in the schema on purpose — it is how a form knows to render a
 * password field, and it is a statement about the *shape*, never about a stored value.
 */
export function sensorTypeRoutes(app: FastifyInstance, options: SensorTypeRouteOptions): void {
  app.get(
    '/sensor-types',
    {
      schema: {
        tags: ['sensor-types'],
        summary: 'List the registered sensor types',
        description:
          'Every type this installation can run, with the JSON Schema its parameters are ' +
          'validated against. An empty list means no sensor can be created.',
        response: { 200: sensorTypeListSchema },
      },
    },
    () => ({ items: options.catalogue.summaries() }),
  );
}
