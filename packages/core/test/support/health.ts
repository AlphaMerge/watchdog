import { CoreHealthService, type CoreHealthSources } from '../../src/health/core-health.js';
import { ProbeHealthService } from '../../src/health/probe-health.js';
import type { Database } from '../../src/db/pool.js';
import type { ProbeLink } from '../../src/transport/probe-endpoint.js';
import { silent } from './tree.js';
import { everyVoucherHolds } from './vouching.js';

/**
 * Core Health over fixed readings, for a test about what is done with the numbers rather than
 * how they are taken: the metrics export, and the routes that serve them (`A-31`).
 */
export function fixedCoreHealth(
  db: Database,
  options: {
    /** What the disk reads; a gap by default, as on a core whose database is elsewhere. */
    readonly disk?: CoreHealthSources['disk'];
    /** False for a v1 core, which runs no reporting and so has no report source (`H-12`). */
    readonly reporting?: boolean;
    /** Writes of the late-refusal record given up (`A-68`); no source, and a gap, when absent. */
    readonly lateRefusalWritesGivenUp?: () => number;
    /** Probe hellos refused unproven (`P-319`); no source, and a gap, when absent. */
    readonly probeHellosUnproven?: () => number;
  } = {},
): CoreHealthService {
  return new CoreHealthService({
    vouching: everyVoucherHolds,
    db,
    logger: silent,
    sources: {
      disk: options.disk ?? (() => null),
      evictedChunks: () => 0,
      machineMemory: () => ({
        availablePercent: 42.5,
        availableBytes: 3_400 * 1024 * 1024,
        totalBytes: 8_000 * 1024 * 1024,
      }),
      limitMemory: () => null,
      ingestion: () => ({
        queuedRows: 41,
        refusedRows: 7,
        dependencyPauses: 3,
        deferredReactions: 0,
        writeMs: { p95: 12.5 },
      }),
      stream: () => ({
        overflowed: 2,
        severed: 0,
        probeCoalesced: 0,
        signedOut: { ended: 0, expired: 0, revoked: 0, disabled: 0 },
        credentialCheckFailures: 0,
        unsure: 0,
        checksOutstanding: 0,
        edgesUnvetted: 0,
        withheld: 0,
        edgesCoalesced: 0,
      }),
      probes: () => ({ probesDown: 1, probesSilent: 2 }),
      alarms: () => ({ fired: 6, overdueMs: 0 }),
      ...(options.reporting === false
        ? {}
        : {
            reports: () => ({
              deferred: 5,
              failed: 3,
              undelivered: 4,
              formatsWaiting: 2,
              formatsRefused: 1,
            }),
          }),
      queries: () => ({ refused: 2, unfit: 2 }),
      ingestionDiscards: () => ({
        discardedFutureTime: 0,
        discardedPastTime: 0,
        discardedUnreadableTime: 0,
        refusedUnfit: 3,
        discardedUnfitReadings: 5,
        channelsCreatedUndeclared: 6,
      }),
      delivery: () => Promise.resolve({ pending: 9, failed: 4, oldestPendingAgeMs: 125_000 }),
      credentialsToReenter: () => Promise.resolve(0),
      ...(options.lateRefusalWritesGivenUp === undefined
        ? {}
        : { lateRefusalWritesGivenUp: options.lateRefusalWritesGivenUp }),
      ...(options.probeHellosUnproven === undefined
        ? {}
        : { probeHellosUnproven: options.probeHellosUnproven }),
      database: () => ({ statements: 4, locks: 3 }),
    },
    ingest: () => Promise.resolve(),
  });
}

/** Probe Health reading every probe through one link. */
export function probeHealthOver(db: Database, link: ProbeLink): ProbeHealthService {
  return new ProbeHealthService({
    vouching: everyVoucherHolds,
    db,
    logger: silent,
    sources: { link: () => link },
    ingest: () => Promise.resolve(),
  });
}

/**
 * A healthy, connected probe.
 *
 * The connected arm rather than the union: spreading a union loses the discriminant, so every
 * `{ ...connectedLink, health: … }` would stop type-checking against the other arm.
 */
export const connectedLink: Extract<ProbeLink, { connected: true }> = {
  connected: true,
  gid: 'probe-gid',
  clockOffsetMs: null,
  protocolVersion: 7,
  connectedAt: new Date(),
  lastHeartbeatAt: new Date(),
  approved: true,
  agentVersion: '1.0.0',
  assignedSensors: 120,
  cadenceSeconds: 60,
  connectedForMs: Number.MAX_SAFE_INTEGER,
  sinceResultsMs: 0,
  sinceConfigMs: 0,
  configured: true,
  configurable: true,
  lastResultsAt: new Date(),
  configSentAt: new Date(),
  health: {
    scheduled: 120,
    schedulerLagMs: { p50: 2, p95: 11, p99: 30, max: 90 },
    poolSize: 48,
    poolBusy: 12,
    queued: 3,
    queueWaitMs: { p50: 1, p95: 40, p99: 90, max: 500 },
    deferred: 7,
    refused: 2,
    timedOut: 0,
    workerCrashes: 0,
    spoolPending: 500,
    spoolBytes: 2 * 1024 * 1024,
    spoolDropped: 4,
    clockJumps: 1,
    memoryMb: 210,
    uptimeSeconds: 3_600,
  },
};
