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
  type WithdrawnCode,
} from '@ms/shared';
import { DatabaseError, savepoint, type Database, type Queryable } from '../db/pool.js';
import type {
  Actor,
  AuditSink,
  Mutation,
  ProbeIdentity,
  ProbeTrustAudit,
} from '../objects/audit.js';
import { IN_PROCESS_SOURCES } from '../ingestion/sources.js';

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
 * Whether a hello proved it is the probe whose row it named (`P-319`), and with which key.
 *
 * `own` is the key the probe was issued; `enrolment` the shared one, which a pending probe and an
 * approved probe that has never used a key of its own still present. When it did not, the
 * refusal it is given, and why, for the log line.
 */
type Proof =
  | { proven: true; key: 'own' | 'enrolment' }
  | {
      proven: false;
      refusal: Extract<ProbeDecision, { kind: 'refused' }>;
      why: string;
      fields?: Readonly<Record<string, unknown>>;
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
  /**
   * When a handshake this core accepted spoke `protocolVersion` (`U-33`), or `null`: beside a
   * version a hello was refused over (`R-06`), and for one recorded before migration 072.
   *
   * **Not `lastSeenAt`**, which a hello refused over its version moves too (and, before `P-319`,
   * every hello did, whatever it was refused for). Read beside the version, `lastSeenAt` made a
   * probe refused at 04:12 look as if it had connected then speaking whatever the row held. The pair is written in one statement (`#speaks`), so this
   * is never another handshake's time.
   */
  protocolAcceptedAt: string | null;
  /**
   * When a hello was last refused over `protocolVersion` (`U-35`), or `null`: beside a version a
   * handshake accepted, and for one recorded before migration 074.
   *
   * **What tells a refusal at 0 from nothing recorded.** Both are a stored 0 with no accepted
   * time, and until this the row read the refusal as the `R-01` upgrade's "has not connected
   * since": `unknown`, for a probe that is refused at every hello. Never beside
   * `protocolAcceptedAt`: the two are written in one statement, and the column's check refuses
   * both.
   */
  protocolRefusedAt: string | null;
  lastAddress: string;
  allowFrom: string[];

  /**
   * Whether this probe has **used** a key of its own. Never the key itself.
   *
   * Deliberately not "a key has been issued" (`P-37`). The core writes the hash and returns the
   * key in the welcome that follows, and nothing acknowledges it — so a hash on its own says the
   * core issued a key, not that the probe ever received one. Reading it as the latter is what
   * let a single dropped welcome lock a probe out for ever.
   */
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

/**
 * A probe approved onto one object, asked onto another (`P-386`). One probe holds one branch, as
 * one branch holds one probe: moving it is revoking it, so the branch it leaves stops being
 * scanned by a decision somebody took, and then approving it where it goes.
 */
function boundElsewhere(gid: string, held: number, asked: number): ProbeRegistryError {
  return new ProbeRegistryError(
    'PROBE_CONFLICT',
    `probe ${gid} is already approved onto probe object ${String(held)}; revoke it first, ` +
      `then approve it onto probe object ${String(asked)}`,
  );
}

/**
 * Just enough of `ProbeEndpoint` for a decision to reach a connection that is already open.
 *
 * A narrow interface rather than the endpoint itself, like every other collaborator here: the
 * registry decides things about probes and must not acquire a transport to do it.
 */
export interface ProbeConnections {
  disconnect(gid: string, reason: string): boolean;
  /**
   * Closes a connection **and says why**, so the probe stops rather than treating it as a blip.
   *
   * Separate from `disconnect`, and the difference is the whole of it. `disconnect` is for a
   * decision the probe should come *back* from — approval (`P-189`) — where a bare close is
   * right because the reconnect is the point. Withdrawal is the opposite: the probe keeps
   * checking and spools to disk when it merely loses the core, so a bare close would leave a
   * machine somebody has just refused probing their network until its process happened to die.
   * The `reject` carries a code the probe acts on.
   */
  withdraw(gid: string, code: WithdrawnCode, detail: string): boolean;
  /**
   * Where this gid is connected from right now, or null if it is not connected at all.
   *
   * The one fact the transport has that this does not. Asking for it is what keeps the *policy*
   * here: whether an address filter still covers a probe is the same decision `admit` makes at a
   * handshake, and a second copy of it in the transport is a second copy to drift.
   */
  remoteAddressOf(gid: string): string | null;
}

export interface ProbeRegistryOptions {
  db: Database;
  /**
   * Where every trust decision is recorded, in the decision's own transaction (`A-20`).
   *
   * Required: approving a probe admits a machine that runs checks with the core's credentials,
   * and until this ticket nothing durable said who had admitted one.
   */
  audit: AuditSink;
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
  readonly #db: Database;
  readonly #audit: AuditSink;
  readonly #logger: Logger;
  #connections: ProbeConnections | undefined;
  readonly #enrolmentKeys: readonly string[];
  readonly #enrolFrom: readonly string[];
  readonly #now: () => Date;
  #hellosRefusedUnproven = 0;

  constructor(options: ProbeRegistryOptions) {
    this.#db = options.db;
    this.#audit = options.audit;
    this.#logger = options.logger.child({ component: 'probe-registry' });
    this.#enrolmentKeys = options.enrolmentKeys;
    this.#enrolFrom = options.enrolFrom ?? [];
    this.#now = options.now ?? ((): Date => new Date());
  }

  /**
   * Where a decision goes once it has been made (`P-189`).
   *
   * Late-bound, because the endpoint is built long after this — the same shape as
   * `ConfigChangeNotifier.attach`. Absent is a legitimate state and means nothing is listening:
   * a test that only cares what the rows say, and every path that decides about a probe which is
   * not connected.
   */
  attach(connections: ProbeConnections): void {
    this.#connections = connections;
  }

  /**
   * Hellos refused before they proved the identity they named, since the core started (`P-319`).
   *
   * Every refusal that leaves no row behind: a known GID whose key, address or revocation
   * refused it (whatever its version), and a GID nobody has seen that was refused for its key,
   * its address or its version. Those leave nothing but a log line, so this is the number that
   * says they are happening. A refusal of a hello that did prove itself, over its version, is on
   * the probe's own row and is not counted here.
   */
  stats(): { hellosRefusedUnproven: number } {
    return { hellosRefusedUnproven: this.#hellosRefusedUnproven };
  }

  /**
   * What to do with a probe that has just connected.
   *
   * **Nothing is written to a probe's row until the hello has proved it is that probe**
   * (`P-319`): its access key accepted, the identity not revoked, and its address one the
   * probe's filter allows. A refusal of a hello that has not is logged, under the handshake's
   * correlation id, and counted (`stats().hellosRefusedUnproven`, a Core Health channel) — and
   * leaves the row as it was.
   *
   * **It used to be the other way round, on purpose**: "every path here writes what it saw,
   * including the refusals" (`R-01`, `R-06`), so that the row would say a revoked identity tried
   * at 04:12 from an address nobody recognised. But what it saw was a *claim*. mTLS proves only
   * that the peer holds a certificate the installation's CA signed, and nothing ties that
   * certificate to a GID, so any holder could name an approved probe and rewrite its name, its
   * agent version and its address — and, since `U-35`, have `/probes` call a connected, working
   * probe refused over its version. The row is what an operator, the add-sensor form and Probe
   * Health read as *that probe's* facts, and a row anybody can write is evidence of nothing: the
   * forger's address overwrote the genuine probe's, which is the opposite of keeping a trace.
   * `A-41c` made the same move for the protocol version alone, for the same reason; this
   * finishes it for the rest of the row. The trace R-06 wanted is the log line, which says the
   * GID claimed, the address, and why, and which nobody can use to change what a probe is.
   */
  async admit(hello: ProbeHello): Promise<ProbeDecision> {
    const existing = hello.gid === '' ? null : await this.get(hello.gid);

    // **Version skew is a refusal like every other one, and the answer the probe is given**
    // (`R-06`): checked first, so the operator of a probe that is too old is told that, not to
    // check a key that was never the problem.
    const skew = describeSkew(hello.protocolVersion);

    if (existing === null) {
      // A probe this core has *never* seen and cannot talk to is refused without a row.
      // Enrolling it would put something in the approval queue that approving cannot help, and
      // its identity claims are the claims of a peer whose protocol this build does not
      // implement.
      if (skew.kind === 'incompatible') {
        this.#refusedVersion(hello, null);
        return { kind: 'refused', code: 'protocol-version', detail: explainSkew(skew) };
      }
      return this.#enrol(hello);
    }

    const proof = await this.#prove(existing, hello);

    if (skew.kind === 'incompatible') {
      this.#refusedVersion(hello, proof);
      // `R-06`: the one refusal whose whole content is the version, so the queue shows it — for
      // the probe that proved it is this one, and only for it. Not accepted, so no accepted time
      // beside it (`U-32`), and the refusal's instead (`U-35`). The proof decides only whether the
      // row is written: the probe is told about its version whatever the proof found.
      if (proof.proven) {
        await this.#touch(existing.gid, hello);
        await this.#speaks(existing.gid, hello.protocolVersion, false);
      }
      return { kind: 'refused', code: 'protocol-version', detail: explainSkew(skew) };
    }

    if (!proof.proven) {
      this.#refusedUnproven(hello, proof.refusal.code, proof.why, proof.fields);
      return proof.refusal;
    }

    // Proven, and accepted: what it says about itself, then the version it speaks and when.
    await this.#touch(existing.gid, hello);
    await this.#speaks(existing.gid, hello.protocolVersion, true);

    if (existing.status === 'pending') return { kind: 'pending', gid: existing.gid };
    const accepted = proof.key;

    // **An approved probe that has never used a key of its own is given one now**, in the welcome
    // it is about to receive. This is the only moment a key can be delivered to a machine that
    // may have been switched off when somebody approved it — see `approve`.
    //
    // **It used to say "it happens exactly once", and that was the bug** (`P-37`). The hash was
    // stored in the same breath, so the next handshake took the issued-key path whether or not
    // the welcome ever arrived — and a probe that never got its key came back on the enrolment
    // key it still had, was refused, and stayed refused. Issuing now repeats until the probe
    // proves it has one, which costs a reconnect where it used to cost the probe.
    if (accepted === 'enrolment') {
      const issuedKey = randomBytes(32).toString('base64url');
      await this.#db.query(
        `UPDATE probe_registration
         SET access_key_hash = $2, access_key_confirmed_at = NULL
         WHERE gid = $1`,
        [existing.gid, hashKey(issuedKey)],
      );
      this.#logger.info({ gid: existing.gid }, 'issued this probe a key of its own');
      return { kind: 'approved', gid: existing.gid, objectId: existing.objectId, issuedKey };
    }

    return { kind: 'approved', gid: existing.gid, objectId: existing.objectId };
  }

  /** A probe nobody has seen before. */
  async #enrol(hello: ProbeHello): Promise<ProbeDecision> {
    // Refused without a row, as ever, and now said and counted like any other hello that proved
    // nothing (`P-319`): it is the same fact, about a GID nobody has seen.
    if (!this.#enrolmentKeyMatches(hello.accessKey)) {
      this.#refusedUnproven(
        hello,
        'bad-access-key',
        'a new probe presented a key that is not the enrolment key',
      );
      return { kind: 'refused', code: 'bad-access-key', detail: 'the access key was not accepted' };
    }
    if (!addressAllowed(hello.remoteAddress, this.#enrolFrom)) {
      this.#refusedUnproven(
        hello,
        'source-not-allowed',
        'a new probe connected from an address enrolment does not allow',
        {
          filters: this.#enrolFrom,
        },
      );
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
    //
    // **Except a name the core's own producers report under** (`P-228`): a probe called `factory`
    // would read as the Sensor Factory in every log line and share its replay pacing. It could
    // not borrow the factory's trust — a probe's results go through `acceptProbeResults` whatever
    // it is called — so this is about what an operator reads, and a fresh identity costs the
    // probe nothing: the welcome carries it, and the probe keeps whatever it is given.
    const reserved = IN_PROCESS_SOURCES.has(hello.gid);
    if (reserved) {
      this.#logger.warn(
        { offered: hello.gid, remoteAddress: hello.remoteAddress },
        'a probe offered an identity the core reserves for itself; enrolling it under a new one',
      );
    }
    const gid = hello.gid === '' || reserved ? randomBytes(16).toString('hex') : hello.gid;
    const now = this.#now();
    await this.#db.query(
      `INSERT INTO probe_registration
         (gid, status, display_name, agent_version, protocol_version, last_address,
          first_seen_at, last_seen_at, protocol_accepted_at)
       VALUES ($1, 'pending', $2, $3, $4, $5, $6, $6, $6)
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
    actor: Actor,
    options: { local?: boolean } = {},
  ): Promise<ProbeRegistration> {
    const local = options.local ?? false;
    const approved = await this.#db.tx(async (q) => {
      const existing = await this.#lock(q, gid);
      // **The branch is held from here until this approval commits** (`P-391`). `#lock` holds
      // this identity's row, not the branch's, so two identities approved onto one branch at once
      // both passed the check below, and `probe_registration_object_idx` refused the second as
      // PostgreSQL's sentence. Now the second waits, and then reads the first as the holder.
      await q.query(
        "SELECT pg_advisory_xact_lock(hashtext('probe_registration_object_idx'), hashtext($1::text))",
        [objectId],
      );

      // **A revoked identity does not hold a branch**, which is what revoking means — the row
      // stays so the decision survives and the GID cannot return by reconnecting, but the branch
      // it was on is free for the machine that replaces it. Without this exclusion, replacing a
      // probe means deleting its record, and deleting the record is how a revoked GID gets back
      // in. Found by the test that replaces the machine beside the core.
      const claimed = await q.query<{ gid: string }>(
        `SELECT gid FROM probe_registration
         WHERE object_id = $1 AND gid <> $2 AND status <> 'revoked'`,
        [objectId, gid],
      );
      if (claimed.length > 0) {
        // One branch per probe, and one probe per branch. Two identities on one branch would
        // both be told to scan the same sensors, which is the duplicate-alarm failure
        // `CLAUDE.md`'s "one outage, one alarm" rule exists to prevent.
        throw new ProbeRegistryError(
          'PROBE_CONFLICT',
          `that probe object already belongs to ${claimed[0]?.gid ?? 'another probe'}`,
        );
      }
      // The other half of that rule (`P-386`): this probe on another branch already.
      const held = await this.#boundElsewhere(q, gid, objectId);
      if (held !== undefined) throw boundElsewhere(gid, held, objectId);

      // `access_key_hash` is cleared rather than set: a re-approved probe is issued a fresh key
      // at its next handshake, so a key that leaked before it was revoked does not survive the
      // decision to let the machine back in.
      //
      // **`access_key_confirmed_at` goes with it** (`P-37`). A row with no hash but a
      // confirmation is a state that cannot be true — nothing was confirmed, because there is
      // nothing to confirm — and leaving it set would mean the next reader has to know that the
      // hash is checked first. It is harmless today for exactly that reason and would not stay
      // harmless.
      const rows = await q.query<Record<string, unknown>>(
        `UPDATE probe_registration
         SET status = 'approved', object_id = $2, access_key_hash = NULL,
             access_key_confirmed_at = NULL, decided_at = now(),
             decided_by = $3, note = ''
         WHERE gid = $1
         RETURNING *`,
        [gid, objectId, decidedBy(actor)],
      );
      const localTakenFrom = local ? await this.#takeLocal(q, objectId) : undefined;
      // The tree's own side of the binding, so `R-04`'s config push finds this probe's subtree.
      // `is_local` is only ever raised, never cleared by an approval: re-approving the core's own
      // probe after replacing the machine must not quietly make it deletable.
      //
      // **`probe_config_gid_unique` is the backstop for the check above**, mapped rather than
      // left to answer `OBJECT_INVALID` with a constraint name: a binding committed between the
      // two (this transaction waits at `#takeLocal`'s lock in between) still names the object.
      // In a savepoint, so the object can be read after the failure (`P-249`).
      try {
        await savepoint(q, (inner) =>
          inner.query(
            `INSERT INTO probe_config (object_id, gid, is_local) VALUES ($1, $2, $3)
             ON CONFLICT (object_id) DO UPDATE
               SET gid = EXCLUDED.gid, is_local = probe_config.is_local OR EXCLUDED.is_local`,
            [objectId, gid, local],
          ),
        );
      } catch (error: unknown) {
        if (!(error instanceof DatabaseError)) throw error;
        if (error.sqlstate !== '23505' || error.constraint !== 'probe_config_gid_unique') {
          throw error;
        }
        const raced = await this.#boundElsewhere(q, gid, objectId);
        if (raced === undefined) throw error;
        throw boundElsewhere(gid, raced, objectId);
      }
      const after = readOne(rows, gid);
      await this.#record(q, actor, {
        action: 'probe.approved',
        objectId,
        probe: identityOf(after),
        local,
        ...(localTakenFrom === undefined ? {} : { localTakenFrom }),
        before: trustOf(existing),
        after: trustOf(after),
      });
      return after;
    });

    this.#logger.info({ gid, objectId, local }, 'a probe was approved');
    // **The decision has to reach the connection** (`P-189`). `session.approved` is fixed at
    // admission, so a probe that connected while pending stays marked unapproved for the life of
    // that session: it was sent nothing, and it went on being sent nothing after somebody
    // approved it. Closing it brings it back in about a second, through the handshake that
    // issues its key and its configuration. After the commit, so a decision that rolled back
    // closes nothing.
    this.#connections?.disconnect(gid, 'approved; reconnect for a key and a configuration');
    return approved;
  }

  /**
   * Refuses a probe from now on, keeping the record.
   *
   * **Revoked rather than deleted**, so the same GID cannot come back by simply reconnecting and
   * so the log of what was refused survives the decision. Deleting is a separate act, and it
   * means "I am sure this machine is gone".
   */
  async revoke(gid: string, note: string, actor: Actor): Promise<ProbeRegistration> {
    const revoked = await this.#db.tx(async (q) => {
      const existing = await this.#lock(q, gid);
      const rows = await q.query<Record<string, unknown>>(
        `UPDATE probe_registration
         SET status = 'revoked', access_key_hash = NULL, access_key_confirmed_at = NULL,
             note = $2, decided_at = now(),
             decided_by = $3
         WHERE gid = $1
         RETURNING *`,
        [gid, note.slice(0, 1_000), decidedBy(actor)],
      );
      // The branch is released so an operator can bind a replacement machine to it — the
      // sensors, their history and their thresholds all live on the objects, and losing them
      // because a probe was replaced would be the wrong end of the trade.
      await q.query(`UPDATE probe_config SET gid = NULL WHERE gid = $1`, [gid]);
      const after = readOne(rows, gid);
      await this.#record(q, actor, {
        action: 'probe.revoked',
        objectId: existing.objectId,
        probe: identityOf(after),
        before: trustOf(existing),
        after: trustOf(after),
      });
      return after;
    });
    this.#logger.warn({ gid, note }, 'a probe was revoked');

    // **The decision has to reach the machine, and `disconnect` would not be enough** (`P-189`
    // closed the approval half of this). A probe that merely loses the core keeps checking and
    // spools to disk, so a bare close leaves a revoked machine probing somebody's network until
    // its process happens to die. The operator's own sentence travels with it, because "revoked"
    // tells whoever reads the probe's journal nothing and "decommissioned, replaced by web-dc4"
    // tells them everything — and it is the same sentence `admit` sends at a refused handshake.
    this.#connections?.withdraw(gid, 'revoked', note === '' ? 'this probe has been revoked' : note);
    return revoked;
  }

  /** Forgets a probe entirely. A revoked probe that comes back would enrol as new. */
  async remove(gid: string, actor: Actor): Promise<boolean> {
    const removed = await this.#db.tx(async (q) => {
      await q.query(`UPDATE probe_config SET gid = NULL WHERE gid = $1`, [gid]);
      const rows = await q.query<Record<string, unknown>>(
        `DELETE FROM probe_registration WHERE gid = $1 RETURNING *`,
        [gid],
      );
      const row = rows[0];
      if (row === undefined) return false;
      const before = read(row);
      await this.#record(q, actor, {
        action: 'probe.deleted',
        objectId: before.objectId,
        probe: identityOf(before),
        before: trustOf(before),
      });
      return true;
    });
    if (!removed) return false;

    // **Forgetting a probe stops it too, and it has to.** Deleting the row means "this machine
    // is gone", which is usually said about one that is — but said about one still connected it
    // would leave the least accountable state this system can reach: a machine checking devices
    // under assignments the core no longer has any record of giving it. `not-approved` rather
    // than `revoked`, because that is what it now is: a forgotten probe that comes back enrols
    // as a stranger and waits in the queue. Both stop it; only one of them is true.
    this.#connections?.withdraw(
      gid,
      'not-approved',
      'this probe is no longer registered with this core',
    );
    return true;
  }

  /** Narrows where one probe may connect from. */
  async setAllowFrom(
    gid: string,
    filters: readonly string[],
    actor: Actor,
  ): Promise<ProbeRegistration> {
    for (const filter of filters) {
      // Validated here rather than at the column, so the operator gets the parser's own sentence
      // about what is wrong with `10.0.0.0/33` instead of a check-constraint violation.
      parseAddressFilter(filter);
    }
    const updated = await this.#db.tx(async (q) => {
      const existing = await this.#lock(q, gid);
      const rows = await q.query<Record<string, unknown>>(
        `UPDATE probe_registration SET allow_from = $2 WHERE gid = $1 RETURNING *`,
        [gid, [...filters]],
      );
      const after = readOne(rows, gid);
      // Only a filter that moved: the same list saved twice changed nothing, and an entry with
      // an empty diff is one somebody reads for nothing.
      if (trustOf(existing).allowFrom !== trustOf(after).allowFrom) {
        await this.#record(q, actor, {
          action: 'probe.allowFrom.set',
          objectId: after.objectId,
          probe: identityOf(after),
          before: trustOf(existing),
          after: trustOf(after),
        });
      }
      return after;
    });

    // **A filter that no longer covers where the probe actually is takes effect now.** The
    // narrower statement is already true the moment it is written — the very next handshake
    // refuses it — so leaving the live session up only decides *when*, and "whenever this probe
    // happens to reconnect" is an answer nobody chose. It would also make the probes page lie: a
    // registration reading `10.0.0.0/24` beside a probe at `192.0.2.5`, still scanning.
    //
    // Only when it is genuinely outside. Narrowing a filter that still covers the probe is the
    // ordinary case — an operator tightening a range around the machines already in it — and
    // must cost nothing at all.
    const address = this.#connections?.remoteAddressOf(gid) ?? null;
    if (address !== null && !this.#addressAllowedFor(updated, address)) {
      this.#logger.warn(
        { gid, remoteAddress: address, filters: [...filters] },
        'a connected probe is outside its new address filter',
      );
      this.#connections?.withdraw(gid, 'source-not-allowed', refusedFrom(address));
    }
    return updated;
  }

  /** The registration, locked for the decision about to be taken on it, or `PROBE_NOT_FOUND`. */
  async #lock(q: Queryable, gid: string): Promise<ProbeRegistration> {
    const rows = await q.query<Record<string, unknown>>(
      `SELECT * FROM probe_registration WHERE gid = $1 FOR UPDATE`,
      [gid],
    );
    return readOne(rows, gid);
  }

  /**
   * Makes room for `objectId` to be the local probe, and says which object it was taken from.
   *
   * **One probe runs beside the core, so one object is local** (`P-382`, and migration 075's
   * index holds it). Another object holding the flag with a probe still bound to it is refused:
   * that is the core's own probe, or a decision somebody has to undo by revoking it first, and
   * quietly moving the flag would make the branch it guards deletable while its machine still
   * reports. One with no probe bound — revoked, or deleted from the registry — has no machine
   * beside the core any more, and the flag moves, recorded in the approval's audit entry.
   *
   * Serialised by a transaction lock, so two approvals each made local at once do not both find
   * nothing to move and leave the second to fail on the index.
   */
  async #takeLocal(q: Queryable, objectId: number): Promise<number | undefined> {
    await q.query(`SELECT pg_advisory_xact_lock(hashtext('probe_config'), hashtext('is_local'))`);
    const held = await q.query<{ object_id: string; gid: string | null }>(
      `SELECT object_id::text AS object_id, gid FROM probe_config
       WHERE is_local AND object_id <> $1
       FOR UPDATE`,
      [objectId],
    );
    const holder = held[0];
    if (holder === undefined) return undefined;
    if (holder.gid !== null) {
      throw new ProbeRegistryError(
        'PROBE_CONFLICT',
        `probe object ${holder.object_id} is already this installation's local probe, held by ` +
          `${holder.gid}; revoke that probe first, then approve this one onto that object or ` +
          'any other',
      );
    }
    await q.query('UPDATE probe_config SET is_local = false WHERE object_id = $1', [
      holder.object_id,
    ]);
    return Number(holder.object_id);
  }

  /**
   * The probe object other than `objectId` this gid is bound to, if any (`P-386`).
   *
   * Read from `probe_config`, whose `gid` is the binding `probe_config_gid_unique` holds to one
   * object, and which revoking and forgetting a probe clear: so a gid found here is approved there.
   */
  async #boundElsewhere(q: Queryable, gid: string, objectId: number): Promise<number | undefined> {
    const rows = await q.query<{ object_id: string }>(
      `SELECT object_id::text AS object_id FROM probe_config
       WHERE gid = $1 AND object_id <> $2`,
      [gid, objectId],
    );
    const row = rows[0];
    return row === undefined ? undefined : Number(row.object_id);
  }

  async #record(q: Queryable, actor: Actor, mutation: Mutation): Promise<void> {
    await this.#audit.record(q, actor, [mutation], this.#now());
  }

  /**
   * Whether this registration accepts a connection from this address.
   *
   * **The probe's own filter, then the installation's.** A probe with a filter of its own is
   * saying something narrower than the default, and the narrower statement wins. Extracted so
   * the handshake and a filter that has just changed cannot come to different conclusions about
   * the same probe — which they would, the first time somebody changed one and not the other.
   */
  #addressAllowedFor(registration: ProbeRegistration, address: string): boolean {
    const filters = registration.allowFrom.length > 0 ? registration.allowFrom : this.#enrolFrom;
    return addressAllowed(address, filters);
  }

  /**
   * Whether this hello proves it is the probe the row describes (`P-319`), and with which key.
   *
   * In the order the refusals have always been given: a revoked identity, then an address its
   * filter does not allow, then the key. Nothing here writes to the row except `#keyAccepted`
   * recording a key's first use, and that only once the key has matched — which is the proof.
   */
  async #prove(existing: ProbeRegistration, hello: ProbeHello): Promise<Proof> {
    if (existing.status === 'revoked') {
      return {
        proven: false,
        why: 'a revoked probe tried to connect',
        refusal: {
          kind: 'refused',
          code: 'revoked',
          detail: existing.note === '' ? 'this probe has been revoked' : existing.note,
        },
      };
    }

    if (!this.#addressAllowedFor(existing, hello.remoteAddress)) {
      return {
        proven: false,
        why: 'a probe connected from an address its filter does not allow',
        fields: { filters: existing.allowFrom.length > 0 ? existing.allowFrom : this.#enrolFrom },
        refusal: {
          kind: 'refused',
          code: 'source-not-allowed',
          detail: refusedFrom(hello.remoteAddress),
        },
      };
    }

    const wrongKey = (why: string): Proof => ({
      proven: false,
      why,
      refusal: {
        kind: 'refused',
        code: 'bad-access-key',
        detail: 'the access key was not accepted',
      },
    });

    // A pending probe still presents the enrolment key, because it has none of its own yet.
    if (existing.status === 'pending') {
      return this.#enrolmentKeyMatches(hello.accessKey)
        ? { proven: true, key: 'enrolment' }
        : wrongKey('a pending probe presented a key that is not the enrolment key');
    }

    // **Which key it presented, not merely whether one was accepted** (`P-37`). `existing` was
    // read before this ran, so its `hasOwnKey` is a snapshot from before a first use could be
    // recorded — deciding whether to issue from that snapshot hands a second key to the probe
    // that just proved it had the first.
    const key = await this.#keyAccepted(existing.gid, hello.accessKey);
    return key === 'no'
      ? wrongKey('an approved probe presented the wrong key')
      : { proven: true, key };
  }

  /**
   * A hello refused before it proved the identity it named (`P-319`): said, and counted.
   *
   * **The log line is where what the hello claimed goes now**, rather than the row: the GID it
   * named, the address it came from, and the name, agent version and protocol it declared — the
   * trace `R-06` wanted, under the handshake's correlation id, without letting the claim stand as
   * the probe's own.
   *
   * **One shape for every one of them, whatever it was refused for** (`P-319` review): `code`,
   * `claimed`, and `unprovenBecause`, the reason the identity was not proven. A refusal over the
   * version passes its own sentence as `message` and its versions in `fields`; every other one
   * is said in its reason.
   */
  #refusedUnproven(
    hello: ProbeHello,
    code: Extract<ProbeDecision, { kind: 'refused' }>['code'],
    why: string,
    fields: Readonly<Record<string, unknown>> = {},
    message: string = why,
  ): void {
    this.#hellosRefusedUnproven += 1;
    this.#logger.warn(
      {
        gid: hello.gid,
        remoteAddress: hello.remoteAddress,
        code,
        claimed: {
          displayName: hello.displayName.slice(0, 200),
          agentVersion: hello.agentVersion.slice(0, 64),
          protocolVersion: hello.protocolVersion,
        },
        unprovenBecause: why,
        ...fields,
      },
      message,
    );
  }

  /**
   * A hello refused over its version (`R-06`). Said once either way, and when it proved nothing,
   * said and counted as every other such refusal is (`P-319`).
   */
  #refusedVersion(hello: ProbeHello, proof: Proof | null): void {
    const message = 'refusing a probe whose protocol this core cannot speak';
    const versions = { coreProtocolVersion: PROTOCOL_VERSION, known: proof !== null };
    if (proof?.proven === true) {
      this.#logger.warn(
        {
          gid: hello.gid,
          remoteAddress: hello.remoteAddress,
          code: 'protocol-version',
          protocolVersion: hello.protocolVersion,
          proven: true,
          ...versions,
        },
        message,
      );
      return;
    }
    this.#refusedUnproven(
      hello,
      'protocol-version',
      proof === null ? 'no probe is registered under the GID it named' : proof.why,
      { ...versions, ...(proof?.fields ?? {}) },
      message,
    );
  }

  #enrolmentKeyMatches(presented: string): boolean {
    if (this.#enrolmentKeys.length === 0) return true;
    return matchesAny(presented, this.#enrolmentKeys);
  }

  /**
   * Which key this probe authenticated with (`P-37`).
   *
   * `'own'` is the key it was issued, and using it is what closes the enrolment fallback.
   * `'enrolment'` is the shared key, accepted only while the probe has never used one of its
   * own — the caller reads that as "this probe still has no key" and issues one.
   */
  async #keyAccepted(gid: string, presented: string): Promise<'own' | 'enrolment' | 'no'> {
    const rows = await this.#db.query<{
      access_key_hash: string | null;
      access_key_confirmed_at: Date | null;
    }>(`SELECT access_key_hash, access_key_confirmed_at FROM probe_registration WHERE gid = $1`, [
      gid,
    ]);
    const stored = rows[0]?.access_key_hash ?? null;
    const confirmed = rows[0]?.access_key_confirmed_at != null;
    // An approved probe with no key of its own was approved by the upgrade in migration 030,
    // which had no key to issue. It keeps working on the enrolment key until it is re-approved,
    // because breaking every existing probe on upgrade is not a security improvement.
    if (stored === null) return this.#enrolmentKeyMatches(presented) ? 'enrolment' : 'no';

    if (timingSafeMatch(hashKey(presented), stored)) {
      // **First use is what closes the enrolment fallback** (`P-37`). Written here rather than
      // where the key is issued, because that is the whole distinction: the core knowing a key
      // and the probe having it are different facts, and only the probe can supply the second.
      if (!confirmed) {
        await this.#db.query(
          `UPDATE probe_registration SET access_key_confirmed_at = now() WHERE gid = $1`,
          [gid],
        );
        this.#logger.info({ gid }, 'this probe used the key it was issued');
      }
      return 'own';
    }

    // **The welcome carrying its key never landed.** The probe has nothing but the enrolment key
    // it started with, so accepting that is the difference between one wasted reconnect and a
    // probe nobody can recover without a human in the UI. The window is narrow on purpose: it is
    // open only between issuing a key and its first use, and `hasOwnKey` being false here means
    // the caller issues a fresh one in the welcome this handshake is about to receive.
    if (!confirmed && this.#enrolmentKeyMatches(presented)) {
      this.#logger.warn(
        { gid },
        'this probe came back on the enrolment key, so the key it was issued never arrived',
      );
      return 'enrolment';
    }

    return 'no';
  }

  /**
   * What a probe says about itself, and when it last said it.
   *
   * **Only for a hello that proved it is this probe** (`P-319`): accepted, or refused over its
   * version alone. It used to run first, for every hello naming a known GID, which let anybody
   * holding a certificate the CA signed rename an approved probe and move its address.
   */
  async #touch(gid: string, hello: ProbeHello): Promise<void> {
    await this.#db.query(
      `UPDATE probe_registration
       SET display_name = $2, agent_version = $3, last_address = $4, last_seen_at = now()
       WHERE gid = $1`,
      [
        gid,
        hello.displayName.slice(0, 200),
        hello.agentVersion.slice(0, 64),
        hello.remoteAddress.slice(0, 64),
      ],
    );
  }

  /**
   * Records the protocol version a probe speaks (`A-41c`).
   *
   * **Only for a hello that was accepted, and for one refused over the version itself.** It used
   * to be written with the rest of `#touch`, before any decision, so a hello that was then
   * refused for its key, its address or a revocation left its claim in the row while an older
   * probe held the connection. "Check now" read that row to decide whether a set bounded by its
   * targets could be sent, and sent it to a probe that connects by name. Nothing that decides
   * what a probe is sent reads this now; it stays what an operator is shown, and so it says what
   * the probe that got in speaks.
   *
   * **And when it was accepted, in the same statement** (`U-32`). `accepted` is true for a hello
   * that is about to be welcomed, approved or pending, and the time is the registry's clock then.
   * For the refusal over the version it is false and the time is cleared: no accepted handshake
   * spoke that version, and a time kept from an earlier one would date it wrongly. The form says
   * "when it last connected" from this pair; `last_seen_at` moves on a refusal over the version
   * too, and cannot.
   *
   * **And when it was refused, the other way round** (`U-35`). The refusal writes the time to
   * `protocol_refused_at` and an acceptance clears it, so the row says which of the two the
   * version was. Without it a refusal at 0 was a 0 with no time, which is also what the `R-01`
   * upgrade left for a probe that had not connected since, and both were read as nothing
   * recorded.
   */
  async #speaks(gid: string, protocolVersion: number, accepted: boolean): Promise<void> {
    const now = this.#now().toISOString();
    await this.#db.query(
      `UPDATE probe_registration
       SET protocol_version = $2, protocol_accepted_at = $3, protocol_refused_at = $4
       WHERE gid = $1`,
      [gid, protocolVersion, accepted ? now : null, accepted ? null : now],
    );
  }
}

/**
 * What a probe is told when its address is not accepted.
 *
 * One function so a probe refused at a handshake and one refused because the filter moved under
 * it read identically in the journal — the operator is looking at the same fact either way.
 */
function refusedFrom(address: string): string {
  return `this probe is not accepted from ${address}`;
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

function readOne(rows: readonly Record<string, unknown>[], gid: string): ProbeRegistration {
  const row = rows[0];
  if (row === undefined)
    throw new ProbeRegistryError('PROBE_NOT_FOUND', `there is no probe ${gid}`);
  return read(row);
}

/** The account a decision is attributed to in `decided_by`, which holds an account id or nothing. */
function decidedBy(actor: Actor): number | null {
  return actor.kind === 'user' ? actor.userId : null;
}

/** Which probe, by what the queue showed: never a key, and not the hash of one (`A-20`). */
function identityOf(registration: ProbeRegistration): ProbeIdentity {
  return {
    gid: registration.gid,
    name: registration.displayName,
    address: registration.lastAddress,
  };
}

function trustOf(registration: ProbeRegistration): ProbeTrustAudit {
  return {
    status: registration.status,
    objectId: registration.objectId,
    allowFrom: registration.allowFrom.join(', '),
    note: registration.note,
  };
}

function read(row: Record<string, unknown>): ProbeRegistration {
  return {
    gid: String(row['gid']),
    status: row['status'] as ProbeRegistration['status'],
    displayName: text(row['display_name']),
    agentVersion: text(row['agent_version']),
    protocolVersion: Number(row['protocol_version'] ?? 0),
    skew: skewFor(Number(row['protocol_version'] ?? 0), row['protocol_refused_at'] != null),
    protocolAcceptedAt:
      row['protocol_accepted_at'] == null ? null : iso(row['protocol_accepted_at']),
    protocolRefusedAt: row['protocol_refused_at'] == null ? null : iso(row['protocol_refused_at']),
    lastAddress: text(row['last_address']),
    allowFrom: Array.isArray(row['allow_from']) ? (row['allow_from'] as string[]) : [],
    hasOwnKey: row['access_key_hash'] != null && row['access_key_confirmed_at'] != null,
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
 *
 * **Unless the row says that zero was refused** (`U-35`). A hello refused over its version writes
 * the version and `protocol_refused_at`, so a refused 0 is the probe's own claim, and is
 * `incompatible` like any other version below the floor.
 *
 * **And `incompatible` says what happens next, from what the row says happened** (`U-35`). A
 * version this build refuses was either refused at a hello, or accepted by a core whose floor
 * was lower and recorded before this one started: that probe is not connected, because this core
 * has refused it at every hello since, and will be refused at its next one. The reason alone said
 * neither.
 *
 * **"A hello was refused over it", never "its last hello"** (`P-317` review). The refusal's time
 * moves only on a version refusal, and since `P-319` a later hello that does not prove it is this
 * probe (a wrong key, an address its filter refuses) writes nothing, so the probe's last hello
 * may have been refused for something else, by a probe upgraded since.
 */
function skewFor(protocolVersion: number, refused: boolean): RegistrationSkew {
  const skew: ProtocolSkew =
    protocolVersion === 0 && !refused ? { kind: 'unknown' } : describeSkew(protocolVersion);
  if (skew.kind !== 'incompatible') return { ...skew, explanation: explainSkew(skew) };
  const next = refused
    ? 'so a hello was refused over it, and it will be refused again until it is upgraded'
    : 'so it will be refused when it next connects, unless it has been upgraded since';
  return { ...skew, explanation: `${explainSkew(skew)}, ${next}` };
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** A text column, or empty. Narrowed rather than coerced: `String({})` is `[object Object]`. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
