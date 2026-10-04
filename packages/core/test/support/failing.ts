import type { QueryResultRow } from 'pg';
import { savepoint, type Queryable } from '../../src/db/pool.js';

/**
 * `q`, with the statements `fails` picks replaced by one PostgreSQL refuses (`P-249`).
 *
 * What a statement the database refused looks like, to code that cannot be made to send a bad
 * one. The refusal is real — a division by zero, sent through `q` — so it aborts `q`'s
 * transaction exactly as any failed statement would. Savepoints taken through it are `q`'s own,
 * with the same replacement inside them.
 */
export function failingOn(
  q: Queryable,
  fails: (text: string, values: readonly unknown[] | undefined) => boolean,
): Queryable {
  return {
    query: <T extends QueryResultRow>(text: string, values?: readonly unknown[]) =>
      fails(text, values) ? q.query<T>('SELECT 1/0') : q.query<T>(text, values),
    afterCommit: (fn: () => void) => q.afterCommit?.(fn),
    afterRollback: (fn: () => void) => q.afterRollback?.(fn),
    savepoint: <T>(fn: (inner: Queryable) => Promise<T>) =>
      savepoint(q, (inner) => fn(failingOn(inner, fails))),
  };
}
