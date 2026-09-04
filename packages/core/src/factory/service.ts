import type { CheckResult, Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';
import {
  FormulaError,
  evaluate,
  parseFormula,
  referencedSensors,
  type ChannelReading,
  type FormulaInputs,
  type Node,
} from './formula.js';

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
}

export interface FactoryStats {
  readonly sweeps: number;
  readonly evaluated: number;
  readonly readings: number;
  readonly gaps: number;
  readonly failed: number;
  readonly cycles: number;
}

const FACTORY_TYPE = 'core.factory';

export class FactoryService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #ingest: (results: readonly CheckResult[]) => Promise<void>;
  readonly #now: () => Date;

  #sweeps = 0;
  #evaluated = 0;
  #readings = 0;
  #gaps = 0;
  #failed = 0;
  #cycles = 0;

  constructor(options: FactoryServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child({ component: 'factory' });
    this.#ingest = options.ingest;
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
    };
  }

  /** One pass over every factory sensor that is not paused. Never throws. */
  async sweep(): Promise<number> {
    this.#sweeps += 1;
    const sensors = await this.#load();
    if (sensors.length === 0) return 0;

    const cycles = findCycles(sensors);
    const order = evaluationOrder(sensors, cycles);
    const inputs = await this.#readInputs(sensors);
    const at = this.#now().toISOString();

    const results: CheckResult[] = [];
    for (const sensor of order) {
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

  /** Every factory sensor that is not paused, with its formulas parsed. */
  async #load(): Promise<FactorySensor[]> {
    const rows = await this.#db.query<{ object_id: string; params: Record<string, unknown> }>(
      `
      SELECT sc.object_id, sc.params
      FROM sensor_config sc
      JOIN sensor_runtime sr ON sr.object_id = sc.object_id
      WHERE sc.type = $1
        AND NOT (sr.paused_by_parent OR sr.paused_by_dependency
                 OR sr.paused_by_schedule OR sr.paused_manually)
      ORDER BY sc.object_id
      `,
      [FACTORY_TYPE],
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
    if (wanted.size === 0) return { channels, up };

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
      this.#db.query<{ object_id: string; state: string }>(
        `SELECT object_id, state FROM sensor_runtime WHERE object_id = ANY($1::int[])`,
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
      up.set(Number(row.object_id), row.state === 'up' || row.state === 'warning');
    }
    return { channels, up };
  }
}

/**
 * A sensor's staleness cut-off, or the default when the stored parameter is not usable.
 *
 * Params come out of the database as whatever was written there, and a cut-off that arrived as
 * `NaN` would widen to `Infinity` under the `Math.max` that bounds the query — every reading
 * fresh, for every factory in the installation. The schema's own bounds are the ones enforced.
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
