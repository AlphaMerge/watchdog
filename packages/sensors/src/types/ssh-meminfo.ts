import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { sshParamsSchema } from '../support/ssh/schema.js';

/**
 * Memory over SSH, from `/proc/meminfo` (`T-08`).
 *
 * **Here the kernel's own `MemAvailable` is simply there for the asking**, which is the whole
 * difference from `snmp.memory`. That type has to work for it: net-snmp's UCD-MIB exposes
 * `MemFree` under a name that sounds like availability, and the measured gap on one 7936 MiB box
 * was 2819 MiB against a true 5169 MiB — the difference between reporting 64% used and 35%. Over
 * SSH the kernel answers the right question directly, so this is the sensor to prefer on a Linux
 * host that has both.
 *
 * `MemAvailable` has been in `/proc/meminfo` since Linux 3.14. Older kernels fall back to
 * free + buffers + cached, which is the same approximation `snmp.memory` makes, and the message
 * says which was used — the two are not interchangeable and an operator comparing two hosts
 * needs to know.
 */
export const sshMeminfo: SensorType = {
  id: 'ssh.meminfo',
  category: 'SSH',
  costHint: 'medium',
  credentialKinds: ['ssh'],

  paramsSchema: sshParamsSchema({}, []),

  channels(): readonly ChannelDef[] {
    return [
      { key: 'percentUsed', name: 'Memory used', unit: '%', isPrimary: true },
      { key: 'available', name: 'Available memory', unit: 'B' },
      { key: 'used', name: 'Used memory', unit: 'B' },
      { key: 'total', name: 'Total memory', unit: 'B' },
      { key: 'swapPercentUsed', name: 'Swap used', unit: '%' },
      { key: 'swapAvailable', name: 'Available swap', unit: 'B' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { sshCheck, hostKeyNote, parseMeminfo, clip } = await import('../support/ssh/index.js');
    const { percentOf, humanBytes } = await import('../support/snmp/mibs.js');

    return sshCheck(context, async (session, signal) => {
      const result = await session.exec('cat /proc/meminfo', signal);
      if (result.code !== 0) {
        throw new Error(
          `${context.target.host} could not read /proc/meminfo: ` +
            clip(result.stderr.trim() === '' ? result.stdout : result.stderr) +
            ' — this sensor is for a Linux host; use SSH Script elsewhere',
        );
      }

      const values = parseMeminfo(result.stdout);
      const total = values.get('MemTotal');
      if (total === undefined || total <= 0) {
        throw new Error(
          `/proc/meminfo on ${context.target.host} had no MemTotal — its output was ` +
            `"${clip(result.stdout)}"`,
        );
      }

      let available = values.get('MemAvailable');
      let source = 'MemAvailable';
      if (available === undefined) {
        // Linux before 3.14. The same approximation `snmp.memory` is forced into, and it reads
        // a few per cent high — said out loud rather than presented as the same number.
        available =
          (values.get('MemFree') ?? 0) + (values.get('Buffers') ?? 0) + (values.get('Cached') ?? 0);
        source = 'MemFree + Buffers + Cached, because this kernel has no MemAvailable';
      }

      const used = Math.max(0, total - available);
      const percentUsed = percentOf(used, total);

      const swapTotal = values.get('SwapTotal');
      const swapFree = values.get('SwapFree');
      const swapPercent =
        swapTotal === undefined || swapFree === undefined || swapTotal <= 0
          ? null
          : percentOf(swapTotal - swapFree, swapTotal);

      return {
        channels: [
          ...(percentUsed === null ? [] : [{ key: 'percentUsed', value: percentUsed }]),
          { key: 'available', value: available },
          { key: 'used', value: used },
          { key: 'total', value: total },
          // Gapped rather than zeroed on a host with no swap: 0% used swap and "there is no
          // swap" are different facts, and only one of them is reassuring.
          ...(swapPercent === null ? [] : [{ key: 'swapPercentUsed', value: swapPercent }]),
          ...(swapFree === undefined ? [] : [{ key: 'swapAvailable', value: swapFree }]),
        ],
        message: [
          `${humanBytes(used)} of ${humanBytes(total)} used (${String(percentUsed ?? 0)}%), ` +
            `${humanBytes(available)} available from ${source}`,
          hostKeyNote(session, context.target.host),
        ]
          .filter((part): part is string => part !== null)
          .join('; '),
      };
    });
  },
};
