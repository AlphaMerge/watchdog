/**
 * What turns check results into sensor states (`M-02`).
 *
 * `IngestionService` reads the readings out of a batch; this reads the *outcome* out of the
 * same batch and decides what it means. The division is `WORKFLOW.MD` §4: the probe reports
 * what happened to the check, the core decides whether that is Up, Warning or Down, because
 * limits, lookups, pauses and acknowledgements are the core's configuration and a probe knows
 * none of them.
 *
 * The cache is what makes it affordable at the v1 target of 5,000 sensors: after the first
 * result from a sensor, deciding its state is a map lookup and some arithmetic, and a scan
 * interval issues no state queries at all.
 */

import type { CheckFailure, Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import type { ActorKind } from '../objects/audit.js';
import { SCAN_RETRY_WARNINGS } from '../settings/registry.js';
import {
  applyResult,
  clearedByRecovery,
  clearedByResume,
  evaluate,
  isPaused,
  isStaleResult,
  operatorDecided,
  readingMessage,
  leftToHold,
  DEFAULT_FAILURE_POLICY,
  type Decision,
  type FailurePolicy,
  type SensorFacts,
} from './machine.js';
import type { ChannelOutcome } from './limits.js';
import { canAcknowledge, type ResolvedAcknowledgement } from './acknowledgement.js';
import {
  loadRuntimes,
  lockRuntimeStates,
  lockRuntimes,
  writeAcknowledgements,
  writeSimulatedErrors,
  writeStateChanges,
  writeStateHistory,
  sameFailure,
  type HeldWords,
  type HeldWordsLookup,
  type RuntimeWrite,
  type SensorRuntime,
  type StateDecisions,
  type StateRewrite,
  type StateTransition,
} from './runtime.js';
import type { CommittedStates } from './runtime.js';
import type { SensorStateCause } from './tables.js';

/** One result, as much of it as the state machine reads. */
export interface SensorResult {
  readonly sensorId: number;
  readonly at: Date;
  readonly outcome: 'ok' | 'error';
  /** The probe's message: what the check itself had to say. */
  readonly message: string;
  /**
   * Where the check failed, as the probe named it (`P-285`): absent from a probe below 35, from a
   * check that threw a plain error, and from every success. Kept beside `message` when the
   * message is the scan's own; it never decides anything.
   */
  readonly failure?: CheckFailure;
  /**
   * What this result's readings were worth (`M-04`), or `null` when there were none to judge.
   *
   * Carries the verdict the layered model combines *and* the message it implies, because the
   * two are decided together: "Response time is 812 ms, above the error limit of 500 ms" is the
   * whole reason the sensor is Down, and recording the probe's "ok" beside it would be a
   * history that explains nothing.
   */
  readonly channels?: ChannelOutcome | null;
}

/** Why `reevaluate` is re-deciding, and the words it may speak for (`M-08`, `P-94`). */
export interface ReevaluationCause {
  readonly message: string;
  readonly sources?: readonly SensorStateCause[];
  /**
   * Where the check `message` comes from stopped, when the words are a held result's (`P-407`,
   * `P-265`). Stored beside them only when they are what is said: the caller speaks for the
   * decided cause and no withholding's words take their place.
   */
  readonly failure?: CheckFailure | null;
}

/**
 * Just enough of `InheritanceResolver` to resolve one key for a batch of sensors.
 *
 * Narrow on purpose: this module has no business knowing what else inheritance can do, and a
 * test can satisfy this with four lines instead of a tree.
 */
export interface PolicySource {
  resolveForObjects(
    objectIds: readonly number[],
    key: string,
  ): Promise<Map<number, { value: unknown }>>;
}

/**
 * Just enough of `PauseRepository` to say why a sensor is paused (`P-94`).
 *
 * Narrow for the same reason as `PolicySource`: the state machine has no business knowing how
 * pauses are stored, only that something can answer "what did the operator write".
 */
export interface PauseMessages {
  messagesFor(q: Queryable, sensorIds: readonly number[], now: Date): Promise<Map<number, string>>;
}

/**
 * Just enough of `AlarmEngine` to reconcile a batch of sensors (`N-02`).
 *
 * Narrow on purpose, like `PolicySource` above: this module has no business knowing what a
 * notification is. It knows that something wants to look at the sensors it just moved.
 */
export interface AlarmReactor {
  react(q: Queryable, sensorIds: readonly number[], now: Date): Promise<unknown>;
}

export interface SensorStateServiceOptions {
  db: Database;
  logger: Logger;
  /**
   * Where the per-sensor failure policy comes from (`M-03`).
   *
   * Absent applies `policy` to every sensor, which is what a unit test wants and no running
   * system does — `main.ts` passes the inheritance resolver.
   */
  settings?: PolicySource;
  /**
   * Where an operator's pause message comes from (`P-94`), and **required** (`P-111`).
   *
   * Optional was the wrong shape. Deleting the one line in `main()` that passes it compiled, ran,
   * and left all 2,118 core tests green — because `buildHarness` constructs its own service and
   * passes its own, so every test that exercises the fix proves the *mechanism* and none of them
   * proves `main()` wires it. A caller with no pause store can pass one that answers nothing; the
   * point is that it has to decide.
   */
  pauses: PauseMessages;
  /** The policy for a sensor with no resolver. Also the registry default's shape. */
  policy?: FailurePolicy;
  /** Sensors held in memory. The v1 target is 5,000, so the default holds every one of them. */
  maxCached?: number;
  /**
   * What reconciles notification alarms against the states this service decides (`N-02`).
   *
   * `reevaluate` is the choke point for every state change that is *not* a check result — a
   * pause, a resume, an acknowledgement, a dependency, a schedule window. The result path is
   * covered by the `Ingestor`, which reacts after the dependency reaction so an alarm is never
   * armed for a sensor the same transaction is about to pause.
   */
  alarms?: AlarmReactor;
  /** Told which state changes committed, so `U-02` can push them. */
  onStatesCommitted?: CommittedStates;
  /**
   * The sensors whose probe's link has gone (`R-05`), each with what it says while held: the
   * first of the five holds of a sensor for its probe, whose words stand over the others' (`P-413`).
   *
   * A live set rather than a stored column, and read on every load rather than at one call
   * site: `probeReachable` is a fact about a TCP connection, and a sensor whose probe is gone
   * must read as Unknown however its state came to be re-decided — a pause clearing, a
   * dependency releasing, a schedule window opening. Consulting it in one place is what stops a
   * later re-evaluation from quietly flipping a sensor back to Up while its probe is still
   * missing.
   *
   * **Each hold's words come with it, and are said by whoever re-decides the sensor** (`P-413`),
   * as a withheld sensor's are (`M-28`). The five lay the same `probeReachable: false` and decide
   * the same Unknown/probe, so moving between them is never a transition, and each used to write
   * its words once, on the re-decision that held the sensor: a hold that arrived over another's
   * kept the first one's words, and one that let go left its words on a sensor another still
   * held. Now the sensor says the first hold in this order that holds it — a lost link, a silence,
   * a frozen clock, a factory's unreached inputs, a check its probe could not start, the episode
   * index's — and is reworded, with no transition, whenever that changes.
   *
   * Absent means every probe is reachable, which is what a unit test wants and what a core
   * without a probe endpoint would honestly report.
   */
  lostSensors?: () => HeldWordsLookup;
  /**
   * The sensors whose probe is connected and has stopped sending results (`P-74`), each with its
   * words: the second of the five (`P-413`). Laid over the facts as `lostSensors` is.
   */
  silentSensors?: () => HeldWordsLookup;
  /**
   * The sensors whose probe's clock reads earlier than their last result (`P-232`), which can
   * accept nothing it sends, each with its words: the third of the five (`P-413`). Laid over the
   * facts exactly as `lostSensors` is — the same fact, so the same state, cause and alarms —
   * because it is the same answer: nothing the probe says about them can be used.
   *
   * Absent means no probe's clock has stepped back.
   */
  clockFrozenSensors?: () => HeldWordsLookup;
  /**
   * The Sensor Factories whose every channel reads a sensor on a lost or frozen probe (`M-26`),
   * each with its words: the fourth of the five (`P-413`). Laid over the facts as `lostSensors`
   * is, because it is the same answer one step further on: nothing they are built on is being
   * measured.
   *
   * Absent means no factory is held for its inputs' probe.
   */
  unreachedFactories?: () => HeldWordsLookup;
  /**
   * The sensors whose last check their probe could not start (`P-265`), the last of the five
   * (`P-413`). Laid over the facts as `lostSensors` is, because it is the same answer: the probe
   * is at fault, and nothing about the device is known.
   *
   * With what each check said and where it stopped (`P-410`): the one probe hold whose words
   * change while it stands, since each round names its own start-up time and output.
   *
   * Absent means every probe starts its checks.
   */
  notStartedSensors?: () => HeldWordsLookup;
  /**
   * The sensors the core has stopped evaluating, each with the sentence that says why (`A-29`)
   * and, when that sentence is a probe's refusal (`A-41c`), where the probe stopped (`P-407`):
   * both from one owner, so they cannot disagree.
   *
   * Live for `lostSensors`' reason, and laid over the facts at the same point: a sensor
   * whose voucher may no longer read what it names must read Unknown however its state comes to
   * be re-decided, and the sentence has to come with it, because it is also the fix.
   *
   * Absent means every voucher holds.
   */
  withheldSensors?: () => ReadonlyMap<number, HeldWords>;
}

export interface StateStats {
  /** Results that moved a sensor's machine. */
  resultsApplied: number;
  /**
   * Results no older sensor state could be moved by — a duplicate after a lost acknowledgement,
   * or a spool arriving behind a live result. Normal on replay, and never silent.
   */
  resultsStale: number;
  /** Results for sensors that no longer exist. */
  resultsUnknownSensor: number;
  /** State changes recorded. This is what uptime is computed from. */
  transitions: number;
  /** Transitions caused by something other than a result — a pause, a resume (`M-08`). */
  reevaluations: number;
  cachedSensors: number;
  /** Failure policies resolved and held. Dropped whenever a setting or the tree moves. */
  cachedPolicies: number;
}

const DEFAULT_MAX_CACHED = 20_000;

/**
 * What a sensor let go from `unknown`/`access` says until its next result (`A-78`): vouched for
 * again, or its credentials sent again, or a factory's voucher able to read again. Its state is
 * the one its facts decide, which is where it stood before it was withheld, and nothing has
 * measured it since: without these words it read Up, or Down, with no message at all.
 */
export const RELEASED_FROM_WITHHOLDING =
  'No longer withheld. Until its next result it stands where it stood before it was withheld.';

/**
 * What a sensor leaving a hold for the state its facts decide says until its next result
 * (`A-78`, `R-11`), and '' when it leaves anything else.
 *
 * - **`access`**: `RELEASED_FROM_WITHHOLDING`, whoever re-decided it. The words of a hold are the
 *   voucher check's or the probe's refusal, and it lets go with none of its own, and with
 *   nothing of where a refused check stopped (`P-407`).
 * - **`probe`**: the words of the caller that let it go, when that caller says it speaks for the
 *   probe (`sources` naming it): the probe answering again, a sensor moved to another probe, the
 *   probe's clock passing the sensor's last result. Any other caller's words are about something
 *   else, and nothing is said rather than the wrong thing. Before `R-11` those words were passed
 *   and dropped.
 */
function releasedMessage(
  from: SensorStateCause,
  cause: { message: string; sources?: readonly SensorStateCause[] },
): string {
  if (from === 'access') return RELEASED_FROM_WITHHOLDING;
  if (from === 'probe' && cause.sources?.includes('probe') === true) return cause.message;
  return '';
}

export class SensorStateService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #settings: PolicySource | undefined;
  readonly #pauses: PauseMessages;
  readonly #fallback: FailurePolicy;
  readonly #maxCached: number;
  readonly #alarms: AlarmReactor | undefined;
  readonly #onStatesCommitted: CommittedStates | undefined;
  /**
   * The five holds of a sensor for its probe, in the order their words stand (`P-413`): a lost
   * link, a silence, a frozen clock, a factory's unreached inputs and a check its probe could not
   * start. The one place that order is kept.
   */
  readonly #probeHolds: readonly (() => HeldWordsLookup)[];
  readonly #withheldSensors: (() => ReadonlyMap<number, HeldWords>) | undefined;
  /**
   * What each sensor's row says, as the last decision left it: never the live facts, which
   * `decide` lays over it as it decides (`P-412`).
   */
  readonly #cache = new Map<number, SensorRuntime>();
  /**
   * The effective failure policy per sensor.
   *
   * Kept apart from the runtime cache rather than folded into it, because the two are different
   * kinds of thing with different invalidation. The runtime is a write-through cache of a table
   * this service owns; the policy is a read-through cache of configuration anyone can change
   * from anywhere in the tree. Conflating them would mean an edit to a group's settings forced a
   * re-read of state that edit did not touch — and would make the write-failure rewind drop
   * policies for no reason at all.
   */
  readonly #policies = new Map<number, FailurePolicy>();
  /**
   * Counts the times `#policies` was emptied, so a resolve that one overtook is used for its own
   * batch and not cached (`P-240`). The second forget runs after the edit or the move commits,
   * and a resolve that began before it read the old setting.
   */
  #policyGeneration = 0;

  #resultsApplied = 0;
  #resultsStale = 0;
  #resultsUnknownSensor = 0;
  #transitions = 0;
  #reevaluations = 0;

  constructor(options: SensorStateServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'state' });
    this.#settings = options.settings;
    this.#pauses = options.pauses;
    this.#fallback = options.policy ?? DEFAULT_FAILURE_POLICY;
    this.#maxCached = options.maxCached ?? DEFAULT_MAX_CACHED;
    this.#alarms = options.alarms;
    this.#onStatesCommitted = options.onStatesCommitted;
    this.#probeHolds = [
      options.lostSensors,
      options.silentSensors,
      options.clockFrozenSensors,
      options.unreachedFactories,
      options.notStartedSensors,
    ].filter((hold): hold is () => HeldWordsLookup => hold !== undefined);
    this.#withheldSensors = options.withheldSensors;
  }

  stats(): StateStats {
    return {
      resultsApplied: this.#resultsApplied,
      resultsStale: this.#resultsStale,
      resultsUnknownSensor: this.#resultsUnknownSensor,
      transitions: this.#transitions,
      reevaluations: this.#reevaluations,
      cachedSensors: this.#cache.size,
      cachedPolicies: this.#policies.size,
    };
  }

  /** For tests, and for whatever invalidates a sensor's configuration in a later phase. */
  clear(): void {
    this.#cache.clear();
    this.#policyGeneration += 1;
    this.#policies.clear();
  }

  /**
   * Forgets every resolved failure policy (`M-03`).
   *
   * Everything, not the objects that changed: `scan.retryWarnings` is inheritable, so setting it
   * on a group changes it for every sensor beneath, and moving a subtree changes it for every
   * sensor inside. Working out which sensors those are means walking the tree inside the
   * mutation's transaction; re-resolving them means **one** query for the whole next batch,
   * because `resolveForObjects` answers for a set. The precise version would cost more than the
   * imprecise one.
   */
  forgetPolicies(): void {
    this.#policyGeneration += 1;
    this.#policies.clear();
  }

  /**
   * Drops what is cached about these sensors (`A-41c`), so their next result is decided from the
   * stored row. Since `P-412` nothing cached carries a hold — the live facts are laid on as each
   * batch is decided — so a release is decided against the facts as they are without it; the
   * callers that let a hold go keep it as a re-read of the row.
   */
  forgetSensors(sensorIds: readonly number[]): void {
    for (const sensorId of sensorIds) this.#cache.delete(sensorId);
  }

  /**
   * The sensors among these result writes whose rows a probe's hold has reached since they were
   * decided (`P-415`), and what is cached of them dropped.
   *
   * Asked inside the write's transaction, before its history. Only a write a probe's hold holds
   * now can be named, so only its row is read, and locked (`lockRuntimeStates`): a hold whose
   * re-decision has committed is on the row, and one that has not waits for the write and decides
   * from what it leaves (`P-414`). Nothing held, the normal state of an installation, locks and
   * names nothing, so the write takes its rows as it always has. What this names keeps the row's
   * state and words; the cache holds the batch's state, which the row will not, so its entry
   * goes.
   *
   * `changing` is the sensors the write's transitions move, whose rows its history takes anyway.
   * Those no hold holds are taken first: a release has let go of a master before it locks it,
   * and its dependency recompute then writes the dependents, so a held dependent's row taken
   * ahead of the master waited on the release while the release waited on it. The held rows
   * asked about go after them, together and in id order, as the hold's own re-decision takes
   * them (`lockRuntimes`): a moved one taken ahead of a steady one the hold holds crossed the
   * hold.
   */
  async overtaken(
    q: Queryable,
    writes: readonly RuntimeWrite[],
    changing: readonly number[],
  ): Promise<ReadonlySet<number>> {
    const heldOf = this.#heldFacts();
    if (heldOf === undefined) return NOTHING_OVERTAKEN;
    // Held now, and decided otherwise: what `leftToHold` can name, whatever the row says.
    const asked = writes.filter(
      (write) =>
        !heldOf(write.sensorId).probeReachable &&
        !(write.state === 'unknown' && write.cause === 'probe'),
    );
    if (asked.length === 0) return NOTHING_OVERTAKEN;
    const held = (sensorId: number): boolean => !heldOf(sensorId).probeReachable;
    await lockRuntimeStates(
      q,
      changing.filter((sensorId) => !held(sensorId)),
    );
    const rows = await lockRuntimeStates(
      q,
      asked.map((write) => write.sensorId),
    );
    const behind = new Set<number>();
    for (const write of asked) {
      const row = rows.get(write.sensorId);
      if (row !== undefined && leftToHold(write, row)) behind.add(write.sensorId);
    }
    for (const sensorId of behind) this.#cache.delete(sensorId);
    return behind;
  }

  /** The current state of a sensor as far as this process knows. Undefined if never seen. */
  peek(sensorId: number): SensorRuntime | undefined {
    return this.#cache.get(sensorId);
  }

  /**
   * Decides what a batch of results means, and advances the cache to match.
   *
   * The cache moves here rather than after the write commits, because a second batch may be
   * decided before the first has landed and it must see the first one's failures. The write
   * failing is handled the other way round — see {@link forget}, which drops the affected
   * sensors so the next batch re-reads the last committed truth instead of trusting a cache
   * that ran ahead of the database.
   */
  async decide(results: readonly SensorResult[]): Promise<StateDecisions> {
    if (results.length === 0) return { transitions: [], runtimes: [] };

    const bySensor = new Map<number, SensorResult[]>();
    for (const result of results) {
      const existing = bySensor.get(result.sensorId);
      if (existing === undefined) bySensor.set(result.sensorId, [result]);
      else existing.push(result);
    }

    const resolved = await this.#warm([...bySensor.keys()]);
    // **The live facts are laid over what is cached as the batch is decided, never cached with
    // it** (`P-412`). A load that straddled a release, a read that straddled a rollback (`P-253`)
    // and a result decided while the sensor was held (`P-409`) each cached the overlay of their
    // moment, and every result after it was decided from that, Unknown for a probe that was
    // running it, until something dropped the entry.
    const cached = new Map<number, SensorRuntime>();
    for (const sensorId of bySensor.keys()) {
      const one = this.#cache.get(sensorId);
      if (one !== undefined) cached.set(sensorId, one);
    }
    const live = this.#withLiveFacts(cached);

    const transitions: StateTransition[] = [];
    const runtimes: RuntimeWrite[] = [];

    for (const [sensorId, batch] of bySensor) {
      const known = live.get(sensorId);
      if (known === undefined) {
        // Not a sensor any more, or never was. Counted, never silently ignored.
        this.#resultsUnknownSensor += batch.length;
        continue;
      }
      let runtime: SensorRuntime = known;

      // A probe may batch several intervals together, and a spool replays whatever order it
      // was written in. The machine is a fold over time, so it has to see them in time order.
      batch.sort((a, b) => a.at.getTime() - b.at.getTime());

      let moved = false;
      for (const result of batch) {
        // Strictly newer, so a duplicate delivery is a no-op rather than a second failure. The
        // acknowledgement protocol is at-least-once by design; this is what makes that safe.
        if (isStaleResult(runtime.facts, result.at)) {
          this.#resultsStale += 1;
          continue;
        }

        const applied = applyResult(
          runtime.facts,
          {
            at: result.at,
            outcome: result.outcome,
            message: result.message,
            channel: result.channels?.verdict ?? null,
          },
          resolved.get(sensorId) ?? this.#policies.get(sensorId) ?? this.#fallback,
        );
        this.#resultsApplied += 1;
        moved = true;

        // Whichever side produced the state gets to explain it. The cause names that side, so
        // there is one source of truth rather than a second rule that can disagree with it.
        //
        // **Including when that side is a person.** A forced or acknowledged sensor keeps being
        // scanned — the force changes what its readings *mean*, not whether it takes any — and
        // the check that runs a second later still reports "2/2 replies". Letting that overwrite
        // the message left a sensor reading "Down — 2/2 replies, min 0.072 ms", which is a row
        // an operator cannot make sense of and which `U-06` puts on the home screen. The rule is
        // `operatorDecided`, the same one `reevaluate` uses; the difference is that there are no
        // fresh operator words here, so what is already stored is what stays.
        const held = operatorDecided(applied.decision)
          ? this.#heldWords(sensorId, applied.decision)
          : undefined;
        const message = operatorDecided(applied.decision)
          ? (held?.message ?? runtime.message)
          : applied.decision.cause === 'limit' || applied.decision.cause === 'lookup'
            ? readingMessage(result.channels?.message ?? '', result.message)
            : result.message;
        // **Where it failed goes with the words, by the same rule** (`P-285`): the check's own
        // when it failed, what is stored when a person's or a hold's words explain the state,
        // and the withholding's own beside its words — a probe's refusal names where it stopped
        // and a sentence of the core's names nothing (`P-407`). Nothing beside a limit's or a
        // lookup's either: those judge readings, which only a success has. Never a cause, so a
        // phase that moves while the state and the cause do not records no transition.
        const failure = operatorDecided(applied.decision)
          ? held === undefined
            ? runtime.failure
            : held.failure
          : result.outcome === 'error'
            ? (result.failure ?? null)
            : null;

        const changed =
          applied.decision.state !== runtime.state || applied.decision.cause !== runtime.cause;
        if (changed) {
          transitions.push({
            sensorId,
            at: result.at,
            state: applied.decision.state,
            previousState: runtime.state,
            cause: applied.decision.cause,
            message,
            failure,
          });
        }

        runtime = {
          sensorId,
          state: applied.decision.state,
          cause: applied.decision.cause,
          message,
          failure,
          // The clock on "Down for 2h 15m" starts when the state did, and does not restart
          // because the sensor failed again in the same way.
          since: changed ? result.at : runtime.since,
          facts: applied.facts,
        };
      }

      if (!moved) continue;
      this.#remember(sensorId, asStored(runtime));
      runtimes.push({
        sensorId,
        at: runtime.facts.lastResultAt ?? runtime.since,
        state: runtime.state,
        cause: runtime.cause,
        message: runtime.message,
        failure: runtime.failure,
        since: runtime.since,
        consecutiveFailures:
          runtime.facts.scan.kind === 'failed' ? runtime.facts.scan.consecutiveFailures : 0,
        // Carried to the row rather than left in the cache: the machine clears an
        // acknowledgement on recovery and on expiry, and a clearing that only ever happened in
        // memory would come back the moment the cache went cold (`M-13`).
        acknowledged: runtime.facts.acknowledged,
        // Likewise (`P-85`): §2.2's answer decides the state, so a state that outlives the
        // process needs the answer that decided it to outlive it too.
        channel: runtime.facts.channel,
      });
    }

    this.#transitions += transitions.length;
    if (transitions.length > 0) {
      for (const transition of transitions) {
        this.#logger.info(
          {
            sensorId: transition.sensorId,
            from: transition.previousState,
            to: transition.state,
            cause: transition.cause,
            at: transition.at.toISOString(),
            message: transition.message,
          },
          `sensor ${String(transition.sensorId)} is ${transition.state}`,
        );
      }
    }

    return { transitions, runtimes };
  }

  /**
   * Re-decides a set of sensors without a result, and writes what changed (`M-08`).
   *
   * A pause is the reason this exists. `M-03` could defer immediate effect to the next scan
   * because a failure policy is a rule *about results*, so the next result applies it. A pause is
   * not: an operator who pauses a device during maintenance means now, and a sensor that alarmed
   * thirty seconds into a planned outage is the exact failure pausing exists to prevent.
   *
   * **Writes inside the caller's transaction**, unlike every other path here, which hands rows to
   * the `Ingestor` to write with the readings. There are no readings to ride along with — and the
   * flags this reads were set by the same transaction, so the state change and the pause that
   * caused it commit together or not at all.
   *
   * `sensorIds` is what `PauseRepository.recompute` returned: the sensors whose flags actually
   * moved. Pausing a group of 4,000 healthy sensors and one already-paused sensor writes 4,000
   * transitions, not 4,001.
   */
  async reevaluate(
    q: Queryable,
    sensorIds: readonly number[],
    at: Date,
    cause: ReevaluationCause,
  ): Promise<number> {
    if (sensorIds.length === 0) return 0;

    // Read through the caller's transaction, never the cache: the flags were written moments
    // ago in this same transaction, and a cache populated before them is exactly wrong.
    const first = await this.#redecide(q, await loadRuntimes(q, sensorIds), at, cause);
    // **Decided again from the rows it writes, locked** (`P-414`). The read above takes no lock,
    // so a pause, a result or another re-decision that commits after it was overwritten by a
    // state decided without it: Unknown written over a row whose pause flags say paused — by a
    // hold as a transition stamped after the pause and following the state before it, by a
    // reword with the history left saying paused. The rows this will write are locked in id order (`P-394`'s
    // order, and the same rows it locked before, only earlier), which waits for a writer still
    // open and reads what it committed; what is written is decided from that. Not a guard that
    // skips a row that moved: a lost probe's sensor whose last batch landed meanwhile would keep
    // that batch's state. The rows nothing changes stay unlocked, as they were.
    const writing = [
      ...new Set([...first.rewrites.map((rewrite) => rewrite.sensorId), ...first.recovered]),
    ];
    const { transitions, rewrites, recovered } =
      writing.length === 0
        ? first
        : await this.#redecide(q, await lockRuntimes(q, writing), at, cause);

    // Before the state, so a row can never say Down (Acknowledged) with no acknowledgement
    // behind it. `reset` clears these too, and clearing twice costs nothing.
    if (recovered.length > 0) {
      await writeAcknowledgements(
        q,
        recovered.map((sensorId) => ({
          sensorId,
          acknowledgedAt: null,
          acknowledgedUntil: null,
          actorKind: null,
          actorLabel: null,
        })),
      );
      for (const sensorId of recovered) this.#cache.delete(sensorId);
    }

    await writeStateHistory(q, transitions, this.#onStatesCommitted);
    await writeStateChanges(q, rewrites);
    // Last, and in the same transaction: a chain armed against a state that rolled back would
    // page somebody about a sensor that is fine. Every sensor asked about, not only the ones
    // that moved — a reconciliation is a comparison against the present, and one that skipped
    // the unmoved would never notice an alarm left standing by a trigger that changed.
    await this.#alarms?.react(q, sensorIds, at);
    this.#transitions += transitions.length;
    this.#reevaluations += transitions.length;
    return transitions.length;
  }

  /**
   * What `reevaluate` would write for these rows, with the live facts laid over them: the
   * transitions, the rewrites and the acknowledgements a recovery clears. Writes nothing but
   * drops the cache entries it would move.
   */
  async #redecide(
    q: Queryable,
    loaded: Map<number, SensorRuntime>,
    at: Date,
    cause: ReevaluationCause,
  ): Promise<{ transitions: StateTransition[]; rewrites: StateRewrite[]; recovered: number[] }> {
    const runtimes = this.#withLiveFacts(loaded);
    const transitions: StateTransition[] = [];
    const rewrites: StateRewrite[] = [];
    const recovered: number[] = [];

    // §3: when the last source clears, the sensor awaits its next scan rather than returning to
    // the state it had before the pause — which the system has not checked since.
    const facts = new Map<number, SensorFacts>();
    for (const [sensorId, runtime] of runtimes) {
      const resuming = !isPaused(runtime.facts.pause) && runtime.state === 'paused';
      facts.set(sensorId, resuming ? clearedByResume(runtime.facts, at) : runtime.facts);
    }
    const policies = await this.#policiesFor(facts);
    const pauseMessages = await this.#pauseMessagesFor(q, cause, facts, at);
    const factsOf = (sensorId: number, fallback: SensorFacts): SensorFacts =>
      facts.get(sensorId) ?? fallback;

    for (const [sensorId, runtime] of runtimes) {
      const facts = factsOf(sensorId, runtime.facts);
      const resuming = facts !== runtime.facts;
      const decision = evaluate(facts, policies(sensorId));

      // §2.4 clears an acknowledgement on a recovery, and a recovery does not have to arrive as
      // a result: lifting a simulated error is one, and so is a pause clearing. Before `M-16`
      // this ran only in `applyResult`, so an alarm acknowledged during a chain test kept its
      // acknowledgement after the force was lifted — invisibly, and it silenced the sensor's
      // next genuine failure.
      if (clearedByRecovery(facts, decision) !== facts) recovered.push(sensorId);

      if (decision.state === runtime.state && decision.cause === runtime.cause) {
        // **Withheld for another reason: its words follow, and nothing else moves** (`M-28`). A
        // factory refused for its voucher that is then withheld for what it reads stays
        // `unknown`/`access`, and its message said a grant it has back was missing. No
        // transition, and the state keeps its start.
        // Where a refusal stopped follows it too, so a refusal renewed with a new phase, or
        // first from a probe that names one, is written though its words are the same (`P-407`).
        // And a check its probe could not start, held again in new words or with a new place,
        // says the latest round's (`P-410`). And a sensor another hold now stands over, or that
        // the hold standing over it let go of, says the words of the one that holds it now
        // (`P-413`).
        const reworded = this.#heldWords(sensorId, decision);
        if (
          reworded !== undefined &&
          (reworded.message !== runtime.message || !sameFailure(reworded.failure, runtime.failure))
        ) {
          rewrites.push({
            sensorId,
            at,
            state: decision.state,
            cause: decision.cause,
            message: reworded.message,
            failure: reworded.failure,
            since: runtime.since,
            reset: false,
          });
          this.#cache.delete(sensorId);
        }
        continue;
      }

      // The operator's words when the operator's action is what decided the state, and nothing
      // on the way out — the reason a sensor is Unknown after a resume is that nobody has
      // scanned it yet. `CAPABILITIES.MD §5.3` requires an acknowledgement's message to become
      // the sensor's last message; a pause's and a simulated error's are wanted for the same
      // reason, which is that a sensor showing an unexplained state is the thing to avoid.
      // **The message has to describe the cause that is reported** (`P-94`). `operatorDecided`
      // is true for *any* paused decision, so whichever subsystem happened to trigger the
      // re-evaluation supplied the words — and `sources` says which causes this caller is
      // entitled to speak for. A schedule window opening on a sensor an operator had also
      // paused by hand moved the cause from `schedule` to `user`, and wrote "outside the Office
      // hours schedule" as the reason it was still paused, at 08:00, with office hours open.
      //
      // When the caller does not own the decided cause, the words come from whoever does. Only
      // `object_pause` knows what an operator typed, so a manual or inherited pause is looked
      // up rather than guessed; there is nothing to look up for the other causes, and an empty
      // message is what a sensor awaiting its next scan has always carried.
      //
      // A withheld sensor's words come from the voucher check whoever re-decided it (`A-29`):
      // they are the only ones that say what fixes it, and they are held with the fact.
      //
      // **Let go from a hold, it says so** (`A-78`, `R-11`): its state is the one it had before
      // it was held, and an Up or a Down with nothing beside it said neither that nor why.
      //
      // **Where the check stopped goes with words that are a check's** (`P-407`): a withholding's
      // own (a probe's refusal names it, the core's sentence nothing), or the caller's when its
      // words are a held result's and it speaks for the cause. Never beside words on the way
      // out, a pause's or an acknowledgement's, which say nothing of where a check stopped. A
      // not-started sensor's come from its probe's latest round, whoever re-decides it (`P-410`),
      // and every hold's from the hold, whoever re-decides it (`P-413`).
      const owned = cause.sources === undefined || cause.sources.includes(decision.cause);
      const held = operatorDecided(decision) ? this.#heldWords(sensorId, decision) : undefined;
      const message = !operatorDecided(decision)
        ? releasedMessage(runtime.cause, cause)
        : (held?.message ?? (owned ? cause.message : (pauseMessages.get(sensorId) ?? '')));
      const failure = !operatorDecided(decision)
        ? null
        : held !== undefined
          ? held.failure
          : owned
            ? (cause.failure ?? null)
            : null;
      transitions.push({
        sensorId,
        at,
        state: decision.state,
        previousState: runtime.state,
        cause: decision.cause,
        message,
        failure,
      });
      rewrites.push({
        sensorId,
        at,
        state: decision.state,
        cause: decision.cause,
        message,
        failure,
        since: at,
        reset: resuming,
      });
      // The cache is now behind the database. Dropping the entry costs one query on this
      // sensor's next result and is the only thing that cannot go wrong.
      this.#cache.delete(sensorId);
    }
    return { transitions, rewrites, recovered };
  }

  /**
   * Forces a sensor Down, or lifts the force (`M-14`).
   *
   * Two writes in one transaction and in this order, exactly as an acknowledgement is: the
   * column §2 reads, then the state it implies. Nothing is refused by state — a simulated error
   * is not a statement about what the sensor is doing, it is an instruction to ignore that.
   *
   * A pause still beats it (§2 layer 1), which is deliberate: pausing is an explicit instruction
   * to stop monitoring, and a sensor an operator switched off should not start paging people
   * because somebody else was testing a notification chain.
   */
  async simulate(
    q: Queryable,
    sensorIds: readonly number[],
    simulated: boolean,
    message: string,
    at: Date,
  ): Promise<{ changed: number[]; transitions: number }> {
    if (sensorIds.length === 0) return { changed: [], transitions: 0 };

    const moved = await writeSimulatedErrors(q, sensorIds, simulated);
    if (moved === 0) return { changed: [], transitions: 0 };
    // Every sensor asked for, not only the ones whose column moved: re-evaluating one already
    // in the requested state costs a comparison and writes nothing, and working out which is
    // which would mean a second read of what was just written.
    for (const sensorId of sensorIds) this.#cache.delete(sensorId);

    const transitions = await this.reevaluate(q, sensorIds, at, { message });
    return { changed: [...sensorIds], transitions };
  }

  /**
   * Acknowledges an alarm, or clears an acknowledgement (`M-13`).
   *
   * Two writes in one transaction, in this order: the columns §2.4 reads, then the state they
   * imply. It cannot be one write, because the machine is what turns a computed `down` into
   * `down_acknowledged` and it has to see the fact before it can be asked about it.
   *
   * Refuses anything that is not Down. §2.4 applies the layer only to `down`, so an
   * acknowledgement stored on an Up sensor would sit there silently and suppress the *next*
   * outage — the opposite of what the operator meant, and invisible until it happened.
   */
  async acknowledge(
    q: Queryable,
    sensorIds: readonly number[],
    acknowledgement: ResolvedAcknowledgement | null,
    actor: { kind: ActorKind; label: string | null },
    at: Date,
  ): Promise<{ acknowledged: number[]; refused: number[]; transitions: number }> {
    if (sensorIds.length === 0) return { acknowledged: [], refused: [], transitions: 0 };

    const runtimes = this.#withLiveFacts(await loadRuntimes(q, sensorIds));
    const acknowledged: number[] = [];
    const refused: number[] = [];
    for (const sensorId of sensorIds) {
      const runtime = runtimes.get(sensorId);
      if (runtime === undefined) {
        refused.push(sensorId);
        continue;
      }
      // Clearing is allowed from any state: an acknowledgement on a sensor that has since been
      // paused is still an acknowledgement somebody may want to withdraw.
      if (acknowledgement !== null && !canAcknowledge(runtime.state)) {
        refused.push(sensorId);
        continue;
      }
      acknowledged.push(sensorId);
    }
    if (acknowledged.length === 0) return { acknowledged, refused, transitions: 0 };

    await writeAcknowledgements(
      q,
      acknowledged.map((sensorId) => ({
        sensorId,
        acknowledgedAt: acknowledgement?.acknowledgedAt ?? null,
        acknowledgedUntil: acknowledgement?.acknowledgedUntil ?? null,
        actorKind: acknowledgement === null ? null : actor.kind,
        actorLabel: acknowledgement === null ? null : actor.label,
      })),
    );
    // The cache holds the pre-acknowledgement facts, and `reevaluate` reads through `q` rather
    // than through it — but the entries have to go, or the next result would decide against
    // facts that are one write out of date.
    for (const sensorId of acknowledged) this.#cache.delete(sensorId);

    const transitions = await this.reevaluate(q, acknowledged, at, {
      message: acknowledgement?.message ?? '',
    });
    return { acknowledged, refused, transitions };
  }

  /**
   * Forgets what a failed write decided.
   *
   * The rows never committed, so the probe still holds the batch and will offer it again. The
   * cache, however, has already moved — and if it stayed moved, the resent results would look
   * stale and the state change would be lost for good. Dropping the entries costs one query
   * next time and makes the database the authority again.
   */
  forget(decisions: StateDecisions): void {
    for (const write of decisions.runtimes) this.#cache.delete(write.sensorId);
  }

  /** Loads what is not already cached. One query each for the whole batch, or none at all. */
  /**
   * What was loaded or cached, with the live facts laid over it: the probe (`R-05`) and the
   * voucher (`A-29`).
   *
   * `loadRuntimes` restores both as true because neither has a column — one is a connection and
   * the other a question about grants asked every sweep, not rows. This is the one place that
   * knows better, so every path that decides a state gets the same answer and none of them has
   * to remember to ask. Laid on as each decision is made, and never kept: the cache holds what
   * the row says (`P-412`).
   */
  #withLiveFacts(runtimes: Map<number, SensorRuntime>): Map<number, SensorRuntime> {
    const heldOf = this.#heldFacts();
    if (heldOf === undefined) return runtimes;
    for (const [sensorId, runtime] of runtimes) {
      const held = heldOf(sensorId);
      if (held.probeReachable && held.vouchedFor) continue;
      runtimes.set(sensorId, {
        ...runtime,
        facts: {
          ...runtime.facts,
          ...(held.probeReachable ? {} : { probeReachable: false }),
          ...(held.vouchedFor ? {} : { vouchedFor: false }),
        },
      });
    }
    return runtimes;
  }

  /**
   * What the holds lay over each sensor now — the five holds of a sensor for its probe make its
   * probe unreachable, a withholding takes its voucher — or nothing at all while nothing is held,
   * the normal state of an installation.
   */
  #heldFacts(): ((sensorId: number) => HeldFacts) | undefined {
    const holds = this.#probeHoldsNow();
    const withheld = this.#withheldSensors?.();
    const anyWithheld = withheld !== undefined && withheld.size > 0;
    if (holds.length === 0 && !anyWithheld) return undefined;
    return (sensorId) => ({
      probeReachable: !holds.some((hold) => hold.has(sensorId)),
      vouchedFor: !(anyWithheld && withheld.has(sensorId)),
    });
  }

  /** The holds of a sensor for its probe that hold anything now, in `#probeHolds`' order. */
  #probeHoldsNow(): HeldWordsLookup[] {
    const now: HeldWordsLookup[] = [];
    for (const hold of this.#probeHolds) {
      const one = hold();
      if (one.size > 0) now.push(one);
    }
    return now;
  }

  /**
   * Why the core stopped evaluating this sensor, and where its probe stopped when a refusal is
   * why, when that is what decided it (`A-29`, `P-407`). And for a sensor held for its probe, the
   * words of **the first hold in the episode index's order that holds it** (`P-413`): a lost link,
   * a silence, a frozen clock, a factory's unreached inputs, a check its probe could not start
   * (`P-410`). Resolved here and nowhere else, whoever re-decides the sensor, so a hold that
   * arrives over another takes its words and one that lets go leaves the next one's.
   */
  #heldWords(sensorId: number, decision: Decision): HeldWords | undefined {
    if (decision.cause === 'access') return this.#withheldSensors?.().get(sensorId);
    if (decision.cause !== 'probe') return undefined;
    for (const hold of this.#probeHoldsNow()) {
      if (hold.has(sensorId)) return hold.get(sensorId);
    }
    return undefined;
  }

  /**
   * The operator's words for sensors this caller cannot speak for (`P-94`).
   *
   * Only asked when the caller named the causes it owns *and* some sensor is going to end up
   * paused for a different one — which is the schedule/dependency sweep meeting a sensor an
   * operator also paused by hand. Every other path resolves nothing.
   */
  async #pauseMessagesFor(
    q: Queryable,
    cause: { message: string; sources?: readonly SensorStateCause[] },
    facts: ReadonlyMap<number, SensorFacts>,
    at: Date,
  ): Promise<ReadonlyMap<number, string>> {
    if (cause.sources === undefined) return new Map();
    const wanted = [...facts]
      .filter(([, one]) => one.pause.manual || one.pause.parent)
      .map(([id]) => id);
    if (wanted.length === 0) return new Map();
    return this.#pauses.messagesFor(q, wanted, at);
  }

  /**
   * The failure policies `reevaluate` needs, resolved rather than assumed (`P-86`).
   *
   * `#warm` writes `#policies`, and `#warm` is reached only from `decide` — so every state
   * change that is not a result evaluated §2.1 with `DEFAULT_FAILURE_POLICY` whenever the
   * sensor's own policy was not already cached, which is *always* after a restart and after any
   * setting change anywhere in the installation (`forgetPolicies` clears the lot). A sensor
   * whose group says `retryWarnings = 3`, sitting at two failures, was re-decided as Down the
   * moment its probe came back: a false transition into the table uptime is computed from, and
   * a notification chain armed for an outage the sensor's own policy says has not happened.
   *
   * **Only the sensors it can change the answer for.** §2.1 consults the policy on a failed
   * scan and nowhere else, so pausing four thousand healthy sensors resolves nothing and this
   * costs one query only when a re-decide meets an actually-failing sensor.
   *
   * **Resolved, never cached.** `resolveForObjects` reads on its own connection, so it cannot
   * see an uncommitted move in the caller's transaction — and `object.moved` clears `#policies`
   * from inside that transaction. Caching what came back would pin the pre-move answer with
   * nothing left to invalidate it. Reading it fresh is the cold path's price for being correct.
   */
  async #policiesFor(
    facts: ReadonlyMap<number, SensorFacts>,
  ): Promise<(sensorId: number) => FailurePolicy> {
    const wanted = [...facts]
      .filter(([id, one]) => one.scan.kind === 'failed' && !this.#policies.has(id))
      .map(([id]) => id);
    if (wanted.length === 0 || this.#settings === undefined) {
      return (sensorId) => this.#policies.get(sensorId) ?? this.#fallback;
    }
    const resolved = await this.#settings.resolveForObjects(wanted, SCAN_RETRY_WARNINGS.key);
    return (sensorId) => {
      const setting = resolved.get(sensorId);
      if (setting !== undefined) return this.#policyFrom(setting.value);
      return this.#policies.get(sensorId) ?? this.#fallback;
    };
  }

  /**
   * Loads what `decide` needs that is not cached, and returns the policies it resolved.
   *
   * **Returned as well as cached**, because a forget may overtake the resolve, and then the
   * answer is not cached (`P-240`). It is still the best this batch has, and the batch must use
   * it: falling back to the default policy is `P-86`'s false transition.
   */
  async #warm(sensorIds: readonly number[]): Promise<ReadonlyMap<number, FailurePolicy>> {
    const runtimes = sensorIds.filter((id) => !this.#cache.has(id));
    const policies =
      this.#settings === undefined ? [] : sensorIds.filter((id) => !this.#policies.has(id));
    if (runtimes.length === 0 && policies.length === 0) return new Map();
    const generation = this.#policyGeneration;

    // Concurrently: they are independent reads of different tables, and a cold batch should
    // cost one round trip's latency rather than two.
    const [loaded, resolved] = await Promise.all([
      runtimes.length === 0
        ? new Map<number, SensorRuntime>()
        : this.#db.tx((q: Queryable) => loadRuntimes(q, runtimes)),
      policies.length === 0 || this.#settings === undefined
        ? new Map<number, { value: unknown }>()
        : this.#settings.resolveForObjects(policies, SCAN_RETRY_WARNINGS.key),
    ]);

    for (const [id, runtime] of loaded) this.#remember(id, runtime);
    const fresh = new Map<number, FailurePolicy>();
    for (const [id, setting] of resolved) {
      const policy = this.#policyFrom(setting.value);
      fresh.set(id, policy);
      if (this.#policyGeneration === generation) {
        remember(this.#policies, id, policy, this.#maxCached);
      }
    }
    return fresh;
  }

  #remember(sensorId: number, runtime: SensorRuntime): void {
    remember(this.#cache, sensorId, runtime, this.#maxCached);
  }

  /**
   * Turns a resolved setting into a policy, refusing anything that is not a count.
   *
   * The registry validates 0–10 on the way in, so this can only fire for a hand-edited row —
   * and the failure it prevents is a quiet one. `consecutiveFailures > NaN` is false for every
   * value, so a `NaN` here would hold a genuinely down sensor at Warning for ever, with nothing
   * to look at but a sensor that never alarms.
   */
  #policyFrom(value: unknown): FailurePolicy {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      return { warnFor: value };
    }
    this.#logger.warn(
      { key: SCAN_RETRY_WARNINGS.key, value },
      'ignoring an unusable failure policy and applying the default',
    );
    return this.#fallback;
  }
}

/** What the holds lay over a sensor, live and never stored (`R-05`, `A-29`). */
interface HeldFacts {
  readonly probeReachable: boolean;
  readonly vouchedFor: boolean;
}

/** What `overtaken` names while nothing is held. */
const NOTHING_OVERTAKEN: ReadonlySet<number> = new Set();

/**
 * A runtime as its row has it (`P-412`): the facts that have no column restored as `loadRuntimes`
 * restores them, so what is cached never carries the live facts a decision was made under.
 */
function asStored(runtime: SensorRuntime): SensorRuntime {
  if (runtime.facts.probeReachable && runtime.facts.vouchedFor) return runtime;
  return { ...runtime, facts: { ...runtime.facts, probeReachable: true, vouchedFor: true } };
}

/**
 * Oldest-first eviction, like the channel resolver's.
 *
 * A sensor still reporting is re-read on its next result at the cost of one query. These caches
 * exist to make the common case free, not to be authoritative.
 */
function remember<T>(cache: Map<number, T>, key: number, value: T, max: number): void {
  if (!cache.has(key) && cache.size >= max) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}
