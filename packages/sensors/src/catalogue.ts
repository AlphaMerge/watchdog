import { Ajv, type ValidateFunction } from 'ajv';
import * as ajvFormats from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import type {
  ChannelDef,
  CostHint,
  JsonSchema,
  SensorType,
  SensorTypeDeclaration,
} from './contract.js';

/** `snmp.traffic`, `http.advanced`, `exe.script-advanced`. */
const SENSOR_TYPE_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

/** Subschema keywords the redactor cannot follow. See `assertWriteOnlyIsReachable`. */
const COMBINATORS = ['oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', 'items'] as const;

export class SensorTypeError extends Error {
  readonly code: 'UNKNOWN_SENSOR_TYPE' | 'BAD_SENSOR_TYPE';
  constructor(code: 'UNKNOWN_SENSOR_TYPE' | 'BAD_SENSOR_TYPE', message: string) {
    super(message);
    this.name = 'SensorTypeError';
    this.code = code;
  }
}

export interface ParamProblem {
  /** JSON Pointer-ish path into the params, `''` for the object itself. */
  readonly path: string;
  readonly message: string;
}

/**
 * Validation reports every problem rather than the first, matching the config loader: someone
 * fixing a sensor form should not have to submit five times to discover five mistakes.
 */
export type ParamValidation =
  | { readonly valid: true; readonly params: Record<string, unknown> }
  | { readonly valid: false; readonly problems: readonly ParamProblem[] };

export interface SensorTypeSummary {
  readonly id: string;
  readonly category: string;
  readonly costHint: CostHint;
  readonly paramsSchema: JsonSchema;
}

/**
 * The registry from ADR-001 Decision 7.
 *
 * Registration happens once at startup and the catalogue is then read-only. Every check it
 * performs at registration is one that would otherwise be a runtime surprise: a duplicate id
 * silently shadowing a type, two primary channels breaking the one-primary-per-sensor index, or
 * a `writeOnly` secret sitting somewhere the redactor cannot reach.
 */
export class SensorCatalogue {
  readonly #types = new Map<string, SensorType>();
  readonly #validators = new Map<string, ValidateFunction>();
  readonly #writeOnly = new Map<string, readonly string[]>();
  readonly #ajv: Ajv;
  #sealed = false;

  constructor() {
    // useDefaults fills in what a type declares a default for, so what gets stored is complete
    // and `channels(params)` never has to second-guess an absent optional.
    this.#ajv = new Ajv({
      allErrors: true,
      strict: true,
      allowUnionTypes: true,
      useDefaults: true,
    });
    // ajv-formats is CommonJS with `module.exports = plugin` and `exports.default = plugin`;
    // `.default` is the callable at runtime while its typings describe a namespace. Same cast,
    // and same reason, as `packages/shared/src/config/load.ts`.
    (ajvFormats.default as unknown as FormatsPlugin)(this.#ajv);
  }

  register(type: SensorType): this {
    if (this.#sealed) {
      throw new SensorTypeError('BAD_SENSOR_TYPE', 'the catalogue is sealed; register at startup');
    }
    if (!SENSOR_TYPE_ID.test(type.id)) {
      throw new SensorTypeError(
        'BAD_SENSOR_TYPE',
        `"${type.id}" is not a valid sensor type id (lowercase, dotted, e.g. "snmp.traffic")`,
      );
    }
    if (this.#types.has(type.id)) {
      // Shadowing would make behaviour depend on registration order, and the loser would be
      // invisible: same id, same form, different code.
      throw new SensorTypeError(
        'BAD_SENSOR_TYPE',
        `sensor type "${type.id}" is already registered`,
      );
    }

    let validate: ValidateFunction;
    try {
      validate = this.#ajv.compile(type.paramsSchema);
    } catch (cause) {
      throw new SensorTypeError(
        'BAD_SENSOR_TYPE',
        `sensor type "${type.id}" has an unusable paramsSchema: ${String(cause)}`,
      );
    }

    const writeOnly = collectWriteOnly(type.paramsSchema, type.id);
    assertOnePrimaryChannel(type);

    this.#types.set(type.id, type);
    this.#validators.set(type.id, validate);
    this.#writeOnly.set(type.id, writeOnly);
    return this;
  }

  /** No further registration. Called once wiring is done, so a late plugin fails loudly. */
  seal(): this {
    this.#sealed = true;
    return this;
  }

  get sealed(): boolean {
    return this.#sealed;
  }

  has(id: string): boolean {
    return this.#types.has(id);
  }

  ids(): readonly string[] {
    return [...this.#types.keys()].sort();
  }

  /** Everything the add-sensor UI needs, without the executable half. */
  summaries(): readonly SensorTypeSummary[] {
    return this.ids().map((id) => {
      const type = this.#require(id);
      return {
        id: type.id,
        category: type.category,
        costHint: type.costHint,
        paramsSchema: type.paramsSchema,
      };
    });
  }

  declaration(id: string): SensorTypeDeclaration {
    return this.#require(id);
  }

  /** The probe's path. Throws for an unknown type rather than returning undefined. */
  type(id: string): SensorType {
    return this.#require(id);
  }

  validate(id: string, params: Readonly<Record<string, unknown>>): ParamValidation {
    const validate = this.#validators.get(id);
    if (validate === undefined) {
      return {
        valid: false,
        problems: [{ path: '', message: `unknown sensor type "${id}"` }],
      };
    }

    // Ajv's useDefaults mutates what it validates; the caller's object is not ours to change.
    const candidate: Record<string, unknown> = structuredClone(params);
    if (validate(candidate)) return { valid: true, params: candidate };

    return {
      valid: false,
      problems: (validate.errors ?? []).map((error) => ({
        path: error.instancePath,
        message: error.message ?? 'is invalid',
      })),
    };
  }

  channelsFor(id: string, params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
    return this.#require(id).channels(params);
  }

  /** Dotted paths of every parameter a type marked `writeOnly`. */
  writeOnlyPaths(id: string): readonly string[] {
    return this.#writeOnly.get(id) ?? [];
  }

  /**
   * Params with every `writeOnly` value removed, and the paths that had one.
   *
   * Removed, not masked: `CredentialView` already established that a secret is *absent* from a
   * read rather than replaced by asterisks, and a masked value is one careless `if (params.x)`
   * away from being treated as real. The paths are returned so a form can still show "set".
   */
  redact(
    id: string,
    params: Readonly<Record<string, unknown>>,
  ): { params: Record<string, unknown>; redacted: readonly string[] } {
    const paths = this.#writeOnly.get(id);
    const clone = structuredClone(params) as Record<string, unknown>;
    if (paths === undefined || paths.length === 0) return { params: clone, redacted: [] };

    const redacted: string[] = [];
    for (const path of paths) {
      if (deleteAtPath(clone, path.split('.'))) redacted.push(path);
    }
    return { params: clone, redacted };
  }

  #require(id: string): SensorType {
    const type = this.#types.get(id);
    if (type === undefined) {
      throw new SensorTypeError('UNKNOWN_SENSOR_TYPE', `no sensor type "${id}" is registered`);
    }
    return type;
  }
}

/**
 * A sensor is judged by one channel. Two would make the one-primary-per-sensor index a coin
 * toss at insert time, which is a constraint violation on some sensors and not others.
 */
function assertOnePrimaryChannel(type: SensorType): void {
  let defs: readonly ChannelDef[];
  try {
    // With no params to speak of, this is the shape a type declares by default. A type whose
    // channel set genuinely depends on params is still checked here for the empty case.
    defs = type.channels({});
  } catch {
    return; // channels() may legitimately require params; the per-sensor path checks it again.
  }

  const primary = defs.filter((def) => def.isPrimary === true);
  if (primary.length > 1) {
    throw new SensorTypeError(
      'BAD_SENSOR_TYPE',
      `sensor type "${type.id}" declares ${String(primary.length)} primary channels; a sensor has at most one`,
    );
  }

  const keys = new Set<string>();
  for (const def of defs) {
    if (keys.has(def.key)) {
      throw new SensorTypeError(
        'BAD_SENSOR_TYPE',
        `sensor type "${type.id}" declares channel key "${def.key}" twice`,
      );
    }
    keys.add(def.key);
  }
}

/**
 * Dotted paths of `writeOnly` properties, refusing any the redactor could not reliably reach.
 *
 * A secret behind `oneOf` cannot be redacted without evaluating which branch matched, and a
 * redactor that guesses wrong either leaks the value or deletes a live one. Failing at startup
 * makes the author hoist it; failing at read time would leak it.
 */
function collectWriteOnly(schema: JsonSchema, typeId: string, prefix = ''): readonly string[] {
  const found: string[] = [];
  walk(schema, prefix, false);
  return found;

  function walk(node: unknown, path: string, insideCombinator: boolean): void {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;

    if (record['writeOnly'] === true) {
      if (insideCombinator) {
        throw new SensorTypeError(
          'BAD_SENSOR_TYPE',
          `sensor type "${typeId}" marks "${path}" writeOnly inside a schema combinator, where it cannot be reliably redacted — hoist it to a plain property`,
        );
      }
      found.push(path);
      // A writeOnly object is removed whole; there is nothing below it left to find.
      return;
    }

    const properties = record['properties'];
    if (typeof properties === 'object' && properties !== null) {
      for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
        walk(child, path === '' ? key : `${path}.${key}`, insideCombinator);
      }
    }

    for (const keyword of COMBINATORS) {
      const branch = record[keyword];
      if (branch === undefined) continue;
      for (const child of Array.isArray(branch) ? branch : [branch]) {
        walk(child, path, true);
      }
    }
  }
}

/** Deletes a dotted path. Returns whether anything was actually there. */
function deleteAtPath(target: Record<string, unknown>, segments: readonly string[]): boolean {
  const [head, ...rest] = segments;
  if (head === undefined) return false;
  if (rest.length === 0) {
    if (!Object.hasOwn(target, head)) return false;
    // Reflect rather than `delete target[head]`: the key is data, and the lint rule against
    // dynamic delete is there to catch objects being used as maps, which is not what this is.
    Reflect.deleteProperty(target, head);
    return true;
  }
  const child = target[head];
  if (typeof child !== 'object' || child === null || Array.isArray(child)) return false;
  return deleteAtPath(child as Record<string, unknown>, rest);
}
