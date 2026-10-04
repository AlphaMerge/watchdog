import { Ajv, type ValidateFunction } from 'ajv';
import * as ajvFormats from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import type {
  ChannelDef,
  CheckContext,
  CheckExecution,
  CostHint,
  JsonSchema,
  PreviewInput,
  PreviewResult,
  SensorType,
  SensorTypeDeclaration,
} from './contract.js';
import type { TargetPolicy } from '@ms/shared';
import { scrubSecrets, secretsOfCheck } from './support/secrets.js';
import { targetPolicyFrom } from './support/checked-target.js';
import {
  isCredentialsWithheld,
  pinTarget,
  systemResolve,
  type ResolveHost,
} from './support/pinned-target.js';

/**
 * `snmp.traffic`, `http.advanced`, `exe.script-advanced`.
 *
 * Exported so a library rule naming a type (`L-01`) is held to the same shape the catalogue
 * registers, rather than to a second copy of it.
 */
export const SENSOR_TYPE_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

/**
 * The longest recovery hold a type may declare, in seconds (`M-18`): a day. Exported so a trigger
 * that sets its own is held to the same bound.
 */
export const MAX_RECOVERY_HOLD_SECONDS = 86_400;

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
  /**
   * Whether this type can dry-run its mapping language against a pasted document (`U-13`).
   *
   * Declared here rather than matched on the id, for the reason `listener` and `evaluatedBy` are:
   * a form that asked `if (type === 'rest.custom')` would need editing for every type with a
   * mapping language added after it, and the rule in CLAUDE.md is that adding a type is a
   * one-file job.
   */
  readonly hasPreview: boolean;
  /**
   * The probe listener that feeds this type, where one does (`B-08`): `snmp-trap`, `syslog`, `flow`.
   *
   * Published so the add-sensor form can say that the chosen probe's listener is off *before* the
   * sensor is created, rather than leaving the first scan's error to say it. Absent on a type that
   * runs its own check — which is nearly all of them.
   */
  readonly listener?: string;
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
  /** Each type's `secretDestinations`, checked against its `writeOnly` paths (`A-40`). */
  readonly #destinations = new Map<string, Readonly<Record<string, readonly string[]>>>();
  readonly #ajv: Ajv;
  /** How `execute` resolves a name it has to check against a set's address targets (`A-41c`). */
  readonly #resolve: ResolveHost;
  /** What a check may connect to (`A-57`): the probe's `targetPolicy`, handed to every check. */
  readonly #policy: TargetPolicy;
  #sealed = false;

  constructor(
    options: { readonly resolve?: ResolveHost; readonly targetPolicy?: TargetPolicy } = {},
  ) {
    this.#resolve = options.resolve ?? systemResolve;
    // From the environment the probe set, where nobody hands one in: a worker builds its
    // catalogue with no options, and inherits the probe's environment.
    this.#policy = options.targetPolicy ?? targetPolicyFrom();
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
    assertSecretsSayWhereTheyGo(type, writeOnly);
    assertPinsWhatItUses(type);
    assertOnePrimaryChannel(type);
    assertSaysWhatItReads(type);
    assertHoldIsADuration(type);

    this.#types.set(type.id, type);
    this.#validators.set(type.id, validate);
    this.#writeOnly.set(type.id, writeOnly);
    this.#destinations.set(type.id, type.secretDestinations ?? {});
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
        hasPreview: type.preview !== undefined,
        ...(type.listener === undefined ? {} : { listener: type.listener }),
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

  /**
   * Runs a check, and keeps its secrets out of what it says (`S-19`).
   *
   * **The one place a message is scrubbed, for every type**, rather than each type remembering
   * to: a script's output, a driver's error and a server's banner are other people's words, and a
   * new type that forgot would leak into the state log and every notification. The message of a
   * result and of a thrown error both leave here with every `writeOnly` parameter value and every
   * secret credential field replaced — exactly the values, and only those long enough to be worth
   * it; `support/secrets.ts` says what that does not catch. Readings are numbers and are not
   * touched. The error keeps its class and its code, because the caller reads those.
   */
  async execute(id: string, context: CheckContext): Promise<CheckExecution> {
    const type = this.#require(id);
    // A device saved before the core refused such a host (`S-20`): refused here, by name, before
    // any type hands it to a program that would read it as an option.
    if (context.target.host.startsWith('-')) {
      throw new Error(
        `this device's host "${context.target.host}" begins with "-", which no address or name ` +
          'does, and a program handed it would read it as an option — correct the device’s host',
      );
    }
    const secrets = secretsOfCheck(this.writeOnlyPaths(id), context.params, context.credentials);
    let execution: CheckExecution;
    try {
      // **Before the type runs, for every type** (`A-41c`): a device named by host name, facing
      // a set whose targets name only addresses, is resolved once and every address checked.
      // The type connects to the address this hands it and never resolves the name again. No
      // lookup is made for a check that holds no such set. Whatever `pinned` arrived with the
      // context is dropped: only this decides it.
      const pinned = await pinTarget(
        {
          sensorId: context.sensorId,
          target: context.target,
          credentials: context.credentials,
          pinnedKinds: type.pinnedKinds ?? [],
          signal: context.signal,
          ...(context.timeoutMs === undefined ? {} : { timeoutMs: context.timeoutMs }),
        },
        this.#resolve,
      );
      // The same scrub, handed to the type for what it clips (`S-21`): a secret cut in two
      // before this point is two strings this scrub no longer finds.
      execution = await type.execute({
        ...context,
        target: {
          host: context.target.host,
          ipVersion: context.target.ipVersion,
          ...(pinned === null ? {} : { pinned }),
          // What a transport that checks addresses itself resolves with (`A-54`): the same
          // resolver, so one injected here is the only one a check ever asks.
          resolve: this.#resolve,
          // What the probe lets a sensor connect to (`A-57`). Whatever `policy` arrived with
          // the context is dropped, as `pinned` is: a check does not choose its own.
          policy: this.#policy,
          // And the one device's exception to it (`A-64`), which is the core's to send and the
          // device's alone: it arrives with the assignment, and `checkedTarget` reads it.
          ...(context.target.policyException === undefined
            ? {}
            : { policyException: context.target.policyException }),
        },
        scrub: (text: string) => scrubSecrets(text, secrets),
      });
    } catch (error: unknown) {
      // A refusal a transport raised does not know the sensor; the runner reads the class.
      throw scrubbedError(
        isCredentialsWithheld(error) ? error.forSensor(context.sensorId) : error,
        secrets,
      );
    }
    return execution.message === undefined || secrets.length === 0
      ? execution
      : { ...execution, message: scrubSecrets(execution.message, secrets) };
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
    if (validate(candidate)) {
      // What the schema cannot say, asked of the type once the schema holds (`A-42`).
      const problems = this.#require(id).paramProblems?.(candidate) ?? [];
      return problems.length === 0
        ? { valid: true, params: candidate }
        : { valid: false, problems: [...problems] };
    }

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
   * Where a sensor of this type sends an inherited credential set of `kind`, beside its device's
   * host and its probe (`A-41`): each declared field with its stored value, sorted by field, so
   * two sensors with the same destination fingerprint the same. Empty for a kind the type does
   * not use, and for one it uses with the host alone.
   *
   * `declared` reads other fields than this release declares: what an earlier release did, so the
   * core can tell a record the declaration moved from one somebody moved (`A-41`).
   */
  credentialDestination(
    id: string,
    kind: string,
    params: Readonly<Record<string, unknown>>,
    declared?: readonly string[],
  ): readonly (readonly [string, unknown])[] {
    const fields = declared ?? this.#destinations.get(id)?.[`kind:${kind}`] ?? [];
    return [...fields]
      .sort()
      .map((field) => [field, readAtPath(params, field.split('.')) ?? null] as const);
  }

  /**
   * Whether a sensor of this type connects to a pinned address with a set of `kind` (`A-41c`):
   * what lets the core send a named device a set whose targets name only addresses.
   */
  pinsAddress(id: string, kind: string): boolean {
    return this.#types.get(id)?.pinnedKinds?.includes(kind) === true;
  }

  /**
   * A patch with every `writeOnly` value it does not mention taken from what is stored.
   *
   * **The rule this exists for is the mirror of redaction.** A read never returns a credential,
   * so nothing outside the core can send one back — and `params` is replaced wholesale on
   * update, not merged. Without this, any client that reads a sensor and writes it back deletes
   * every secret it holds, on the first save, silently. A generated form (`U-08`) is exactly
   * such a client, and so is a script, and so is `curl`. Putting it here rather than in the form
   * means a new caller cannot forget it, which is the same argument that put redaction in one
   * place.
   *
   * Three cases, and the third is what makes "unset" expressible at all:
   *
   * - **absent** from the patch — the stored value is carried forward;
   * - **present** with a value — the patch wins, which is a rotation;
   * - **present as `null`** — removed, and then validated, so a required secret cannot be
   *   cleared and an optional one can.
   *
   * **Absent is carried only while the secret is going where it went** (`A-40`). A patch that
   * changes a parameter the type names in `secretDestinations` and does not send the secret
   * again leaves it behind — `secretsLeftBehind` says which — because keeping it would let
   * anyone with `write` on the sensor send a secret they were never shown somewhere new.
   */
  carryWriteOnly(
    id: string,
    patch: Record<string, unknown>,
    stored: Record<string, unknown>,
  ): Record<string, unknown> {
    const paths = this.#writeOnly.get(id);
    const merged = structuredClone(patch);
    if (paths === undefined || paths.length === 0) return merged;

    for (const path of paths) {
      const segments = path.split('.');
      const given = readAtPath(merged, segments);
      if (given === null) {
        // An explicit unset. Removing it before validation is what lets the schema decide
        // whether this type may be without it.
        deleteAtPath(merged, segments);
        continue;
      }
      if (given !== undefined) continue;
      const held = readAtPath(stored, segments);
      if (held === undefined || this.#sentElsewhere(id, path, patch, stored)) continue;
      writeAtPath(merged, segments, held);
    }
    return merged;
  }

  /**
   * The stored secrets `carryWriteOnly` leaves behind for this patch (`A-40`): those it does not
   * mention, whose destinations it changes. Paths only — this is what an audit entry records.
   */
  secretsLeftBehind(
    id: string,
    patch: Readonly<Record<string, unknown>>,
    stored: Readonly<Record<string, unknown>>,
  ): readonly string[] {
    return (this.#writeOnly.get(id) ?? []).filter((path) => {
      const segments = path.split('.');
      return (
        readAtPath(patch, segments) === undefined &&
        readAtPath(stored, segments) !== undefined &&
        this.#sentElsewhere(id, path, patch, stored)
      );
    });
  }

  /**
   * Whether a patch changes where the secret at `path` is sent.
   *
   * The patch is compared with its defaults filled in by the type's own validator, because the
   * stored params were: a client that leaves out a parameter at its default has not moved
   * anything. Arrays and objects compare by their JSON, which reads a reordered object as a
   * change. That mistake costs a secret re-entered; the other one would carry it somewhere new.
   */
  #sentElsewhere(
    id: string,
    path: string,
    patch: Readonly<Record<string, unknown>>,
    stored: Readonly<Record<string, unknown>>,
  ): boolean {
    const destinations = this.#destinations.get(id)?.[path] ?? [];
    if (destinations.length === 0) return false;
    const filled = structuredClone(patch) as Record<string, unknown>;
    // Run for its defaults, not its verdict: `normalise` judges the patch after this.
    this.#validators.get(id)?.(filled);
    return destinations.some((destination) => {
      const segments = destination.split('.');
      return !sameParam(readAtPath(filled, segments), readAtPath(stored, segments));
    });
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

  /**
   * A dry run of this type's mapping language against a pasted document (`U-13`).
   *
   * Returns null where the type declares none, which is almost all of them — the caller turns
   * that into a refusal naming the type rather than an empty result that looks like a document
   * nothing matched.
   *
   * Parameters are **not** validated first, on purpose: the form asking for this has a
   * half-finished parameter set in it by definition, and a preview that refused until the whole
   * form was valid would be unavailable exactly while it is needed.
   */
  async preview(id: string, input: PreviewInput): Promise<PreviewResult | null> {
    // Called on the type rather than through a detached reference, so a type is free to build
    // its preview out of its own members later without that becoming a `this` bug.
    const type = this.#require(id);
    return type.preview === undefined ? null : type.preview(input);
  }

  #require(id: string): SensorType {
    const type = this.#types.get(id);
    if (type === undefined) {
      throw new SensorTypeError('UNKNOWN_SENSOR_TYPE', `no sensor type "${id}" is registered`);
    }
    return type;
  }
}

/** The same error with its message and stack scrubbed, or a new one saying what was thrown. */
function scrubbedError(error: unknown, secrets: readonly string[]): Error {
  if (!(error instanceof Error)) return new Error(scrubSecrets(String(error), secrets));
  if (secrets.length === 0) return error;
  error.message = scrubSecrets(error.message, secrets);
  if (error.stack !== undefined) error.stack = scrubSecrets(error.stack, secrets);
  return error;
}

/**
 * A type the core evaluates has to say what it reads (`A-29`).
 *
 * The core evaluates exactly the types whose readings come from what it already holds — other
 * sensors' readings, a probe's health, the installation's own figures — and a sensor republishes
 * its readings to everybody who can read it. So the type declares which objects its parameters
 * name (`references`), or the bar for writing one at all (`requires`), and the core checks the
 * writer against that. A type with neither would be a way to read anything the core holds from
 * wherever one could be put, which is `A-29`'s whole finding.
 */
/**
 * A recovery hold that is a whole number of seconds up to a day (`M-18`). Anything else is a typo
 * that would surface as an alarm that never ends, or ends at the return it was meant to hold.
 */
function assertHoldIsADuration(type: SensorType): void {
  const hold = type.recoveryHoldSeconds;
  if (hold === undefined) return;
  if (Number.isInteger(hold) && hold >= 0 && hold <= MAX_RECOVERY_HOLD_SECONDS) return;
  throw new SensorTypeError(
    'BAD_SENSOR_TYPE',
    `sensor type "${type.id}" declares a recovery hold of ${String(hold)} s; it must be a whole ` +
      `number of seconds from 0 to ${String(MAX_RECOVERY_HOLD_SECONDS)}`,
  );
}

/** A type pins only the kinds it is sent (`A-41c`): a promise about a set it never holds is a typo. */
function assertPinsWhatItUses(type: SensorType): void {
  const used = type.credentialKinds ?? [];
  const stray = (type.pinnedKinds ?? []).filter((kind) => !used.includes(kind));
  if (stray.length === 0) return;
  throw new SensorTypeError(
    'BAD_SENSOR_TYPE',
    `sensor type "${type.id}" says it pins the "${stray.join('", "')}" credential kind, which ` +
      'is not one of its `credentialKinds`',
  );
}

function assertSaysWhatItReads(type: SensorType): void {
  if (type.evaluatedBy !== 'core') return;
  if (type.references !== undefined || type.requires !== undefined) return;
  throw new SensorTypeError(
    'BAD_SENSOR_TYPE',
    `sensor type "${type.id}" is evaluated by the core, so it has to declare what it reads: ` +
      '`references` for the objects its parameters name, or `requires` for a bar on writing one',
  );
}

/**
 * Every secret says where it is sent, and where it is sent is a parameter an edit can be seen
 * changing (`A-40`).
 *
 * Declared for every `writeOnly` path rather than assumed, because the assumption a new type
 * would get by default — carry the secret whatever else changes — is the one that leaks it. A
 * destination that is itself write-only, or holds one, is refused: comparing it would compare a
 * secret, and nobody editing the sensor can see what they would be changing.
 */
function assertSecretsSayWhereTheyGo(type: SensorType, writeOnly: readonly string[]): void {
  const declared = type.secretDestinations ?? {};
  const where = `sensor type "${type.id}"`;
  for (const path of writeOnly) {
    if (!Object.hasOwn(declared, path)) {
      throw new SensorTypeError(
        'BAD_SENSOR_TYPE',
        `${where} marks "${path}" writeOnly but does not say where it is sent: name the ` +
          'parameters that choose it in `secretDestinations`, or `[]` if it goes only to the ' +
          'device the sensor is on',
      );
    }
  }
  // An inherited credential set is a secret too, one the sensor never holds (`A-41`).
  const kinds = (type.credentialKinds ?? []).map((kind) => `kind:${kind}`);
  for (const key of kinds) {
    if (!Object.hasOwn(declared, key)) {
      throw new SensorTypeError(
        'BAD_SENSOR_TYPE',
        `${where} uses the "${key.slice('kind:'.length)}" credential kind but does not say ` +
          `where it is sent: name the parameters that choose it as "${key}" in ` +
          '`secretDestinations`, or `[]` if the device’s host alone decides',
      );
    }
  }
  for (const [path, destinations] of Object.entries(declared)) {
    if (path.startsWith('kind:') && !kinds.includes(path)) {
      throw new SensorTypeError(
        'BAD_SENSOR_TYPE',
        `${where} says where "${path}" is sent, but it does not use that credential kind`,
      );
    }
    if (!path.startsWith('kind:') && !writeOnly.includes(path)) {
      throw new SensorTypeError(
        'BAD_SENSOR_TYPE',
        `${where} says where "${path}" is sent, but "${path}" is not a writeOnly parameter`,
      );
    }
    for (const destination of destinations) {
      const secret = writeOnly.find(
        (one) =>
          one === destination ||
          one.startsWith(`${destination}.`) ||
          destination.startsWith(`${one}.`),
      );
      if (secret !== undefined) {
        throw new SensorTypeError(
          'BAD_SENSOR_TYPE',
          `${where} says "${path}" is sent where "${destination}" says, but "${secret}" is ` +
            'write-only, so nobody editing the sensor can see it change',
        );
      }
      if (schemaAt(type.paramsSchema, destination.split('.')) === undefined) {
        throw new SensorTypeError(
          'BAD_SENSOR_TYPE',
          `${where} says "${path}" is sent where "${destination}" says, but its paramsSchema ` +
            `has no property "${destination}"`,
        );
      }
    }
  }
}

/** The schema of a dotted property path, through `properties` only, or undefined. */
function schemaAt(schema: JsonSchema, segments: readonly string[]): JsonSchema | undefined {
  let cursor: unknown = schema;
  for (const segment of segments) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    const properties = (cursor as Record<string, unknown>)['properties'];
    if (typeof properties !== 'object' || properties === null) return undefined;
    if (!Object.hasOwn(properties, segment)) return undefined;
    cursor = (properties as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'object' && cursor !== null && !Array.isArray(cursor)
    ? (cursor as JsonSchema)
    : undefined;
}

/** Two parameter values as the same destination: primitives by value, the rest by JSON. */
function sameParam(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
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
    if (def.limits !== undefined) assertUsableLimits(type.id, def);
  }
}

/**
 * Declared thresholds that could never do anything, refused at registration (`S-18`).
 *
 * The catalogue's rule: a mistake that can be caught when a type is registered is not left to be
 * discovered at the first reading. All three of these read as configured and produce either
 * nothing or nonsense — and the third is the one that would actually happen, since "warn at 80,
 * fail at 95" is easy to type in the wrong order.
 */
function assertUsableLimits(id: string, def: ChannelDef): void {
  const limits = def.limits ?? {};
  const where = `sensor type "${id}" channel "${def.key}"`;
  const bounds = [
    limits.upperError,
    limits.upperWarning,
    limits.lowerWarning,
    limits.lowerError,
  ].filter((one): one is number => one !== undefined);

  if (bounds.length === 0) {
    throw new SensorTypeError(
      'BAD_SENSOR_TYPE',
      `${where} declares limits with no bound in them; leave the field off instead`,
    );
  }
  if (bounds.some((one) => !Number.isFinite(one))) {
    throw new SensorTypeError('BAD_SENSOR_TYPE', `${where} declares a limit that is not a number`);
  }

  const { upperError, upperWarning, lowerWarning, lowerError } = limits;
  const ordered = (below: number | undefined, above: number | undefined, why: string): void => {
    if (below !== undefined && above !== undefined && below > above) {
      throw new SensorTypeError('BAD_SENSOR_TYPE', `${where} declares ${why}`);
    }
  };
  // Warning is crossed on the way to error, so it sits inside it on both sides. The other order
  // makes the warning unreachable: every reading past it is already an error.
  ordered(upperWarning, upperError, 'an upper warning above its upper error');
  ordered(lowerError, lowerWarning, 'a lower error above its lower warning');
  ordered(lowerWarning, upperWarning, 'a lower warning above its upper warning');
  ordered(lowerError, upperError, 'a lower error above its upper error');
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
/** The value at a dotted path, or undefined — including when a parent is missing. */
function readAtPath(source: Record<string, unknown>, segments: readonly string[]): unknown {
  let cursor: unknown = source;
  for (const segment of segments) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined;
    if (!Object.hasOwn(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Writes at a dotted path, creating the objects on the way. */
function writeAtPath(
  target: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): void {
  const [head, ...rest] = segments;
  if (head === undefined) return;
  if (rest.length === 0) {
    target[head] = value;
    return;
  }
  const child = target[head];
  const next =
    typeof child === 'object' && child !== null && !Array.isArray(child)
      ? (child as Record<string, unknown>)
      : {};
  target[head] = next;
  writeAtPath(next, rest, value);
}

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
