import type { ChannelReading } from '@ms/shared';

/**
 * A JSON Schema document. Deliberately not a structural type: `paramsSchema` is handed to Ajv,
 * shipped to the UI to generate a form, and written by people adding sensor types — pinning it
 * to a hand-rolled interface would reject valid schemas without adding safety.
 */
export type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * How expensive a check is, which is how the pool decides what to place where.
 *
 * Not a duration: a `heavy` check is heavy because of what it holds — a spawned process, a
 * large walk, an open connection — not because it is slow. A slow `light` check is still light.
 */
export type CostHint = 'light' | 'medium' | 'heavy';

/**
 * A channel a sensor produces, declared before the sensor has ever run.
 *
 * Declaring up front is what lets the core create channels at sensor-creation time, show the
 * form and the graph legend before the first result, and know which channel a sensor is judged
 * by. `S-07` created channels lazily from whatever arrived on the wire and could not set
 * `isPrimary`, because nothing had said which one it was.
 */
export interface ChannelDef {
  /** Stable within the sensor and matched against `ChannelReading.key`. Never the label. */
  readonly key: string;
  readonly name: string;
  readonly unit?: string;
  /**
   * The channel this sensor is judged by — the number in a list, the line in a summary graph.
   * At most one per sensor; the catalogue rejects a type that declares two.
   */
  readonly isPrimary?: boolean;
}

/** What a check is handed when it runs. */
export interface CheckContext {
  readonly sensorId: number;
  readonly params: Readonly<Record<string, unknown>>;
  /**
   * Not optional and not advisory. CLAUDE.md requires every check to honour it; one that does
   * not gets its worker terminated, which costs strictly more than returning.
   */
  readonly signal: AbortSignal;
}

export interface CheckExecution {
  channels: ChannelReading[];
  message?: string;
}

/**
 * A sensor type, per ADR-001 Decision 7.
 *
 * One type is one file. `execute` is the only member the probe uses and the only one the core
 * does not — a type with heavy or native dependencies must `await import()` them *inside*
 * `execute`, so that loading the catalogue in the core costs nothing.
 */
export interface SensorType {
  /** Dotted, lowercase, stable forever: it is written into `sensor_config.type`. */
  readonly id: string;
  /** Groups the add-sensor picker. Free text, but reuse an existing one where it fits. */
  readonly category: string;
  /** Validates the API, generates the UI form, and marks secrets `writeOnly`. */
  readonly paramsSchema: JsonSchema;
  readonly costHint: CostHint;
  /** Called with already-validated params. Must be pure — it runs in the core, not the probe. */
  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[];
  execute(context: CheckContext): Promise<CheckExecution>;
}

/** A type as the core sees it: everything except the half that does I/O. */
export type SensorTypeDeclaration = Omit<SensorType, 'execute'>;
