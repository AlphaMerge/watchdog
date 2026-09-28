import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { ObjectError } from '../../objects/errors.js';
import type { ProbeConfigService } from '../../probes/config.js';
import type { ProbeQueryService } from '../../probes/queries.js';
import { notAudited, onObject } from '../authorization.js';

/**
 * Running one check now, with the request waiting on it (`R-09`).
 *
 * **The whole of what this endpoint is for is telling failures apart.** A sensor that has just
 * been created, or has just been fixed, is Down for one of a handful of reasons — a wrong
 * credential, an unreachable host, a firewall, a typo in a parameter — and the scheduled path
 * answers that question once a minute in a graph. This answers it in a second, in words, without
 * putting anything in the graph.
 */

export interface QueryRoutesOptions {
  queries: ProbeQueryService;
  probeConfig: ProbeConfigService;
}

const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
} as const;

const checkBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    timeoutMs: {
      type: 'integer',
      minimum: 1_000,
      maximum: 120_000,
      description:
        'How long to wait. Bounded well below the sensor’s own timeout allowance because a ' +
        'person is waiting: a check that may run for an hour is not something to hold an HTTP ' +
        'request open for. The probe is told the same number and abandons the work when it ' +
        'expires.',
    },
  },
} as const;

/** How each failure reaches a client. Chosen so the status alone tells a UI what to do. */
const STATUS: Readonly<Record<string, number>> = {
  // The probe is fine and the *request* cannot be served: retry later, and say which.
  offline: 503,
  busy: 503,
  timeout: 504,
  // Nothing about waiting will fix these.
  'too-old': 409,
  unsupported: 409,
  failed: 502,
};

export function queryRoutes(app: FastifyInstance, options: QueryRoutesOptions): void {
  const { queries, probeConfig } = options;

  app.post<{ Params: { id: number }; Body: { timeoutMs?: number } }>(
    '/sensors/:id/check',
    {
      config: {
        ...onObject('write'),
        ...notAudited('runs the check once and returns what it said; no configuration changes'),
      },
      schema: {
        tags: ['sensors'],
        summary: 'Run this sensor’s check now and return what it said',
        description:
          'Asks the probe that owns the sensor to run **exactly** the check a scheduled scan ' +
          'would run — the same parameters, the same credentials, the same target — and hands ' +
          'back the result. **Nothing is stored**: a reading taken outside the schedule is not ' +
          'history, and ten presses of the button would otherwise draw ten spikes into a ' +
          'channel whose interval is a minute. `stored` says so on every response.\n\n' +
          'A check that *fails* is a 200 carrying `outcome: "error"` and the reason, because ' +
          'that is the answer somebody pressed the button to get. The error statuses are for ' +
          'the query failing rather than the check: 503 the probe is not connected or is ' +
          'already running as many of these as it will, 504 it did not answer in time, 409 it ' +
          'is too old to be asked at all.\n\n' +
          'A **paused** sensor can still be checked. A pause stops the monitoring; it does not ' +
          'stop an operator asking whether the thing they just fixed is working, which is ' +
          'exactly when a sensor is most likely to be paused.',
        params: idParams,
        body: checkBody,
        response: { 200: { $ref: 'ms:checkResult' } },
      },
    },
    async (request, reply) => {
      const sensorId = request.params.id;
      const found = await probeConfig.assignmentFor(sensorId);
      if (found === null) {
        throw new ObjectError(
          'OBJECT_NOT_FOUND',
          'no such sensor, or it has no probe to ask — a core-evaluated sensor is computed ' +
            'here rather than run anywhere',
          { context: { objectId: sensorId, phase: 'check-now' } },
        );
      }

      const outcome = await queries.ask(
        found.probeObjectId,
        { kind: 'check', assignment: found.assignment },
        ...(request.body.timeoutMs === undefined ? [] : [{ timeoutMs: request.body.timeoutMs }]),
      );

      if (outcome.kind === 'failed') {
        // The failure is named in the code as well as the message, so a client can act on it
        // without parsing English — `too-old` puts an upgrade prompt on the screen where
        // `offline` puts a retry.
        await reply.code(STATUS[outcome.failure] ?? 502).send({
          error: {
            code: `PROBE_QUERY_${outcome.failure.replace('-', '_').toUpperCase()}`,
            message: outcome.message,
            context: { objectId: sensorId, probeObjectId: found.probeObjectId },
            details: {},
            correlationId: request.id,
          },
        });
        return reply;
      }

      return { ...outcome.result, sensorId, stored: false };
    },
  );
}
