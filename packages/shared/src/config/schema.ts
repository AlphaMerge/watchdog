/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion --
   Each nested object carries `default: {}` so ajv's `useDefaults` walks into it and fills the
   leaves. `JSONSchemaType` insists a default is a complete `T`, so the cast is what tsc needs;
   the lint rule reads the same types and disagrees. tsc is the authority. */
import type { JSONSchemaType } from 'ajv';

/**
 * Configuration is validated at the boundary (CLAUDE.md: "validate at boundaries with JSON
 * Schema"). Defaults live in the schema itself, so the defaults layer and the validation
 * layer can never drift apart.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface ServiceConfig {
  /** Identifies this process in logs and self-monitoring. */
  name: string;
  /** Base directory for state that must survive a restart. */
  dataDir: string;
  logLevel: LogLevel;
  /** Human-readable log output. Never enable in production — logs must stay structured. */
  logPretty: boolean;
  /** Upper bound on graceful shutdown before the process exits anyway. */
  shutdownTimeoutMs: number;
}

export interface TlsConfig {
  certFile: string;
  keyFile: string;
  /** CA used to verify the peer. mTLS both ways on the probe channel. */
  caFile: string;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  poolSize: number;
  connectTimeoutMs: number;
  /**
   * Apply pending schema migrations at start-up.
   *
   * On by default: this is a standalone product an operator upgrades by unpacking a tarball and
   * restarting, and a service that refuses to start until someone runs a second command is a
   * support ticket. Turn it off where schema changes are gated by a change process — then run
   * `ms-core migrate up` deliberately.
   */
  autoMigrate: boolean;
}

export interface HousekeepingConfig {
  /** Turn the loop off entirely. Only sane on a core that will never own the data lifecycle. */
  enabled: boolean;
  /** How often the loop runs. Each pass does a bounded slice of work and then sleeps. */
  intervalSeconds: number;
  /**
   * How long after a bucket closes before it is rolled up.
   *
   * Nothing is lost by waiting: a bucket is only rolled up once every reading inside it has
   * landed, and a reading that arrives later still gets in through the backfill queue. The lag
   * exists so the common case — a batch of samples written a second after the minute — does not
   * need the queue at all.
   */
  rollupLagSeconds: number;
  /** Days of history kept per data class (WORKFLOW.MD §9). */
  retention: {
    rawDays: number;
    fiveMinuteDays: number;
    hourlyDays: number;
    dailyDays: number;
    /**
     * Configuration audit entries. Longer than the raw data on purpose: "who changed this, and
     * when" is asked about changes made long after the readings around them have been rolled up.
     */
    auditDays: number;
  };
  /**
   * Age at which a chunk is compressed. Measured at 12.5x on raw readings
   * (docs/findings/2026-08-25-rollup-storage-spike.md). Compressing too eagerly is not a
   * correctness problem — writes into a compressed chunk still work — but it is slower, so the
   * default leaves a week of raw data in row storage where a probe replay can land cheaply.
   */
  compression: {
    rawAfterDays: number;
    fiveMinuteAfterDays: number;
  };
}

export interface IngestionConfig {
  /**
   * Readings held in memory awaiting a write before further batches are refused.
   *
   * This is the bound in "never queue unboundedly" (CLAUDE.md). Refusing is safe because the
   * probe has not been acked and still holds the batch in its disk spool (R-02): the readings
   * wait on the probe's disk rather than in the core's heap, which is where a backlog belongs.
   */
  queueMaxRows: number;
  /** Largest single write. */
  batchMaxRows: number;
  /** How long a partial batch waits for company before being written anyway. */
  batchMaxDelayMs: number;
  /**
   * Queue fill, as a percentage, above which acknowledgements start carrying a slow-down hint.
   *
   * Backpressure has to be gradual to be useful. By the time batches are refused outright the
   * probes have already built a backlog; asking them to ease off at half full is what stops it
   * getting there.
   */
  slowDownAtPercent: number;
  /** How long a probe is asked to wait when it is slowed down or refused. */
  retryAfterMs: number;
}

export interface CoreConfig {
  service: ServiceConfig;
  api: {
    host: string;
    port: number;
    /**
     * Directory of the built web UI, served at `/` by the core itself (ADR-001 Decision 8:
     * there is no second web server to install). Empty serves no UI at all, which is what a
     * headless install or a development run against the Vite dev server wants.
     */
    webRoot: string;
  };
  database: DatabaseConfig;
  ingestion: IngestionConfig;
  housekeeping: HousekeepingConfig;
  probeEndpoint: {
    host: string;
    port: number;
    tls: TlsConfig;
    /**
     * Access keys a probe must present (CAPABILITIES.MD §8). Empty accepts any client that
     * already passed mutual TLS — acceptable in development, not in production.
     */
    accessKeys: string[];
    /** A probe that has not said hello within this window is disconnected. */
    handshakeTimeoutMs: number;
    heartbeatIntervalMs: number;
  };
}

export interface ProbeConfig {
  service: ServiceConfig;
  probe: {
    /** Stable probe identity. Generated at first start if absent. */
    gid: string;
    displayName: string;
    /** Results spool to disk when the core is unreachable (WORKFLOW.MD §10). */
    spoolDir: string;
    spoolMaxBytes: number;
    /**
     * Segment size. Eviction and reclamation both work a whole segment at a time, so this is
     * the granularity of both: smaller wastes less when evicting, larger costs fewer files.
     */
    spoolSegmentMaxBytes: number;
    /** Results per batch offered to the core, which refuses anything over 5,000 either way. */
    spoolBatchMaxRows: number;
    /** 0 means "derive from CPU count". */
    workerPoolSize: number;
    /**
     * Checks that may wait for a worker before further ones are refused.
     *
     * A refused check is counted and skipped, never queued indefinitely: the next scan of that
     * sensor is already scheduled, and a check run ten minutes late answers a question nobody
     * is still asking.
     */
    checkQueueMaxLength: number;
    /**
     * How long a check has to honour its abort before its worker is terminated.
     *
     * The cooperative path costs nothing — an aborted check returns and its worker is reusable.
     * Termination is the backstop for a check that cannot be interrupted, and it costs a worker
     * restart.
     */
    checkAbortGraceMs: number;
  };
  core: {
    host: string;
    port: number;
    accessKey: string;
    tls: TlsConfig;
    reconnectMinDelayMs: number;
    reconnectMaxDelayMs: number;
    heartbeatIntervalMs: number;
  };
}

const logLevels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

function serviceSchema(defaultName: string, defaultDataDir: string): JSONSchemaType<ServiceConfig> {
  return {
    type: 'object',
    default: {} as ServiceConfig,
    additionalProperties: false,
    required: ['name', 'dataDir', 'logLevel', 'logPretty', 'shutdownTimeoutMs'],
    properties: {
      name: { type: 'string', minLength: 1, default: defaultName },
      dataDir: { type: 'string', minLength: 1, default: defaultDataDir },
      logLevel: { type: 'string', enum: logLevels, default: 'info' },
      logPretty: { type: 'boolean', default: false },
      shutdownTimeoutMs: { type: 'integer', minimum: 100, maximum: 300_000, default: 20_000 },
    },
  };
}

const tlsSchema: JSONSchemaType<TlsConfig> = {
  type: 'object',
  default: {} as TlsConfig,
  additionalProperties: false,
  required: ['certFile', 'keyFile', 'caFile'],
  properties: {
    certFile: { type: 'string', default: '' },
    keyFile: { type: 'string', default: '' },
    caFile: { type: 'string', default: '' },
  },
};

export const coreConfigSchema: JSONSchemaType<CoreConfig> = {
  type: 'object',
  additionalProperties: false,
  required: ['service', 'api', 'database', 'ingestion', 'housekeeping', 'probeEndpoint'],
  properties: {
    service: serviceSchema('ms-core', '/var/lib/ms-core'),
    api: {
      type: 'object',
      default: {} as CoreConfig['api'],
      additionalProperties: false,
      required: ['host', 'port', 'webRoot'],
      properties: {
        host: { type: 'string', minLength: 1, default: '127.0.0.1' },
        port: { type: 'integer', minimum: 1, maximum: 65_535, default: 8080 },
        webRoot: { type: 'string', default: '' },
      },
    },
    database: {
      type: 'object',
      default: {} as DatabaseConfig,
      additionalProperties: false,
      required: [
        'host',
        'port',
        'database',
        'user',
        'password',
        'ssl',
        'poolSize',
        'connectTimeoutMs',
        'autoMigrate',
      ],
      properties: {
        host: { type: 'string', minLength: 1, default: '127.0.0.1' },
        port: { type: 'integer', minimum: 1, maximum: 65_535, default: 5432 },
        database: { type: 'string', minLength: 1, default: 'monitoring' },
        user: { type: 'string', minLength: 1, default: 'monitoring' },
        password: { type: 'string', default: '' },
        ssl: { type: 'boolean', default: false },
        // Minimum 2: schema migration holds one client for its advisory lock while the
        // migrations themselves run on another.
        poolSize: { type: 'integer', minimum: 2, maximum: 500, default: 20 },
        connectTimeoutMs: { type: 'integer', minimum: 100, maximum: 120_000, default: 10_000 },
        autoMigrate: { type: 'boolean', default: true },
      },
    },
    ingestion: {
      type: 'object',
      default: {} as IngestionConfig,
      additionalProperties: false,
      required: [
        'queueMaxRows',
        'batchMaxRows',
        'batchMaxDelayMs',
        'slowDownAtPercent',
        'retryAfterMs',
      ],
      properties: {
        // 200,000 readings is about two minutes of the v1 target's output, and a few tens of
        // megabytes of heap. Long enough to ride out a slow write, short enough that a database
        // that has gone away is noticed rather than absorbed.
        queueMaxRows: { type: 'integer', minimum: 1_000, maximum: 10_000_000, default: 200_000 },
        // 1,000, not "as large as it will go". Phase 1's exit criterion is stated in write
        // latency as well as throughput, and the sweep in
        // packages/core/test/ingestion-performance.test.ts shows the trade is one-sided:
        //   1,000 rows/write  3.46M samples/min  p99 38 ms
        //   2,000 rows/write  3.55M samples/min  p99 47 ms
        //   5,000 rows/write  3.76M samples/min  p99 88 ms
        // Nine per cent more throughput for two and a half times the write latency, against a
        // target already exceeded thirty-four times over. There is nothing to buy with a bigger
        // batch, and a p99 sitting on the 100 ms budget is a coin toss rather than a margin.
        batchMaxRows: { type: 'integer', minimum: 100, maximum: 100_000, default: 1_000 },
        batchMaxDelayMs: { type: 'integer', minimum: 1, maximum: 60_000, default: 250 },
        slowDownAtPercent: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        retryAfterMs: { type: 'integer', minimum: 1, maximum: 300_000, default: 1_000 },
      },
    },
    housekeeping: {
      type: 'object',
      default: {} as HousekeepingConfig,
      additionalProperties: false,
      required: ['enabled', 'intervalSeconds', 'rollupLagSeconds', 'retention', 'compression'],
      properties: {
        enabled: { type: 'boolean', default: true },
        // Five minutes matches the finest rollup tier: running more often just re-reads the
        // same closed buckets.
        intervalSeconds: { type: 'integer', minimum: 10, maximum: 86_400, default: 300 },
        rollupLagSeconds: { type: 'integer', minimum: 0, maximum: 86_400, default: 120 },
        retention: {
          type: 'object',
          default: {} as HousekeepingConfig['retention'],
          additionalProperties: false,
          required: ['rawDays', 'fiveMinuteDays', 'hourlyDays', 'dailyDays', 'auditDays'],
          properties: {
            // 40 days of raw is PRTG's figure (CAPABILITIES.MD §9), and the reason its UI
            // refuses sub-hourly detail beyond that point.
            rawDays: { type: 'integer', minimum: 1, maximum: 3_650, default: 40 },
            fiveMinuteDays: { type: 'integer', minimum: 1, maximum: 36_500, default: 365 },
            hourlyDays: { type: 'integer', minimum: 1, maximum: 36_500, default: 730 },
            dailyDays: { type: 'integer', minimum: 1, maximum: 36_500, default: 3_650 },
            auditDays: { type: 'integer', minimum: 1, maximum: 36_500, default: 730 },
          },
        },
        compression: {
          type: 'object',
          default: {} as HousekeepingConfig['compression'],
          additionalProperties: false,
          required: ['rawAfterDays', 'fiveMinuteAfterDays'],
          properties: {
            rawAfterDays: { type: 'integer', minimum: 1, maximum: 3_650, default: 7 },
            fiveMinuteAfterDays: { type: 'integer', minimum: 1, maximum: 36_500, default: 30 },
          },
        },
      },
    },
    probeEndpoint: {
      type: 'object',
      default: {} as CoreConfig['probeEndpoint'],
      additionalProperties: false,
      required: ['host', 'port', 'tls', 'accessKeys', 'handshakeTimeoutMs', 'heartbeatIntervalMs'],
      properties: {
        host: { type: 'string', minLength: 1, default: '0.0.0.0' },
        port: { type: 'integer', minimum: 1, maximum: 65_535, default: 23560 },
        tls: tlsSchema,
        accessKeys: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          default: [],
        },
        handshakeTimeoutMs: { type: 'integer', minimum: 100, maximum: 60_000, default: 10_000 },
        heartbeatIntervalMs: { type: 'integer', minimum: 1_000, maximum: 300_000, default: 10_000 },
      },
    },
  },
};

export const probeConfigSchema: JSONSchemaType<ProbeConfig> = {
  type: 'object',
  additionalProperties: false,
  required: ['service', 'probe', 'core'],
  properties: {
    service: serviceSchema('ms-probe', '/var/lib/ms-probe'),
    probe: {
      type: 'object',
      default: {} as ProbeConfig['probe'],
      additionalProperties: false,
      required: [
        'gid',
        'displayName',
        'spoolDir',
        'spoolMaxBytes',
        'spoolSegmentMaxBytes',
        'spoolBatchMaxRows',
        'workerPoolSize',
        'checkQueueMaxLength',
        'checkAbortGraceMs',
      ],
      properties: {
        gid: { type: 'string', default: '' },
        displayName: { type: 'string', minLength: 1, default: 'Local probe' },
        spoolDir: { type: 'string', minLength: 1, default: '/var/lib/ms-probe/spool' },
        spoolMaxBytes: {
          type: 'integer',
          minimum: 1_048_576,
          default: 2_147_483_648,
        },
        spoolSegmentMaxBytes: {
          type: 'integer',
          minimum: 4_096,
          maximum: 1_073_741_824,
          default: 8_388_608,
        },
        // The core refuses a batch over 5,000 rows, so this cannot usefully exceed it.
        spoolBatchMaxRows: { type: 'integer', minimum: 1, maximum: 5_000, default: 500 },
        workerPoolSize: { type: 'integer', minimum: 0, maximum: 1_024, default: 0 },
        checkQueueMaxLength: { type: 'integer', minimum: 1, maximum: 1_000_000, default: 1_000 },
        checkAbortGraceMs: { type: 'integer', minimum: 100, maximum: 300_000, default: 2_000 },
      },
    },
    core: {
      type: 'object',
      default: {} as ProbeConfig['core'],
      additionalProperties: false,
      required: [
        'host',
        'port',
        'accessKey',
        'tls',
        'reconnectMinDelayMs',
        'reconnectMaxDelayMs',
        'heartbeatIntervalMs',
      ],
      properties: {
        host: { type: 'string', minLength: 1, default: '127.0.0.1' },
        port: { type: 'integer', minimum: 1, maximum: 65_535, default: 23560 },
        accessKey: { type: 'string', default: '' },
        tls: tlsSchema,
        reconnectMinDelayMs: { type: 'integer', minimum: 100, maximum: 60_000, default: 1_000 },
        reconnectMaxDelayMs: { type: 'integer', minimum: 100, maximum: 600_000, default: 60_000 },
        heartbeatIntervalMs: { type: 'integer', minimum: 1_000, maximum: 300_000, default: 10_000 },
      },
    },
  },
};
