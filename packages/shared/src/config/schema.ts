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
  /**
   * How catch-up is paced so it cannot stall live ingestion (R-03).
   *
   * The queue's own `retryAfterMs` is one global signal and slows every probe alike. This
   * applies only to probes reporting a backlog, in proportion to how many are catching up at
   * once, so a probe reporting a check that just ran is never queued behind a fleet replaying
   * their spools.
   */
  replay: {
    maxConcurrentProbes: number;
    stepMs: number;
    maxDelayMs: number;
    idleAfterMs: number;
  };
}

/**
 * One SMTP relay (`N-07`, `CAPABILITIES.MD §5.2`).
 *
 * Configuration rather than an API resource, and deliberately: it holds a password, it is set
 * once per installation by whoever runs the service, and a file the operating system protects is
 * a better place for a credential than a table any administrator can read.
 */
export interface SmtpRelay {
  /** Empty disables this relay. An installation with no primary sends no email at all. */
  host: string;
  port: number;
  /**
   * How TLS is negotiated.
   *
   * `starttls` is the common case — connect in the clear on 587 and upgrade — and `tls` is
   * implicit TLS on 465. `none` exists because a relay on localhost is a real deployment, and
   * refusing it would push operators towards disabling certificate checks instead, which is
   * worse.
   */
  security: 'none' | 'starttls' | 'tls';
  /**
   * Whether the relay's certificate must verify.
   *
   * Separate from `security` because they fail differently: an unverified certificate on an
   * encrypted connection is a weaker guarantee, not none, and an operator with an internal CA
   * needs to be able to say so without dropping to plaintext.
   */
  verifyCertificate: boolean;
  /** `none`, or the SASL mechanism to force. `auto` lets the relay's EHLO decide. */
  auth: 'none' | 'auto' | 'plain' | 'login' | 'cram-md5';
  user: string;
  password: string;
  /**
   * What this host calls itself in EHLO.
   *
   * Some relays refuse a HELO that does not resolve, and a container's hostname rarely does.
   * Empty uses the machine's own name.
   */
  heloName: string;
  timeoutMs: number;
}

export interface SmtpConfig {
  /** Where mail is sent from, unless a template overrides it. */
  sender: string;
  primary: SmtpRelay;
  /**
   * Tried when the primary fails, and only then.
   *
   * Paessler's own advice is two delivery paths per trigger; this is the cheaper half of it —
   * one relay going down should not silence an installation. A fallback with an empty host is no
   * fallback, which is the default.
   */
  fallback: SmtpRelay;
}

/**
 * HTTP action delivery (`N-08`).
 *
 * The interesting field is `targetPolicy`, and the interesting thing about it is that the default
 * is *not* "block everything private". A monitoring system lives inside the network it watches —
 * an internal ticketing system, a self-hosted chat server, a script on the same machine are all
 * ordinary webhook targets — and a guard that refused them would be switched off within the hour,
 * which is a worse outcome than a narrower guard nobody disables.
 *
 * `link-local` blocks the one range that is never a legitimate webhook target and is a known
 * credential-theft vector: `169.254.169.254` and its IPv6 equivalents, where every cloud provider
 * parks the instance-metadata service that hands out IAM credentials to anything that asks.
 */
export interface WebhookConfig {
  targetPolicy: 'link-local' | 'private' | 'none';
  /** How many redirects to follow. Zero refuses them outright. */
  maxRedirects: number;
  userAgent: string;
}

/**
 * Running a program as a notification (`N-10`).
 *
 * **`directory` is the whole security model, and it is not optional.** Without it, anybody who
 * can create a notification template can name any path on the machine and have the core run it
 * as the service account — an editor permission becomes code execution. So a template names a
 * file *inside* this directory and nothing else: no absolute paths, no `..`, and the resolved
 * real path has to still be under it, because a symlink is a path too. Empty disables the method
 * outright, which is the default: an installation that has not deliberately set this up cannot
 * run programs at all.
 */
export interface ProgramConfig {
  /** Where notification programs live. Empty disables the method. */
  directory: string;
  /** Bytes of stdout and of stderr kept and logged. */
  maxOutputBytes: number;
  /** How long a timed-out program has to end on `SIGTERM` before `SIGKILL`. */
  killGraceMs: number;
  /**
   * POSIX uid and gid to run a program as. `-1` leaves it as the service account.
   *
   * `-1` because that is what POSIX itself means by "do not change this one" — `setresuid` has
   * always read it that way — rather than a sentinel invented here. Only usable by a core that
   * has the privilege to change user, which a correctly installed one does not; it is here
   * because a hardened installation may want notification scripts to be *less* privileged than
   * the service, and asking for it without the privilege fails loudly with EPERM rather than
   * quietly running as the service account.
   */
  uid: number;
  gid: number;
}

/**
 * When a failed notification is tried again, and when delivery counts as broken (`N-13`).
 *
 * The waits grow — a relay that refused one message will refuse the next one a second later, and
 * hammering it is how a delivery problem becomes a delivery problem *and* a rate-limit problem.
 * Half of each wait is randomised, which is not decoration: a relay that was down for an hour
 * comes back to a queue whose waits all started at the same failure and would otherwise all
 * expire at the same instant.
 */
export interface DeliveryRetryConfig {
  /** The wait after the first failure. Each further failure doubles it, up to the maximum. */
  firstDelaySeconds: number;
  maxDelaySeconds: number;
  /** After this many attempts a notification is given up on and reported as never delivered. */
  maxAttempts: number;
  /**
   * How long an attempted, still-undelivered notification may wait before delivery is Down.
   *
   * Attempted, deliberately: a notification queued a second ago has not waited for anything, and
   * one that has been tried five times over twenty minutes is a relay that is not coming back on
   * its own.
   */
  staleAfterSeconds: number;
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
  /** What a notification needs to know about this installation (`N-06`). */
  notifications: {
    /**
     * The externally reachable base URL of the web UI, for `%linksensor`.
     *
     * Not derivable from `api.host` and `api.port`: the core usually listens on a loopback or a
     * private address behind a reverse proxy, and a link built from what it binds to would be a
     * link nobody receiving the alarm can open. Empty renders `%linksensor` as the bare object
     * id, which is honest — better than a URL that 404s.
     */
    publicUrl: string;
    /** What this installation is called, for `%sitename`. */
    siteName: string;
    /** The relay email is sent through (`N-07`). */
    smtp: SmtpConfig;
    /** What an HTTP action may reach, and how it behaves (`N-08`). */
    webhook: WebhookConfig;
    /** Where a notification program may live, and how it is bounded (`N-10`). */
    program: ProgramConfig;
    /** How a failed delivery backs off, and when delivery is broken (`N-13`). */
    retry: DeliveryRetryConfig;
  };
  database: DatabaseConfig;
  ingestion: IngestionConfig;
  housekeeping: HousekeepingConfig;
  /** Where monitored-device credentials are encrypted from (`A-05`). */
  vault: VaultConfig;
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
    /**
     * Batch size once there is a backlog. Larger than `spoolBatchMaxRows`: the same rows in
     * fewer round trips clear a backlog sooner, and the core paces catch-up by delay rather
     * than by batch size (R-03).
     */
    spoolCatchUpMaxRows: number;
    /**
     * Checks that may run at once. 0 derives it from the machine.
     *
     * Slots, not cores: a check spends nearly all of its time awaiting a packet, so this bounds
     * *concurrency* rather than CPU. The derived default is four per core with a floor of 16,
     * measured by `P-15` — see `docs/findings/2026-08-26-scheduler-benchmark.md` for what the
     * old core-count default cost, and for the point where more workers start to hurt.
     */
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
    /**
     * Checks that may run in a child process at once (`P-03`).
     *
     * Much smaller than `workerPoolSize`, and it has to be: a worker awaiting a packet costs a
     * slot and almost no memory, where each of these is a Node process of its own. Only sensor
     * types that declare `isolation: 'process'` come here — today that is the EXE/Script family,
     * because a fault in code somebody else wrote must not take the probe down with it.
     */
    processRunnerMaxConcurrent: number;
    processRunnerQueueMaxLength: number;
    /** Heap ceiling for each check process, as `--max-old-space-size`. */
    processMemoryLimitMb: number;
    /**
     * POSIX user and group to run check processes as. 0 means "this probe's own".
     *
     * The point of a separate account is that a script somebody dropped in a directory does not
     * run as the user holding this probe's certificate and credential material. Setting it needs
     * the probe to be started with the privilege to change user, which in practice means root or
     * `CAP_SETUID`; it is ignored on Windows, which has no equivalent this can reach.
     */
    processUid: number;
    processGid: number;
  };
  /**
   * The SNMP trap listener (`T-06`).
   *
   * Off by default, and that is deliberate rather than cautious: it binds a socket, port 162 is
   * privileged, and a probe that silently opened a listening port nobody asked for would be a
   * surprise on somebody's firewall audit. A `snmp.trap` sensor whose probe has this disabled
   * fails its check saying so, which is a better answer than a confident zero.
   */
  trapListener: {
    enabled: boolean;
    /** 162 is the assigned port and needs privilege; 10162 is the usual unprivileged choice. */
    port: number;
    /** The address to bind. `0.0.0.0` accepts from anywhere the host can be reached at. */
    address: string;
    /** udp4 or udp6. One socket, one family — a dual-stack probe runs two probes. */
    transport: 'udp4' | 'udp6';
    /**
     * Community strings that may send v1/v2c notifications. Empty accepts any.
     *
     * A trap community is not a credential in the `A-05` sense: it authenticates the *sender* to
     * the probe rather than the probe to a device, it is the same for every device that sends,
     * and it arrives before any sensor is known. So it is probe configuration, not a per-sensor
     * parameter — and it is not secret in any useful way, since v1 and v2c send it in clear.
     */
    communities: string[];
    /**
     * Notifications held before the oldest is overwritten, across all sensors.
     *
     * The bound that makes a trap flood survivable: a device in a loop can send thousands a
     * second, and an unbounded buffer is a probe that runs out of memory during exactly the
     * incident it was bought for. What is lost is counted per sensor and reported, never
     * dropped silently (CLAUDE.md).
     */
    bufferSize: number;
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

/**
 * One relay's shape.
 *
 * A function rather than a constant because `JSONSchemaType` will not let two properties share
 * one schema object, and because the primary and the fallback differ in exactly one default: an
 * unconfigured fallback has no port either, so an operator who sets only a host gets an error
 * rather than a silent attempt on 587.
 */
function relaySchema(defaultPort: number): JSONSchemaType<SmtpRelay> {
  return {
    type: 'object',
    default: {} as SmtpRelay,
    additionalProperties: false,
    required: [
      'host',
      'port',
      'security',
      'verifyCertificate',
      'auth',
      'user',
      'password',
      'heloName',
      'timeoutMs',
    ],
    properties: {
      host: { type: 'string', default: '' },
      port: { type: 'integer', minimum: 0, maximum: 65_535, default: defaultPort },
      security: { type: 'string', enum: ['none', 'starttls', 'tls'], default: 'starttls' },
      verifyCertificate: { type: 'boolean', default: true },
      auth: {
        type: 'string',
        enum: ['none', 'auto', 'plain', 'login', 'cram-md5'],
        default: 'none',
      },
      user: { type: 'string', default: '' },
      password: { type: 'string', default: '' },
      heloName: { type: 'string', default: '' },
      timeoutMs: { type: 'integer', minimum: 100, maximum: 300_000, default: 20_000 },
    },
  };
}

/**
 * The credential vault's key (`A-05`).
 *
 * A file rather than the OS keystore, and the reasoning is in `vault/keyring.ts`: on Linux the
 * keystore is libsecret over a *session* D-Bus, which a systemd system service does not have,
 * and on Windows it is DPAPI through a native addon. Neither survives CLAUDE.md's first
 * constraint — production is a standalone native service.
 */
export interface VaultConfig {
  /**
   * Path to the key file. Relative paths resolve against the service's data directory.
   *
   * The file is created with mode 0600 at first start if it is absent, and a load refuses a file
   * any other user can read. Back it up: losing it loses every stored device credential, and
   * nothing else.
   */
  keyFile: string;
  /**
   * Whether to create a key file that is not there.
   *
   * True is right for an ordinary install. False is for an operator who restores the key from a
   * backup as part of provisioning and wants a missing one to stop the core rather than be
   * papered over with a new key that silently orphans every stored credential.
   */
  create: boolean;
}

export const coreConfigSchema: JSONSchemaType<CoreConfig> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'service',
    'api',
    'notifications',
    'database',
    'ingestion',
    'housekeeping',
    'vault',
    'probeEndpoint',
  ],
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
    notifications: {
      type: 'object',
      default: {} as CoreConfig['notifications'],
      additionalProperties: false,
      required: ['publicUrl', 'siteName', 'smtp'],
      properties: {
        publicUrl: { type: 'string', default: '' },
        siteName: { type: 'string', default: 'MonitoringSystem' },
        smtp: {
          type: 'object',
          default: {} as SmtpConfig,
          additionalProperties: false,
          required: ['sender', 'primary', 'fallback'],
          properties: {
            sender: { type: 'string', default: '' },
            primary: relaySchema(587),
            // Nothing by default: a fallback nobody configured must not quietly become a second
            // attempt against the same host.
            fallback: relaySchema(0),
          },
        },
        webhook: {
          type: 'object',
          default: {} as WebhookConfig,
          additionalProperties: false,
          required: ['targetPolicy', 'maxRedirects', 'userAgent'],
          properties: {
            targetPolicy: {
              type: 'string',
              enum: ['link-local', 'private', 'none'],
              default: 'link-local',
            },
            maxRedirects: { type: 'integer', minimum: 0, maximum: 10, default: 3 },
            userAgent: { type: 'string', default: 'ms-core' },
          },
        },
        program: {
          type: 'object',
          default: {} as ProgramConfig,
          additionalProperties: false,
          required: ['directory', 'maxOutputBytes', 'killGraceMs', 'uid', 'gid'],
          properties: {
            // Empty by default: running programs is opt-in, and an installation that has not
            // set this up deliberately cannot run one at all.
            directory: { type: 'string', default: '' },
            maxOutputBytes: { type: 'integer', minimum: 0, maximum: 1_048_576, default: 8192 },
            killGraceMs: { type: 'integer', minimum: 0, maximum: 60_000, default: 5_000 },
            uid: { type: 'integer', minimum: -1, default: -1 },
            gid: { type: 'integer', minimum: -1, default: -1 },
          },
        },
        retry: {
          type: 'object',
          default: {} as DeliveryRetryConfig,
          additionalProperties: false,
          required: ['firstDelaySeconds', 'maxDelaySeconds', 'maxAttempts', 'staleAfterSeconds'],
          properties: {
            firstDelaySeconds: { type: 'integer', minimum: 1, maximum: 3_600, default: 60 },
            maxDelaySeconds: { type: 'integer', minimum: 1, maximum: 86_400, default: 900 },
            // Ten attempts over roughly an hour and a half. Long enough for a relay restart or a
            // certificate renewal, short enough that a permanently wrong address does not sit in
            // the queue for a week.
            maxAttempts: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
            staleAfterSeconds: { type: 'integer', minimum: 60, maximum: 86_400, default: 900 },
          },
        },
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
        'replay',
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
        replay: {
          type: 'object',
          default: {} as IngestionConfig['replay'],
          additionalProperties: false,
          required: ['maxConcurrentProbes', 'stepMs', 'maxDelayMs', 'idleAfterMs'],
          properties: {
            // Four at once: enough that a small site's probes all catch up immediately, few
            // enough that a large one's do not arrive as a single wall of writes.
            maxConcurrentProbes: { type: 'integer', minimum: 1, maximum: 1_000, default: 4 },
            stepMs: { type: 'integer', minimum: 1, maximum: 60_000, default: 250 },
            // Past this, asking politely is not the tool any more — the queue's own refusals
            // are, and they do not depend on a probe choosing to honour a hint.
            maxDelayMs: { type: 'integer', minimum: 100, maximum: 600_000, default: 30_000 },
            // Two heartbeat intervals' worth: long enough not to forget a probe between
            // batches, short enough that a disconnected one stops counting against the others.
            idleAfterMs: { type: 'integer', minimum: 1_000, maximum: 600_000, default: 30_000 },
          },
        },
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
    vault: {
      type: 'object',
      default: {} as CoreConfig['vault'],
      additionalProperties: false,
      required: ['keyFile', 'create'],
      properties: {
        keyFile: { type: 'string', default: 'vault.key' },
        create: { type: 'boolean', default: true },
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
  required: ['service', 'probe', 'trapListener', 'core'],
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
        'spoolCatchUpMaxRows',
        'workerPoolSize',
        'checkQueueMaxLength',
        'checkAbortGraceMs',
        'processRunnerMaxConcurrent',
        'processRunnerQueueMaxLength',
        'processMemoryLimitMb',
        'processUid',
        'processGid',
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
        spoolCatchUpMaxRows: { type: 'integer', minimum: 1, maximum: 5_000, default: 2_000 },
        workerPoolSize: { type: 'integer', minimum: 0, maximum: 1_024, default: 0 },
        checkQueueMaxLength: { type: 'integer', minimum: 1, maximum: 1_000_000, default: 1_000 },
        checkAbortGraceMs: { type: 'integer', minimum: 100, maximum: 300_000, default: 2_000 },
        // Four at once, because each is a Node process rather than a thread awaiting a packet.
        processRunnerMaxConcurrent: { type: 'integer', minimum: 1, maximum: 64, default: 4 },
        processRunnerQueueMaxLength: {
          type: 'integer',
          minimum: 1,
          maximum: 100_000,
          default: 256,
        },
        processMemoryLimitMb: { type: 'integer', minimum: 64, maximum: 8_192, default: 256 },
        processUid: { type: 'integer', minimum: 0, maximum: 4_294_967_295, default: 0 },
        processGid: { type: 'integer', minimum: 0, maximum: 4_294_967_295, default: 0 },
      },
    },
    trapListener: {
      type: 'object',
      default: {} as ProbeConfig['trapListener'],
      additionalProperties: false,
      required: ['enabled', 'port', 'address', 'transport', 'communities', 'bufferSize'],
      properties: {
        enabled: { type: 'boolean', default: false },
        port: { type: 'integer', minimum: 1, maximum: 65_535, default: 162 },
        address: { type: 'string', minLength: 1, default: '0.0.0.0' },
        transport: { type: 'string', enum: ['udp4', 'udp6'], default: 'udp4' },
        communities: { type: 'array', items: { type: 'string', minLength: 1 }, default: [] },
        // Ten thousand traps is minutes of a bad flood and a few megabytes of memory. Past this
        // the honest answer is that the sensor scans too rarely for the volume, which is what
        // the dropped count says.
        bufferSize: { type: 'integer', minimum: 100, maximum: 1_000_000, default: 10_000 },
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
