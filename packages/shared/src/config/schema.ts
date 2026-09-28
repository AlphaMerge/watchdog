/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion --
   Each nested object carries `default: {}` so ajv's `useDefaults` walks into it and fills the
   leaves. `JSONSchemaType` insists a default is a complete `T`, so the cast is what tsc needs;
   the lint rule reads the same types and disagrees. tsc is the authority. */
import { isIP } from 'node:net';
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
    /**
     * State transitions (`S-15`).
     *
     * As long as the coarsest sample tier by default, because uptime and SLA are computed from
     * *this* table rather than from samples (`CLAUDE.md`) — a retention that outlived the state
     * history would leave a graph with numbers and no way to say how much of it was an outage.
     * It costs almost nothing: a row per transition, and a quiet sensor produces one a year.
     */
    stateDays: number;
    /**
     * Stored report documents (`E-10`, `ADR-005`).
     *
     * **The one retention setting that is about bytes an operator asked for rather than
     * measurements this system took.** A month of HTML data tables over a few dozen sensors is
     * tens of kilobytes; hourly reports over five hundred sensors is not, and `ADR-005` says
     * plainly that the default has to be chosen with that in mind rather than set to "forever".
     * Ninety days is a quarter, which is the period a report is usually compared against.
     */
    reportDays: number;
    /**
     * The record that a report *ran* — when, for what period, and whether it worked.
     *
     * Longer than the documents, and for the same reason `auditDays` is longer than `rawDays`:
     * this is a row of a few hundred bytes, and "has this report been failing since August" is
     * asked long after nobody needs August's document. Deleting a run takes its documents with
     * it, so setting this below `reportDays` makes `reportDays` ineffective rather than wrong —
     * the effective horizon is whichever comes first.
     */
    reportRunDays: number;
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
  /**
   * What happens as the disk fills (`S-17`, `WORKFLOW.MD §13` row 7).
   *
   * Retention by age keeps a healthy installation inside its budget. This is the other case: the
   * budget was wrong, or something else on the volume grew, and the choice is between evicting
   * the oldest readings early and letting the database stop accepting writes. **It evicts**, and
   * says so loudly — data that cannot be written is worse than data kept less long than promised,
   * and a monitoring system that goes silent because its disk filled is the failure this project
   * exists to not have (ADR-001 Decision 4 amendment).
   */
  disk: {
    /**
     * The filesystem to watch. Empty watches the one holding `service.dataDir`.
     *
     * **Set it when PostgreSQL's data directory is on a different volume**, which is the case
     * that matters: the readings are on the database's disk, not the core's, and watching the
     * wrong one would guard nothing while reporting a healthy number. A core whose database is
     * on another *host* cannot see that disk at all, and says so rather than guessing.
     */
    path: string;
    /** Free space, as a percentage, below which the oldest readings are evicted early. */
    evictBelowPercent: number;
    /**
     * Free space, as a percentage, at which eviction stops.
     *
     * Above `evictBelowPercent` on purpose: evicting exactly to the trigger point means the next
     * pass starts evicting again, and the system spends its life at the threshold dropping data
     * a chunk at a time.
     */
    recoverAbovePercent: number;
    /**
     * How much recent history is never evicted, whatever the disk says.
     *
     * A floor rather than a policy: evicting what is being written this minute would not save an
     * installation whose disk is full, and would take the readings an operator is looking at
     * while they try to fix it.
     */
    minimumRetainedHours: number;
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

export interface ReportFontConfig {
  path: string;
  face: string;
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
    /**
     * Origins whose writes are accepted even though they are not this API's own (`A-19`).
     *
     * The CSRF guard compares the browser's `Origin` against the request's `Host`, and a proxy
     * that rewrites `Host` — Vite's `changeOrigin` in development, and most reverse proxies in
     * production — makes those two differ for a request that is not cross-site at all. Without
     * this key every write from such a deployment is refused, which is the guard being right
     * about the headers and wrong about the situation.
     *
     * Full origins: `https://ms.example.com`, not a host and not a wildcard. Empty accepts only
     * same-origin writes, which is what a direct install wants.
     */
    allowedOrigins: string[];
    /**
     * The reverse proxies whose `X-Forwarded-For` and `X-Forwarded-Proto` this API believes
     * (`A-36`).
     *
     * **Behind a proxy the core sees one client, the proxy, over plain HTTP**, unless it is told
     * which peer may speak for the browser. Then the session cookie is never `Secure` and HSTS is
     * never sent, however the browser reached the proxy; and the login throttle and the rate limit
     * count every browser as the proxy's one address, so twenty wrong passwords from anybody
     * refuse everybody's login for fifteen minutes.
     *
     * Addresses and CIDR ranges of **the proxy itself**, or `loopback` for a proxy on the same
     * host. Not the network the browsers are on: a client inside a listed range can write its own
     * `X-Forwarded-For` and be counted as whoever it names. Empty trusts nobody, and the headers
     * are then ignored whoever sends them, which is what a direct install wants.
     */
    trustedProxies: string[];
    /**
     * Whether the API refuses a request that does not reach the bar its route declares
     * (`A-11`, `R11`).
     *
     * **On by default, and there is no third state.** The authorisation layer was written,
     * tested and left switched off for the whole of `A-03` and `A-04`, because turning it on
     * before there were per-object rights would have meant an installation where every account
     * saw everything. Those rights exist now, so the honest default is the enforcing one.
     *
     * **The bundled web UI logs in as of `U-17`**, which is what made this default honest. It
     * asks `GET /auth/session` before anything else — public, and the only route that
     * distinguishes "nobody is logged in" from "a login is needed" — and puts up a login form
     * when the answer says one is needed. `ensureFirstAdministrator` writes a generated password
     * to `<dataDir>/first-admin-password`, so both the API and the UI are usable from first
     * boot, and the UI forces that password to be replaced before anything else.
     *
     * `P-172` added a startup warning here for the year this was not true, and `U-17` removed
     * it: a warning that outlives its condition is worse than none.
     *
     * The alternative was defaulting to false, and it is worse than it looks: false does not
     * mean "authenticated principals may do everything", it means the API needs no principal at
     * all. Shipping that as the default would put an unauthenticated monitoring system behind
     * every reverse proxy that forwards to it. So false stays a sentence an operator writes in a
     * file — for a single-operator install, or one behind something else that authenticates.
     */
    requireAuthentication: boolean;
  };
  /**
   * How long a signed-in browser stays signed in (`A-01`, `A-38`).
   *
   * **Its own section, apart from `api`**, because `api` is the listener — where it binds and what
   * it serves — and this is how long an identity lasts. The rest of that question lives here as it
   * arrives.
   *
   * **Both clocks apply to every session in the installation**, so raising them for one screen
   * raises them for everybody: `administration.md` has the recipe for a wall display and what it
   * costs. An API token has neither; it lasts until it expires or is revoked.
   */
  sessions: {
    /**
     * Minutes without a request before a session ends. A request extends it; an open live stream
     * does not (`A-34`). 12 hours by default: a shift, and an unattended screen is signed out by
     * the next one.
     */
    idleTimeoutMinutes: number;
    /**
     * Hours after signing in at which a session ends however active it is. 7 days by default.
     * Never shorter than the idle timeout — `config check` refuses that, since the idle timeout
     * would then never be what ended a session.
     */
    absoluteTimeoutHours: number;
  };
  /**
   * Where a geographical map's tiles come from (`G-08`, `ADR-004`).
   *
   * **Empty by default, and the product ships no tiles and no provider.** Bundling a world is
   * tens of megabytes for a view that cannot show a street; a default provider accepts somebody
   * else's terms on behalf of every operator who installs this. An operator who wants a street
   * map chooses a source, accepts its terms and pastes its URL — and one who does not gets a map
   * drawn over the background image instead of a map that will not load.
   */
  maps: {
    /** `https://tiles.example.org/{z}/{x}/{y}.png`. All three placeholders, or it is ignored. */
    tileUrl: string;
    /**
     * The credit the provider requires, drawn on every map that uses it.
     *
     * Not optional in spirit: every tile service asks for attribution, and removing it is an
     * operator breaking somebody's terms using our software.
     */
    tileAttribution: string;
  };
  /** How reports are drawn (`E-12`). */
  reports: {
    /**
     * Fonts a PDF report draws with where the bundled ones have no glyph, in order.
     *
     * **Empty by default, and a report still draws Japanese, Chinese and Korean**: every PDF
     * draws with DejaVu Sans first and the bundled WenQuanYi Micro Hei last. What this adds is a
     * better font between them — Noto Sans CJK from `fonts-noto-cjk`, say, with the face for the
     * region its readers are in, because one Han code point is drawn differently in Japan and in
     * China and a single font can only choose one. `face` is the PostScript name inside a font
     * collection (`NotoSansCJKjp-Regular`), and empty for a file with one face.
     *
     * A font that cannot be read is logged at startup and skipped, not a reason to refuse to
     * start: the core monitors things, and a report font is not one of them.
     */
    pdfFonts: ReportFontConfig[];
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
     * Checks that may run at once. **0 lets the probe derive it from its own workload.**
     *
     * Slots, not cores: a check spends nearly all of its time awaiting a packet, so this bounds
     * *concurrency* rather than CPU. `P-15` disproved deriving it from the core count — the
     * machine's width has nothing to do with how many packets are in the air.
     *
     * **At 0 the probe sizes itself from Little's law** (`P-34`): it sums
     * `check duration / interval` over the sensors it was actually assigned, using the durations
     * it has measured for each type rather than a guess, and takes 30% headroom. Recomputed on
     * every thirty seconds and shortly after a configuration push — after rather than during,
     * because a chunked push is transiently incomplete (`P-41`) — bounded by
     * `autoPoolCeilingMax()`. It raises at once and lowers only past a deadband and only when
     * the lower answer persists (`P-40`), so the ceiling climbs quickly and steps down. This
     * is the case one constant could not serve: `P-32` measured 48 to be *under* the floor for a
     * probe watching `icmp.ping` at the v1 target, while 64 is more than a probe watching fast
     * checks needs at the same sensor count.
     *
     * **Any non-zero value is a fixed ceiling and is never overruled**, because setting it is a
     * statement about how much memory this probe may use. Set it when you know your workload, or
     * when a derived ceiling would exceed what the box has.
     */
    workerPoolSize: number;
    /**
     * Workers to start with, and never to drop below (`P-18`).
     *
     * `workerPoolSize` is a *ceiling*, not a headcount: the pool starts here and grows towards
     * it only while checks are actually waiting, then gives workers back after a quiet minute.
     * A probe watching fifty sensors therefore costs about thirty megabytes rather than the
     * ~290 MB a flat 48 workers reserves, while one watching five thousand reaches the same
     * ceiling `P-15` measured within the first tranche of work.
     *
     * **Set this equal to `workerPoolSize` for a fixed pool**, which is what a probe with a
     * known steady workload wants — the sizing loop is worth nothing there and a re-spawn during
     * a spike is worth something.
     */
    workerPoolMinSize: number;
    /**
     * How long every worker must have been idle before one is given up. 0 never shrinks.
     *
     * Longer than a scan interval on purpose: a probe is idle between ticks by design, and a
     * shrink policy shorter than the interval would spend its life dropping workers it is about
     * to re-spawn.
     */
    workerPoolIdleShrinkMs: number;
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
    /**
     * Where this probe keeps the programs an EXE/Script sensor may run (`T-19`).
     *
     * **The security boundary of that sensor type**, and the reason it is here rather than in a
     * sensor's parameters: a directory an operator could set per sensor would make the directory
     * decorative, and creating a sensor would become the same thing as running any command as
     * the account this probe holds its credentials in. Empty means this probe runs no programs
     * at all, which is the right default for a probe nobody has deliberately given scripts to.
     */
    scriptDir: string;
    /**
     * Where PowerShell is, for the Windows sensors (`T-09`).
     *
     * Empty works it out: `powershell.exe` on Windows, which is 5.1 and on every Windows Server
     * since 2012 R2, and `pwsh` elsewhere. Set it where PowerShell 7 lives somewhere unusual, or
     * where an operator wants 7 rather than 5.1 on a machine that has both — the wrapper is
     * written for the older one, so it runs on either.
     */
    powerShellPath: string;
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
  /**
   * The probe's syslog listener (`T-20`).
   *
   * Off by default, and bound to 514 only if somebody says so: that port needs privilege a
   * probe should not be running with, and a receiver nobody asked for is a socket accepting
   * anything on the network. `sudo setcap 'cap_net_bind_service=+ep'` on the node binary, or a
   * high port with a firewall redirect, are the two ordinary answers.
   */
  syslogListener: {
    enabled: boolean;
    port: number;
    address: string;
    udp: boolean;
    tcp: boolean;
    ipVersion: 'udp4' | 'udp6';
    /**
     * Addresses whose messages are kept. Empty accepts any.
     *
     * A filter, not a lock. Syslog authenticates nothing at all — anything that can reach the
     * port can claim to be anything — so this stops a misconfigured device filling the buffer
     * and stops nothing else.
     */
    senders: string[];
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
    'sessions',
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
      required: [
        'host',
        'port',
        'webRoot',
        'allowedOrigins',
        'trustedProxies',
        'requireAuthentication',
      ],
      properties: {
        host: { type: 'string', minLength: 1, default: '127.0.0.1' },
        port: { type: 'integer', minimum: 1, maximum: 65_535, default: 8080 },
        webRoot: { type: 'string', default: '' },
        // Not validated by pattern here: what makes an entry usable is that it parses to the
        // origin a browser would send, and `registerCsrfGuard` says so by name at startup.
        allowedOrigins: { type: 'array', default: [], items: { type: 'string', minLength: 1 } },
        // Not by pattern either: an address, a CIDR range or `loopback`, checked by
        // `trustedProxyProblem` below, which names the entry.
        trustedProxies: { type: 'array', default: [], items: { type: 'string', minLength: 1 } },
        requireAuthentication: { type: 'boolean', default: true },
      },
    },
    sessions: {
      type: 'object',
      default: {} as CoreConfig['sessions'],
      additionalProperties: false,
      required: ['idleTimeoutMinutes', 'absoluteTimeoutHours'],
      properties: {
        // Five minutes at the least: shorter signs somebody out between reading a page and saving
        // the form on it. Thirty days at the most.
        idleTimeoutMinutes: { type: 'integer', minimum: 5, maximum: 43_200, default: 720 },
        // Ninety days at the most. A browser that must stay signed in longer than a quarter is
        // a script, and a script uses an API token.
        absoluteTimeoutHours: { type: 'integer', minimum: 1, maximum: 2_160, default: 168 },
      },
    },
    maps: {
      type: 'object',
      default: {} as CoreConfig['maps'],
      additionalProperties: false,
      required: ['tileUrl', 'tileAttribution'],
      properties: {
        // Not pattern-validated here: what makes a template usable is that it carries `{z}`,
        // `{x}` and `{y}` and parses to an origin, and the renderer says so by refusing to draw
        // rather than by failing to start.
        tileUrl: { type: 'string', default: '' },
        tileAttribution: { type: 'string', default: '' },
      },
    },
    reports: {
      type: 'object',
      default: {} as CoreConfig['reports'],
      additionalProperties: false,
      required: ['pdfFonts'],
      properties: {
        pdfFonts: {
          type: 'array',
          default: [],
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'face'],
            properties: {
              path: { type: 'string', minLength: 1 },
              face: { type: 'string', default: '' },
            },
          },
        },
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
      required: [
        'enabled',
        'intervalSeconds',
        'rollupLagSeconds',
        'retention',
        'compression',
        'disk',
      ],
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
          required: [
            'rawDays',
            'fiveMinuteDays',
            'hourlyDays',
            'dailyDays',
            'auditDays',
            'stateDays',
            'reportDays',
            'reportRunDays',
          ],
          properties: {
            // 40 days of raw is PRTG's figure (CAPABILITIES.MD §9), and the reason its UI
            // refuses sub-hourly detail beyond that point.
            rawDays: { type: 'integer', minimum: 1, maximum: 3_650, default: 40 },
            fiveMinuteDays: { type: 'integer', minimum: 1, maximum: 36_500, default: 365 },
            hourlyDays: { type: 'integer', minimum: 1, maximum: 36_500, default: 730 },
            dailyDays: { type: 'integer', minimum: 1, maximum: 36_500, default: 3_650 },
            auditDays: { type: 'integer', minimum: 1, maximum: 36_500, default: 730 },
            stateDays: { type: 'integer', minimum: 1, maximum: 36_500, default: 3_650 },
            reportDays: { type: 'integer', minimum: 1, maximum: 36_500, default: 90 },
            reportRunDays: { type: 'integer', minimum: 1, maximum: 36_500, default: 730 },
          },
        },
        disk: {
          type: 'object',
          default: {} as HousekeepingConfig['disk'],
          additionalProperties: false,
          required: ['path', 'evictBelowPercent', 'recoverAbovePercent', 'minimumRetainedHours'],
          properties: {
            path: { type: 'string', default: '' },
            // Ten percent of a disk is enough room for the database to keep writing while an
            // operator reads the alarm, and low enough that it is not reached by an installation
            // whose retention is sized correctly.
            evictBelowPercent: { type: 'number', minimum: 1, maximum: 90, default: 10 },
            recoverAbovePercent: { type: 'number', minimum: 1, maximum: 95, default: 15 },
            minimumRetainedHours: { type: 'integer', minimum: 1, maximum: 8_760, default: 48 },
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

/**
 * What a configuration must satisfy that its schema cannot say: rules across fields (`A-38`), and
 * values whose shape a pattern would state badly (`A-36`).
 *
 * **Keyed by the schema, so no loader has to be told.** The core loads its configuration in three
 * places — serving, `migrate` and `config check` — and a rule passed in by each would be a rule one
 * of them forgets; `loadConfig` asks here for whatever schema it was given.
 */
const RULES = new WeakMap<object, (config: never) => readonly string[]>();

/** The problems `config` has that its schema's own rules find. Empty when it has none. */
export function ruleProblems<T>(schema: JSONSchemaType<T>, config: T): readonly string[] {
  const rules = RULES.get(schema) as ((config: T) => readonly string[]) | undefined;
  return rules === undefined ? [] : rules(config);
}

/**
 * What is wrong with one `api.trustedProxies` entry, or `undefined` when it is usable (`A-36`).
 *
 * An address, a CIDR range, or `loopback` for a proxy on the core's own host. **`uniquelocal` and
 * `linklocal` are refused although the proxy library understands them**: they name every private
 * or link-local address, which is where the browsers are too, and a browser inside a trusted range
 * can write its own `X-Forwarded-For` and be counted as whoever it names. The core asks this again
 * when it builds its listener, so a server built without loading a file is held to it as well.
 */
export function trustedProxyProblem(entry: string): string | undefined {
  if (entry === 'loopback') return undefined;
  if (entry === 'uniquelocal' || entry === 'linklocal') {
    return (
      `api.trustedProxies: "${entry}" names every ` +
      `${entry === 'linklocal' ? 'link-local' : 'private'} address, which is where the browsers ` +
      "are too — list the proxy's own address or range"
    );
  }
  const [address = '', bits, extra] = entry.split('/');
  const family = isIP(address);
  const widest = family === 6 ? 128 : 32;
  const range = bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= widest);
  if (family !== 0 && extra === undefined && range) return undefined;
  return (
    `api.trustedProxies: "${entry}" is not an address, a CIDR range or "loopback" — name the ` +
    'proxy, as in "127.0.0.1", "10.0.4.7" or "10.0.4.0/28"'
  );
}

RULES.set(coreConfigSchema, (config: CoreConfig): readonly string[] => {
  const problems: string[] = [];
  for (const entry of config.api.trustedProxies) {
    const problem = trustedProxyProblem(entry);
    if (problem !== undefined) problems.push(problem);
  }
  const { idleTimeoutMinutes, absoluteTimeoutHours } = config.sessions;
  if (idleTimeoutMinutes > absoluteTimeoutHours * 60) {
    problems.push(
      `sessions.idleTimeoutMinutes: ${String(idleTimeoutMinutes)} minutes is longer than ` +
        `sessions.absoluteTimeoutHours (${String(absoluteTimeoutHours)} hours), so the idle ` +
        'timeout would never be what ended a session; raise the absolute timeout or lower the ' +
        'idle one',
    );
  }
  return problems;
});

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
        'workerPoolMinSize',
        'workerPoolIdleShrinkMs',
        'checkQueueMaxLength',
        'checkAbortGraceMs',
        'processRunnerMaxConcurrent',
        'processRunnerQueueMaxLength',
        'processMemoryLimitMb',
        'processUid',
        'processGid',
        'scriptDir',
        'powerShellPath',
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
        workerPoolMinSize: { type: 'integer', minimum: 1, maximum: 1_024, default: 4 },
        workerPoolIdleShrinkMs: {
          type: 'integer',
          minimum: 0,
          maximum: 3_600_000,
          default: 60_000,
        },
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
        // Empty by default: a probe runs no programs until somebody deliberately says where.
        scriptDir: { type: 'string', default: '' },
        // Empty means "work it out from the platform", which is right on Windows and honest
        // everywhere else.
        powerShellPath: { type: 'string', default: '' },
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
    syslogListener: {
      type: 'object',
      default: {} as ProbeConfig['syslogListener'],
      additionalProperties: false,
      required: ['enabled', 'port', 'address', 'udp', 'tcp', 'ipVersion', 'senders', 'bufferSize'],
      properties: {
        enabled: { type: 'boolean', default: false },
        // Not 514: that needs privilege a probe should not be running with. An operator who
        // wants the well-known port says so, having decided how to grant it.
        port: { type: 'integer', minimum: 1, maximum: 65_535, default: 10514 },
        address: { type: 'string', minLength: 1, default: '0.0.0.0' },
        udp: { type: 'boolean', default: true },
        // On by default too: a firewall exporting an audit trail over UDP is a firewall whose
        // audit trail has holes in it, and both framings of RFC 6587 are read.
        tcp: { type: 'boolean', default: true },
        ipVersion: { type: 'string', enum: ['udp4', 'udp6'], default: 'udp4' },
        senders: { type: 'array', items: { type: 'string', minLength: 1 }, default: [] },
        // Syslog arrives far faster than traps do — a chatty firewall is thousands a second —
        // so the default buffer is larger, and what it loses is still counted rather than lost.
        bufferSize: { type: 'integer', minimum: 100, maximum: 200_000, default: 20_000 },
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
