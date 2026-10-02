import { createHash } from 'node:crypto';
import { isRestricted, restrictionOf, type CredentialRestriction } from '@ms/sensors';
import {
  capabilitiesFor,
  describeError,
  PROTOCOL_VERSION,
  targetVerdict,
  versionFor,
  type CheckResult,
  type Logger,
} from '@ms/shared';
import { atLeast, type AccessPrincipal, type AccessRight } from '../auth/access.js';
import type { AccountRole } from '../auth/accounts.js';
import { AuthError } from '../auth/errors.js';
import type { Queryable } from '../db/pool.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';
import type { Actor, AuditSink, Mutation } from './audit.js';
import {
  credentialVoucherOf,
  type CredentialVoucher,
  type Writer,
  type Writes,
} from './sensor-reads.js';
import type { SensorTypeGate } from './sensor-type-gate.js';
import type { ObjectId } from './types.js';
import {
  storedVoucher,
  type ReleasedHold,
  type StoredVoucher,
  type VoucherCheck,
} from './vouching.js';

/**
 * Who stands behind sending an inherited credential set where a sensor sends it (`A-41`).
 *
 * **An inherited set goes wherever the sensor points.** An administrator stores SNMP or SSH
 * credentials on a group and every sensor beneath uses them, so whoever may write a device there
 * could otherwise point it at a machine of their own and be sent them. The rule: a set reaches a
 * destination only through a voucher with `write` on the object the set is stored on — its owner.
 *
 * **A destination is the probe, the device's host and address family, and the fields the sensor
 * type names** under `kind:<id>` in `secretDestinations`. The probe is part of it because the same
 * private address behind another probe is another machine.
 *
 * Two halves, and they ask the same question. A write that brings a set somewhere new is refused
 * in its own transaction unless its writer can vouch (`vouch`); and a probe's configuration sends
 * a set only while the voucher recorded for it still can (`CredentialVouching`), so a grant taken
 * away stops the next configuration carrying it.
 */

/** Which parts of the gate this needs. */
export type CredentialTypes = Pick<
  SensorTypeGate,
  'credentialKinds' | 'credentialedTypes' | 'credentialDestination'
>;

/**
 * And whether a type connects to an address its probe checked (`A-41c`), for the two callers
 * that decide whether a restricted set is sent: the configuration, and the count a write answers.
 */
export type CredentialBoundTypes = CredentialTypes & Pick<SensorTypeGate, 'pinsAddress'>;

/**
 * The fingerprint of where a sensor sends a set: its probe, its device's host and address
 * family, and the fields its type names for that kind, in order. Opaque everywhere else.
 *
 * Hashed rather than stored as written, so the column has one size whatever a type declares.
 * `FINGERPRINT_VERSION` is part of the recipe. A change here has to bump it and keep the previous
 * computation for `adopt` to carry records over with: a record this build cannot recompute is
 * left withheld, and on a version change that would be every one.
 */
export function destinationOf(where: {
  readonly probeId: number | null;
  readonly host: string;
  readonly ipVersion: string;
  readonly fields: readonly (readonly [string, unknown])[];
}): string {
  return createHash('sha256')
    .update(JSON.stringify([where.probeId, where.host, where.ipVersion, where.fields]))
    .digest('base64url');
}

const FINGERPRINT_VERSION = 1;

/**
 * What every credentialed type says about where it sends each kind, as one value (`A-41`).
 *
 * Stored at boot, as written rather than hashed — a few kilobytes — because the next release has
 * to read it. A release that changes a declaration, a field added to `kind:http`, changes every
 * fingerprint of that type without anything having moved. `adopt` tells the two apart by
 * computing each record's fingerprint the way this recipe would, from the sensor's values now.
 */
export function recipeOf(types: CredentialTypes): string {
  const declared = [...types.credentialedTypes()].sort().map((type) => [
    type,
    [...types.credentialKinds(type)].sort().map((kind) => [
      kind,
      // The declared fields, read off a destination with no parameters at all.
      types.credentialDestination(type, kind, {}).map(([field]) => field),
    ]),
  ]);
  return JSON.stringify([FINGERPRINT_VERSION, declared]);
}

/** One type and kind's entry in a recipe. */
function declarationKey(sensorType: string, kind: string): string {
  return JSON.stringify([sensorType, kind]);
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && (value as unknown[]).every((item) => typeof item === 'string');
}

/**
 * The fields a stored recipe declared for each type and kind, or null when there is none to use:
 * the empty recipe migration 060 leaves, anything unreadable, or one made with another
 * `FINGERPRINT_VERSION`, whose fingerprints this build cannot compute.
 */
export function declarationsOf(recipe: string): Map<string, readonly string[]> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(recipe);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const [version, types] = parsed as unknown[];
  if (version !== FINGERPRINT_VERSION || !Array.isArray(types)) return null;
  const declared = new Map<string, readonly string[]>();
  for (const entry of types as unknown[]) {
    if (!Array.isArray(entry)) return null;
    const [sensorType, kinds] = entry as unknown[];
    if (typeof sensorType !== 'string' || !Array.isArray(kinds)) return null;
    for (const pair of kinds as unknown[]) {
      if (!Array.isArray(pair)) return null;
      const [kind, fields] = pair as unknown[];
      if (typeof kind !== 'string' || !isStrings(fields)) return null;
      declared.set(declarationKey(sensorType, kind), fields);
    }
  }
  return declared;
}

/** A (sensor, kind) whose set is in force, where it is stored, and where it goes now. */
export interface CredentialRoute {
  readonly sensorId: ObjectId;
  readonly sensorName: string;
  readonly sensorType: string;
  readonly kind: string;
  readonly ownerId: ObjectId;
  readonly ownerKind: string;
  readonly ownerName: string;
  /** The host, for a refusal; the fingerprint is what is compared. */
  readonly host: string;
  readonly fields: readonly (readonly [string, unknown])[];
  readonly destination: string;
  /**
   * Where an earlier release's recipe would say the set goes, from the same values: null unless
   * one was asked about and declared this type and kind (`adopt`).
   */
  readonly formerDestination: string | null;
  /** What is recorded for this pair, or null when nothing is. */
  readonly vouched: VouchedFor | null;
  /** What bounds where the set may go (`A-41b`). A restricted set is decided by that alone. */
  readonly restriction: CredentialRestriction;
}

/** One row of `sensor_credential_voucher`. */
export interface VouchedFor {
  readonly ownerId: ObjectId;
  readonly destination: string;
  readonly voucher: StoredVoucher;
}

/** What a write does about one pair. */
export type RouteVerdict = 'keep' | 'vouch' | 'refuse';

/**
 * What a write does about one (sensor, kind) it touched (`A-41`). Pure, so the rule is a table.
 *
 * - **Unchanged and the installation's**: kept. The installation never stops vouching, and
 *   swapping it for an account would make the sensor depend on that account staying enabled.
 * - **The writer can vouch**: the writer is recorded, whether or not anything moved — which is
 *   also how a sensor withheld for a voucher's lost grant is let go, by saving it.
 * - **Unchanged, and the writer cannot**: kept. A rename sends nothing anywhere new.
 * - **Changed, and the writer cannot**: refused, and the whole write with it.
 */
export function verdictFor(
  route: Pick<CredentialRoute, 'ownerId' | 'destination' | 'vouched'>,
  writerMayVouch: boolean,
): RouteVerdict {
  const vouched = route.vouched;
  const same =
    vouched !== null &&
    vouched.ownerId === route.ownerId &&
    vouched.destination === route.destination;
  if (same && vouched.voucher.kind === 'installation') return 'keep';
  if (writerMayVouch) return 'vouch';
  return same ? 'keep' : 'refuse';
}

/**
 * The (sensor, kind) pairs at or under these objects whose type uses a credential kind and whose
 * kind resolves to a set, with where each goes and what is recorded for it.
 *
 * **One query**, which walks down to the sensors and back up from each: nearest probe, nearest set
 * per kind, the device's host, and the recorded voucher. The nearest-set rule is the vault's
 * (`resolveSealedCredentials`), asked without opening anything.
 */
export async function routesAtOrUnder(
  q: Queryable,
  types: CredentialTypes,
  under: readonly ObjectId[],
  options: {
    types?: readonly string[];
    kinds?: readonly string[];
    /** The fields an earlier recipe declared, by `declarationsOf`, for `formerDestination`. */
    formerly?: ReadonlyMap<string, readonly string[]>;
  } = {},
): Promise<CredentialRoute[]> {
  const credentialed = types.credentialedTypes();
  const wanted =
    options.types === undefined
      ? credentialed
      : options.types.filter((type) => credentialed.includes(type));
  const kinds = [
    ...new Set(
      wanted.flatMap((type) =>
        types
          .credentialKinds(type)
          .filter((kind) => options.kinds === undefined || options.kinds.includes(kind)),
      ),
    ),
  ];
  if (under.length === 0 || wanted.length === 0 || kinds.length === 0) return [];

  const rows = await q.query<{
    sensor_id: string;
    sensor_name: string;
    sensor_type: string;
    params: Record<string, unknown>;
    host: string | null;
    ip_version: string | null;
    probe_id: string | null;
    kind: string;
    owner_id: string;
    owner_kind: string;
    owner_name: string;
    public_params: Record<string, unknown> | null;
    vouched_owner: string | null;
    vouched_destination: string | null;
    vouched_by: string | null;
    vouched_by_user: string | null;
  }>(
    `
    WITH RECURSIVE subtree AS (
      SELECT id, 0 AS depth FROM object WHERE id = ANY($1::bigint[])

      UNION ALL

      SELECT c.id, subtree.depth + 1
      FROM object c
      JOIN subtree ON c.parent_id = subtree.id
      WHERE subtree.depth < ${String(MAX_WALK_DEPTH)}
    ),
    sensors AS (
      -- Distinct ids, not distinct rows: two of the objects asked about can be one inside the
      -- other, and comparing parameter documents to find that out is waste.
      SELECT s.id, s.name, s.parent_id, sc.type, sc.params
      FROM (SELECT DISTINCT id FROM subtree) t
      JOIN object s         ON s.id = t.id AND s.kind = 'sensor'
      JOIN sensor_config sc ON sc.object_id = s.id
      WHERE sc.type = ANY($2::text[])
    ),
    up AS (
      SELECT s.id AS sensor_id, s.id, s.parent_id, 'sensor'::text AS kind, 0 AS depth
      FROM sensors s

      UNION ALL

      SELECT up.sensor_id, o.id, o.parent_id, o.kind::text, up.depth + 1
      FROM object o
      JOIN up ON o.id = up.parent_id
      WHERE up.depth < ${String(MAX_WALK_DEPTH)}
    ),
    owners AS (
      SELECT DISTINCT ON (up.sensor_id, cs.kind)
             up.sensor_id, cs.kind::text AS kind, cs.object_id AS owner_id, cs.public_params
      FROM up
      JOIN credential_set cs ON cs.object_id = up.id AND cs.kind::text = ANY($3::text[])
      ORDER BY up.sensor_id, cs.kind, up.depth
    ),
    probes AS (
      SELECT DISTINCT ON (up.sensor_id) up.sensor_id, up.id AS probe_id
      FROM up
      WHERE up.kind = 'probe'
      ORDER BY up.sensor_id, up.depth
    )
    SELECT s.id::text          AS sensor_id,
           s.name              AS sensor_name,
           s.type              AS sensor_type,
           s.params            AS params,
           dc.host             AS host,
           dc.ip_version       AS ip_version,
           p.probe_id::text    AS probe_id,
           ow.kind             AS kind,
           ow.owner_id::text   AS owner_id,
           o.kind::text        AS owner_kind,
           o.name              AS owner_name,
           ow.public_params    AS public_params,
           v.owner_id::text    AS vouched_owner,
           v.destination       AS vouched_destination,
           v.vouched_by        AS vouched_by,
           v.vouched_by_user::text AS vouched_by_user
    FROM owners ow
    JOIN sensors s        ON s.id = ow.sensor_id
    JOIN object o         ON o.id = ow.owner_id
    JOIN device_config dc ON dc.object_id = s.parent_id
    LEFT JOIN probes p    ON p.sensor_id = s.id
    LEFT JOIN sensor_credential_voucher v ON v.sensor_id = s.id AND v.kind::text = ow.kind
    ORDER BY s.id, ow.kind
    `,
    [under, wanted, kinds],
  );

  const routes: CredentialRoute[] = [];
  for (const row of rows) {
    // Every kind any wanted type uses was asked for, so a row can be a kind this type does not.
    if (!types.credentialKinds(row.sensor_type).includes(row.kind)) continue;
    const host = row.host ?? '';
    const probeId = row.probe_id === null ? null : Number(row.probe_id);
    const ipVersion = row.ip_version ?? 'auto';
    const fields = types.credentialDestination(row.sensor_type, row.kind, row.params);
    const declaredBefore = options.formerly?.get(declarationKey(row.sensor_type, row.kind));
    routes.push({
      sensorId: Number(row.sensor_id),
      sensorName: row.sensor_name,
      sensorType: row.sensor_type,
      kind: row.kind,
      ownerId: Number(row.owner_id),
      ownerKind: row.owner_kind,
      ownerName: row.owner_name,
      host,
      fields,
      destination: destinationOf({ probeId, host, ipVersion, fields }),
      formerDestination:
        declaredBefore === undefined
          ? null
          : destinationOf({
              probeId,
              host,
              ipVersion,
              fields: types.credentialDestination(
                row.sensor_type,
                row.kind,
                row.params,
                declaredBefore,
              ),
            }),
      vouched:
        row.vouched_owner === null || row.vouched_destination === null || row.vouched_by === null
          ? null
          : {
              ownerId: Number(row.vouched_owner),
              destination: row.vouched_destination,
              voucher: storedVoucher(row.vouched_by, row.vouched_by_user),
            },
      restriction: restrictionOf(row.kind, row.public_params ?? {}),
    });
  }
  return routes;
}

/**
 * The refusal of a write that would bring a set somewhere new (`A-41`).
 *
 * **It names the kind, the owner and where the set would go, and never the secret.** The owner is
 * no news to the writer: the credentials view of anything they can read says where its sets are
 * inherited from.
 */
export function credentialRefusal(route: CredentialRoute, sayWhich: boolean): AuthError {
  const shown = (value: unknown): string =>
    typeof value === 'string' ? value : JSON.stringify(value);
  const fields = route.fields.map(([field, value]) => `${field} ${shown(value)}`).join(', ');
  const where = route.fields.length === 0 ? route.host : `${route.host} (${fields})`;
  return new AuthError(
    'AUTH_FORBIDDEN',
    `${sayWhich ? `sensor "${route.sensorName}": ` : ''}bringing the ${route.kind} credentials ` +
      `on ${route.ownerKind} "${route.ownerName}" (#${String(route.ownerId)}) to ${where} needs ` +
      `write on that ${route.ownerKind}`,
    { kind: route.kind, ownerId: route.ownerId, needed: 'write' },
  );
}

/**
 * Refuses a write that brings an inherited credential set somewhere new unless its writer can
 * vouch for it, and records who vouched (`A-41`).
 *
 * **After the write, inside its transaction**, like `A-29`'s check: a moved subtree has its new
 * probe and its new owners above it, a created sensor has its id, and a refusal rolls the whole
 * write back. `types` narrows the sensors to what the caller knows it wrote; `kinds`, to the kind
 * a credential write touched. A write under which nothing uses a credential asks nothing further.
 */
export async function vouch(
  q: Queryable,
  types: CredentialTypes,
  writer: Writer,
  under: readonly ObjectId[],
  options: { sayWhich: boolean; types?: readonly string[]; kinds?: readonly string[] },
): Promise<void> {
  // A set bounded by its targets or its keys goes wherever they allow, whoever writes, and
  // nowhere else, whoever writes (`A-41b`): nobody vouches for it, and no write is refused for it.
  // The probe configuration asks its bounds instead, every time.
  const routes = (await routesAtOrUnder(q, types, under, options)).filter(
    (route) => !isRestricted(route.restriction),
  );
  if (routes.length === 0) return;

  const voucher = credentialVoucherOf(writer);
  let writable: ReadonlySet<ObjectId>;
  if (voucher.kind === 'installation') {
    writable = new Set(routes.map((route) => route.ownerId));
  } else {
    // Every owner a verdict turns on — unchanged pairs included, which the writer re-vouches for
    // when it can — and none that stays the installation's whoever writes.
    const open = routes.filter((route) => verdictFor(route, true) === 'vouch');
    const asked = [...new Set(open.map((route) => route.ownerId))];
    writable = asked.length === 0 ? new Set() : await voucher.writes(q, asked);
  }

  const vouched: CredentialRoute[] = [];
  for (const route of routes) {
    const verdict = verdictFor(route, writable.has(route.ownerId));
    if (verdict === 'refuse') throw credentialRefusal(route, options.sayWhich);
    if (verdict === 'vouch') vouched.push(route);
  }
  await recordVouchers(q, vouched, voucher);
}

/** Upserts one row per pair, as this voucher. */
async function recordVouchers(
  q: Queryable,
  routes: readonly CredentialRoute[],
  voucher: CredentialVoucher,
): Promise<void> {
  if (routes.length === 0) return;
  await q.query(
    `INSERT INTO sensor_credential_voucher
       (sensor_id, kind, owner_id, destination, vouched_by, vouched_by_user)
     SELECT r.sensor_id, r.kind::credential_kind, r.owner_id, r.destination, $5::text, $6::bigint
     FROM unnest($1::bigint[], $2::text[], $3::bigint[], $4::text[])
       AS r (sensor_id, kind, owner_id, destination)
     ON CONFLICT (sensor_id, kind) DO UPDATE
       SET owner_id = EXCLUDED.owner_id,
           destination = EXCLUDED.destination,
           vouched_by = EXCLUDED.vouched_by,
           vouched_by_user = EXCLUDED.vouched_by_user,
           vouched_at = now()`,
    [
      routes.map((route) => route.sensorId),
      routes.map((route) => route.kind),
      routes.map((route) => route.ownerId),
      routes.map((route) => route.destination),
      voucher.kind,
      voucher.kind === 'account' ? voucher.userId : null,
    ],
  );
}

/**
 * The writes an account stored by id can make, resolved when asked (`A-41`): for a discovery run,
 * which vouches as the account that started it or last wrote its rule, with no request to ask.
 *
 * A deleted or disabled account writes nothing, which is what makes it vouch for nothing.
 */
export function storedAccountWrites(
  rights: (
    principal: AccessPrincipal,
    objectIds: readonly number[],
    q: Queryable,
  ) => Promise<ReadonlyMap<number, AccessRight>>,
  userId: number | null,
): Writes {
  return async (q, objectIds) => {
    if (userId === null || objectIds.length === 0) return new Set();
    const [account] = await q.query<{ role: AccountRole; disabled: boolean }>(
      'SELECT role, disabled FROM user_account WHERE id = $1',
      [userId],
    );
    if (account === undefined || account.disabled) return new Set();
    const held = await rights({ userId, role: account.role }, objectIds, q);
    return new Set(objectIds.filter((id) => atLeast(held.get(id) ?? 'none', 'write')));
  };
}

/** What a withheld sensor says (`A-41`). Each is also the fix, and none names the owner. */
export const WITHHELD_CREDENTIALS = {
  unvouched:
    'Not scanned: nobody with write on where its credentials are stored has vouched for sending ' +
    'them where this sensor sends them. Saving the sensor again, as an account that has, vouches ' +
    'for it.',
  deleted:
    'Not scanned: the account that vouched for sending this sensor its credentials has been ' +
    'deleted. Saving the sensor again, as an account with write on where they are stored, ' +
    'vouches for it.',
  disabled:
    'Not scanned: the account that vouched for sending this sensor its credentials has been ' +
    'disabled. Saving the sensor again, as an account with write on where they are stored, ' +
    'vouches for it.',
  lostWrite:
    'Not scanned: the account that vouched for sending this sensor its credentials no longer has ' +
    'write on where they are stored. Saving the sensor again, as an account that has, vouches ' +
    'for it.',
  outside:
    'Not scanned: this device is outside the allowed targets of the credentials it would use, ' +
    'so they are not sent to it. Adding the device to the targets where the credentials are ' +
    'stored, or pointing it back inside them, sends them again.',
  undecided:
    'Not scanned: this device is named by host name, and the allowed targets of the credentials ' +
    'it would use name only addresses and ranges. A name is checked against those by resolving ' +
    'it and connecting to the address that was checked, and this kind of sensor connects ' +
    'through a driver that resolves the name itself. Giving the device its address, or adding ' +
    'its name or *.domain to the targets, sends them again.',
  probeCannotPin:
    'Not scanned: this device is named by host name, and the allowed targets of the credentials ' +
    'it would use name only addresses and ranges. Its probe is too old to resolve the name ' +
    'once and connect to the address it checked. Upgrading the probe to protocol ' +
    `${String(versionFor('credentialAddressPinning'))} sends them again, and so does giving the ` +
    'device its address, or adding its name or *.domain to the targets.',
  probeTooOld:
    'Not scanned: the SSH credentials it would use list host keys, and its probe is too old to ' +
    'check a server against more than one. Upgrading the probe to protocol 22 sends them again.',
} as const;

/**
 * Why a restricted set is not sent where a sensor sends it, or null when it is (`A-41b`).
 *
 * **Its bounds decide it, and nothing else does**: not who vouched, and not who wrote the sensor.
 * Inside the targets, every sensor gets it; outside them, none does. A device named by host name
 * against targets that name only addresses is not the core's to decide: it does not resolve
 * names. It is sent to a probe that resolves the name once and connects to the address it
 * checked, for a sensor whose transport can be held to one (`A-41c`), and refused otherwise: for
 * an older probe, and for a transport that resolves the name itself. And a set bounded
 * by its SSH keys goes only to a probe that checks the whole list: an older one reads the one
 * fingerprint and would log in to a server the list does not name.
 */
export function boundRefusal(
  restriction: CredentialRestriction,
  host: string,
  peerVersion: number,
  /**
   * Whether the sensor's type connects to an address its probe checked, with this kind
   * (`A-41c`). False withholds a name facing address targets, as before `A-41c`.
   */
  pinsAddress = false,
): string | null {
  if (restriction.targets.length > 0) {
    const verdict = targetVerdict(host, restriction.targets);
    if (verdict === 'outside') return WITHHELD_CREDENTIALS.outside;
    if (verdict === 'undecided') {
      // **The probe decides it, and only a probe that can** (`A-41c`). It resolves the name once,
      // checks every address against the targets, and connects to one it checked. Two things
      // have to hold, and either failing withholds the set as before: the transport takes an
      // address to connect to, and the probe is new enough to do the check at all. A probe below
      // that version would be sent the set and connect by name.
      if (!pinsAddress) return WITHHELD_CREDENTIALS.undecided;
      if (!capabilitiesFor(peerVersion).credentialAddressPinning) {
        return WITHHELD_CREDENTIALS.probeCannotPin;
      }
    }
  }
  if (restriction.hostKeys !== null && !capabilitiesFor(peerVersion).credentialHostKeys) {
    return WITHHELD_CREDENTIALS.probeTooOld;
  }
  return null;
}

/**
 * The sensors a set's bounds keep it from, after a write (`A-41b`): the ones that resolve to it
 * and are outside its targets, or undecided against them with a transport that cannot be held to
 * a checked address. None for an unrestricted set.
 *
 * **A named device a probe will check is not among them** (`A-41c`): whether its name resolves
 * inside the targets is the probe's to find out, at each scan, and the write cannot know.
 *
 * Read in the write's transaction, for the response and the audit entry, so that narrowing a
 * set's targets says how many sensors it is about to take to Unknown before anybody finds out
 * from the sensors. The probe's version is not the write's business and is not counted.
 *
 * **The sensors, not their number** (`U-21`). The whole subtree is walked, whoever asks, because
 * that is what the set reaches. How many of them a caller is told about is the caller's view, and
 * the one who answers counts the ids it can see (`ObjectService.#seenAmong`).
 */
export async function withheldByBounds(
  q: Queryable,
  types: CredentialBoundTypes,
  ownerId: ObjectId,
  kind: string,
): Promise<ObjectId[]> {
  const routes = await routesAtOrUnder(q, types, [ownerId], { kinds: [kind] });
  const sensors = new Set<ObjectId>();
  for (const route of routes) {
    if (route.ownerId !== ownerId || !isRestricted(route.restriction)) continue;
    const pins = types.pinsAddress(route.sensorType, route.kind);
    if (boundRefusal(route.restriction, route.host, PROTOCOL_VERSION, pins) !== null) {
      sensors.add(route.sensorId);
    }
  }
  return [...sensors];
}

/**
 * The sensors at or beneath `ownerId` that resolve this kind to the set stored on it (`U-21`): what
 * removing that set takes it from. The nearest-set rule is `routesAtOrUnder`'s, so a sensor under
 * a device with a set of its own is not counted against the group's. The ids, for the same reason
 * `withheldByBounds` answers ids.
 */
export async function sensorsUsing(
  q: Queryable,
  types: CredentialTypes,
  ownerId: ObjectId,
  kind: string,
): Promise<ObjectId[]> {
  const routes = await routesAtOrUnder(q, types, [ownerId], { kinds: [kind] });
  return [
    ...new Set(routes.filter((route) => route.ownerId === ownerId).map((route) => route.sensorId)),
  ];
}

/** One sensor a probe's configuration is about to send credentials to. */
export interface SensorBeingSent {
  readonly sensorId: number;
  readonly sensorType: string;
  readonly params: Record<string, unknown>;
  readonly host: string;
  readonly ipVersion: string;
  /** The object each kind's set in force is stored on, as the vault resolved it. */
  readonly owners: ReadonlyMap<string, number>;
  /**
   * What bounds each kind's set (`A-41b`), read from its public half. A kind absent here is
   * unbounded, and `A-41`'s voucher decides it.
   */
  readonly restrictions?: ReadonlyMap<string, CredentialRestriction>;
}

export interface CredentialVouchingOptions {
  db: Queryable & { tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> };
  logger: Logger;
  sensorTypes: CredentialBoundTypes;
  /** What each account may do to each owner: `AccessService.resolveManyFor`. */
  rights: (
    principal: AccessPrincipal,
    objectIds: readonly number[],
    q: Queryable,
  ) => Promise<ReadonlyMap<number, AccessRight>>;
  /** Where a withheld sensor is held Unknown: `A-29`'s set, which the state machine reads. */
  vouching?: ProbeRefusalHolds;
  /** Where `adopt` records what it did, one entry per kind. */
  audit?: AuditSink;
}

/** What one boot's `adopt` did. */
export interface Adoption {
  /** Pairs nobody had vouched for, recorded as the installation's: the first boot after 060. */
  adopted: number;
  /** Pairs the recipe moved and whose record matched the recipe before: carried over. */
  refingerprinted: number;
  /** Pairs the recipe moved whose record matched neither: left withheld. */
  withheld: number;
}

const NOTHING_ADOPTED: Adoption = { adopted: 0, refingerprinted: 0, withheld: 0 };

/** One kind's line in `adopt`'s audit entry. */
interface KindTally {
  installation: number;
  carried: number;
  withheld: number;
}

/** Who `adopt`'s audit entries are by: the core, at boot. */
const ADOPTING: Actor = { kind: 'system', component: 'credential-vouching' };

export interface CredentialVouchingStats {
  /** Sensors whose credentials were checked before being sent. */
  checked: number;
  /**
   * Sensors withheld at the last check of each probe, and those a probe is refusing to scan
   * because their name resolves outside their credentials' targets (`A-41c`).
   */
  withheld: number;
}

/** One sensor a probe refused to scan (`A-41c`), and when it last said so, by its own clock. */
interface ProbeRefusal {
  readonly at: number;
  readonly message: string;
}

/**
 * What this needs of `SensorVouching`: the sweep's `settle` for what the core withholds itself,
 * and for what a probe refuses, a settle that says when it did not land and a release that
 * re-decides nothing (`A-41c`).
 */
export interface ProbeRefusalHolds extends Pick<VoucherCheck, 'settle'> {
  settleOrThrow(owner: string, refused: ReadonlyMap<number, string>, at?: Date): Promise<number>;
  release(owner: string, sensorIds: readonly number[]): ReleasedHold;
}

/** What `reported` made of one probe's batch (`A-41c`). */
export interface ReportedBatch {
  /** The results left for the state machine. */
  readonly results: readonly CheckResult[];
  /**
   * Results marked `withheld` that were not this probe's to mark: not an error with no readings,
   * or for a sensor it was not left to check. Kept in `results`, as the results they are without
   * the mark, and counted by the caller.
   */
  readonly unearned: number;
  /**
   * Says what became of `results`. Stored, a master among the sensors they let go settles what
   * depends on it. Not stored, the sensors are held again as they were: the probe sends the batch
   * again, and lets them go then. Never throws.
   */
  stored(landed: boolean): Promise<void>;
}

const NOTHING_LET_GO = (): Promise<void> => Promise.resolve();

/** The result without the mark it had no claim to. */
function unmarked(result: CheckResult): CheckResult {
  const plain = { ...result };
  delete plain.withheld;
  return plain;
}

/** Whether two sets of refusals say the same words about the same sensors. */
function sameWords(
  a: ReadonlyMap<number, ProbeRefusal> | undefined,
  b: ReadonlyMap<number, ProbeRefusal>,
): boolean {
  if ((a?.size ?? 0) !== b.size) return false;
  for (const [sensorId, refusal] of b) {
    if (a?.get(sensorId)?.message !== refusal.message) return false;
  }
  return true;
}

interface Account {
  readonly role: AccountRole;
  readonly disabled: boolean;
}

/**
 * The continuous half (`A-41`): whether a probe's configuration may carry each sensor's
 * credentials, asked every time one is built.
 *
 * **A fixed number of queries a build**: the recorded rows and the vouching accounts with the
 * access epoch, then one rights lookup per account for owners it has not been asked about at this
 * epoch. Every grant, membership and move bumps the epoch, so a steady installation asks two.
 *
 * **A withheld sensor is left out of the configuration**, not sent without its credentials: it
 * would fail to log in and go Down, which is an alarm about the wrong thing. It is held Unknown
 * through `A-29`'s set instead, under one owner per probe.
 */
export class CredentialVouching {
  readonly #db: CredentialVouchingOptions['db'];
  readonly #logger: Logger;
  readonly #types: CredentialBoundTypes;
  readonly #rights: CredentialVouchingOptions['rights'];
  readonly #vouching: ProbeRefusalHolds | undefined;
  readonly #audit: AuditSink | undefined;

  #epoch: string | null = null;
  /** Keyed by account and role: a role is a ceiling, and changing it does not move the epoch. */
  readonly #writable = new Map<string, Map<number, boolean>>();
  readonly #withheldByProbe = new Map<number, number>();
  /** What each probe is refusing to scan, by sensor (`A-41c`). */
  readonly #refusedByProbe = new Map<number, Map<number, ProbeRefusal>>();
  /**
   * The sensors each probe was sent with a set whose targets left the host for it to check
   * (`A-41c`), at its last configuration. Only these can be refused by it.
   */
  readonly #leftToProbe = new Map<number, ReadonlySet<number>>();
  #checked = 0;

  constructor(options: CredentialVouchingOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'credential-vouching' });
    this.#types = options.sensorTypes;
    this.#rights = options.rights;
    this.#vouching = options.vouching;
    this.#audit = options.audit;
  }

  stats(): CredentialVouchingStats {
    let withheld = 0;
    for (const count of this.#withheldByProbe.values()) withheld += count;
    for (const refused of this.#refusedByProbe.values()) withheld += refused.size;
    return { checked: this.#checked, withheld };
  }

  /**
   * Which of these sensors may not be sent their credentials by this probe, with the sentence
   * for each. Asks, and changes nothing: `withhold` is the one that holds them.
   */
  refusals(
    probeId: number,
    sensors: readonly SensorBeingSent[],
    /** What the probe speaks, which decides whether it may be sent a set bounded by its keys. */
    peerVersion: number = PROTOCOL_VERSION,
  ): Promise<Map<number, string>> {
    return this.#check(probeId, sensors, peerVersion, new Set());
  }

  /** `refusals`, noting in `left` each sensor sent a set its probe has to check a name against. */
  async #check(
    probeId: number,
    sensors: readonly SensorBeingSent[],
    peerVersion: number,
    left: Set<number>,
  ): Promise<Map<number, string>> {
    const refused = new Map<number, string>();
    const sent = sensors.filter((sensor) => sensor.owners.size > 0);
    this.#checked += sent.length;
    if (sent.length === 0) return refused;

    const rows = await this.#db.query<{
      sensor_id: string;
      kind: string;
      owner_id: string;
      destination: string;
      vouched_by: string;
      vouched_by_user: string | null;
    }>(
      `SELECT sensor_id::text AS sensor_id, kind::text AS kind, owner_id::text AS owner_id,
              destination, vouched_by, vouched_by_user::text AS vouched_by_user
       FROM sensor_credential_voucher
       WHERE sensor_id = ANY($1::bigint[])`,
      [sent.map((sensor) => sensor.sensorId)],
    );
    const recorded = new Map<string, VouchedFor>();
    for (const row of rows) {
      recorded.set(`${row.sensor_id}:${row.kind}`, {
        ownerId: Number(row.owner_id),
        destination: row.destination,
        voucher: storedVoucher(row.vouched_by, row.vouched_by_user),
      });
    }

    // First pass: the pairs whose record no longer matches, and the owners each account has to
    // be asked about for the rest.
    const asks = new Map<number, Set<number>>();
    const pending: { sensorId: number; userId: number | null; ownerId: number }[] = [];
    for (const sensor of sent) {
      for (const [kind, ownerId] of sensor.owners) {
        const restriction = sensor.restrictions?.get(kind);
        if (restriction !== undefined && isRestricted(restriction)) {
          const refusal = boundRefusal(
            restriction,
            sensor.host,
            peerVersion,
            this.#types.pinsAddress(sensor.sensorType, kind),
          );
          if (refusal !== null) refused.set(sensor.sensorId, refusal);
          else if (targetVerdict(sensor.host, restriction.targets) === 'undecided') {
            left.add(sensor.sensorId);
          }
          continue;
        }
        const vouched = recorded.get(`${String(sensor.sensorId)}:${kind}`);
        const destination = destinationOf({
          probeId,
          host: sensor.host,
          ipVersion: sensor.ipVersion,
          fields: this.#types.credentialDestination(sensor.sensorType, kind, sensor.params),
        });
        if (
          vouched === undefined ||
          vouched.ownerId !== ownerId ||
          vouched.destination !== destination
        ) {
          refused.set(sensor.sensorId, WITHHELD_CREDENTIALS.unvouched);
          continue;
        }
        if (vouched.voucher.kind === 'installation') continue;
        const userId = vouched.voucher.userId;
        pending.push({ sensorId: sensor.sensorId, userId, ownerId });
        if (userId !== null) asks.set(userId, (asks.get(userId) ?? new Set<number>()).add(ownerId));
      }
    }
    if (pending.length === 0) return refused;

    const accounts = await this.#accounts([...asks.keys()]);
    const writable = new Map<number, ReadonlyMap<number, boolean>>();
    for (const [userId, owners] of asks) {
      const account = accounts.get(userId);
      if (account === undefined || account.disabled) continue;
      writable.set(userId, await this.#writableFor(userId, account, [...owners]));
    }

    for (const { sensorId, userId, ownerId } of pending) {
      if (refused.has(sensorId)) continue;
      const account = userId === null ? undefined : accounts.get(userId);
      if (userId === null || account === undefined) {
        refused.set(sensorId, WITHHELD_CREDENTIALS.deleted);
      } else if (account.disabled) {
        refused.set(sensorId, WITHHELD_CREDENTIALS.disabled);
      } else if (writable.get(userId)?.get(ownerId) !== true) {
        refused.set(sensorId, WITHHELD_CREDENTIALS.lostWrite);
      }
    }
    return refused;
  }

  /**
   * `refusals`, and the answer held as the live fact the state machine reads, under this probe.
   *
   * The whole answer for the probe, so a sensor withheld last time and not sent now — paused,
   * moved to another probe, vouched for again — is let go.
   */
  async withhold(
    probeId: number,
    sensors: readonly SensorBeingSent[],
    peerVersion: number = PROTOCOL_VERSION,
  ): Promise<Map<number, string>> {
    const left = new Set<number>();
    const refused = await this.#check(probeId, sensors, peerVersion, left);
    // A sensor refused for another of its kinds is not sent at all, and so not the probe's.
    for (const sensorId of refused.keys()) left.delete(sensorId);
    if (left.size === 0) this.#leftToProbe.delete(probeId);
    else this.#leftToProbe.set(probeId, left);
    const before = this.#withheldByProbe.get(probeId) ?? 0;
    if (refused.size === 0) this.#withheldByProbe.delete(probeId);
    else this.#withheldByProbe.set(probeId, refused.size);
    if (refused.size !== before) {
      this.#logger.info(
        { probeId, withheld: refused.size, before },
        'sensors withheld from their probe because of who vouched for their credentials',
      );
    }
    await this.#vouching?.settle(`credentials:${String(probeId)}`, refused);
    // What the probe was refusing to scan stands only for a sensor it is still being sent
    // (`A-41c`): one paused, moved away, deleted or withheld here is no longer the probe's to
    // refuse, and its own reason is the one that speaks for it now.
    const sent = new Set(sensors.map((sensor) => sensor.sensorId).filter((id) => !refused.has(id)));
    await this.#keepReported(probeId, (sensorId) => sent.has(sensorId));
    return refused;
  }

  /**
   * Takes the checks a probe refused out of its batch, and holds their sensors Unknown with what
   * the probe said (`A-41c`). Returns the results that are left, for the state machine.
   *
   * **A refused check is not a failed scan.** The probe resolved the device's name, found an
   * address outside the credentials' targets, or none, and sent the device nothing. Counted as a
   * failure it would turn the sensor Down, an alarm about a device nobody asked anything of. So
   * it never reaches the machine: the sensor is held through the set `A-41` withholds with, under
   * this probe's own name, and reads Unknown with the probe's sentence.
   *
   * **Only a refusal the probe could have made.** The mark is honoured on an error with no
   * readings, for a sensor this probe was sent with a set whose targets left the name for it to
   * check. Any other result that carries it is the result it would be without it, and is counted:
   * a probe cannot turn a failure of a sensor it merely owns into a standing Unknown.
   *
   * **The next result that is not a refusal lets it go, and that result decides the sensor.** The
   * hold is dropped without re-deciding anything, so the machine makes one transition, from
   * Unknown to what the result says. Re-decided first, a sensor that was Down before the refusal
   * would pass through Down again on its way to Up, with an alarm for it. Ordered by the probe's
   * clock, since a spool replays: a refusal older than the last thing known about the sensor
   * holds nothing, and an older reading lets nothing go.
   *
   * **A result from the probe a sensor is under now lets go what another probe refused.** The
   * sensor was moved, and the probe it left may never be sent another configuration.
   *
   * **What this holds and what the set holds move together.** A new refusal is written here only
   * once the set has taken it; when it does not, this throws, nothing has moved, and the caller
   * has the probe send the batch again.
   */
  async reported(
    probeId: number,
    results: readonly CheckResult[],
    /** When the machine last took a result for a sensor, if it has. */
    lastResultAt: (sensorId: number) => Date | null | undefined = () => undefined,
  ): Promise<ReportedBatch> {
    // Nothing held by anyone and nothing marked, which is every batch of every probe but a few.
    if (this.#refusedByProbe.size === 0 && !results.some((result) => result.withheld === true)) {
      return { results, unearned: 0, stored: NOTHING_LET_GO };
    }

    const held = this.#refusedByProbe.get(probeId);
    const left = this.#leftToProbe.get(probeId);
    const refused = new Map(held);
    const kept: CheckResult[] = [];
    /** Sensors with a result that is not a refusal, which is what lets a hold go. */
    const measured = new Set<number>();
    const letGo = new Set<number>();
    /** When the first refusal that says something new was made, by the probe's clock. */
    let news: number | undefined;
    let unearned = 0;
    const inOrder = [...results].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (const result of inOrder) {
      const at = Date.parse(result.at);
      const holding = refused.get(result.sensorId);
      const earned =
        result.withheld === true &&
        result.outcome === 'error' &&
        result.channels.length === 0 &&
        left?.has(result.sensorId) === true;
      if (!earned) {
        if (result.withheld === true) {
          unearned += 1;
          kept.push(unmarked(result));
        } else {
          kept.push(result);
        }
        if (!Number.isNaN(at)) measured.add(result.sensorId);
        if (holding !== undefined && at > holding.at) {
          refused.delete(result.sensorId);
          letGo.add(result.sensorId);
        }
        continue;
      }
      // A time nobody can read orders against nothing. Left for the machine's own gate, which
      // drops and counts it; it holds nothing.
      if (Number.isNaN(at)) {
        kept.push(result);
        continue;
      }
      const known = holding?.at ?? lastResultAt(result.sensorId)?.getTime();
      if (known !== undefined && at <= known) continue;
      refused.set(result.sensorId, { at, message: result.message });
      letGo.delete(result.sensorId);
      if (held?.get(result.sensorId)?.message !== result.message) news = Math.min(news ?? at, at);
    }

    // What the set has to hold before anything is let go: every refusal that stands, and still
    // the ones a result in this batch is about to release.
    const holdsNow = new Map(refused);
    for (const sensorId of letGo) {
      const was = held?.get(sensorId);
      if (was !== undefined) holdsNow.set(sensorId, was);
    }
    // The same words at a later time move nothing anybody reads, and settle nothing.
    // Stamped as the probe measured it, as a result's transition is, so that the reading which
    // lets it go sorts after it whatever the two clocks say. Never ahead of this core's clock: a
    // refusal does not pass the gate that drops a result stamped in the future.
    if (!sameWords(held, holdsNow)) {
      await this.#settleReported(
        probeId,
        holdsNow,
        news === undefined ? undefined : new Date(Math.min(news, Date.now())),
      );
    }

    const releases: { probeId: number; was: Map<number, ProbeRefusal>; hold: ReleasedHold }[] = [];
    const release = (owner: number, sensorIds: readonly number[]): void => {
      const now = this.#refusedByProbe.get(owner);
      const was = new Map<number, ProbeRefusal>();
      for (const sensorId of sensorIds) {
        const refusal = now?.get(sensorId);
        if (refusal !== undefined) was.set(sensorId, refusal);
      }
      if (now === undefined || was.size === 0) return;
      this.#store(owner, new Map([...now].filter(([sensorId]) => !was.has(sensorId))));
      const hold = this.#vouching?.release(`credentials-probe:${String(owner)}`, [...was.keys()]);
      if (hold !== undefined) releases.push({ probeId: owner, was, hold });
    };

    this.#store(probeId, holdsNow);
    release(probeId, [...letGo]);
    for (const other of [...this.#refusedByProbe.keys()]) {
      if (other !== probeId) release(other, [...measured]);
    }

    if (releases.length === 0) return { results: kept, unearned, stored: NOTHING_LET_GO };
    return {
      results: kept,
      unearned,
      stored: async (landed) => {
        for (const { probeId: owner, was, hold } of releases) {
          if (landed) {
            await hold.evaluated();
            continue;
          }
          hold.undo();
          const now = new Map(this.#refusedByProbe.get(owner));
          // Whatever was refused again meanwhile keeps its newer words.
          for (const [sensorId, refusal] of was) if (!now.has(sensorId)) now.set(sensorId, refusal);
          this.#store(owner, now);
        }
      },
    };
  }

  /**
   * Drops what a probe refused for sensors that are no longer under it, and everything held for
   * a probe that no longer exists (`A-41c`). Never throws.
   *
   * For a move or a delete, which no configuration may ever follow: the probe a sensor left has
   * nothing left to scan, or is not connected, or is gone. Without this its last refusal held the
   * sensor Unknown, under a probe that could no longer say otherwise, until the core restarted.
   */
  async reconcile(): Promise<void> {
    try {
      const probes = new Set([
        ...this.#refusedByProbe.keys(),
        ...this.#leftToProbe.keys(),
        ...this.#withheldByProbe.keys(),
      ]);
      if (probes.size === 0) return;
      const sensors = new Set<number>();
      for (const refused of this.#refusedByProbe.values()) {
        for (const sensorId of refused.keys()) sensors.add(sensorId);
      }
      const rows = await this.#db.query<{ kind: string; id: string; probe_id: string | null }>(
        `WITH RECURSIVE up AS (
           SELECT id AS sensor_id, id, parent_id, kind, 0 AS depth
           FROM object WHERE id = ANY($1::bigint[]) AND kind = 'sensor'
           UNION ALL
           SELECT up.sensor_id, o.id, o.parent_id, o.kind, up.depth + 1
           FROM object o JOIN up ON up.parent_id = o.id
           WHERE up.depth < ${String(MAX_WALK_DEPTH)}
         )
         SELECT 'sensor' AS kind, s.sensor_id::text AS id,
                (SELECT up.id::text FROM up
                 WHERE up.sensor_id = s.sensor_id AND up.kind = 'probe'
                 ORDER BY up.depth LIMIT 1) AS probe_id
         FROM (SELECT DISTINCT sensor_id FROM up) s
         UNION ALL
         SELECT 'probe' AS kind, id::text AS id, NULL AS probe_id
         FROM object WHERE id = ANY($2::bigint[]) AND kind = 'probe'`,
        [[...sensors], [...probes]],
      );
      const under = new Map<number, number | null>();
      const existing = new Set<number>();
      for (const row of rows) {
        if (row.kind === 'probe') existing.add(Number(row.id));
        else under.set(Number(row.id), row.probe_id === null ? null : Number(row.probe_id));
      }
      for (const probeId of probes) {
        const gone = !existing.has(probeId);
        await this.#keepReported(probeId, (sensorId) => !gone && under.get(sensorId) === probeId);
        if (!gone) continue;
        // Nothing is sent to a probe that does not exist, and nothing is withheld from it.
        this.#leftToProbe.delete(probeId);
        if (this.#withheldByProbe.delete(probeId)) {
          await this.#vouching?.settle(`credentials:${String(probeId)}`, new Map());
        }
      }
    } catch (error: unknown) {
      this.#logger.error(
        { err: describeError(error) },
        'could not check which refused sensors are still under their probe; the next move or ' +
          'delete tries again',
      );
    }
  }

  /**
   * Drops what a probe refused for every sensor `keep` does not answer for, in the set first and
   * here only once the set has let them go. A settle that fails leaves both as they were, for
   * the next configuration or the next move to try again.
   */
  async #keepReported(probeId: number, keep: (sensorId: number) => boolean): Promise<void> {
    const held = this.#refusedByProbe.get(probeId);
    if (held === undefined) return;
    const refused = new Map([...held].filter(([sensorId]) => keep(sensorId)));
    if (refused.size === held.size) return;
    try {
      await this.#settleReported(probeId, refused);
    } catch (error: unknown) {
      this.#logger.error(
        { probeId, err: describeError(error) },
        'could not let go the sensors a probe is no longer sent; they stay held until the next ' +
          'configuration',
      );
      return;
    }
    this.#store(probeId, refused);
  }

  #store(probeId: number, refused: Map<number, ProbeRefusal>): void {
    if (refused.size === 0) this.#refusedByProbe.delete(probeId);
    else this.#refusedByProbe.set(probeId, refused);
  }

  /** Has the set hold exactly these for the probe. Throws when it could not, with nothing moved. */
  async #settleReported(
    probeId: number,
    refused: ReadonlyMap<number, ProbeRefusal>,
    at?: Date,
  ): Promise<void> {
    this.#logger.info(
      { probeId, refused: refused.size },
      'sensors a probe refuses to scan because of where their credentials may go',
    );
    await this.#vouching?.settleOrThrow(
      `credentials-probe:${String(probeId)}`,
      new Map([...refused].map(([sensorId, refusal]) => [sensorId, refusal.message])),
      at,
    );
  }

  async #accounts(userIds: readonly number[]): Promise<Map<number, Account>> {
    const rows = await this.#db.query<{
      epoch: string;
      id: string | null;
      role: AccountRole | null;
      disabled: boolean | null;
    }>(
      `SELECT e.value::text AS epoch, u.id::text AS id, u.role, u.disabled
       FROM access_epoch e
       LEFT JOIN user_account u ON u.id = ANY($1::bigint[])`,
      [userIds],
    );
    const epoch = rows[0]?.epoch ?? '0';
    if (epoch !== this.#epoch) {
      this.#epoch = epoch;
      this.#writable.clear();
    }
    const accounts = new Map<number, Account>();
    for (const row of rows) {
      if (row.id === null || row.role === null) continue;
      accounts.set(Number(row.id), { role: row.role, disabled: row.disabled === true });
    }
    return accounts;
  }

  async #writableFor(
    userId: number,
    account: Account,
    owners: readonly number[],
  ): Promise<ReadonlyMap<number, boolean>> {
    const key = `${String(userId)}:${account.role}`;
    let known = this.#writable.get(key);
    if (known === undefined) {
      known = new Map();
      this.#writable.set(key, known);
    }
    const unknown = owners.filter((id) => !known.has(id));
    if (unknown.length === 0) return known;
    const held = await this.#rights({ userId, role: account.role }, unknown, this.#db);
    for (const id of unknown) known.set(id, atLeast(held.get(id) ?? 'none', 'write'));
    return known;
  }

  /**
   * Records the installation as voucher for every set in use, once, after migration 060 — and
   * re-fingerprints what is recorded when a release changes where a type says it sends a kind.
   *
   * **One transaction, which also clears the mark and stores the recipe**, so a crash halfway
   * leaves both for the next boot to run again whole. Run before the probe endpoint serves a
   * configuration: until it has, every credentialed sensor would read as not vouched for.
   *
   * **A record is carried to the new recipe only if the old one says it is where it was.** Its
   * stored fingerprint has to equal what the recipe before would compute from the sensor's values
   * now; then nothing but the declaration moved it, and its voucher vouched for that same place.
   * A record that matches neither recipe is left as it is, withheld until somebody who can vouches
   * — it is not adopted on the strength of a release. A record whose owner changed is not the
   * recipe's business at all.
   *
   * **One audit entry per kind**, with how many pairs were recorded as the installation's, carried
   * and left withheld — never one per sensor.
   */
  async adopt(): Promise<Adoption> {
    const recipe = recipeOf(this.#types);
    return this.#db.tx(async (q) => {
      const [mark] = await q.query<{ pending: boolean; recipe: string }>(
        'SELECT pending, recipe FROM credential_voucher_adoption FOR UPDATE',
      );
      if (mark === undefined) return NOTHING_ADOPTED;
      const recipeMoved = mark.recipe !== recipe;
      if (!mark.pending && !recipeMoved) return NOTHING_ADOPTED;

      const formerly = recipeMoved ? declarationsOf(mark.recipe) : null;
      const [root] = await q.query<{ id: string }>(
        `SELECT id::text AS id FROM object WHERE kind = 'root'`,
      );
      const routes =
        root === undefined
          ? []
          : await routesAtOrUnder(
              q,
              this.#types,
              [Number(root.id)],
              formerly === null ? {} : { formerly },
            );

      const byKind = new Map<string, KindTally>();
      const tally = (kind: string): KindTally => {
        let counts = byKind.get(kind);
        if (counts === undefined) {
          counts = { installation: 0, carried: 0, withheld: 0 };
          byKind.set(kind, counts);
        }
        return counts;
      };

      // Whatever a write recorded between the migration and now stands: it was checked.
      const fresh = mark.pending ? routes.filter((route) => route.vouched === null) : [];
      await recordVouchers(q, fresh, { kind: 'installation' });
      for (const route of fresh) tally(route.kind).installation += 1;

      const carried: CredentialRoute[] = [];
      if (recipeMoved) {
        for (const route of routes) {
          const vouched = route.vouched;
          // Only what a declaration can have moved: the same owner, another fingerprint.
          if (vouched === null || vouched.ownerId !== route.ownerId) continue;
          if (vouched.destination === route.destination) continue;
          if (vouched.destination === route.formerDestination) {
            carried.push(route);
            tally(route.kind).carried += 1;
          } else {
            tally(route.kind).withheld += 1;
          }
        }
      }
      if (carried.length > 0) {
        await q.query(
          `UPDATE sensor_credential_voucher v
           SET destination = r.destination
           FROM unnest($1::bigint[], $2::text[], $3::text[]) AS r (sensor_id, kind, destination)
           WHERE v.sensor_id = r.sensor_id AND v.kind::text = r.kind`,
          [
            carried.map((route) => route.sensorId),
            carried.map((route) => route.kind),
            carried.map((route) => route.destination),
          ],
        );
      }

      await q.query('UPDATE credential_voucher_adoption SET pending = false, recipe = $1', [
        recipe,
      ]);
      const entries: Mutation[] = [...byKind]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, counts]) => ({
          action: 'credential.adopted' as const,
          objectId: null,
          credentialKind: kind,
          ...counts,
        }));
      if (entries.length > 0) await this.#audit?.record(q, ADOPTING, entries, new Date());

      const adoption: Adoption = {
        adopted: fresh.length,
        refingerprinted: carried.length,
        withheld: [...byKind.values()].reduce((sum, counts) => sum + counts.withheld, 0),
      };
      this.#logger.info(
        {
          ...adoption,
          pending: mark.pending,
          recipeMoved,
          formerRecipeReadable: formerly !== null,
        },
        'recorded who vouches for the credentials in use',
      );
      return adoption;
    });
  }
}
