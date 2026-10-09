// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import { CORE_HEALTH_CHANNELS, PROBE_HEALTH_CHANNELS } from '@ms/sensors';
import { AppError, versionFor } from '@ms/shared';
import type { FastifyInstance } from 'fastify';
import type { CoreHealthService } from '../../health/core-health.js';
import {
  PROBE_NUMBERS_UNAVAILABLE,
  withLastRefusal,
  type ProbeHealthService,
} from '../../health/probe-health.js';
import { toHttpError } from '../errors.js';
import { INSTALLATION, onObject } from '../authorization.js';

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
      // The installation's own numbers, so the installation's bar (`A-12`).
      config: INSTALLATION,
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
      // **Degraded rather than refused** (`P-126`). An unreachable database used to throw out of
      // here and answer 500, which loses the CPU, the memory and the ingest queue as well — none
      // of which need a database — at the exact moment an operator most needs to know how the
      // core is. The four database-backed channels come back as gaps instead, which is what a
      // channel that could not be measured is everywhere else in this system.
      return { at: new Date().toISOString(), channels: await service.read(undefined, true) };
    },
  );

  const probeHealth = options.probeHealth;
  if (probeHealth === undefined) return;

  app.get<{ Params: { id: number } }>(
    '/probes/:id/health',
    {
      // One probe's numbers and message, so a right on that probe (`A-12`). A role check let an
      // account granted one branch read the connection state of every probe by id.
      config: onObject('read'),
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
          'message says so in words rather than leaving the channels silently absent, and it ' +
          'names the last hello refused over the version, with `lastProtocolRefusedAt` as its ' +
          'time, whenever that is set. ' +
          '`numbersUnavailable` says why the probe’s own numbers are gaps, as a value: ' +
          '`not-connected`; `protocol`, the only reason that is about versions, with the ' +
          'version it speaks and the one its numbers need; `no-heartbeat`, connected and none ' +
          'arrived yet, with how long it has been connected; `not-reported`, heartbeats that ' +
          'carry none. `null` when it reported them. `protocolVersion` is the version the probe ' +
          'speaks on its current connection, `null` when it is not connected: a probe that ' +
          'reports, below the version a channel arrived in, leaves that channel a gap whether ' +
          'or not what it counts is running. `lastProtocolVersion` is the version the probe ' +
          'declared at the last handshake the core recorded, kept after it disconnects: the ' +
          'one `GET /probes` shows, said of that connection and not of the probe now, which may ' +
          'have been upgraded since. `null` when none is recorded or the database could not be ' +
          'asked. `lastProtocolVersionAt` is when a handshake the core accepted spoke that ' +
          'version, as ISO 8601: not when the probe was last seen, which a refused hello moves ' +
          'too. `null` whenever `lastProtocolVersion` is, beside a version a hello was refused ' +
          'over, and for one recorded before the core kept the time. ' +
          '`lastProtocolRefusedAt` is when a hello was last refused over that version, as ISO ' +
          '8601: the probe has not connected since, and a core with the same floor will refuse ' +
          'it again. Never beside `lastProtocolVersionAt`, and `null` whenever ' +
          '`lastProtocolVersion` is, beside an accepted version, and for one recorded before the ' +
          'core kept the time. A `lastProtocolVersion` of 0 is served only beside it: a 0 ' +
          'without it is nothing recorded, and is `null`.',
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
            required: [
              'at',
              'probeId',
              'message',
              'numbersUnavailable',
              'protocolVersion',
              'lastProtocolVersion',
              'lastProtocolVersionAt',
              'lastProtocolRefusedAt',
              'channels',
            ],
            properties: {
              at: { type: 'string' },
              probeId: { type: 'integer' },
              message: { type: 'string' },
              // `P-255`. Flat rather than a `oneOf` per reason: each field below belongs to one
              // reason and is absent from the others, which the type in `probe-health.ts` says.
              numbersUnavailable: {
                type: ['object', 'null'],
                additionalProperties: false,
                required: ['reason'],
                properties: {
                  reason: { type: 'string', enum: [...PROBE_NUMBERS_UNAVAILABLE] },
                  protocolVersion: { type: 'integer' },
                  requiredVersion: { type: 'integer' },
                  connectedSeconds: { type: 'integer' },
                },
              },
              // `U-30`. The add-sensor form needs it to tell a listener that is off from a probe
              // too old to report one. The version alone, under the same `read` right: the
              // `protocol` channel and the message already turn on it, and a skewed probe's
              // message names it. Nothing else about the link comes with it.
              protocolVersion: { type: ['integer', 'null'] },
              // `U-31`. What a probe that is down last spoke, so the form can say it was too old
              // for a listener then. The one integer from the registration row, under the same
              // `read` right: never its address, its filter or its key (`lastProtocolVersion`).
              lastProtocolVersion: { type: ['integer', 'null'] },
              // `U-32`. When that version was accepted, so the form can say when the probe last
              // connected. The registry's own column beside the version, not `last_seen_at`.
              lastProtocolVersionAt: { type: ['string', 'null'], format: 'date-time' },
              // `U-35`. When a hello was refused over that version, so the form can say the probe
              // will be refused again, and a refusal at 0 is not read as nothing recorded. The
              // registry's own column, read with the version, under the same `read` right.
              lastProtocolRefusedAt: { type: ['string', 'null'], format: 'date-time' },
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
      const { reading, message, unavailable, protocolVersion } = service.read(request.params.id);
      const last = await service.lastProtocol(request.params.id);
      return {
        at: new Date().toISOString(),
        probeId: request.params.id,
        // `P-317`: the sentence names a recorded refusal, which the probe's link cannot know.
        message: withLastRefusal(message, last),
        numbersUnavailable: unavailable,
        protocolVersion,
        lastProtocolVersion: last.version,
        lastProtocolVersionAt: last.at,
        lastProtocolRefusedAt: last.refusedAt,
        channels: reading,
      };
    },
  );
}
