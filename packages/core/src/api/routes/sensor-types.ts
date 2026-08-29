import { SensorTypeError, type SensorCatalogue } from '@ms/sensors';
import type { FastifyInstance } from 'fastify';
import { ObjectError } from '../../objects/errors.js';

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
        required: ['id', 'category', 'costHint', 'paramsSchema', 'hasPreview'],
        properties: {
          id: { type: 'string' },
          category: { type: 'string' },
          costHint: { enum: ['light', 'medium', 'heavy'] },
          paramsSchema: { type: 'object', additionalProperties: true },
          hasPreview: { type: 'boolean' },
        },
      },
    },
  },
} as const;

/** As much of a response as anybody pastes, and a bound on what one request may make us walk. */
const MAX_DOCUMENT_BYTES = 256 * 1024;

const previewBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['document', 'params'],
  properties: {
    document: {
      type: 'string',
      maxLength: MAX_DOCUMENT_BYTES,
      description:
        'The response, pasted verbatim. Bounded well below what the sensor itself will read: ' +
        'this one is walked once per path while somebody types, and a preview is for finding ' +
        'out whether a path is right, not for proving a sensor can survive the whole document.',
    },
    contentType: {
      type: 'string',
      maxLength: 200,
      default: '',
      description:
        'What the server called it, where that is known. Empty is honest and common — the ' +
        'format is then guessed from the document exactly as the sensor guesses it.',
    },
    params: {
      type: 'object',
      additionalProperties: true,
      description:
        'The parameters as the form currently holds them. **Not validated first**: the form ' +
        'asking for this has a half-finished parameter set in it by definition, and a preview ' +
        'that refused until everything was valid would be unavailable exactly when it is needed.',
    },
  },
} as const;

const previewResultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['format', 'rows', 'expectations', 'problems'],
  properties: {
    format: { type: 'string', description: 'How the document was read — `auto` resolved.' },
    error: { type: 'string', description: 'Set when the document itself did not parse.' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'path', 'selected', 'selectedCount', 'value'],
        properties: {
          key: { type: 'string' },
          path: { type: 'string' },
          error: { type: 'string' },
          selected: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text', 'numeric'],
              properties: { text: { type: 'string' }, numeric: { type: 'boolean' } },
            },
          },
          selectedCount: { type: 'integer' },
          value: { type: ['number', 'null'] },
        },
      },
    },
    expectations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'actual', 'ok'],
        properties: {
          path: { type: 'string' },
          error: { type: 'string' },
          actual: { type: 'string' },
          ok: { type: 'boolean' },
        },
      },
    },
    problems: { type: 'array', items: { type: 'string' } },
  },
} as const;

/**
 * What the add-sensor form is built from (ADR-001 Decision 7: `paramsSchema` generates the UI).
 *
 * Mostly a GET, because the catalogue is read-only at runtime. Parameters marked `writeOnly`
 * keep that annotation in the schema on purpose — it is how a form knows to render a password
 * field, and it is a statement about the *shape*, never about a stored value.
 *
 * The one POST does no writing either: it runs a type's own mapping language over a document the
 * caller pasted and hands back what each path selected (`U-13`).
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

  app.post<{
    Params: { id: string };
    Body: { document: string; contentType?: string; params: Record<string, unknown> };
  }>(
    '/sensor-types/:id/preview',
    {
      schema: {
        tags: ['sensor-types'],
        summary: 'Run this type’s mapping language over a pasted response',
        description:
          'For types whose parameters contain paths into a document — `rest.custom`’s ' +
          '`extract` array is the one — this answers what each path selects against a response ' +
          'the operator pasted, what the aggregate makes of it, and whether the check would ' +
          'pass. **The type’s own code runs**, the same functions a real check runs, so a path ' +
          'proved here works against the device.\n\n' +
          '**Nothing is fetched and nothing is stored.** The document comes from the request; ' +
          'no sensor is created, no credential is read, and no reading enters history. Types ' +
          'with no mapping language answer 409, and `hasPreview` on the type list says which ' +
          'those are without a request.\n\n' +
          'A path that does not parse is reported on its own row rather than failing the ' +
          'request: the form this feeds has a half-typed path in it every few keystrokes.',
        params: {
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: { id: { type: 'string', maxLength: 100 } },
        },
        body: previewBodySchema,
        response: { 200: previewResultSchema },
      },
    },
    async (request) => {
      const typeId = request.params.id;
      let result;
      try {
        result = await options.catalogue.preview(typeId, {
          document: request.body.document,
          contentType: request.body.contentType ?? '',
          params: request.body.params,
        });
      } catch (cause) {
        if (cause instanceof SensorTypeError) {
          throw new ObjectError('OBJECT_NOT_FOUND', cause.message, {
            context: { phase: 'preview' },
            cause,
          });
        }
        throw cause;
      }
      if (result === null) {
        // A 400 rather than a 404: the type exists and the thing being asked of it does not, and
        // a 404 would send a client looking for a typo in the type id it in fact spelled right.
        // The UI never gets here — it reads `hasPreview` off the type list — so this is for a
        // hand-written client, which needs the sentence more than it needs the status.
        throw new ObjectError(
          'OBJECT_INVALID',
          `sensor type "${typeId}" has no paths to preview — this is for types whose ` +
            'parameters contain a mapping language, such as rest.custom',
          { context: { phase: 'preview' }, details: { sensorType: typeId } },
        );
      }
      return result;
    },
  );
}
