import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * That every query behind `toRuntime` reads every field `toRuntime` uses (`P-97`).
 *
 * `RuntimeRow` is asserted from raw SQL, so the compiler cannot check it: a query that omits a
 * column produces `undefined` where the type promises `T | null`, and `toRuntime` then rebuilds
 * *different facts* from the same sensor depending on which query happened to read it. Two
 * queries feed it — `loadRuntimes`, which the machine decides on, and `readSensorState`, which
 * the API answers `GET /sensors/:id/state` from — and they carry separate column lists.
 *
 * It has already gone wrong twice, once per column added:
 *
 * - `P-85` added `channel_state`/`channel_cause` and updated only `RUNTIME_COLUMNS`. The read
 *   side quietly returned `undefined`, which `channelVerdict` read as "nothing judged" — so the
 *   API reported a sensor as having no channel verdict while the machine had one. Silent.
 * - `P-97` added `resumed_at` the same way, and `neverScanned` calls `.getTime()` on it. That
 *   one threw, which is the only reason it was found: `GET /sensors/:id/state` answered 500 for
 *   every sensor, and it was caught by an unrelated acknowledgement test asserting over HTTP.
 *
 * A guard rather than a convention, because the convention had already been written down in the
 * first query's comment and did not survive the second column.
 */
describe('the runtime row', () => {
  it('is read in full by every query that builds one', async () => {
    const source = await readFile(
      join(import.meta.dirname, '..', '..', 'src', 'state', 'runtime.ts'),
      'utf8',
    );

    const shape = /interface RuntimeRow \{([\s\S]*?)\n\}/.exec(source);
    assert.ok(shape?.[1] !== undefined, 'RuntimeRow has moved; this guard needs its new shape');

    // **Optional means "one query may skip it", and the type already says which.**
    // `acknowledged_by_kind`/`_label` are declared `?:` because only the single-sensor read
    // needs them (`M-13`); everything else is required, and a required field missing from
    // either query is the defect this guard exists for.
    const declared = [...shape[1].matchAll(/^ {2}(\w+)(\??):/gm)]
      .map((match) => ({ field: match[1] ?? '', optional: match[2] === '?' }))
      // `object_id` is aliased in both queries rather than selected bare.
      .filter((one) => one.field !== '' && one.field !== 'object_id');
    const required = declared.filter((one) => !one.optional).map((one) => one.field);
    const optional = declared.filter((one) => one.optional).map((one) => one.field);
    assert.ok(
      required.length >= 12,
      `only ${String(required.length)} required fields; regex broke`,
    );

    // The two column lists, by the shape each one has rather than by line number.
    const bulk = /const RUNTIME_COLUMNS = `([\s\S]*?)`;/.exec(source);
    const single = /export async function readSensorState\(([\s\S]*?)\n\}/.exec(source);
    assert.ok(bulk?.[1] !== undefined, 'RUNTIME_COLUMNS has moved');
    assert.ok(single?.[1] !== undefined, 'readSensorState has moved');

    // Word-bounded: `channel_state` must not be satisfied by `channel_state_kind`, and `state`
    // must not be satisfied by `channel_state` (`P-80`'s substring lesson).
    const selects = (sql: string, field: string): boolean => new RegExp(`\\b${field}\\b`).test(sql);

    const queries = [
      ['RUNTIME_COLUMNS', bulk[1]],
      ['readSensorState', single[1]],
    ] as const;

    const missing: string[] = [];
    for (const [where, sql] of queries) {
      for (const field of required) {
        if (!selects(sql, field)) missing.push(`${where}: ${field}`);
      }
    }
    // An optional field nothing reads is not optional, it is dead.
    for (const field of optional) {
      if (!queries.some(([, sql]) => selects(sql, field))) {
        missing.push(`no query at all: ${field}`);
      }
    }

    assert.deepEqual(
      missing,
      [],
      `toRuntime reads these, and the query does not select them — the field comes back ` +
        `undefined and the facts are silently wrong:\n  ${missing.join('\n  ')}`,
    );
  });
});
