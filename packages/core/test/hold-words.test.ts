import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { CheckFailure, CheckResult } from '@ms/shared';
import { CompositeAuditSink } from '../src/audit/store.js';
import { Reach, Visibility } from '../src/auth/access.js';
import type { Database } from '../src/db/pool.js';
import { FactoryReach, REACHED_MESSAGE, UNREACHED_MESSAGE } from '../src/factory/reach.js';
import { FROZEN_MESSAGE } from '../src/probes/clock-freeze.js';
import { ClockFreezeSync } from '../src/probes/clock-freeze-sync.js';
import { NotStarted } from '../src/probes/not-started.js';
import {
  LOST_MESSAGE,
  PROBE_SOURCE,
  ProbeReachability,
  SILENT_MESSAGE,
} from '../src/probes/reachability.js';
import { ReachabilitySync } from '../src/probes/reachability-sync.js';
import {
  readSensorState,
  writeRuntimes,
  writeStateHistory,
  type HeldWords,
  type HeldWordsLookup,
} from '../src/state/runtime.js';
import type { ReevaluationCause, SensorResult } from '../src/state/service.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { installationVouching } from './support/vouching.js';

const available = await databaseAvailable();

/** Before now, so an acknowledgement, stamped now, sorts after every result. */
const T0 = new Date(Date.now() - 60 * 60_000);
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

/** What a probe that could not start a check says, and where it stopped (`P-265`). */
const GAVE_UP = 'the probe took 10012 ms to start the check and gave up';
const STARTUP: CheckFailure = { phase: 'startup' };
/** What a probe that refused a check says, and where (`A-41c`). */
const REFUSED = 'Not scanned: app.dc.test did not resolve before the check’s timeout.';
const RESOLVE: CheckFailure = { phase: 'resolve', target: 'app.dc.test' };
const EXEC: CheckFailure = { phase: 'exec', target: '192.0.2.43:22' };
/** What a caller re-deciding a sensor says: never what a hold says while it holds (`P-413`). */
const CALLER = 'the words of whoever re-decided it';
/** What a release says, as each hold's owner lets a sensor go in words of its own (`R-11`). */
const RELEASED = 'let go, and until its next result it stands where it stood before';
const NOBODY = 'ticket 4471: the switch is being replaced';
/** An acknowledgement before the one in force, of an outage since recovered (`P-411`). */
const EARLIER = 'ticket 4470: the uplink is being re-patched';
/** What a simulated error says when it is what decides the state (`M-14`). */
const SIMULATION = 'chain test';
/** What a retention anchor says in place of the words of the row it carries (`S-15`). */
const ANCHORED = 'state carried forward past the retention horizon';
/**
 * Minutes after `T0` that sort after an acknowledgement stamped now, with half an hour to spare,
 * so the transitions that follow one are the newest rows (`P-411`).
 */
const AFTER = 90;

const lost = new Map<number, HeldWords>();
const silentProbe = new Map<number, HeldWords>();
const frozen = new Map<number, HeldWords>();
const unreached = new Map<number, HeldWords>();
const unstarted = new Map<number, HeldWords>();
const withheld = new Map<number, HeldWords>();

/** One hold: the set the state service reads it from, and the words its owner publishes. */
interface Hold {
  readonly name: string;
  readonly held: Map<number, HeldWords>;
  readonly words: HeldWords;
  readonly sources: ReevaluationCause['sources'];
}

const LOST_LINK: Hold = {
  name: 'a lost link',
  held: lost,
  words: { message: LOST_MESSAGE, failure: null },
  sources: PROBE_SOURCE,
};

const NOT_STARTED: Hold = {
  name: 'a check not started',
  held: unstarted,
  words: { message: GAVE_UP, failure: STARTUP },
  sources: PROBE_SOURCE,
};

/**
 * The five holds of a sensor for its probe, in the episode index's order, each with the words its
 * owner publishes: `ProbeReachability`'s two reasons, `ClockFreeze`, `FactoryReach`, `NotStarted`.
 */
const HOLDS: readonly Hold[] = [
  LOST_LINK,
  {
    name: 'a silence',
    held: silentProbe,
    words: { message: SILENT_MESSAGE, failure: null },
    sources: PROBE_SOURCE,
  },
  {
    name: 'a frozen clock',
    held: frozen,
    words: { message: FROZEN_MESSAGE, failure: null },
    sources: PROBE_SOURCE,
  },
  {
    name: 'a factory’s unreached inputs',
    held: unreached,
    words: { message: UNREACHED_MESSAGE, failure: null },
    sources: PROBE_SOURCE,
  },
  NOT_STARTED,
];

/** And the hold that is not for the probe, whose words follow the same rule out (`P-411`). */
const WITHHOLDING: Hold = {
  name: 'a withholding',
  held: withheld,
  words: { message: REFUSED, failure: RESOLVE },
  sources: ['access'],
};

/**
 * Whose words a sensor held for its probe says (`P-413`), and what a person's state says once a
 * hold lets go of it (`P-411`), against PostgreSQL. Each hold is laid as its owner lays it — the
 * sensor in the live set, with its words — and re-decided as its owner re-decides it, in the words
 * of a caller that is not the hold, so what the sensor says can only be the hold's.
 */
describe(
  'whose words a held sensor says (P-413, P-411)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let sensorId: number;

    before(async () => {
      scratch = await createScratchDatabase('hold_words');
      db = scratch.db;
      h = await buildHarness(db, {
        states: true,
        lostSensors: () => lost,
        silentSensors: () => silentProbe,
        clockFrozenSensors: () => frozen,
        unreachedFactories: () => unreached,
        notStartedSensors: () => unstarted,
        withheldSensors: () => withheld,
      });
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      for (const one of [lost, silentProbe, frozen, unreached, unstarted, withheld]) one.clear();
      const probe = await h.service.create(testActor, {
        kind: 'probe',
        parentId: h.rootId,
        name: `probe-${String(process.hrtime.bigint())}`,
      });
      const device = await h.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'switch-04',
        host: '192.0.2.43',
      });
      sensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: device.id,
          name: 'Ping',
          sensorType: 'icmp.ping',
        })
      ).id;
    });

    /** Results into states the way ingestion writes them (`M-11`). */
    async function report(results: readonly SensorResult[]): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      const decisions = await states.decide(results);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
      });
    }

    const ok = (minutes: number): SensorResult => ({
      sensorId,
      at: at(minutes),
      outcome: 'ok',
      message: 'load 0.5',
    });
    const failed = (minutes: number, failure?: CheckFailure): SensorResult => ({
      sensorId,
      at: at(minutes),
      outcome: 'error',
      message: `failed at minute ${String(minutes)}`,
      ...(failure === undefined ? {} : { failure }),
    });

    async function redecide(minutes: number, cause: ReevaluationCause): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      await db.tx((q) => states.reevaluate(q, [sensorId], at(minutes), cause));
    }

    /** The hold takes the sensor, and its owner re-decides it. */
    async function arrive(hold: Hold, minutes: number): Promise<void> {
      hold.held.set(sensorId, hold.words);
      await redecide(minutes, {
        message: CALLER,
        ...(hold.sources === undefined ? {} : { sources: hold.sources }),
      });
    }

    /** The hold lets the sensor go, and its owner re-decides it in its release's words. */
    async function leave(hold: Hold, minutes: number): Promise<void> {
      hold.held.delete(sensorId);
      await redecide(minutes, {
        message: RELEASED,
        ...(hold.sources === undefined ? {} : { sources: hold.sources }),
      });
    }

    async function said(): Promise<{
      state: string;
      message: string;
      failure: CheckFailure | null;
    }> {
      const runtime = await readSensorState(db, sensorId);
      assert.ok(runtime !== null);
      return { state: runtime.state, message: runtime.message, failure: runtime.failure };
    }

    async function since(): Promise<number | undefined> {
      return (await readSensorState(db, sensorId))?.since.getTime();
    }

    /** Every transition, oldest first: state, cause, words and where it failed. */
    async function transitions(): Promise<[string, string, string, string | null][]> {
      const rows = await db.query<{
        state: string;
        cause: string;
        message: string;
        failure_phase: string | null;
      }>(
        `SELECT state, cause, message, failure_phase FROM sensor_state
         WHERE sensor_id = $1 ORDER BY time`,
        [sensorId],
      );
      return rows.map((row) => [row.state, row.cause, row.message, row.failure_phase]);
    }

    // ── P-413: every pair of the five, in both orders ────────────────────────────────────────

    for (const [index, higher] of HOLDS.entries()) {
      for (const lower of HOLDS.slice(index + 1)) {
        for (const lowerFirst of [true, false]) {
          const [first, second] = lowerFirst ? [lower, higher] : [higher, lower];
          it(`says ${higher.name}’s words over ${lower.name}’s when ${second.name} comes second, and ${lower.name}’s once ${higher.name} lets go`, async () => {
            await report([ok(0)]);
            await arrive(first, 1);
            assert.deepEqual(
              await said(),
              { state: 'unknown', ...first.words },
              'the hold’s own words, not the caller’s',
            );
            const held = await transitions();
            assert.deepEqual(held.at(-1), [
              'unknown',
              'probe',
              first.words.message,
              first.words.failure?.phase ?? null,
            ]);
            const start = await since();

            // The second hold arrives: the higher one's words, whichever came first, and nothing
            // decided moved.
            await arrive(second, 2);
            assert.deepEqual(await said(), { state: 'unknown', ...higher.words });
            // A result decided while both hold it keeps them. Not what tells `decide`'s lookup
            // from the stored words, which already say them: the single cases and the pairs
            // whose lower hold comes first, below, are.
            await report([failed(3, EXEC)]);
            assert.deepEqual(await said(), { state: 'unknown', ...higher.words });

            // The higher lets go: the lower's words, with no transition.
            await leave(higher, 4);
            assert.deepEqual(await said(), { state: 'unknown', ...lower.words });
            assert.deepEqual(await transitions(), held, 'one hold, one Unknown, whoever says it');
            assert.equal(await since(), start);

            // The last lets go: the release's words, and none of a hold's.
            await leave(lower, 5);
            assert.deepEqual(await said(), {
              state: 'warning',
              message: RELEASED,
              failure: null,
            });
            assert.deepEqual((await transitions()).at(-1), ['warning', 'scan', RELEASED, null]);
          });
        }
      }
    }

    // ── P-413: a result decided before the owner's re-decision lands ─────────────────────────

    // The words `decide` resolves itself: a hold laid in its live set whose owner's re-decision
    // has not committed yet, or was given up (`P-249`), while a result is decided. In the single
    // cases and the pairs whose lower hold comes first the row says something else then, so only
    // a `decide` that looks the hold up says its words; the pairs whose higher hold comes first
    // pin the order.
    for (const hold of HOLDS) {
      it(`says ${hold.name}’s words of a result decided before its owner re-decides the sensor`, async () => {
        await report([ok(0)]);
        hold.held.set(sensorId, hold.words);
        await report([failed(1, EXEC)]);
        assert.deepEqual(await said(), { state: 'unknown', ...hold.words });
        assert.deepEqual((await transitions()).at(-1), [
          'unknown',
          'probe',
          hold.words.message,
          hold.words.failure?.phase ?? null,
        ]);
      });
    }

    for (const [index, higher] of HOLDS.entries()) {
      for (const lower of HOLDS.slice(index + 1)) {
        for (const lowerFirst of [true, false]) {
          const [first, second] = lowerFirst ? [lower, higher] : [higher, lower];
          it(`says ${higher.name}’s words of a result decided after ${second.name} arrives over ${first.name} with no re-decision`, async () => {
            await report([ok(0)]);
            await arrive(first, 1);
            const held = await transitions();
            second.held.set(sensorId, second.words);
            await report([failed(2, EXEC)]);
            assert.deepEqual(await said(), { state: 'unknown', ...higher.words });
            assert.deepEqual(await transitions(), held, 'still one hold, one Unknown');
          });
        }
      }
    }

    // ── P-411: a person's state after each hold ───────────────────────────────────────────────

    async function acknowledge(message: string, minutes?: number): Promise<void> {
      await h.service.acknowledge(
        testActor,
        sensorId,
        minutes === undefined ? { kind: 'indefinite' } : { kind: 'duration', minutes },
        Visibility.EVERYTHING,
        Reach.EVERYTHING,
        message,
      );
    }

    async function simulate(simulated: boolean, minutes: number): Promise<void> {
      const states = h.states;
      assert.ok(states !== undefined);
      await db.tx((q) => states.simulate(q, [sensorId], simulated, SIMULATION, at(minutes)));
    }

    /** Down (Acknowledged) in the person's words, on the row and on its newest transition. */
    async function personal(message: string, why: string): Promise<void> {
      assert.deepEqual(await said(), { state: 'down_acknowledged', message, failure: null }, why);
      assert.deepEqual((await transitions()).at(-1), ['down_acknowledged', 'user', message, null]);
    }

    for (const hold of [...HOLDS, WITHHOLDING]) {
      for (const by of ['its owner’s re-decision', 'the result that follows it'] as const) {
        it(`says the acknowledgement’s words, never ${hold.name}’s, when ${by} lets an acknowledged Down go`, async () => {
          await report([failed(1, EXEC)]);
          await report([failed(2, EXEC)]);
          await acknowledge(NOBODY);
          assert.deepEqual(await said(), {
            state: 'down_acknowledged',
            message: NOBODY,
            failure: null,
          });

          await arrive(hold, AFTER + 1);
          assert.deepEqual(await said(), { state: 'unknown', ...hold.words });

          if (by === 'its owner’s re-decision') {
            await leave(hold, AFTER + 2);
          } else {
            // Let go without a re-decision, as `NotStarted.release` lets go: the result decides.
            hold.held.delete(sensorId);
            await report([failed(AFTER + 2, EXEC)]);
          }
          await personal(NOBODY, 'the person’s words, and nothing of where a check stopped');

          // And the next result keeps them, as it keeps any person's.
          await report([failed(AFTER + 3, EXEC)]);
          await personal(NOBODY, 'kept');
        });
      }
    }

    it('says nothing a hold said when an acknowledgement’s own words are none', async () => {
      await report([failed(1)]);
      await report([failed(2)]);
      await acknowledge('');
      await arrive(NOT_STARTED, AFTER + 1);
      unstarted.delete(sensorId);
      await report([failed(AFTER + 2, EXEC)]);
      await personal('', 'none of the hold’s');
    });

    it('says the acknowledgement’s words when the result that lets a hold go finds it lapsed', async () => {
      await report([failed(1, EXEC)]);
      await report([failed(2, EXEC)]);
      await acknowledge(NOBODY, 5);
      await arrive(NOT_STARTED, 3);
      assert.deepEqual(await said(), { state: 'unknown', ...NOT_STARTED.words });

      // An hour after the acknowledgement by the result's clock (§2.4), so it lapses as this
      // result lets the hold go: the Down its lapse leaves, which says what a lapse says.
      unstarted.delete(sensorId);
      await report([failed(120, EXEC)]);
      assert.deepEqual(
        await said(),
        { state: 'down', message: NOBODY, failure: null },
        'the person’s words, as a lapse that no hold had taken says them',
      );
      assert.deepEqual((await transitions()).at(-1), ['down', 'user', NOBODY, null]);
    });

    // A simulated error over a held sensor decides it before the hold does (layer 2 above layer
    // 3), and an acknowledgement makes that Down (Acknowledged): a person's state, out of a hold.
    for (const hold of [LOST_LINK, WITHHOLDING]) {
      it(`says the acknowledgement’s words when a simulated error takes an acknowledged Down out of ${hold.name}, and when it lets go`, async () => {
        await report([failed(1, EXEC)]);
        await report([failed(2, EXEC)]);
        await acknowledge(NOBODY);
        await arrive(hold, AFTER + 1);

        await simulate(true, AFTER + 2);
        await personal(NOBODY, 'the person’s words, not none and not the simulation’s');
        await simulate(false, AFTER + 3);
        assert.deepEqual(await said(), { state: 'unknown', ...hold.words }, 'held again');
        await leave(hold, AFTER + 4);
        await personal(NOBODY, 'and the same once it lets go');
      });
    }

    // The words of the acknowledgement in force, whatever the history holds.
    for (const again of ['after a recovery', 'over the first, in new words'] as const) {
      it(`says the acknowledgement in force when a hold lets it go, one made ${again}`, async () => {
        await report([failed(1, EXEC)]);
        await report([failed(2, EXEC)]);
        await acknowledge(EARLIER);
        if (again === 'after a recovery') {
          await report([ok(3)]);
          assert.equal((await said()).state, 'up', 'the recovery cleared the first');
          await report([failed(4, EXEC)]);
          await report([failed(5, EXEC)]);
        }
        await acknowledge(NOBODY);
        await arrive(NOT_STARTED, AFTER + 1);
        await leave(NOT_STARTED, AFTER + 2);
        await personal(NOBODY, 'the newer acknowledgement’s words');
      });
    }

    it('says the acknowledgement in force when it was made over a hold not yet re-decided', async () => {
      await report([failed(1, EXEC)]);
      await report([failed(2, EXEC)]);
      await acknowledge(EARLIER);
      await report([ok(3)]);
      await report([failed(4, EXEC)]);
      await report([failed(5, EXEC)]);

      // The lost link is laid and its re-decision has not run: the row still says Down, so the
      // acknowledgement is accepted, and it decides Unknown — no transition of its own.
      lost.set(sensorId, LOST_LINK.words);
      await acknowledge(NOBODY);
      assert.deepEqual(await said(), { state: 'unknown', ...LOST_LINK.words });
      await redecide(AFTER + 1, { message: CALLER, sources: PROBE_SOURCE });
      await leave(LOST_LINK, AFTER + 2);
      await personal(NOBODY, 'never the recovered outage’s acknowledgement');
    });

    for (const [what, previous, message, carried] of [
      ['a release before P-411 wrote', 'unknown', GAVE_UP, false],
      ['a retention anchor carries', 'down_acknowledged', ANCHORED, true],
    ] as const) {
      it(`says the acknowledgement’s words, not what ${what}, when a hold lets it go`, async () => {
        await report([failed(1, EXEC)]);
        await report([failed(2, EXEC)]);
        await acknowledge(NOBODY);
        await db.query(
          `INSERT INTO sensor_state (time, sensor_id, state, previous_state, cause, message, carried)
           VALUES ($1, $2, 'down_acknowledged', $3, 'user', $4, $5)`,
          [at(AFTER), sensorId, previous, message, carried],
        );
        await arrive(NOT_STARTED, AFTER + 1);
        await leave(NOT_STARTED, AFTER + 2);
        await personal(NOBODY, 'the history is not where they are kept');
      });
    }
  },
);

/**
 * The same, through the holds' own owners (`P-413`): a check not started that a lost link or a
 * silence then holds, which the same-state branch has to reword, a sensor `NotStarted.resync`
 * frees onto a lost probe, and a factory the probe set lets go.
 */
describe(
  'whose words a held sensor says, through the holds themselves (P-413)',
  { skip: available ? false : 'no PostgreSQL reachable (start docker-compose.dev.yml)' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let h: Harness;
    let reachability: ProbeReachability | undefined;
    let notStarted: NotStarted | undefined;
    let reach: FactoryReach | undefined;
    let probeId: number;
    let deviceId: number;
    let sensorId: number;
    const NONE: HeldWordsLookup = new Map();

    before(async () => {
      scratch = await createScratchDatabase('hold_words_owners');
      db = scratch.db;
      h = await buildHarness(db, {
        states: true,
        lostSensors: () => reachability?.heldWords('link') ?? NONE,
        silentSensors: () => reachability?.heldWords('silence') ?? NONE,
        unreachedFactories: () => reach?.heldWords() ?? NONE,
        notStartedSensors: () => notStarted?.heldWords() ?? NONE,
      });
    });

    after(async () => {
      await scratch.drop();
    });

    beforeEach(async () => {
      const states = h.states;
      const dependencies = h.dependencies;
      assert.ok(states !== undefined && dependencies !== undefined);
      reachability = new ProbeReachability({ db, logger: silent, states, dependencies });
      notStarted = new NotStarted({ db, logger: silent, states, dependencies });
      reach = new FactoryReach();
      probeId = (
        await h.service.create(testActor, {
          kind: 'probe',
          parentId: h.rootId,
          name: `probe-${String(process.hrtime.bigint())}`,
        })
      ).id;
      deviceId = (
        await h.service.create(testActor, {
          kind: 'device',
          parentId: probeId,
          name: 'app-server',
          host: '192.0.2.44',
        })
      ).id;
      sensorId = (
        await h.service.create(testActor, {
          kind: 'sensor',
          parentId: deviceId,
          name: 'Script',
          sensorType: 'icmp.ping',
        })
      ).id;
      const decisions = await states.decide([
        { sensorId, at: at(0), outcome: 'ok', message: '4/4 replies' },
      ]);
      await db.tx(async (q) => {
        await writeStateHistory(q, decisions.transitions);
        await writeRuntimes(q, decisions.runtimes);
      });
    });

    const couldNotStart = (minutes: number): CheckResult => ({
      sensorId,
      at: at(minutes).toISOString(),
      outcome: 'error',
      message: GAVE_UP,
      durationMs: 10_012,
      channels: [],
      notStarted: true,
      failure: STARTUP,
    });

    async function said(): Promise<{
      state: string;
      message: string;
      failure: CheckFailure | null;
    }> {
      const runtime = await readSensorState(db, sensorId);
      assert.ok(runtime !== null);
      return { state: runtime.state, message: runtime.message, failure: runtime.failure };
    }

    async function transitions(): Promise<number> {
      const rows = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM sensor_state WHERE sensor_id = $1',
        [sensorId],
      );
      return Number(rows[0]?.n);
    }

    for (const reason of ['link', 'silence'] as const) {
      const words = reason === 'link' ? LOST_MESSAGE : SILENT_MESSAGE;
      it(`rewords a check not started when its probe’s ${reason} holds it too, and gives the check’s words back when that ends`, async () => {
        assert.ok(reachability !== undefined && notStarted !== undefined);
        await notStarted.hold(probeId, [couldNotStart(1)]);
        assert.deepEqual(await said(), { state: 'unknown', message: GAVE_UP, failure: STARTUP });
        const held = await transitions();

        // Already Unknown for its probe: the same-state branch, which kept the check's words.
        await reachability.lost(probeId, reason);
        assert.deepEqual(await said(), { state: 'unknown', message: words, failure: null });

        if (reason === 'link') await reachability.found(probeId);
        else await reachability.resumed(probeId);
        assert.deepEqual(await said(), { state: 'unknown', message: GAVE_UP, failure: STARTUP });
        assert.equal(await transitions(), held, 'no transition either way');
      });
    }

    it('says the lost probe’s words of a sensor a move frees from a check not started onto it', async () => {
      assert.ok(reachability !== undefined && notStarted !== undefined);
      const away = (
        await h.service.create(testActor, {
          kind: 'probe',
          parentId: h.rootId,
          name: `away-${String(process.hrtime.bigint())}`,
        })
      ).id;
      await reachability.lost(away, 'link');
      await notStarted.hold(probeId, [couldNotStart(1)]);
      const held = await transitions();

      const reachabilitySync = new ReachabilitySync({
        reachability: () => reachability,
        logger: silent,
      });
      const notStartedSync = new ClockFreezeSync({
        clockFreeze: () => undefined,
        notStarted: () => notStarted,
      });
      // In `main.ts`'s order: the lost probe takes it before the probe that could not start it
      // lets it go, so it never reads its last reading in between.
      h.audit.also = new CompositeAuditSink([reachabilitySync, notStartedSync]);
      try {
        await h.service.move(testActor, deviceId, away, { kind: 'none' });
      } finally {
        h.audit.also = undefined;
      }
      assert.equal(notStarted.heldSensors().has(sensorId), false, 'let go by its old probe');
      assert.equal(reachability.unreachableSensors().has(sensorId), true, 'held by its new');
      assert.deepEqual(await said(), { state: 'unknown', message: LOST_MESSAGE, failure: null });
      assert.equal(await transitions(), held);

      // And its new probe's return leaves no hold's words at all.
      await reachability.found(away);
      const back = await said();
      assert.equal(back.state, 'up');
      assert.ok(![GAVE_UP, LOST_MESSAGE].includes(back.message), back.message);
    });

    // A move between two held probes keeps the sensor held, so nothing crosses the boundary
    // `resync` re-decides; but a lost link's words are not a silent probe's.
    for (const [from, to] of [
      ['link', 'silence'],
      ['silence', 'link'],
    ] as const) {
      it(`rewords a sensor a move takes from a probe held for its ${from} to one held for its ${to}`, async () => {
        assert.ok(reachability !== undefined);
        const words = { link: LOST_MESSAGE, silence: SILENT_MESSAGE };
        const away = (
          await h.service.create(testActor, {
            kind: 'probe',
            parentId: h.rootId,
            name: `away-${String(process.hrtime.bigint())}`,
          })
        ).id;
        await reachability.lost(probeId, from);
        await reachability.lost(away, to);
        assert.deepEqual(await said(), { state: 'unknown', message: words[from], failure: null });
        const held = await transitions();
        const start = (await readSensorState(db, sensorId))?.since.getTime();

        h.audit.also = new ReachabilitySync({
          reachability: () => reachability,
          logger: silent,
        });
        try {
          await h.service.move(testActor, deviceId, away, { kind: 'none' });
        } finally {
          h.audit.also = undefined;
        }
        assert.deepEqual(await said(), { state: 'unknown', message: words[to], failure: null });
        assert.equal(await transitions(), held, 'still held: no transition');
        assert.equal((await readSensorState(db, sensorId))?.since.getTime(), start);
      });
    }

    it('lets a factory go in words of its own, never the hold’s', async () => {
      const states = h.states;
      const dependencies = h.dependencies;
      assert.ok(states !== undefined && dependencies !== undefined && reach !== undefined);
      const vouching = installationVouching({ db, states, dependencies });
      await vouching.settleTogether(new Map(), reach.stage(new Map([[sensorId, [sensorId + 1]]])));
      assert.deepEqual(await said(), {
        state: 'unknown',
        message: UNREACHED_MESSAGE,
        failure: null,
      });
      await vouching.settleTogether(new Map(), reach.stage(new Map()));
      assert.deepEqual(await said(), { state: 'up', message: REACHED_MESSAGE, failure: null });
    });
  },
);
