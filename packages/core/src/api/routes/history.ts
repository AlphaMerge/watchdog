// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import type { ObjectService } from '../../objects/service.js';
import type { ChannelValue, HistoryService, SensorValues } from '../../timeseries/history.js';
import { onObject } from '../authorization.js';
import {
  ALLOWED_RESOLUTIONS,
  FORCED_AVERAGING_FROM_DAYS,
  FORCED_AVERAGING_MIN_SECONDS,
  MAX_RANGE_DAYS,
  SHORTENED_RANGE_DAYS,
} from '../../timeseries/query.js';

export interface HistoryRoutesOptions {
  history: HistoryService;
  /** Where a channel's `retired` is worked out (`P-310`, `P-322`), for `/values` to carry it. */
  objects: Pick<ObjectService, 'channels'>;
}

/** `GET /sensors/:id/values`: each channel's reading, and whether it is retired (`U-38`). */
export interface SensorValuesAnswer extends Omit<SensorValues, 'channels'> {
  channels: (ChannelValue & { retired: boolean })[];
}

/** The sensor detail page's first tab (CAPABILITIES.MD §8) — two days, when nothing is asked. */
const DEFAULT_RANGE_MS = 2 * 86_400_000;

const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
} as const;

const historyQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // Parsed rather than format-validated: the planner already refuses an unparseable or
    // inverted range with a message naming the value, and one rejection path is easier to trust
    // than two that can disagree.
    from: { type: 'string', maxLength: 64 },
    to: { type: 'string', maxLength: 64 },
    resolutionSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 86_400,
    },
  },
} as const;

interface HistoryQuery {
  from?: string;
  to?: string;
  resolutionSeconds?: number;
}

export async function historyRoutes(
  app: FastifyInstance,
  options: HistoryRoutesOptions,
): Promise<void> {
  const { history, objects } = options;

  app.get<{ Params: { id: number } }>(
    '/sensors/:id/values',
    {
      config: onObject('read'),
      schema: {
        tags: ['sensors'],
        description:
          "Each channel's current reading, for a sensor detail page's channel table. " +
          'A `null` value means no reading inside the window, which is a gap and never a zero: ' +
          'the window is three scan intervals (at least a minute), so a sensor that has stopped ' +
          'reporting shows nothing rather than its last healthy figure dressed as current. ' +
          '`at` is when the reading shown was actually taken. `retired` is the channel list’s ' +
          '(`GET /objects/{id}/channels`), worked out by the same query on every read.',
        params: idParams,
        response: { 200: { $ref: 'ms:sensorValues' } },
      },
    },
    async (request): Promise<SensorValuesAnswer> => {
      // The readings first: a sensor that does not exist, or an object that is not a sensor, is
      // the 404 this route has always answered, not the channel list's own refusal.
      const values = await history.latestForSensor(request.params.id);
      // `retired` is not reimplemented here: it is the channel list's, from the one query that
      // derives it (`ObjectRepository.channelsWithRetirement`). A channel created between the two
      // reads is absent from the list and answers `false`, which is what `false` already means:
      // not known to be retired.
      const retired = new Set(
        (await objects.channels(request.params.id))
          .filter((channel) => channel.retired)
          .map((channel) => channel.id),
      );
      return {
        ...values,
        channels: values.channels.map((channel) => ({
          ...channel,
          retired: retired.has(channel.id),
        })),
      };
    },
  );

  app.get<{ Params: { id: number }; Querystring: HistoryQuery }>(
    '/sensors/:id/history',
    {
      config: onObject('read'),
      schema: {
        tags: ['sensors'],
        description:
          'Historic channel data for a sensor. The resolution is snapped up to a supported ' +
          `averaging interval (${String(ALLOWED_RESOLUTIONS[0])}s upwards); ranges over ` +
          `${String(MAX_RANGE_DAYS)} days are shortened to ${String(SHORTENED_RANGE_DAYS)}, and ` +
          `ranges of ${String(FORCED_AVERAGING_FROM_DAYS)} days or more are averaged over at ` +
          `least ${String(FORCED_AVERAGING_MIN_SECONDS / 60)} minutes. Everything the rules ` +
          'change is reported in `adjustments`. In `avg`, `min`, `max` and `count`, null is a ' +
          'gap — a period the sensor produced no readings — and never a zero.',
        params: idParams,
        querystring: historyQuery,
        response: { 200: { $ref: 'ms:sensorHistory' } },
      },
    },
    async (request) => {
      const { from, to, resolutionSeconds } = request.query;
      const end = to === undefined ? new Date() : new Date(to);
      const start =
        from === undefined ? new Date(end.getTime() - DEFAULT_RANGE_MS) : new Date(from);

      return history.forSensor(request.params.id, {
        from: start,
        to: end,
        ...(resolutionSeconds === undefined ? {} : { resolutionSeconds }),
      });
    },
  );

  await Promise.resolve();
}
