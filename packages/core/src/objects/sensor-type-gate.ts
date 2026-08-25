import type { SensorCatalogue } from '@ms/sensors';
import type { Logger } from '@ms/shared';
import { ObjectError } from './errors.js';
import type { ChannelRecord } from './types.js';

export interface ChannelDraft {
  key: string;
  name: string;
  unit?: string;
  isPrimary?: boolean;
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

  /** Channels to create with a new sensor, including which one is primary. */
  channelsFor(sensorType: string, params: Record<string, unknown>): readonly ChannelDraft[];

  /**
   * Params safe to hand to an API response or an audit row. Never call the un-redacted params
   * anything but internal: CLAUDE.md's write-only rule covers every route, to everyone.
   */
  redact(sensorType: string, params: Record<string, unknown>): RedactedParams;
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

/** The real gate: a `SensorCatalogue` behind the interface the object service uses. */
export function catalogueSensorTypeGate(catalogue: SensorCatalogue): SensorTypeGate {
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
      return catalogue.channelsFor(sensorType, params).map((def) => ({
        key: def.key,
        name: def.name,
        ...(def.unit === undefined ? {} : { unit: def.unit }),
        ...(def.isPrimary === undefined ? {} : { isPrimary: def.isPrimary }),
      }));
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
