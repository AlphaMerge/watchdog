import {
  SensorTypeError,
  type ChannelDef,
  type ChannelLimitDefaults,
  type SensorCatalogue,
  type SensorReference,
} from '@ms/sensors';
import type { Logger } from '@ms/shared';
import {
  errorKindOf,
  errorWithoutParamValues,
  withoutParamValues,
} from '../support/param-values.js';
import { ObjectError } from './errors.js';
import type { ChannelRecord } from './types.js';

export interface ChannelDraft {
  key: string;
  name: string;
  unit?: string;
  isPrimary?: boolean;
  /** The lookup the sensor type declares for this channel (`M-06`), if any. */
  lookup?: string;
  /** Set when the type declares this channel a counter, so the core stores a rate (`T-02`). */
  counterBits?: 32 | 64;
  /**
   * The thresholds the type declares for this channel (`S-18`), if any.
   *
   * Written once, when the channel is created, and marked `declared` so an operator's later
   * decision — including a decision to clear them — is never overwritten by a restart.
   */
  limits?: ChannelLimitDefaults;
}

/**
 * What a sensor reads beyond its own place in the tree (`A-29`), as its type declares it.
 *
 * `references` are the objects its parameters name; `requires` is a bar on writing one at all.
 * Both empty for every type a probe runs, which read nothing but their own target.
 */
export interface SensorReads {
  readonly references: readonly SensorReference[];
  readonly requires?: 'installation';
}

/** Params fit to leave the process, and which secrets were taken out of them. */
export interface RedactedParams {
  readonly params: Record<string, unknown>;
  readonly redacted: readonly string[];
}

/**
 * How the core reaches the sensor-type registry (P-05).
 *
 * An interface rather than the catalogue itself because the catalogue is the *probe's* view too
 * — it carries `execute` — and the core has no business holding a function it must never call.
 */
export interface SensorTypeGate {
  /**
   * Validates params against the type's schema and returns them with declared defaults filled
   * in. What comes back is what gets stored, so a sensor's row is complete rather than
   * depending on the form that created it.
   *
   * Throws `ObjectError('OBJECT_INVALID')` for an unknown type or params failing its schema.
   */
  normalise(sensorType: string, params: Record<string, unknown>): Record<string, unknown>;

  /**
   * The channels a sensor of this type declares with these parameters, including which one is
   * primary: what a create writes, and what an edit re-declares against (`P-303`).
   *
   * Throws `ObjectError('OBJECT_INVALID')`, naming the type, when the type cannot answer for
   * parameters its own schema accepted (`P-296`, `P-305`). The fault is the type's, so it is
   * logged as such, and neither the reply nor the log carries a parameter's value.
   */
  channelsFor(sensorType: string, params: Record<string, unknown>): readonly ChannelDraft[];

  /**
   * What a sensor's *stored* parameters declared, or `null` when the type cannot say: it is not
   * registered, or it throws for them (`P-303`). Neither refused nor logged, because nobody is
   * asking to write these parameters; an edit compares against them to learn what it changes,
   * and without them falls back to the channel rows themselves.
   */
  storedChannelsFor(
    sensorType: string,
    params: Record<string, unknown>,
  ): readonly ChannelDraft[] | null;

  /**
   * Params safe to hand to an API response or an audit row. Never call the un-redacted params
   * anything but internal: CLAUDE.md's write-only rule covers every route, to everyone.
   */
  redact(sensorType: string, params: Record<string, unknown>): RedactedParams;

  /**
   * A patch with every `writeOnly` value it does not mention taken from what is stored.
   *
   * The mirror of `redact`, and it has to exist for the same reason. A read never returns a
   * credential, so no client can send one back — and `params` is *replaced* on update, not
   * merged. Without this, anything that reads a sensor and writes it back deletes every secret
   * it holds, on the first save, silently. `null` in the patch is an explicit unset.
   */
  carryWriteOnly(
    sensorType: string,
    patch: Record<string, unknown>,
    stored: Record<string, unknown>,
  ): Record<string, unknown>;

  /**
   * The stored secrets `carryWriteOnly` does not carry, because the patch changes where they are
   * sent without sending them again (`A-40`). Paths, never values.
   */
  secretsLeftBehind(
    sensorType: string,
    patch: Record<string, unknown>,
    stored: Record<string, unknown>,
  ): readonly string[];

  /**
   * The types whose sensors read something other than their own target (`A-29`), so that a
   * write can ask the database for just those — and skip asking at all for the rest, which is
   * every sensor a provisioning run creates.
   */
  readingTypes(): readonly string[];

  /** What a sensor of this type, with these stored params, reads (`A-29`). */
  reads(sensorType: string, params: Record<string, unknown>): SensorReads;

  /**
   * The types with a `writeOnly` parameter (`A-41`), so that a write which changes where a
   * sensor sends things can find the secrets it has to clear without reading every sensor.
   */
  secretTypes(): readonly string[];

  /** The credential kinds a sensor of this type is sent from the vault (`A-05`). */
  credentialKinds(sensorType: string): readonly string[];

  /**
   * The types that are sent any credential kind (`A-41`), so that a write can ask the database
   * about just those — and skip asking at all for a ping or a factory.
   */
  credentialedTypes(): readonly string[];

  /**
   * Where a sensor of this type, with these stored params, sends the set of this kind, beyond
   * its device's host: the fields its type names, sorted, and their values (`A-41`). `declared`
   * reads the fields an earlier release named instead.
   */
  credentialDestination(
    sensorType: string,
    kind: string,
    params: Record<string, unknown>,
    declared?: readonly string[],
  ): readonly (readonly [string, unknown])[];

  /**
   * Whether a sensor of this type connects to an address its probe checked, with a set of this
   * kind (`A-41c`): what lets a set whose targets name only addresses reach a device named by
   * host name. False for a type that resolves the name itself, and for one not registered.
   */
  pinsAddress(sensorType: string, kind: string): boolean;
}

export type { ChannelRecord };

// Structural bounds kept from the pre-registry gate. A type is free to declare
// `additionalProperties: true`, and these are what stop that from becoming an unbounded blob
// in a column every read touches.
const MAX_PARAM_KEYS = 100;
const MAX_PARAM_DEPTH = 8;
const MAX_PARAM_BYTES = 16 * 1024;

function depthOf(value: unknown, depth = 0): number {
  if (depth > MAX_PARAM_DEPTH) return depth;
  if (Array.isArray(value)) {
    return value.reduce<number>((max, item) => Math.max(max, depthOf(item, depth + 1)), depth);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).reduce<number>(
      (max, item) => Math.max(max, depthOf(item, depth + 1)),
      depth,
    );
  }
  return depth;
}

function fail(sensorType: string, message: string, details?: Record<string, unknown>): never {
  throw new ObjectError('OBJECT_INVALID', message, {
    context: { sensorType, phase: 'validate-sensor-type' },
    ...(details === undefined ? {} : { details }),
  });
}

function assertStructurallySane(sensorType: string, params: Record<string, unknown>): void {
  if (typeof params !== 'object' || Array.isArray(params)) {
    fail(sensorType, 'sensor params must be a JSON object');
  }
  const keys = Object.keys(params);
  if (keys.length > MAX_PARAM_KEYS) {
    fail(sensorType, `sensor params may not have more than ${String(MAX_PARAM_KEYS)} keys`, {
      actual: keys.length,
    });
  }
  if (depthOf(params) > MAX_PARAM_DEPTH) {
    fail(sensorType, `sensor params may not nest deeper than ${String(MAX_PARAM_DEPTH)} levels`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(params), 'utf8');
  if (bytes > MAX_PARAM_BYTES) {
    fail(sensorType, `sensor params may not exceed ${String(MAX_PARAM_BYTES)} bytes`, {
      actual: bytes,
    });
  }
}

function draftsOf(defs: readonly ChannelDef[]): readonly ChannelDraft[] {
  return defs.map((def) => ({
    key: def.key,
    name: def.name,
    ...(def.unit === undefined ? {} : { unit: def.unit }),
    ...(def.isPrimary === undefined ? {} : { isPrimary: def.isPrimary }),
    ...(def.lookup === undefined ? {} : { lookup: def.lookup }),
    ...(def.counter === undefined ? {} : { counterBits: def.counter.bits }),
    ...(def.limits === undefined ? {} : { limits: def.limits }),
  }));
}

/**
 * The real gate: a `SensorCatalogue` behind the interface the object service uses.
 *
 * `logger` hears about a type that broke its own declaration (`P-296`), which the caller is told
 * about with a 400 and nobody else would be: the fault is the type's, and whoever ships it
 * reads the log, not the operator's screen.
 */
export function catalogueSensorTypeGate(
  catalogue: SensorCatalogue,
  options: { readonly logger?: Logger } = {},
): SensorTypeGate {
  // Fixed once the catalogue is sealed, which is before anything writes; worked out again until
  // then, so a type registered after the gate was made is not missed.
  let sealedReadingTypes: readonly string[] | undefined;
  const readingTypes = (): readonly string[] => {
    if (sealedReadingTypes !== undefined) return sealedReadingTypes;
    const found = catalogue.ids().filter((id) => {
      const type = catalogue.declaration(id);
      return type.references !== undefined || type.requires !== undefined;
    });
    if (catalogue.sealed) sealedReadingTypes = found;
    return found;
  };
  let sealedSecretTypes: readonly string[] | undefined;
  const secretTypes = (): readonly string[] => {
    if (sealedSecretTypes !== undefined) return sealedSecretTypes;
    const found = catalogue.ids().filter((id) => catalogue.writeOnlyPaths(id).length > 0);
    if (catalogue.sealed) sealedSecretTypes = found;
    return found;
  };
  let sealedCredentialedTypes: readonly string[] | undefined;
  const credentialKinds = (sensorType: string): readonly string[] =>
    catalogue.has(sensorType) ? (catalogue.declaration(sensorType).credentialKinds ?? []) : [];
  const credentialedTypes = (): readonly string[] => {
    if (sealedCredentialedTypes !== undefined) return sealedCredentialedTypes;
    const found = catalogue.ids().filter((id) => credentialKinds(id).length > 0);
    if (catalogue.sealed) sealedCredentialedTypes = found;
    return found;
  };
  /**
   * The refusal for a type that cannot declare its channels for parameters its schema accepted,
   * and the warning for whoever ships it (`P-296`, `P-305`).
   *
   * **No parameter's value in either.** The type's own message can carry one — `P-297`'s review
   * found the same for the ingestion path — and on an edit the parameters include secrets the
   * caller never sent, carried from what is stored. So every string the parameters hold is cut
   * out of the message and the stack, as `P-297` does, and no parameter is logged as a field.
   */
  const refusedDeclaration = (
    sensorType: string,
    params: Record<string, unknown>,
    cause: unknown,
  ): ObjectError => {
    const secrets = catalogue.has(sensorType) ? catalogue.writeOnlyPaths(sensorType) : [];
    const broke = cause instanceof SensorTypeError;
    const kind = errorKindOf(cause);
    const said =
      cause instanceof Error
        ? withoutParamValues(cause.message, params, secrets)
        : `it threw a ${typeof cause}`;
    options.logger?.warn(
      {
        sensorType,
        phase: 'declare-channels',
        err: {
          code: kind,
          message: said,
          ...(cause instanceof Error && cause.stack !== undefined
            ? { stack: withoutParamValues(cause.stack, params, secrets) }
            : {}),
        },
      },
      broke
        ? 'a sensor type broke its own channel declaration, and a sensor of it was refused'
        : 'a sensor type could not declare its channels for parameters its schema accepts, ' +
            'and a sensor of it was refused',
    );
    const scrubbed = errorWithoutParamValues(cause, params, secrets);
    return new ObjectError(
      'OBJECT_INVALID',
      broke
        ? `a sensor of type "${sensorType}" cannot have these parameters, because the type does ` +
            `not keep to its own declaration: ${said}`
        : `a sensor of type "${sensorType}" cannot have these parameters, because the type ` +
            `failed to declare its channels for them (${kind}: ${said}); its parameters schema ` +
            'accepts them, so the fault is the type’s',
      {
        context: { sensorType, phase: 'declare-channels' },
        details: { sensorType, reason: broke ? kind : 'CHANNELS_FAILED' },
        // The scrubbed one: something that logs this error with its cause must not find the
        // value there either.
        ...(scrubbed instanceof Error ? { cause: scrubbed } : {}),
      },
    );
  };
  return {
    normalise(sensorType: string, params: Record<string, unknown>): Record<string, unknown> {
      assertStructurallySane(sensorType, params);

      if (!catalogue.has(sensorType)) {
        // Naming what *is* registered turns "invalid" into something an operator can act on,
        // and makes an empty catalogue diagnose itself.
        const known = catalogue.ids();
        fail(
          sensorType,
          known.length === 0
            ? `no sensor types are registered, so "${sensorType}" cannot be created`
            : `"${sensorType}" is not a registered sensor type`,
          { registered: known },
        );
      }

      const result = catalogue.validate(sensorType, params);
      if (!result.valid) {
        fail(sensorType, `sensor params are not valid for "${sensorType}"`, {
          problems: result.problems.map((problem) => ({
            path: problem.path === '' ? '(root)' : problem.path,
            message: problem.message,
          })),
        });
      }
      return result.params;
    },

    channelsFor(sensorType: string, params: Record<string, unknown>): readonly ChannelDraft[] {
      let defs: readonly ChannelDef[];
      try {
        defs = catalogue.channelsFor(sensorType, params);
      } catch (cause) {
        // **A type that cannot answer for parameters its own schema accepted.** Two kinds, one
        // answer. A type breaking what it said at registration (`P-296`): a `fixedChannels` type
        // whose channels these parameters change, or one without the flag putting `limits` on a
        // channel only these parameters make (`P-293`); only `channelsFor` can see either. Or a
        // type whose `channels()` throws for them (`P-305`), which is a bug in the type just as
        // surely: the schema is the type's own statement of what it accepts. Either way these
        // parameters, with this type, in this build, are always refused, and the caller can act
        // on that (other parameters work). So a 400 naming the type rather than a 500 that says
        // nothing, and nothing written.
        throw refusedDeclaration(sensorType, params, cause);
      }
      return draftsOf(defs);
    },

    storedChannelsFor(
      sensorType: string,
      params: Record<string, unknown>,
    ): readonly ChannelDraft[] | null {
      if (!catalogue.has(sensorType)) return null;
      try {
        return draftsOf(catalogue.channelsFor(sensorType, params));
      } catch {
        // A type that cannot answer for what is stored — one stored before `P-293`, or before a
        // build changed the type — leaves the caller the channel rows, which is what it asks for.
        return null;
      }
    },

    carryWriteOnly(
      sensorType: string,
      patch: Record<string, unknown>,
      stored: Record<string, unknown>,
    ): Record<string, unknown> {
      // An unregistered type has no declared secrets to carry, and `normalise` is about to
      // refuse the patch anyway with a message that names what is registered.
      if (!catalogue.has(sensorType)) return patch;
      return catalogue.carryWriteOnly(sensorType, patch, stored);
    },

    secretsLeftBehind(
      sensorType: string,
      patch: Record<string, unknown>,
      stored: Record<string, unknown>,
    ): readonly string[] {
      if (!catalogue.has(sensorType)) return [];
      return catalogue.secretsLeftBehind(sensorType, patch, stored);
    },

    readingTypes,

    reads(sensorType: string, params: Record<string, unknown>): SensorReads {
      // An unregistered type is not evaluated by anything, so it reads nothing; `normalise`
      // refuses to write one in the first place.
      if (!catalogue.has(sensorType)) return { references: [] };
      const type = catalogue.declaration(sensorType);
      return {
        references: type.references?.(params) ?? [],
        ...(type.requires === undefined ? {} : { requires: type.requires }),
      };
    },

    secretTypes,
    credentialKinds,
    credentialedTypes,

    credentialDestination(
      sensorType: string,
      kind: string,
      params: Record<string, unknown>,
      declared?: readonly string[],
    ): readonly (readonly [string, unknown])[] {
      // An unregistered type is sent nothing, so it has nowhere to send it.
      if (!catalogue.has(sensorType)) return [];
      return catalogue.credentialDestination(sensorType, kind, params, declared);
    },

    pinsAddress(sensorType: string, kind: string): boolean {
      return catalogue.pinsAddress(sensorType, kind);
    },

    redact(sensorType: string, params: Record<string, unknown>): RedactedParams {
      if (!catalogue.has(sensorType)) {
        // An unregistered type's parameters cannot be classified, and one of them may be a
        // credential. Withholding all of them is recoverable — register the type again and they
        // reappear — where returning them is not.
        return { params: {}, redacted: Object.keys(params).sort() };
      }
      return catalogue.redact(sensorType, params);
    },
  };
}

/**
 * Says once, at boot, how many sensor types are loaded — and warns when that is none.
 *
 * An operator whose sensors all refuse to be created should learn why from the first screen of
 * the log, not by reading a validation error and guessing at its cause.
 */
export function logSensorTypes(logger: Logger, catalogue: SensorCatalogue): void {
  const ids = catalogue.ids();
  if (ids.length === 0) {
    logger.warn(
      { registered: 0, unblocks: 'P-08' },
      'no sensor types are registered: sensors cannot be created and nothing can be checked',
    );
    return;
  }
  logger.info({ registered: ids.length, types: ids }, 'sensor types registered');
}
