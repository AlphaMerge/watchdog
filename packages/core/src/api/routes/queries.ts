import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { ObjectError } from '../../objects/errors.js';
import type { ProbeConfigService } from '../../probes/config.js';
import {
  PROBE_NOT_CONNECTED,
  type ProbeQueryService,
  type QueryOutcome,
} from '../../probes/queries.js';
import type { Queryable } from '../../db/pool.js';
import { notAudited, onObject, visibilityOf } from '../authorization.js';

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
  /** For asking whether the caller can see the probe a failure is about (`A-77`). */
  db: Queryable;
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
          'is too old to be asked at all — or, as `OBJECT_CREDENTIALS_WITHHELD`, the sensor is ' +
          'not being sent its credentials because nobody who may still write where they are ' +
          'stored vouches for where it sends them (`A-41`); the message says what fixes it.\n\n' +
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
      // Decided against the probe on the line now, not the one last registered (`A-41c`).
      const found = await probeConfig.assignmentFor(sensorId, (probeObjectId) =>
        queries.peerVersion(probeObjectId),
      );
      if (found === null) {
        throw new ObjectError(
          'OBJECT_NOT_FOUND',
          'no such sensor, or it has no probe to ask — a core-evaluated sensor is computed ' +
            'here rather than run anywhere',
          { context: { objectId: sensorId, phase: 'check-now' } },
        );
      }

      // **Nobody on the line is `offline`, whatever the sensor's credentials would need of a
      // probe** (`A-52`). Said here, before anything is asked: no assignment was built, and the
      // answer is the one a query with no session to go to gets, in the same words and under the
      // same code, so a client puts up a retry and not an upgrade prompt.
      const outcome: QueryOutcome =
        found.assignment === null
          ? { kind: 'failed', failure: 'offline', message: PROBE_NOT_CONNECTED }
          : await queries.ask(
              found.probeObjectId,
              { kind: 'check', assignment: found.assignment },
              {
                // And sent only to a session that still speaks it: a probe that reconnected older
                // in between is not handed what was decided for the newer one.
                peerVersion: found.peerVersion,
                ...(request.body.timeoutMs === undefined
                  ? {}
                  : { timeoutMs: request.body.timeoutMs }),
              },
            );

      if (outcome.kind === 'failed') {
        // **The probe by id only to a caller who can see it** (`A-77`). A writer granted a
        // branch is not given the probe above it, and its id is the one thing here that would
        // say which object that is. The message says what failed either way.
        const probeId = found.probeObjectId;
        const sees = await visibilityOf(request);
        const shown =
          sees.everything || (await sees.visibleAmong(options.db, [probeId])).has(probeId);
        // The failure is named in the code as well as the message, so a client can act on it
        // without parsing English — `too-old` puts an upgrade prompt on the screen where
        // `offline` puts a retry.
        await reply.code(STATUS[outcome.failure] ?? 502).send({
          error: {
            code: `PROBE_QUERY_${outcome.failure.replace('-', '_').toUpperCase()}`,
            message: outcome.message,
            context: { objectId: sensorId, ...(shown ? { probeObjectId: probeId } : {}) },
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
