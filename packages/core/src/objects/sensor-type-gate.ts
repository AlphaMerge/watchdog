import type { Logger } from '@ms/shared';
import { ObjectError } from './errors.js';
import type { ChannelRecord } from './types.js';

export interface ChannelDraft {
  key: string;
  name: string;
  unit?: string;
  isPrimary?: boolean;
}

/**
 * The seam where the sensor-type plugin registry (P-05) plugs in.
 *
 * Until then nothing knows what `snmp.traffic` means, what parameters it takes, or which
 * channels it produces. Rather than pretend otherwise, S-03 validates only the shape of a
 * sensor type id and the size of its parameter blob, and says so out loud at boot.
 */
export interface SensorTypeGate {
  /** Throws `ObjectError('OBJECT_INVALID')` for an unknown type or params failing its schema. */
  assertValid(sensorType: string, params: Record<string, unknown>): void;
  /** Channels to create with a new sensor. Empty until P-05 registers real types. */
  channelsFor(sensorType: string, params: Record<string, unknown>): readonly ChannelDraft[];
}

export type { ChannelRecord };

/** `snmp.traffic`, `http.advanced`, `exe.script-advanced`. */
const SENSOR_TYPE_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

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

/**
 * The pre-P-05 gate: structural checks only.
 *
 * It exists to bound what an unvalidated blob can do — not to pretend the parameters are
 * correct. Swapping in the real registry is one binding in `main.ts`.
 */
export const permissiveSensorTypeGate: SensorTypeGate = {
  assertValid(sensorType: string, params: Record<string, unknown>): void {
    const fail = (message: string, details?: Record<string, unknown>): never => {
      throw new ObjectError('OBJECT_INVALID', message, {
        context: { sensorType, phase: 'validate-sensor-type' },
        ...(details === undefined ? {} : { details }),
      });
    };

    if (!SENSOR_TYPE_ID.test(sensorType)) {
      fail(
        `"${sensorType}" is not a valid sensor type id (expected lowercase, dotted, e.g. "snmp.traffic")`,
      );
    }
    if (typeof params !== 'object' || Array.isArray(params)) {
      fail('sensor params must be a JSON object');
    }

    const keys = Object.keys(params);
    if (keys.length > MAX_PARAM_KEYS) {
      fail(`sensor params may not have more than ${String(MAX_PARAM_KEYS)} keys`, {
        actual: keys.length,
      });
    }
    if (depthOf(params) > MAX_PARAM_DEPTH) {
      fail(`sensor params may not nest deeper than ${String(MAX_PARAM_DEPTH)} levels`);
    }

    const bytes = Buffer.byteLength(JSON.stringify(params), 'utf8');
    if (bytes > MAX_PARAM_BYTES) {
      fail(`sensor params may not exceed ${String(MAX_PARAM_BYTES)} bytes`, { actual: bytes });
    }
  },

  channelsFor(): readonly ChannelDraft[] {
    // A sensor type declares its channels (ADR-001 Decision 7). Until the registry exists,
    // there is nothing to declare, and inventing channels here would be a second source of
    // truth for two phases.
    return [];
  },
};

/**
 * Says once, at boot, that sensor parameters are not being type-validated. An operator
 * reading the log should not have to infer it from the absence of errors.
 */
export function warnSensorTypesUnvalidated(logger: Logger): void {
  logger.warn(
    { gate: 'permissive', unblocks: 'P-05' },
    'sensor parameters are shape-checked only: no sensor-type registry is loaded yet',
  );
}
