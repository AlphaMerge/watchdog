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
  /**
   * The lookup that turns this channel's readings into a state (`M-06`).
   *
   * For a channel whose value is a status code rather than a measurement: SNMP `ifOperStatus`
   * is `1`, `2` or `7`, and "warn above 1.5" is not a threshold anybody should have to write.
   * The core resolves the id against its lookup catalogue; a type may name one this
   * installation has not loaded, and that is reported rather than fatal.
   *
   * An operator can override it per channel. The declaration is the sensible default, not a
   * rule — the whole point of lookups being files is that a device can disagree with its RFC.
   */
  readonly lookup?: string;
  /**
   * This channel reports a *counter*, not a measurement, and the core turns it into a rate
   * (`T-02`).
   *
   * An interface reports octets since it was last reset. Declaring the width here is what lets
   * the core divide two readings by the time between them — and the width matters, because a
   * 32-bit counter going backwards has wrapped (2^32 octets is thirty-four seconds of gigabit)
   * while a 64-bit one going backwards is a device that rebooted.
   *
   * A counter channel's readings carry `ChannelReading.counter` — the exact value as text —
   * rather than being read from `value`, which cannot hold `ifHCInOctets` without losing its
   * low bits. The stored sample is the rate, in this channel's own unit per second.
   */
  readonly counter?: { readonly bits: 32 | 64 };
}

/**
 * What a check points at.
 *
 * It comes from the sensor's parent device, not from its own parameters: one device, one host,
 * and moving a device re-targets every sensor under it at once. A sensor type that asked for a
 * host in its `paramsSchema` would let the two disagree, which is how a device gets renamed and
 * half its sensors keep checking the old address.
 */
export interface CheckTarget {
  /** The device's `host`: a hostname or a literal address. Never resolved by the core. */
  readonly host: string;
  readonly ipVersion: 'auto' | 'v4' | 'v6';
}

/** What a check is handed when it runs. */
export interface CheckContext {
  readonly sensorId: number;
  readonly target: CheckTarget;
  readonly params: Readonly<Record<string, unknown>>;
  /**
   * The credential sets this type declared, resolved and decrypted for this sensor (`A-05`).
   *
   * Keyed by kind, and holding only the kinds `credentialKinds` names — a Ping sensor is never
   * handed an SSH key. Each is the *inherited* answer: set once on the device, or on the group
   * above it, and every sensor underneath gets it. A kind that is declared but not configured
   * anywhere up the tree is simply absent, which a type should report as a check failure naming
   * the kind rather than as an authentication error twenty seconds later.
   *
   * These are secrets. They exist in this worker for the duration of the check and are not
   * logged, not spooled and not returned in a result.
   */
  readonly credentials: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
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
  /**
   * Credential kinds this type needs, resolved from the sensor's ancestors and handed to
   * `execute` in `ctx.credentials` (`A-05`).
   *
   * Declared rather than discovered, and the reason is what the core does with it: it decrypts
   * exactly these kinds for exactly these sensors and sends them to the probe that owns them. A
   * type that did not say would have to be sent everything, so every probe would hold every
   * credential in the installation to run a Ping.
   */
  readonly credentialKinds?: readonly string[];
  /** Called with already-validated params. Must be pure — it runs in the core, not the probe. */
  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[];
  execute(context: CheckContext): Promise<CheckExecution>;
}

/** A type as the core sees it: everything except the half that does I/O. */
export type SensorTypeDeclaration = Omit<SensorType, 'execute'>;
