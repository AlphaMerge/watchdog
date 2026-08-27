import {
  assertSplittable,
  credentialKind,
  credentialKindIds,
  secretFields,
  splitCredential,
  CREDENTIAL_KINDS,
  type CredentialKindDefinition,
} from '@ms/sensors';
import { AppError, type Logger } from '@ms/shared';
import type { Queryable } from '../db/pool.js';
import type {
  CredentialKind,
  InheritanceResolver,
  SealedCredential,
} from '../settings/inheritance.js';
import { VaultSealer } from './sealer.js';

/**
 * The credential vault (`A-05`).
 *
 * **Pulled forward out of Phase 9, and only the half that does not need accounts.** The task
 * depends on `A-03` (per-object access rights), which needs `A-02` and `A-01` — none of which
 * exist. But that dependency is about *who may write* a credential, and everything here is
 * already write-only to **everyone**, which is the stronger property CLAUDE.md demands. What
 * `A-03`/`A-04` still add is the permission check on the write, and that is one guard in one
 * place when accounts arrive.
 *
 * Pulling it forward is what `A-05`'s own note asked for: Phase 6 precedes Phase 9, and `T-01`
 * made the consequence real. Without this, an SNMP sensor carries its own community string, so
 * forty sensors on a router hold forty copies of it and rotating means editing forty.
 */
export class VaultError extends AppError {
  constructor(code: string, message: string, context: Record<string, string | number> = {}) {
    super(code, message, { context });
    this.name = 'VaultError';
  }
}

export interface CredentialVaultOptions {
  resolver: InheritanceResolver;
  sealer: VaultSealer;
  logger: Logger;
}

/** A credential in force for a sensor, decrypted, with the marker that says when it changed. */
export interface ResolvedSecret {
  readonly values: Record<string, unknown>;
  /**
   * Identifies *which* record and *when* it was last written — never its contents.
   *
   * The probe's configuration fingerprint has to change when a credential is rotated, or a probe
   * holding the old one is told its configuration is unchanged and keeps authenticating with it.
   * The obvious way to get that is to hash the credential into the fingerprint, and it is a
   * mistake: a community string is short and drawn from a tiny space, so a published SHA-256 of
   * one is recovered by guessing, and the fingerprint is sent to probes and written to logs.
   * The owning object and the update time change on every rotation and reveal nothing.
   */
  readonly stamp: string;
}

/** What a write did, for the audit entry — kinds and field *names*, never a value. */
export interface CredentialWriteSummary {
  readonly kind: string;
  readonly created: boolean;
  /** Names of the secret fields this write replaced. Never their values, at any age. */
  readonly secretsSet: readonly string[];
  /** Names of the secret fields it deliberately left as they were. */
  readonly secretsKept: readonly string[];
  readonly publicParams: Readonly<Record<string, unknown>>;
}

export class CredentialVault {
  readonly #resolver: InheritanceResolver;
  readonly #sealer: VaultSealer;
  readonly #logger: Logger;

  constructor(options: CredentialVaultOptions) {
    this.#resolver = options.resolver;
    this.#sealer = options.sealer;
    this.#logger = options.logger.child({ component: 'vault' });
    // Every kind, at construction, so a schema that could leak a secret into `public_params`
    // stops the core at boot rather than being discovered in a database column.
    for (const definition of CREDENTIAL_KINDS) assertSplittable(definition);
  }

  /** The kinds an operator can store, with the schema a form is generated from. */
  kinds(): readonly CredentialKindDefinition[] {
    return CREDENTIAL_KINDS;
  }

  definition(kind: string): CredentialKindDefinition {
    const found = credentialKind(kind);
    if (found === undefined) {
      throw new VaultError(
        'CREDENTIAL_KIND_UNKNOWN',
        `"${kind}" is not a credential kind this build can use — it knows ` +
          `${credentialKindIds().join(', ')}. A kind with no transport behind it would store a ` +
          'password nothing ever authenticates with',
        { kind },
      );
    }
    return found;
  }

  /**
   * Writes a credential set on one object, replacing whatever was there.
   *
   * **A secret the caller omits is kept, exactly as a sensor parameter is** (`U-08`'s
   * `carryWriteOnly`, and the same reasoning): a read never returns the value, so nothing
   * outside the core can send it back, and a write that replaced the whole record would delete
   * the community string every time somebody corrected the SNMP version beside it. Sending the
   * field with a value rotates it; sending `null` removes it.
   *
   * Takes a `Queryable` rather than opening its own transaction: the caller writes the audit
   * entry in the same one, so an entry cannot exist for a change that rolled back.
   */
  async write(
    q: Queryable,
    objectId: number,
    kind: string,
    values: Readonly<Record<string, unknown>>,
  ): Promise<CredentialWriteSummary> {
    const definition = this.definition(kind);
    const { publicParams, secret } = splitCredential(definition, values);

    const [existing] = await q.query<{ secret: Buffer; key_id: string }>(
      'SELECT secret, key_id FROM credential_set WHERE object_id = $1 AND kind = $2',
      [objectId, kind],
    );

    const held =
      existing === undefined
        ? {}
        : this.#sealer.open(existing.secret, existing.key_id, { objectId, kind });

    const merged: Record<string, unknown> = { ...held };
    const secretsSet: string[] = [];
    const removed: string[] = [];
    for (const field of secretFields(definition)) {
      if (!(field in secret)) continue;
      const value = secret[field];
      if (value === null || value === '') {
        // An explicit unset. Distinct from omitting the field, which keeps it — the difference
        // a form's "Clear" button relies on.
        if (field in merged) removed.push(field);
        Reflect.deleteProperty(merged, field);
        continue;
      }
      merged[field] = value;
      secretsSet.push(field);
    }
    const secretsKept = Object.keys(merged).filter((field) => !secretsSet.includes(field));

    const sealed = this.#sealer.seal(merged, { objectId, kind });
    await q.query(
      `
      INSERT INTO credential_set (object_id, kind, public_params, secret, key_id)
      VALUES ($1, $2, $3::jsonb, $4, $5)
      ON CONFLICT (object_id, kind) DO UPDATE
        SET public_params = EXCLUDED.public_params,
            secret        = EXCLUDED.secret,
            key_id        = EXCLUDED.key_id,
            updated_at    = now()
      `,
      [objectId, kind, JSON.stringify(publicParams), sealed.bytes, sealed.keyId],
    );

    this.#logger.info(
      {
        objectId,
        kind,
        created: existing === undefined,
        // Field names, never values — this line goes to a log file.
        secretsSet,
        secretsRemoved: removed,
      },
      'credential set written',
    );

    return {
      kind,
      created: existing === undefined,
      secretsSet,
      secretsKept,
      publicParams,
    };
  }

  /** Removes the credential set on this object. Returns false when there was none. */
  async clear(q: Queryable, objectId: number, kind: string): Promise<boolean> {
    this.definition(kind);
    const rows = await q.query<{ object_id: string }>(
      'DELETE FROM credential_set WHERE object_id = $1 AND kind = $2 RETURNING object_id',
      [objectId, kind],
    );
    return rows.length > 0;
  }

  /**
   * The decrypted credentials for many sensors at once, for the probe configuration.
   *
   * **The only path a secret takes out of the database**, and it goes to one place: the config
   * push over the probe channel's mutual TLS. Worth stating what that costs — the probe holds
   * them in memory for as long as it is scanning, which it must, because it is the thing doing
   * the authenticating. It does not write them anywhere: assignments live in a `Map` and the only
   * file the probe writes is the result spool, which carries check outcomes and never parameters.
   *
   * A kind that is not configured anywhere up the tree is simply absent from the result rather
   * than an error. Whether a sensor can run without it is the sensor type's judgement, and it is
   * the one placed to say which kind is missing.
   */
  async resolveFor(
    sensorIds: readonly number[],
    kinds: readonly CredentialKind[],
  ): Promise<Map<number, Map<string, ResolvedSecret>>> {
    const out = new Map<number, Map<string, ResolvedSecret>>();
    if (sensorIds.length === 0 || kinds.length === 0) return out;

    const sealed = await this.#resolver.resolveSealedCredentials(sensorIds, kinds);

    // One record can be inherited by hundreds of sensors, so it is opened once and shared rather
    // than decrypted per sensor: a branch of 5,000 sensors under one device would otherwise be
    // 5,000 AES operations to build one push.
    const opened = new Map<string, Record<string, unknown>>();

    for (const [sensorId, byKind] of sealed) {
      const forSensor = new Map<string, ResolvedSecret>();
      for (const [kind, record] of byKind) {
        const cacheKey = `${String(record.ownerId)}:${kind}:${record.updatedAt}`;
        let secret = opened.get(cacheKey);
        if (secret === undefined) {
          secret = this.#open(record);
          opened.set(cacheKey, secret);
        }
        forSensor.set(kind, {
          values: { ...record.publicParams, ...secret },
          // What changes when a credential is rotated, and the only part of a credential that
          // may be hashed into a configuration fingerprint — see `ProbeConfigService`.
          stamp: `${String(record.ownerId)}@${record.updatedAt}`,
        });
      }
      if (forSensor.size > 0) out.set(sensorId, forSensor);
    }
    return out;
  }

  /**
   * A record that cannot be decrypted is dropped, loudly, rather than failing the whole push.
   *
   * One unreadable credential — a key restored without its predecessor, a row altered — would
   * otherwise stop every sensor on the probe from being configured, turning one broken device
   * into an outage. The sensors that need it fail their checks and say so, which is the blast
   * radius the operator can act on.
   */
  #open(record: SealedCredential): Record<string, unknown> {
    try {
      return this.#sealer.open(record.secret, record.keyId, {
        objectId: record.ownerId,
        kind: record.kind,
      });
    } catch (error) {
      this.#logger.error(
        {
          objectId: record.ownerId,
          kind: record.kind,
          keyId: record.keyId,
          err: error instanceof Error ? error.message : String(error),
        },
        'a stored credential could not be decrypted; sensors using it will fail to authenticate',
      );
      return {};
    }
  }
}

export { VaultSealer };
