import type { Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import { atLeast, type AccessRight } from '../auth/access.js';
import { FlatAccess, ceilingOf, verdict, type FlatViewer } from '../auth/flat-access.js';
import type { Actor, AuditSink, LibraryAudit } from '../objects/audit.js';
import { LibraryError, changedUnderneath, invisible, libraryNotFound } from './errors.js';
import { describeNodes, validateNodes, type LibraryNode } from './nodes.js';
import {
  LIBRARY_GRANTS,
  type LibraryGrant,
  type LibraryRepository,
  type LibraryRow,
} from './repository.js';

/**
 * Everything about a library that decides something (`L-01`).
 *
 * **The shape `MapService` has, on the same access rules**, because a library is the third flat
 * entity and `FlatAccess` is where the rules now live. Two things differ from a map, and both are
 * deliberate:
 *
 * - **Every create, edit and delete is audited**, in the transaction that makes it. A library
 *   decides what a group of people are shown, and narrowing a rule is a change nobody notices
 *   until the day a failure is not on the screen. Maps and reports are not audited; that is a gap
 *   of theirs, and a library does not join it.
 * - **The nodes are refused whole when they do not fit** — `nodes.ts` says why a library is
 *   stricter at the write than a map is.
 *
 * What a library *shows* is not here. That is `L-02`'s resolver, which evaluates each rule through
 * the viewer's own rights (Phase 14, decision 2); nothing in this file reads a sensor.
 */

/** Who is asking. Every flat entity's viewer is `FlatViewer`, under its own name. */
export type LibraryViewer = FlatViewer;

export interface LibraryInput {
  name: string;
  description?: string;
  priority?: number;
  /** Checked by `validateNodes`, so it arrives as whatever the client sent. */
  nodes?: unknown;
}

export type LibraryPatch = Partial<LibraryInput>;

export interface LibraryServiceOptions {
  readonly db: Database;
  readonly repository: LibraryRepository;
  /** Required, so a build cannot wire libraries and forget to record what is done to them. */
  readonly audit: AuditSink;
  readonly logger: Logger;
}

const MAX_NAME = 100;
const MAX_DESCRIPTION = 1000;

export class LibraryService {
  readonly #db: Database;
  readonly #repository: LibraryRepository;
  readonly #access = new FlatAccess(LIBRARY_GRANTS);
  readonly #audit: AuditSink;
  readonly #logger: Logger;

  constructor(options: LibraryServiceOptions) {
    this.#db = options.db;
    this.#repository = options.repository;
    this.#audit = options.audit;
    this.#logger = options.logger.child({ component: 'libraries' });
  }

  /** What this viewer may do with this library. The rules are `FlatAccess`'s. */
  async rightFor(
    viewer: LibraryViewer,
    libraryId: number,
    q: Queryable = this.#db,
  ): Promise<AccessRight> {
    return this.#access.rightFor(viewer, libraryId, q);
  }

  /** Throws unless the viewer holds at least this right; an unreadable library reads as absent. */
  async require(
    viewer: LibraryViewer,
    libraryId: number,
    needed: AccessRight,
    q: Queryable = this.#db,
  ): Promise<LibraryRow> {
    const library = await this.#repository.find(q, libraryId);
    if (library === undefined) throw libraryNotFound(libraryId);

    const held = await this.rightFor(viewer, libraryId, q);
    switch (verdict(held, needed)) {
      case 'ok':
        return library;
      case 'invisible':
        throw invisible(libraryId);
      case 'forbidden':
        throw new LibraryError(
          'LIBRARY_FORBIDDEN',
          `this account may not ${needed} library ${String(libraryId)}`,
          { context: { libraryId, phase: 'authorize' }, details: { held, needed } },
        );
    }
  }

  /** The libraries this viewer may see. Administrators see all of them. */
  async list(viewer: LibraryViewer): Promise<LibraryRow[]> {
    const scope = await this.#access.listScope(viewer, this.#db);
    return scope.all
      ? this.#repository.list(this.#db)
      : this.#repository.listFor(this.#db, scope.groupIds);
  }

  async get(viewer: LibraryViewer, id: number): Promise<LibraryRow> {
    return this.require(viewer, id, 'read');
  }

  /**
   * Creates a library, granting its creator's primary group `full` on it in the same transaction.
   *
   * **Refused to anybody who could not change one**, before the input is read (`A-14`): a new
   * library has no grant to cap, so the role's and the token's ceilings are the whole check, and a
   * caller who may not create learns nothing about what a library must look like.
   */
  async create(
    viewer: LibraryViewer,
    actor: Actor,
    input: LibraryInput,
    now = new Date(),
  ): Promise<LibraryRow> {
    if (!atLeast(ceilingOf(viewer), 'write')) {
      throw new LibraryError('LIBRARY_FORBIDDEN', 'this account may not create libraries', {
        context: { phase: 'create' },
        details: {
          role: viewer.role,
          ...(viewer.scope === undefined ? {} : { scope: viewer.scope }),
        },
      });
    }
    const name = validName(input.name);
    const description = validDescription(input.description ?? '');
    const priority = validPriority(input.priority ?? 3);
    const nodes = validateNodes(input.nodes ?? []);

    return this.#db.tx(async (tx) => {
      // Checked rather than caught: a unique violation inside a transaction aborts it, and every
      // statement after that fails for the wrong reason.
      if (await this.#repository.nameTaken(tx, name, null)) throw nameTaken(name, null);

      const library = await this.#repository.create(tx, { name, description, priority, nodes });
      await this.#access.grantCreator(tx, library.id, viewer, labelOf(actor));
      await this.#audit.record(
        tx,
        actor,
        [
          {
            action: 'library.created',
            objectId: null,
            libraryId: library.id,
            after: auditOf(library),
          },
        ],
        now,
      );

      this.#logger.info({ libraryId: library.id, name }, 'library created');
      return library;
    });
  }

  /**
   * Changes a library, refusing when it has moved on since the caller read it.
   *
   * The version goes into the statement rather than being compared first — see the repository —
   * so the zero-row result *is* the conflict.
   */
  async update(
    viewer: LibraryViewer,
    actor: Actor,
    id: number,
    expectedVersion: number,
    patch: LibraryPatch,
    now = new Date(),
  ): Promise<LibraryRow> {
    return this.#db.tx(async (tx) => {
      const current = await this.require(viewer, id, 'write', tx);

      const next: {
        name?: string;
        description?: string;
        priority?: number;
        nodes?: LibraryNode[];
      } = {};
      if (patch.name !== undefined) next.name = validName(patch.name);
      if (patch.description !== undefined) next.description = validDescription(patch.description);
      if (patch.priority !== undefined) next.priority = validPriority(patch.priority);
      if (patch.nodes !== undefined) next.nodes = validateNodes(patch.nodes);

      if (
        next.name !== undefined &&
        next.name.toLowerCase() !== current.name.toLowerCase() &&
        (await this.#repository.nameTaken(tx, next.name, id))
      ) {
        throw nameTaken(next.name, id);
      }

      const updated = await this.#repository.update(tx, id, expectedVersion, next);
      if (updated === undefined) throw changedUnderneath(id, expectedVersion, current.version);

      await this.#audit.record(
        tx,
        actor,
        [
          {
            action: 'library.updated',
            objectId: null,
            libraryId: id,
            before: auditOf(current),
            after: auditOf(updated),
          },
        ],
        now,
      );

      this.#logger.info({ libraryId: id, version: updated.version }, 'library updated');
      return updated;
    });
  }

  /** Needs `full`, as a map's delete does. The grants go with it. */
  async remove(viewer: LibraryViewer, actor: Actor, id: number, now = new Date()): Promise<void> {
    await this.#db.tx(async (tx) => {
      const current = await this.require(viewer, id, 'full', tx);
      await this.#repository.remove(tx, id);
      await this.#audit.record(
        tx,
        actor,
        [{ action: 'library.deleted', objectId: null, libraryId: id, before: auditOf(current) }],
        now,
      );
      this.#logger.info({ libraryId: id }, 'library deleted');
    });
  }

  /* --------------------------------------------------------------- grants */

  /** Who may see it. `full`, because who else can see a thing is not a read. */
  async grants(viewer: LibraryViewer, id: number): Promise<LibraryGrant[]> {
    return this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'full', tx);
      return this.#access.grants(tx, id);
    });
  }

  /**
   * Granting needs `full`: a `write` holder may arrange the nodes, not decide who else sees them.
   *
   * **Logged, not audited**, as every grant in this system is — object, map and report grants
   * alike. `L-01` records that as a gap of its own rather than closing it for one entity of four.
   */
  async grant(
    viewer: LibraryViewer,
    actor: Actor,
    id: number,
    groupId: number,
    right: AccessRight,
  ): Promise<void> {
    await this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'full', tx);
      if ((await this.#access.grant(tx, id, groupId, right, labelOf(actor))) === 'no-such-group') {
        throw new LibraryError(
          'LIBRARY_GROUP_NOT_FOUND',
          `group ${String(groupId)} does not exist`,
          {
            context: { libraryId: id, phase: 'grant' },
            details: { groupId },
          },
        );
      }
      this.#logger.info({ libraryId: id, groupId, right, actor }, 'library access granted');
    });
  }

  async revoke(viewer: LibraryViewer, actor: Actor, id: number, groupId: number): Promise<void> {
    await this.#db.tx(async (tx) => {
      await this.require(viewer, id, 'full', tx);
      await this.#access.revoke(tx, id, groupId);
      this.#logger.info({ libraryId: id, groupId, actor }, 'library access revoked');
    });
  }
}

/** Who granted a right, as `granted_by` stores it: a login, or nothing for a non-person. */
function labelOf(actor: Actor): string {
  return actor.kind === 'user' ? actor.login : '';
}

function auditOf(library: {
  name: string;
  description: string;
  priority: number;
  nodes: readonly LibraryNode[];
}): LibraryAudit {
  return {
    name: library.name,
    description: library.description,
    priority: library.priority,
    nodes: describeNodes(library.nodes),
  };
}

function nameTaken(name: string, libraryId: number | null): LibraryError {
  return new LibraryError('LIBRARY_NAME_TAKEN', `a library called ${name} already exists`, {
    context: libraryId === null ? { phase: 'create' } : { libraryId, phase: 'update' },
    details: { name },
  });
}

function validName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_NAME) {
    throw new LibraryError(
      'LIBRARY_INVALID',
      `a library name must be 1 to ${String(MAX_NAME)} characters`,
      { context: { phase: 'validate' }, details: { field: 'name' } },
    );
  }
  return name;
}

function validDescription(raw: string): string {
  if (raw.length > MAX_DESCRIPTION) {
    throw new LibraryError(
      'LIBRARY_INVALID',
      `a library description may be at most ${String(MAX_DESCRIPTION)} characters`,
      { context: { phase: 'validate' }, details: { field: 'description' } },
    );
  }
  return raw;
}

function validPriority(raw: number): number {
  if (!Number.isInteger(raw) || raw < 1 || raw > 5) {
    throw new LibraryError('LIBRARY_INVALID', 'priority is a whole number from 1 to 5', {
      context: { phase: 'validate' },
      details: { field: 'priority' },
    });
  }
  return raw;
}
