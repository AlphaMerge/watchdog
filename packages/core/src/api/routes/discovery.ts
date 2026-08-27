// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { IpRangeError, parseIpRange } from '@ms/shared';
import { DiscoveryError } from '../../discovery/errors.js';
import type { DiscoveryService } from '../../discovery/service.js';

export interface DiscoveryRouteOptions {
  discovery: DiscoveryService;
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
    status: { type: 'string', enum: ['queued', 'running', 'done', 'cancelled', 'failed'] },
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
        summary: 'What a range means, before starting a run',
        description:
          'Parses a range and reports its size and a time estimate. The same parser the run ' +
          'uses, so a range that previews is a range that will start.',
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
            required: ['range', 'total', 'estimateSeconds'],
            properties: {
              range: { type: 'string' },
              total: { type: 'integer' },
              estimateSeconds: { type: 'integer' },
            },
          },
        },
      },
    },
    (request: FastifyRequest) => {
      const body = request.body as { range: string; timeoutMs?: number; concurrency?: number };
      const range = parse(body.range);
      const timeoutMs = body.timeoutMs ?? 1_000;
      const concurrency = body.concurrency ?? 32;
      return {
        range: range.text,
        total: range.size,
        // The worst case, deliberately: every address timing out is what a sweep of an empty
        // range costs, and it is the number that stops somebody starting a /16 at 16:55 on a
        // Friday. A range that is mostly alive finishes far sooner, which is a pleasant surprise
        // rather than a broken promise.
        estimateSeconds: Math.ceil((range.size * timeoutMs) / concurrency / 1_000),
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
