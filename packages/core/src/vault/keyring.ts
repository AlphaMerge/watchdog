import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError } from '@ms/shared';

/**
 * Where the vault's keys come from (`A-05`).
 *
 * **A key file, and not the OS keystore, which the task offers as the alternative.** On Linux the
 * keystore is libsecret talking to gnome-keyring over a *session* D-Bus; a systemd system service
 * has no session bus and no unlocked keyring, so the mechanism is unavailable exactly where this
 * runs. On Windows it is DPAPI, which needs a native addon — and CLAUDE.md's first constraint is
 * that production is a standalone native service, so a key path that works on one platform, in
 * one session type, with a compiled dependency, is not a key path.
 *
 * What a file gives instead is something an operator can reason about: it is on disk, it has
 * permissions, it can be backed up, and losing it loses exactly the monitored-device credentials
 * and nothing else. The obligations that come with that are enforced rather than documented —
 * the mode is checked on every read, and a key is generated at first start rather than defaulted
 * to something guessable.
 */

/** AES-256. Anything else is a mistake in the file rather than a configuration choice. */
const KEY_BYTES = 32;

export class VaultKeyError extends AppError {
  constructor(message: string, context: Record<string, string | number> = {}) {
    super('VAULT_KEY_UNUSABLE', message, { context });
    this.name = 'VaultKeyError';
  }
}

export interface VaultKey {
  readonly id: string;
  readonly key: Buffer;
}

interface StoredKey {
  id: string;
  key: string;
  createdAt: string;
}

interface KeyFile {
  currentId: string;
  keys: StoredKey[];
}

/**
 * The keys this installation can decrypt with, and the one it encrypts with.
 *
 * **Several keys, one current.** `credential_set.key_id` has been in the schema since migration
 * 001 for this: rotating means adding a key and making it current, after which new writes use it
 * and old rows stay readable until they are rewritten. A vault with one key can only rotate by
 * decrypting everything up front, under a lock, with no way to resume if it stops halfway.
 */
export class VaultKeyring {
  readonly #keys: ReadonlyMap<string, Buffer>;
  readonly #currentId: string;

  private constructor(keys: ReadonlyMap<string, Buffer>, currentId: string) {
    this.#keys = keys;
    this.#currentId = currentId;
  }

  /** For tests and for an in-memory installation. Never reads or writes a file. */
  static fromKeys(keys: readonly VaultKey[], currentId?: string): VaultKeyring {
    if (keys.length === 0) throw new VaultKeyError('a keyring needs at least one key');
    const map = new Map<string, Buffer>();
    for (const { id, key } of keys) {
      if (key.length !== KEY_BYTES) {
        throw new VaultKeyError(
          `key "${id}" is ${String(key.length)} bytes; the vault uses AES-256, so it needs ` +
            String(KEY_BYTES),
          { keyId: id },
        );
      }
      map.set(id, key);
    }
    const current = currentId ?? keys[keys.length - 1]?.id ?? '';
    if (!map.has(current)) {
      throw new VaultKeyError(`the current key "${current}" is not in the keyring`);
    }
    return new VaultKeyring(map, current);
  }

  /**
   * Loads the key file, creating one if it is not there.
   *
   * **Generated rather than defaulted.** The alternative — a key derived from something the
   * installer already knows, or a constant with a "change this" comment — produces an
   * installation that is encrypted in form and not in fact, and nobody finds out. A file that
   * did not exist a moment ago is unambiguous.
   */
  static load(path: string, options: { create?: boolean } = {}): VaultKeyring {
    const create = options.create ?? true;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw new VaultKeyError(`could not read the vault key file at ${path}: ${describe(error)}`);
      }
      if (!create) {
        throw new VaultKeyError(
          `there is no vault key file at ${path}, and this installation was told not to make ` +
            'one — monitored-device credentials cannot be read or written without it',
        );
      }
      return VaultKeyring.#create(path);
    }

    VaultKeyring.#assertPrivate(path);

    let parsed: KeyFile;
    try {
      parsed = JSON.parse(raw) as KeyFile;
    } catch (error) {
      throw new VaultKeyError(
        `the vault key file at ${path} is not valid JSON: ${describe(error)} — it is not ` +
          'regenerated automatically, because a new key would silently orphan every stored ' +
          'credential rather than reporting that this one is unreadable',
      );
    }

    // `parsed` is whatever the file held, so the array may genuinely be missing however the
    // declared type reads.
    const stored: readonly StoredKey[] = Array.isArray(parsed.keys) ? parsed.keys : [];
    const keys = stored.map((stored) => ({
      id: stored.id,
      key: Buffer.from(stored.key, 'base64'),
    }));
    if (keys.length === 0) {
      throw new VaultKeyError(`the vault key file at ${path} holds no keys`);
    }
    return VaultKeyring.fromKeys(keys, parsed.currentId);
  }

  get currentId(): string {
    return this.#currentId;
  }

  /** The key to encrypt with. */
  current(): VaultKey {
    const key = this.#keys.get(this.#currentId);
    /* c8 ignore next -- the constructor refuses a current id that is not in the map */
    if (key === undefined) throw new VaultKeyError('the current vault key has gone');
    return { id: this.#currentId, key };
  }

  /**
   * The key a stored record names, or a refusal that says which one is missing.
   *
   * Naming it matters: "the key that encrypted this is not in the key file" and "the key file is
   * wrong" look identical from a failed decryption, and only the first tells an operator which
   * backup to go and find.
   */
  byId(id: string): Buffer {
    const key = this.#keys.get(id);
    if (key === undefined) {
      throw new VaultKeyError(
        `this credential was encrypted with vault key "${id}", which is not in the key file — ` +
          'restore that key, or delete and re-enter the credential',
        { keyId: id },
      );
    }
    return key;
  }

  get size(): number {
    return this.#keys.size;
  }

  static #create(path: string): VaultKeyring {
    const id = `k${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    const key = randomBytes(KEY_BYTES);
    const file: KeyFile = {
      currentId: id,
      keys: [{ id, key: key.toString('base64'), createdAt: new Date().toISOString() }],
    };
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // The mode is on the open, not a chmod after it: writing world-readable and narrowing a
      // moment later leaves a window in which the key was readable, and it is the only window
      // that matters.
      writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(path, 0o600);
    } catch (error) {
      throw new VaultKeyError(`could not create the vault key file at ${path}: ${describe(error)}`);
    }
    return VaultKeyring.fromKeys([{ id, key }], id);
  }

  /**
   * Refuses a key file anyone else on the box can read.
   *
   * Checked on every load rather than only on the one this created: a key file is restored from
   * backups, copied between hosts and edited by hand, and any of those can widen the mode. A
   * warning would be the wrong response — the file would stay readable and the installation would
   * keep running as though it were not.
   */
  static #assertPrivate(path: string): void {
    let mode: number;
    try {
      mode = statSync(path).mode & 0o777;
    } catch (error) {
      /* c8 ignore next 2 -- the file was just read successfully */
      throw new VaultKeyError(`could not stat the vault key file at ${path}: ${describe(error)}`);
    }
    // Windows does not carry POSIX modes, and Node reports something that always looks too wide.
    if (process.platform === 'win32') return;
    if ((mode & 0o077) !== 0) {
      throw new VaultKeyError(
        `the vault key file at ${path} is mode ${mode.toString(8).padStart(4, '0')}, which lets ` +
          'other users on this machine read every monitored-device credential — run ' +
          `"chmod 600 ${path}"`,
      );
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
