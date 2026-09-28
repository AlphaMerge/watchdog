import type { Queryable } from '../db/pool.js';
import { grantedTo, type FlatGrant, type GrantTable } from '../auth/flat-access.js';
import type { LibraryNode } from './nodes.js';

/**
 * Rows in and rows out for libraries (`L-01`).
 *
 * **SQL and nothing else**, the split `MapRepository` keeps: no access decisions, no validation,
 * no audit. The grants are not here at all — `auth/flat-access.ts` holds them for every entity
 * that has them.
 */

export interface LibraryRow {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly priority: number;
  readonly nodes: readonly LibraryNode[];
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type LibraryGrant = FlatGrant;

/** Where a library's grants live, for `FlatAccess`. */
export const LIBRARY_GRANTS: GrantTable = { table: 'library_access', key: 'library_id' };

interface RawLibrary {
  id: string;
  name: string;
  description: string;
  priority: number;
  nodes: LibraryNode[];
  version: string;
  created_at: Date;
  updated_at: Date;
}

function toLibrary(row: RawLibrary): LibraryRow {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description,
    priority: row.priority,
    nodes: row.nodes,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = 'id, name, description, priority, nodes, version, created_at, updated_at';

export class LibraryRepository {
  async list(q: Queryable): Promise<LibraryRow[]> {
    const rows = await q.query<RawLibrary>(
      `SELECT ${COLUMNS} FROM library ORDER BY priority DESC, lower(name)`,
    );
    return rows.map(toLibrary);
  }

  /** The libraries a set of groups may see, in one query rather than list-then-filter. */
  async listFor(q: Queryable, groupIds: readonly number[]): Promise<LibraryRow[]> {
    if (groupIds.length === 0) return [];
    const rows = await q.query<RawLibrary>(
      `SELECT ${COLUMNS} FROM library l
       WHERE ${grantedTo(LIBRARY_GRANTS, 'l.id', '$1')}
       ORDER BY l.priority DESC, lower(l.name)`,
      [groupIds],
    );
    return rows.map(toLibrary);
  }

  async find(q: Queryable, id: number): Promise<LibraryRow | undefined> {
    const rows = await q.query<RawLibrary>(`SELECT ${COLUMNS} FROM library WHERE id = $1`, [id]);
    const row = rows[0];
    return row === undefined ? undefined : toLibrary(row);
  }

  /** Whether another library already has this name, compared as the unique index compares it. */
  async nameTaken(q: Queryable, name: string, exceptId: number | null): Promise<boolean> {
    const rows = await q.query<{ id: string }>(
      `SELECT id FROM library WHERE lower(name) = lower($1) AND ($2::bigint IS NULL OR id <> $2)`,
      [name, exceptId],
    );
    return rows.length > 0;
  }

  async create(
    q: Queryable,
    input: {
      name: string;
      description: string;
      priority: number;
      nodes: readonly LibraryNode[];
    },
  ): Promise<LibraryRow> {
    const rows = await q.query<RawLibrary>(
      `INSERT INTO library (name, description, priority, nodes)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING ${COLUMNS}`,
      [input.name, input.description, input.priority, JSON.stringify(input.nodes)],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('the insert returned no row');
    return toLibrary(row);
  }

  /**
   * Writes a library, refusing when it has moved on since the caller read it.
   *
   * **The version is in the WHERE clause, not checked first**, as `MapRepository.update` does it:
   * the zero-row result *is* the conflict, with no window between the read and the write for the
   * other editor to commit into.
   */
  async update(
    q: Queryable,
    id: number,
    expectedVersion: number,
    patch: {
      name?: string;
      description?: string;
      priority?: number;
      nodes?: readonly LibraryNode[];
    },
  ): Promise<LibraryRow | undefined> {
    const rows = await q.query<RawLibrary>(
      `UPDATE library SET
         name        = COALESCE($3, name),
         description = COALESCE($4, description),
         priority    = COALESCE($5, priority),
         nodes       = COALESCE($6::jsonb, nodes),
         version     = version + 1
       WHERE id = $1 AND version = $2
       RETURNING ${COLUMNS}`,
      [
        id,
        expectedVersion,
        patch.name ?? null,
        patch.description ?? null,
        patch.priority ?? null,
        patch.nodes === undefined ? null : JSON.stringify(patch.nodes),
      ],
    );
    const row = rows[0];
    return row === undefined ? undefined : toLibrary(row);
  }

  async remove(q: Queryable, id: number): Promise<boolean> {
    const rows = await q.query<{ id: string }>(`DELETE FROM library WHERE id = $1 RETURNING id`, [
      id,
    ]);
    return rows.length > 0;
  }
}
