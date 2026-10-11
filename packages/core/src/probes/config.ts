import { createHash } from 'node:crypto';
import { restrictionOf, type CredentialRestriction } from '@ms/sensors';
import { capabilitiesFor, PROTOCOL_VERSION, type SensorAssignment } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import type {
  BuildingFor,
  CredentialVouching,
  SensorBeingSent,
} from '../objects/credential-vouching.js';
import { ObjectError } from '../objects/errors.js';
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
  /**
   * Whether each sensor may still be sent its inherited credentials (`A-41`).
   *
   * Absent in a test that is not about that, which then sends every set it resolves — the
   * behaviour before `A-41`. `main.ts` always supplies it.
   */
  credentialCheck?: Pick<CredentialVouching, 'refusals' | 'withhold'> &
    Partial<Pick<CredentialVouching, 'judgedVersion'>>;
}

/**
 * What "check now" sends, and to which probe (`R-09`).
 *
 * `assignment` is null, and `peerVersion` 0, when the probe that owns the sensor is not connected
 * (`A-52`): there is nobody to build one for, and the caller answers that the probe is not
 * connected, not anything about what a probe would have to speak.
 */
export type CheckNowAssignment =
  | { probeObjectId: number; peerVersion: number; assignment: SensorAssignment }
  | { probeObjectId: number; peerVersion: 0; assignment: null };

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
  readonly #credentialCheck: ProbeConfigOptions['credentialCheck'];

  constructor(options: ProbeConfigOptions) {
    this.#db = options.db;
    this.#resolver = options.resolver;
    this.#vault = options.vault;
    this.#credentialKindsFor = options.credentialKindsFor ?? (() => []);
    this.#coreEvaluated = options.coreEvaluated ?? ((): boolean => false);
    this.#credentialCheck = options.credentialCheck;
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

  async assignmentsFor(
    probeObjectId: number,
    /**
     * What the probe speaks (`A-41b`). A set bounded by its SSH keys goes only to a probe that
     * checks the whole list, so the endpoint passes the session's version; this build's own is
     * only the default for a caller that has no probe on the line.
     */
    peerVersion: number = PROTOCOL_VERSION,
    /**
     * Who it is built for, when it is built for a session (`A-72`): what the probe advertised,
     * which a flap of its protocol version is counted in, and whether the session is still the
     * probe's, without which nothing the build finds is recorded.
     */
    building?: BuildingFor,
  ): Promise<ProbeAssignments> {
    const rows = await this.#db.query<{
      sensor_id: string;
      sensor_type: string;
      params: Record<string, unknown> | null;
      host: string | null;
      ip_version: string | null;
      target_policy_exception: string[] | null;
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
             dc.ip_version  AS ip_version,
             dc.target_policy_exception AS target_policy_exception
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
    const evaluatedHere = rows.filter((row) => !this.#coreEvaluated(row.sensor_type));
    if (evaluatedHere.length === 0) {
      // **Still the whole answer for this probe, and it is nothing** (`A-41c`). Returned before
      // this was said, whatever the probe's last configuration withheld, and whatever the probe
      // itself had refused to scan, stayed held: its last sensor paused, deleted or moved to
      // another probe read Unknown until the core restarted.
      await this.#credentialCheck?.withhold(probeObjectId, [], peerVersion, building);
      return EMPTY_ASSIGNMENTS;
    }

    const resolved = await this.#credentialsFor(evaluatedHere);
    // A sensor whose credentials nobody still vouches for is not configured at all, rather than
    // sent without them: it would fail to log in and go Down, which is an alarm about the wrong
    // thing. It is held Unknown with the reason instead (`A-41`).
    const withheld =
      (await this.#credentialCheck?.withhold(
        probeObjectId,
        beingSent(evaluatedHere, resolved),
        peerVersion,
        building,
      )) ?? new Map<number, string>();
    const assignable = evaluatedHere.filter((row) => !withheld.has(Number(row.sensor_id)));
    if (assignable.length === 0) return EMPTY_ASSIGNMENTS;

    const sensorIds = assignable.map((row) => Number(row.sensor_id));
    // One query per key for the whole branch, not one per sensor: `resolveForObjects` exists
    // for exactly this, and looping the single-object resolver would be rows x keys round trips.
    const [intervals, timeouts] = await Promise.all([
      this.#resolver.resolveForObjects<number>(sensorIds, 'scan.intervalSeconds'),
      this.#resolver.resolveForObjects<number>(sensorIds, 'scan.timeoutMs'),
    ]);

    const credentials = resolved.values;
    const stamps = new Map([...resolved.stamps].filter(([id]) => !withheld.has(id)));

    const sensors: SensorAssignment[] = assignable.map((row) => {
      const sensorId = Number(row.sensor_id);
      const forSensor = credentials.get(sensorId);
      return {
        sensorId,
        sensorType: row.sensor_type,
        params: row.params ?? {},
        target: targetFor(row, peerVersion),
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
    /**
     * What the probe **on the line now** speaks, or 0 when none is (`A-41c`). It decides whether
     * a set bounded by its targets or its SSH keys may be sent, so it is the version of the
     * session the query goes to and nothing else. The registration row is not that: it records
     * what a probe last *said*, and a hello that was then refused says whatever it likes while
     * an older probe holds the connection. Absent, nobody is on the line, and the answer carries
     * no assignment (`A-52`).
     */
    peerVersionOf: (probeObjectId: number) => number = () => 0,
  ): Promise<CheckNowAssignment | null> {
    const [row] = await this.#db.query<{
      probe_id: string | null;
      sensor_type: string;
      params: Record<string, unknown> | null;
      host: string | null;
      ip_version: string | null;
      target_policy_exception: string[] | null;
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
             dc.ip_version AS ip_version,
             dc.target_policy_exception AS target_policy_exception
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
    // Asked, and not held: pressing the button changes nothing about the sensor (`A-41`). The
    // probe's version is its live session's (`A-41b`, `A-41c`).
    //
    // **With nobody on the line there is no version to decide against** (`A-52`). Asked as the
    // oldest probe, a set only a new enough probe may be sent was refused in the words for a
    // probe that is too old, and upgrading a probe that is merely not connected fixes nothing. So
    // the question is asked as this build's own version, which leaves the refusals no probe would
    // change (nobody vouches, the device is outside the targets, the transport cannot be held to
    // an address) with their sentences, and whatever is left is answered below: not connected.
    const probeObjectId = Number(row.probe_id);
    const peerVersion = peerVersionOf(probeObjectId);
    const connected = peerVersion > 0;
    // While the probe's version flaps, at the version its configurations are judged at (`A-72`):
    // a sensor the flap holds is refused in the words it stands Unknown with, and not run, which
    // a result the core then dropped as made for a withheld sensor would have shown as nothing.
    const judged = connected
      ? (this.#credentialCheck?.judgedVersion?.(probeObjectId, peerVersion) ?? peerVersion)
      : PROTOCOL_VERSION;
    const refused = await this.#credentialCheck?.refusals(
      probeObjectId,
      beingSent([{ sensor_id: String(sensorId), ...row }], credentials),
      judged,
      connected ? peerVersion : judged,
    );
    const withheld = refused?.get(sensorId);
    if (withheld !== undefined) {
      throw new ObjectError('OBJECT_CREDENTIALS_WITHHELD', withheld, {
        context: { objectId: sensorId, phase: 'check-now' },
      });
    }
    // Nothing is built for a probe that is not there. What a set may be sent was decided for no
    // probe, so there is no assignment to hand to one that connects a moment later.
    if (!connected) return { probeObjectId, peerVersion: 0, assignment: null };
    const forSensor = credentials.values.get(sensorId);

    return {
      probeObjectId,
      peerVersion,
      assignment: {
        sensorId,
        sensorType: row.sensor_type,
        params: row.params ?? {},
        target: targetFor(row, peerVersion),
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
    const owners = new Map<number, Map<string, number>>();
    const restrictions = new Map<number, Map<string, CredentialRestriction>>();
    if (this.#vault === undefined) return { values: new Map(), stamps, owners, restrictions };

    const byKindSet = new Map<string, { kinds: string[]; sensorIds: number[] }>();
    for (const row of rows) {
      const kinds = this.#credentialKindsFor(row.sensor_type);
      if (kinds.length === 0) continue;
      const key = [...kinds].sort().join(',');
      const bucket = byKindSet.get(key) ?? { kinds: [...kinds].sort(), sensorIds: [] };
      bucket.sensorIds.push(Number(row.sensor_id));
      byKindSet.set(key, bucket);
    }
    if (byKindSet.size === 0) return { values: new Map(), stamps, owners, restrictions };

    const out = new Map<number, Record<string, Record<string, unknown>>>();
    for (const { kinds, sensorIds } of byKindSet.values()) {
      const resolved = await this.#vault.resolveFor(sensorIds, kinds as CredentialKind[]);
      for (const [sensorId, byKind] of resolved) {
        const values: Record<string, Record<string, unknown>> = {};
        const marks: string[] = [];
        const ownedBy = new Map<string, number>();
        const bounds = new Map<string, CredentialRestriction>();
        // Sorted, so the same credentials in a different map order fingerprint the same.
        for (const kind of [...byKind.keys()].sort()) {
          const entry = byKind.get(kind);
          /* c8 ignore next -- the key came from this map */
          if (entry === undefined) continue;
          values[kind] = entry.values;
          marks.push(`${kind}=${entry.stamp}`);
          ownedBy.set(kind, entry.ownerId);
          bounds.set(kind, restrictionOf(kind, entry.values));
        }
        out.set(sensorId, values);
        stamps.set(sensorId, marks.join('|'));
        owners.set(sensorId, ownedBy);
        restrictions.set(sensorId, bounds);
      }
    }
    return { values: out, stamps, owners, restrictions };
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
  /** The object each sensor's set of each kind is stored on (`A-41`). */
  owners: Map<number, Map<string, number>>;
  /** What bounds each sensor's set of each kind (`A-41b`). */
  restrictions: Map<number, Map<string, CredentialRestriction>>;
}

/**
 * Where a sensor points, as the probe that scans it is told (`A-64`): its device's host and
 * family, and the device's exception to the target policy where it has one and the probe can be
 * sent it.
 *
 * **Not to a probe below 28** (`targetPolicyException`). `target` is a closed schema on the
 * probe, so an older one would refuse the whole configuration for the field; left out, it refuses
 * those addresses as its policy says, which is what it did before there was an exception.
 */
function targetFor(
  row: {
    host: string | null;
    ip_version: string | null;
    target_policy_exception: string[] | null;
  },
  peerVersion: number,
): SensorAssignment['target'] {
  const exception = row.target_policy_exception ?? [];
  return {
    host: row.host ?? '',
    ipVersion: (row.ip_version ?? 'auto') as SensorAssignment['target']['ipVersion'],
    ...(exception.length > 0 && capabilitiesFor(peerVersion).targetPolicyException
      ? { policyException: [...exception] }
      : {}),
  };
}

/** The sensors being sent a set, as the credential check asks about them (`A-41`). */
function beingSent(
  rows: readonly {
    sensor_id: string;
    sensor_type: string;
    params: Record<string, unknown> | null;
    host: string | null;
    ip_version: string | null;
  }[],
  resolved: Pick<ResolvedCredentials, 'owners' | 'restrictions'>,
): SensorBeingSent[] {
  const sent: SensorBeingSent[] = [];
  for (const row of rows) {
    const sensorId = Number(row.sensor_id);
    const ownedBy = resolved.owners.get(sensorId);
    const bounds = resolved.restrictions.get(sensorId);
    if (ownedBy === undefined || ownedBy.size === 0) continue;
    sent.push({
      sensorId,
      sensorType: row.sensor_type,
      params: row.params ?? {},
      host: row.host ?? '',
      ipVersion: row.ip_version ?? 'auto',
      owners: ownedBy,
      ...(bounds === undefined ? {} : { restrictions: bounds }),
    });
  }
  return sent;
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
      // Only where there is one (`A-64`), so that every assignment without one hashes as it did
      // before the field existed and an upgrade re-sends nothing; where there is, a change to it
      // is a change to the sensor, and the probe is sent it.
      ...(sensor.target.policyException === undefined
        ? []
        : [sensor.target.policyException.join(',')]),
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
