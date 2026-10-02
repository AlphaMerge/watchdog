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
  // Not named: whoever reads this sensor may not be able to see the one it reads (`M-23`).
  upstream:
    'Not evaluated: every channel it computes reads a sensor that is itself not being ' +
    'evaluated, because of who vouched for that one. It is evaluated again when that sensor is.',
} as const;

/**
 * What an evaluator needs (`A-29`): which sensors to leave alone this sweep, and a place to say
 * so. `SensorVouching` is the one there is; the interface is what a unit test of a sweep stubs.
 */
export interface VoucherCheck {
  refusals(sensors: readonly SensorToVouchFor[]): Promise<Map<number, string>>;
  settle(owner: string, refused: ReadonlyMap<number, string>): Promise<number>;
}

/**
 * A set of sensors not being evaluated that has already moved, and what moved (`M-28`): settled
 * beside the voucher sets, in their transaction.
 */
export interface StagedSet {
  /** The sensors that came in. */
  readonly entered: readonly number[];
  /** The sensors that went out. */
  readonly left: readonly number[];
  /** Whether it holds this sensor now. */
  holds(sensorId: number): boolean;
  /** The cause it decides, and the words for a sensor it decides. */
  readonly cause: SensorStateCause;
  readonly message: string;
  /** Puts the set back, for a write that did not land. */
  undo(): void;
}

/** What this needs from the state service: re-decide these, in this transaction. */
export interface WithheldReevaluator {
  reevaluate(
    q: Queryable,
    sensorIds: readonly number[],
    at: Date,
    cause: { message: string; sources?: readonly SensorStateCause[] },
  ): Promise<number>;
  /**
   * Drops what is cached about these sensors, so the next result is decided from the stored row
   * with the live facts as they are now (`A-41c`). Absent, `release` is only right for a caller
   * whose cache holds nothing.
   */
  forgetSensors?(sensorIds: readonly number[]): void;
}

/** Sensors let go by `SensorVouching.release`, and the two things that can follow. */
export interface ReleasedHold {
  /** The sensors nothing withholds any more. */
  readonly released: readonly number[];
  /** Puts them back as they were held: the result that was to decide them was not stored. */
  undo(): void;
  /**
   * The result was stored and has decided them: a master among them that held its dependents
   * while it was withheld settles now, as any master evaluated again does (`M-23`).
   */
  evaluated(): Promise<void>;
}

/**
 * Settles `paused_by_dependency` after sensors have moved, as `ProbeReachability` does, and keeps
 * a master withheld while Down holding what it held (`M-23`).
 */
export interface WithheldDependencies {
  holdWithheld(q: Queryable, sensorIds: readonly number[]): Promise<void>;
  returnWithheld(q: Queryable, sensorIds: readonly number[], now: Date): Promise<void>;
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
  /**
   * `api.requireAuthentication` (`A-45`). Off, the authorisation layer is off, and no account's
   * voucher is held against a sensor. Defaults to on.
   */
  requireAuthentication?: boolean;
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
  readonly #requireAuthentication: boolean;
  readonly #states: WithheldReevaluator | undefined;
  readonly #dependencies: WithheldDependencies | undefined;
  readonly #now: () => Date;

  /** Every withheld sensor, with its sentence. What `SensorStateService` lays over the facts. */
  readonly #withheld = new Map<number, string>();
  /**
   * Which sweep withholds which sensors, and in what words, so one sweep's answer never clears
   * another's. A sensor moving between probes is withheld by one probe's check and released by
   * the other's, in either order (`A-41`).
   */
  readonly #byOwner = new Map<string, ReadonlyMap<number, string>>();
  /**
   * Sensors let go by `release` whose dependents have not been settled yet, because that write
   * failed. Tried again with the next release that is evaluated.
   */
  readonly #unreturned = new Set<number>();

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
    this.#requireAuthentication = options.requireAuthentication ?? true;
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
    // **With the layer off, no account's voucher is held against a sensor** (`A-45`). Nobody's
    // grants apply to any reader then, so a sensor republishes nothing its readers could not read
    // anyway, and withholding it protected nobody while stopping what it measures, Core Health's
    // own figures included. That covers the vouchers migration 059 took from the audit log on
    // such an installation, and any an account wrote while `writerFor` took a login to mean the
    // layer was on. They are not rewritten: switching the layer on holds each to its account
    // again, as a write made then would be, where rewriting them at a start with the layer off
    // would drop every account's voucher for good the first time an operator switched it off.
    if (!this.#requireAuthentication) return refused;
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
  settle(owner: string, refused: ReadonlyMap<number, string>): Promise<number> {
    return this.settleTogether(new Map([[owner, refused]]));
  }

  /**
   * `settle`, for a caller that is not a sweep (`A-41c`): it throws when the re-decision did not
   * land, with the set put back as it was.
   *
   * A sweep settles its whole answer every time, so a write that failed is made again by the next
   * one, and `settle` only logs. A caller that settles when something changed has no next time:
   * told nothing, it would believe a hold that was never made, or a release that was undone.
   */
  settleOrThrow(
    owner: string,
    refused: ReadonlyMap<number, string>,
    /**
     * When what changed was decided, if not now. A probe's refusal is stamped as the probe
     * measured it, like the results either side of it: stamped with this core's clock, a hold
     * replayed from a spool sorted after the reading that had already let it go, and the history
     * that uptime is computed from ended on Unknown for a sensor that was Up.
     */
    at?: Date,
  ): Promise<number> {
    return this.#settleAll(new Map([[owner, refused]]), undefined, true, at);
  }

  /**
   * Lets `owner`'s hold on these sensors go **without re-deciding them** (`A-41c`): a result for
   * each is in hand, and the machine decides the sensor from that, once.
   *
   * Re-decided here, a sensor would first return to whatever it read before it was withheld. One
   * that was Down then went Unknown, Down and Up in one batch: a transition and an alarm for an
   * outage nobody saw at that moment. So only the live fact moves, in memory, and what is cached
   * about the sensor is dropped so that the result is decided against the fact as it is now.
   *
   * Nothing is written, so nothing here can fail. The caller says what became of the result:
   * `undo` when it was not stored, `evaluated` when it was.
   */
  release(owner: string, sensorIds: readonly number[]): ReleasedHold {
    const before = this.#byOwner.get(owner);
    const taken = new Map<number, string>();
    for (const id of sensorIds) {
      const message = before?.get(id);
      if (message !== undefined) taken.set(id, message);
    }
    if (before === undefined || taken.size === 0) {
      return { released: [], undo: () => undefined, evaluated: () => Promise.resolve() };
    }
    this.#byOwner.set(owner, new Map([...before].filter(([id]) => !taken.has(id))));
    const released: number[] = [];
    for (const id of taken.keys()) {
      if (this.#recount(id) === undefined) released.push(id);
    }
    this.#states?.forgetSensors?.([...taken.keys()]);
    this.#logger.info(
      { owner, released: released.length },
      'sensors released to the result that decides them',
    );

    return {
      released,
      undo: () => {
        const now = new Map(this.#byOwner.get(owner));
        // Whatever was held again meanwhile keeps its newer words.
        for (const [id, message] of taken) if (!now.has(id)) now.set(id, message);
        this.#byOwner.set(owner, now);
        for (const id of taken.keys()) this.#recount(id);
        this.#states?.forgetSensors?.([...taken.keys()]);
      },
      evaluated: async () => {
        for (const id of released) this.#unreturned.add(id);
        if (this.#dependencies === undefined) {
          this.#unreturned.clear();
          return;
        }
        // Not one withheld again since: that one is held, and settles when it is let go.
        const returning = [...this.#unreturned].filter((id) => !this.#withheld.has(id));
        if (returning.length === 0) return;
        try {
          await this.#db.tx(async (q) => {
            const at = this.#now();
            await this.#dependencies?.returnWithheld(q, returning, at);
            await this.#dependencies?.recompute(q, at);
          });
          for (const id of returning) this.#unreturned.delete(id);
        } catch (error) {
          this.#logger.error(
            { owner, sensors: returning.length, err: describeError(error) },
            'could not settle what depends on sensors released to their results; the next ' +
              'release tries again',
          );
        }
      },
    };
  }

  /**
   * Replaces what each owner withholds, and re-decides what crossed, in one transaction with
   * `alongside`, a set that holds sensors unevaluated for another reason and has already moved
   * (`M-28`).
   *
   * **Every set moves before anything is re-decided.** Settled one after another, a sensor
   * leaving one set for another was re-decided in between, with neither: it passed through its
   * last reading, a transition and a notification on the way, and then went back to Unknown. The
   * factory sweep's own refusals, what it withholds for what a factory reads, and the factories
   * held for their inputs' probe are three sets, and a factory can cross between any two in one
   * sweep. So what came in or went out is counted against all of them together: a sensor that
   * only moved between them is re-decided once, and neither holds nor lets go what depends on it.
   */
  settleTogether(
    owners: ReadonlyMap<string, ReadonlyMap<number, string>>,
    alongside?: StagedSet,
  ): Promise<number> {
    return this.#settleAll(owners, alongside, false);
  }

  async #settleAll(
    owners: ReadonlyMap<string, ReadonlyMap<number, string>>,
    alongside: StagedSet | undefined,
    /** Whether a write that failed is the caller's to hear about, after the sets are put back. */
    strict: boolean,
    stamped?: Date,
  ): Promise<number> {
    const had = new Map<string, ReadonlyMap<number, string> | undefined>();
    const touched = new Set<number>([...(alongside?.entered ?? []), ...(alongside?.left ?? [])]);
    for (const [owner, refused] of owners) {
      const before = this.#byOwner.get(owner);
      had.set(owner, before);
      for (const id of before?.keys() ?? []) touched.add(id);
      for (const id of refused.keys()) touched.add(id);
    }
    const was = new Map([...touched].map((id) => [id, this.#withheld.get(id)]));
    for (const [owner, refused] of owners) this.#byOwner.set(owner, new Map(refused));

    const cameIn = new Set(alongside?.entered);
    const wentOut = new Set(alongside?.left);
    const heldBefore = (id: number): boolean =>
      alongside !== undefined &&
      (cameIn.has(id) ? false : wentOut.has(id) ? true : alongside.holds(id));
    const entered: number[] = [];
    const left: number[] = [];
    const changed: number[] = [];
    for (const id of touched) {
      const before = was.get(id);
      const now = this.#recount(id);
      if (before === now && !cameIn.has(id) && !wentOut.has(id)) continue;
      changed.push(id);
      const unevaluatedBefore = before !== undefined || heldBefore(id);
      const unevaluatedNow = now !== undefined || alongside?.holds(id) === true;
      if (!unevaluatedBefore && unevaluatedNow) entered.push(id);
      else if (unevaluatedBefore && !unevaluatedNow) left.push(id);
    }
    if (changed.length === 0 || this.#states === undefined) return 0;

    try {
      const moved = await this.#db.tx(async (q) => {
        const at = stamped ?? this.#now();
        // **A master withheld while Down keeps holding until it is evaluated again** (`M-23`).
        // Marked while its state still says Down: Unknown is not Down, and letting go would page
        // each dependent on the outage the master can no longer speak for.
        await this.#dependencies?.holdWithheld(q, entered);
        // `access` is the cause this can speak for, and the words come from the set. The set
        // alongside speaks for its own.
        const count = await this.#states?.reevaluate(q, changed, at, {
          message: alongside?.message ?? '',
          sources: alongside === undefined ? ['access'] : ['access', alongside.cause],
        });
        // Vouched for again, a master is evaluated again, and settles as any master returning
        // from Down does: holding if Down, after the configured delay if not.
        await this.#dependencies?.returnWithheld(q, left, at);
        await this.#dependencies?.recompute(q, at);
        return count ?? 0;
      });
      if (entered.length > 0 || left.length > 0) {
        this.#logger.info(
          { owners: [...owners.keys()], withheld: entered.length, released: left.length, moved },
          'sensors withheld or released because of who vouched for them or what they read',
        );
      }
      return moved;
    } catch (error) {
      // **Put back, so that the next sweep tries again** (`A-45`). The set moved before the write,
      // and kept after a write that failed, the next sweep found nothing had changed and never
      // re-decided these sensors: a withheld one kept its stored state, Up and counted as
      // monitored, or Down with its alarm still paging. Restored, the next settle sees the same
      // crossings and makes the same write. Recounted rather than copied back, so another owner
      // that settled while this write was out keeps what it did.
      for (const [owner, before] of had) {
        if (before === undefined) this.#byOwner.delete(owner);
        else this.#byOwner.set(owner, before);
      }
      for (const id of touched) this.#recount(id);
      alongside?.undo();
      this.#logger.error(
        { owners: [...owners.keys()], sensors: changed.length, err: describeError(error) },
        'could not re-decide sensors after a voucher check; the next sweep tries again',
      );
      if (strict) throw error;
      return 0;
    }
  }

  /** Sets the live fact for one sensor from what the owners hold, and returns it. */
  #recount(sensorId: number): string | undefined {
    const now = this.#heldBy(sensorId);
    if (now === undefined) this.#withheld.delete(sensorId);
    else this.#withheld.set(sensorId, now);
    return now;
  }

  /** The words of the first sweep still withholding this sensor, or undefined if none is. */
  #heldBy(sensorId: number): string | undefined {
    for (const held of this.#byOwner.values()) {
      const message = held.get(sensorId);
      if (message !== undefined) return message;
    }
    return undefined;
  }

  /**
   * What this account can read of these ids, cached for the epoch `refusals` last read.
   *
   * **Stored only under the epoch it was resolved at** (`A-45`). The factory, Probe Health and
   * Core Health sweeps share this and run in phase, so another sweep's `refusals` can move the
   * epoch and empty the caches while this one waits on the database. A sight resolved before a
   * revoke and stored after that answered with the revoked grant under the new epoch, until the
   * next grant change, which on a quiet installation is never. A sight from another epoch is used
   * for this call and not kept. The answers need no such guard: a new epoch empties the map they
   * go into, so one that lands late lands where nothing reads it again.
   */
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
      if (this.#current(sees)) this.#sights.set(key, sees);
    }
    if (!sees.everything) this.#readsAsked += 1;
    const visible = await sees.visibleAmong(this.#db, unknown);
    for (const id of unknown) known.set(id, visible.has(id));
    return known;
  }

  /** Whether a sight was resolved at the epoch the caches hold. */
  #current(sees: Visibility): boolean {
    return sees.epoch !== null && String(sees.epoch) === this.#epoch;
  }
}
