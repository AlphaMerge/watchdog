import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { SNMP_SECRET_DESTINATIONS, snmpParamsSchema } from '../support/snmp/schema.js';

/**
 * Processor load over SNMP (`T-05`).
 *
 * **`hrProcessorLoad` first, because it is a percentage and needs no state.** HOST-RESOURCES-MIB
 * reports each processor's load over the last minute as a number from 0 to 100, so a check reads
 * it and is done. The obvious alternative — UCD's `ssCpuRaw*` counters — is more precise and much
 * more machinery: they are jiffy counters, a percentage is one counter over the sum of all of
 * them, and the core computes rates per channel independently (`T-02`), so it could not divide
 * one by another. That would need a new kind of derived channel for a number the device is
 * already willing to compute.
 *
 * **The average is the primary, and the busiest core is beside it.** A 32-core box with one
 * pegged core averages 3% and is in trouble; a mean alone hides exactly the case worth alarming
 * on. Both come from the same walk, so the second channel is free.
 *
 * The fallback is UCD's `ssCpuIdle` — `100 - idle`, a single number with no per-processor
 * detail, which is what a device with no HOST-RESOURCES-MIB can offer. The per-processor
 * channels gap rather than repeat the average, since a made-up "busiest core" equal to the mean
 * is worse than an honest gap.
 */
export const snmpCpu: SensorType = {
  id: 'snmp.cpu',
  category: 'SNMP',
  costHint: 'medium',
  secretDestinations: SNMP_SECRET_DESTINATIONS,
  credentialKinds: ['snmp'],
  pinnedKinds: ['snmp'],

  paramsSchema: snmpParamsSchema(
    {
      source: {
        enum: ['auto', 'hr', 'ucd'],
        default: 'auto',
        title: 'Where to read it',
        description:
          '`auto` walks hrProcessorLoad and falls back to UCD’s ssCpuIdle when the device has ' +
          'no HOST-RESOURCES-MIB. Force one only for a device that answers both and disagrees ' +
          'with itself.',
      },
    },
    [],
  ),

  channels(): readonly ChannelDef[] {
    return [
      { key: 'load', name: 'Processor load', unit: '%', isPrimary: true },
      // A mean hides the one pegged core, which is the case worth alarming on.
      { key: 'loadMax', name: 'Busiest processor', unit: '%' },
      { key: 'processors', name: 'Processors', unit: '' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { snmpCheck, numberOf, isException, HR, UCD } = await import('../support/snmp/index.js');

    const declared = context.params['source'];
    const source = typeof declared === 'string' ? declared : 'auto';

    return snmpCheck(context, async (session, signal) => {
      const loads: number[] = [];
      if (source !== 'ucd') {
        for (const varbind of await session.walk(HR.processorLoad, signal)) {
          const load = numberOf(varbind);
          if (load !== null && load >= 0 && load <= 100) loads.push(load);
        }
      }

      if (loads.length > 0) {
        const total = loads.reduce((sum, load) => sum + load, 0);
        const average = Math.round((total / loads.length) * 100) / 100;
        const busiest = Math.max(...loads);
        return {
          channels: [
            { key: 'load', value: average },
            { key: 'loadMax', value: busiest },
            { key: 'processors', value: loads.length },
          ],
          message:
            `${String(average)}% across ${String(loads.length)} processors, ` +
            `busiest ${String(busiest)}%`,
        };
      }

      if (source === 'hr') {
        throw new Error(
          `${context.target.host} has no hrProcessorLoad — this sensor is set to read ` +
            'HOST-RESOURCES-MIB only; set it to auto to fall back to UCD-SNMP-MIB',
        );
      }

      const [idleBind] = await session.get([UCD.ssCpuIdle], signal);
      const idle = idleBind === undefined || isException(idleBind) ? null : numberOf(idleBind);
      if (idle === null) {
        throw new Error(
          `${context.target.host} reports processor load in neither HOST-RESOURCES-MIB ` +
            '(hrProcessorLoad) nor UCD-SNMP-MIB (ssCpuIdle) — most network hardware puts it in a ' +
            'vendor MIB instead, which an SNMP Custom sensor can read',
        );
      }

      const load = Math.round((100 - idle) * 100) / 100;
      return {
        // `loadMax` and `processors` are *gapped*, not filled with the average and 1: a busiest
        // core equal to the mean is a number an operator would set a limit against.
        channels: [{ key: 'load', value: load }],
        message:
          `${String(load)}% from ssCpuIdle; this device has no hrProcessorLoad, so there is no ` +
          'per-processor detail',
      };
    });
  },
};
