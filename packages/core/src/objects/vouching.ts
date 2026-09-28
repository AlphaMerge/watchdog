import { describeError, type Logger } from '@ms/shared';
import type { AccessPrincipal, Visibility } from '../auth/access.js';
import type { AccountRole } from '../auth/accounts.js';
import type { Queryable } from '../db/pool.js';
import type { SensorStateCause } from '../state/tables.js';
import type { SensorTypeGate } from './sensor-type-gate.js';

/**
 * Who a sensor is evaluated through, as stored (`A-29`, migration 059).
 *
 * `userId: null` on an account is one since deleted: the column goes NULL with it.
 */
export type StoredVoucher =
  { readonly kind: 'installation' } | { readonly kind: 'account'; readonly userId: number | null };

/** The two columns, as a query returns them. */
export function storedVoucher(kind: string, userId: string | number | null): StoredVoucher {
  if (kind !== 'account') return { kind: 'installation' };
  return { kind: 'account', userId: userId === null ? null : Number(userId) };
}

/** One sensor a sweep is about to evaluate. */
export interface SensorToVouchFor {
  readonly sensorId: number;
  readonly sensorType: string;
  readonly params: Record<string, unknown>;
  /** The probe above it, for a type that names that probe; null when there is none. */
  readonly enclosingProbeId: number | null;
  readonly voucher: StoredVoucher;
}

/**
 * What a withheld sensor says. Each is also the fix, and none names what it cannot read — the
 * sensor's readers may not be able to read it either, which is the whole point.
 */
export const WITHHELD = {
  deleted:
    'Not evaluated: the account that vouched for this sensor has been deleted. Saving the sensor ' +
    'again, as an account that can read everything it names, vouches for it.',
  disabled:
    'Not evaluated: the account that vouched for this sensor has been disabled. Saving the ' +
    'sensor again, as an account that can read everything it names, vouches for it.',
  lostRead:
    'Not evaluated: the account that vouched for this sensor can no longer read everything it ' +
    'names. Saving the sensor again, as an account that can, vouches for it.',
} as const;

/**
 * What an evaluator needs (`A-29`): which sensors to leave alone this sweep, and a place to say
 * so. `SensorVouching` is the one there is; the interface is what a unit test of a sweep stubs.
 */
export interface VoucherCheck {
  refusals(sensors: readonly SensorToVouchFor[]): Promise<Map<number, string>>;
  settle(owner: string, refused: ReadonlyMap<number, string>): Promise<number>;
}

/** What this needs from the state service: re-decide these, in this transaction. */
export interface WithheldReevaluator {
  reevaluate(
    q: Queryable,
    sensorIds: readonly number[],
    at: Date,
    cause: { message: string; sources?: readonly SensorStateCause[] },
  ): Promise<number>;
}

/** Settles `paused_by_dependency` after sensors have moved, as `ProbeReachability` does. */
export interface WithheldDependencies {
  recompute(q: Queryable, at: Date): Promise<{ moved: number }>;
}

interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
}

export interface SensorVouchingOptions {
  db: Db;
  logger: Logger;
  /** What each type reads — the same question the write path asks (`A-29`). */
  sensorTypes: Pick<SensorTypeGate, 'reads'>;
  /** What an account can see: `AccessService.visibilityFor`. */
  sight: (principal: AccessPrincipal, q: Queryable) => Promise<Visibility>;
  /** Absent in a unit test that only asks for verdicts. */
  states?: WithheldReevaluator;
  dependencies?: WithheldDependencies;
  now?: () => Date;
}

export interface VouchingStats {
  /** Sensors whose voucher was checked. */
  checked: number;
  /** Sensors not evaluated right now, because of their voucher. */
  withheld: number;
  /** Account sights resolved — once per account per `access_epoch`, not per sensor. */
  sightsResolved: number;
  /** Times the database was asked which of a voucher's objects it can read. */
  readsAsked: number;
}

interface Account {
  readonly role: AccountRole;
  readonly disabled: boolean;
}

/**
 * The core's evaluators ask this before evaluating a sensor that republishes what it reads
 * (`A-29`), and it holds the answer as a live fact the state machine reads (§2 layer 3a).
 *
 * **A fixed number of queries a sweep, not one per sensor.** One for the access epoch and the
 * vouching accounts, one for which named objects exist; then, per account, its sight when the
 * epoch has moved since it was last resolved and a `visibleAmong` for ids it has not been asked
 * about at this epoch. Every grant, membership and move bumps the epoch (`A-12`), so between two
 * of them a steady installation asks nothing but the first two — and one where nothing is vouched
 * for by an account asks nothing at all.
 *
 * **A named object that no longer exists is not a refusal.** The sensor reads nothing from it and
 * says so on its own — a factory gaps the channel. Refusing would make a deleted source look like
 * a revoked grant, and a delete is not the voucher's fault.
 *
 * **A locked account still vouches; a disabled one does not** — `reports/context.ts` gives the
 * reasons. Disabling is how this system revokes an account, and a lockout is a defence anybody can
 * trigger from the login form.
 */
export class SensorVouching implements VoucherCheck {
  readonly #db: Db;
  readonly #logger: Logger;
  readonly #sensorTypes: Pick<SensorTypeGate, 'reads'>;
  readonly #sight: (principal: AccessPrincipal, q: Queryable) => Promise<Visibility>;
  readonly #states: WithheldReevaluator | undefined;
  readonly #dependencies: WithheldDependencies | undefined;
  readonly #now: () => Date;

  /** Every withheld sensor, with its sentence. What `SensorStateService` lays over the facts. */
  readonly #withheld = new Map<number, string>();
  /** Which sweep withholds which sensors, so one sweep's answer never clears another's. */
  readonly #byOwner = new Map<string, Set<number>>();

  /** Resolved at `#epoch`; dropped whole when it moves. */
  #epoch: string | null = null;
  /** Keyed by account and role: a role is a ceiling, and changing it does not move the epoch. */
  readonly #sights = new Map<string, Visibility>();
  readonly #readable = new Map<string, Map<number, boolean>>();

  #checked = 0;
  #sightsResolved = 0;
  #readsAsked = 0;

  constructor(options: SensorVouchingOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'vouching' });
    this.#sensorTypes = options.sensorTypes;
    this.#sight = options.sight;
    this.#states = options.states;
    this.#dependencies = options.dependencies;
    this.#now = options.now ?? (() => new Date());
  }

  withheld(): ReadonlyMap<number, string> {
    return this.#withheld;
  }

  stats(): VouchingStats {
    return {
      checked: this.#checked,
      withheld: this.#withheld.size,
      sightsResolved: this.#sightsResolved,
      readsAsked: this.#readsAsked,
    };
  }

  /**
   * Which of these sensors may not be evaluated, and the sentence for each.
   *
   * Throws only if the database does; a sweep that cannot ask evaluates nothing it would have
   * had to ask about, rather than everything.
   */
  async refusals(sensors: readonly SensorToVouchFor[]): Promise<Map<number, string>> {
    this.#checked += sensors.length;
    const refused = new Map<number, string>();
    const byAccount = sensors.filter(
      (sensor): sensor is SensorToVouchFor & { voucher: { kind: 'account' } } =>
        sensor.voucher.kind === 'account',
    );
    if (byAccount.length === 0) return refused;

    const userIds = [
      ...new Set(
        byAccount.flatMap((sensor) =>
          sensor.voucher.userId === null ? [] : [sensor.voucher.userId],
        ),
      ),
    ];
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
      this.#sights.clear();
      this.#readable.clear();
    }
    const accounts = new Map<number, Account>();
    for (const row of rows) {
      if (row.id === null || row.role === null) continue;
      accounts.set(Number(row.id), { role: row.role, disabled: row.disabled === true });
    }

    // What each sensor names, asked of its type — the question the write path asked.
    const named = new Map<number, { ids: number[]; bar: boolean }>();
    for (const sensor of byAccount) {
      const reads = this.#sensorTypes.reads(sensor.sensorType, sensor.params);
      const ids: number[] = [];
      for (const reference of reads.references) {
        if (reference.kind === 'object') ids.push(reference.objectId);
        else if (sensor.enclosingProbeId !== null) ids.push(sensor.enclosingProbeId);
      }
      named.set(sensor.sensorId, { ids, bar: reads.requires === 'installation' });
    }

    const allNamed = [...new Set([...named.values()].flatMap((one) => one.ids))];
    const existing = await this.#db.query<{ id: string; kind: string }>(
      `SELECT id::text AS id, kind::text AS kind FROM object
       WHERE id = ANY($1::bigint[]) OR kind = 'root'`,
      [allNamed],
    );
    const exists = new Set<number>();
    let rootId: number | null = null;
    for (const row of existing) {
      const id = Number(row.id);
      if (row.kind === 'root') rootId = id;
      exists.add(id);
    }

    for (const sensor of byAccount) {
      const userId = sensor.voucher.userId;
      const account = userId === null ? undefined : accounts.get(userId);
      if (userId === null || account === undefined) {
        refused.set(sensor.sensorId, WITHHELD.deleted);
        continue;
      }
      if (account.disabled) {
        refused.set(sensor.sensorId, WITHHELD.disabled);
        continue;
      }
      const wanted = named.get(sensor.sensorId) ?? { ids: [], bar: false };
      const asked = wanted.ids.filter((id) => exists.has(id));
      if (wanted.bar && rootId !== null) asked.push(rootId);
      if (asked.length === 0) continue;
      const readable = await this.#readableFor(userId, account, asked);
      if (asked.some((id) => readable.get(id) !== true)) {
        refused.set(sensor.sensorId, WITHHELD.lostRead);
      }
    }
    return refused;
  }

  /**
   * Replaces what `owner` withholds with `refused`, and re-decides the sensors that crossed.
   *
   * `refused` is the whole answer for that sweep, so a sensor it withheld last time and did not
   * look at now — deleted, paused — is let go, and the set cannot grow stale.
   */
  async settle(owner: string, refused: ReadonlyMap<number, string>): Promise<number> {
    const before = this.#byOwner.get(owner) ?? new Set<number>();
    const entered = [...refused.keys()].filter((id) => !before.has(id));
    const left = [...before].filter((id) => !refused.has(id));
    const reworded = [...refused].filter(
      ([id, message]) => before.has(id) && this.#withheld.get(id) !== message,
    );

    for (const id of left) this.#withheld.delete(id);
    for (const [id, message] of refused) this.#withheld.set(id, message);
    this.#byOwner.set(owner, new Set(refused.keys()));

    const changed = [...entered, ...left, ...reworded.map(([id]) => id)];
    if (changed.length === 0 || this.#states === undefined) return 0;

    try {
      const moved = await this.#db.tx(async (q) => {
        const at = this.#now();
        // `access` is the only cause this can speak for; the words themselves come from the set.
        const count = await this.#states?.reevaluate(q, changed, at, {
          message: '',
          sources: ['access'],
        });
        // A master that has just become Unknown is not Down, so whatever it held is released —
        // and one that is evaluated again may hold them again (`P-135`'s reasoning).
        await this.#dependencies?.recompute(q, at);
        return count ?? 0;
      });
      if (entered.length > 0 || left.length > 0) {
        this.#logger.info(
          { owner, withheld: entered.length, released: left.length, moved },
          'sensors withheld or released because of who vouched for them',
        );
      }
      return moved;
    } catch (error) {
      // The set is already right; only the stored states are behind, and the next sweep's
      // settle or any re-decision of these sensors reads the set again.
      this.#logger.error(
        { owner, sensors: changed.length, err: describeError(error) },
        'could not re-decide sensors after a voucher check; the live fact is correct',
      );
      return 0;
    }
  }

  async #readableFor(
    userId: number,
    account: Account,
    ids: readonly number[],
  ): Promise<ReadonlyMap<number, boolean>> {
    const key = `${String(userId)}:${account.role}`;
    let known = this.#readable.get(key);
    if (known === undefined) {
      known = new Map();
      this.#readable.set(key, known);
    }
    const unknown = [...new Set(ids)].filter((id) => !known.has(id));
    if (unknown.length === 0) return known;

    let sees = this.#sights.get(key);
    if (sees === undefined) {
      sees = await this.#sight({ userId, role: account.role }, this.#db);
      this.#sightsResolved += 1;
      this.#sights.set(key, sees);
    }
    if (!sees.everything) this.#readsAsked += 1;
    const visible = await sees.visibleAmong(this.#db, unknown);
    for (const id of unknown) known.set(id, visible.has(id));
    return known;
  }
}
