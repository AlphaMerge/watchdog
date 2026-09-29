import type { Visibility } from '../auth/access.js';
import { AuthError } from '../auth/errors.js';
import type { Queryable } from '../db/pool.js';
import type { Actor } from './audit.js';
import { ObjectError } from './errors.js';
import type { ObjectId, ObjectKind } from './types.js';

/**
 * Whose rights stand behind what a sensor's parameters name (`A-29`).
 *
 * **A sensor that reads another object's data republishes it** to everybody who can read the
 * sensor — a Sensor Factory's formula, a Probe Health sensor's probe. So writing one has to be
 * something its writer could have read for themselves, and the object service checks that on
 * every write that leaves such a sensor behind.
 *
 * An account vouches with what it can see, which is the `Visibility` the request already
 * resolved. The installation vouches for what it does itself — a sensor the core makes for a new
 * probe, a template an administrator installed — and for everything when the authorisation layer
 * is off, where there is nobody to hide anything from.
 */
export type Voucher =
  | {
      readonly kind: 'account';
      readonly userId: number;
      readonly sees: Sees;
      /** Which objects the account may write, for where a write sends credentials (`A-41`). */
      readonly writes: Writes;
    }
  | { readonly kind: 'installation' };

/**
 * Which of some objects an account may write, asked on the connection of the write that needs it
 * (`A-41`): the bar the route that names each one would hold it to, role and token scope included.
 */
export type Writes = (
  q: Queryable,
  objectIds: readonly ObjectId[],
) => Promise<ReadonlySet<ObjectId>>;

/**
 * Who stands behind sending an inherited credential set to where a write sends it (`A-41`).
 *
 * Usually the write's own voucher. A discovery run is the exception: the installation stands
 * behind what its templates name, but not behind the addresses somebody chose to scan, so the
 * account that started the run — or last wrote the rule that started it — vouches for where the
 * credentials go. `userId: null` is an account since deleted, which vouches for nothing.
 */
export type CredentialVoucher =
  | { readonly kind: 'account'; readonly userId: number | null; readonly writes: Writes }
  | { readonly kind: 'installation' };

/**
 * What an account can see: already resolved, or resolved on the connection of the write that
 * first needs it (`P-235`).
 *
 * **Most writes never need it.** Only a sensor of a type that reads another object's data asks,
 * and a request resolving it up front paid a query on every authenticated write for the few that
 * do: a group, a device or a ping create never looked at the answer. Deferred, it costs nothing
 * where nothing is named, and where something is, it runs inside the write's own transaction, on
 * the connection that transaction already holds. The request's own memo still stands behind it, so
 * a request that resolved its sight for another reason does not resolve it twice.
 */
export type Sees = Visibility | ((q: Queryable) => Promise<Visibility>);

export const INSTALLATION_VOUCHES: Voucher = { kind: 'installation' };

/**
 * Who is writing, as the audit records them, and — for an account — who vouches (`A-29`).
 *
 * **An account or a token has to say**, because a default there would be the unchecked write
 * `A-29` exists to close; the system and an installation with authorisation off vouch as the
 * installation, which is what they are. Usually an account vouches as itself (`writerFor`), but
 * not always: a discovery run writes what an administrator's template says, so it vouches as the
 * installation, and the audit still names who started it.
 */
export type Writer = (
  | Extract<Actor, { kind: 'system' | 'anonymous' }>
  | (Extract<Actor, { kind: 'user' | 'token' }> & { readonly voucher: Voucher })
) & {
  /** Who vouches for where inherited credentials go, when it is not the voucher (`A-41`). */
  readonly credentials?: CredentialVoucher;
};

/**
 * An actor writing what the installation stands behind, with the audit still naming them.
 *
 * For a discovery run, whose sensors come from a template file somebody with the server's file
 * system installed — a bar well above read on the root.
 */
export function asInstallation(actor: Actor): Writer {
  return actor.kind === 'user' || actor.kind === 'token'
    ? { ...actor, voucher: INSTALLATION_VOUCHES }
    : actor;
}

/** Who vouches for a write. */
export function voucherOf(writer: Writer): Voucher {
  return writer.kind === 'user' || writer.kind === 'token' ? writer.voucher : INSTALLATION_VOUCHES;
}

/** Who vouches for where a write sends inherited credentials (`A-41`). */
export function credentialVoucherOf(writer: Writer): CredentialVoucher {
  return writer.credentials ?? voucherOf(writer);
}

/** The writer as the audit records them: who, and nothing about what they can see. */
export function actorOf(writer: Writer): Actor {
  switch (writer.kind) {
    case 'user':
      return { kind: 'user', userId: writer.userId, login: writer.login };
    case 'token':
      return { kind: 'token', tokenId: writer.tokenId };
    // Rebuilt rather than returned, so that nothing a writer carries besides who they are — a
    // credential voucher (`A-41`) — reaches the audit.
    case 'system':
      return { kind: 'system', component: writer.component };
    case 'anonymous':
      return { kind: 'anonymous', remoteAddress: writer.remoteAddress };
  }
}

/** One object a written sensor names, and where in its parameters. */
export interface NamedObject {
  /** The sensor that names it, by name, for a refusal about a sensor inside a subtree. */
  readonly sensorName: string;
  readonly param: string;
  readonly objectId: ObjectId;
  readonly expects: 'sensor' | 'probe';
}

/** A sensor whose type bars writing one to anybody who cannot read the root. */
export interface InstallationBar {
  readonly sensorName: string;
  readonly sensorType: string;
}

/** What one write leaves behind that has to be checked. */
export interface WrittenReads {
  readonly named: readonly NamedObject[];
  readonly bars: readonly InstallationBar[];
  /**
   * Whether a refusal has to say which sensor it is about. A write of one sensor does not: its
   * caller sent the parameters being refused. A move, a clone or a tree does.
   */
  readonly sayWhich: boolean;
}

/** What the database says about the objects a write names. */
export interface Found {
  /** The kind of every named object that exists. */
  readonly kinds: ReadonlyMap<ObjectId, ObjectKind>;
  /** Which of them the voucher can read. Ignored for the installation. */
  readonly readable: ReadonlySet<ObjectId>;
  /** Whether the voucher can read the root. Ignored for the installation. */
  readonly rootReadable: boolean;
}

/**
 * The first reason a write may not stand, or null (`A-29`). Pure, so the rules are a table.
 *
 * **A hidden object and a missing one are refused in the same words**, with the same status and
 * the same context, which is what keeps a formula from being a way to learn which ids exist. A
 * wrong kind is said only of an object the voucher can read: saying "that is a device" of one it
 * cannot would be the same leak by another route.
 */
export function refusal(voucher: Voucher, written: WrittenReads, found: Found): Error | null {
  const account = voucher.kind === 'account';
  const about = (sensorName: string): string =>
    written.sayWhich ? `sensor "${sensorName}": ` : '';

  for (const named of written.named) {
    const kind = found.kinds.get(named.objectId);
    const readable = kind !== undefined && (!account || found.readable.has(named.objectId));
    if (!readable) {
      // No sensor id: for a create or a clone it is a number the rollback took back, and the
      // message names the sensor wherever the caller could not tell which one it is about.
      const context = { param: named.param, objectId: named.objectId };
      return account
        ? new AuthError(
            'AUTH_FORBIDDEN',
            `${about(named.sensorName)}${named.param} names object ${String(named.objectId)}, ` +
              'which does not exist or which you cannot read',
            { ...context, needed: 'read' },
          )
        : new ObjectError(
            'OBJECT_INVALID',
            `${about(named.sensorName)}${named.param} names object ${String(named.objectId)}, ` +
              'which does not exist',
            { context: { ...context, phase: 'check-sensor-reads' } },
          );
    }
    if (kind !== named.expects) {
      return new ObjectError(
        'OBJECT_INVALID',
        `${about(named.sensorName)}${named.param} names object ${String(named.objectId)}, ` +
          `which is a ${kind}, not a ${named.expects}`,
        {
          context: { param: named.param, objectId: named.objectId, phase: 'check-sensor-reads' },
          details: { expected: named.expects, actual: kind },
        },
      );
    }
  }

  if (account && !found.rootReadable) {
    const bar = written.bars[0];
    if (bar !== undefined) {
      return new AuthError(
        'AUTH_FORBIDDEN',
        `${about(bar.sensorName)}a ${bar.sensorType} sensor reports on the whole installation, so ` +
          'writing one needs read on the root',
        { sensorType: bar.sensorType, needed: 'read' },
      );
    }
  }

  return null;
}

/**
 * Throws unless the voucher could have read everything this write names (`A-29`).
 *
 * Two queries at most, and none when nothing was named: which of the objects exist and what they
 * are, and which of them the voucher can read — the same condition every list is filtered by.
 */
export async function assertMayName(
  q: Queryable,
  voucher: Voucher,
  written: WrittenReads,
): Promise<void> {
  if (written.named.length === 0 && written.bars.length === 0) return;

  const asked = new Set(written.named.map((named) => named.objectId));
  const ids = [...asked];
  const rows = await q.query<{ id: string; kind: ObjectKind }>(
    `SELECT id::text AS id, kind FROM object WHERE id = ANY($1::bigint[]) OR kind = 'root'`,
    [ids],
  );
  const kinds = new Map<ObjectId, ObjectKind>();
  let rootId: ObjectId | undefined;
  for (const row of rows) {
    const id = Number(row.id);
    if (row.kind === 'root') rootId = id;
    if (asked.has(id)) kinds.set(id, row.kind);
  }

  let readable: ReadonlySet<ObjectId> = new Set();
  let rootReadable = false;
  if (voucher.kind === 'account') {
    const existing = rootId === undefined ? [...kinds.keys()] : [...kinds.keys(), rootId];
    const sees = typeof voucher.sees === 'function' ? await voucher.sees(q) : voucher.sees;
    const seen = await sees.visibleAmong(q, existing);
    readable = seen;
    rootReadable = rootId !== undefined && seen.has(rootId);
  }

  const refused = refusal(voucher, written, { kinds, readable, rootReadable });
  if (refused !== null) throw refused;
}
