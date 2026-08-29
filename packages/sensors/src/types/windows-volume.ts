import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import {
  WINDOWS_SCHEMA,
  driveKey,
  fieldNumber,
  fieldText,
  percentOf,
  queryCim,
} from './windows-shared.js';

/**
 * Free space on a Windows machine's volumes (`T-10`).
 *
 * **One sensor for the machine, with a channel per volume — not one sensor per volume.** A
 * server with six drives would otherwise be six sensors that all go Down together when the
 * machine does, which is six alarms for one outage. The primary is the *lowest* free percentage
 * across the volumes this sensor watches, so a single limit says "alarm when any disk on this
 * machine gets tight" and the per-volume channels say which.
 *
 * **Percentage first, bytes second, and both.** A limit belongs on the percentage — it is the
 * one number that means the same thing on a 200 GB volume and a 20 TB one. Bytes are what
 * somebody needs when the limit fires and the question becomes how much has to be freed.
 *
 * **Fixed disks only, by default.** `DriveType` 3 is a local fixed disk; 2 is removable, 4 is a
 * network drive and 5 is optical. A network drive appearing and disappearing as a session comes
 * and goes is a channel that gaps for reasons that have nothing to do with storage.
 */

const MAX_VOLUMES = 32;

export const windowsVolume: SensorType = {
  id: 'windows.volume',
  category: 'Windows',
  costHint: 'medium',
  credentialKinds: ['windows'],

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...WINDOWS_SCHEMA,
      drives: {
        type: 'array',
        maxItems: MAX_VOLUMES,
        default: [],
        title: 'Volumes',
        description:
          'Drive letters to watch — C:, D:. Empty watches every local fixed disk, which is what ' +
          'most machines want and what keeps a new volume from being invisible.',
        // The singular, for `U-12`'s repeating control.
        items: { title: 'Volume', type: 'string', minLength: 1, maxLength: 4 },
      },
      includeNetwork: {
        type: 'boolean',
        default: false,
        title: 'Include network drives',
        description:
          'Off by default. A mapped drive that comes and goes with a session produces a channel ' +
          'that gaps for reasons that have nothing to do with storage.',
      },
    },
  },

  channels(): readonly ChannelDef[] {
    return [{ key: 'lowest', name: 'Lowest free space', unit: '%', isPrimary: true }];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const wanted = new Set(
      (Array.isArray(context.params['drives']) ? context.params['drives'] : [])
        .filter((one): one is string => typeof one === 'string')
        .map(driveKey)
        .filter((one) => one !== ''),
    );
    // 3 is a local fixed disk; 4 is a network drive. The filter runs on the far end rather than
    // here, so a machine with a hundred mapped drives does not send them all across.
    const filter =
      context.params['includeNetwork'] === true
        ? 'DriveType = 3 OR DriveType = 4'
        : 'DriveType = 3';

    const rows = await queryCim(
      context,
      'Win32_LogicalDisk',
      ['DeviceID', 'VolumeName', 'Size', 'FreeSpace', 'DriveType'],
      filter,
    );

    const readings: { key: string; value: number }[] = [];
    const notes: string[] = [];
    let lowest: number | null = null;
    let lowestName = '';
    let seen = 0;

    for (const row of rows) {
      const deviceId = fieldText(row, 'DeviceID');
      const key = driveKey(deviceId);
      if (key === '') continue;
      if (wanted.size > 0 && !wanted.has(key)) continue;
      if (seen >= MAX_VOLUMES) break;
      seen += 1;

      const size = fieldNumber(row, 'Size');
      const free = fieldNumber(row, 'FreeSpace');
      if (free === null || size === null || size === 0) {
        // A volume that is there and reports nothing — a disconnected mapped drive, or a
        // BitLocker volume that is locked. A gap, and named, rather than a zero that reads as a
        // full disk and pages somebody at three in the morning.
        notes.push(`${deviceId} reported no size`);
        continue;
      }
      const percent = percentOf(free, size);
      if (percent === null) continue;
      readings.push({ key: `free_${key}`, value: percent });
      readings.push({ key: `freebytes_${key}`, value: free });
      readings.push({ key: `size_${key}`, value: size });
      if (lowest === null || percent < lowest) {
        lowest = percent;
        lowestName = `${deviceId}${fieldText(row, 'VolumeName') === '' ? '' : ` (${fieldText(row, 'VolumeName')})`}`;
      }
    }

    if (lowest === null) {
      throw new Error(
        wanted.size > 0
          ? `none of the volumes this sensor watches (${[...wanted].join(', ')}) answered — the ` +
              `machine reported ${String(rows.length)} volumes` +
              (notes.length === 0 ? '' : `; ${notes.join('; ')}`)
          : 'the machine reported no local fixed disks, which is not a reading of no free space',
      );
    }

    return {
      channels: [{ key: 'lowest', value: lowest }, ...readings],
      message:
        `${String(seen)} volumes, lowest ${String(lowest)}% free on ${lowestName}` +
        (notes.length === 0 ? '' : `; ${notes.join('; ')}`),
    };
  },
};
