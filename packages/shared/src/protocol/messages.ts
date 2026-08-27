import { Ajv, type ValidateFunction } from 'ajv';
import { AppError } from '../errors/app-error.js';

/**
 * The core↔probe wire protocol.
 *
 * Phase 0 carried a versioned handshake and a heartbeat; version 2 added check results and their
 * acknowledgement (S-07); version 3 added the configuration push (R-04); version 4 adds the
 * discovery sweep (D-01). The rest of spool replay arrives later as new members of these
 * unions — which is why they are discriminated unions rather than one message type with
 * optional fields.
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
 *
 * Version 4 added the discovery sweep (D-01). Same rule: the core will not send `sweep-*` to a
 * peer below 4, and a discovery run assigned to such a probe fails saying which probe and what
 * version it is running, rather than waiting for progress that will never come.
 *
 * Version 5 added identification (D-02), which is the sweep's second stage and follows the same
 * shape: a job with a cursor, progress that carries findings, and one finish.
 *
 * Version 6 added approval (R-01). A `welcome` now says whether the probe is *approved*, and a
 * probe that is not gets an identity, a heartbeat and no configuration — so it waits in an
 * administrator's queue instead of being trusted for having reached the port. The same message
 * may carry a per-probe `accessKey`, issued once at approval, which is what makes revoking one
 * probe possible without rotating the enrolment key every other probe shares.
 */
export const PROTOCOL_VERSION = 6;

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
  /**
   * Decrypted credential sets for the kinds this sensor's type declared (`A-05`).
   *
   * **Secrets on the wire, deliberately, and only on this wire.** The probe is the thing that
   * authenticates to the device, so it has to hold them; the alternatives are giving every probe
   * the vault key or moving the protocol into the core, and both are worse. What bounds it: the
   * channel is mutual TLS, only the kinds a sensor's type declares are sent, and only to the
   * probe that owns that sensor — a Ping probe never receives an SNMP community string.
   *
   * The probe keeps assignments in memory and writes none of them to disk. Its only file is the
   * result spool, which carries check outcomes and never parameters.
   */
  credentials?: Record<string, Record<string, unknown>>;
}

/** A single channel's reading inside a check result. */
export interface ChannelReading {
  /** Stable within the sensor, assigned by the sensor type — not the display name. */
  key: string;
  value: number;
  /**
   * The exact counter, as decimal text, for a channel its type declared a counter (`T-02`).
   *
   * Text and not a number, and this is the whole reason the field exists: `ifHCInOctets` is the
   * counter designed to go past 2^53 — about nine days on a 100 Gbit/s link — and that is where
   * a double starts dropping low bits. A rate computed from a rounded counter is wrong by
   * whatever was rounded away, quietly, on exactly the busy links anyone is watching.
   *
   * `value` is still sent, and is the same number lossily: it is what a build that does not know
   * about counters would store, and what a log line shows. The core uses this field.
   */
  counter?: string;
  /**
   * The width the device's counter actually was, when it differs from what the type declared.
   *
   * Discovered rather than declared: `snmp.traffic` prefers `ifHCInOctets` and falls back to the
   * 32-bit counters per device, so a channel created as 64-bit can legitimately be fed 32-bit
   * values. Getting this wrong is not a rounding error — a 32-bit wrap read as a 64-bit counter
   * looks exactly like a device that rebooted, so every wrap would be a gap in the graph rather
   * than a rate, and on a gigabit link that is every thirty-four seconds.
   */
  counterBits?: 32 | 64;
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

/**
 * A sweep a probe has been told to run (`D-01`).
 *
 * **The range is sent as text and parsed on the probe**, rather than as a list of addresses.
 * 65,536 addresses is about a megabyte of JSON to say what forty characters say, it would have
 * to be re-sent on every resume, and `@ms/shared` gives both ends the same parser — so the two
 * cannot disagree about what the text means.
 */
export interface SweepJob {
  runId: number;
  /** The range, in the spelling the operator typed. Parsed by `parseIpRange` at both ends. */
  range: string;
  /**
   * Where to start, as a count of addresses already offered.
   *
   * **This is the whole of resumability.** A restarted probe, a reconnect and a core failover
   * all resume by sending the cursor the core has durably recorded; an iterator would survive
   * none of them. Re-sweeping a few addresses after a crash is free — a host found twice is the
   * same host — so the cursor is advanced on acknowledgement rather than on send.
   */
  cursor: number;
  /** Milliseconds a single address waits for a reply before it counts as no answer. */
  timeoutMs: number;
  /**
   * How many addresses may be in flight at once.
   *
   * Bounded here rather than by the probe alone so an operator sweeping a lab can go faster and
   * one sweeping a production VLAN can go slower. It is a ceiling either way: the probe also
   * yields to its own check pool, because a discovery run that delays live checks has traded a
   * one-off convenience for the thing the system exists to do.
   */
  concurrency: number;
  /** Addresses per second, averaged. Zero means the concurrency bound is the only limit. */
  ratePerSecond: number;
}

/** One address a sweep found alive, with what it cost to find out. */
export interface SweepHost {
  /** Dotted-quad. Text rather than the integer, because everything downstream reads it. */
  address: string;
  rttMs: number;
}

/**
 * An identification pass a probe has been told to run (`D-02`).
 *
 * **The addresses are sent, unlike the sweep's range**, and the difference is not an
 * inconsistency. A range is a rule that generates addresses and compresses to forty characters; a
 * list of *live* hosts is data the core holds and the probe does not, and there is no rule that
 * regenerates it. It is also far smaller — the hosts a /24 sweep found, not the 254 it tried.
 */
export interface IdentifyJob {
  runId: number;
  /** Dotted-quads, in the order the core wants them tried. */
  addresses: string[];
  /** Where to resume: how many of `addresses` have already been offered. */
  cursor: number;
  /** Per-probe budget, applied to each source rather than to the whole host. */
  timeoutMs: number;
  concurrency: number;
  /**
   * TCP ports to ask about, from the run's level (`D-06`).
   *
   * Sent rather than left to the probe's own default, so the level decides in one place and the
   * estimate an operator was shown is about the run that actually happens. Absent on a probe
   * built before `D-06`, which falls back to its own list — the standard set, which is what
   * such a probe would have used anyway.
   */
  ports?: number[];
  /**
   * The SNMP community to try, or empty to skip SNMP.
   *
   * The one credential identification has. A community is not a secret in any useful sense —
   * it travels unencrypted in every v2c packet — but it is still an operator's configuration, so
   * it goes over the same mutual-TLS channel every other credential does.
   */
  community: string;
}

/** Why a sweep stopped. Only `done` means the range was covered. */
export type SweepEnding = 'done' | 'cancelled' | 'failed' | 'superseded';

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
      /**
       * Results still on disk *after* this batch, or absent when the probe does not track it.
       *
       * Only the probe knows this, and without it the core cannot tell a live batch from a
       * probe replaying an hour of backlog — so it has to slow both down alike, which is
       * precisely how a catch-up stalls everyone else's live ingestion (R-03).
       */
      backlog?: number;
    }
  | {
      type: 'config-ack';
      version: string;
      /** How many assignments the probe now has scheduled. The core logs any disagreement. */
      scheduled: number;
    }
  | {
      /**
       * How far a sweep has got, and what it found (`D-01`).
       *
       * Progress and findings in one message on purpose. They are the same fact — "these
       * addresses have been offered, and these of them answered" — and splitting them would let
       * the core record a cursor past a host whose reply had not arrived yet, which is a host
       * silently missed on the one run that mattered.
       */
      type: 'sweep-progress';
      runId: number;
      /** Addresses offered so far, counted from the start of the range, not of this session. */
      cursor: number;
      /** Alive since the last progress message. Empty is an ordinary and common message. */
      found: SweepHost[];
      /** Addresses that could not be attempted at all — no route, no permission to ping. */
      failed: number;
    }
  | {
      type: 'sweep-finished';
      runId: number;
      ending: SweepEnding;
      cursor: number;
      /** Empty unless `ending` is `failed`, where it is what to tell the operator. */
      message: string;
    }
  | {
      /**
       * Hosts identified since the last message (`D-02`).
       *
       * Fingerprints and the cursor together, for the reason the sweep sends hosts and its cursor
       * together: they are the same fact, and a cursor recorded past a fingerprint that had not
       * arrived is a host that never gets identified and never gets asked again.
       */
      type: 'identify-progress';
      runId: number;
      cursor: number;
      /** JSON, validated against the fingerprint shape by the core rather than by the schema. */
      found: unknown[];
    }
  | {
      type: 'identify-finished';
      runId: number;
      ending: SweepEnding;
      cursor: number;
      message: string;
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
      /**
       * Whether an administrator has approved this probe (`R-01`).
       *
       * **A welcome rather than a rejection, and that is deliberate.** An unapproved probe is
       * not an attacker — it is a machine somebody has just installed — so it is let in far
       * enough to be *seen*: it gets its identity, it heartbeats, and it appears in the
       * approval queue with the name and version it reported. What it does not get is any
       * configuration, so it scans nothing at all until a person says so. Rejecting it instead
       * would leave the administrator approving something they cannot see, and would make the
       * probe re-enrol under a new identity on every retry.
       *
       * Optional so a version-5 core, which never sends it, still reads as approved — that
       * core had no notion of approval and trusted whatever presented the access key.
       */
      approved?: boolean;
      /**
       * A key issued to this probe alone, sent once, at the moment it is approved.
       *
       * The probe persists it and presents it from then on instead of the shared enrolment key.
       * That is the whole point of issuing one: revoking a single probe otherwise means
       * rotating the key every probe in the installation shares, which nobody does, which means
       * in practice nothing is ever revoked. The core keeps only a hash.
       */
      accessKey?: string;
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
  /** Start or resume a sweep (`D-01`). Sending one for a run already running resumes it. */
  | { type: 'sweep-start'; job: SweepJob }
  /**
   * Stop a sweep.
   *
   * Cancellation is a message rather than a disconnect because a sweep must stop *promptly* —
   * an operator who typed the wrong range wants the pings to stop now, not when the last of
   * 65,536 timeouts expires.
   */
  | { type: 'sweep-cancel'; runId: number }
  /** Identify the hosts a sweep found (`D-02`). Resent to resume, exactly as `sweep-start` is. */
  | { type: 'identify-start'; job: IdentifyJob }
  | { type: 'identify-cancel'; runId: number }
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
        // Optional, so a version-3 probe that does not report one still validates. Absent is
        // read as "unknown", which is paced like a live batch — the behaviour before R-03.
        backlog: { type: 'integer', minimum: 0 },
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
                    // The exact counter and the width it was read at (`T-02`). Text because an
                    // unsigned 64-bit counter does not survive a double, and 20 digits is the
                    // most one can have.
                    counter: { type: 'string', pattern: '^[0-9]{1,20}$' },
                    counterBits: { type: 'integer', enum: [32, 64] },
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
        type: { const: 'sweep-progress' },
        runId: { type: 'integer', minimum: 1 },
        cursor: { type: 'integer', minimum: 0 },
        found: {
          type: 'array',
          // A batch bound rather than a run bound: a /16 where everything answers is 65,534
          // hosts, and they arrive across many progress messages.
          maxItems: 4096,
          items: {
            type: 'object',
            properties: {
              address: { type: 'string', minLength: 7, maxLength: 15 },
              rttMs: { type: 'number', minimum: 0 },
            },
            required: ['address', 'rttMs'],
            additionalProperties: false,
          },
        },
        failed: { type: 'integer', minimum: 0 },
      },
      required: ['type', 'runId', 'cursor', 'found', 'failed'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'sweep-finished' },
        runId: { type: 'integer', minimum: 1 },
        ending: { type: 'string', enum: ['done', 'cancelled', 'failed', 'superseded'] },
        cursor: { type: 'integer', minimum: 0 },
        message: { type: 'string', maxLength: 2000 },
      },
      required: ['type', 'runId', 'ending', 'cursor', 'message'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'identify-progress' },
        runId: { type: 'integer', minimum: 1 },
        cursor: { type: 'integer', minimum: 0 },
        // `unknown` items, validated by the core rather than here. A fingerprint is a growing
        // shape — `D-03` will want fields this build has not thought of — and a wire schema that
        // enumerated them would refuse a newer probe's perfectly good answer outright, which is
        // the one failure mode a version negotiation is supposed to prevent.
        found: { type: 'array', maxItems: 1024 },
      },
      required: ['type', 'runId', 'cursor', 'found'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'identify-finished' },
        runId: { type: 'integer', minimum: 1 },
        ending: { type: 'string', enum: ['done', 'cancelled', 'failed', 'superseded'] },
        cursor: { type: 'integer', minimum: 0 },
        message: { type: 'string', maxLength: 2000 },
      },
      required: ['type', 'runId', 'ending', 'cursor', 'message'],
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
    // Decrypted credential sets, keyed by kind (`A-05`). `additionalProperties: true` inside
    // each, because a kind's own schema is what validates it and that lives in the catalogue —
    // the same division `params` above follows.
    credentials: {
      type: 'object',
      additionalProperties: { type: 'object', additionalProperties: true },
    },
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
        approved: { type: 'boolean' },
        accessKey: { type: 'string', minLength: 1, maxLength: 512 },
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
        type: { const: 'sweep-start' },
        job: {
          type: 'object',
          properties: {
            runId: { type: 'integer', minimum: 1 },
            // The range as text, bounded: a comma-separated list long enough to exceed this is
            // an operator pasting something that is not a range.
            range: { type: 'string', minLength: 1, maxLength: 4000 },
            cursor: { type: 'integer', minimum: 0 },
            timeoutMs: { type: 'integer', minimum: 100, maximum: 60000 },
            concurrency: { type: 'integer', minimum: 1, maximum: 512 },
            ratePerSecond: { type: 'number', minimum: 0, maximum: 100000 },
          },
          required: ['runId', 'range', 'cursor', 'timeoutMs', 'concurrency', 'ratePerSecond'],
          additionalProperties: false,
        },
      },
      required: ['type', 'job'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'sweep-cancel' },
        runId: { type: 'integer', minimum: 1 },
      },
      required: ['type', 'runId'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'identify-start' },
        job: {
          type: 'object',
          properties: {
            runId: { type: 'integer', minimum: 1 },
            // The hosts a sweep found, which is bounded by the sweep's own maximum range.
            addresses: {
              type: 'array',
              maxItems: 65536,
              items: { type: 'string', minLength: 7, maxLength: 15 },
            },
            cursor: { type: 'integer', minimum: 0 },
            timeoutMs: { type: 'integer', minimum: 100, maximum: 60000 },
            concurrency: { type: 'integer', minimum: 1, maximum: 128 },
            community: { type: 'string', maxLength: 128 },
            // Optional, so a probe and a core one version apart still agree on the message.
            ports: {
              type: 'array',
              maxItems: 64,
              items: { type: 'integer', minimum: 1, maximum: 65535 },
            },
          },
          required: ['runId', 'addresses', 'cursor', 'timeoutMs', 'concurrency', 'community'],
          additionalProperties: false,
        },
      },
      required: ['type', 'job'],
      additionalProperties: false,
    },
    {
      properties: {
        type: { const: 'identify-cancel' },
        runId: { type: 'integer', minimum: 1 },
      },
      required: ['type', 'runId'],
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
