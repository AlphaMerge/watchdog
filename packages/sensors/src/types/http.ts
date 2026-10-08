import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { HTTP_COMMON_SCHEMA, httpChannels, runHttp } from './http-shared.js';

/**
 * One HTTP request against the device (`P-09`).
 *
 * **The host comes from the device, never from a URL in the parameters.** A sensor type that
 * asked for a whole URL would let the two disagree, which is how a device gets renamed and half
 * its sensors keep checking the old address (CLAUDE.md). So this takes a scheme, a port and a
 * path, and the host is whatever the device says it is today.
 *
 * **Two timings, because they fail differently.** Time to first byte is connect, TLS and the
 * server thinking; the total adds transferring the body. A page that got slower because a query
 * got slower moves the first, and one that got slower because it got bigger moves only the
 * second — and a single "response time" cannot tell an operator which happened.
 *
 * The plain form: a status, two timings and a size. `http.advanced` adds headers and
 * authentication, `http.content` reads the body. All three share `support/http/request.ts`.
 */
export const httpRequest: SensorType = {
  // Dotted, as the catalogue requires: `T-13` and `T-14` add `http.advanced` and `http.content`
  // beside it.
  id: 'http.request',
  category: 'Web',
  costHint: 'medium',

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...HTTP_COMMON_SCHEMA,
      method: {
        enum: ['GET', 'HEAD'],
        default: 'GET',
        title: 'Method',
        description:
          'HEAD is the cheapest and gives no size to measure. For POST and for custom headers, ' +
          'use HTTP Advanced.',
      },
    },
  },

  // Every reading is keyed by a channel `channels(params)` names for the same parameters, so one
  // an edit no longer names is retired (`P-310`).
  declaresEveryChannel: true,

  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
    return httpChannels(params['method'] !== 'HEAD');
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const method = context.params['method'] === 'HEAD' ? 'HEAD' : 'GET';
    return runHttp(context, { method, headers: {}, body: '', maxBodyBytes: 0 });
  },
};
