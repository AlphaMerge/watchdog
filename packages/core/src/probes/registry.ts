import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  addressAllowed,
  AppError,
  describeSkew,
  explainSkew,
  parseAddressFilter,
  PROTOCOL_VERSION,
  type Logger,
  type ProtocolSkew,
} from '@ms/shared';

/**
 * Which probes this installation trusts (`R-01`).
 *
 * **Reaching the port is not the same as being trusted, and until this existed it was.** A probe
 * that presented the shared access key was handed configuration immediately — it became part of
 * the installation because it connected. An operator could not see what had joined, could not
 * refuse one, and could not remove one without rotating the key every other probe shared.
 *
 * **A pending probe is welcomed, not rejected, and that is the central decision here.** It is
 * given its identity, it heartbeats, and it appears in the queue with the name, version and
 * address it reported — and it is given **no configuration at all**, so it scans nothing.
 * Rejecting it instead would leave an administrator approving something they cannot see, and
 * would make the probe re-enrol under a fresh identity on every retry, filling the queue with
 * one row per reconnect. `WORKFLOW.MD` makes the same argument about discovery: show what was
 * found, create nothing until somebody says so.
 *
 * **The per-probe key is what makes revocation mean anything.** Revoking one probe otherwise
 * means rotating the enrolment key every probe shares, which nobody does, which means in
 * practice nothing is ever revoked. So a key is generated at approval, sent in that one welcome,
 * and stored only as a hash.
 */

/** What the handshake is allowed to do with a probe that has just said hello. */
export type ProbeDecision =
  | { kind: 'approved'; gid: string; objectId: number | null; issuedKey?: string }
  | { kind: 'pending'; gid: string }
  | {
      kind: 'refused';
      code: 'revoked' | 'source-not-allowed' | 'bad-access-key' | 'protocol-version';
      detail: string;
    };

/**
 * A skew verdict with its own sentence attached, so every caller does not reassemble one.
 *
 * The union carries the parts a UI would arrange itself; `explanation` is the same thing said
 * once, for the log line, the API and the operator who wants a reason rather than a shape.
 */
export type RegistrationSkew = ProtocolSkew & { explanation: string };

export interface ProbeRegistration {
  gid: string;
  status: 'pending' | 'approved' | 'revoked';
  displayName: string;
  agentVersion: string;
  protocolVersion: number;
  lastAddress: string;
  allowFrom: string[];
  /** Whether a key has been issued to this probe. Never the key itself. */
  hasOwnKey: boolean;
  objectId: number | null;
  note: string;
  firstSeenAt: string;
  lastSeenAt: string | null;
  decidedAt: string | null;
  /**
   * What this probe's protocol version means for what it can do (`R-06`).
   *
   * **Derived rather than stored**, because it is a statement about *this build* as much as
   * about the probe: the same protocol-4 probe is current against a protocol-4 core and outdated
   * against this one, and a stored verdict would go stale the moment the core was upgraded —
   * which is the exact moment it matters.
   */
  skew: RegistrationSkew;
}

export class ProbeRegistryError extends AppError {
  readonly status: number;

  constructor(code: 'PROBE_NOT_FOUND' | 'PROBE_INVALID' | 'PROBE_CONFLICT', message: string) {
    super(code, message, { context: {} });
    this.name = 'ProbeRegistryError';
    this.status = code === 'PROBE_NOT_FOUND' ? 404 : code === 'PROBE_CONFLICT' ? 409 : 400;
  }
}

interface Db {
  query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<T[]>;
}

export interface ProbeRegistryOptions {
  db: Db;
  logger: Logger;
  /**
   * Keys any probe may present to *enrol*. Empty means enrolment needs no key at all, which is
   * only reasonable on a trusted network and is the shipped development default.
   */
  enrolmentKeys: readonly string[];
  /** Addresses any probe may enrol from, empty meaning anywhere. Per-probe filters narrow it. */
  enrolFrom?: readonly string[];
  now?: () => Date;
}

/** How a probe says hello, as far as the registry cares. */
export interface ProbeHello {
  gid: string;
  displayName: string;
  agentVersion: string;
  protocolVersion: number;
  accessKey: string;
  remoteAddress: string;
}

export class ProbeRegistry {
  readonly #db: Db;
  readonly #logger: Logger;
  readonly #enrolmentKeys: readonly string[];
  readonly #enrolFrom: readonly string[];
  readonly #now: () => Date;

  constructor(options: ProbeRegistryOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'probe-registry' });
    this.#enrolmentKeys = options.enrolmentKeys;
    this.#enrolFrom = options.enrolFrom ?? [];
    this.#now = options.now ?? ((): Date => new Date());
  }

  /**
   * What to do with a probe that has just connected.
   *
   * **Every path here writes what it saw**, including the refusals: an operator investigating
   * "why is backup-01 not scanning" needs the row that says a revoked identity tried at 04:12
   * from an address they do not recognise, and a refusal that left no trace is the one that
   * takes a day to find.
   */
  async admit(hello: ProbeHello): Promise<ProbeDecision> {
    const existing = hello.gid === '' ? null : await this.get(hello.gid);

    // Recorded before the decision, so a refused attempt is still visible in the queue.
    if (existing !== null) await this.#touch(existing.gid, hello);

    // **Version skew is a refusal like every other one here, so it is recorded like every other
    // one** (`R-06`). It used to be checked in the endpoint, before the registry saw the probe
    // at all, which meant the one refusal an operator is most likely to hit — they upgraded one
    // end and not the other — was the one refusal that left no row behind. The touch above ran
    // first, so the queue now shows the version the probe is actually running rather than the
    // version it ran the last time it managed to connect.
    //
    // A probe this core has *never* seen and cannot talk to is refused without a row. Enrolling
    // it would put something in the approval queue that approving cannot help, and its identity
    // claims are the claims of a peer whose protocol this build does not implement.
    const skew = describeSkew(hello.protocolVersion);
    if (skew.kind === 'incompatible') {
      this.#logger.warn(
        {
          gid: hello.gid,
          remoteAddress: hello.remoteAddress,
          protocolVersion: hello.protocolVersion,
          coreProtocolVersion: PROTOCOL_VERSION,
          known: existing !== null,
        },
        'refusing a probe whose protocol this core cannot speak',
      );
      return { kind: 'refused', code: 'protocol-version', detail: explainSkew(skew) };
    }

    if (existing === null) return this.#enrol(hello);

    if (existing.status === 'revoked') {
      this.#logger.warn(
        { gid: existing.gid, remoteAddress: hello.remoteAddress },
        'a revoked probe tried to connect',
      );
      return {
        kind: 'refused',
        code: 'revoked',
        detail: existing.note === '' ? 'this probe has been revoked' : existing.note,
      };
    }

    // The probe's own filter, then the installation's. A probe with a filter of its own is
    // saying something narrower than the default, and the narrower statement wins.
    const filters = existing.allowFrom.length > 0 ? existing.allowFrom : this.#enrolFrom;
    if (!addressAllowed(hello.remoteAddress, filters)) {
      this.#logger.warn(
        { gid: existing.gid, remoteAddress: hello.remoteAddress, filters },
        'a probe connected from an address its filter does not allow',
      );
      return {
        kind: 'refused',
        code: 'source-not-allowed',
        detail: `this probe is not accepted from ${hello.remoteAddress}`,
      };
    }

    if (existing.status === 'pending') {
      // A pending probe still presents the enrolment key, because it has none of its own yet.
      if (!this.#enrolmentKeyMatches(hello.accessKey)) {
        return {
          kind: 'refused',
          code: 'bad-access-key',
          detail: 'the access key was not accepted',
        };
      }
      return { kind: 'pending', gid: existing.gid };
    }

    if (!(await this.#keyAccepted(existing.gid, hello.accessKey))) {
      this.#logger.warn({ gid: existing.gid }, 'an approved probe presented the wrong key');
      return { kind: 'refused', code: 'bad-access-key', detail: 'the access key was not accepted' };
    }

    // **An approved probe with no key of its own is given one now**, in the welcome it is about
    // to receive. This is the only moment a key can be delivered to a machine that may have been
    // switched off when somebody approved it — see `approve`. It happens exactly once: the hash
    // is stored in the same breath, so the next handshake takes the issued-key path above.
    if (!existing.hasOwnKey) {
      const issuedKey = randomBytes(32).toString('base64url');
      await this.#db.query(`UPDATE probe_registration SET access_key_hash = $2 WHERE gid = $1`, [
        existing.gid,
        hashKey(issuedKey),
      ]);
      this.#logger.info({ gid: existing.gid }, 'issued this probe a key of its own');
      return { kind: 'approved', gid: existing.gid, objectId: existing.objectId, issuedKey };
    }

    return { kind: 'approved', gid: existing.gid, objectId: existing.objectId };
  }

  /** A probe nobody has seen before. */
  async #enrol(hello: ProbeHello): Promise<ProbeDecision> {
    if (!this.#enrolmentKeyMatches(hello.accessKey)) {
      return { kind: 'refused', code: 'bad-access-key', detail: 'the access key was not accepted' };
    }
    if (!addressAllowed(hello.remoteAddress, this.#enrolFrom)) {
      return {
        kind: 'refused',
        code: 'source-not-allowed',
        detail: `probes are not accepted from ${hello.remoteAddress}`,
      };
    }

    // A probe that presented a GID this core has never heard of is enrolling with somebody
    // else's name for itself — a rebuilt core, a restored backup, a copied config file. It is
    // recorded under the GID it offered rather than a fresh one, because that is the identity
    // it will keep presenting and inventing a second one would put two rows in the queue for
    // one machine.
    const gid = hello.gid === '' ? randomBytes(16).toString('hex') : hello.gid;
    const now = this.#now();
    await this.#db.query(
      `INSERT INTO probe_registration
         (gid, status, display_name, agent_version, protocol_version, last_address,
          first_seen_at, last_seen_at)
       VALUES ($1, 'pending', $2, $3, $4, $5, $6, $6)
       ON CONFLICT (gid) DO NOTHING`,
      [
        gid,
        hello.displayName.slice(0, 200),
        hello.agentVersion.slice(0, 64),
        hello.protocolVersion,
        hello.remoteAddress.slice(0, 64),
        now.toISOString(),
      ],
    );
    this.#logger.info(
      { gid, displayName: hello.displayName, remoteAddress: hello.remoteAddress },
      'a probe is waiting for approval',
    );
    return { kind: 'pending', gid };
  }

  async get(gid: string): Promise<ProbeRegistration | null> {
    const rows = await this.#db.query<Record<string, unknown>>(
      `SELECT * FROM probe_registration WHERE gid = $1`,
      [gid],
    );
    const row = rows[0];
    return row === undefined ? null : read(row);
  }

  async list(status?: ProbeRegistration['status']): Promise<ProbeRegistration[]> {
    const rows =
      status === undefined
        ? await this.#db.query<Record<string, unknown>>(
            `SELECT * FROM probe_registration ORDER BY status, first_seen_at`,
          )
        : await this.#db.query<Record<string, unknown>>(
            `SELECT * FROM probe_registration WHERE status = $1 ORDER BY first_seen_at`,
            [status],
          );
    return rows.map(read);
  }

  /**
   * Approves a probe and binds it to a branch of the tree.
   *
   * **The key is not issued here, and that is a correction live verification forced.** Issuing
   * it at approval means putting it in the `welcome` — and a probe that is *offline* when an
   * administrator approves it never receives that welcome, comes back on the enrolment key, and
   * is refused by the key it was never told about. Approving a machine that is switched off is
   * an ordinary thing to do, so it cannot be the thing that locks it out.
   *
   * So approval records the decision and nothing else; the key is minted at the next handshake,
   * by `admit`. That is better in a second way: the key never passes through an operator's
   * clipboard, a browser, or a support ticket, because nobody ever sees it.
   */
  async approve(
    gid: string,
    objectId: number,
    options: { local?: boolean; actorId?: number } = {},
  ): Promise<ProbeRegistration> {
    const existing = await this.get(gid);
    if (existing === null)
      throw new ProbeRegistryError('PROBE_NOT_FOUND', `there is no probe ${gid}`);

    // **A revoked identity does not hold a branch**, which is what revoking means — the row
    // stays so the decision survives and the GID cannot return by reconnecting, but the branch
    // it was on is free for the machine that replaces it. Without this exclusion, replacing a
    // probe means deleting its record, and deleting the record is how a revoked GID gets back
    // in. Found by the test that replaces the machine beside the core.
    const claimed = await this.#db.query<{ gid: string }>(
      `SELECT gid FROM probe_registration
       WHERE object_id = $1 AND gid <> $2 AND status <> 'revoked'`,
      [objectId, gid],
    );
    if (claimed.length > 0) {
      // One branch per probe, and one probe per branch. Two identities on one branch would both
      // be told to scan the same sensors, which is the duplicate-alarm failure `CLAUDE.md`'s
      // "one outage, one alarm" rule exists to prevent.
      throw new ProbeRegistryError(
        'PROBE_CONFLICT',
        `that probe object already belongs to ${claimed[0]?.gid ?? 'another probe'}`,
      );
    }

    // `access_key_hash` is cleared rather than set: a re-approved probe is issued a fresh key at
    // its next handshake, so a key that leaked before it was revoked does not survive the
    // decision to let the machine back in.
    const rows = await this.#db.query<Record<string, unknown>>(
      `UPDATE probe_registration
       SET status = 'approved', object_id = $2, access_key_hash = NULL, decided_at = now(),
           decided_by = $3, note = ''
       WHERE gid = $1
       RETURNING *`,
      [gid, objectId, options.actorId ?? null],
    );
    // The tree's own side of the binding, so `R-04`'s config push finds this probe's subtree.
    // `is_local` is only ever raised, never cleared by an approval: re-approving the core's own
    // probe after replacing the machine must not quietly make it deletable.
    await this.#db.query(
      `INSERT INTO probe_config (object_id, gid, is_local) VALUES ($1, $2, $3)
       ON CONFLICT (object_id) DO UPDATE
         SET gid = EXCLUDED.gid, is_local = probe_config.is_local OR EXCLUDED.is_local`,
      [objectId, gid, options.local ?? false],
    );

    this.#logger.info({ gid, objectId, local: options.local ?? false }, 'a probe was approved');
    const row = rows[0];
    if (row === undefined)
      throw new ProbeRegistryError('PROBE_NOT_FOUND', `there is no probe ${gid}`);
    return read(row);
  }

  /**
   * Refuses a probe from now on, keeping the record.
   *
   * **Revoked rather than deleted**, so the same GID cannot come back by simply reconnecting and
   * so the log of what was refused survives the decision. Deleting is a separate act, and it
   * means "I am sure this machine is gone".
   */
  async revoke(gid: string, note: string, actorId?: number): Promise<ProbeRegistration> {
    const rows = await this.#db.query<Record<string, unknown>>(
      `UPDATE probe_registration
       SET status = 'revoked', access_key_hash = NULL, note = $2, decided_at = now(),
           decided_by = $3
       WHERE gid = $1
       RETURNING *`,
      [gid, note.slice(0, 1_000), actorId ?? null],
    );
    const row = rows[0];
    if (row === undefined)
      throw new ProbeRegistryError('PROBE_NOT_FOUND', `there is no probe ${gid}`);

    // The branch is released so an operator can bind a replacement machine to it — the sensors,
    // their history and their thresholds all live on the objects, and losing them because a
    // probe was replaced would be the wrong end of the trade.
    await this.#db.query(`UPDATE probe_config SET gid = NULL WHERE gid = $1`, [gid]);
    this.#logger.warn({ gid, note }, 'a probe was revoked');
    return read(row);
  }

  /** Forgets a probe entirely. A revoked probe that comes back would enrol as new. */
  async remove(gid: string): Promise<boolean> {
    await this.#db.query(`UPDATE probe_config SET gid = NULL WHERE gid = $1`, [gid]);
    const rows = await this.#db.query<{ gid: string }>(
      `DELETE FROM probe_registration WHERE gid = $1 RETURNING gid`,
      [gid],
    );
    return rows.length > 0;
  }

  /** Narrows where one probe may connect from. */
  async setAllowFrom(gid: string, filters: readonly string[]): Promise<ProbeRegistration> {
    for (const filter of filters) {
      // Validated here rather than at the column, so the operator gets the parser's own sentence
      // about what is wrong with `10.0.0.0/33` instead of a check-constraint violation.
      parseAddressFilter(filter);
    }
    const rows = await this.#db.query<Record<string, unknown>>(
      `UPDATE probe_registration SET allow_from = $2 WHERE gid = $1 RETURNING *`,
      [gid, [...filters]],
    );
    const row = rows[0];
    if (row === undefined)
      throw new ProbeRegistryError('PROBE_NOT_FOUND', `there is no probe ${gid}`);
    return read(row);
  }

  #enrolmentKeyMatches(presented: string): boolean {
    if (this.#enrolmentKeys.length === 0) return true;
    return matchesAny(presented, this.#enrolmentKeys);
  }

  async #keyAccepted(gid: string, presented: string): Promise<boolean> {
    const rows = await this.#db.query<{ access_key_hash: string | null }>(
      `SELECT access_key_hash FROM probe_registration WHERE gid = $1`,
      [gid],
    );
    const stored = rows[0]?.access_key_hash ?? null;
    // An approved probe with no key of its own was approved by the upgrade in migration 030,
    // which had no key to issue. It keeps working on the enrolment key until it is re-approved,
    // because breaking every existing probe on upgrade is not a security improvement.
    if (stored === null) return this.#enrolmentKeyMatches(presented);
    return timingSafeMatch(hashKey(presented), stored);
  }

  async #touch(gid: string, hello: ProbeHello): Promise<void> {
    await this.#db.query(
      `UPDATE probe_registration
       SET display_name = $2, agent_version = $3, protocol_version = $4, last_address = $5,
           last_seen_at = now()
       WHERE gid = $1`,
      [
        gid,
        hello.displayName.slice(0, 200),
        hello.agentVersion.slice(0, 64),
        hello.protocolVersion,
        hello.remoteAddress.slice(0, 64),
      ],
    );
  }
}

/**
 * SHA-256, not argon2, and that is deliberate.
 *
 * argon2 exists to make guessing a *human-chosen* password expensive. This key is 32 bytes from
 * `randomBytes`, so there is nothing to guess — 2^256 is not reachable however cheap the hash —
 * and a deliberately slow hash on the handshake path would only mean a reconnecting probe waits.
 * `A-01`'s account passwords are the opposite case and will use argon2 for the opposite reason.
 */
function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Constant-time, so a wrong key cannot be found one character at a time. */
function timingSafeMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function matchesAny(presented: string, accepted: readonly string[]): boolean {
  let matched = false;
  for (const candidate of accepted) {
    // Every candidate is compared even after a match, so timing does not reveal which one hit.
    matched = timingSafeMatch(presented, candidate) || matched;
  }
  return matched;
}

function read(row: Record<string, unknown>): ProbeRegistration {
  return {
    gid: String(row['gid']),
    status: row['status'] as ProbeRegistration['status'],
    displayName: text(row['display_name']),
    agentVersion: text(row['agent_version']),
    protocolVersion: Number(row['protocol_version'] ?? 0),
    skew: skewFor(Number(row['protocol_version'] ?? 0)),
    lastAddress: text(row['last_address']),
    allowFrom: Array.isArray(row['allow_from']) ? (row['allow_from'] as string[]) : [],
    hasOwnKey: row['access_key_hash'] != null,
    objectId: row['object_id'] == null ? null : Number(row['object_id']),
    note: text(row['note']),
    firstSeenAt: iso(row['first_seen_at']),
    lastSeenAt: row['last_seen_at'] == null ? null : iso(row['last_seen_at']),
    decidedAt: row['decided_at'] == null ? null : iso(row['decided_at']),
  };
}

/**
 * The recorded version's meaning, with zero read as "nothing recorded" rather than as a version.
 *
 * The column defaults to zero and the `R-01` upgrade filled no version for the probes it carried
 * over, so zero is what a probe that has not reconnected since looks like. `describeSkew` would
 * call that incompatible, which is true of a peer that really claimed zero and false of every
 * row an upgrade wrote.
 */
function skewFor(protocolVersion: number): RegistrationSkew {
  const skew: ProtocolSkew =
    protocolVersion === 0 ? { kind: 'unknown' } : describeSkew(protocolVersion);
  return { ...skew, explanation: explainSkew(skew) };
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** A text column, or empty. Narrowed rather than coerced: `String({})` is `[object Object]`. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
