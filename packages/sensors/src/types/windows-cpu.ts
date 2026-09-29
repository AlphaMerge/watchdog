import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { WINDOWS_SCHEMA, fieldNumber, fieldText, queryCim } from './windows-shared.js';

/**
 * Processor load on a Windows machine (`T-10`).
 *
 * **The performance counter, not `Win32_Processor.LoadPercentage`.** The latter is a one-second
 * sample taken at the moment of the query and is what most examples reach for; it disagrees with
 * Task Manager by tens of percent on a busy machine, because it is one sample rather than an
 * interval average. `Win32_PerfFormattedData_PerfOS_Processor` is the same counter Task Manager
 * and PRTG read, which matters when somebody compares this sensor to what they can see.
 *
 * **Per-core channels come from the machine, not from the form.** A sixty-four-core server
 * reports sixty-four instances plus `_Total`, and the core creates a channel the first time a
 * sensor mentions one (`S-07`). The total is the primary because that is the number a limit goes
 * on; the per-core channels are for the morning somebody asks why the total looks fine while one
 * thread is pinned.
 */

/** Enough for a large server, and short of the point where one sensor is a hundred channels. */
const MAX_CORES = 128;

export const windowsCpu: SensorType = {
  id: 'windows.cpu',
  category: 'Windows',
  costHint: 'medium',
  credentialKinds: ['windows'],
  // Where the set goes besides the host (`A-41`): another machine, or Basic, which sends the
  // password itself.
  secretDestinations: { 'kind:windows': ['authentication', 'host'] },

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...WINDOWS_SCHEMA,
      perCore: {
        type: 'boolean',
        default: true,
        title: 'Per-core channels',
        description:
          'A channel per logical processor as well as the total. Worth turning off on a machine ' +
          'with many cores, where the extra channels cost storage every scan and the total is ' +
          'what anybody looks at.',
      },
    },
  },

  channels(): readonly ChannelDef[] {
    return [{ key: 'total', name: 'Total', unit: '%', isPrimary: true }];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const rows = await queryCim(context, 'Win32_PerfFormattedData_PerfOS_Processor', [
      'Name',
      'PercentProcessorTime',
    ]);
    if (rows.length === 0) {
      throw new Error(
        'the processor performance counters returned nothing — on a machine where they have ' +
          'been corrupted, `lodctr /R` rebuilds them; reporting 0% would be reporting an idle ' +
          'machine on the strength of no evidence',
      );
    }

    const perCore = context.params['perCore'] !== false;
    const channels: { key: string; value: number }[] = [];
    let total: number | null = null;
    let busiest = { name: '', value: -1 };

    for (const row of rows) {
      const name = fieldText(row, 'Name');
      const value = fieldNumber(row, 'PercentProcessorTime');
      if (value === null) continue;
      if (name === '_Total') {
        total = value;
        continue;
      }
      if (value > busiest.value) busiest = { name, value };
      // `_Total` aside, the instance names are `0`, `1`, … and on a machine with more than
      // sixty-four logical processors they are `0,0`, `0,1` — a processor group and an index.
      // The key keeps both, because two cores called `0` in different groups are two cores.
      if (perCore && channels.length < MAX_CORES) {
        channels.push({ key: `core_${name.replace(/[^A-Za-z0-9]/g, '_')}`, value });
      }
    }

    if (total === null) {
      throw new Error(
        `the performance counters returned ${String(rows.length)} processor instances and no ` +
          '_Total — this sensor reads the total, and computing one from the parts would report a ' +
          'number the machine did not say',
      );
    }

    return {
      channels: [{ key: 'total', value: total }, ...channels],
      message:
        `${String(total)}% across ${String(rows.length - 1)} logical processors` +
        (busiest.value > total + 25
          ? `; core ${busiest.name} is at ${String(busiest.value)}%`
          : ''),
    };
  },
};
