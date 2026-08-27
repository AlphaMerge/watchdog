import type { Migration } from './types.js';

/**
 * The last raw counter per channel, so the next reading can be turned into a rate (`T-02`).
 *
 * **Not a sample, and deliberately not in the `sample` hypertable.** What is stored as a sample
 * is the rate — `scaling.ts` states the rule this follows, one number so a chart can never
 * disagree with the alarm that fired. The raw counter is a *baseline*: exactly one value per
 * channel, overwritten every scan, never queried as history, never rolled up, and worthless the
 * moment the next one arrives. Putting it in a hypertable would mean storing and compressing and
 * expiring a second series nobody reads to answer a question about the newest row.
 *
 * **`numeric(20,0)` rather than `bigint`.** SNMP's Counter64 is *unsigned* 64-bit, so its top
 * half does not fit a signed `bigint` — `ifHCInOctets` past 2^63 would arrive negative and the
 * next delta would be nonsense on precisely the busiest links. `numeric` holds it exactly and is
 * read back as text, which is what `parseCounter` wants anyway.
 *
 * **One row per channel, cascading with it.** A channel deleted takes its baseline with it, and a
 * sensor re-created gets no baseline, which is right: it reports `first` and starts again rather
 * than dividing across a discontinuity nobody can see.
 */
export const migration023: Migration = {
  id: 23,
  name: 'channel-counters',

  up: `
    -- Declared by the sensor type, stored on the channel, exactly as \`lookup_id\` is (migration
    -- 009). It rides with the channel rather than being looked up from the catalogue at
    -- ingestion time so the reading path stays one query, and so a type whose declaration
    -- changes does not silently reinterpret a channel that already has history.
    ALTER TABLE channel
      ADD COLUMN counter_bits smallint CHECK (counter_bits IN (32, 64));

    COMMENT ON COLUMN channel.counter_bits IS
      'Set when this channel reports a counter rather than a measurement (T-02). The stored sample is the rate; the raw counter lives in channel_counter.';

    CREATE TABLE channel_counter (
      channel_id  integer PRIMARY KEY REFERENCES channel (id) ON DELETE CASCADE,
      -- The counter exactly as the device reported it, before any scaling.
      last_value  numeric(20,0) NOT NULL CHECK (last_value >= 0),
      -- When the device was read, not when the row was written: the divisor is the time between
      -- two *readings*, and a row written late would shrink the interval and inflate the rate.
      last_at     timestamptz NOT NULL,
      updated_at  timestamptz NOT NULL DEFAULT now()
    );

    COMMENT ON TABLE channel_counter IS
      'Last raw counter per channel, the baseline T-02 divides the next reading against. Not history: one row per channel, overwritten every scan.';
  `,

  down: `
    DROP TABLE IF EXISTS channel_counter;
    ALTER TABLE channel DROP COLUMN IF EXISTS counter_bits;
  `,
};
