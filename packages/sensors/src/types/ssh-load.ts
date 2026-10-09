import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { scrubberOf } from '../support/secrets.js';
import { sshParamsSchema } from '../support/ssh/schema.js';

/**
 * Load average over SSH (`T-08`).
 *
 * **Load average is not CPU usage, and the per-processor channel is what makes it readable.**
 * A load of 4 is idle on a 32-core box and desperate on a single-core one, so the raw figure
 * cannot carry a threshold that means the same thing on two machines. The processor count comes
 * back in the same command — one round trip — and `loadPerCpu` is the channel worth setting a
 * limit on: above 1 the run queue is longer than the machine can serve.
 *
 * `/proc/loadavg` first and `uptime` as the fallback, because the same sensor is worth pointing
 * at a BSD or a macOS host, and `uptime`'s output is prose that some locales write with commas
 * for decimal points.
 */
export const sshLoad: SensorType = {
  id: 'ssh.load',
  category: 'SSH',
  costHint: 'medium',
  credentialKinds: ['ssh'],
  pinnedKinds: ['ssh'],
  // Where the set goes besides the host (`A-41`): the port.
  secretDestinations: { 'kind:ssh': ['port'] },

  paramsSchema: sshParamsSchema({}, []),

  // Every reading is keyed by a channel `channels()` names, on every path: a channel a later
  // build drops is retired (`P-320`).
  declaresEveryChannel: true,

  channels(): readonly ChannelDef[] {
    return [
      // The per-processor figure is primary rather than the raw one-minute average: it is the
      // only one of the four that means the same thing on two differently-sized machines.
      { key: 'loadPerCpu', name: 'Load per processor', unit: '', isPrimary: true },
      { key: 'load1', name: 'Load average (1 min)', unit: '' },
      { key: 'load5', name: 'Load average (5 min)', unit: '' },
      { key: 'load15', name: 'Load average (15 min)', unit: '' },
      { key: 'processors', name: 'Processors', unit: '' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const scrub = scrubberOf(context);
    const { sshCheck, hostKeyNote, parseLoadAverage, clip } =
      await import('../support/ssh/index.js');

    return sshCheck(context, async (session, signal) => {
      // One round trip for both facts. `||` rather than `;` on the first: a host without
      // /proc/loadavg should fall through to uptime, not report an error and stop.
      const result = await session.exec(
        '(cat /proc/loadavg 2>/dev/null || uptime); (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo)',
        signal,
      );

      const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
      const load = parseLoadAverage(lines.slice(0, -1).join('\n') || result.stdout);
      if (load === null) {
        throw new Error(
          `${context.target.host} reported no load average — neither /proc/loadavg nor uptime ` +
            `gave one. Its output was "${clip(scrub(result.stdout))}"`,
        );
      }

      const last = lines[lines.length - 1] ?? '';
      const processors = /^\d+$/.test(last.trim()) ? Number(last.trim()) : null;
      const perCpu =
        processors !== null && processors > 0
          ? Math.round((load.one / processors) * 100) / 100
          : null;

      return {
        channels: [
          // Gapped rather than falling back to the raw figure: a per-processor load that is
          // secretly the whole-machine one is a number somebody would set a limit against.
          ...(perCpu === null ? [] : [{ key: 'loadPerCpu', value: perCpu }]),
          { key: 'load1', value: load.one },
          { key: 'load5', value: load.five },
          { key: 'load15', value: load.fifteen },
          ...(processors === null ? [] : [{ key: 'processors', value: processors }]),
        ],
        message: [
          `${String(load.one)} ${String(load.five)} ${String(load.fifteen)}` +
            (processors === null
              ? '; this host did not report a processor count, so there is no per-processor figure'
              : ` across ${String(processors)} processors (${String(perCpu ?? 0)} each)`),
          hostKeyNote(session, context.target.host),
        ]
          .filter((part): part is string => part !== null)
          .join('; '),
      };
    });
  },
};
