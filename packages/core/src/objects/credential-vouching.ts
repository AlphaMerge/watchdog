import { createHash } from 'node:crypto';
import { isRestricted, restrictionOf, type CredentialRestriction } from '@ms/sensors';
import {
  capabilitiesFor,
  describeError,
  pinningCapabilityFor,
  PROTOCOL_VERSION,
  targetVerdict,
  versionFor,
  type CheckResult,
  type Logger,
} from '@ms/shared';
import { atLeast, type AccessPrincipal, type AccessRight } from '../auth/access.js';
import type { AccountRole } from '../auth/accounts.js';
import { AuthError } from '../auth/errors.js';
import { DatabaseError, type Queryable, type TxLimits } from '../db/pool.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';
import type { Actor, AuditSink, Mutation } from './audit.js';
import {
  answeredSight,
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
  /** The device the sensor is on, whose address `host` is (`A-16`). */
  readonly deviceId: ObjectId;
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
    device_id: string;
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
           s.parent_id::text   AS device_id,
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
      deviceId: Number(row.device_id),
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

/** Which of a refused route's three objects its writer can see (`A-16`). */
export interface RouteSeen {
  readonly owner: boolean;
  readonly sensor: boolean;
  /** The sensor's device, whose address is where the set would go. */
  readonly device: boolean;
}

/** All three, for a writer who sees everything: the installation, or an administrator. */
const ROUTE_SEEN_WHOLE: RouteSeen = { owner: true, sensor: true, device: true };

/**
 * The refusal of a write that would bring a set somewhere new (`A-41`).
 *
 * **It names the kind, the owner and where the set would go, and never the secret.** The owner is
 * named by id alone, as the credentials view names where a set is inherited from — and by name
 * and kind only to a writer who can see it, since it is often the group or probe above the branch
 * the writer was given (`A-16`). A sensor the writer cannot see, a hole beneath the device being
 * edited, is not named, and nor is where its set would go, which is its device's address and its
 * own parameters. A sensor re-granted inside a device the writer cannot see is named, with its
 * parameters, and the device's address is not: it is the device's own fact, as `%host` is.
 */
export function credentialRefusal(
  route: CredentialRoute,
  sayWhich: boolean,
  seen: RouteSeen,
): AuthError {
  const shown = (value: unknown): string =>
    typeof value === 'string' ? value : JSON.stringify(value);
  const fields = route.fields.map(([field, value]) => `${field} ${shown(value)}`).join(', ');
  const host = seen.device ? route.host : 'a device outside your view';
  const where = !seen.sensor
    ? 'a sensor outside your view'
    : route.fields.length === 0
      ? host
      : `${host} (${fields})`;
  const owner = seen.owner
    ? `${route.ownerKind} "${route.ownerName}" (#${String(route.ownerId)})`
    : `#${String(route.ownerId)}`;
  return new AuthError(
    'AUTH_FORBIDDEN',
    `${sayWhich && seen.sensor ? `sensor "${route.sensorName}": ` : ''}bringing the ` +
      `${route.kind} credentials on ${owner} to ${where} needs write on that ` +
      (seen.owner ? route.ownerKind : 'object'),
    { kind: route.kind, ownerId: route.ownerId, needed: 'write' },
  );
}

/** What the writer of a refused route can see of it (`A-16`). */
async function seenBy(q: Queryable, writer: Writer, route: CredentialRoute): Promise<RouteSeen> {
  // Whoever is answered, which for a discovery run is the account that asked for it and not the
  // installation that vouches for its templates (`A-77`).
  const sees = await answeredSight(q, writer);
  if (sees === null) return ROUTE_SEEN_WHOLE;
  const visible = await sees.visibleAmong(q, [route.ownerId, route.sensorId, route.deviceId]);
  return {
    owner: visible.has(route.ownerId),
    sensor: visible.has(route.sensorId),
    device: visible.has(route.deviceId),
  };
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
    if (verdict === 'refuse') {
      throw credentialRefusal(route, options.sayWhich, await seenBy(q, writer, route));
    }
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
    'through a transport that resolves the name itself. Giving the device its address, or adding ' +
    'its name or *.domain to the targets, sends them again.',
  probeCannotPin:
    'Not scanned: this device is named by host name, and the allowed targets of the credentials ' +
    'it would use name only addresses and ranges. Its probe is too old to resolve the name ' +
    'once and connect to the address it checked. Upgrading the probe to protocol ' +
    `${String(versionFor('credentialAddressPinning'))} sends them again, and so does giving the ` +
    'device its address, or adding its name or *.domain to the targets.',
  probeCannotPinDatabase:
    'Not scanned: this device is named by host name, and the allowed targets of the credentials ' +
    'it would use name only addresses and ranges. Its probe is too old to connect a database ' +
    'sensor to the address it checked: its driver resolves the name itself. Upgrading the ' +
    `probe to protocol ${String(versionFor('databaseAddressPinning'))} sends them again, and so ` +
    'does giving the device its address, or adding its name or *.domain to the targets.',
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
  /**
   * The kind of the set, which says what a probe must speak to pin it (`A-62`): a database
   * set needs a newer probe than the others.
   */
  kind = '',
): string | null {
  const reason = boundRefusalReason(restriction, host, peerVersion, pinsAddress, kind);
  return reason === null ? null : WITHHELD_CREDENTIALS[reason];
}

/** Which of `WITHHELD_CREDENTIALS`' sentences a set's bounds refuse a sensor with. */
export type BoundRefusalReason =
  'outside' | 'undecided' | 'probeCannotPin' | 'probeCannotPinDatabase' | 'probeTooOld';

/**
 * `boundRefusal`, as which refusal it is and not its sentence (`A-59`): a write that counts the
 * sensors its bounds keep the set from says how many for each reason, and reads the reason here
 * and not out of the words.
 */
export function boundRefusalReason(
  restriction: CredentialRestriction,
  host: string,
  peerVersion: number,
  pinsAddress = false,
  kind = '',
): BoundRefusalReason | null {
  if (restriction.targets.length > 0) {
    const verdict = targetVerdict(host, restriction.targets);
    if (verdict === 'outside') return 'outside';
    if (verdict === 'undecided') {
      // **The probe decides it, and only a probe that can** (`A-41c`). It resolves the name once,
      // checks every address against the targets, and connects to one it checked. Two things
      // have to hold, and either failing withholds the set as before: the transport takes an
      // address to connect to, and the probe is new enough to do the check at all. A probe below
      // that version would be sent the set and connect by name.
      if (!pinsAddress) return 'undecided';
      // **The version is the kind's** (`A-62`): a probe that pins SNMP, SSH, HTTP and mail may
      // still have database drivers that resolve the name themselves.
      const needs = pinningCapabilityFor(kind);
      if (!capabilitiesFor(peerVersion)[needs]) {
        return needs === 'databaseAddressPinning' ? 'probeCannotPinDatabase' : 'probeCannotPin';
      }
    }
  }
  if (restriction.hostKeys !== null && !capabilitiesFor(peerVersion).credentialHostKeys) {
    return 'probeTooOld';
  }
  return null;
}

/**
 * Why a set's bounds keep it from a sensor, as a write counts it (`A-59`).
 *
 * - `outside`: the device's address, or its name, is not one the targets cover.
 * - `unpinnable`: the device is entered by name, the targets that could cover it are addresses,
 *   and the sensor's type cannot be held to an address its probe checked. Whatever the name
 *   resolves to, the set is not sent.
 *
 * Two, because they are mended differently: the first by widening the targets or moving the
 * device, the second by giving the device its address or naming it in the targets.
 */
export type WithheldReason = 'outside' | 'unpinnable';

/** Where one kind's sets stand for the sensors at or beneath an object (`A-41b`, `A-55`). */
export interface BoundsBeneath {
  /** The sensors that resolve the kind to the set stored on the object itself. */
  readonly reached: ReadonlySet<ObjectId>;
  /**
   * The sensors a set's bounds keep it from, **whichever object that set is stored on**: the one
   * asked about, one nearer the sensor, or an ancestor's. Each with why (`A-59`).
   */
  readonly withheld: ReadonlyMap<ObjectId, WithheldReason>;
}

/**
 * The sensors at or beneath `ownerId` that a set's bounds keep this kind's set from (`A-41b`):
 * the ones outside its targets, or undecided against them with a transport that cannot be held
 * to a checked address. None for an unrestricted set. And which sensors resolve the kind to the
 * set on `ownerId` itself, which are the ones a write there is about.
 *
 * **A named device a probe will check is not among them** (`A-41c`): whether its name resolves
 * inside the targets is the probe's to find out, at each scan, and the write cannot know.
 *
 * Read in the write's transaction, for the response and the audit entry, so that narrowing a
 * set's targets says how many sensors it is about to take to Unknown before anybody finds out
 * from the sensors. The probe's version is not the write's business and is not counted.
 *
 * **Every owner's bounds, so that a write can be compared with what stood before it** (`A-55`).
 * Asked before a write and again after it, the two answers say which sensors the write took the
 * set from and which it gave it back to. A set stored for the first time on a group replaces an
 * ancestor's for everything beneath, and a sensor the ancestor's bounds already kept its set
 * from is not one this write put outside: only an answer that reads the ancestor's bounds too
 * can tell.
 *
 * **The sensors, not their number** (`U-21`). The whole subtree is walked, whoever asks, because
 * that is what the set reaches. How many of them a caller is told about is the caller's view, and
 * the one who answers counts the ids it can see (`ObjectService.#seenOf`).
 */
export async function boundsBeneath(
  q: Queryable,
  types: CredentialBoundTypes,
  ownerId: ObjectId,
  kind: string,
): Promise<BoundsBeneath> {
  const routes = await routesAtOrUnder(q, types, [ownerId], { kinds: [kind] });
  const reached = new Set<ObjectId>();
  const withheld = new Map<ObjectId, WithheldReason>();
  for (const route of routes) {
    if (route.ownerId === ownerId) reached.add(route.sensorId);
    if (!isRestricted(route.restriction)) continue;
    const pins = types.pinsAddress(route.sensorType, route.kind);
    const reason = boundRefusalReason(
      route.restriction,
      route.host,
      PROTOCOL_VERSION,
      pins,
      route.kind,
    );
    if (reason === null) continue;
    // Asked as the newest probe, so the two refusals that are about a probe's age do not come
    // up; anything that is not the name left undecided is the device outside the targets.
    withheld.set(route.sensorId, reason === 'undecided' ? 'unpinnable' : 'outside');
  }
  return { reached, withheld };
}

/**
 * The sensors at or beneath `ownerId` that resolve this kind to the set stored on it (`U-21`): what
 * removing that set takes it from. The nearest-set rule is `routesAtOrUnder`'s, so a sensor under
 * a device with a set of its own is not counted against the group's. The ids, for the same reason
 * `boundsBeneath` answers ids.
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
  db: Queryable & { tx<T>(fn: (q: Queryable) => Promise<T>, limits?: TxLimits): Promise<T> };
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
  /**
   * How long after a configuration stops leaving a sensor to its probe a refusal from that probe
   * is still taken as made under the one before (`A-53`). `LATE_REFUSAL_GRACE_MS` when absent.
   */
  lateRefusalGraceMs?: number;
  /**
   * How long after that grace a change of the probe's protocol version alone cannot begin it
   * again for the same sensor (`A-68`). `LATE_REFUSAL_COOL_OFF_MS` when absent.
   */
  lateRefusalCoolOffMs?: number;
  /** Milliseconds on a clock that never goes back, for that window. Injected by a test. */
  now?: () => number;
  /**
   * Milliseconds on the wall clock, which is what the stored record is written in and read back
   * against at the next start (`A-61`). `Date.now` when absent. Injected by a test.
   */
  wallNow?: () => number;
  /**
   * How long a probe's protocol version has to hold for a flap to be over, and how close together
   * two changes have to come to make one (`A-72`). `PROTOCOL_FLAP_HOLD_MS` when absent; zero
   * holds nothing, for a test that asks as whichever probe a case needs.
   */
  protocolFlapHoldMs?: number;
  /**
   * Told of the probes whose flap `prune` found over (`A-72`), so that their configurations are
   * built again and what the flap held is let go now rather than at the next reconnect. The
   * notifier's push in `main.ts`. Absent, it waits for the next configuration.
   */
  onProtocolFlapOver?: (probeIds: readonly number[]) => void;
  /**
   * How long a configuration waits for its record to be stored before it goes out without
   * (`A-61`). `LATE_REFUSAL_SAVE_WAIT_MS` when absent. Injected by a test.
   */
  saveWaitMs?: number;
}

/**
 * How long a probe's protocol version has to hold before a flap is over, and how close together
 * two changes of it make one (`A-72`).
 *
 * **One outage, one alarm.** The version a probe connects with decides whether it is left its
 * named sensors (`A-41c`), so a probe that reconnects under an older version withholds them,
 * each with an Unknown and its page, and one that reconnects under the newer lets them go, each
 * with a recovery. Five alternations were three pages and two recoveries for every such sensor
 * (`A-68`, measured). A second change within this long of the one before is a flap: from it the
 * probe's configurations are judged at the lowest version the flap has spoken, so the sensors
 * that version decides stay as they stood, and Probe Health raises the one warning that names it.
 * It is over when the version has held this long, and the next configuration judges by the
 * version the probe speaks.
 *
 * An hour, as `A-68`'s window is remembered an hour: a probe rolled back and forward by people
 * does not do so twice inside one, and what it costs one that is is an hour of its named sensors
 * Unknown with a warning on its Probe Health saying why, rather than a page each way.
 */
export const PROTOCOL_FLAP_HOLD_MS = 60 * 60_000;

/**
 * What a probe's protocol version has done lately, as the core keeps it for that probe (`A-72`).
 * Times are on `CredentialVouching`'s monotonic clock.
 */
export interface VersionRecord {
  /**
   * The version the probe advertised when its last configuration was built: what it says it
   * speaks, and not what it was negotiated down to (`BuildingFor`).
   */
  readonly version: number;
  /** When that version began, or null when this record has seen no change that still counts. */
  readonly changedAt: number | null;
  /** When the run of changes it ends began: the first change of a flap. Null with no change. */
  readonly since: number | null;
  /** How many changes that run has had, each within the hold of the one before it. */
  readonly changes: number;
  /**
   * The lowest version the run has spoken since it became a flap, at its second change: what the
   * probe's configurations are judged at while it lasts. Null until then.
   */
  readonly floor: number | null;
}

/**
 * The record after a configuration is built for a probe speaking `version` at `now` (`A-72`).
 * Pure, so the rule is a table.
 *
 * - **The first configuration** starts the record, with no change.
 * - **The same version** changes nothing, except that a run whose last change is a hold old is
 *   over and forgotten, flap and all.
 * - **Another version, with no change within the hold before it**: the first change of a run.
 *   Nothing is held: the configuration is judged at the version spoken, as it always was.
 * - **Another version within the hold of the last change**: a flap, or a flap going on. The
 *   floor is the lowest of the version the last configuration was built for and every version
 *   since, so the sensors that version decides hold where they stood at the change that made
 *   it a flap, and a lower version spoken later is still never sent more than it may be.
 */
export function nextVersionRecord(
  record: VersionRecord | undefined,
  version: number,
  now: number,
  holdMs: number,
): VersionRecord {
  if (record === undefined) {
    return { version, changedAt: null, since: null, changes: 0, floor: null };
  }
  const current = settledRecord(record, now, holdMs);
  if (version === current.version) return current;
  if (current.changedAt === null) {
    return { version, changedAt: now, since: now, changes: 1, floor: null };
  }
  return {
    version,
    changedAt: now,
    since: current.since ?? current.changedAt,
    changes: current.changes + 1,
    floor: Math.min(current.floor ?? current.version, version),
  };
}

/** The record with a run that has held for `holdMs` forgotten: what it is once the version held. */
function settledRecord(record: VersionRecord, now: number, holdMs: number): VersionRecord {
  if (record.changedAt === null || now - record.changedAt < holdMs) return record;
  return { version: record.version, changedAt: null, since: null, changes: 0, floor: null };
}

/** Whether the record is a flap at `now`: two changes or more, the last within the hold. */
export function isFlapping(
  record: VersionRecord | undefined,
  now: number,
  holdMs: number,
): record is VersionRecord & { changedAt: number; since: number; floor: number } {
  return (
    record !== undefined &&
    record.floor !== null &&
    record.changedAt !== null &&
    record.since !== null &&
    now - record.changedAt < holdMs
  );
}

/**
 * The version a configuration negotiated at `peerVersion` is judged at, given the probe's record
 * (`A-72`): that version, or while the probe flaps, the floor of what it advertised if that is
 * lower. Never above the negotiated version, which is what the pair can do: a probe advertising
 * more than this core speaks flaps all the same, and is held at no more than the core's own.
 */
export function judgedAt(
  record: VersionRecord | undefined,
  peerVersion: number,
  now: number,
  holdMs: number,
): number {
  return isFlapping(record, now, holdMs) ? Math.min(record.floor, peerVersion) : peerVersion;
}

/**
 * Who a configuration is being built for (`A-72`), as the probe endpoint knows it.
 *
 * - **What the probe advertised** in its hello, which is what a flap is counted in. The version a
 *   configuration is judged at is the one the pair negotiated, the lower of this and the core's
 *   own, and a core upgraded and rolled back changes that for every probe at once. A flap is
 *   something a probe does, so it is counted in what the probe says, and a core's own version
 *   moving counts nothing.
 * - **Whether its session is still the probe's live one.** A build is chained behind its
 *   session's other work, and a session superseded or closed meanwhile can finish one after its
 *   successor's: what such a build found is not recorded, since what it would record is a
 *   connection the probe no longer has. Asked synchronously, right before anything is recorded,
 *   so a session cannot close between the asking and the recording.
 */
export interface BuildingFor {
  readonly advertisedVersion: number;
  readonly live: () => boolean;
}

/** A probe's flap as Probe Health reads it (`A-72`): what it names, and when it is over. */
export interface ProtocolFlap {
  /** The version the probe advertises now. */
  readonly version: number;
  /**
   * The lowest version it has advertised since the flap began: its configurations are judged at
   * this, or at the version negotiated with it if that is lower, while the flap lasts.
   */
  readonly floor: number;
  /** How many times the version has changed since the run began, two or more. */
  readonly changes: number;
  /** How long ago the run's first change was. */
  readonly sinceMs: number;
  /** How long the version still has to hold for the flap to be over. */
  readonly remainingMs: number;
}

/**
 * How long a refusal may trail the configuration that stopped leaving its sensor to the probe
 * (`A-53`).
 *
 * A result does not say which configuration its check ran under, so this is the bound on how
 * late one made under the last may arrive: the probe has to receive the new configuration, a
 * check already running has to finish resolving (ten seconds at most, `resolveBoundMs`), and its
 * batch has to be sent, or replayed from the spool behind what was written before it. Ten minutes
 * is generous for all three and short against what it costs: for that long, and no longer, the
 * probe can have an error with no readings for such a sensor discarded, which it could as well
 * have not sent.
 */
export const LATE_REFUSAL_GRACE_MS = 10 * 60_000;

/**
 * How long after a grace has run out the sensor's window is still remembered, so that the probe
 * cannot begin another by what it says alone (`A-68`).
 *
 * The protocol version a probe connects with decides whether a named device is left to it, so a
 * probe that reconnects under an older version stops being left such a sensor, and under the
 * newer one is left it again. Each stop began the grace. For the grace and this long after it,
 * counted from when the window began, a stop that only the probe's version caused begins
 * nothing: the window stays where it was, and what is left of it, if anything, is all there is.
 * **One window an hour for each sensor is the most a probe can have by reconnecting**, and an
 * hour because a probe upgraded and rolled back by people does not do so twice inside one. A stop
 * somebody configured (targets narrowed, a device moved or paused, a voucher lost) is not held
 * to this: it begins its grace whenever it happens.
 */
export const LATE_REFUSAL_COOL_OFF_MS = 50 * 60_000;

/**
 * How long the write of the stored record waits for a lock before it gives up (`A-61`). Well
 * under PostgreSQL's `deadlock_timeout` (a second as shipped), so that against a delete that
 * cascades into the table it is this write that gives way, and never the delete that is aborted.
 */
export const LATE_REFUSAL_SAVE_LOCK_MS = 300;
/** How long that statement may run on the server at all. */
export const LATE_REFUSAL_SAVE_STATEMENT_MS = 2_000;
/**
 * How long a configuration waits for the write, whatever the write is doing: the two above bound
 * a statement the server is running, and this bounds a connection that never answers.
 */
export const LATE_REFUSAL_SAVE_WAIT_MS = 3_000;

/**
 * The write's own two limits, over the pool's (`P-229`), set for its one transaction by
 * `Database.tx`. **Its give-ways are its own to count**: they are `recordWritesGivenUp` on Core
 * Health already (`A-68`), a channel with no alarm because a delete of a group makes a few on
 * purpose, so the pool's lock and statement counts, which warn on any rate, leave them out.
 */
const LATE_REFUSAL_SAVE_LIMITS: TxLimits = {
  lockTimeoutMs: LATE_REFUSAL_SAVE_LOCK_MS,
  statementTimeoutMs: LATE_REFUSAL_SAVE_STATEMENT_MS,
  ownLockTimeouts: true,
  ownStatementTimeouts: true,
};

/** `lock_not_available`, `query_canceled` and `deadlock_detected`: a write that gave way. */
const GAVE_WAY = new Set(['55P03', '57014', '40P01']);

/** Whether a write failed for a lock or for time, through the pool's wrapper or without it. */
function gaveWay(error: unknown): boolean {
  if (error instanceof DatabaseError) return GAVE_WAY.has(error.sqlstate ?? '');
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return typeof error.code === 'string' && GAVE_WAY.has(error.code);
}

/** What a stored time says at a start (`A-61`): how much of the grace has run, or that it is spent. */
export type StoredStop =
  | {
      /**
       * `kept`: the time is in the past and inside the grace. `ahead`: it is later than the
       * clock reads now, so the clock was set back, and nothing can be counted from it.
       */
      readonly verdict: 'kept' | 'ahead';
      /** How much of the grace has already run. Never negative, never more than the grace. */
      readonly elapsedMs: number;
    }
  | { readonly verdict: 'spent' };

/**
 * How much of its grace a record stored at `storedAtMs` has used when a core starts at
 * `wallNowMs`, both on the wall clock (`A-61`). Pure, so the clock's jumps are a table.
 *
 * The record is counted on a monotonic clock while a core runs, and a monotonic clock starts
 * again with the process, so what crosses a restart is the wall clock's reading: the time that
 * has run is the difference between the two. **A wall clock can be set, so the difference is
 * bounded on both sides, and neither side gives more than the grace.**
 *
 * - **Past the grace, by however much**: spent. A clock set forward between the two readings
 *   lands here too, and ends the grace early. That is the safe side: the refusal is the failed
 *   scan it was before any of this was stored.
 * - **Later than now**: the clock was set back. Nothing has run that can be counted, so the whole
 *   grace is given, from this start: the most a record is ever given, and not a millisecond more.
 *   The caller writes the time down again as now, so a second start does not give it twice.
 * - **Not a number, or not finite**: spent. The column refuses infinity; this is for whatever
 *   reaches here regardless.
 */
export function storedStop(storedAtMs: number, wallNowMs: number, graceMs: number): StoredStop {
  if (!Number.isFinite(storedAtMs) || !Number.isFinite(wallNowMs)) return { verdict: 'spent' };
  const elapsedMs = wallNowMs - storedAtMs;
  if (elapsedMs > graceMs) return { verdict: 'spent' };
  if (elapsedMs < 0) return { verdict: 'ahead', elapsedMs: 0 };
  return { verdict: 'kept', elapsedMs };
}

/**
 * A probe's stored version record as a core starting at `wallNowMs` takes it up (`A-72`), on its
 * monotonic clock reading `nowMs`. Pure, so the clock's jumps are a table, as `storedStop`'s are.
 *
 * - **The version** is taken as stored: it is what the next configuration is compared with, so a
 *   probe whose version changed while the core was stopped is found to have changed.
 * - **A last change older than the hold, by however much**, is no change: the run is over and the
 *   flap with it. A clock set forward across the restart lands here too, and ends a flap early,
 *   which lets go at the next configuration what it held: the side that pages, once, and never
 *   the side that sends a probe what it may not have.
 * - **A last change later than the clock reads**: the clock was set back. It is taken as now, so
 *   a flap gets the whole hold from this start and no more, and the row is written again so a
 *   second start does not give it twice (`ahead`).
 * - **When the run began** only says how long it has gone on: taken as stored, and never later
 *   than the last change.
 */
export function restoredVersion(
  row: {
    readonly version: number;
    readonly changed_ms: string | null;
    readonly since_ms: string | null;
    readonly run_changes: number;
    readonly flap_floor: number | null;
  },
  wallNowMs: number,
  nowMs: number,
  holdMs: number,
): { record: VersionRecord; ahead: boolean } {
  const quiet: VersionRecord = {
    version: row.version,
    changedAt: null,
    since: null,
    changes: 0,
    floor: null,
  };
  if (row.changed_ms === null || row.run_changes < 1) return { record: quiet, ahead: false };
  const stop = storedStop(Number(row.changed_ms), wallNowMs, holdMs);
  if (stop.verdict === 'spent' || stop.elapsedMs >= holdMs) return { record: quiet, ahead: false };
  const changedAt = nowMs - stop.elapsedMs;
  const sinceWall = row.since_ms === null ? Number.NaN : Number(row.since_ms);
  const ranMs = Number.isFinite(sinceWall) ? Math.max(0, wallNowMs - sinceWall) : 0;
  return {
    record: {
      version: row.version,
      changedAt,
      since: Math.min(changedAt, nowMs - ranMs),
      changes: row.run_changes,
      floor: row.run_changes >= 2 ? Math.min(row.flap_floor ?? row.version, row.version) : null,
    },
    ahead: stop.verdict === 'ahead',
  };
}

/** What one start read back from the stored record (`A-61`). */
export interface RestoredStops {
  /** Entries taken up, each with what was left of its grace. */
  restored: number;
  /** Of those, the ones stored at a time later than this clock reads: given the grace from now. */
  ahead: number;
  /**
   * Entries whose grace had run out and whose cool-off had not (`A-68`): nothing is late by one,
   * and a change of the probe's version alone begins no window while it is remembered.
   */
  remembered: number;
  /** Times past the cool-off too, or that could not be read: removed. */
  spent: number;
  /** Sensors taken up as what a probe's last configuration left it (`A-68`). */
  left: number;
  /** Probes whose protocol version was still flapping when the core stopped, and is (`A-72`). */
  flapping: number;
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
  /**
   * Writes of the late-refusal record that were not made when they were due (`A-68`): the
   * statement gave way for a lock or for time, the configuration stopped waiting for it, or it
   * failed. Each is made again at the next configuration or within the minute; until then a core
   * that restarts reads the record as it was before.
   */
  recordWritesGivenUp: number;
}

/** One write of the late-refusal record, and whether it has been counted as given up. */
interface RecordWrite {
  done: Promise<void>;
  counted: boolean;
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
   * Refusals for a sensor a configuration stopped leaving to this probe within the grace
   * (`A-53`): made under the configuration before, and delivered after. Not in `results`, and
   * holding nothing: neither a failed scan nor a reason to stand Unknown. Counted by the caller.
   */
  readonly late: number;
  /**
   * Results of any kind for a sensor this probe's last configuration withheld (`A-72`): the core
   * is not sending it the sensor, so whatever it says of it was made under a configuration
   * before. Not in `results`: never a failed scan, so a sensor let go does not open with a Down
   * nobody can read. Holding nothing and letting nothing go. Counted by the caller.
   */
  readonly withheldDropped: number;
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
  /**
   * What each probe's last configuration withheld, by sensor, with the sentence (`A-41`). A
   * result from the probe for one of these is dropped (`A-72`).
   */
  readonly #withheldByProbe = new Map<number, ReadonlyMap<number, string>>();
  /** What each probe is refusing to scan, by sensor (`A-41c`). */
  readonly #refusedByProbe = new Map<number, Map<number, ProbeRefusal>>();
  /**
   * The sensors each probe was sent with a set whose targets left the host for it to check
   * (`A-41c`), at its last configuration. Only these can be refused by it.
   */
  readonly #leftToProbe = new Map<number, ReadonlySet<number>>();
  /**
   * The sensors a configuration stopped leaving to each probe, and when it did, by `#now`
   * (`A-53`). A refusal for one of them inside the grace was made under the configuration before.
   * Nothing is late by an entry once the grace has run out. It goes at the probe's first
   * configuration after the cool-off that follows the grace, and with its probe.
   *
   * **Stored as well, and read back at start** (`A-61`): `late_refusal_grace` holds one row per
   * entry, written whenever a configuration changes a probe's entries, so a core restarted
   * inside the grace still takes a late refusal as late. What is here is what is judged by;
   * the table is this, as of the last write that landed, in wall-clock time (`#save`,
   * `restore`).
   *
   * **An entry outlives the sensor being left again, and its own grace** (`A-68`): it is kept
   * for `#rememberMs` from when its window began, so that a stop caused by the probe's protocol
   * version alone inside that time begins no second window. Nothing is late by an entry whose
   * sensor is left to the probe, or whose grace has run out; it is only remembered.
   */
  readonly #stoppedLeaving = new Map<number, Map<number, number>>();
  /**
   * The protocol version each probe's last configuration was built for, where that configuration
   * left it anything (`A-68`): with `#leftToProbe`, what the next configuration is compared with
   * to say what stopped and why. Both are stored, on the rows of the sensors the probe is left,
   * and read back at start.
   */
  readonly #versionSent = new Map<number, number>();
  /**
   * What each probe's protocol version has done lately (`A-72`): the version its last
   * configuration was built for, and the run of changes that ended in it. A flap is judged from
   * this, and it is stored, one row a probe, so a core restarted in the middle of one still holds.
   */
  readonly #versions = new Map<number, VersionRecord>();
  /** Probes whose version record has moved since it was last stored (`A-72`). */
  readonly #versionsUnsaved = new Set<number>();
  /** Probes whose late-refusal rows the next write is to store (`A-61`). */
  readonly #graceDue = new Set<number>();
  readonly #flapHoldMs: number;
  readonly #onFlapOver: ((probeIds: readonly number[]) => void) | undefined;
  /** Probes whose entries here are not what the table holds: a write failed. Written again. */
  readonly #unsaved = new Set<number>();
  /** Each probe's write that is running, and the one waiting behind it (`#saved`). */
  readonly #saveRunning = new Map<number, Promise<void>>();
  readonly #saveWaiting = new Map<number, RecordWrite>();
  readonly #saveWaitMs: number;
  readonly #graceMs: number;
  /** The grace and the cool-off after it: how long a window is remembered from its beginning. */
  readonly #rememberMs: number;
  #recordWritesGivenUp = 0;
  readonly #now: () => number;
  readonly #wallNow: () => number;
  #checked = 0;

  constructor(options: CredentialVouchingOptions) {
    this.#graceMs = options.lateRefusalGraceMs ?? LATE_REFUSAL_GRACE_MS;
    this.#rememberMs =
      this.#graceMs + Math.max(0, options.lateRefusalCoolOffMs ?? LATE_REFUSAL_COOL_OFF_MS);
    this.#now = options.now ?? ((): number => performance.now());
    this.#wallNow = options.wallNow ?? ((): number => Date.now());
    this.#saveWaitMs = options.saveWaitMs ?? LATE_REFUSAL_SAVE_WAIT_MS;
    this.#flapHoldMs = Math.max(0, options.protocolFlapHoldMs ?? PROTOCOL_FLAP_HOLD_MS);
    this.#onFlapOver = options.onProtocolFlapOver;
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'credential-vouching' });
    this.#types = options.sensorTypes;
    this.#rights = options.rights;
    this.#vouching = options.vouching;
    this.#audit = options.audit;
  }

  stats(): CredentialVouchingStats {
    let withheld = 0;
    for (const refused of this.#withheldByProbe.values()) withheld += refused.size;
    for (const refused of this.#refusedByProbe.values()) withheld += refused.size;
    return { checked: this.#checked, withheld, recordWritesGivenUp: this.#recordWritesGivenUp };
  }

  /**
   * The flap this probe's protocol version is in now, or null when it is in none (`A-72`): for
   * Probe Health, which raises the one warning that names it.
   */
  protocolFlap(probeId: number): ProtocolFlap | null {
    const record = this.#versions.get(probeId);
    const now = this.#now();
    if (!isFlapping(record, now, this.#flapHoldMs)) return null;
    return {
      version: record.version,
      floor: record.floor,
      changes: record.changes,
      sinceMs: Math.max(0, now - record.since),
      remainingMs: Math.max(0, this.#flapHoldMs - (now - record.changedAt)),
    };
  }

  /**
   * The version a configuration for this probe is judged at, when it speaks `peerVersion`
   * (`A-72`): that version, or while the probe's version flaps, the lowest it has spoken since
   * the flap began. Asks, and records nothing: "check now" is decided by it, so that pressing the
   * button on a sensor a flap holds says what the sensor says.
   */
  judgedVersion(probeId: number, peerVersion: number): number {
    return judgedAt(this.#versions.get(probeId), peerVersion, this.#now(), this.#flapHoldMs);
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
            kind,
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
   *
   * **Judged at the version a flap holds** (`A-72`). While the version the probe advertises flaps,
   * every decision below that turns on a version is made at the lowest it has advertised since
   * the flap began, or at the negotiated version if that is lower, so the sensors it decides stand
   * as they stood and nothing a version decides moves until it has held for
   * `PROTOCOL_FLAP_HOLD_MS`. Never higher than the negotiated version: a probe is never sent a set
   * it cannot be trusted with.
   *
   * **Recorded only for the probe's live session** (`building`). What is asked is asked first;
   * then, if the session is still the probe's, the version is noted and what the probe is left is
   * recorded, in one synchronous step, and stored; then, if it still is, what is withheld is held.
   * A build for a session that has gone records nothing, holds nothing and lets nothing go: its
   * answer goes back to a caller that has nobody to send it to. Without `building` (a caller with
   * no session, a test) the negotiated version is taken as advertised, and the build as live.
   */
  async withhold(
    probeId: number,
    sensors: readonly SensorBeingSent[],
    peerVersion: number = PROTOCOL_VERSION,
    building?: BuildingFor,
  ): Promise<Map<number, string>> {
    const advertised = building?.advertisedVersion ?? peerVersion;
    const live = building?.live ?? ((): boolean => true);
    // Asked, not noted: what this build is judged at if it is the probe's, which is noted below.
    const judged = judgedAt(
      this.#recordAfter(probeId, advertised),
      peerVersion,
      this.#now(),
      this.#flapHoldMs,
    );
    const left = new Set<number>();
    const refused = await this.#check(probeId, sensors, judged, left);
    // A sensor refused for another of its kinds is not sent at all, and so not the probe's.
    for (const sensorId of refused.keys()) left.delete(sensorId);
    const otherwise = await this.#leftUnderVersionBefore(probeId, sensors, judged, left);
    if (!live()) {
      this.#logger.info(
        { probeId, peerVersion, advertised },
        'a configuration was built for a probe session that has closed; nothing it found is recorded',
      );
      return refused;
    }
    this.#noteVersion(probeId, advertised);
    const stopped = this.#noteStopped(probeId, left, otherwise);
    const moved = this.#noteLeft(probeId, left, judged) || stopped;
    // Stored before this configuration is handed to anybody (`A-61`), and only when it changed
    // what is recorded, which most configurations do not: a steady build writes nothing. Waited
    // for within a bound, and never behind another probe's write.
    const grace = moved || this.#unsaved.has(probeId);
    if (grace || this.#versionsUnsaved.has(probeId)) await this.#saved(probeId, grace);
    // Closed while its record was stored: the session that follows it holds its own.
    if (!live()) return refused;
    const before = this.#withheldByProbe.get(probeId)?.size ?? 0;
    if (refused.size === 0) this.#withheldByProbe.delete(probeId);
    else this.#withheldByProbe.set(probeId, new Map(refused));
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
   * The probe's version record as it would be with `advertised` noted now (`A-72`), and noted
   * nowhere. A version that is not a positive whole number moves nothing: every caller passes a
   * hello's, which the protocol has already checked, and the column takes nothing else.
   */
  #recordAfter(probeId: number, advertised: number): VersionRecord | undefined {
    const record = this.#versions.get(probeId);
    if (!Number.isSafeInteger(advertised) || advertised <= 0) return record;
    return nextVersionRecord(record, advertised, this.#now(), this.#flapHoldMs);
  }

  /**
   * Notes the version the probe advertised for a configuration being built for it (`A-72`).
   *
   * **A move of the record is what is stored**: the first configuration a probe is built on
   * this core, each one under another advertised version than the last, and one that finds the
   * last change a hold old, which ends the run. A steady build moves nothing and writes nothing,
   * as `A-61`'s record does not. What a probe can make the core write by this is one row, its
   * own, once per reconnect under another version and once an hour after.
   */
  #noteVersion(probeId: number, advertised: number): void {
    const record = this.#versions.get(probeId);
    const next = this.#recordAfter(probeId, advertised);
    if (next === undefined || next === record) return;
    // An ended run is written too, so a clock set back across a restart cannot bring it back.
    this.#versionsUnsaved.add(probeId);
    this.#versions.set(probeId, next);
    if (next.changes === 2 && next.version !== record?.version) {
      this.#logger.warn(
        { probeId, version: next.version, floor: next.floor, holdMs: this.#flapHoldMs },
        'a probe’s protocol version changed twice inside the hold; the sensors its version ' +
          'decides hold where they stood until it has held one version for the hold',
      );
    }
  }

  /**
   * Records which sensors this configuration stops leaving to the probe, and when (`A-53`).
   * Called with what the probe is left now, before that replaces what it was left before.
   *
   * **The time is the first configuration's that stopped leaving the sensor, and no later one
   * moves it**: the window is how long a refusal made under the one before may take to arrive,
   * and a configuration built for another reason says nothing about that.
   *
   * **A window is remembered for the grace and the cool-off after it, and inside that time the
   * probe's protocol version alone begins no other** (`A-68`). The entry stays when the sensor
   * is left to the probe again, which is what a probe gets by reconnecting under the newer
   * version, and a stop that only the version caused (`otherwise` has the sensor) leaves its
   * time where it was: a refusal is late for what remains of the one window, and for nothing
   * once that has run out. A stop that was configured begins its grace at once, as it always
   * did, remembered window or not.
   */
  #noteStopped(
    probeId: number,
    left: ReadonlySet<number>,
    otherwise: ReadonlySet<number> | 'unknown' | null = null,
  ): boolean {
    const now = this.#now();
    const before = this.#stoppedLeaving.get(probeId);
    const stopped = new Map<number, number>();
    for (const [sensorId, at] of before ?? []) {
      if (now - at <= this.#rememberMs) stopped.set(sensorId, at);
    }
    for (const sensorId of this.#leftToProbe.get(probeId) ?? []) {
      if (left.has(sensorId)) continue;
      const byVersionAlone = otherwise === 'unknown' || otherwise?.has(sensorId) === true;
      if (byVersionAlone && stopped.has(sensorId)) continue;
      stopped.set(sensorId, now);
    }
    if (stopped.size === 0) this.#stoppedLeaving.delete(probeId);
    else this.#stoppedLeaving.set(probeId, stopped);
    // Whether what is recorded moved, which is whether there is anything to store (`A-61`).
    if (stopped.size !== (before?.size ?? 0)) return true;
    for (const [sensorId, at] of stopped) if (before?.get(sensorId) !== at) return true;
    return false;
  }

  /**
   * What the probe would be left by this configuration had it kept the protocol version its last
   * one was built for (`A-68`), or null when that question does not arise.
   *
   * **This is how a stop the probe caused is told from one somebody configured.** What a probe is
   * left is decided by the tree, the sets and their bounds, who vouched, and one thing the probe
   * says itself: its protocol version. A sensor that is not left now and would be, had only the
   * version stayed, was stopped by the version alone. One that would not be left either way was
   * stopped by something an operator did, whatever the version did beside it. Decided by the same
   * check that decides the configuration, asked a second time, so the two cannot disagree about
   * what a version changes.
   *
   * Asked only when it can matter: the version differs from the last, and a sensor about to be
   * recorded as stopped has a window still remembered. That is a probe reconnecting under
   * another version within the hour of the last time it did, and nothing else.
   *
   * **When the second check fails, the two cannot be told apart, and time alone decides**:
   * `'unknown'`, which `#noteStopped` reads as the version's doing for every sensor whose window
   * is remembered. The version did change, so that is the reading that cannot be used to begin a
   * window, and what it costs is an operator's change made in the same moment being judged by
   * the window already there.
   */
  async #leftUnderVersionBefore(
    probeId: number,
    sensors: readonly SensorBeingSent[],
    peerVersion: number,
    left: ReadonlySet<number>,
  ): Promise<ReadonlySet<number> | 'unknown' | null> {
    const versionBefore = this.#versionSent.get(probeId);
    if (versionBefore === undefined || versionBefore === peerVersion) return null;
    const now = this.#now();
    const remembered = this.#stoppedLeaving.get(probeId);
    const reopens = [...(this.#leftToProbe.get(probeId) ?? [])].some((sensorId) => {
      const at = remembered?.get(sensorId);
      return !left.has(sensorId) && at !== undefined && now - at <= this.#rememberMs;
    });
    if (!reopens) return null;
    const otherwise = new Set<number>();
    try {
      const refused = await this.#check(probeId, sensors, versionBefore, otherwise);
      for (const sensorId of refused.keys()) otherwise.delete(sensorId);
      return otherwise;
    } catch (error: unknown) {
      this.#logger.warn(
        { probeId, peerVersion, versionBefore, err: describeError(error) },
        'could not tell whether a probe was stopped being left sensors by its protocol version ' +
          'alone; inside the hour of their last window they begin no other',
      );
      return 'unknown';
    } finally {
      // Asked, not sent: the count of sensors checked before being sent is of the first check.
      this.#checked -= sensors.filter((sensor) => sensor.owners.size > 0).length;
    }
  }

  /**
   * Takes this configuration as what the probe is left, and the version it was built for
   * (`A-68`). Says whether either moved, which is whether there is anything to store: both are
   * on the rows of the sensors the probe is left, so a version with nothing left has no row.
   */
  #noteLeft(probeId: number, left: ReadonlySet<number>, peerVersion: number): boolean {
    const before = this.#leftToProbe.get(probeId);
    const versionBefore = this.#versionSent.get(probeId);
    if (left.size === 0) {
      // Nothing left is nothing that can stop being left, so there is no version to compare
      // with either: kept only beside what it was left, here as in the table.
      this.#leftToProbe.delete(probeId);
      this.#versionSent.delete(probeId);
    } else {
      this.#leftToProbe.set(probeId, left);
      this.#versionSent.set(probeId, peerVersion);
    }
    if (left.size !== (before?.size ?? 0)) return true;
    for (const sensorId of left) if (before?.has(sensorId) !== true) return true;
    return left.size > 0 && versionBefore !== peerVersion;
  }

  /**
   * Has the table hold what is recorded here for one probe, and nothing else for it (`A-61`).
   * Never throws: a write that fails is logged, and made again at the probe's next configuration
   * or the next `prune`, whichever is first.
   *
   * **One statement**, so the table never holds half of a change. Each time is written as the
   * wall clock's reading now less what the entry has already run on the monotonic one, which is
   * the moment the configuration stopped leaving the sensor as this clock would have read it.
   *
   * **It gives way to everything else, and soon.** The statement runs in a transaction of its
   * own with a lock timeout of `LATE_REFUSAL_SAVE_LOCK_MS` and a statement timeout of
   * `LATE_REFUSAL_SAVE_STATEMENT_MS`. It takes its own rows and then a key-share lock on the
   * sensors' and the probe's rows in `object`; a delete of a device or a group takes those rows
   * first and cascades into these, which is the two in the other order. PostgreSQL would settle
   * that by aborting one of them after `deadlock_timeout`, a second as shipped, and the one it
   * picks could be the operator's delete. The lock timeout is well under that, so **this write
   * is always the one to give up**: it is the one that can be made again. Giving up for a lock
   * or for time is expected under contention and is logged at `warn`; anything else at `error`.
   * Both limits are `LATE_REFUSAL_SAVE_LIMITS`, set by `Database.tx` for this transaction alone,
   * and neither give-way is counted by the pool (`P-229`): `recordWritesGivenUp` counts it.
   *
   * **An entry whose sensor or probe is gone is dropped, not written again.** The join skips it,
   * the statement says which rows it wrote, and what it did not write has nothing left to be
   * about: without this a sensor deleted while its write was waiting would be a write retried
   * every minute for nothing.
   *
   * **The window between the decision and this write.** A configuration change is decided in the
   * write's own transaction, and nothing here is part of that: the record is of what a probe's
   * *configuration* stops leaving it, and that is known only when the configuration is next built
   * for that probe, from what the one before left it, which is held in memory. For a connected
   * probe that is the notifier's 250 ms after the commit, and this write is waited for, within
   * its bound, before the configuration is handed over. A core that stops inside that window, or
   * while the probe is away, starts with no entry for the change. What is stored is every entry
   * a configuration has been built for and whose write landed.
   *
   * **And what the probe is left, with the version it was left it under** (`A-68`), in the same
   * statement: a row for each sensor the last configuration left to the probe carries that
   * configuration's protocol version, and a row for a remembered window carries its time, and a
   * sensor that is both has both on one row. Read back at start, that is what the first
   * configuration a restarted core builds is compared with, so a change committed before the
   * core stopped and not yet built for the probe is still found to have stopped leaving its
   * sensors, and begins their grace then. That closes the window above, for every change made
   * after a configuration whose write landed: until `A-68` a late refusal for such a change was
   * the failed scan it had been before `A-61`.
   */
  async #save(probeId: number, write: RecordWrite): Promise<void> {
    // What this write is for, taken as it runs: a request made while it waited its turn is in it.
    const grace = this.#graceDue.delete(probeId);
    const version = this.#versionsUnsaved.delete(probeId) ? this.#versions.get(probeId) : undefined;
    if (!grace && version === undefined) return;
    const entries = grace ? [...(this.#stoppedLeaving.get(probeId) ?? [])] : [];
    const sensorIds = entries.map(([sensorId]) => sensorId);
    const wall = this.#wallNow();
    const now = this.#now();
    const stoppedAtMs = entries.map(([, at]) => wall - (now - at));
    const leftIds = grace ? [...(this.#leftToProbe.get(probeId) ?? [])] : [];
    const leftVersion = this.#versionSent.get(probeId) ?? null;
    const onWall = (at: number | null): number | null => (at === null ? null : wall - (now - at));
    try {
      const { written, versionWritten } = await this.#db.tx(async (q) => {
        const rows = grace
          ? await this.#saveGrace(q, probeId, sensorIds, stoppedAtMs, leftIds, leftVersion)
          : [];
        // The probe's own row (`A-72`), in the same transaction and under the same bounds: a probe
        // that is gone writes nothing, as a sensor that is gone does above.
        const versionRows =
          version === undefined
            ? []
            : await q.query<{ probe_id: string }>(
                `INSERT INTO probe_protocol_flap
                   (probe_id, version, changed_at, run_since, run_changes, flap_floor)
                 SELECT p.id, $2::integer, to_timestamp($3::float8 / 1000.0),
                        to_timestamp($4::float8 / 1000.0), $5::integer, $6::integer
                 FROM object p WHERE p.id = $1
                 ON CONFLICT (probe_id) DO UPDATE
                   SET version = EXCLUDED.version, changed_at = EXCLUDED.changed_at,
                       run_since = EXCLUDED.run_since, run_changes = EXCLUDED.run_changes,
                       flap_floor = EXCLUDED.flap_floor
                 RETURNING probe_id::text AS probe_id`,
                [
                  probeId,
                  version.version,
                  onWall(version.changedAt),
                  onWall(version.since),
                  version.changes,
                  version.floor,
                ],
              );
        return { written: rows, versionWritten: versionRows.length > 0 };
      }, LATE_REFUSAL_SAVE_LIMITS);
      // A probe that is gone has no record to keep, and nothing to write again.
      if (version !== undefined && !versionWritten && this.#versions.get(probeId) === version) {
        this.#versions.delete(probeId);
      }
      if (!grace) return;
      this.#unsaved.delete(probeId);
      // What was not written has no sensor, or no probe, to be about any more.
      const stored = new Set(written.map((row) => Number(row.sensor_id)));
      const stopped = this.#stoppedLeaving.get(probeId);
      for (const [sensorId, at] of entries) {
        if (!stored.has(sensorId) && stopped?.get(sensorId) === at) stopped.delete(sensorId);
      }
      if (stopped?.size === 0) this.#stoppedLeaving.delete(probeId);
    } catch (error: unknown) {
      if (grace) this.#unsaved.add(probeId);
      if (version !== undefined) this.#versionsUnsaved.add(probeId);
      this.#gaveUp(write);
      const fields = {
        probeId,
        entries: sensorIds.length,
        left: leftIds.length,
        version: version?.version ?? null,
        err: describeError(error),
      };
      if (gaveWay(error)) {
        this.#logger.warn(
          fields,
          'gave up storing which sensors a configuration stopped leaving to a probe, or what its ' +
            'protocol version has done, for a lock or for time; it is written again at the next ' +
            'configuration or within a minute',
        );
      } else {
        this.#logger.error(
          fields,
          'could not store which sensors a configuration stopped leaving to a probe, or what its ' +
            'protocol version has done; a core restarted before the next write reads a late ' +
            'refusal for them as a failed scan, and does not know the probe was flapping',
        );
      }
    }
  }

  /** The late-refusal rows of one probe, as `#save` writes them (`A-61`, `A-68`). */
  #saveGrace(
    q: Queryable,
    probeId: number,
    sensorIds: readonly number[],
    stoppedAtMs: readonly number[],
    leftIds: readonly number[],
    leftVersion: number | null,
  ): Promise<{ sensor_id: string }[]> {
    return q.query<{ sensor_id: string }>(
      `WITH gone AS (
             DELETE FROM late_refusal_grace
             WHERE probe_id = $1
               AND sensor_id <> ALL($2::bigint[]) AND sensor_id <> ALL($4::bigint[])
           )
           INSERT INTO late_refusal_grace (probe_id, sensor_id, stopped_at, left_version)
           SELECT p.id, s.id, to_timestamp(r.stopped_ms / 1000.0),
                  CASE WHEN r.is_left THEN $5::integer END
           FROM (
             SELECT COALESCE(stopped.sensor_id, lft.sensor_id) AS sensor_id,
                    stopped.stopped_ms,
                    lft.sensor_id IS NOT NULL AS is_left
             FROM unnest($2::bigint[], $3::float8[]) AS stopped (sensor_id, stopped_ms)
             FULL JOIN unnest($4::bigint[]) AS lft (sensor_id)
               ON lft.sensor_id = stopped.sensor_id
           ) r
           JOIN object s ON s.id = r.sensor_id
           JOIN object p ON p.id = $1
           ON CONFLICT (probe_id, sensor_id) DO UPDATE
             SET stopped_at = EXCLUDED.stopped_at, left_version = EXCLUDED.left_version
           RETURNING sensor_id::text AS sensor_id`,
      [probeId, sensorIds, stoppedAtMs, leftIds, leftVersion],
    );
  }

  /**
   * `#save`, waited for no longer than `#saveWaitMs`.
   *
   * **One probe's write never waits on another's**: each probe has its own line, of the write
   * that is running and at most one behind it. One behind is enough, since a write stores what
   * is recorded when it runs and not when it was asked for, so a second request while one is
   * already waiting its turn is that same write.
   *
   * **And a probe's configuration does not wait on its own without end.** The server's two
   * timeouts bound a statement the server is running. They do not bound a connection that never
   * answers or a pool with none to give, so the caller is let go after `#saveWaitMs` whatever
   * the write is doing, with the probe marked for the next configuration or prune to write again.
   */
  #saved(probeId: number, grace = true): Promise<void> {
    // What is due is marked now, and taken by whichever write runs next for the probe.
    if (grace) this.#graceDue.add(probeId);
    let waiting = this.#saveWaiting.get(probeId);
    if (waiting === undefined) {
      const before = this.#saveRunning.get(probeId) ?? Promise.resolve();
      const asked: RecordWrite = { done: Promise.resolve(), counted: false };
      asked.done = before.then(async () => {
        this.#saveWaiting.delete(probeId);
        const run = this.#save(probeId, asked);
        this.#saveRunning.set(probeId, run);
        await run;
        if (this.#saveRunning.get(probeId) === run) this.#saveRunning.delete(probeId);
      });
      waiting = asked;
      this.#saveWaiting.set(probeId, waiting);
    }
    const asked = waiting;
    const write = waiting.done;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // The version record needs no mark: a write that has not landed puts its own back when
        // it ends, and one that never ends holds every write behind it in the line regardless.
        if (grace) this.#unsaved.add(probeId);
        this.#gaveUp(asked);
        this.#logger.warn(
          { probeId, waitedMs: this.#saveWaitMs },
          'stopped waiting for the record of late refusals to be stored; the configuration ' +
            'goes out without it, and it is written again at the next one or within a minute',
        );
        resolve();
      }, this.#saveWaitMs);
      timer.unref();
      void write.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Counts a write that was not made when it was due (`A-68`), for Core Health: once for each
   * write, whether it was the statement that gave way or failed, the caller that stopped waiting
   * for it, or both. Until then this was a log line and no number, and a database that makes
   * these writes give way all day looked like one that never does.
   */
  #gaveUp(write: RecordWrite): void {
    if (write.counted) return;
    write.counted = true;
    this.#recordWritesGivenUp += 1;
  }

  /**
   * Reads the stored record back, once, at start (`A-61`): before the probe endpoint accepts a
   * result, so that none is judged without it. Throws when the table cannot be read, and the
   * core does not start: started without the record it would raise the alarms this exists to
   * prevent, and say nothing of why.
   *
   * **How a stored time becomes what is left of a grace.** The grace runs on the monotonic
   * clock, which a new process starts from nothing; the table holds wall-clock times. An entry
   * is taken up as having stopped `elapsed` milliseconds before this clock's reading now, where
   * `elapsed` is the wall clock's reading now less the stored time, bounded by `storedStop`:
   * spent past the grace, and the whole grace and no more for a time that is ahead of the clock.
   * From then on it is counted as any entry is.
   *
   * **A time past its grace is still taken up while it is remembered** (`A-68`): nothing is late
   * by it, and it is what keeps a probe that changes its protocol version after the restart from
   * beginning a window the core before this one would have refused it. So the bound survives
   * the restart as the grace does. Past the cool-off too, it is spent.
   *
   * Spent times are removed, and a time ahead of the clock is written down again as now, so the
   * table agrees with what was taken up and a second start cannot give the same grace twice.
   *
   * **And what each probe was last left** (`A-68`), with the protocol version it was left it
   * under, so that the first configuration this core builds for a probe is compared with the
   * last one the core before it built, and not with nothing. A change committed before the stop
   * and not yet built for the probe is found then, and its sensors' grace begins then.
   */
  async restore(): Promise<RestoredStops> {
    const rows = await this.#db.query<{
      probe_id: string;
      sensor_id: string;
      stopped_ms: string | null;
      left_version: number | null;
    }>(
      `SELECT probe_id::text AS probe_id, sensor_id::text AS sensor_id,
              (extract(epoch FROM stopped_at) * 1000)::float8::text AS stopped_ms,
              left_version
       FROM late_refusal_grace`,
    );
    const versions = await this.#db.query<{
      probe_id: string;
      version: number;
      changed_ms: string | null;
      since_ms: string | null;
      run_changes: number;
      flap_floor: number | null;
    }>(
      `SELECT probe_id::text AS probe_id, version,
              (extract(epoch FROM changed_at) * 1000)::float8::text AS changed_ms,
              (extract(epoch FROM run_since) * 1000)::float8::text AS since_ms,
              run_changes, flap_floor
       FROM probe_protocol_flap`,
    );
    const wall = this.#wallNow();
    const now = this.#now();
    const tally: RestoredStops = {
      restored: 0,
      ahead: 0,
      remembered: 0,
      spent: 0,
      left: 0,
      flapping: 0,
    };
    const rewrite = new Set<number>();
    /** Probes whose version record is to be written again: a time ahead of this clock (`A-72`). */
    const versionsAhead = new Set<number>();
    for (const row of versions) {
      const probeId = Number(row.probe_id);
      // A probe this core has built a configuration for keeps what that one said.
      if (this.#versions.has(probeId)) continue;
      const restored = restoredVersion(row, wall, now, this.#flapHoldMs);
      this.#versions.set(probeId, restored.record);
      if (restored.ahead) {
        this.#versionsUnsaved.add(probeId);
        versionsAhead.add(probeId);
      }
      if (isFlapping(restored.record, now, this.#flapHoldMs)) tally.flapping += 1;
    }
    // What each probe was last left, and under which version (`A-68`): what the first
    // configuration this core builds for it is compared with. A probe this core has already
    // built one for, were it ever to have, keeps what that one said.
    const leftStored = new Map<number, { version: number; sensors: Set<number> }>();
    for (const row of rows) {
      if (row.left_version === null || this.#leftToProbe.has(Number(row.probe_id))) continue;
      const stored = leftStored.get(Number(row.probe_id));
      if (stored === undefined) {
        leftStored.set(Number(row.probe_id), {
          version: row.left_version,
          sensors: new Set([Number(row.sensor_id)]),
        });
      } else {
        stored.sensors.add(Number(row.sensor_id));
      }
      tally.left += 1;
    }
    for (const [probeId, stored] of leftStored) {
      this.#leftToProbe.set(probeId, stored.sensors);
      this.#versionSent.set(probeId, stored.version);
    }
    for (const row of rows) {
      if (row.stopped_ms === null) continue;
      const probeId = Number(row.probe_id);
      const sensorId = Number(row.sensor_id);
      // Kept for as long as it is remembered, which is longer than anything is late by it.
      const stop = storedStop(Number(row.stopped_ms), wall, this.#rememberMs);
      if (stop.verdict === 'spent') {
        tally.spent += 1;
        rewrite.add(probeId);
        continue;
      }
      let stopped = this.#stoppedLeaving.get(probeId);
      if (stopped === undefined) {
        stopped = new Map();
        this.#stoppedLeaving.set(probeId, stopped);
      }
      // Whatever this core has recorded itself, were it ever to have, is the later word.
      if (!stopped.has(sensorId)) stopped.set(sensorId, now - stop.elapsedMs);
      if (stop.elapsedMs <= this.#graceMs) tally.restored += 1;
      else tally.remembered += 1;
      if (stop.verdict === 'ahead') {
        tally.ahead += 1;
        rewrite.add(probeId);
      }
    }
    await Promise.all([
      ...[...rewrite].map((probeId) => this.#saved(probeId)),
      ...[...versionsAhead]
        .filter((probeId) => !rewrite.has(probeId))
        .map((probeId) => this.#saved(probeId, false)),
    ]);
    if (rows.length > 0 || versions.length > 0) {
      const ahead = tally.ahead + versionsAhead.size;
      this.#logger[ahead > 0 ? 'warn' : 'info'](
        { ...tally, versions: versions.length, versionsAhead: versionsAhead.size },
        ahead > 0
          ? 'read which sensors a configuration stopped leaving to a probe; some were stored at ' +
              'a time ahead of this clock, which was set back, and are given the grace from now'
          : 'read which sensors a configuration stopped leaving to a probe',
      );
    }
    return tally;
  }

  /**
   * Drops every entry that is no longer remembered, here and in the table (`A-61`): its grace
   * has run out, and the cool-off after it (`A-68`). Never throws.
   *
   * On a timer, because the other thing that drops one is the probe's next configuration, and a
   * probe that is never sent another would keep its rows for good. It also writes again whatever
   * an earlier write could not.
   */
  async prune(): Promise<void> {
    const now = this.#now();
    const moved = new Set(this.#unsaved);
    for (const [probeId, stopped] of this.#stoppedLeaving) {
      for (const [sensorId, at] of stopped) {
        if (now - at <= this.#rememberMs) continue;
        stopped.delete(sensorId);
        moved.add(probeId);
      }
      if (stopped.size === 0) this.#stoppedLeaving.delete(probeId);
    }
    // A run whose version has held for the hold is over (`A-72`), and a flap with it. **The ended
    // run is written**, as a settled row: left as it was, its stored times would bring the flap
    // back at a start whose wall clock had been set back across the restart, and page each
    // sensor it held a second time. Whoever builds configurations is told of a flap, so what it
    // held is let go now and not at the probe's next reconnect.
    const over: number[] = [];
    for (const [probeId, record] of this.#versions) {
      const settled = settledRecord(record, now, this.#flapHoldMs);
      if (settled === record) continue;
      this.#versions.set(probeId, settled);
      this.#versionsUnsaved.add(probeId);
      if (record.floor !== null) over.push(probeId);
    }
    if (over.length > 0) {
      this.#logger.info(
        { probeIds: over, holdMs: this.#flapHoldMs },
        'a probe’s protocol version has held for the hold; what its flap held is let go at the ' +
          'next configuration',
      );
      try {
        this.#onFlapOver?.(over);
      } catch (error: unknown) {
        this.#logger.error(
          { probeIds: over, err: describeError(error) },
          'could not ask for the configurations of probes whose flap is over; each is let go ' +
            'at its next one',
        );
      }
    }
    // Together: each probe has its own line, and none of them waits past its bound.
    await Promise.all([
      ...[...moved].map((probeId) => this.#saved(probeId)),
      ...[...this.#versionsUnsaved]
        .filter((probeId) => !moved.has(probeId))
        .map((probeId) => this.#saved(probeId, false)),
    ]);
  }

  /** Whether a configuration stopped leaving this sensor to the probe within the grace. */
  #stoppedWithinGrace(probeId: number, sensorId: number): boolean {
    const at = this.#stoppedLeaving.get(probeId)?.get(sensorId);
    return at !== undefined && this.#now() - at <= this.#graceMs;
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
   * **A refusal is judged against the configuration it was made under** (`A-53`). A probe that
   * follows its configuration refuses only a sensor that configuration left to it, so a refusal
   * for a sensor the probe is no longer left was made under an earlier one: the check was
   * running, or its result was in the spool, when the configuration changed. A result does not
   * say which configuration it ran under, so that is taken to be the case for the grace after
   * the configuration that stopped leaving the sensor, and not after it. Such a refusal is
   * dropped and counted (`late`). It is not a failed scan, since nothing was asked of the device,
   * and it holds nothing, since whatever the configuration now says about the sensor is what
   * speaks for it. It measures nothing either, and lets no hold go. **What that gives a probe
   * that misbehaves is a result that vanishes, which it had by not sending it**: no hold begins
   * or lasts longer by it, only an error with no readings is taken, only for a sensor this probe
   * was left, and only inside the grace.
   *
   * **A result for a sensor the core withholds from this probe is dropped, whatever it is**
   * (`A-72`). The probe's last configuration did not send it the sensor, so the result was made
   * under one before. Past the grace a marked one used to be the failed scan its mark had no claim
   * to, while the sensor stood Unknown for the core's own reason, and two of them were a Down the
   * sensor opened with when it was let go, in words that no longer applied. It is counted
   * (`withheldDropped`) and nothing else: no failed scan, no hold, no release.
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
    /** What this probe's last configuration withheld (`A-72`). */
    const withheldHere = this.#withheldByProbe.get(probeId);
    // Nothing held by anyone, nothing withheld from this probe and nothing marked, which is every
    // batch of every probe but a few.
    if (
      this.#refusedByProbe.size === 0 &&
      withheldHere === undefined &&
      !results.some((result) => result.withheld === true)
    ) {
      return { results, unearned: 0, late: 0, withheldDropped: 0, stored: NOTHING_LET_GO };
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
    let late = 0;
    let withheldDropped = 0;
    const inOrder = [...results].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (const result of inOrder) {
      const at = Date.parse(result.at);
      const holding = refused.get(result.sensorId);
      /** What a refusal looks like, whoever sent it: an error that measured nothing. */
      const refusal =
        result.withheld === true && result.outcome === 'error' && result.channels.length === 0;
      const earned = refusal && left?.has(result.sensorId) === true;
      if (refusal && !earned && this.#stoppedWithinGrace(probeId, result.sensorId)) {
        // Made under the configuration before this one (`A-53`). Neither kept nor held.
        late += 1;
        continue;
      }
      if (withheldHere?.has(result.sensorId) === true) {
        // **The core is not sending this probe the sensor** (`A-72`), so whatever the probe says
        // of it was made under a configuration before, past the grace or with no grace at all.
        // Taken as a failed scan, two of them were a Down the sensor opened with when it was let
        // go, in words nobody could place. Dropped instead, and counted: it measures nothing,
        // holds nothing and lets nothing go, whatever it is, a reading included.
        withheldDropped += 1;
        continue;
      }
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

    if (releases.length === 0) {
      return { results: kept, unearned, late, withheldDropped, stored: NOTHING_LET_GO };
    }
    return {
      results: kept,
      unearned,
      late,
      withheldDropped,
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
        ...this.#stoppedLeaving.keys(),
        ...this.#withheldByProbe.keys(),
        ...this.#versions.keys(),
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
        // Its rows went with it, by the table's cascade (`A-61`).
        this.#stoppedLeaving.delete(probeId);
        this.#versionSent.delete(probeId);
        this.#unsaved.delete(probeId);
        // Its version record went with it too (`A-72`).
        this.#versions.delete(probeId);
        this.#versionsUnsaved.delete(probeId);
        this.#graceDue.delete(probeId);
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
