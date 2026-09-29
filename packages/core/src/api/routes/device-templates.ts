// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, type Fingerprint } from '@ms/shared';
import type { DeviceTemplateCatalogue } from '../../device-templates/catalogue.js';
import { templateFromDevice } from '../../device-templates/from-device.js';
import { runNotFound } from '../../discovery/errors.js';
import { checkFingerprint } from '../../discovery/fingerprint.js';
import type { DiscoveryService } from '../../discovery/service.js';
import type { Visibility } from '../../auth/access.js';
import { ObjectError } from '../../objects/errors.js';
import {
  COMPUTES,
  READS,
  computesOn,
  onObject,
  onObjectOf,
  visibilityOf,
} from '../authorization.js';

export interface DeviceTemplateRouteOptions {
  templates: DeviceTemplateCatalogue;
  discovery?: DiscoveryService;
  /**
   * A device's sensors, for save-as-template: those the caller can see (`A-23`). Absent disables
   * that one route.
   */
  sensorsOf?: (
    deviceId: number,
    visibility: Visibility,
  ) => Promise<{ name: string; sensorType: string; params: Record<string, unknown> }[]>;
  credentialKindsFor: (sensorType: string) => readonly string[];
}

const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

/**
 * Device templates (`D-03`).
 *
 * **Read-only over HTTP, and that is the same decision `/lookups` made.** A template is a file an
 * operator edits and the core loads at start; making it editable through the API would give one
 * concept two sources of truth and a question about which wins. What *is* here is everything an
 * operator needs to work with them: the list, what was refused and why, what a given fingerprint
 * would produce, and a starting file generated from a device they have already set up.
 */
export function deviceTemplateRoutes(
  app: FastifyInstance,
  options: DeviceTemplateRouteOptions,
): void {
  const { templates, discovery, sensorsOf, credentialKindsFor } = options;

  app.get(
    '/device-templates',
    {
      config: READS,
      schema: {
        tags: ['discovery'],
        summary: 'Every device template, and anything that was refused',
        description:
          'Refused templates are reported rather than hidden: one that failed to load creates ' +
          'none of the sensors it names, and nobody notices until the day one of them mattered.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'problems'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'name', 'description', 'sensorCount', 'source'],
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    sensorCount: { type: 'integer' },
                    overridesBuiltIn: { type: 'boolean' },
                    source: { type: 'string' },
                  },
                },
              },
              problems: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'source', 'problems'],
                  properties: {
                    id: { type: 'string' },
                    source: { type: 'string' },
                    problems: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    () => ({ items: templates.summaries(), problems: templates.problems() }),
  );

  app.get(
    '/device-templates/:templateId',
    {
      config: READS,
      schema: {
        tags: ['discovery'],
        summary: 'One template, in full',
        params: {
          type: 'object',
          required: ['templateId'],
          additionalProperties: false,
          properties: { templateId: { type: 'string', minLength: 1, maxLength: 100 } },
        },
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    (request: FastifyRequest) => {
      const { templateId } = request.params as { templateId: string };
      const template = templates.get(templateId);
      if (template === null) {
        throw new AppError('DEVICE_TEMPLATE_NOT_FOUND', `there is no template "${templateId}"`, {
          context: { templateId },
        });
      }
      return template;
    },
  );

  app.post(
    '/device-templates/plan',
    {
      // Answers what a fingerprint would produce. Creates nothing.
      config: COMPUTES,
      schema: {
        tags: ['discovery'],
        summary: 'What a fingerprint would produce',
        description:
          'The answer `D-04` will act on, before it acts on it. Takes a fingerprint — one of ' +
          'the ones a discovery run recorded — and reports which templates matched and which ' +
          'sensors would actually be created, given the credential kinds available. The ' +
          'fingerprint is checked as a stored one is: without an IPv4 `address`, a known ' +
          '`kind` and a number on every port, or with anything but text in a text field, it is ' +
          'a 400 `FINGERPRINT_INVALID` naming the field. Fields this build does not know are ' +
          'accepted and ignored.',
        body: {
          type: 'object',
          required: ['fingerprint'],
          additionalProperties: false,
          properties: {
            fingerprint: { type: 'object', additionalProperties: true },
            credentials: {
              type: 'array',
              default: [],
              items: { type: 'string', maxLength: 40 },
              description:
                'The credential kinds this device could resolve. A sensor whose kind is not ' +
                'here is left out rather than created and left failing.',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['templates', 'sensors', 'tags'],
            properties: {
              templates: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'name', 'score'],
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    score: { type: 'integer' },
                  },
                },
              },
              sensors: { type: 'array', items: { type: 'object', additionalProperties: true } },
              tags: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    (request: FastifyRequest) => {
      const body = request.body as { fingerprint: unknown; credentials?: string[] };
      // Through the check a stored fingerprint takes (`D-12`). The body schema leaves the
      // fingerprint open, as the wire does, so this is where a missing `ports` or a numeric
      // `vendor` stops, rather than inside the matcher as a 500.
      const check = checkFingerprint(body.fingerprint);
      if (!check.ok) {
        throw new AppError('FINGERPRINT_INVALID', `fingerprint.${check.field} ${check.problem}`, {
          context: { field: `fingerprint.${check.field}` },
        });
      }
      const plan = templates.plan(check.fingerprint, new Set(body.credentials ?? []));
      return {
        templates: plan.templates.map((one) => ({
          id: one.template.id,
          name: one.template.name,
          score: one.score,
        })),
        sensors: plan.sensors,
        tags: plan.tags,
      };
    },
  );

  if (discovery !== undefined) {
    app.get(
      '/discovery/:id/plan',
      {
        // What a run found, so the run's own bar: read on the group it provisions into (`A-12`).
        config: onObjectOf(
          'read',
          'this run',
          async (id) => (await discovery.get(id))?.groupId ?? null,
          runNotFound,
        ),
        schema: {
          tags: ['discovery'],
          summary: 'What a run’s hosts would produce',
          description:
            'The whole run at once, which is what an operator wants to look at before letting ' +
            '`D-04` create anything. Hosts with no fingerprint yet are reported with the ' +
            'generic plan, because that is what they would get.',
          params: idParams,
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              credentials: { type: 'string', maxLength: 200, default: '' },
              limit: { type: 'integer', minimum: 1, maximum: 5_000, default: 500 },
            },
          },
          response: {
            200: {
              type: 'object',
              additionalProperties: false,
              required: ['items'],
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['address', 'templates', 'sensors'],
                    properties: {
                      address: { type: 'string' },
                      kind: { type: 'string' },
                      templates: { type: 'array', items: { type: 'string' } },
                      sensors: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      async (request: FastifyRequest) => {
        const { id } = request.params as { id: number };
        const { credentials, limit } = request.query as { credentials?: string; limit?: number };
        // Not an empty plan: that is the answer for a run that found nothing (`A-37`).
        if ((await discovery.get(id)) === null) throw runNotFound(id);
        const available = new Set(
          (credentials ?? '')
            .split(',')
            .map((one) => one.trim())
            .filter((one) => one !== ''),
        );
        const hosts = await discovery.hosts(id, limit ?? 500);
        return {
          items: hosts.map((host) => {
            // A host with no fingerprint gets the generic plan, because that is exactly what it
            // would get: the fallback template matches every fingerprint including an empty one.
            const fingerprint: Fingerprint = host.fingerprint ?? {
              address: host.address,
              ports: [],
              kind: 'unknown',
              confidence: 0,
              evidence: ['this host has not been identified'],
            };
            const plan = templates.plan(fingerprint, available);
            return {
              address: host.address,
              kind: fingerprint.kind,
              templates: plan.templates.map((one) => one.template.id),
              sensors: plan.sensors.map((one) => one.type),
            };
          }),
        };
      },
    );
  }

  if (sensorsOf !== undefined) {
    app.post(
      '/objects/:id/as-template',
      {
        // **A read of one device, priced as one** (`R12`). It stores nothing — the operator
        // saves the returned document themselves — but it returns every sensor on that device
        // with its name, type and parameters, which is exactly what `GET /objects/:id/tree` is
        // guarded for. Declaring `WRITES` served that read to any account with the role,
        // including for devices the same account is refused sight of.
        config: computesOn(onObject('read')),
        schema: {
          tags: ['discovery'],
          summary: 'A template file, from a device already set up',
          description:
            'Returns the JSON to save under the template directory — it is not registered here, ' +
            'because a template is a file an operator edits and one source of truth is enough. ' +
            '**The match rule matches nothing until you fill it in**: only you know whether this ' +
            'is for this model, this vendor, or every switch, and a template that matched ' +
            'everything by accident would put this sensor set on every printer in the estate.',
          params: idParams,
          body: {
            type: 'object',
            required: ['id', 'name'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 3, maxLength: 100 },
              name: { type: 'string', minLength: 1, maxLength: 200 },
              description: { type: 'string', maxLength: 1_000 },
              match: { type: 'object', additionalProperties: true },
            },
          },
          response: { 200: { type: 'object', additionalProperties: true } },
        },
      },
      async (request: FastifyRequest) => {
        const { id } = request.params as { id: number };
        const body = request.body as {
          id: string;
          name: string;
          description?: string;
          match?: Record<string, unknown>;
        };
        const sensors = await sensorsOf(id, await visibilityOf(request));
        // A 400, and the same one for a device whose sensors are all hidden (`A-23`). It was a bare
        // `AppError`, which no branch of `toHttpError` knows, so it went out as a 500 with its
        // message replaced — a mistake by the caller reported as a failure of the core.
        if (sensors.length === 0) {
          throw new ObjectError('OBJECT_INVALID', `object ${String(id)} has no sensors to save`, {
            context: { objectId: id, phase: 'as-template' },
          });
        }
        return templateFromDevice({
          id: body.id,
          name: body.name,
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.match === undefined ? {} : { match: body.match }),
          sensors,
          credentialKindsFor,
        });
      },
    );
  }
}
