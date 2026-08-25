import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { Migrator } from '../src/db/migrator.js';
import type { Database } from '../src/db/pool.js';
import {
  PAUSE_CAUSE,
  PAUSE_PRECEDENCE,
  PAUSE_SOURCES,
  ROLLUP_SEVERITY,
  SENSOR_STATE_CAUSES,
  SENSOR_STATES,
  TRANSITIONS,
  V1_STATES,
  V2_STATES,
  type PauseSource,
  type RollupState,
} from '../src/state/tables.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { silent } from './support/tree.js';

const available = await databaseAvailable();

/** The rule the written-out table has to agree with: first active source, in order. */
function causeByRule(active: readonly PauseSource[]): string | null {
  const found = PAUSE_SOURCES.find((source) => active.includes(source));
  return found === undefined ? null : PAUSE_CAUSE[found];
}

/** Every subset of the four sources, as a bitmask over PAUSE_SOURCES. */
function everyCombination(): PauseSource[][] {
  const out: PauseSource[][] = [];
  for (let mask = 0; mask < 1 << PAUSE_SOURCES.length; mask += 1) {
    out.push(PAUSE_SOURCES.filter((_, index) => (mask & (1 << index)) !== 0));
  }
  return out;
}

const key = (active: readonly PauseSource[]): string =>
  PAUSE_SOURCES.filter((source) => active.includes(source)).join('+');

describe('pause precedence', () => {
  it('covers every combination of the four sources, exactly once', () => {
    // Sixteen rows. Exhaustive is cheap here and is the only way to be sure the table has no
    // hole — PLAN.md names precedence bugs as this phase's principal risk.
    const listed = PAUSE_PRECEDENCE.map((entry) => key(entry.active)).sort();
    const expected = everyCombination().map(key).sort();

    assert.equal(listed.length, 16);
    assert.deepEqual(listed, expected);
    assert.equal(new Set(listed).size, 16, 'a combination is listed twice');
  });

  it('agrees with the rule it is meant to encode', () => {
    // The table is written out by hand and the rule is computed. Two independent derivations
    // that must agree catches a mistake in either; one derivation checked against itself
    // catches nothing.
    for (const entry of PAUSE_PRECEDENCE) {
      assert.equal(
        entry.cause,
        causeByRule(entry.active),
        `wrong cause for [${key(entry.active)}]`,
      );
    }
  });

  it('pauses whenever any source is set', () => {
    for (const entry of PAUSE_PRECEDENCE) {
      assert.equal(entry.paused, entry.active.length > 0, `[${key(entry.active)}]`);
    }
  });

  it('is a set, not a priority chain', () => {
    // The invariant the whole task turns on. Clearing one source must never resume a sensor
    // another source still holds — as a chain, resuming the parent would resume a sensor
    // somebody had also paused by hand.
    const table = new Map(PAUSE_PRECEDENCE.map((entry) => [key(entry.active), entry]));

    for (const entry of PAUSE_PRECEDENCE) {
      if (entry.active.length < 2) continue;
      for (const cleared of entry.active) {
        const remaining = entry.active.filter((source) => source !== cleared);
        const after = table.get(key(remaining));
        assert.ok(after, `no row for [${key(remaining)}]`);
        assert.equal(
          after.paused,
          true,
          `clearing ${cleared} from [${key(entry.active)}] resumed a sensor that is still held`,
        );
      }
    }
  });

  it('reports a cause exactly when it is paused', () => {
    for (const entry of PAUSE_PRECEDENCE) {
      assert.equal(entry.cause === null, !entry.paused, `[${key(entry.active)}]`);
      if (entry.cause !== null) {
        assert.ok(
          (SENSOR_STATE_CAUSES as readonly string[]).includes(entry.cause),
          `${entry.cause} is not a cause the database knows`,
        );
      }
    }
  });

  it('evaluates parent first and manual last', () => {
    // WORKFLOW.MD §5 fixes this order. Asserting it means a reordering is a failing test rather
    // than a silently different attribution in the history tab.
    assert.deepEqual([...PAUSE_SOURCES], ['parent', 'dependency', 'schedule', 'manual']);
  });
});

describe('state vocabulary', () => {
  it('splits cleanly into v1 and v2', () => {
    assert.deepEqual(
      [...V1_STATES, ...V2_STATES].sort(),
      [...SENSOR_STATES].sort(),
      'every state must be in exactly one of the two lists',
    );
    for (const state of V1_STATES) {
      assert.ok(!(V2_STATES as readonly string[]).includes(state), `${state} is in both lists`);
    }
  });

  it('ranks only the states a scan with readings can produce', () => {
    // `unknown` is not "better than up": it is decided a layer earlier. Ranking it here would
    // let a channel with no reading outvote one that is genuinely down.
    assert.deepEqual(Object.keys(ROLLUP_SEVERITY).sort(), ['down', 'up', 'warning']);

    // Sorted by the ranking rather than compared pairwise: the literals make a direct
    // comparison a compile-time tautology, and this exercises the ordering the rollup uses.
    const ordered = (Object.keys(ROLLUP_SEVERITY) as RollupState[]).sort(
      (a, b) => ROLLUP_SEVERITY[a] - ROLLUP_SEVERITY[b],
    );
    assert.deepEqual(ordered, ['up', 'warning', 'down'], 'worst must be down');
  });
});

describe('transitions', () => {
  it('never reaches a v2 state', () => {
    // The type accommodates Unusual and Down (Partial) so the column never has to change. An
    // aspiration in a comment is not a constraint; this is.
    for (const transition of TRANSITIONS) {
      assert.ok(
        !(V2_STATES as readonly string[]).includes(transition.to),
        `${transition.from} → ${transition.to} reaches a [V2] state`,
      );
    }
  });

  it('names only causes the database can store', () => {
    for (const transition of TRANSITIONS) {
      assert.ok(transition.causes.length > 0, `${transition.from} → ${transition.to} has no cause`);
      for (const cause of transition.causes) {
        assert.ok(
          (SENSOR_STATE_CAUSES as readonly string[]).includes(cause),
          `${cause} is not a cause the database knows`,
        );
      }
    }
  });

  it('can reach every v1 state', () => {
    // A state nothing transitions into is either dead or a gap in the table.
    const reachable = new Set(TRANSITIONS.map((transition) => transition.to));
    for (const state of V1_STATES) {
      assert.ok(reachable.has(state), `nothing transitions into ${state}`);
    }
  });

  it('can leave every v1 state', () => {
    const leavable = new Set(TRANSITIONS.map((transition) => transition.from));
    for (const state of V1_STATES) {
      assert.ok(leavable.has(state), `${state} is a dead end`);
    }
  });

  it('starts from creation exactly once', () => {
    const created = TRANSITIONS.filter((transition) => transition.from === 'created');
    assert.equal(created.length, 1);
    assert.equal(created[0]?.to, 'unknown', 'a sensor has not been checked when it is created');
  });

  it('gives every transition a trigger someone can read', () => {
    for (const transition of TRANSITIONS) {
      assert.ok(
        transition.trigger.length > 10,
        `${transition.from} → ${transition.to} has no usable trigger`,
      );
    }
  });
});

describe(
  'the database agrees',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;

    before(async () => {
      scratch = await createScratchDatabase('statetables');
      db = scratch.db;
      // A scratch database is empty; the enums arrive with migration 003.
      await new Migrator({ db, logger: silent, migrations: MIGRATIONS }).up();
    });

    after(async () => {
      await scratch.drop();
    });

    async function enumValues(name: string): Promise<string[]> {
      const rows = await db.query<{ value: string }>(
        `SELECT e.enumlabel AS value
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
         WHERE t.typname = $1 ORDER BY e.enumsortorder`,
        [name],
      );
      return rows.map((row) => row.value);
    }

    it('stores exactly the states these tables name', async () => {
      // Migration 003 created the enum; these tables mirror it. Checking rather than trusting,
      // because a state the code can produce and the column cannot store is a write that fails
      // at the worst possible moment — while recording an outage.
      assert.deepEqual((await enumValues('sensor_state_kind')).sort(), [...SENSOR_STATES].sort());
    });

    it('stores exactly the causes these tables name', async () => {
      assert.deepEqual(
        (await enumValues('sensor_state_cause')).sort(),
        [...SENSOR_STATE_CAUSES].sort(),
      );
    });
  },
);
