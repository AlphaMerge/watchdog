// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import { CORE_HEALTH_CHANNELS, PROBE_HEALTH_CHANNELS } from '@ms/sensors';
import { AppError, versionFor } from '@ms/shared';
import type { FastifyInstance } from 'fastify';
import type { CoreHealthService } from '../../health/core-health.js';
import type { ProbeHealthService } from '../../health/probe-health.js';
import { toHttpError } from '../errors.js';
import { READS } from '../authorization.js';

export interface HealthRoutesOptions {
  /**
   * Late-bound, because the service is built from the ingestor and the probe endpoint — both of
   * which are constructed after the API so a slow first housekeeping pass cannot delay the port
   * opening. The window is milliseconds; answering honestly during it beats pretending.
   */
  coreHealth: () => CoreHealthService | undefined;
  /** Late-bound for the same reason, and built after the probe endpoint it reads (`P-13`). */
  probeHealth?: () => ProbeHealthService | undefined;
}

/**
 * The core's own numbers, live (`P-12`).
 *
 * **Served whether or not a Core Health sensor exists**, and that is the point of having a route
 * at all rather than only channels. Two reasons, and the second is the one that matters:
 *
 * 1. An operator must be able to ask how the core is on a fresh installation, before anyone has
 *    added a sensor to anything.
 * 2. **A sensor's reading is a row.** `WORKFLOW.MD §13` says Core Health goes Down when the
 *    database is unavailable, and a sensor cannot report that while it is happening — there is
 *    nowhere to write the reading or the state. Most of this answer needs no database at all, so
 *    this route keeps working when the sensor cannot.
 */
export function healthRoutes(app: FastifyInstance, options: HealthRoutesOptions): void {
  const channelProperties: Record<string, { type: ['number', 'null'] }> = {};
  for (const key of CORE_HEALTH_CHANNELS) channelProperties[key] = { type: ['number', 'null'] };

  const probeProperties: Record<string, { type: ['number', 'null'] }> = {};
  for (const key of PROBE_HEALTH_CHANNELS) probeProperties[key] = { type: ['number', 'null'] };

  app.get(
    '/core-health',
    {
      config: READS,
      schema: {
        tags: ['health'],
        summary: 'How the core itself is doing, right now',
        description:
          'The same numbers the Core Health sensor records, read live. **A `null` is a gap and ' +
          'never a zero** — CPU is null on the first reading after a start because it is a rate ' +
          'and there is nothing to measure against yet, and a rollup tier that has never run is ' +
          'not a tier that is infinitely behind. `rollupLag` is the excess over a tier’s own ' +
          'bucket width, so a healthy daily tier reads 0 rather than 86,400.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['at', 'channels'],
            properties: {
              at: { type: 'string' },
              channels: {
                type: 'object',
                additionalProperties: false,
                properties: channelProperties,
              },
            },
          },
          // Declared rather than left to fall out of the schema, because an undeclared status is
          // stripped to nothing by `additionalProperties: false` on the way out.
          503: { $ref: 'ms:error' },
        },
      },
    },
    async (request, reply) => {
      const service = options.coreHealth();
      if (service === undefined) {
        // 503 rather than an empty answer. "The core is starting" and "every number is zero"
        // are different facts, and a monitoring system may not confuse them about itself.
        const mapped = toHttpError(
          new AppError('CORE_STARTING', 'the core is still starting; ask again in a moment'),
          request.id,
        );
        await reply.status(503).send(mapped.body);
        return reply;
      }
      return { at: new Date().toISOString(), channels: await service.read() };
    },
  );

  const probeHealth = options.probeHealth;
  if (probeHealth === undefined) return;

  app.get<{ Params: { id: number } }>(
    '/probes/:id/health',
    {
      config: READS,
      schema: {
        tags: ['health'],
        summary: 'How one probe is doing, right now',
        description:
          '**Answers for a probe that is not connected**, which is the whole reason Probe Health ' +
          'is evaluated by the core: a probe cannot report its own absence. `connected` is 0 ' +
          'then and every other channel is `null` — a gap, because the probe’s numbers are not ' +
          'zero, they are unknown, and a scheduler lag of 0 ms from a probe that is gone would ' +
          'be the most misleading reading this system could produce. A probe below protocol ' +
          `${String(versionFor('healthReporting'))} cannot send its own numbers either; the ` +
          'message says so in words rather than leaving the channels silently absent.',
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'integer', minimum: 1 } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['at', 'probeId', 'message', 'channels'],
            properties: {
              at: { type: 'string' },
              probeId: { type: 'integer' },
              message: { type: 'string' },
              channels: {
                type: 'object',
                additionalProperties: false,
                properties: probeProperties,
              },
            },
          },
          503: { $ref: 'ms:error' },
        },
      },
    },
    async (request, reply) => {
      const service = probeHealth();
      if (service === undefined) {
        const mapped = toHttpError(
          new AppError('CORE_STARTING', 'the core is still starting; ask again in a moment'),
          request.id,
        );
        await reply.status(503).send(mapped.body);
        return reply;
      }
      const { reading, message } = service.read(request.params.id);
      return {
        at: new Date().toISOString(),
        probeId: request.params.id,
        message,
        channels: reading,
      };
    },
  );
}
