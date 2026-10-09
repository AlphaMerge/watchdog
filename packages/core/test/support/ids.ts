import type { Queryable } from '../../src/db/pool.js';

/**
 * Moves `table`'s id sequence so that the next `count` rows straddle a power of ten (`P-385`).
 *
 * An id cast to text sorts `'1000'` before `'999'`, so an `ORDER BY` that names a
 * `x::text AS x` output column instead of the column itself is wrong only across a digit
 * boundary, which a fresh scratch database never reaches. Upwards only, so nothing already made
 * is reused: the boundary is the first power of ten that leaves room below it for half the rows.
 *
 * For a scratch database: the sequence is the whole file's from here on. Returns the ids the next
 * `count` inserts will take, lowest first.
 */
export async function straddleAPowerOfTen(
  q: Queryable,
  table: string,
  count: number,
): Promise<number[]> {
  const below = Math.ceil(count / 2);
  const [current] = await q.query<{ last: string }>(
    `SELECT coalesce(pg_sequence_last_value(pg_get_serial_sequence($1, 'id')::regclass), 0)::text
              AS last`,
    [table],
  );
  const last = Number(current?.last ?? 0);
  let boundary = 10;
  while (boundary - below <= last) boundary *= 10;
  const first = boundary - below;
  await q.query(`SELECT setval(pg_get_serial_sequence($1, 'id'), $2)`, [table, first - 1]);
  return Array.from({ length: count }, (_, index) => first + index);
}
