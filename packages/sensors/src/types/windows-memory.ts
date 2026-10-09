import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { WINDOWS_SCHEMA, bytesFromKib, percentOf, queryCim } from './windows-shared.js';

/**
 * Memory on a Windows machine (`T-10`).
 *
 * **Available memory as a percentage is the primary, and bytes are context.** A limit is set on
 * the percentage: "alarm below 10% free" is a sentence somebody can write once and apply to
 * every server, where "alarm below 3,221,225,472 bytes" has to be worked out per machine and is
 * wrong the day one gets more RAM.
 *
 * **`Win32_OperatingSystem`, not the memory performance counters.** One query, present on every
 * Windows since 2000, and it carries the virtual figures in the same row — where
 * `Win32_PerfFormattedData_PerfOS_Memory` needs the counters to be healthy and reports zero when
 * they are not, which is indistinguishable from a machine that has run out.
 *
 * **Virtual memory is a second pair of channels rather than a second sensor.** A machine with
 * physical memory free and its commit charge at the pagefile limit is about to refuse
 * allocations, and that is invisible in the physical numbers alone.
 */

export const windowsMemory: SensorType = {
  id: 'windows.memory',
  category: 'Windows',
  costHint: 'medium',
  credentialKinds: ['windows'],
  // Where the set goes besides the host (`A-41`): another machine, or Basic, which sends the
  // password itself.
  secretDestinations: { 'kind:windows': ['authentication', 'host'] },

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { ...WINDOWS_SCHEMA },
  },

  // Every reading is keyed by a channel `channels()` names, on every path: a channel a later
  // build drops is retired (`P-320`).
  declaresEveryChannel: true,

  channels(): readonly ChannelDef[] {
    return [
      { key: 'availablePercent', name: 'Available memory', unit: '%', isPrimary: true },
      { key: 'available', name: 'Available memory', unit: 'B' },
      { key: 'total', name: 'Total memory', unit: 'B' },
      { key: 'virtualAvailablePercent', name: 'Available virtual memory', unit: '%' },
      { key: 'virtualAvailable', name: 'Available virtual memory', unit: 'B' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const rows = await queryCim(context, 'Win32_OperatingSystem', [
      'TotalVisibleMemorySize',
      'FreePhysicalMemory',
      'TotalVirtualMemorySize',
      'FreeVirtualMemory',
      'Caption',
    ]);
    const row = rows[0];
    if (row === undefined) {
      throw new Error('Win32_OperatingSystem returned no rows, which no working Windows does');
    }

    // Every one of these is reported in kibibytes. Storing kibibytes would make the unit
    // something every graph, limit and summary has to remember; bytes is what the rest of this
    // system counts in.
    const total = bytesFromKib(row, 'TotalVisibleMemorySize');
    const available = bytesFromKib(row, 'FreePhysicalMemory');
    const virtualTotal = bytesFromKib(row, 'TotalVirtualMemorySize');
    const virtualAvailable = bytesFromKib(row, 'FreeVirtualMemory');

    if (total === null || available === null) {
      throw new Error(
        'Win32_OperatingSystem answered without the physical memory figures — this sensor has ' +
          'nothing to report, and a zero here would read as a machine with no memory left',
      );
    }

    const availablePercent = percentOf(available, total);
    const readings: { key: string; value: number }[] = [
      { key: 'available', value: available },
      { key: 'total', value: total },
    ];
    if (availablePercent !== null) {
      readings.unshift({ key: 'availablePercent', value: availablePercent });
    }
    if (virtualAvailable !== null) {
      readings.push({ key: 'virtualAvailable', value: virtualAvailable });
      const percent = percentOf(virtualAvailable, virtualTotal);
      if (percent !== null) readings.push({ key: 'virtualAvailablePercent', value: percent });
    }

    return {
      channels: readings,
      message:
        `${String(availablePercent ?? 0)}% available — ${gib(available)} of ${gib(total)} GiB` +
        (virtualAvailable === null ? '' : `, virtual ${gib(virtualAvailable)} GiB free`),
    };
  },
};

function gib(bytes: number): string {
  return String(Math.round((bytes / 1024 ** 3) * 10) / 10);
}
