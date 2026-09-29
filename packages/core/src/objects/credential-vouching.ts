import { createHash } from 'node:crypto';
import type { Logger } from '@ms/shared';
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
import { storedVoucher, type StoredVoucher, type VoucherCheck } from './vouching.js';

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
             up.sensor_id, cs.kind::text AS kind, cs.object_id AS owner_id
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
  const routes = await routesAtOrUnder(q, types, under, options);
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
} as const;

/** One sensor a probe's configuration is about to send credentials to. */
export interface SensorBeingSent {
  readonly sensorId: number;
  readonly sensorType: string;
  readonly params: Record<string, unknown>;
  readonly host: string;
  readonly ipVersion: string;
  /** The object each kind's set in force is stored on, as the vault resolved it. */
  readonly owners: ReadonlyMap<string, number>;
}

export interface CredentialVouchingOptions {
  db: Queryable & { tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> };
  logger: Logger;
  sensorTypes: CredentialTypes;
  /** What each account may do to each owner: `AccessService.resolveManyFor`. */
  rights: (
    principal: AccessPrincipal,
    objectIds: readonly number[],
    q: Queryable,
  ) => Promise<ReadonlyMap<number, AccessRight>>;
  /** Where a withheld sensor is held Unknown: `A-29`'s set, which the state machine reads. */
  vouching?: Pick<VoucherCheck, 'settle'>;
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
  /** Sensors withheld at the last check of each probe. */
  withheld: number;
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
  readonly #types: CredentialTypes;
  readonly #rights: CredentialVouchingOptions['rights'];
  readonly #vouching: Pick<VoucherCheck, 'settle'> | undefined;
  readonly #audit: AuditSink | undefined;

  #epoch: string | null = null;
  /** Keyed by account and role: a role is a ceiling, and changing it does not move the epoch. */
  readonly #writable = new Map<string, Map<number, boolean>>();
  readonly #withheldByProbe = new Map<number, number>();
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
    return { checked: this.#checked, withheld };
  }

  /**
   * Which of these sensors may not be sent their credentials by this probe, with the sentence
   * for each. Asks, and changes nothing: `withhold` is the one that holds them.
   */
  async refusals(
    probeId: number,
    sensors: readonly SensorBeingSent[],
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
  ): Promise<Map<number, string>> {
    const refused = await this.refusals(probeId, sensors);
    const before = this.#withheldByProbe.get(probeId) ?? 0;
    this.#withheldByProbe.set(probeId, refused.size);
    if (refused.size !== before) {
      this.#logger.info(
        { probeId, withheld: refused.size, before },
        'sensors withheld from their probe because of who vouched for their credentials',
      );
    }
    await this.#vouching?.settle(`credentials:${String(probeId)}`, refused);
    return refused;
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
