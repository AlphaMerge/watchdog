// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../db/pool.js';
import { readSensorState } from '../../state/runtime.js';
import { PAUSE_SOURCES } from '../../state/tables.js';
import { notFound } from '../../objects/errors.js';

export interface StateRoutesOptions {
  db: Database;
}

const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
} as const;

/**
 * What a sensor is right now (`M-02`).
 *
 * Separate from `GET /objects/:id` on purpose. That read is conditional — its ETag is built
 * from configuration versions — and a fact that changes on every scan would either be served
 * stale behind a 304 or force the validator to move once a minute for every sensor, which would
 * also push a fresh configuration to every probe (`R-04` diffs on exactly those versions).
 * Listings carry `state` for colouring a tree; this is the whole answer for one sensor, and
 * `U-02` will stream the same shape.
 */
export function stateRoutes(app: FastifyInstance, options: StateRoutesOptions): void {
  const { db } = options;

  app.get<{ Params: { id: number } }>(
    '/sensors/:id/state',
    {
      schema: {
        description:
          'A sensor’s current state, why it is in it, and since when. `pausedBy` lists every ' +
          'pause source holding the sensor, not only the one `cause` reports: the four are an ' +
          'independent set, so clearing the reported one does not necessarily resume it.',
        params: idParams,
        response: { 200: { $ref: 'ms:sensorState' } },
      },
    },
    async (request, reply) => {
      const runtime = await readSensorState(db, request.params.id);
      if (runtime === null) throw notFound(request.params.id);

      // Never cached: this is the one thing on the API that changes on its own.
      void reply.header('cache-control', 'no-store');

      const { facts } = runtime;
      return {
        sensorId: runtime.sensorId,
        state: runtime.state,
        cause: runtime.cause,
        message: runtime.message,
        since: runtime.since.toISOString(),
        lastResultAt: facts.lastResultAt?.toISOString() ?? null,
        consecutiveFailures: facts.scan.kind === 'failed' ? facts.scan.consecutiveFailures : 0,
        pausedBy: PAUSE_SOURCES.filter((source) => facts.pause[source]),
        acknowledged: facts.acknowledged,
        acknowledgedUntil: facts.acknowledgedUntil?.toISOString() ?? null,
        // Who silenced the alarm (`M-13`). On the state read rather than only in the audit log,
        // for the reason the pause view carries an actor: an operator looking at a red sensor
        // that is not paging anybody should not have to go searching for who decided that.
        acknowledgedBy: runtime.acknowledgedBy ?? null,
        simulatedError: facts.simulatedError,
      };
    },
  );
}
