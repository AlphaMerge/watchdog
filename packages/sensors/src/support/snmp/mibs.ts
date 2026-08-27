import { isException, numberOf, stringOf, type SnmpSession, type SnmpVarbind } from './session.js';
import { indexUnder, parseOid } from './oid.js';

/**
 * The standard MIBs the `T-05` sensor types read, and the awkward bits of reading them.
 *
 * Shared for the same reason `check.ts` is: four types ask overlapping questions of the same two
 * MIBs, and four copies would drift. What lives here is the knowledge that is *not* obvious from
 * the OID — that `hrStorageSize` is in allocation units and not bytes, that a processor index is
 * arbitrary, that "available memory" has three possible sources and they disagree by a factor of
 * two. Every number below was measured against the dev target's own net-snmp agent; the figures
 * are in the comments because they are the argument for the choices.
 */

/** HOST-RESOURCES-MIB, RFC 2790. Present on anything running a general-purpose OS. */
export const HR = {
  /** Host uptime. **Not** `sysUpTime`, which is the agent's — see `uptimeOf`. */
  systemUptime: '1.3.6.1.2.1.25.1.1.0',
  /** Percentage over the last minute, one row per processor. */
  processorLoad: '1.3.6.1.2.1.25.3.3.1.2',
  storage: {
    entry: '1.3.6.1.2.1.25.2.3.1',
    type: '1.3.6.1.2.1.25.2.3.1.2',
    descr: '1.3.6.1.2.1.25.2.3.1.3',
    allocationUnits: '1.3.6.1.2.1.25.2.3.1.4',
    size: '1.3.6.1.2.1.25.2.3.1.5',
    used: '1.3.6.1.2.1.25.2.3.1.6',
  },
  /** `hrStorageType` values, which say what a storage row actually is. */
  storageType: {
    other: '1.3.6.1.2.1.25.2.1.1',
    ram: '1.3.6.1.2.1.25.2.1.2',
    virtualMemory: '1.3.6.1.2.1.25.2.1.3',
    fixedDisk: '1.3.6.1.2.1.25.2.1.4',
    removableDisk: '1.3.6.1.2.1.25.2.1.5',
    ramDisk: '1.3.6.1.2.1.25.2.1.8',
    flashMemory: '1.3.6.1.2.1.25.2.1.9',
    networkDisk: '1.3.6.1.2.1.25.2.1.10',
  },
} as const;

/** The disk-ish storage types. `other` is excluded: on Linux it is where the agent puts caches. */
export const DISK_TYPES: readonly string[] = [
  HR.storageType.fixedDisk,
  HR.storageType.removableDisk,
  HR.storageType.ramDisk,
  HR.storageType.flashMemory,
  HR.storageType.networkDisk,
];

/** SNMPv2-MIB. The agent's uptime, which is not the host's. */
export const SYS_UPTIME = '1.3.6.1.2.1.1.3.0';

/** UCD-SNMP-MIB. Linux and BSD running net-snmp; absent on most network hardware. */
export const UCD = {
  memTotalSwap: '1.3.6.1.4.1.2021.4.3.0',
  memAvailSwap: '1.3.6.1.4.1.2021.4.4.0',
  memTotalReal: '1.3.6.1.4.1.2021.4.5.0',
  /** **MemFree, not MemAvailable.** See `memoryOf` — this alone is misleading on Linux. */
  memAvailReal: '1.3.6.1.4.1.2021.4.6.0',
  memBuffer: '1.3.6.1.4.1.2021.4.14.0',
  memCached: '1.3.6.1.4.1.2021.4.15.0',
  ssCpuUser: '1.3.6.1.4.1.2021.11.9.0',
  ssCpuSystem: '1.3.6.1.4.1.2021.11.10.0',
  ssCpuIdle: '1.3.6.1.4.1.2021.11.11.0',
} as const;

/** `TimeTicks` are hundredths of a second. Nothing in SNMP says so at the point of use. */
export const TICKS_PER_SECOND = 100;

/**
 * How long a `TimeTicks` counter runs before it goes round: 2^32 centiseconds, ~497 days.
 *
 * Not corrected for, and that is a deliberate limit rather than an oversight: a host up for more
 * than 497 days reports a wrapped value, and *nothing in the reading says how many times*. The
 * sensor says so in its message once past the threshold rather than reporting a confident wrong
 * number. Network hardware genuinely reaches this; a Linux box rarely does.
 */
export const TICKS_WRAP_DAYS = 497;

const value = (varbind: SnmpVarbind | undefined): number | null =>
  varbind === undefined || isException(varbind) ? null : numberOf(varbind);

const label = (varbind: SnmpVarbind | undefined): string | null =>
  varbind === undefined || isException(varbind) ? null : stringOf(varbind);

export interface Uptime {
  /** Seconds. */
  readonly seconds: number;
  /** Which OID it came from, for the message. */
  readonly source: 'host' | 'agent';
  /** The agent's own uptime in seconds, when it differs usefully from the host's. */
  readonly agentSeconds: number | null;
}

/**
 * How long the device has been up.
 *
 * **`sysUpTime` is the wrong OID for this and is the one everybody reaches for.** It counts from
 * the last time the *network management subsystem* re-initialised — restarting `snmpd` resets it
 * while the host keeps running. Measured on the dev target while writing this: `sysUpTime` said
 * 32 hours and `hrSystemUptime` said 8.9 days, on a box that had not rebooted. A sensor built on
 * `sysUpTime` would have reported a restart that never happened, which is precisely the alarm
 * this type exists to raise.
 *
 * So `hrSystemUptime` is preferred and `sysUpTime` is the fallback for a device with no
 * HOST-RESOURCES-MIB — most network hardware — where the agent and the box do restart together.
 * Both are read every scan: the difference is worth reporting, because an agent that restarted
 * on its own is a real event that explains a gap in the graph.
 */
export async function uptimeOf(session: SnmpSession, signal: AbortSignal): Promise<Uptime | null> {
  const [host, agent] = await session.get([HR.systemUptime, SYS_UPTIME], signal);
  const hostTicks = value(host);
  const agentTicks = value(agent);
  const agentSeconds = agentTicks === null ? null : agentTicks / TICKS_PER_SECOND;

  if (hostTicks !== null) {
    return { seconds: hostTicks / TICKS_PER_SECOND, source: 'host', agentSeconds };
  }
  if (agentSeconds !== null) {
    return { seconds: agentSeconds, source: 'agent', agentSeconds };
  }
  return null;
}

export interface StorageRow {
  /** The row index, as text: it is arbitrary and it is not always one arc. */
  readonly index: string;
  readonly descr: string;
}

/**
 * Every `hrStorageTable` row, by index and description.
 *
 * One walk of `hrStorageDescr`. The index is text and never assumed contiguous — the dev target
 * indexes its rows 1, 3, 6, 7, 8, 10, 11, 33, 38, 39… — and `hrProcessorLoad` on the same box is
 * indexed from 196608, which is what an arbitrary index looks like in the wild.
 */
export async function storageRows(
  session: SnmpSession,
  signal: AbortSignal,
): Promise<StorageRow[]> {
  const prefix = parseOid(HR.storage.descr);
  const rows: StorageRow[] = [];
  for (const varbind of await session.walk(HR.storage.descr, signal)) {
    const descr = label(varbind);
    if (descr === null) continue;
    const suffix = indexUnder(prefix, parseOid(varbind.oid));
    if (suffix === null || suffix.length === 0) continue;
    rows.push({ index: suffix.join('.'), descr: descr.trim() });
  }
  return rows;
}

export interface StorageAmounts {
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly freeBytes: number;
  /** `hrStorageAllocationUnits`, kept for the message: it is the reason the numbers are big. */
  readonly units: number;
  readonly type: string | null;
}

/**
 * One storage row in **bytes**.
 *
 * The multiplication is the whole point of this helper. `hrStorageSize` and `hrStorageUsed` are
 * counts of `hrStorageAllocationUnits`, not bytes, and the unit differs per row on the same
 * device — measured on the dev target: 1024 for the memory rows and 4096 for the filesystems.
 * A sensor reading the columns raw reports a filesystem four times smaller than it is.
 */
export async function storageAt(
  session: SnmpSession,
  signal: AbortSignal,
  index: string,
): Promise<StorageAmounts | null> {
  const [units, size, used, type] = await session.get(
    [
      `${HR.storage.allocationUnits}.${index}`,
      `${HR.storage.size}.${index}`,
      `${HR.storage.used}.${index}`,
      `${HR.storage.type}.${index}`,
    ],
    signal,
  );

  const unitBytes = value(units);
  const sizeUnits = value(size);
  const usedUnits = value(used);
  if (unitBytes === null || sizeUnits === null || unitBytes <= 0) return null;

  const totalBytes = sizeUnits * unitBytes;
  // A row whose `used` the agent does not answer is reported as a total with no usage rather
  // than as an empty one: zero used would draw a reassuring flat line at the floor.
  const usedBytes = usedUnits === null ? Number.NaN : usedUnits * unitBytes;
  return {
    totalBytes,
    usedBytes,
    freeBytes: Number.isNaN(usedBytes) ? Number.NaN : totalBytes - usedBytes,
    units: unitBytes,
    type: type === undefined || isException(type) ? null : stringOf(type),
  };
}

/** A percentage, rounded to two decimals, or null when the total makes it meaningless. */
export function percentOf(part: number, total: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  return Math.round((part / total) * 10_000) / 100;
}

/** Bytes as something a person reads, for a sensor message. */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let scaled = bytes;
  let at = 0;
  while (Math.abs(scaled) >= 1024 && at < units.length - 1) {
    scaled /= 1024;
    at += 1;
  }
  return `${scaled.toFixed(at === 0 ? 0 : 1)} ${units[at] ?? 'B'}`;
}

/** Seconds as something a person reads: "8 days, 21 hours". */
export function humanDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${String(days)} days, ${String(hours)} hours`;
  if (hours > 0) return `${String(hours)} hours, ${String(minutes)} minutes`;
  return `${String(minutes)} minutes`;
}
