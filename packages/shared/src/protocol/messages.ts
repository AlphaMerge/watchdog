import { Ajv, type ValidateFunction } from 'ajv';
import { AppError } from '../errors/app-error.js';

/**
 * The core↔probe wire protocol.
 *
 * Phase 0 carried a versioned handshake and a heartbeat; version 2 added check results and their
 * acknowledgement (S-07); version 3 adds the configuration push (R-04). The rest of spool replay
 * arrives later as new members of these unions — which is why they are discriminated unions
 * rather than one message type with optional fields.
 */

/**
 * Bumped whenever a change is not backwards compatible. Negotiated in the handshake.
 *
 * Version 2 added `results`, `results-ack` and `results-nack`. A version-2 probe talking to a
 * version-1 core would send results the core cannot parse, so the bump is what turns that into
 * a clean rejection at the handshake instead of a dropped connection later.
 *
 * Version 3 added the configuration push (R-04). The core will not send `config-*` to a peer
 * below 3 — an older probe simply scans nothing, which is what it did before the push existed.
 */
export const PROTOCOL_VERSION = 3;

/**
 * The oldest peer version this build still understands.
 *
 * Still 1: a version-1 probe never sends results, so an older probe against this core simply
 * heartbeats. There is nothing to break, and forcing an upgrade in lockstep would defeat the
 * point of negotiating at all.
 */
export const MIN_PROTOCOL_VERSION = 1;

/**
 * One sensor a probe has been told to scan, with everything needed to scan it.
 *
 * Self-contained on purpose: the probe holds no copy of the object tree and does no lookups of
 * its own. `target` comes from the sensor's parent device and `intervalSeconds` from the
 * resolved settings chain — both are the core's to work out, so that moving a device or changing
 * an inherited interval is one recomputation in one place rather than a rule the probe has to
 * reimplement and keep in step.
 */
export interface SensorAssignment {
  sensorId: number;
  sensorType: string;
  params: Record<string, unknown>;
  target: { host: string; ipVersion: 'auto' | 'v4' | 'v6' };
  intervalSeconds: number;
  timeoutMs: number;
}

/** A single channel's reading inside a check result. */
export interface ChannelReading {
  /** Stable within the sensor, assigned by the sensor type — not the display name. */
  key: string;
  value: number;
  /**
   * Display metadata, sent so the core can create the channel the first time it sees it.
   * Absent on every subsequent result; the core already has it.
   */
  name?: string;
  unit?: string;
}

/**
 * One check execution, as the probe saw it.
 *
 * `outcome` is what happened to the *check*, not what state the sensor is in. Limits, lookups
 * and the state machine are the core's business (WORKFLOW.MD §4) — a probe that decided states
 * for itself could not have its thresholds edited without a config push, and two probes could
 * disagree about the same rule.
 */
export interface CheckResult {
  sensorId: number;
  /** When the check ran, ISO-8601. The probe's clock; the core does not rewrite it. */
  at: string;
  outcome: 'ok' | 'error';
  message: string;
  durationMs: number;
  /** Empty on a failed check: a Down sensor records no channel values (CLAUDE.md). */
  channels: ChannelReading[];
}

/** Why a batch of results was refused. Every one of these is retryable except `invalid`. */
export type NackReason =
  'queue-full' | 'shutting-down' | 'storage-error' | 'unavailable' | 'invalid';

export type RejectCode =
  | 'protocol-version'
  | 'bad-access-key'
  | 'not-approved'
  | 'revoked'
  | 'source-not-allowed'
  | 'internal-error';

export type ProbeToCoreMessage =
  | {
      type: 'hello';
      protocolVersion: number;
      /** Stable probe identity (CAPABILITIES.MD §8). Empty on a probe's very first connection. */
      gid: string;
      displayName: string;
      agentVersion: string;
      accessKey: string;
      /**
       * Fingerprint of the configuration this probe is currently running, or `''` if it has
       * none. The core answers `config-unchanged` when it matches, which is what stops a
       * reconnect after a blip from re-sending five thousand assignments that did not change.
       *
       * Held in memory, deliberately not persisted: a restarted probe has no configuration to
       * keep the fingerprint of, so persisting one would only let it claim to be up to date
       * while scanning nothing.
       */
      configVersion?: string;
    }
  | { type: 'heartbeat'; seq: number; sentAt: string }
  | {
      type: 'results';
      /**
       * Identifies this batch so the acknowledgement can name it. The probe holds the batch in
       * its spool until it is acked, so a lost ack costs a duplicate write, never a lost
       * reading — and duplicates are free, because the unique index on (channel_id, time) makes
       * the write idempotent.
       */
      batchId: string;
      results: CheckResult[];
    }
  | {
      type: 'config-ack';
      version: string;
      /** How many assignments the probe now has scheduled. The core logs any disagreement. */
      scheduled: number;
    }
  | { type: 'bye'; reason: string };

export type CoreToProbeMessage =
  | {
      type: 'welcome';
      protocolVersion: number;
      coreVersion: string;
      /** Identity the core assigned; the probe persists it and presents it next time. */
      gid: string;
      heartbeatIntervalMs: number;
    }
  | { type: 'reject'; code: RejectCode; message: string }
  | { type: 'heartbeat-ack'; seq: number }
  | {
      type: 'results-ack';
      batchId: string;
      /**
       * Readings actually written. Fewer than were sent is normal on replay — the duplicates
       * were already there — and is worth surfacing rather than hiding.
       */
      storedSamples: number;
      /**
       * Backpressure, before it becomes a refusal. Zero means "keep going"; anything else asks
       * the probe to wait that long before offering more. Sending it on the *ack* is what makes
       * the signal gradual: by the time batches are being refused outright it is already too
       * late to be polite about it.
       */
      retryAfterMs: number;
    }
  | {
      type: 'results-nack';
      batchId: string;
      reason: NackReason;
      retryAfterMs: number;
    }
  /** The whole assignment set. Sent on connect, and whenever a delta would be larger. */
  | { type: 'config-set'; version: string; sensors: SensorAssignment[] }
  /**
   * What changed since the version the probe is holding.
   *
   * Only ever sent to a probe the core has already sent a `config-set` to *on this connection*:
   * a delta is relative to state the core knows the peer has, and the core only knows that while
   * the session is alive. After a disconnect the answer is a snapshot or `config-unchanged`,
   * never a delta against a guess.
   */
  | { type: 'config-delta'; version: string; upserted: SensorAssignment[]; removed: number[] }
  /** The probe's fingerprint already matches. Nothing to send, and nothing to apply. */
  | { type: 'config-unchanged'; version: string }
  | { type: 'bye'; reason: string };

export type ProtocolMessage = ProbeToCoreMessage | CoreToProbeMessage;

export class ProtocolError extends AppError {
  constructor(message: string, context?: Record<string, string | number>) {
    super('PROTOCOL_INVALID', message, { context: context ?? {} });
    this.name = 'ProtocolError';
  }
}

// --- Schemas -------------------------------------------------------------------------------
// CLAUDE.md: validate at boundaries with JSON Schema — API inputs, sensor params, config files
// and probe messages. A peer is a boundary even when it is our own code on the other end.

const probeToCoreSchema = {
  type: 'object',
  required: ['type'],
  discriminator: { propertyName: 'type' },
  oneOf: [
    {
      properties: {
        type: { const: 'hello' },
        protocolVersion: { type: 'integer', minimum: 0 },
        gid: { type: 'string', maxLength: 128 },
        displayName: { type: 'string', minLength: 1, maxLength: 240 },
        agentVersion: { type: 'string', maxLength: 64 },
        accessKey: { type: 'string', maxLength: 512 },
        // Optional, not required: a version-2 probe does not send one, and its hello must still
        // validate rather than being refused for speaking the version it advertised.
        configVersion: { type: 'string', maxLength: 128 },
      },
      required: ['type', 'protocolVersion', 'gid', 'displayName', 'agentVersion', 'accessKey'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'heartbeat' },
        seq: { type: 'integer', minimum: 0 },
        sentAt: { type: 'string', minLength: 1, maxLength: 64 },
      },
      required: ['type', 'seq', 'sentAt'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'results' },
        batchId: { type: 'string', minLength: 1, maxLength: 128 },
        results: {
          type: 'array',
          // Bounded here as well as by the 4 MB frame cap, so a malformed peer is refused by
          // the schema with a message rather than by the decoder with a socket reset.
          maxItems: 5000,
          items: {
            type: 'object',
            properties: {
              sensorId: { type: 'integer', minimum: 1 },
              at: { type: 'string', minLength: 1, maxLength: 64 },
              outcome: { type: 'string', enum: ['ok', 'error'] },
              message: { type: 'string', maxLength: 2000 },
              durationMs: { type: 'number', minimum: 0 },
              channels: {
                type: 'array',
                maxItems: 500,
                items: {
                  type: 'object',
                  properties: {
                    key: { type: 'string', minLength: 1, maxLength: 100 },
                    // No NaN and no Infinity: JSON cannot carry them, and a channel whose value
                    // is not a number is a gap, which is the absence of a reading.
                    value: { type: 'number' },
                    name: { type: 'string', minLength: 1, maxLength: 200 },
                    unit: { type: 'string', maxLength: 50 },
                  },
                  required: ['key', 'value'],
                  additionalProperties: false,
                },
              },
            },
            required: ['sensorId', 'at', 'outcome', 'message', 'durationMs', 'channels'],
            additionalProperties: false,
          },
        },
      },
      required: ['type', 'batchId', 'results'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'config-ack' },
        version: { type: 'string', maxLength: 128 },
        scheduled: { type: 'integer', minimum: 0 },
      },
      required: ['type', 'version', 'scheduled'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'bye' },
        reason: { type: 'string', maxLength: 512 },
      },
      required: ['type', 'reason'],
      additionalProperties: false,
    },
  ],
} as const;

/**
 * One assignment on the wire.
 *
 * `params` is `additionalProperties: true` because a sensor type's own `paramsSchema` is what
 * validates it, and that schema lives in the catalogue rather than here. What this bounds is the
 * shape and the size — a peer is a boundary even when it is our own code (CLAUDE.md).
 */
const sensorAssignmentSchema = {
  type: 'object',
  properties: {
    sensorId: { type: 'integer', minimum: 1 },
    sensorType: { type: 'string', minLength: 1, maxLength: 100 },
    params: { type: 'object', additionalProperties: true },
    target: {
      type: 'object',
      properties: {
        host: { type: 'string', maxLength: 255 },
        ipVersion: { type: 'string', enum: ['auto', 'v4', 'v6'] },
      },
      required: ['host', 'ipVersion'],
      additionalProperties: false,
    },
    intervalSeconds: { type: 'integer', minimum: 1, maximum: 86400 },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 3600000 },
  },
  required: ['sensorId', 'sensorType', 'params', 'target', 'intervalSeconds', 'timeoutMs'],
  additionalProperties: false,
} as const;

const coreToProbeSchema = {
  type: 'object',
  required: ['type'],
  discriminator: { propertyName: 'type' },
  oneOf: [
    {
      properties: {
        type: { const: 'welcome' },
        protocolVersion: { type: 'integer', minimum: 0 },
        coreVersion: { type: 'string', maxLength: 64 },
        gid: { type: 'string', minLength: 1, maxLength: 128 },
        heartbeatIntervalMs: { type: 'integer', minimum: 1000, maximum: 300000 },
      },
      required: ['type', 'protocolVersion', 'coreVersion', 'gid', 'heartbeatIntervalMs'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'reject' },
        code: {
          type: 'string',
          enum: [
            'protocol-version',
            'bad-access-key',
            'not-approved',
            'revoked',
            'source-not-allowed',
            'internal-error',
          ],
        },
        message: { type: 'string', maxLength: 512 },
      },
      required: ['type', 'code', 'message'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'heartbeat-ack' },
        seq: { type: 'integer', minimum: 0 },
      },
      required: ['type', 'seq'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'results-ack' },
        batchId: { type: 'string', minLength: 1, maxLength: 128 },
        storedSamples: { type: 'integer', minimum: 0 },
        retryAfterMs: { type: 'integer', minimum: 0 },
      },
      required: ['type', 'batchId', 'storedSamples', 'retryAfterMs'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'results-nack' },
        batchId: { type: 'string', minLength: 1, maxLength: 128 },
        reason: {
          type: 'string',
          enum: ['queue-full', 'shutting-down', 'storage-error', 'unavailable', 'invalid'],
        },
        retryAfterMs: { type: 'integer', minimum: 0 },
      },
      required: ['type', 'batchId', 'reason', 'retryAfterMs'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'config-set' },
        version: { type: 'string', maxLength: 128 },
        sensors: {
          type: 'array',
          // The same bound as a result batch, and for the same reason: refused by the schema
          // with a message rather than by the decoder with a socket reset.
          maxItems: 5000,
          items: sensorAssignmentSchema,
        },
      },
      required: ['type', 'version', 'sensors'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'config-delta' },
        version: { type: 'string', maxLength: 128 },
        upserted: { type: 'array', maxItems: 5000, items: sensorAssignmentSchema },
        removed: { type: 'array', maxItems: 5000, items: { type: 'integer', minimum: 1 } },
      },
      required: ['type', 'version', 'upserted', 'removed'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'config-unchanged' },
        version: { type: 'string', maxLength: 128 },
      },
      required: ['type', 'version'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'bye' },
        reason: { type: 'string', maxLength: 512 },
      },
      required: ['type', 'reason'],
      additionalProperties: false,
    },
  ],
} as const;

const ajv = new Ajv({ allErrors: true, discriminator: true, strict: false });

const validateProbeToCore = ajv.compile<ProbeToCoreMessage>(probeToCoreSchema);
const validateCoreToProbe = ajv.compile<CoreToProbeMessage>(coreToProbeSchema);

function describeErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((e) => `${e.instancePath === '' ? '(root)' : e.instancePath}: ${e.message ?? 'invalid'}`)
    .join('; ');
}

/** Parses a decoded frame from a probe. Throws `ProtocolError` on anything unrecognised. */
export function parseProbeToCore(value: unknown): ProbeToCoreMessage {
  if (!validateProbeToCore(value)) {
    throw new ProtocolError(
      `unrecognised message from probe: ${describeErrors(validateProbeToCore)}`,
    );
  }
  return value;
}

/** Parses a decoded frame from the core. */
export function parseCoreToProbe(value: unknown): CoreToProbeMessage {
  if (!validateCoreToProbe(value)) {
    throw new ProtocolError(
      `unrecognised message from core: ${describeErrors(validateCoreToProbe)}`,
    );
  }
  return value;
}

/**
 * Version negotiation. Incompatibility is reported, never silently tolerated — R-06 turns this
 * into an operator-visible condition rather than a peer that misbehaves in subtle ways.
 */
export function isProtocolCompatible(peerVersion: number): boolean {
  return (
    Number.isInteger(peerVersion) &&
    peerVersion >= MIN_PROTOCOL_VERSION &&
    peerVersion <= PROTOCOL_VERSION
  );
}
