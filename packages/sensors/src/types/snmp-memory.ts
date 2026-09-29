import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { SNMP_SECRET_DESTINATIONS, snmpParamsSchema } from '../support/snmp/schema.js';

/**
 * Memory over SNMP (`T-05`).
 *
 * **"Available memory" has three sources on the same device and they disagree by a factor of
 * two.** Measured on the dev target, an ordinary Linux box with 7936 MiB:
 *
 * ```
 *   hrStorage row "Available memory"        5169 MiB   (Linux MemAvailable)
 *   memAvailReal + memBuffer + memCached    5583 MiB   (the classic approximation, ~8% high)
 *   memAvailReal alone                      2819 MiB   (MemFree — the misleading one)
 * ```
 *
 * The last is what a naive sensor reports, and it would have called this box **64% used** when
 * the true figure is 35%. Every Linux machine under any load looks nearly full by that measure,
 * because the kernel spends free memory on page cache *on purpose* and hands it back on demand.
 * A monitoring system that alarms on it teaches its operators to ignore memory alarms.
 *
 * So the order is: net-snmp's own `MemAvailable` row where it exists, then free+buffers+cached,
 * then MemFree with the caveat in the message. The sensor always says which it used, because the
 * three are not interchangeable and an operator comparing two devices needs to know.
 *
 * Swap is a second pair of channels rather than folded into the first: swap filling up is a
 * different fault from RAM filling up, and adding them together hides both.
 */
export const snmpMemory: SensorType = {
  id: 'snmp.memory',
  category: 'SNMP',
  costHint: 'medium',
  secretDestinations: SNMP_SECRET_DESTINATIONS,
  credentialKinds: ['snmp'],

  paramsSchema: snmpParamsSchema(
    {
      countCacheAsAvailable: {
        type: 'boolean',
        default: true,
        title: 'Count cache as available',
        description:
          'On by default, and it is the difference between a Linux box reading 35% used and the ' +
          'same box reading 64%. The kernel spends free memory on page cache deliberately and ' +
          'returns it under pressure, so cache is available memory. Turn this off only for a ' +
          'device where reclaiming the cache is genuinely not free.',
      },
    },
    [],
  ),

  channels(): readonly ChannelDef[] {
    return [
      { key: 'percentUsed', name: 'Memory used', unit: '%', isPrimary: true },
      { key: 'available', name: 'Available memory', unit: 'B' },
      { key: 'used', name: 'Used memory', unit: 'B' },
      { key: 'total', name: 'Total memory', unit: 'B' },
      // Separate, because swap filling is a different fault from RAM filling.
      { key: 'swapPercentUsed', name: 'Swap used', unit: '%' },
      { key: 'swapAvailable', name: 'Available swap', unit: 'B' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { snmpCheck, numberOf, isException, UCD, storageRows, storageAt, percentOf, humanBytes } =
      await import('../support/snmp/index.js');

    const countCache = context.params['countCacheAsAvailable'] !== false;
    const host = context.target.host;

    return snmpCheck(context, async (session, signal) => {
      // 1. The best source of "available": net-snmp exposes Linux's own MemAvailable as an
      //    hrStorage row, which is the number the kernel itself would quote.
      let totalBytes: number | null = null;
      let availableBytes: number | null = null;
      let source = '';

      const rows = await storageRows(session, signal).catch(() => []);
      const physical = rows.find((row) => /^physical memory$/i.test(row.descr));
      const availableRow = rows.find((row) => /^available memory$/i.test(row.descr));

      if (physical !== undefined) {
        const amounts = await storageAt(session, signal, physical.index);
        if (amounts !== null) totalBytes = amounts.totalBytes;
      }
      if (countCache && availableRow !== undefined && totalBytes !== null) {
        const amounts = await storageAt(session, signal, availableRow.index);
        // The row's *size* is the figure; net-snmp reports nothing as used on it.
        if (amounts !== null && amounts.totalBytes > 0) {
          availableBytes = amounts.totalBytes;
          source = 'hrStorage “Available memory” (the kernel’s own MemAvailable)';
        }
      }

      // 2. UCD, for the total when HOST-RESOURCES had none and for every fallback for available.
      const [totalReal, availReal, buffer, cached, totalSwap, availSwap] = await session.get(
        [
          UCD.memTotalReal,
          UCD.memAvailReal,
          UCD.memBuffer,
          UCD.memCached,
          UCD.memTotalSwap,
          UCD.memAvailSwap,
        ],
        signal,
      );
      // UCD reports kilobytes. Not documented at the point of use, and wrong by 1024× if missed.
      const kib = (varbind: typeof totalReal): number | null => {
        if (varbind === undefined || isException(varbind)) return null;
        const raw = numberOf(varbind);
        return raw === null ? null : raw * 1024;
      };

      totalBytes ??= kib(totalReal);
      if (availableBytes === null) {
        const free = kib(availReal);
        if (free !== null && countCache) {
          const extra = (kib(buffer) ?? 0) + (kib(cached) ?? 0);
          availableBytes = free + extra;
          source =
            extra > 0
              ? 'memAvailReal + memBuffer + memCached'
              : 'memAvailReal (this device reports no buffers or cache)';
        } else if (free !== null) {
          availableBytes = free;
          source = 'memAvailReal, which on Linux is MemFree and reads far lower than reality';
        }
      }

      if (totalBytes === null || availableBytes === null || totalBytes <= 0) {
        throw new Error(
          `${host} reports memory in neither HOST-RESOURCES-MIB (an hrStorage row called ` +
            '"Physical memory") nor UCD-SNMP-MIB (memTotalReal/memAvailReal) — most network ' +
            'hardware puts it in a vendor MIB instead, which an SNMP Custom sensor can read',
        );
      }

      const usedBytes = Math.max(0, totalBytes - availableBytes);
      const percentUsed = percentOf(usedBytes, totalBytes);

      const swapTotal = kib(totalSwap);
      const swapAvail = kib(availSwap);
      const swapPercent =
        swapTotal === null || swapAvail === null || swapTotal <= 0
          ? null
          : percentOf(swapTotal - swapAvail, swapTotal);

      return {
        channels: [
          ...(percentUsed === null ? [] : [{ key: 'percentUsed', value: percentUsed }]),
          { key: 'available', value: availableBytes },
          { key: 'used', value: usedBytes },
          { key: 'total', value: totalBytes },
          // Gapped rather than zeroed on a device with no swap: 0% used swap and "there is no
          // swap" are different facts, and only one of them is reassuring.
          ...(swapPercent === null ? [] : [{ key: 'swapPercentUsed', value: swapPercent }]),
          ...(swapAvail === null ? [] : [{ key: 'swapAvailable', value: swapAvail }]),
        ],
        message:
          `${humanBytes(usedBytes)} of ${humanBytes(totalBytes)} used ` +
          `(${String(percentUsed ?? 0)}%), ${humanBytes(availableBytes)} available from ${source}`,
      };
    });
  },
};
