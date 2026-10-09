import { credentialKind, declaredPublic } from '@ms/sensors';
import { AppError, type Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import { settingRegistry } from './registry.js';

/**
 * A hard ceiling on the ancestor walk. Cycles are prevented by a trigger, a pre-check and the
 * tree lock, but a recursive CTE over a cyclic tree never returns rather than returning
 * something wrong — and a resolver that hangs takes the scheduler with it.
 */
const MAX_WALK_DEPTH = 1000;

/**
 * Where a resolved value came from.
 *
 * The UI needs this as much as the value itself: an inheritance-aware control shows what the
 * object would inherit and whether it is currently overriding it (U-09).
 */
export type SettingSource =
  | { kind: 'own'; objectId: number }
  | { kind: 'inherited'; objectId: number; depth: number }
  | { kind: 'default' };

export interface ResolvedSetting<T = unknown> {
  key: string;
  value: T;
  source: SettingSource;
}

/**
 * Every kind a credential set can be stored as: the `credential_kind` enum, as migration 001
 * declared it and migration 024 added `mail` to (`P-351`).
 *
 * The database's list, not the registry's. `@ms/sensors`' `CREDENTIAL_KINDS` is what this build
 * can use, a subset of this one; a kind it adds needs a migration, and the value here with it.
 */
export const CREDENTIAL_SET_KINDS = [
  'snmp',
  'windows',
  'ssh',
  'vmware',
  'database',
  'http',
  'mail',
] as const;
export type CredentialKind = (typeof CREDENTIAL_SET_KINDS)[number];

/**
 * A credential set in effect for an object, and where it comes from.
 *
 * There is no field a secret could occupy: the ciphertext is never selected, and neither is
 * the key id. Monitored-device credentials are write-only through every route, to everyone
 * (CLAUDE.md).
 */
export interface ResolvedCredential {
  kind: CredentialKind;
  publicParams: Record<string, unknown>;
  source: SettingSource;
  updatedAt: string;
}

/**
 * A credential set as it is stored: public half in the clear, secret half still encrypted.
 *
 * Only `resolveSealedCredentials` produces one, only `CredentialVault` opens one, and neither a
 * route nor the audit sink ever sees the type. `ownerId` is the object the record lives on —
 * which is what the seal is bound to, and is *not* the sensor that inherited it.
 */
export interface SealedCredential {
  kind: CredentialKind;
  publicParams: Record<string, unknown>;
  secret: Buffer;
  keyId: string;
  ownerId: number;
  updatedAt: string;
}

export class InheritanceError extends AppError {
  constructor(message: string, context: Record<string, string | number>) {
    super('INHERITANCE_FAILED', message, { context });
    this.name = 'InheritanceError';
  }
}

interface SettingRow {
  key: string;
  value: unknown;
  object_id: string;
  depth: number;
}

/**
 * Resolves inheritable settings against the object tree.
 *
 * The rule, from `CAPABILITIES.MD §1`: a setting resolves to the value defined by the nearest
 * ancestor that defines it; an object may override it locally; reverting to inherit discards
 * the local value. If nothing in the chain defines it, the registry default applies.
 *
 * **This is the only place parent-walking happens** (CLAUDE.md). Every subsystem that needs an
 * effective value — the scheduler, the state machine, the trigger engine, the UI — comes here.
 */
export class InheritanceResolver {
  readonly #db: Queryable;
  readonly #logger: Logger;

  constructor(options: { db: Queryable; logger: Logger }) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'inheritance' });
  }

  /**
   * A resolver bound to a transaction's executor rather than the pool.
   *
   * Without this, a mutation that asks "what changed?" reads through the pool and sees the
   * state from *before* its own uncommitted write — so every before/after diff reports that
   * nothing changed. Move and clone both depend on it.
   */
  withExecutor(executor: Queryable): InheritanceResolver {
    return new InheritanceResolver({ db: executor, logger: this.#logger });
  }

  /**
   * Resolves one setting for one object.
   *
   * One query: a recursive CTE walks from the object to the root, and `DISTINCT ON` takes the
   * shallowest row per key. Resolving in SQL rather than fetching the chain and looping keeps
   * this to a single round trip on the hottest path in the system.
   */
  async resolve<T = unknown>(objectId: number, key: string): Promise<ResolvedSetting<T>> {
    settingRegistry.get(key); // rejects unknown keys before touching the database
    const resolved = await this.resolveKeys(objectId, [key]);
    const value = resolved[key];
    if (value === undefined) {
      throw new InheritanceError('setting did not resolve', { objectId, key });
    }
    return value as ResolvedSetting<T>;
  }

  /** Resolves several settings for one object in a single query. */
  async resolveKeys(
    objectId: number,
    keys: readonly string[],
  ): Promise<Record<string, ResolvedSetting>> {
    for (const key of keys) settingRegistry.get(key);

    const rows = await this.#db.query<SettingRow>(
      `
      WITH RECURSIVE chain AS (
        SELECT id, parent_id, 0 AS depth
        FROM object
        WHERE id = $1

        UNION ALL

        SELECT parent.id, parent.parent_id, chain.depth + 1
        FROM object parent
        JOIN chain ON parent.id = chain.parent_id
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT DISTINCT ON (s.key)
             s.key, s.value, s.object_id, chain.depth
      FROM chain
      JOIN object_setting s ON s.object_id = chain.id
      WHERE s.key = ANY($2)
      -- Nearest ancestor wins: depth 0 is the object itself.
      ORDER BY s.key, chain.depth ASC
      `,
      [objectId, keys],
    );

    // An object with no rows at all might simply define nothing — or might not exist. Those
    // are very different, and silently returning defaults for a deleted object is how stale
    // configuration outlives the thing it configured.
    if (rows.length === 0 && !(await this.#objectExists(objectId))) {
      throw new InheritanceError('object does not exist', { objectId });
    }

    return this.#project(keys, rows);
  }

  /** Rows from a chain walk to a resolved value per key, defaulting whatever is missing. */
  #project(keys: readonly string[], rows: readonly SettingRow[]): Record<string, ResolvedSetting> {
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const out: Record<string, ResolvedSetting> = {};

    for (const key of keys) {
      const row = byKey.get(key);
      if (row === undefined) {
        out[key] = { key, value: settingRegistry.defaultFor(key), source: { kind: 'default' } };
        continue;
      }
      out[key] = {
        key,
        value: row.value,
        source:
          row.depth === 0
            ? { kind: 'own', objectId: Number(row.object_id) }
            : { kind: 'inherited', objectId: Number(row.object_id), depth: row.depth },
      };
    }

    return out;
  }

  /** Resolves every registered setting for one object — what a settings page renders. */
  async resolveAll(objectId: number): Promise<Record<string, ResolvedSetting>> {
    return this.resolveKeys(objectId, settingRegistry.keys);
  }

  /**
   * Resolves one setting for many objects at once.
   *
   * The scheduler needs the effective interval for every sensor, and the device tree needs
   * effective values for thousands of rows. Doing that one object at a time is thousands of
   * round trips; this is one.
   */
  async resolveForObjects<T = unknown>(
    objectIds: readonly number[],
    key: string,
  ): Promise<Map<number, ResolvedSetting<T>>> {
    settingRegistry.get(key);
    const out = new Map<number, ResolvedSetting<T>>();
    if (objectIds.length === 0) return out;

    const rows = await this.#db.query<{
      start_id: string;
      value: unknown;
      object_id: string;
      depth: number;
    }>(
      `
      WITH RECURSIVE chain AS (
        SELECT o.id AS start_id, o.id, o.parent_id, 0 AS depth
        FROM object o
        WHERE o.id = ANY($1)

        UNION ALL

        SELECT chain.start_id, parent.id, parent.parent_id, chain.depth + 1
        FROM object parent
        JOIN chain ON parent.id = chain.parent_id
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT DISTINCT ON (chain.start_id)
             chain.start_id, s.value, s.object_id, chain.depth
      FROM chain
      JOIN object_setting s ON s.object_id = chain.id AND s.key = $2
      ORDER BY chain.start_id, chain.depth ASC
      `,
      [objectIds, key],
    );

    const byStart = new Map(rows.map((row) => [Number(row.start_id), row]));
    for (const objectId of objectIds) {
      const row = byStart.get(objectId);
      if (row === undefined) {
        out.set(objectId, {
          key,
          value: settingRegistry.defaultFor(key) as T,
          source: { kind: 'default' },
        });
        continue;
      }
      out.set(objectId, {
        key,
        value: row.value as T,
        source:
          row.depth === 0
            ? { kind: 'own', objectId: Number(row.object_id) }
            : { kind: 'inherited', objectId: Number(row.object_id), depth: row.depth },
      });
    }

    return out;
  }

  /**
   * What this object's settings *would* resolve to if it hung under a different parent.
   *
   * This is the move-confirmation dialog's query. A dry-run that performs the move and rolls
   * back would hold the exclusive tree lock for what is only a read, and would inherit every
   * transaction-visibility hazard; a projection is a pure query over a hypothetical chain.
   *
   * The hypothetical chain is: the object itself at depth 0 (its own overrides travel with
   * it), then the candidate parent and its ancestors.
   */
  async resolveAllAsChildOf(
    objectId: number,
    hypotheticalParentId: number,
  ): Promise<Record<string, ResolvedSetting>> {
    const keys = settingRegistry.keys;

    const rows = await this.#db.query<SettingRow>(
      `
      WITH RECURSIVE up AS (
        SELECT o.id, o.parent_id, 1 AS depth
        FROM object o
        WHERE o.id = $2

        UNION ALL

        SELECT parent.id, parent.parent_id, up.depth + 1
        FROM object parent
        JOIN up ON parent.id = up.parent_id
        WHERE up.depth < ${String(MAX_WALK_DEPTH)}
      ),
      chain AS (
        -- The object keeps its own overrides wherever it hangs.
        SELECT $1::bigint AS id, 0 AS depth
        UNION ALL
        SELECT id, depth FROM up
      )
      SELECT DISTINCT ON (s.key)
             s.key, s.value, s.object_id, chain.depth
      FROM chain
      JOIN object_setting s ON s.object_id = chain.id
      WHERE s.key = ANY($3)
      ORDER BY s.key, chain.depth ASC
      `,
      [objectId, hypotheticalParentId, keys],
    );

    return this.#project(keys, rows);
  }

  /**
   * The credential sets in effect for an object: its own at depth 0, then the nearest
   * ancestor that defines each kind (CAPABILITIES.MD §10).
   *
   * This lives here, and not in a credential repository, because parent-walking happens in
   * exactly one place (CLAUDE.md). A-05 extends this method rather than writing a second one.
   *
   * `secret` and `key_id` are not in the SELECT list and never will be.
   */
  async resolveCredentials(objectId: number): Promise<ResolvedCredential[]> {
    const rows = await this.#db.query<{
      kind: CredentialKind;
      public_params: Record<string, unknown>;
      object_id: string;
      depth: number;
      updated_at: Date;
    }>(
      `
      WITH RECURSIVE chain AS (
        SELECT id, parent_id, 0 AS depth
        FROM object
        WHERE id = $1

        UNION ALL

        SELECT parent.id, parent.parent_id, chain.depth + 1
        FROM object parent
        JOIN chain ON parent.id = chain.parent_id
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT DISTINCT ON (cs.kind)
             cs.kind, cs.public_params, cs.object_id, chain.depth, cs.updated_at
      FROM chain
      JOIN credential_set cs ON cs.object_id = chain.id
      ORDER BY cs.kind, chain.depth ASC
      `,
      [objectId],
    );

    return rows.map((row) => ({
      kind: row.kind,
      publicParams: publicOf(row.kind, row.public_params),
      source:
        row.depth === 0
          ? { kind: 'own', objectId: Number(row.object_id) }
          : { kind: 'inherited', objectId: Number(row.object_id), depth: row.depth },
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  /**
   * The sealed credential records in effect for many objects at once (`A-05`).
   *
   * **The one place `credential_set.secret` is read**, and the only method on this class that
   * selects it. Everything else — `resolveCredentials`, every API route, the audit sink — sees
   * `public_params` and nothing more; CLAUDE.md's rule is that a monitored device's credentials
   * are never returned to anyone, and the exception is not "an administrator" but "the probe
   * that has to authenticate with them".
   *
   * The same walk as `resolveCredentials`, batched the way `resolveForObjects` is: the probe
   * configuration resolves a whole branch, and one query per sensor per kind would be thousands
   * of round trips to build one push.
   *
   * Returns the record still sealed. Decryption belongs to `CredentialVault`, which holds the
   * keys; this class does the parent-walking and nothing else.
   */
  async resolveSealedCredentials(
    objectIds: readonly number[],
    kinds: readonly CredentialKind[],
  ): Promise<Map<number, Map<CredentialKind, SealedCredential>>> {
    const out = new Map<number, Map<CredentialKind, SealedCredential>>();
    if (objectIds.length === 0 || kinds.length === 0) return out;

    const rows = await this.#db.query<{
      start_id: string;
      kind: CredentialKind;
      public_params: Record<string, unknown>;
      secret: Buffer;
      key_id: string;
      object_id: string;
      depth: number;
      updated_at: Date;
    }>(
      `
      WITH RECURSIVE chain AS (
        SELECT o.id AS start_id, o.id, o.parent_id, 0 AS depth
        FROM object o
        WHERE o.id = ANY($1)

        UNION ALL

        SELECT chain.start_id, parent.id, parent.parent_id, chain.depth + 1
        FROM object parent
        JOIN chain ON parent.id = chain.parent_id
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT DISTINCT ON (chain.start_id, cs.kind)
             chain.start_id, cs.kind, cs.public_params, cs.secret, cs.key_id,
             cs.object_id, chain.depth, cs.updated_at
      FROM chain
      JOIN credential_set cs ON cs.object_id = chain.id AND cs.kind = ANY($2::credential_kind[])
      ORDER BY chain.start_id, cs.kind, chain.depth ASC
      `,
      [objectIds, kinds],
    );

    for (const row of rows) {
      const startId = Number(row.start_id);
      let forObject = out.get(startId);
      if (forObject === undefined) {
        forObject = new Map<CredentialKind, SealedCredential>();
        out.set(startId, forObject);
      }
      forObject.set(row.kind, {
        kind: row.kind,
        publicParams: publicOf(row.kind, row.public_params),
        secret: row.secret,
        keyId: row.key_id,
        // The object the record is stored on, not the sensor asking. The seal is bound to it,
        // so decrypting against the sensor's id would fail on every inherited credential.
        ownerId: Number(row.object_id),
        updatedAt: row.updated_at.toISOString(),
      });
    }
    return out;
  }

  /** Sets an explicit local value, overriding whatever would be inherited. */
  async set(objectId: number, key: string, value: unknown): Promise<void> {
    settingRegistry.validate(key, value);
    if (!(await this.#objectExists(objectId))) {
      throw new InheritanceError('object does not exist', { objectId });
    }

    await this.#db.query(
      `
      INSERT INTO object_setting (object_id, key, value)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (object_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `,
      [objectId, key, JSON.stringify(value)],
    );
    this.#logger.debug({ objectId, key }, 'setting overridden');
  }

  /**
   * Reverts to inherited, **discarding** the local value (CAPABILITIES.MD §1).
   *
   * Deleting the row rather than flagging it is the point: PRTG's behaviour is that reverting
   * to inherit forgets what you had overridden it to, and a remembered value that reappears
   * later is exactly the surprise operators complain about.
   *
   * @returns whether a local value was actually removed
   */
  async clear(objectId: number, key: string): Promise<boolean> {
    settingRegistry.get(key);
    const rows = await this.#db.query<{ object_id: string }>(
      'DELETE FROM object_setting WHERE object_id = $1 AND key = $2 RETURNING object_id',
      [objectId, key],
    );
    const removed = rows.length > 0;
    if (removed) this.#logger.debug({ objectId, key }, 'setting reverted to inherited');
    return removed;
  }

  /** The values this object defines itself, ignoring inheritance. */
  async own(objectId: number): Promise<Record<string, unknown>> {
    const rows = await this.#db.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM object_setting WHERE object_id = $1',
      [objectId],
    );
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  async #objectExists(objectId: number): Promise<boolean> {
    const rows = await this.#db.query<{ exists: boolean }>(
      'SELECT true AS exists FROM object WHERE id = $1',
      [objectId],
    );
    return rows.length > 0;
  }
}

/**
 * The public half of a stored credential set, as far as its kind declares it (`A-43`).
 *
 * Both reads come through here, the API's and the probe's. A key written before `A-43` that the
 * kind does not declare may be a secret under a mistyped name, stored in the clear, so it is left
 * out whatever it holds. A kind this build does not know declares nothing.
 */
function publicOf(kind: string, stored: Record<string, unknown>): Record<string, unknown> {
  const definition = credentialKind(kind);
  return definition === undefined ? {} : declaredPublic(definition, stored);
}
