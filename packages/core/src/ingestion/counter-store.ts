import type { Queryable } from '../db/pool.js';
import type { CounterSample } from './counters.js';

/**
 * The baselines a batch of counter readings needs, and the ones it leaves behind (`T-02`).
 *
 * Two statements per batch rather than two per reading. A probe's batch carries every interface
 * on every device it watches, so a round trip per channel would make a busy probe's ingest
 * dominated by the bookkeeping rather than by the samples.
 */
export class CounterStore {
  /** The last reading for each of these channels, for the ones that have one. */
  async load(q: Queryable, channelIds: readonly number[]): Promise<Map<number, CounterSample>> {
    const out = new Map<number, CounterSample>();
    if (channelIds.length === 0) return out;

    const rows = await q.query<{ channel_id: number; last_value: string; last_at: Date }>(
      `SELECT channel_id, last_value::text AS last_value, last_at
       FROM channel_counter
       WHERE channel_id = ANY($1::int[])`,
      [channelIds],
    );

    for (const row of rows) {
      // `numeric` comes back as text on purpose: an unsigned 64-bit counter does not fit a
      // double, and the driver would have rounded it before this code ever saw it.
      out.set(row.channel_id, { value: BigInt(row.last_value), at: row.last_at });
    }
    return out;
  }

  /**
   * Records what each channel last read.
   *
   * Written for **every** counter reading, including the ones that produced no sample. A reset,
   * a stale gap and a first reading all have to move the baseline forward, or the next scan
   * would divide against a value the device has long since passed and report the same failure
   * for ever.
   */
  async save(q: Queryable, samples: ReadonlyMap<number, CounterSample>): Promise<void> {
    if (samples.size === 0) return;

    const channelIds: number[] = [];
    const values: string[] = [];
    const times: Date[] = [];
    for (const [channelId, sample] of samples) {
      channelIds.push(channelId);
      values.push(sample.value.toString());
      times.push(sample.at);
    }

    await q.query(
      `INSERT INTO channel_counter (channel_id, last_value, last_at)
       SELECT channel_id, last_value, last_at
       FROM unnest($1::int[], $2::numeric[], $3::timestamptz[])
            AS s(channel_id, last_value, last_at)
       -- A channel deleted between the read and this write is ordinary — a sensor removed while
       -- its last batch was in flight — and letting the foreign key raise would fail every other
       -- channel's baseline in the same statement.
       WHERE EXISTS (SELECT 1 FROM channel c WHERE c.id = s.channel_id)
       ON CONFLICT (channel_id) DO UPDATE
         SET last_value = EXCLUDED.last_value,
             last_at    = EXCLUDED.last_at,
             updated_at = now()
         -- Out-of-order arrival is real: a probe drains its spool after an outage, so a batch
         -- can carry a reading older than one already stored. Taking it would move the baseline
         -- backwards and make the next delta enormous.
         WHERE EXCLUDED.last_at > channel_counter.last_at`,
      [channelIds, values, times],
    );
  }
}
