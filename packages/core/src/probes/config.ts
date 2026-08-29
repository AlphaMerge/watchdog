import { createHash } from 'node:crypto';
import type { SensorAssignment } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import type { CredentialKind, InheritanceResolver } from '../settings/inheritance.js';
import type { CredentialVault } from '../vault/service.js';

/** Matches the repository's own guard: a walk that cannot terminate is a hung request. */
const MAX_WALK_DEPTH = 1000;

export interface ProbeAssignments {
  /** Fingerprint of `sensors`. Equal fingerprints mean equal configuration. */
  readonly version: string;
  readonly sensors: readonly SensorAssignment[];
  /**
   * The credential rotation stamp per sensor, carried alongside rather than folded in.
   *
   * It has to travel with the set because the *delta* needs it too, and that is not obvious:
   * `version` is computed over the whole configuration including these, so a rotation changes it
   * and the core decides something must be sent — but `diffAssignments` compares sensors one at
   * a time, and without the stamps every sensor hashes the same as before. The result was a
   * version that said "changed" and a delta that said "nothing", so a probe recorded the new
   * version and went on using the old credential for ever. Found live, rotating a host key
   * fingerprint during `T-08`.
   */
  readonly stamps: ReadonlyMap<number, string>;
}

/** An empty assignment set still has a stable fingerprint, so "nothing" compares equal. */
export const EMPTY_ASSIGNMENTS: ProbeAssignments = {
  version: fingerprint([]),
  sensors: [],
  stamps: new Map(),
};

export interface ProbeConfigOptions {
  db: Database;
  resolver: InheritanceResolver;
  /**
   * The vault, and the catalogue that says which sensor type needs which credential kind
   * (`A-05`).
   *
   * Both optional together: without them assignments carry no credentials, which is what an
   * installation with no vault configured should push rather than failing to configure its
   * probes at all. A sensor whose type needs a credential then fails its own check and says so.
   */
  vault?: CredentialVault;
  credentialKindsFor?: (sensorType: string) => readonly string[];
  /**
   * Whether the *core* evaluates this sensor type rather than a probe (`T-21`).
   *
   * Injected like `credentialKindsFor`, and defaulting to "no" for the same reason: this module
   * is about resolving a configuration, and a test driving it should not have to build a sensor
   * catalogue to do so. `main.ts` supplies the real answer.
   */
  coreEvaluated?: (sensorType: string) => boolean;
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
  readonly #vault: CredentialVault | undefined;
  readonly #credentialKindsFor: (sensorType: string) => readonly string[];
  readonly #coreEvaluated: (sensorType: string) => boolean;

  constructor(options: ProbeConfigOptions) {
    this.#db = options.db;
    this.#resolver = options.resolver;
    this.#vault = options.vault;
    this.#credentialKindsFor = options.credentialKindsFor ?? (() => []);
    this.#coreEvaluated = options.coreEvaluated ?? ((): boolean => false);
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

    // Sensor types the *core* evaluates never go to a probe (`T-21`). Filtered here rather than
    // in the SQL, and asked of the catalogue rather than matched on an id, for the reason the
    // probe reads `listener` from it: a hardcoded `core.factory` here would be a second rule to
    // keep in step by hand the day there is a second such type.
    const assignable = rows.filter((row) => !this.#coreEvaluated(row.sensor_type));
    if (assignable.length === 0) return EMPTY_ASSIGNMENTS;

    const sensorIds = assignable.map((row) => Number(row.sensor_id));
    // One query per key for the whole branch, not one per sensor: `resolveForObjects` exists
    // for exactly this, and looping the single-object resolver would be rows x keys round trips.
    const [intervals, timeouts] = await Promise.all([
      this.#resolver.resolveForObjects<number>(sensorIds, 'scan.intervalSeconds'),
      this.#resolver.resolveForObjects<number>(sensorIds, 'scan.timeoutMs'),
    ]);

    const { values: credentials, stamps } = await this.#credentialsFor(assignable);

    const sensors: SensorAssignment[] = assignable.map((row) => {
      const sensorId = Number(row.sensor_id);
      const forSensor = credentials.get(sensorId);
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
        ...(forSensor === undefined ? {} : { credentials: forSensor }),
      };
    });

    return { version: fingerprint(sensors, stamps), sensors, stamps };
  }

  /**
   * One sensor's assignment, and the probe that owns it (`R-09`).
   *
   * **The same assignment a scheduled scan would run, built by the same rules**, because an
   * operator pressing "check now" is asking what the *sensor* does. An assignment assembled
   * differently here would be the version that works when the real one does not, which is worse
   * than no answer at all.
   *
   * Deliberately not `assignmentsFor(probe).find(...)`: that resolves and decrypts credentials
   * for every sensor on the branch — thousands, on an interactive path — to answer about one.
   *
   * A paused sensor is **not** excluded, and that is the difference from the scheduled path. A
   * pause stops the monitoring; it does not stop an operator asking whether the thing they just
   * fixed is working, which is exactly when a sensor is most likely to be paused.
   */
  async assignmentFor(
    sensorId: number,
  ): Promise<{ probeObjectId: number; assignment: SensorAssignment } | null> {
    const [row] = await this.#db.query<{
      probe_id: string | null;
      sensor_type: string;
      params: Record<string, unknown> | null;
      host: string | null;
      ip_version: string | null;
    }>(
      `
      WITH RECURSIVE up AS (
        SELECT id, parent_id, kind, 0 AS depth FROM object WHERE id = $1
        UNION ALL
        SELECT o.id, o.parent_id, o.kind, up.depth + 1
        FROM object o
        JOIN up ON up.parent_id = o.id
        WHERE up.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT (SELECT id::text FROM up WHERE kind = 'probe' ORDER BY depth LIMIT 1) AS probe_id,
             sc.type       AS sensor_type,
             sc.params     AS params,
             dc.host       AS host,
             dc.ip_version AS ip_version
      FROM object s
      JOIN sensor_config sc ON sc.object_id = s.id
      JOIN device_config dc ON dc.object_id = s.parent_id
      WHERE s.id = $1 AND s.kind = 'sensor'
      `,
      [sensorId],
    );
    if (row === undefined || row.probe_id === null) return null;
    // A core-evaluated type has no probe to ask: its reading is computed here, so "run it on the
    // probe now" is a question with no answer rather than one that times out.
    if (this.#coreEvaluated(row.sensor_type)) return null;

    const [intervals, timeouts, credentials] = await Promise.all([
      this.#resolver.resolveForObjects<number>([sensorId], 'scan.intervalSeconds'),
      this.#resolver.resolveForObjects<number>([sensorId], 'scan.timeoutMs'),
      this.#credentialsFor([{ sensor_id: String(sensorId), sensor_type: row.sensor_type }]),
    ]);
    const forSensor = credentials.values.get(sensorId);

    return {
      probeObjectId: Number(row.probe_id),
      assignment: {
        sensorId,
        sensorType: row.sensor_type,
        params: row.params ?? {},
        target: {
          host: row.host ?? '',
          ipVersion: (row.ip_version ?? 'auto') as SensorAssignment['target']['ipVersion'],
        },
        intervalSeconds: intervals.get(sensorId)?.value ?? 60,
        timeoutMs: timeouts.get(sensorId)?.value ?? 30_000,
        ...(forSensor === undefined ? {} : { credentials: forSensor }),
      },
    };
  }

  /**
   * The decrypted credentials each sensor needs, and the stamps that go into the fingerprint.
   *
   * Grouped by the *set of kinds* a sensor type declares rather than resolved per sensor: a
   * branch is usually a handful of types over thousands of sensors, so this is a query per
   * distinct kind-set instead of one per sensor.
   */
  async #credentialsFor(
    rows: readonly { sensor_id: string; sensor_type: string }[],
  ): Promise<ResolvedCredentials> {
    const stamps = new Map<number, string>();
    if (this.#vault === undefined) return { values: new Map(), stamps };

    const byKindSet = new Map<string, { kinds: string[]; sensorIds: number[] }>();
    for (const row of rows) {
      const kinds = this.#credentialKindsFor(row.sensor_type);
      if (kinds.length === 0) continue;
      const key = [...kinds].sort().join(',');
      const bucket = byKindSet.get(key) ?? { kinds: [...kinds].sort(), sensorIds: [] };
      bucket.sensorIds.push(Number(row.sensor_id));
      byKindSet.set(key, bucket);
    }
    if (byKindSet.size === 0) return { values: new Map(), stamps };

    const out = new Map<number, Record<string, Record<string, unknown>>>();
    for (const { kinds, sensorIds } of byKindSet.values()) {
      const resolved = await this.#vault.resolveFor(sensorIds, kinds as CredentialKind[]);
      for (const [sensorId, byKind] of resolved) {
        const values: Record<string, Record<string, unknown>> = {};
        const marks: string[] = [];
        // Sorted, so the same credentials in a different map order fingerprint the same.
        for (const kind of [...byKind.keys()].sort()) {
          const entry = byKind.get(kind);
          /* c8 ignore next -- the key came from this map */
          if (entry === undefined) continue;
          values[kind] = entry.values;
          marks.push(`${kind}=${entry.stamp}`);
        }
        out.set(sensorId, values);
        stamps.set(sensorId, marks.join('|'));
      }
    }
    return { values: out, stamps };
  }
}

/**
 * What a credential resolve produced, returned rather than stashed on the service.
 *
 * **This used to be an instance field**, reassigned at the top of every resolve and read back
 * after it — sound for one caller and a shared mutable buffer for two. `R-09` added the second
 * caller, and `pushAllConfigs()` already started a resolve per probe without awaiting between
 * them.
 *
 * What that could cost is not cosmetic: a fingerprint assembled with another probe's rotation
 * stamps, and a fingerprint that stops moving when a credential is rotated is a probe told
 * `config-unchanged` afterwards — a device scanned with a password that no longer works, and a
 * sensor Down for a reason nothing explains.
 *
 * **Whether a real interleaving reached that is not established.** Two candidates were traced
 * and written as tests; neither reproduced against the old shape, because every write goes
 * through the field as it stands at that moment and the read follows the last write with no
 * yield between them. Returning the map removes the question for the cost of one object, which
 * is cheaper than the scheduler it would take to answer it.
 */
interface ResolvedCredentials {
  values: Map<number, Record<string, Record<string, unknown>>>;
  /** Rotation markers, keyed by sensor. Never contents — see `fingerprint`. */
  stamps: Map<number, string>;
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
export function fingerprint(
  sensors: readonly SensorAssignment[],
  credentialStamps: ReadonlyMap<number, string> = new Map(),
): string {
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
      // **The stamp, never the credential.** A rotated community string has to change this, or
      // the probe holding the old one is told "unchanged" and keeps authenticating with it. The
      // obvious way to get that is to hash the credential in — and it is a mistake: a community
      // string is short and drawn from a tiny space, so a published SHA-256 of one is recovered
      // by guessing, and this value is sent to probes and written to logs. The owning object and
      // the update time change on every rotation and give nothing away (`A-05`).
      credentialStamps.get(sensor.sensorId) ?? '',
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

/**
 * What changed between two assignment sets, as the delta the probe applies.
 *
 * **The stamps are not optional and the default is a trap the code fell into once.** A per-sensor
 * fingerprint computed without them is identical before and after a credential rotation, so a
 * rotation produced an *empty* delta against a version that had changed — the probe recorded the
 * new version and kept authenticating with the old secret, indefinitely, with nothing anywhere
 * saying so. Rotating a password to lock somebody out would have appeared to work and not have.
 */
export function diffAssignments(
  before: readonly SensorAssignment[],
  after: readonly SensorAssignment[],
  beforeStamps: ReadonlyMap<number, string> = new Map(),
  afterStamps: ReadonlyMap<number, string> = new Map(),
): { upserted: SensorAssignment[]; removed: number[] } {
  const previous = new Map(
    before.map((sensor) => [sensor.sensorId, fingerprint([sensor], beforeStamps)]),
  );
  const upserted: SensorAssignment[] = [];

  for (const sensor of after) {
    if (previous.get(sensor.sensorId) !== fingerprint([sensor], afterStamps)) upserted.push(sensor);
    previous.delete(sensor.sensorId);
  }
  // Whatever is left was in the old set and not the new one.
  return { upserted, removed: [...previous.keys()] };
}
