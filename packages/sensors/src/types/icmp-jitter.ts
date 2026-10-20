import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';

/**
 * How steady a link is, not just how fast (`T-22`).
 *
 * **Average latency hides the fault this sensor exists to find.** A link answering in 20 ms
 * every time and one alternating between 5 ms and 35 ms have the same average and are not the
 * same link: the second one makes a voice call unusable and a video call worse. Nothing in an
 * ICMP Ping sensor's numbers distinguishes them.
 *
 * **Jitter is RFC 3550's estimator**, which is what RTP reports and what a VoIP engineer already
 * has in their head. A figure that disagreed with every other tool on the network would be
 * argued with rather than acted on.
 *
 * More packets than an ordinary ping, because jitter is a property of the gaps between samples
 * and four gives three of them.
 */
export const icmpJitter: SensorType = {
  id: 'icmp.jitter',
  category: 'Availability',
  costHint: 'medium',

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      count: {
        type: 'integer',
        minimum: 5,
        maximum: 60,
        default: 20,
        title: 'Packets',
        description:
          'Jitter is a property of the *gaps* between replies, so it needs a run of them — five ' +
          'packets give four gaps, which is not much of a sample. At the default spacing of one ' +
          'second, twenty packets take roughly twenty seconds; keep the scan interval well ' +
          'above that.',
      },
      intervalSeconds: {
        type: 'number',
        minimum: 0.2,
        maximum: 10,
        default: 1,
        title: 'Seconds between packets',
        description:
          'One second here, unlike `icmp.ping`’s 0.2, and the difference is deliberate: ' +
          'jitter is a measurement of the network *over time*, and twenty packets spaced 0.2 s ' +
          'apart sample four seconds of it rather than twenty. Congestion that comes and goes on ' +
          'a ten-second cycle is invisible in a four-second window. Lower it to make the check ' +
          'cheaper, knowing that is the trade.',
      },
      packetSize: {
        type: 'integer',
        minimum: 8,
        maximum: 65_500,
        default: 32,
        title: 'Payload size',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1_000,
        maximum: 300_000,
        default: 60_000,
        title: 'Timeout',
        description: 'For the whole run, not per packet.',
      },
    },
  },

  // Every reading is keyed by a channel `channels()` names, on every path: a channel a later
  // build drops is retired (`P-320`).
  declaresEveryChannel: true,

  channels(): readonly ChannelDef[] {
    return [
      // The steadiness, not the speed. An average latency that looks fine can hide a link that
      // is unusable for voice.
      { key: 'jitter', name: 'Jitter', unit: 'ms', isPrimary: true },
      { key: 'rtt', name: 'Response time', unit: 'ms' },
      { key: 'min', name: 'Fastest reply', unit: 'ms' },
      { key: 'max', name: 'Slowest reply', unit: 'ms' },
      { key: 'loss', name: 'Packet loss', unit: '%' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const {
      duplicatesNote,
      pingCommand,
      pingPlatform,
      parsePingOutput,
      summarise,
      jitterOf,
      PingError,
      runPing,
      sentNone,
    } = await import('../support/ping.js');

    const host = context.target.host;
    if (host === '') throw new Error('the device has no host to ping');

    const count = Number(context.params['count'] ?? 20);
    const params = {
      count,
      packetSize: Number(context.params['packetSize'] ?? 32),
      timeoutMs: Number(context.params['timeoutMs'] ?? 60_000),
      intervalSeconds: Number(context.params['intervalSeconds'] ?? 1),
    };

    const { command, args } = pingCommand(pingPlatform(process.platform), context.target, params);
    const run = await runPing(command, args, context.signal, host);
    const outcome = parsePingOutput(run.output, count);

    if (outcome.times.length === 0) {
      // Not the device's silence when ping sent nothing (`P-406`): see `sentNone`.
      throw (
        sentNone(run, host) ??
        new PingError(
          `${host} did not answer any of ${String(outcome.transmitted)} pings — there is no ` +
            'round-trip time to measure the steadiness of',
          { phase: 'echo', host },
        )
      );
    }

    const stats = summarise(outcome);
    const jitter = jitterOf(outcome.times);
    if (jitter === null) {
      // One reply is a round-trip time and not a jitter figure. Reporting zero would say
      // "perfectly stable" about a link that answered once out of twenty.
      throw new PingError(
        `${host} answered only ${String(outcome.times.length)} of ` +
          `${String(outcome.transmitted)} pings — jitter is the variation *between* replies, and ` +
          'one reply has none',
        { phase: 'echo', host },
      );
    }

    return {
      channels: [
        { key: 'jitter', value: jitter },
        { key: 'rtt', value: stats.rttMs },
        { key: 'min', value: stats.minMs },
        { key: 'max', value: stats.maxMs },
        { key: 'loss', value: stats.lossPercent },
      ],
      message:
        `${String(jitter)} ms jitter over ${String(outcome.times.length)} replies ` +
        `(${String(stats.minMs)}–${String(stats.maxMs)} ms, ${String(stats.lossPercent)}% loss` +
        `${duplicatesNote(outcome)})`,
    };
  },
};
