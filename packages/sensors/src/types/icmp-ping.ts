import type { CheckContext, CheckExecution, SensorType } from '../contract.js';
import {
  duplicatesNote,
  parsePingOutput,
  pingCommand,
  pingPlatform,
  runPing,
  summarise,
  type PingParams,
} from '../support/ping.js';

/**
 * ICMP ping (`P-08`) — the most-used sensor type there is.
 *
 * Runs the system `ping` binary (ADR-001: no privileges, correct everywhere). The optional
 * raw-socket fast path is `P-07`'s to justify with a measurement at 1,000 targets; nothing here
 * assumes it will not exist, which is why the spawning is behind `runPing` and the parsing is
 * pure.
 *
 * **Two channels, not the three the task names.** Availability would be a channel that can only
 * ever hold one value: a run with no replies has no round-trip time to report, so it throws, and
 * CLAUDE.md is explicit that a Down sensor records *no* channel values. An availability channel
 * would therefore read 100 on every sample it ever had — a line on a graph that cannot move, and
 * a limit nobody can usefully set. `loss` already carries the information.
 */
export const icmpPing: SensorType = {
  id: 'icmp.ping',
  category: 'Availability',
  // Not 'light': this spawns a process per check. At 5,000 sensors on a one-minute interval
  // that is 5,000 processes a minute, and whether that holds is exactly what P-07 measures.
  costHint: 'medium',

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      count: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        default: 4,
        title: 'Packets',
        description:
          'ICMP echo requests per check. At the default spacing of 0.2 s, a count of 4 takes ' +
          'about six-tenths of a second.',
      },
      intervalSeconds: {
        type: 'number',
        minimum: 0.2,
        maximum: 10,
        default: 0.2,
        title: 'Seconds between packets',
        description:
          'Ping’s own default is one second, which makes a four-packet check a three-second ' +
          'check — measured, that is 20 targets a second across 64 workers where 0.2 s gives ' +
          '99, with identical reply counts (`P-07`). 0.2 is the floor: below it iputils needs ' +
          'CAP_NET_RAW and BSD needs the superuser. Windows has no such flag and ignores this.',
      },
      packetSize: {
        type: 'integer',
        minimum: 8,
        maximum: 65_500,
        default: 32,
        title: 'Payload size',
        description: 'Bytes of payload per packet, before the ICMP and IP headers.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 100,
        maximum: 60_000,
        default: 5_000,
        title: 'Timeout',
        description: 'Overall deadline for the whole run, in milliseconds.',
      },
    },
  },

  // Every reading is keyed by a channel `channels()` names, on every path: a channel a later
  // build drops is retired (`P-320`).
  declaresEveryChannel: true,

  channels() {
    return [
      { key: 'rtt', name: 'Response time', unit: 'ms', isPrimary: true },
      { key: 'loss', name: 'Packet loss', unit: '%' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const params: PingParams = {
      count: Number(context.params['count'] ?? 4),
      packetSize: Number(context.params['packetSize'] ?? 32),
      timeoutMs: Number(context.params['timeoutMs'] ?? 5_000),
      intervalSeconds: Number(context.params['intervalSeconds'] ?? 0.2),
    };

    const host = context.target.host;
    if (host === '') {
      throw new Error('the device has no host to ping');
    }

    const { command, args } = pingCommand(pingPlatform(process.platform), context.target, params);
    const run = await runPing(command, args, context.signal);
    const outcome = parsePingOutput(run.output, params.count);

    if (outcome.times.length === 0) {
      // Unreachable is a failed check, not a successful measurement of nothing: there is no
      // round-trip time, and inventing one for the primary channel would be a lie a graph
      // cannot distinguish from a fast reply. The message carries the target and the counts,
      // because "ETIMEDOUT" alone is not a diagnosis (CLAUDE.md).
      throw new Error(
        `no ICMP reply from ${host} (${String(outcome.transmitted)} sent, 0 replies)` +
          (run.detail === '' ? '' : `: ${run.detail}`),
      );
    }

    const stats = summarise(outcome);
    return {
      channels: [
        { key: 'rtt', value: stats.rttMs, name: 'Response time', unit: 'ms' },
        { key: 'loss', value: stats.lossPercent, name: 'Packet loss', unit: '%' },
      ],
      message:
        `${String(outcome.times.length)}/${String(outcome.transmitted)} replies, ` +
        `min ${stats.minMs.toFixed(3)} ms, avg ${stats.rttMs.toFixed(3)} ms, ` +
        `max ${stats.maxMs.toFixed(3)} ms${duplicatesNote(outcome)}`,
    };
  },
};
