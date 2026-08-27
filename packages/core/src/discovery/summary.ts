import type { DeviceKind, DiscoveryLevel } from '@ms/shared';
import type { DiscoveryRunRow } from './service.js';

/**
 * What a discovery run did, in one object (`D-08`).
 *
 * **Derived, never stored.** Every number here comes from the run row and the host rows, so the
 * summary cannot drift from what actually happened and a second provisioning pass updates it for
 * free. A stored summary blob would have to be rewritten by the sweep, by identification and by
 * every provisioning attempt, and the first writer to forget would leave a page confidently
 * reporting numbers nothing else agreed with. `WORKFLOW.MD §2`'s "auditable summary" is satisfied
 * by the records being immutable, not by copying them.
 *
 * **A headline, because the counts alone do not answer the question an operator asked.** They
 * ran a discovery to find out whether it worked; "254 / 18 / 11 / 20 / 2" is a table they then
 * have to interpret. One sentence at the top says what happened, and the table underneath says
 * it precisely — the same division `T-21`'s factory report and `D-06`'s estimate make.
 *
 * **Errors are in the summary rather than behind a second request.** A run that created eleven
 * devices and could not create two is the case where somebody stops reading at the good number.
 */

export interface DiscoverySummary {
  runId: number;
  groupId: number;
  probeId: number;
  /** The rediscovery schedule that started it, or null for one somebody started (`D-07`). */
  scheduleId: number | null;
  range: string;
  level: DiscoveryLevel;
  status: DiscoveryRunRow['status'];
  /** One sentence. What the run did, in the order somebody asks it. */
  headline: string;
  scanned: {
    addresses: number;
    swept: number;
    alive: number;
    /** Swept, answered nothing, and did not error. The ordinary majority of any range. */
    unreachable: number;
    /** Addresses the sweep itself could not complete — a socket error, not a silent host. */
    failed: number;
    identified: number;
    complete: boolean;
  };
  found: {
    byKind: { kind: DeviceKind | 'unidentified'; count: number }[];
    byVendor: { vendor: string; count: number }[];
  };
  created: {
    devices: number;
    /** Devices that already existed and were reused. The number that grows on a re-run. */
    matched: number;
    sensors: number;
    provisionedAt: string | null;
  };
  errors: { address: string; problem: string }[];
  timing: {
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    /** Null while a run is going, and for one that finished in no measurable time. */
    addressesPerSecond: number | null;
  };
}

/** One row of the kind breakdown, as the database hands it over: a null kind is unidentified. */
export interface KindCount {
  kind: string | null;
  count: number;
}

export interface VendorCount {
  vendor: string;
  count: number;
}

export function describeRun(
  run: DiscoveryRunRow,
  kinds: readonly KindCount[],
  vendors: readonly VendorCount[],
  errors: readonly { address: string; problem: string }[],
): DiscoverySummary {
  // Clamped, because the three counters are written by different messages and a summary read
  // between two of them should say "0 unreachable" rather than "-3".
  const unreachable = Math.max(0, run.cursor - run.found - run.failed);
  const durationMs =
    run.startedAt === null || run.finishedAt === null
      ? null
      : Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt));

  const scanned = {
    addresses: run.total,
    swept: run.cursor,
    alive: run.found,
    unreachable,
    failed: run.failed,
    identified: run.identified,
    complete: run.cursor >= run.total,
  };
  const created = {
    devices: run.devicesCreated,
    matched: run.devicesMatched,
    sensors: run.sensorsCreated,
    provisionedAt: run.provisionedAt,
  };

  return {
    runId: run.id,
    groupId: run.groupId,
    probeId: run.probeId,
    scheduleId: run.scheduleId,
    range: run.range,
    level: run.level,
    status: run.status,
    headline: headlineFor(run, scanned, created, errors.length),
    scanned,
    found: {
      byKind: kinds.map((one) => ({ kind: kindOf(one.kind), count: one.count })),
      byVendor: vendors.map((one) => ({ vendor: one.vendor, count: one.count })),
    },
    created,
    errors: [...errors],
    timing: {
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs,
      addressesPerSecond:
        durationMs === null || durationMs === 0
          ? null
          : Math.round((run.cursor / durationMs) * 1_000 * 10) / 10,
    },
  };
}

/**
 * The sentence at the top.
 *
 * Written as a small set of cases rather than a template with optional clauses, because the
 * interesting sentences are the unhappy ones and a template would bury them: "cancelled after 132
 * of 254 addresses" and "created nothing" are the two an operator most needs to read first, and
 * both would otherwise be a missing clause in the middle of a success message.
 */
function headlineFor(
  run: DiscoveryRunRow,
  scanned: DiscoverySummary['scanned'],
  created: DiscoverySummary['created'],
  errors: number,
): string {
  // Pluralised on the total rather than on the progress, so a range of one reads as "0 of 1
  // address" rather than "0 addresses of 1".
  const swept = `${String(scanned.swept)} of ${count(scanned.addresses, 'address', 'addresses')}`;
  const alive = `${count(scanned.alive, 'host', 'hosts')} answered`;

  switch (run.status) {
    case 'queued':
      return `${run.range} is waiting for its probe — ${String(scanned.addresses)} addresses to sweep.`;
    case 'running':
      return `Sweeping ${run.range} — ${swept}, ${alive}.`;
    case 'identifying':
      return `Identifying what ${run.range} found — ${count(scanned.identified, 'host', 'hosts')} of ${String(scanned.alive)}.`;
    case 'cancelled':
      return `Cancelled after ${swept} in ${run.range}${scanned.alive === 0 ? '' : `, ${alive}`}.`;
    case 'failed':
      // The run's own message, because "it failed" without it sends somebody to the log for a
      // sentence that already exists.
      return `${run.range} failed after ${swept}${run.message === '' ? '' : `: ${run.message}`}`;
    case 'done':
      break;
  }

  const parts = [`${run.range}: ${swept} swept, ${alive}`];
  if (scanned.identified > 0) parts.push(`${String(scanned.identified)} identified`);

  if (created.provisionedAt === null) {
    parts.push('nothing created yet');
  } else if (created.devices === 0 && created.sensors === 0) {
    // The genuinely useful case for a re-run: everything was already there, which is the promise
    // idempotency makes and the thing somebody re-running is checking.
    parts.push(
      created.matched === 0
        ? 'nothing created'
        : `nothing new — ${count(created.matched, 'device', 'devices')} already existed`,
    );
  } else {
    parts.push(
      `${count(created.devices, 'device', 'devices')} and ${count(created.sensors, 'sensor', 'sensors')} created`,
    );
    if (created.matched > 0) parts.push(`${String(created.matched)} already existed`);
  }

  if (errors > 0) parts.push(`${count(errors, 'address', 'addresses')} had problems`);
  return `${parts.join(', ')}.`;
}

function count(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

const KINDS: ReadonlySet<string> = new Set([
  'windows',
  'linux',
  'network',
  'printer',
  'hypervisor',
  'nas',
  'unknown',
]);

/**
 * A kind from the database, or `unidentified`.
 *
 * `unknown` and `unidentified` are different answers and the distinction matters: `unknown` is a
 * host the classifier looked at and could not place, `unidentified` is one it never looked at —
 * a `ping` run, or a run cancelled before identification. Collapsing them would make a ping-only
 * discovery look like a failed classification.
 */
function kindOf(value: string | null): DeviceKind | 'unidentified' {
  if (value === null || !KINDS.has(value)) return 'unidentified';
  return value as DeviceKind;
}
