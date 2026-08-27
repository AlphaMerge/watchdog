import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { snmpParamsSchema } from '../support/snmp/schema.js';

/**
 * Free space on one filesystem over SNMP (`T-05`).
 *
 * **Why this exists when `snmp.table` could read the same columns.** Three things it knows that
 * a generic table sensor cannot: that `hrStorageSize` and `hrStorageUsed` are counts of
 * `hrStorageAllocationUnits` rather than bytes — the unit differs *per row on the same device*,
 * measured at 1024 for the memory rows and 4096 for the filesystems on the dev target, so a
 * generic sensor reports a filesystem four times too small; that the row worth watching is found
 * by mount point and not by index, because `hrStorageIndex` is arbitrary and moves when a
 * filesystem is mounted; and that the number to alarm on is a percentage the device does not
 * report at all.
 *
 * **The mount point is matched every scan.** The dev target indexes its storage rows 1, 3, 6, 7,
 * 8, 10, 11, 33, 38, 39…, and which integer "/" lands on is a fact about this boot. An index is
 * accepted as a hint and checked first, so an unchanged device costs one extra request rather
 * than a walk.
 */
export const snmpDiskFree: SensorType = {
  id: 'snmp.diskfree',
  category: 'SNMP',
  costHint: 'medium',
  credentialKinds: ['snmp'],

  paramsSchema: snmpParamsSchema(
    {
      mountPoint: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        title: 'Mount point',
        description:
          'Matched against `hrStorageDescr` — “/”, “/var”, “C:\\ Label:… ” on Windows. Compared ' +
          'whole, ignoring case and surrounding spaces; a device that decorates the description ' +
          'needs the “starts with” match below. Resolved on every scan, so this sensor follows ' +
          'the filesystem when the device renumbers its storage table.',
      },
      matchMode: {
        enum: ['exact', 'startsWith'],
        default: 'exact',
        title: 'How to match',
        description:
          '`exact` is the whole description. `startsWith` is for an agent that appends a label ' +
          'or a filesystem type — Windows reports “C:\\ Label:System Serial Number 1234-5678”, ' +
          'where the only stable part is the front.',
      },
      storageIndex: {
        type: 'string',
        pattern: '^$|^[0-9]+(\\.[0-9]+)*$',
        maxLength: 128,
        default: '',
        title: 'Storage index',
        description:
          'Optional. A hint, checked before the walk, so an unchanged device costs one request ' +
          'instead of a walk of its storage table. It is never trusted on its own: if the row it ' +
          'names no longer has this mount point, the table is walked and the mount point wins.',
      },
    },
    ['mountPoint'],
  ),

  channels(): readonly ChannelDef[] {
    return [
      // The percentage is primary because it is the one number that means the same thing on a
      // 64 GB volume and a 64 TB one, and the device does not report it.
      { key: 'percentUsed', name: 'Disk used', unit: '%', isPrimary: true },
      { key: 'free', name: 'Free space', unit: 'B' },
      { key: 'used', name: 'Used space', unit: 'B' },
      { key: 'total', name: 'Total space', unit: 'B' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const {
      snmpCheck,
      storageRows,
      storageAt,
      percentOf,
      humanBytes,
      isException,
      stringOf,
      DISK_TYPES,
      HR,
    } = await import('../support/snmp/index.js');

    const host = context.target.host;
    const asked = context.params['mountPoint'];
    const wanted = (typeof asked === 'string' ? asked : '').trim();
    if (wanted === '') throw new Error('this sensor names no mount point');

    const startsWith = context.params['matchMode'] === 'startsWith';
    const hintRaw = context.params['storageIndex'];
    const hint = (typeof hintRaw === 'string' ? hintRaw : '').trim();

    const target = wanted.toLowerCase();
    const matches = (descr: string): boolean => {
      const value = descr.trim().toLowerCase();
      return startsWith ? value.startsWith(target) : value === target;
    };

    return snmpCheck(context, async (session, signal) => {
      let index: string | null = null;
      let resolvedBy = 'index';

      if (hint !== '') {
        // One Get against the hinted row's description. Cheap, and it is *verified* rather than
        // trusted: an index that has moved is the failure mode this whole type is shaped around.
        const [descrBind] = await session
          .get([`${HR.storage.descr}.${hint}`], signal)
          .catch(() => []);
        if (descrBind !== undefined && !isException(descrBind)) {
          if (matches(stringOf(descrBind) ?? '')) index = hint;
        }
      }

      let rows: readonly { index: string; descr: string }[] = [];
      if (index === null) {
        rows = await storageRows(session, signal);
        const found = rows.find((row) => matches(row.descr));
        if (found === undefined) {
          // Naming what the device *does* have is the difference between a five-second fix and
          // an `snmpwalk` session: the mount point is nearly always a typo or a decorated
          // description away from one that is right there in the list.
          const disks = rows.map((row) => row.descr).slice(0, 12);
          throw new Error(
            `${host} has no storage called "${wanted}" — it reports ` +
              (disks.length === 0
                ? 'no storage table at all, so it has no HOST-RESOURCES-MIB'
                : disks.map((descr) => `"${descr}"`).join(', ')),
          );
        }
        index = found.index;
        resolvedBy = 'name';
      }

      const amounts = await storageAt(session, signal, index);
      if (amounts === null) {
        throw new Error(
          `${host} has a storage row ${index} for "${wanted}" but did not report its size or ` +
            'its allocation units, so there is nothing to measure',
        );
      }

      const notes: string[] = [];
      if (amounts.type !== null && !DISK_TYPES.includes(amounts.type)) {
        // Not a failure — an operator may deliberately watch a RAM disk or a memory row — but
        // it is the usual reason a "disk" sensor reports a suspiciously small volume.
        notes.push(`this row is not a disk (hrStorageType ${amounts.type})`);
      }
      if (!Number.isFinite(amounts.usedBytes)) {
        throw new Error(
          `${host} reports a size for "${wanted}" but no hrStorageUsed, so free space cannot be ` +
            'computed — reporting it as empty would be a reassuring lie',
        );
      }

      const percentUsed = percentOf(amounts.usedBytes, amounts.totalBytes);
      return {
        channels: [
          ...(percentUsed === null ? [] : [{ key: 'percentUsed', value: percentUsed }]),
          { key: 'free', value: amounts.freeBytes },
          { key: 'used', value: amounts.usedBytes },
          { key: 'total', value: amounts.totalBytes },
        ],
        message: [
          `${humanBytes(amounts.freeBytes)} free of ${humanBytes(amounts.totalBytes)} ` +
            `(${String(percentUsed ?? 0)}% used) on row ${index}` +
            (resolvedBy === 'name' ? ' found by name' : ''),
          ...notes,
        ].join('; '),
      };
    });
  },
};
