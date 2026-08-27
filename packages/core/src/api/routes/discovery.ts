// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  DISCOVERY_LEVELS,
  estimateSeconds,
  IpRangeError,
  parseIpRange,
  type DiscoveryLevel,
} from '@ms/shared';
import { DiscoveryError } from '../../discovery/errors.js';
import type { DiscoveryService } from '../../discovery/service.js';
import type { ProvisionReport } from '../../discovery/provision.js';
import type { Actor } from '../../objects/audit.js';

export interface DiscoveryRouteOptions {
  discovery: DiscoveryService;
  /** Absent until D-04 is wired; the provision route then does not exist. */
  provision?: (runId: number, actor: Actor) => Promise<ProvisionReport>;
}

const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const runSchema = {
  $id: 'ms:discoveryRun',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'groupId', 'probeId', 'range', 'total', 'cursor', 'found', 'failed', 'status'],
  properties: {
    id: { type: 'integer' },
    groupId: { type: 'integer' },
    probeId: { type: 'integer' },
    range: { type: 'string' },
    total: { type: 'integer' },
    cursor: { type: 'integer' },
    found: { type: 'integer' },
    failed: { type: 'integer' },
    status: {
      type: 'string',
      enum: ['queued', 'running', 'identifying', 'done', 'cancelled', 'failed'],
    },
    level: { type: 'string', enum: ['ping', 'standard', 'detailed'] },
    templates: { type: 'array', items: { type: 'string' } },
    identified: { type: 'integer' },
    devicesCreated: { type: 'integer' },
    devicesMatched: { type: 'integer' },
    sensorsCreated: { type: 'integer' },
    provisionedAt: { type: ['string', 'null'] },
    message: { type: 'string' },
    timeoutMs: { type: 'integer' },
    concurrency: { type: 'integer' },
    ratePerSecond: { type: 'number' },
    createdAt: { type: 'string' },
    startedAt: { type: ['string', 'null'] },
    finishedAt: { type: ['string', 'null'] },
  },
} as const;

/**
 * Discovery runs (`D-01`).
 *
 * **A run is created, watched and cancelled — never edited.** Changing the range of a sweep
 * halfway through would make its cursor mean something different from what it meant when the
 * addresses behind it were swept, and the progress an operator is watching would jump. A
 * different range is a different run, and runs are cheap.
 *
 * `/preview` exists so a form can say "that is 65,534 addresses and about forty minutes" before
 * the operator commits, which is the one piece of advice that stops a mistyped mask becoming a
 * sixteen-million-address sweep. It parses with the same code the run will.
 */
export function discoveryRoutes(app: FastifyInstance, options: DiscoveryRouteOptions): void {
  const { discovery } = options;
  app.addSchema(runSchema);

  app.post(
    '/discovery/preview',
    {
      schema: {
        tags: ['discovery'],
        summary: 'What a range means, and what each level would cost',
        description:
          'Parses a range and estimates every level, so an operator picks one knowing what it ' +
          'costs rather than finding out. The same parser and the same level table the run ' +
          'uses, so a range that previews is a range that will start and an estimate is about ' +
          'the run that actually happens.',
        body: {
          type: 'object',
          required: ['range'],
          additionalProperties: false,
          properties: {
            range: { type: 'string', minLength: 1, maxLength: 4000 },
            timeoutMs: { type: 'integer', minimum: 100, maximum: 60_000, default: 1_000 },
            concurrency: { type: 'integer', minimum: 1, maximum: 512, default: 32 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['range', 'total', 'levels'],
            properties: {
              range: { type: 'string' },
              total: { type: 'integer' },
              levels: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'name', 'description', 'minSeconds', 'maxSeconds', 'ports'],
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    minSeconds: {
                      type: 'integer',
                      description:
                        'If every address answers: the sweep is quick and every host is identified.',
                    },
                    maxSeconds: {
                      type: 'integer',
                      description:
                        'If none do: the sweep pays a full timeout each and there is nothing to identify.',
                    },
                    ports: {
                      type: 'integer',
                      description: 'How many ports each host is asked about.',
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    (request: FastifyRequest) => {
      const body = request.body as { range: string; timeoutMs?: number; concurrency?: number };
      const range = parse(body.range);
      const sweepTimeoutMs = body.timeoutMs ?? 1_000;
      const sweepConcurrency = body.concurrency ?? 32;
      return {
        range: range.text,
        total: range.size,
        levels: DISCOVERY_LEVELS.map((level) => {
          const estimate = estimateSeconds({
            level: level.id,
            addresses: range.size,
            sweepTimeoutMs,
            sweepConcurrency,
            // The bound the service uses when it dispatches identification (`D-02`).
            identifyConcurrency: 8,
          });
          return {
            id: level.id,
            name: level.name,
            description: level.description,
            minSeconds: estimate.min,
            maxSeconds: estimate.max,
            ports: level.ports.length,
          };
        }),
      };
    },
  );

  app.post(
    '/discovery',
    {
      schema: {
        tags: ['discovery'],
        summary: 'Start a discovery run',
        description:
          'Sweeps a range from one probe into one group. The probe is named rather than chosen: ' +
          'discovery is a local-network job, so the probe that can reach 10.0.0.0/24 is the one ' +
          'on that network.',
        body: {
          type: 'object',
          required: ['groupId', 'probeId', 'range'],
          additionalProperties: false,
          properties: {
            groupId: { type: 'integer', minimum: 1 },
            probeId: { type: 'integer', minimum: 1 },
            range: { type: 'string', minLength: 1, maxLength: 4000 },
            timeoutMs: { type: 'integer', minimum: 100, maximum: 60_000 },
            concurrency: { type: 'integer', minimum: 1, maximum: 512 },
            // 0 means the concurrency bound is the only limit. A rate is what an operator
            // reaches for on a network where a burst of pings sets off an intrusion detector.
            ratePerSecond: { type: 'number', minimum: 0, maximum: 100_000 },
            level: {
              type: 'string',
              enum: ['ping', 'standard', 'detailed'],
              default: 'standard',
              description:
                'How hard to look. `POST /discovery/preview` reports what each one costs on ' +
                'this range, which is worth reading before starting a detailed sweep of a /16.',
            },
            templates: {
              type: 'array',
              maxItems: 100,
              default: [],
              items: { type: 'string', minLength: 1, maxLength: 100 },
              description:
                'Template ids this run may use. Empty means all of them. A filter rather than ' +
                'a fourth level, because “detailed, but only these templates” is a thing ' +
                'somebody wants and a level could not express it.',
            },
            snmpCommunity: {
              type: 'string',
              maxLength: 128,
              default: '',
              description:
                'Tried read-only against every host during identification, and skipped when ' +
                'empty. `sysDescr` and `sysObjectID` are the two most informative things a ' +
                'device will tell you, and this is the only credential identification has: it ' +
                'runs before anybody has told the system anything about these hosts, so v3 — ' +
                'which needs a username and a passphrase per device — is not available to it.',
            },
          },
        },
        response: { 201: { $ref: 'ms:discoveryRun' } },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        groupId: number;
        probeId: number;
        range: string;
        timeoutMs?: number;
        concurrency?: number;
        ratePerSecond?: number;
        level?: DiscoveryLevel;
        snmpCommunity?: string;
        templates?: string[];
      };
      parse(body.range);
      const run = await discovery.start(body);
      await reply.code(201).send(run);
      return reply;
    },
  );

  app.get(
    '/discovery/:id',
    {
      schema: {
        tags: ['discovery'],
        summary: 'A run and how far it has got',
        params: idParams,
        response: { 200: { $ref: 'ms:discoveryRun' } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: number };
      const run = await discovery.get(id);
      if (run === null) throw notFound(id);
      return run;
    },
  );

  app.get(
    '/discovery/:id/hosts',
    {
      schema: {
        tags: ['discovery'],
        summary: 'The addresses a run found alive',
        description:
          'In address order rather than the order they answered, because an operator reading a ' +
          'list of them is looking for gaps.',
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 65_536, default: 1_000 } },
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
                  required: ['address'],
                  properties: {
                    address: { type: 'string' },
                    rttMs: { type: ['number', 'null'] },
                    // Null until identification has run, and for a run at `level: 'ping'`. Null
                    // rather than absent: "not identified yet" is a state a client renders, and
                    // a missing key is indistinguishable from a client that did not ask.
                    fingerprint: { type: ['object', 'null'], additionalProperties: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: number };
      const { limit } = request.query as { limit?: number };
      if ((await discovery.get(id)) === null) throw notFound(id);
      return { items: await discovery.hosts(id, limit ?? 1_000) };
    },
  );

  app.post(
    '/discovery/:id/cancel',
    {
      schema: {
        tags: ['discovery'],
        summary: 'Stop a run',
        description:
          'Recorded immediately and sent to the probe as well, so a cancel works even while the ' +
          'probe is disconnected — otherwise the sweep would resume the moment it came back.',
        params: idParams,
        response: { 200: { $ref: 'ms:discoveryRun' } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: number };
      const run = await discovery.cancel(id);
      if (run !== null) return run;
      // A run that exists but has already finished is not an error worth a 404: the operator
      // asked for it to stop and it is stopped. Anything else is genuinely missing.
      const existing = await discovery.get(id);
      if (existing === null) throw notFound(id);
      return existing;
    },
  );

  if (options.provision !== undefined) {
    const provision = options.provision;
    app.post(
      '/discovery/:id/provision',
      {
        schema: {
          tags: ['discovery'],
          summary: 'Create the devices and sensors this run found',
          description:
            '**Idempotent.** Devices are matched on address, then reverse name, then short name ' +
            'within the target group, and only sensors that are not already there are created — ' +
            'so running this twice creates nothing the second time. That matters because a ' +
            'discovery is re-run: on a schedule, or by an operator who has configured a ' +
            'credential and wants the sensors it unlocks.',
          params: idParams,
          response: {
            200: {
              type: 'object',
              additionalProperties: false,
              required: ['devicesCreated', 'matched', 'sensorsCreated', 'sensorsSkipped'],
              properties: {
                devicesCreated: { type: 'integer' },
                matched: { type: 'integer', description: 'Devices that already existed.' },
                sensorsCreated: { type: 'integer' },
                sensorsSkipped: {
                  type: 'integer',
                  description: 'Sensors a template named that were already there.',
                },
                mastersSet: {
                  type: 'integer',
                  description:
                    'Devices whose reachability sensor became their master object, so one ' +
                    'unreachable host is one alarm rather than a device’s worth.',
                },
                problems: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['address', 'problem'],
                    properties: { address: { type: 'string' }, problem: { type: 'string' } },
                  },
                },
                devices: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['address', 'deviceId', 'created'],
                    properties: {
                      address: { type: 'string' },
                      deviceId: { type: 'integer' },
                      created: { type: 'boolean' },
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
        if ((await discovery.get(id)) === null) throw notFound(id);
        return provision(id, { kind: 'anonymous', remoteAddress: request.ip });
      },
    );
  }

  app.get(
    '/discovery/:id/problems',
    {
      schema: {
        tags: ['discovery'],
        summary: 'What a run could not create, and why',
        params: idParams,
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
                  required: ['address', 'problem'],
                  properties: { address: { type: 'string' }, problem: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest) => {
      const { id } = request.params as { id: number };
      return { items: await discovery.problems(id) };
    },
  );

  app.get(
    '/objects/:id/discovery',
    {
      schema: {
        tags: ['discovery'],
        summary: 'What this group has been discovering, newest first',
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: { $ref: 'ms:discoveryRun' } } },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: number };
      const { limit } = request.query as { limit?: number };
      return { items: await discovery.list(id, limit ?? 25) };
    },
  );
}

/** The parser's own sentence reaches the operator, rather than "invalid range". */
function parse(text: string): ReturnType<typeof parseIpRange> {
  try {
    return parseIpRange(text);
  } catch (error) {
    if (error instanceof IpRangeError) {
      throw new DiscoveryError('DISCOVERY_RANGE_INVALID', error.message, {
        context: { range: text },
      });
    }
    throw error;
  }
}

function notFound(id: number): DiscoveryError {
  return new DiscoveryError('DISCOVERY_RUN_NOT_FOUND', `there is no discovery run ${String(id)}`, {
    context: { id },
  });
}
