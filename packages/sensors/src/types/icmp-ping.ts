import type { CheckContext, CheckExecution, SensorType } from '../contract.js';
import {
  parsePingOutput,
  pingCommand,
  pingPlatform,
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
          'ICMP echo requests per check. Ping waits about a second between packets, so a ' +
          'count of 4 takes roughly three seconds.',
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
        `max ${stats.maxMs.toFixed(3)} ms`,
    };
  },
};

interface PingRun {
  readonly output: string;
  /** Something worth adding to a failure message: stderr, or why the process ended. */
  readonly detail: string;
}

/**
 * Spawns `ping` and collects what it said.
 *
 * A non-zero exit is not an error here: ping exits 1 when nothing replied, which is a perfectly
 * ordinary result that the caller reads out of the output. Only being unable to *run* it is.
 */
async function runPing(
  command: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<PingRun> {
  // Imported here rather than at the top of the module: the core loads this catalogue for
  // schemas and channel declarations and never calls execute, so it should not pay for the
  // module graph behind it (docs/adding-a-sensor-type.md).
  const { spawn } = await import('node:child_process');

  return new Promise<PingRun>((resolve, reject) => {
    // Node kills the process when the signal aborts, which is how this check honours
    // `ctx.signal` without a race of its own.
    const child = spawn(command, [...args], { signal, windowsHide: true });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (signal.aborted) {
        reject(new Error(`the check was cancelled before ${command} finished`));
        return;
      }
      if (error.code === 'ENOENT') {
        // A probe running in a minimal container is the usual cause, and it fails identically
        // on every check until someone installs the binary — so say which binary.
        reject(new Error(`the "${command}" binary is not available on this probe`));
        return;
      }
      reject(new Error(`could not run ${command}: ${error.message}`));
    });

    child.on('close', (code, killSignal) => {
      const detail =
        stderr.trim().split('\n')[0] ??
        (killSignal === null ? `exit ${String(code ?? 'unknown')}` : `killed by ${killSignal}`);
      resolve({ output: `${stdout}\n${stderr}`, detail: stderr.trim() === '' ? '' : detail });
    });
  });
}
