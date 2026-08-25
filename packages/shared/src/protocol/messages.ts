import { Ajv, type ValidateFunction } from 'ajv';
import { AppError } from '../errors/app-error.js';

/**
 * The core↔probe wire protocol.
 *
 * Phase 0 carried a versioned handshake and a heartbeat; version 2 adds check results and their
 * acknowledgement (S-07). Configuration deltas and the rest of spool replay arrive later as new
 * members of these unions — which is why they are discriminated unions rather than one message
 * type with optional fields.
 */

/**
 * Bumped whenever a change is not backwards compatible. Negotiated in the handshake.
 *
 * Version 2 added `results`, `results-ack` and `results-nack`. A version-2 probe talking to a
 * version-1 core would send results the core cannot parse, so the bump is what turns that into
 * a clean rejection at the handshake instead of a dropped connection later.
 */
export const PROTOCOL_VERSION = 2;

/**
 * The oldest peer version this build still understands.
 *
 * Still 1: a version-1 probe never sends results, so an older probe against this core simply
 * heartbeats. There is nothing to break, and forcing an upgrade in lockstep would defeat the
 * point of negotiating at all.
 */
export const MIN_PROTOCOL_VERSION = 1;

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
        type: { const: 'bye' },
        reason: { type: 'string', maxLength: 512 },
      },
      required: ['type', 'reason'],
      additionalProperties: false,
    },
  ],
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
