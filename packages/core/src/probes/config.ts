import { createHash } from 'node:crypto';
import type { SensorAssignment } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import type { InheritanceResolver } from '../settings/inheritance.js';

/** Matches the repository's own guard: a walk that cannot terminate is a hung request. */
const MAX_WALK_DEPTH = 1000;

export interface ProbeAssignments {
  /** Fingerprint of `sensors`. Equal fingerprints mean equal configuration. */
  readonly version: string;
  readonly sensors: readonly SensorAssignment[];
}

/** An empty assignment set still has a stable fingerprint, so "nothing" compares equal. */
export const EMPTY_ASSIGNMENTS: ProbeAssignments = { version: fingerprint([]), sensors: [] };

export interface ProbeConfigOptions {
  db: Database;
  resolver: InheritanceResolver;
}

/**
 * What a probe has been told to scan (R-04).
 *
 * The probe holds no copy of the object tree, so everything it needs is resolved here: the
 * device's host from the sensor's parent, and the scan interval and timeout from the settings
 * chain. That keeps one rule in one place — change an inherited interval on a group and every
 * sensor under it moves, without the probe knowing what a group is.
 */
export class ProbeConfigService {
  readonly #db: Database;
  readonly #resolver: InheritanceResolver;

  constructor(options: ProbeConfigOptions) {
    this.#db = options.db;
    this.#resolver = options.resolver;
  }

  /** The probe object a connected GID owns, or null while the GID is unclaimed. */
  async probeObjectFor(gid: string, q: Queryable = this.#db): Promise<number | null> {
    if (gid === '') return null;
    const [row] = await q.query<{ object_id: string }>(
      'SELECT object_id FROM probe_config WHERE gid = $1',
      [gid],
    );
    return row === undefined ? null : Number(row.object_id);
  }

  /** Records that this probe was seen. Best-effort: a failed touch must not fail a handshake. */
  async touch(objectId: number): Promise<void> {
    await this.#db.query('UPDATE probe_config SET last_seen_at = now() WHERE object_id = $1', [
      objectId,
    ]);
  }

  async assignmentsFor(probeObjectId: number): Promise<ProbeAssignments> {
    const rows = await this.#db.query<{
      sensor_id: string;
      sensor_type: string;
      params: Record<string, unknown> | null;
      host: string | null;
      ip_version: string | null;
    }>(
      `
      WITH RECURSIVE branch AS (
        SELECT id, 0 AS depth FROM object WHERE id = $1
        UNION ALL
        SELECT o.id, branch.depth + 1
        FROM object o
        JOIN branch ON o.parent_id = branch.id
        WHERE branch.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT s.id           AS sensor_id,
             sc.type        AS sensor_type,
             sc.params      AS params,
             dc.host        AS host,
             dc.ip_version  AS ip_version
      FROM branch b
      JOIN object s          ON s.id = b.id AND s.kind = 'sensor'
      JOIN sensor_config sc  ON sc.object_id = s.id
      -- A sensor's parent is always a device (the hierarchy trigger enforces it), so this join
      -- is total. An inner join rather than a left one: a sensor with no device to point at is
      -- a broken row, and scanning it with an empty host would be worse than not scanning it.
      JOIN device_config dc  ON dc.object_id = s.parent_id
      -- Paused sensors are simply not in the configuration (M-08). WORKFLOW.MD §3 skips them
      -- before the check is enqueued, and the cheapest way to skip a check is never to schedule
      -- it: no new protocol field, no probe-side rule to keep in step with the core's four
      -- sources, and a probe that cannot scan something it was not told about.
      JOIN sensor_runtime sr ON sr.object_id = s.id
       AND NOT (sr.paused_by_parent OR sr.paused_by_dependency
                OR sr.paused_by_schedule OR sr.paused_manually)
      ORDER BY s.id
      `,
      [probeObjectId],
    );

    if (rows.length === 0) return EMPTY_ASSIGNMENTS;

    const sensorIds = rows.map((row) => Number(row.sensor_id));
    // One query per key for the whole branch, not one per sensor: `resolveForObjects` exists
    // for exactly this, and looping the single-object resolver would be rows x keys round trips.
    const [intervals, timeouts] = await Promise.all([
      this.#resolver.resolveForObjects<number>(sensorIds, 'scan.intervalSeconds'),
      this.#resolver.resolveForObjects<number>(sensorIds, 'scan.timeoutMs'),
    ]);

    const sensors: SensorAssignment[] = rows.map((row) => {
      const sensorId = Number(row.sensor_id);
      return {
        sensorId,
        sensorType: row.sensor_type,
        params: row.params ?? {},
        target: {
          host: row.host ?? '',
          ipVersion: (row.ip_version ?? 'auto') as SensorAssignment['target']['ipVersion'],
        },
        intervalSeconds: intervals.get(sensorId)?.value ?? 60,
        timeoutMs: timeouts.get(sensorId)?.value ?? 30_000,
      };
    });

    return { version: fingerprint(sensors), sensors };
  }
}

/**
 * A fingerprint of an assignment set.
 *
 * Content-addressed rather than a counter: a counter would have to be stored, incremented under
 * a lock, and kept correct across every path that can change a sensor — while a hash of what the
 * probe should be running is derived from the answer itself and cannot drift from it. Equal
 * fingerprints mean equal configuration, which is the only property the handshake needs.
 *
 * Sorted by sensor id, and every field written explicitly, so the same configuration hashes the
 * same regardless of row order or of what order a driver happened to build an object in.
 */
export function fingerprint(sensors: readonly SensorAssignment[]): string {
  const canonical = [...sensors]
    .sort((a, b) => a.sensorId - b.sensorId)
    .map((sensor) => [
      sensor.sensorId,
      sensor.sensorType,
      stableJson(sensor.params),
      sensor.target.host,
      sensor.target.ipVersion,
      sensor.intervalSeconds,
      sensor.timeoutMs,
    ]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
}

/** JSON with object keys in a fixed order, so `{a,b}` and `{b,a}` are the same parameters. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
}

/** What changed between two assignment sets, as the delta the probe applies. */
export function diffAssignments(
  before: readonly SensorAssignment[],
  after: readonly SensorAssignment[],
): { upserted: SensorAssignment[]; removed: number[] } {
  const previous = new Map(before.map((sensor) => [sensor.sensorId, fingerprint([sensor])]));
  const upserted: SensorAssignment[] = [];

  for (const sensor of after) {
    if (previous.get(sensor.sensorId) !== fingerprint([sensor])) upserted.push(sensor);
    previous.delete(sensor.sensorId);
  }
  // Whatever is left was in the old set and not the new one.
  return { upserted, removed: [...previous.keys()] };
}
