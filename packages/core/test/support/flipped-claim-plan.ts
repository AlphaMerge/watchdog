import type { Database, Queryable } from '../../src/db/pool.js';

/**
 * The dispatcher's database, with the plan that hands a claimed batch back in heap order (`N-31`).
 *
 * The claim is one `UPDATE ... FROM claimed RETURNING`, and `RETURNING` promises no order. With a
 * nested loop over `claimed` the rows come back in the claim's order by accident; with a hash join
 * over the table they come back in the order they were last written. Statistics alone choose
 * between the two, which is how round 17's suite sent a recovery ahead of the alarm that should
 * have dropped it. Here every transaction of the dispatcher's turns off the nested loop and the
 * merge join, so the planner has the hash join and nothing else.
 *
 * Each claim is explained in its own transaction before it runs, and the plans are kept, so a test
 * can show the hash join really was taken. Without that a planner that changed its mind would let
 * the test pass without ever meeting the order it is about.
 *
 * Heap order is the order rows were last written in only on a heap with nothing to prune, so a
 * test using this empties `notification_request` with `TRUNCATE`, not `DELETE`.
 */
export function flippedClaimPlan(db: Database): { db: Database; plans: string[] } {
  const plans: string[] = [];
  const explained = (q: Queryable): Queryable =>
    new Proxy(q, {
      get(target, property, receiver) {
        if (property === 'query') {
          return async (text: string, values?: readonly unknown[]) => {
            if (text.includes('WITH claimed AS')) {
              const plan = await target.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${text}`, values);
              plans.push(plan.map((row) => row['QUERY PLAN']).join('\n'));
            }
            return target.query(text, values);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
  const flipped = new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'tx') {
        return <T>(
          fn: (q: Queryable) => Promise<T>,
          limits?: Parameters<Database['tx']>[1],
        ): Promise<T> =>
          target.tx(async (q) => {
            await q.query('SET LOCAL enable_nestloop = off');
            await q.query('SET LOCAL enable_mergejoin = off');
            return fn(explained(q));
          }, limits);
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  return { db: flipped, plans };
}

/**
 * Whether a claim's plan joins the table to `claimed` by hashing `claimed` and scanning the table:
 * the plan whose `RETURNING` comes back in heap order.
 */
export function returnsInHeapOrder(plan: string): boolean {
  // The planner renames `r` and `claimed` (`r_1`, `claimed_1`) where a query uses them twice.
  return /Hash Join[^\n]*\n\s+Hash Cond: \((r(?:_\d+)?)\.id = claimed(?:_\d+)?\.id\)\n\s+->\s+Seq Scan on notification_request \1 [^\n]*\n\s+->\s+Hash\b[^\n]*\n\s+->\s+CTE Scan on claimed\b/.test(
    plan,
  );
}
