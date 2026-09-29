import type { CheckResult, Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';
import { FACTORY_SENSOR_TYPE, type FactoryReach } from './reach.js';
import {
  storedVoucher,
  WITHHELD,
  type SensorVouching,
  type StoredVoucher,
} from '../objects/vouching.js';
import {
  FormulaError,
  evaluate,
  parseFormula,
  referencedSensors,
  type FormulaInputs,
  type FormulaNode as Node,
  type FormulaReading as ChannelReading,
} from '@ms/sensors';

/**
 * Evaluating Sensor Factory sensors (`T-21`).
 *
 * **The core computes these, and it has to.** A factory sensor's inputs are channel values the
 * core already holds; asking a probe would mean shipping other sensors' history out to every
 * probe that had one. So `SensorType.evaluatedBy: 'core'` keeps them out of assignment lists and
 * this runs them instead — on a sweep, reading the latest value per referenced channel and the
 * current state per referenced sensor, and handing the answers to `IngestionService` as ordinary
 * results.
 *
 * **Ordinary results, deliberately.** They go through the same path a probe's do: channel
 * creation, scaling, limits, the state machine, notifications. A factory sensor therefore has
 * history, thresholds, dependencies and alarms with no special case anywhere downstream — which
 * is what makes "one sensor to alarm on instead of twelve" (`CLAUDE.md`: one outage, one alarm)
 * something an operator can actually use.
 *
 * **A cycle is refused, not detected at the point of stack overflow.** A factory reading another
 * factory is legitimate and useful; a factory reading itself, directly or round a ring, is not.
 * The graph is walked before anything is evaluated and every sensor in a cycle fails its check
 * saying which sensors form it — because the alternative is a formula that silently reads its own
 * previous value and reports a number that drifts.
 *
 * **Order matters when factories read factories.** They are evaluated in dependency order within
 * one sweep, so a factory over a factory sees this sweep's value rather than last sweep's. That
 * is only possible because the whole thing runs in one place.
 */

export interface FactoryServiceOptions {
  readonly db: Database;
  readonly logger: Logger;
  /** Where results go. The same entry point a probe's batch uses. */
  readonly ingest: (results: readonly CheckResult[]) => Promise<void>;
  /**
   * Asked before a factory is evaluated, whether whoever vouched for it may still read what its
   * formulas name (`A-29`). Required for `P-111`'s reason: a wiring line that can be deleted with
   * every test still green is one that will be. `withheld` is what every sweep withholds right
   * now, so a factory reading a withheld Probe Health knows it (`M-23`). `settleTogether` settles
   * this sweep's sets in one transaction (`M-28`).
   */
  readonly vouching: FactoryVouching;
  /**
   * Where a factory whose every channel reads a sensor on a lost or frozen probe is held Unknown
   * (`M-26`). Required for `vouching`'s reason.
   */
  readonly reach: Pick<FactoryReach, 'stage'>;
  readonly now?: () => Date;
}

interface FactoryChannel {
  readonly key: string;
  readonly formula: string;
}

interface FactorySensor {
  readonly sensorId: number;
  readonly channels: readonly FactoryChannel[];
  readonly maxAgeSeconds: number;
  /** Parsed once per sweep. A formula that will not parse fails the check rather than the sweep. */
  readonly parsed: ReadonlyMap<string, Node | FormulaError>;
  readonly reads: ReadonlySet<number>;
  /** As stored, for the voucher check; `reads` is what the formulas that parsed name. */
  readonly params: Record<string, unknown>;
  readonly voucher: StoredVoucher;
}

export interface FactoryStats {
  readonly sweeps: number;
  readonly evaluated: number;
  readonly readings: number;
  readonly gaps: number;
  readonly failed: number;
  readonly cycles: number;
  /** Factories not evaluated because of who vouched for them (`A-29`), counted per sweep. */
  readonly withheld: number;
  /**
   * Factories held Unknown because what they read is on a lost or frozen probe (`M-26`), counted
   * per sweep.
   */
  readonly unreached: number;
}

/**
 * The sweep that withholds a factory for what it reads rather than for who vouched for it
 * (`M-23`). Its own owner, settled after the evaluation that finds it, so that the factory
 * sweep's own set is still settled before anything is read.
 */
const UPSTREAM = 'factory-upstream';
const NOTHING_WITHHELD: ReadonlyMap<number, string> = new Map();
const NOTHING_HELD: ReadonlyMap<number, readonly number[]> = new Map();

/** What the factory sweep asks of the voucher check. */
export type FactoryVouching = Pick<SensorVouching, 'refusals' | 'withheld' | 'settleTogether'>;

export class FactoryService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #ingest: (results: readonly CheckResult[]) => Promise<void>;
  readonly #vouching: FactoryVouching;
  readonly #reach: Pick<FactoryReach, 'stage'>;
  readonly #now: () => Date;

  #sweeps = 0;
  #evaluated = 0;
  #readings = 0;
  #gaps = 0;
  #failed = 0;
  #cycles = 0;
  #withheld = 0;
  #unreached = 0;
  /**
   * When each sensor a factory reads was last seen on a probe that is away, in ms (`M-26`). Kept
   * past the probe's return, until the sensor reports again, so that a factory is not failed in
   * the interval between the two for readings the outage kept from it.
   */
  readonly #lastAway = new Map<number, number>();

  constructor(options: FactoryServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'factory' });
    this.#ingest = options.ingest;
    this.#vouching = options.vouching;
    this.#reach = options.reach;
    this.#now = options.now ?? ((): Date => new Date());
  }

  stats(): FactoryStats {
    return {
      sweeps: this.#sweeps,
      evaluated: this.#evaluated,
      readings: this.#readings,
      gaps: this.#gaps,
      failed: this.#failed,
      cycles: this.#cycles,
      withheld: this.#withheld,
      unreached: this.#unreached,
    };
  }

  /** One pass over every factory sensor that is not paused. Never throws. */
  async sweep(): Promise<number> {
    this.#sweeps += 1;
    const sensors = await this.#load();
    // Settled even when there are none, so a factory withheld last sweep and deleted or paused
    // since is let go rather than held Unknown for ever.
    const withheld = await this.#vouching.refusals(
      sensors.map((sensor) => ({
        sensorId: sensor.sensorId,
        sensorType: FACTORY_SENSOR_TYPE,
        params: sensor.params,
        enclosingProbeId: null,
        voucher: sensor.voucher,
      })),
    );
    if (sensors.length === 0) {
      await this.#settle(withheld, NOTHING_WITHHELD, NOTHING_HELD);
      this.#lastAway.clear();
      return 0;
    }

    const cycles = findCycles(sensors);
    const order = evaluationOrder(sensors, cycles);
    const inputs = await this.#readInputs(sensors);
    const started = this.#now();
    const at = started.toISOString();

    // **What is not being evaluated right now** (`M-23`), for the factories that read it: this
    // sweep's refusals, anything another sweep withholds (a Probe Health, Core Health), and each
    // factory this sweep withholds for what it reads, added in evaluation order so that it carries
    // down a chain. Factories withheld at the last sweep for what they read are not in it: this
    // sweep finds out again whether they still are.
    const factories = new Set(sensors.map((sensor) => sensor.sensorId));
    const unevaluated = new Set<number>(withheld.keys());
    for (const id of this.#vouching.withheld().keys()) {
      if (!factories.has(id)) unevaluated.add(id);
    }
    const upstream = new Map<number, string>();
    // **And what is on a probe that is away** (`M-26`): the sensors a lost or frozen probe carries,
    // which read `unknown`/`probe`, and each factory held for them this sweep, in evaluation
    // order. Factories are left out of what was read for the reason they are left out above.
    const unreached = new Set<number>();
    for (const id of inputs.lost) {
      if (!factories.has(id)) unreached.add(id);
    }
    const widest = Math.max(...sensors.map((sensor) => sensor.maxAgeSeconds));
    const returning = this.#returning(inputs.runtime, unreached, started.getTime(), widest);
    const held = new Map<number, readonly number[]>();

    const results: CheckResult[] = [];
    for (const sensor of order) {
      // **A factory's own stored rows are not evidence about this sweep** (`P-69`). `#readInputs`
      // loaded the latest sample for every referenced channel, and a factory read by another
      // factory has samples of its own — so without this, a factory that gaps, fails on a broken
      // formula, or sits in a cycle leaves its *previous* reading in the map, and the factory
      // above computes a number from it. That is the one thing the dependency ordering exists to
      // prevent: "this sweep's value rather than last sweep's" has to mean a gap when this sweep
      // produced nothing. Cleared before any branch below can `continue`, and written back a few
      // lines down for whatever this sensor actually computes.
      for (const channel of sensor.channels) {
        inputs.channels.delete(`${String(sensor.sensorId)}:${channel.key}`);
      }

      // Not evaluated, and nothing recorded: its channels gap and its state is Unknown, laid
      // over it by the voucher check (`A-29`). After the clearing above, so a factory reading
      // this one sees a gap rather than this one's last value.
      if (withheld.has(sensor.sensorId)) {
        this.#withheld += 1;
        continue;
      }

      const inCycle = cycles.get(sensor.sensorId);
      if (inCycle !== undefined) {
        this.#cycles += 1;
        this.#failed += 1;
        results.push({
          sensorId: sensor.sensorId,
          at,
          outcome: 'error',
          durationMs: 0,
          channels: [],
          message:
            'this Sensor Factory is part of a loop: ' +
            inCycle.map((one) => `sensor ${String(one)}`).join(' → ') +
            ` → sensor ${String(inCycle[0] ?? sensor.sensorId)}. A factory that reads its own ` +
            'result, directly or round a ring, reports a number that drifts from nothing',
        });
        continue;
      }

      // One shared map of readings, one cut-off per sensor. Sharing the map is what lets the
      // write-back below reach the factories downstream; sharing the cut-off was `P-59`.
      const view: FormulaInputs = {
        channels: inputs.channels,
        up: inputs.up,
        maxAgeSeconds: sensor.maxAgeSeconds,
      };

      const readings: { key: string; value: number }[] = [];
      const missing: string[] = [];
      const broken: string[] = [];

      for (const channel of sensor.channels) {
        const parsed = sensor.parsed.get(channel.key);
        if (parsed === undefined || parsed instanceof FormulaError) {
          broken.push(`${channel.key}: ${parsed?.message ?? 'no formula'}`);
          continue;
        }
        const value = evaluate(parsed, view);
        if (value === null || !Number.isFinite(value)) {
          // A gap, never a zero. A total that quietly lost a term is a number that looks like
          // data and is wrong, which is the failure mode a factory is most likely to produce.
          missing.push(channel.key);
          this.#gaps += 1;
          continue;
        }
        readings.push({ key: channel.key, value: Math.round(value * 1e6) / 1e6 });
        this.#readings += 1;

        // Within one sweep, a factory over a factory sees this sweep's value. Only possible
        // because the whole thing runs in one place, in dependency order.
        inputs.channels.set(`${String(sensor.sensorId)}:${channel.key}`, { value, ageSeconds: 0 });
      }

      if (broken.length > 0) {
        this.#failed += 1;
        results.push({
          sensorId: sensor.sensorId,
          at,
          outcome: 'error',
          durationMs: 0,
          channels: [],
          message: `this Sensor Factory has a formula it cannot read — ${broken.join('; ')}`,
        });
        continue;
      }

      if (readings.length === 0) {
        // **Withheld for what it reads** (`M-23`). Every channel gapped, and each on a sensor
        // that is not being evaluated: nothing it is built on has failed, the question stopped
        // being asked upstream, and an error here would page Down on every factory downstream
        // of one grant edit. Unknown with a gap instead, as the one it reads is.
        //
        // **Held for its inputs' probe** (`M-26`), the same, when any of it is on a probe that
        // is lost or behind: Unknown, cause `probe`, as the sensors it reads are, and not a Down
        // beside the probe's own alarm. The probe's is the wider fact, as in the state machine.
        //
        // **Until what it reads reports again**: a sensor on a probe that has come back reads
        // its last reading at once, but nothing is measured until its first result, and a
        // replayed spool arrives oldest first. Within this factory's own maximum age of being
        // seen away, and only until it reports, it is still the outage's.
        const cutoff = started.getTime() - sensor.maxAgeSeconds * 1000;
        const isAway = (id: number): boolean =>
          unreached.has(id) || (returning.get(id) ?? -Infinity) >= cutoff;
        const isUnevaluated = (id: number): boolean => unevaluated.has(id);
        const reads = (key: string, test: (id: number) => boolean): boolean =>
          readsAny(sensor.parsed.get(key), test);
        const away = missing.some((key) => reads(key, isAway));
        if (!away && missing.every((key) => reads(key, isUnevaluated))) {
          upstream.set(sensor.sensorId, WITHHELD.upstream);
          unevaluated.add(sensor.sensorId);
          inputs.up.set(sensor.sensorId, false);
          this.#withheld += 1;
          continue;
        }
        if (away && missing.every((key) => reads(key, isUnevaluated) || reads(key, isAway))) {
          held.set(sensor.sensorId, lacking(sensor, missing, isAway, held));
          unreached.add(sensor.sensorId);
          inputs.up.set(sensor.sensorId, false);
          this.#unreached += 1;
          continue;
        }
        // Every channel gapped. Not a reading of none: the sources this sensor is built on are
        // all missing, which is a fault of its own rather than a quiet period.
        this.#failed += 1;
        results.push({
          sensorId: sensor.sensorId,
          at,
          outcome: 'error',
          durationMs: 0,
          channels: [],
          message:
            'none of this Sensor Factory’s formulas could be evaluated — every channel they ' +
            `read is missing or older than ${String(sensor.maxAgeSeconds)} s`,
        });
        continue;
      }

      this.#evaluated += 1;
      results.push({
        sensorId: sensor.sensorId,
        at,
        outcome: 'ok',
        durationMs: 0,
        channels: readings,
        message:
          readings
            .slice(0, 4)
            .map((one) => `${one.key}=${String(one.value)}`)
            .join(' ') +
          (missing.length === 0 ? '' : `; ${missing.join(', ')} had nothing to compute from`),
      });
    }

    // Before the results, so that a factory let go here is re-decided before its fresh result is
    // applied.
    await this.#settle(withheld, upstream, held);
    if (results.length > 0) await this.#ingest(results);
    if (this.#cycles > 0 && cycles.size > 0) {
      // Once a sweep, not once a sensor: a ring of eight would otherwise be eight identical
      // lines a minute for as long as it takes somebody to notice.
      this.#logger.warn(
        { sensors: [...cycles.keys()] },
        'sensor factory formulas form a loop and are not being evaluated',
      );
    }
    return results.length;
  }

  /**
   * The sweep's three sets, settled in one transaction (`M-28`): the factories refused for who
   * vouched for them, those withheld for what they read (`M-23`), and those held for their
   * inputs' probe (`M-26`). A factory crosses between any two of them in one sweep when its
   * voucher returns or a probe goes or comes back, and settled one after another it was
   * re-decided in between with neither: its last reading, a transition and a notification, then
   * Unknown again. All three move first, and what crossed is re-decided once.
   */
  async #settle(
    refused: ReadonlyMap<number, string>,
    upstream: ReadonlyMap<number, string>,
    held: ReadonlyMap<number, readonly number[]>,
  ): Promise<void> {
    await this.#vouching.settleTogether(
      new Map([
        ['factory', refused],
        [UPSTREAM, upstream],
      ]),
      this.#reach.stage(held),
    );
  }

  /** Every factory sensor that is not paused, with its formulas parsed. */
  async #load(): Promise<FactorySensor[]> {
    const rows = await this.#db.query<{
      object_id: string;
      params: Record<string, unknown>;
      vouched_by: string;
      vouched_by_user: string | null;
    }>(
      `
      SELECT sc.object_id, sc.params, sc.vouched_by, sc.vouched_by_user
      FROM sensor_config sc
      JOIN sensor_runtime sr ON sr.object_id = sc.object_id
      WHERE sc.type = $1
        AND NOT (sr.paused_by_parent OR sr.paused_by_dependency
                 OR sr.paused_by_schedule OR sr.paused_manually)
      ORDER BY sc.object_id
      `,
      [FACTORY_SENSOR_TYPE],
    );

    const out: FactorySensor[] = [];
    for (const row of rows) {
      const sensorId = Number(row.object_id);
      const declared = row.params['channels'];
      const channels: FactoryChannel[] = [];
      if (Array.isArray(declared)) {
        for (const entry of declared) {
          if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
          const record = entry as Record<string, unknown>;
          const key = typeof record['key'] === 'string' ? record['key'].trim() : '';
          const formula = typeof record['formula'] === 'string' ? record['formula'] : '';
          if (key === '' || formula.trim() === '') continue;
          channels.push({ key, formula });
        }
      }
      if (channels.length === 0) continue;

      const parsed = new Map<string, Node | FormulaError>();
      const reads = new Set<number>();
      for (const channel of channels) {
        try {
          const node = parseFormula(channel.formula);
          parsed.set(channel.key, node);
          referencedSensors(node, reads);
        } catch (error) {
          // One unreadable formula fails that sensor's check, not the sweep. A typo in one
          // factory must not stop every other factory in the installation reporting.
          parsed.set(
            channel.key,
            error instanceof FormulaError ? error : new FormulaError(String(error)),
          );
        }
      }

      out.push({
        sensorId,
        channels,
        maxAgeSeconds: readMaxAge(row.params['maxAgeSeconds']),
        parsed,
        reads,
        params: row.params,
        voucher: storedVoucher(row.vouched_by, row.vouched_by_user),
      });
    }
    return out;
  }

  /**
   * The latest value per referenced channel and the current state per referenced sensor.
   *
   * Two queries for the whole sweep rather than two per sensor: a hundred factory sensors
   * reading five channels each is still two round trips.
   */
  async #readInputs(sensors: readonly FactorySensor[]): Promise<{
    channels: Map<string, ChannelReading>;
    up: Map<number, boolean>;
    /** The ones on a probe that is lost or behind: `unknown`/`probe` (`M-26`). */
    lost: Set<number>;
    /** Whether each is paused, and when it last reported, in ms (`M-26`). */
    runtime: Map<number, InputRuntime>;
  }> {
    const wanted = new Set<number>();
    // The widest cut-off in play, and nothing more: it bounds how far back the one query has to
    // look so that every sensor can apply its own cut-off to the result. No sensor is subject to
    // it — reading it as a cut-off is exactly the defect `P-59` fixed.
    let widest = 0;
    for (const sensor of sensors) {
      for (const id of sensor.reads) wanted.add(id);
      widest = Math.max(widest, sensor.maxAgeSeconds);
    }
    const channels = new Map<string, ChannelReading>();
    const up = new Map<number, boolean>();
    const lost = new Set<number>();
    const runtime = new Map<number, InputRuntime>();
    if (wanted.size === 0) return { channels, up, lost, runtime };

    const ids = [...wanted];
    const [values, states] = await Promise.all([
      // `DISTINCT ON` is the cheap "latest row per group" in PostgreSQL, and the index on
      // `(channel_id, time DESC)` the sample hypertable already carries is what makes it one
      // seek per channel rather than a scan.
      this.#db.query<{
        sensor_id: string;
        channel_key: string;
        value: string;
        age_seconds: string;
      }>(
        `
        SELECT DISTINCT ON (c.id)
               c.sensor_id, c.key AS channel_key, s.value,
               EXTRACT(EPOCH FROM (now() - s.time)) AS age_seconds
        FROM channel c
        JOIN sample s ON s.channel_id = c.id
        WHERE c.sensor_id = ANY($1::int[])
          AND s.time > now() - ($2 || ' seconds')::interval
        ORDER BY c.id, s.time DESC
        `,
        [ids, String(widest)],
      ),
      // `sensor_runtime`, not `sensor_state`: the latter is the append-only history uptime is
      // computed from, and asking it for "the state right now" means a `DISTINCT ON` per sensor
      // over a hypertable. `M-02` put the current state in a row per sensor for exactly this.
      this.#db.query<{
        object_id: string;
        state: string;
        cause: string;
        last_result_at: Date | null;
      }>(
        `SELECT object_id, state, cause, last_result_at
         FROM sensor_runtime WHERE object_id = ANY($1::int[])`,
        [ids],
      ),
    ]);

    for (const row of values) {
      channels.set(`${row.sensor_id}:${row.channel_key}`, {
        value: Number(row.value),
        // Aged by the database's clock, in the same query that read the sample, so a core whose
        // clock has drifted from the database's cannot make a reading look fresh.
        ageSeconds: Number(row.age_seconds),
      });
    }
    for (const row of states) {
      const id = Number(row.object_id);
      up.set(id, row.state === 'up' || row.state === 'warning');
      if (row.state === 'unknown' && row.cause === 'probe') lost.add(id);
      runtime.set(id, {
        paused: row.state === 'paused',
        lastResultAt: row.last_result_at?.getTime() ?? null,
      });
    }
    return { channels, up, lost, runtime };
  }

  /**
   * The sensors seen away at an earlier sweep that are back and have not reported since, each
   * with when it was last seen away (`M-26`). Records the ones away now, and forgets any that
   * reported, were paused, are no longer read, or have been back longer than any factory waits.
   */
  #returning(
    runtime: ReadonlyMap<number, InputRuntime>,
    away: ReadonlySet<number>,
    now: number,
    widestSeconds: number,
  ): Map<number, number> {
    for (const id of away) this.#lastAway.set(id, now);
    const returning = new Map<number, number>();
    for (const [id, seen] of this.#lastAway) {
      if (away.has(id)) continue;
      const row = runtime.get(id);
      if (
        row === undefined ||
        row.paused ||
        (row.lastResultAt !== null && row.lastResultAt > seen) ||
        now - seen > widestSeconds * 1000
      ) {
        this.#lastAway.delete(id);
        continue;
      }
      returning.set(id, seen);
    }
    return returning;
  }
}

/** What the factory sweep needs of a sensor it reads beyond its state (`M-26`). */
interface InputRuntime {
  readonly paused: boolean;
  /** When its last result was measured, in ms, or null for never. */
  readonly lastResultAt: number | null;
}

/**
 * The sensors on a probe that is away that these channels' formulas lead to (`M-26`), in id
 * order. A factory held this sweep stands for the sensors it lacks, so what is kept is always
 * sensors a probe scans, which is where the alarm engine finds the probe.
 */
function lacking(
  sensor: FactorySensor,
  channels: readonly string[],
  away: (id: number) => boolean,
  held: ReadonlyMap<number, readonly number[]>,
): number[] {
  const reads = new Set<number>();
  for (const key of channels) {
    const node = sensor.parsed.get(key);
    if (node !== undefined && !(node instanceof FormulaError)) referencedSensors(node, reads);
  }
  const out = new Set<number>();
  for (const id of reads) {
    if (!away(id)) continue;
    for (const input of held.get(id) ?? [id]) out.add(input);
  }
  return [...out].sort((a, b) => a - b);
}

/** Whether a formula names any sensor that passes. A formula that did not parse names none. */
function readsAny(node: Node | FormulaError | undefined, test: (id: number) => boolean): boolean {
  if (node === undefined || node instanceof FormulaError) return false;
  const reads = new Set<number>();
  referencedSensors(node, reads);
  return [...reads].some(test);
}

/**
 * A sensor's staleness cut-off, or the default when the stored parameter is not usable.
 *
 * Params come out of the database as whatever was written there, and `Math.max(0, NaN)` is
 * `NaN`, not a number — so the query's interval parameter becomes the string `'NaN'`, and
 * PostgreSQL answers `invalid input syntax for type interval: "NaN seconds"` (measured). That
 * throws the one query the whole sweep depends on, so a single unparseable row stops **every**
 * factory sensor in the installation reporting, not just its own. Out of range falls back to the
 * default rather than clamping to the nearer bound: a stored 5 is not evidence that somebody
 * meant 30, and the schema's default is the only value here that anybody actually chose.
 */
function readMaxAge(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 30 || value > 86_400) return 600;
  return Math.floor(value);
}

/**
 * Which factory sensors are in a cycle, and which sensors form it.
 *
 * Only *factory* sensors can form one: an ordinary sensor reads nothing, so a ring has to run
 * entirely through factories. Depth-first with a colour marking, which is the standard way and
 * the one that can name the ring rather than only report that there is one.
 */
export function findCycles(sensors: readonly FactorySensor[]): Map<number, number[]> {
  const byId = new Map(sensors.map((sensor) => [sensor.sensorId, sensor]));
  const colour = new Map<number, 'grey' | 'black'>();
  const cycles = new Map<number, number[]>();
  const stack: number[] = [];

  const walk = (id: number): void => {
    const sensor = byId.get(id);
    if (sensor === undefined) return;
    const seen = colour.get(id);
    if (seen === 'black') return;
    if (seen === 'grey') {
      // Back edge. Everything from where this id sits on the stack to the top is the ring.
      const from = stack.indexOf(id);
      const ring = stack.slice(from < 0 ? 0 : from);
      for (const member of ring) cycles.set(member, ring);
      return;
    }
    colour.set(id, 'grey');
    stack.push(id);
    for (const next of sensor.reads) walk(next);
    stack.pop();
    colour.set(id, 'black');
  };

  for (const sensor of sensors) walk(sensor.sensorId);
  return cycles;
}

/**
 * Factories before the factories that read them.
 *
 * So a factory over a factory sees this sweep's value rather than last sweep's — a difference of
 * one whole scan interval on every layer, which on a three-layer stack is three minutes of lag
 * for no reason. Sensors in a cycle keep their place; they fail rather than evaluate.
 */
export function evaluationOrder(
  sensors: readonly FactorySensor[],
  cycles: ReadonlyMap<number, number[]>,
): FactorySensor[] {
  const byId = new Map(sensors.map((sensor) => [sensor.sensorId, sensor]));
  const done = new Set<number>();
  const out: FactorySensor[] = [];

  const visit = (sensor: FactorySensor): void => {
    if (done.has(sensor.sensorId)) return;
    done.add(sensor.sensorId);
    if (!cycles.has(sensor.sensorId)) {
      for (const id of sensor.reads) {
        const dependency = byId.get(id);
        if (dependency !== undefined) visit(dependency);
      }
    }
    out.push(sensor);
  };

  for (const sensor of sensors) visit(sensor);
  return out;
}
