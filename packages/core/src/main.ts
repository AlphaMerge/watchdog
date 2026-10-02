#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  bootstrap,
  coreConfigSchema,
  describeBuild,
  describeError,
  exitWithLine,
  MemorySampler,
  runConfigCheck,
  type CoreConfig,
  type Lifecycle,
  type Logger,
  ConfigError,
  startFailure,
  waitForLocalAddress,
} from '@ms/shared';
import { withheldReason } from '@ms/sensors';
import { ApiServer } from './api/server.js';
import { runMigrateCommand, type MigrateAction } from './commands/migrate.js';
import { AuditRepository, CompositeAuditSink, DatabaseAuditSink } from './audit/store.js';
import { LoggingAuditSink } from './objects/audit.js';
import { PauseRepository } from './objects/pause-repository.js';
import { ReachabilitySync } from './probes/reachability-sync.js';
import {
  credentialAdoptionAuditSinks,
  discoveryAuditSinks,
  grantAuditSinks,
  identityAuditSinks,
  objectAuditSinks,
  probeAuditSinks,
  scheduleAuditSinks,
  triggerAuditSinks,
  type AuditSinkSet,
} from './objects/audit-composition.js';
import { ObjectRepository } from './objects/repository.js';
import { catalogueSensorTypeGate, logSensorTypes } from './objects/sensor-type-gate.js';
import { SensorVouching } from './objects/vouching.js';
import { CredentialVouching } from './objects/credential-vouching.js';
import {
  applyDeclaredLimits,
  declaredChannelLookup,
  declaredLimitsLookup,
} from './state/declared-limits.js';
import { DiskWatcher } from './timeseries/disk.js';
import { CredentialVault } from './vault/service.js';
import { VaultKeyring } from './vault/keyring.js';
import { VaultSealer } from './vault/sealer.js';
import { ObjectService } from './objects/service.js';
import { PauseSweep } from './objects/pause-sweep.js';
import { DependencyPauses } from './dependencies/pauses.js';
import { DependencyRepository } from './dependencies/repository.js';
import { DependencySync } from './dependencies/sync.js';
import { SchedulePauses } from './schedules/pauses.js';
import { ScheduleRepository } from './schedules/repository.js';
import { ScheduleService } from './schedules/service.js';
import { ScheduleSweep } from './schedules/sweep.js';
import { FactoryReach } from './factory/reach.js';
import { FactoryService } from './factory/service.js';
import { FactorySweep } from './factory/sweep.js';
import { ScheduleSync } from './schedules/sync.js';
import { AlarmEngine, holdsFrom } from './notifications/engine.js';
import { AlarmScheduler } from './notifications/scheduler.js';
import { TriggerSync } from './notifications/sync.js';
import { MessageContextLoader } from './notifications/context.js';
import { RecipientResolver } from './notifications/recipients.js';
import { EmailTransport } from './notifications/delivery/email.js';
import { NotificationDispatcher } from './notifications/dispatcher.js';
import { DeliveryHealthReader } from './notifications/health.js';
import { TemplateActivation } from './notifications/activation.js';
import { ProbeDeliveryWatch } from './probes/delivery-watch.js';
import { remoteClockOffsets } from './health/core-clock.js';
import { CoreHealthService } from './health/core-health.js';
import { heartbeatFor } from './health/heartbeat.js';
import { ProbeHealthService, ProbeHealthTargets } from './health/probe-health.js';
import { MetricsExporter } from './metrics/exporter.js';
import { PeriodicSweep } from './support/periodic-sweep.js';
import { NotificationTester } from './notifications/test-send.js';
import { StateBroadcaster } from './state/stream.js';
import type { CommittedStates } from './state/runtime.js';
import { WebhookTransport } from './notifications/delivery/webhook.js';
import { slackTransport, teamsTransport } from './notifications/delivery/chat.js';
import { ProgramTransport } from './notifications/delivery/program.js';
import { DeliveryLoop } from './notifications/delivery/loop.js';
import { TemplateService } from './notifications/templates.js';
import { TriggerService } from './triggers/service.js';
import { InheritanceResolver } from './settings/inheritance.js';
import { Database, type Queryable } from './db/pool.js';
import { MigrationError, Migrator } from './db/migrator.js';
import { MIGRATIONS } from './db/migrations/index.js';
import { refuseSchema } from './db/schema-gate.js';
import { waitForDatabase } from './db/wait.js';
import { loadLookups } from './lookups/loader.js';
import { loadDeviceTemplates } from './device-templates/loader.js';
import { ChannelResolver } from './ingestion/channels.js';
import { ResultCacheInvalidator } from './ingestion/invalidation.js';
import { SensorOwnership } from './ingestion/ownership.js';
import { IN_PROCESS_SOURCE } from './ingestion/sources.js';
import { ProbeRefusals } from './probes/refusals.js';
import { Ingestor } from './ingestion/ingestor.js';
import { IngestionService, maxResultAgeMs } from './ingestion/service.js';
import { HistoryService } from './timeseries/history.js';
import { EngineError, type EngineCapabilities } from './timeseries/engine.js';
import { SqlTimeSeriesStore, type TimeSeriesStore } from './timeseries/store.js';
import { Housekeeper } from './timeseries/housekeeper.js';
import { ProbeEndpoint } from './transport/probe-endpoint.js';
import { DiscoveryService } from './discovery/service.js';
import { ProvisionService, provisionRun, type ProvisionReport } from './discovery/provision.js';
import { RediscoveryService } from './discovery/rediscovery.js';
import { ProbeRegistry } from './probes/registry.js';
import { AccountService } from './auth/accounts.js';
import { GroupService } from './auth/groups.js';
import { AccessService } from './auth/access.js';
import { coreCatalogue, startV2Subsystems, v2ApiOptions } from './profile.js';
import { TokenService } from './auth/tokens.js';
import { TotpService } from './auth/totp.js';
import { SessionService } from './auth/sessions.js';
import { LoginThrottle } from './auth/throttle.js';
import { ProbeReachability } from './probes/reachability.js';
import { ClockFreeze } from './probes/clock-freeze.js';
import { ClockFreezeSync } from './probes/clock-freeze-sync.js';
import { ProbeEpisodeIndex } from './probes/episodes.js';
import { RediscoverySweep } from './discovery/rediscovery-sweep.js';
import type { Actor } from './objects/audit.js';
import { ReplayPacer } from './ingestion/replay-pacer.js';
import { ProbeConfigService } from './probes/config.js';
import { ProbeQueryService } from './probes/queries.js';
import { SensorStateService } from './state/service.js';
import { ConfigChangeNotifier } from './probes/notifier.js';
import { BUILD, VERSION } from './version.js';
import { MAX_WALK_DEPTH } from './db/walk.js';

const USAGE = `ms-core ${describeBuild(BUILD)}

  ms-core [--config <file>]              run the core server
  ms-core migrate status                 show applied and pending migrations
  ms-core migrate up                     apply pending migrations
  ms-core migrate down [--steps <n>]     roll back the most recent migration(s)
  ms-core config check                   validate the configuration and exit

Configuration is layered: schema defaults, then the file, then MS_* environment variables.
`;

export interface ParsedArgs {
  command: 'serve' | 'migrate' | 'config-check' | 'help';
  migrateAction: MigrateAction;
  steps: number;
}

/** Flags that consume the argument after them; their values are never positional. */
const VALUE_FLAGS = new Set(['--config', '--steps']);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (VALUE_FLAGS.has(arg)) {
      i += 1; // skip the flag's value — `--config dev/core.json` is not the `dev/core.json` command
      continue;
    }
    if (arg.startsWith('-')) continue;
    positional.push(arg);
  }

  const stepsIndex = argv.indexOf('--steps');
  const stepsRaw = stepsIndex === -1 ? undefined : argv[stepsIndex + 1];
  const steps = stepsRaw === undefined ? 1 : Number.parseInt(stepsRaw, 10);

  if (argv.includes('--help') || argv.includes('-h') || positional[0] === 'help') {
    return { command: 'help', migrateAction: 'status', steps: 1 };
  }

  if (positional[0] === 'config') {
    // Only `check` for now. An unknown verb prints the usage rather than being taken for the
    // server: `ms-core config` with a typo must not start listening on a port.
    if (positional[1] !== 'check') return { command: 'help', migrateAction: 'status', steps: 1 };
    return { command: 'config-check', migrateAction: 'status', steps: 1 };
  }

  if (positional[0] === 'migrate') {
    const action = positional[1] ?? 'status';
    if (action !== 'up' && action !== 'down' && action !== 'status') {
      return { command: 'help', migrateAction: 'status', steps: 1 };
    }
    return {
      command: 'migrate',
      migrateAction: action,
      steps: Number.isFinite(steps) && steps > 0 ? steps : 1,
    };
  }

  return { command: 'serve', migrateAction: 'status', steps: 1 };
}

/** How often a migration running at start-up reports that it still is (`P-215`). */
const MIGRATION_PROGRESS_MS = 15_000;

/**
 * How much more start-up time each report asks for: three reports' worth, so a single late tick
 * cannot let `TimeoutStartSec` land mid-migration.
 */
const MIGRATION_EXTEND_MS = 3 * MIGRATION_PROGRESS_MS;

/**
 * Brings the schema up to date at start-up when `database.autoMigrate` is set.
 *
 * Failing to migrate is fatal. A core running against a schema it does not understand writes
 * data it cannot read back, and that is worse than not starting.
 */
async function migrateOnStart(db: Database, logger: Logger, lifecycle: Lifecycle): Promise<void> {
  const migrator = new Migrator({
    db,
    logger,
    migrations: MIGRATIONS,
    progressIntervalMs: MIGRATION_PROGRESS_MS,
    // **An upgrade must be able to finish** (`P-215`). Each report asks systemd for three
    // intervals more, so one late timer tick never costs a migration half-applied.
    onProgress: ({ migration, elapsedMs }) => {
      lifecycle.starting(
        `applying migration ${String(migration.id)} (${migration.name}), ` +
          `${String(Math.round(elapsedMs / 1000))} s so far`,
        MIGRATION_EXTEND_MS,
      );
    },
    // **The lock comes before any migration, and is waited for in view too** (`P-222`). A core
    // blocked on it used to send nothing, be killed at `TimeoutStartSec` five times and end
    // `failed`; now `systemctl status` names the session holding it.
    onLockWait: ({ elapsedMs, holder }) => {
      const who =
        holder === null
          ? 'another session'
          : `PostgreSQL session ${String(holder.pid)} (${holder.application || 'no application name'}` +
            (holder.clientAddress === null ? '' : ` from ${holder.clientAddress}`) +
            (holder.state === null ? '' : `, ${holder.state}`) +
            `${holder.stateForSeconds === null ? '' : ` for ${String(holder.stateForSeconds)} s`})`;
      lifecycle.starting(
        `waiting for the migration lock, held by ${who}, ` +
          `${String(Math.round(elapsedMs / 1000))} s so far`,
        MIGRATION_EXTEND_MS,
      );
    },
  });
  let applied: readonly unknown[];
  try {
    ({ applied } = await migrator.up());
  } catch (error) {
    // A schema this build will not run against is the operator's to settle, not a restart's.
    if (error instanceof MigrationError && error.refusal) {
      throw new ConfigError(error.message, { cause: error });
    }
    throw error;
  }
  if (applied.length === 0) logger.debug('schema already up to date');
}

async function serve(): Promise<void> {
  const { config, logger, lifecycle, logOutput } = bootstrap<CoreConfig>({
    schema: coreConfigSchema,
    version: VERSION,
    build: BUILD,
  });

  logger.info(
    {
      api: `${config.api.host}:${String(config.api.port)}`,
      probeEndpoint: `${config.probeEndpoint.host}:${String(config.probeEndpoint.port)}`,
      database: `${config.database.host}:${String(config.database.port)}/${config.database.database}`,
    },
    'core configured',
  );

  const db = new Database({ config: config.database, logger });
  lifecycle.onShutdown({ name: 'database', timeoutMs: 5_000, run: () => db.close() });

  // **Waited for, not merely tried** (`P-215`). This is the one start-time failure of the core that
  // waiting fixes — a database still in crash recovery, or started a moment after us — and until
  // it was waited for here, systemd's restart every five seconds was the only thing waiting for
  // it. That made a start limit unsafe: it would stop a core with a slow database exactly as it
  // stops one that can never fit under its memory ceiling.
  const { serverVersion } = await waitForDatabase({
    check: () => db.check(),
    logger,
    target: db.description,
    attemptTimeoutMs: config.database.connectTimeoutMs,
    starting: (status, ms) => {
      lifecycle.starting(status, ms);
    },
  });
  const store = new SqlTimeSeriesStore();
  // Which engine, and what it can do. Reported rather than assumed: a database started under
  // the Apache licence has no compaction, and the housekeeping loop needs to know that before
  // it spends every pass asking for it.
  const engine = await engineOrRefuse(store, db);
  logger.info(
    {
      postgres: serverVersion.split(' ').slice(0, 2).join(' '),
      engine: engine.engine,
      engineVersion: engine.version,
      compaction: engine.compaction,
    },
    'database reachable',
  );

  if (config.database.autoMigrate) {
    await migrateOnStart(db, logger, lifecycle);
  } else {
    // Refusing to start is the safe failure: the alternative is running against a schema this
    // build was not written for. `refuseSchema` knows all three ways that happens (`H-03`).
    const status = await new Migrator({ db, logger, migrations: MIGRATIONS }).status();
    const refusal = refuseSchema(status);
    // Exit 78, not 1 (`P-222`): restarting finds the same schema, and five restarts used up the
    // start limit, so the restart after `ms-core migrate up` was refused.
    if (refusal !== null) throw new ConfigError(refusal);
  }

  const resolver = new InheritanceResolver({ db, logger });

  // Rides the audit sink, which every mutation already goes through, so no new mutation path
  // has to remember to tell the probes about itself (R-04).
  const configNotifier = new ConfigChangeNotifier({ logger });
  // This build's profile of the built-in set (`H-12`), sealed once registered.
  const catalogue = coreCatalogue(BUILD.profile);

  // The vault, before anything that can write a credential. A key file that is unreadable, too
  // permissive or absent-with-`create:false` stops the core here rather than at the first write
  // — an installation that starts and then cannot store a credential has already told an
  // operator it is healthy.
  const vaultKeyFile = isAbsolute(config.vault.keyFile)
    ? config.vault.keyFile
    : join(config.service.dataDir, config.vault.keyFile);
  const vault = new CredentialVault({
    resolver,
    sealer: new VaultSealer(VaultKeyring.load(vaultKeyFile, { create: config.vault.create })),
    logger,
  });
  logger.info(
    { keyFile: vaultKeyFile, kinds: vault.kinds().map((kind) => kind.id) },
    'credential vault ready',
  );
  // Once per set written before writes were checked against their kind (`A-43`). Core Health
  // counts them for as long as they last; this says which they are.
  await vault.warnOfUndeclaredKeys(db);

  // Built-ins, then whatever the operator wrote under <dataDir>/lookups, later winning by id
  // (M-06). Loaded before anything can report a reading, because a channel resolved without its
  // lookup would be judged by nothing until the next time its cache went cold.
  const lookups = await loadLookups({
    directory: join(config.service.dataDir, 'lookups'),
    logger,
  });

  // Built-ins, then whatever the operator wrote under <dataDir>/device-templates, later winning
  // by id — the same shape as the lookups above, so somebody who has learnt one knows the other
  // (`D-03`). The sensor catalogue is passed in so a template naming a type that does not exist
  // is refused *by name* at start rather than silently creating fewer sensors than it says.
  const deviceTemplates = await loadDeviceTemplates({
    directory: join(config.service.dataDir, 'device-templates'),
    logger,
    knownSensorType: (id) => catalogue.has(id),
    // And that the parameters it supplies would actually make that sensor. Checking only the
    // type is checking half of it: a template naming `snmp.diskfree` without its mount point
    // fails at provisioning time, once per device, long after anybody is looking at it.
    validateParams: (id, params) => {
      const outcome = catalogue.validate(id, params);
      return outcome.valid ? [] : outcome.problems.map((one) => one.message);
    },
    // A v1 build's Windows server template keeps its ping and leaves out the WMI set (`H-12`).
    withheld: (id) => withheldReason(BUILD.profile, id),
  });

  // Built here rather than beside the ingestion service, because the audit sink below has to
  // hold them: they cache channel limits and sensor states, and an edited limit that only took
  // effect after a restart would not be the "immediate effect" M-04 promises.
  // The declared limits reach a channel created here as well as one created with its sensor
  // (`S-18`): a channel a probe reports for the first time would otherwise wait for the next
  // start-up pass, which is how `S-17`'s new Core Health channels were found sitting unset.
  const channels = new ChannelResolver({
    logger,
    lookups,
    declaredLimits: declaredLimitsLookup(catalogue),
    declaredShape: declaredChannelLookup(catalogue),
  });
  // `settings` is what makes the failure policy per-sensor and inheritable (M-03): a group can
  // set "warn for three intervals" for everything beneath it, and a sensor can override.
  // What arms and stands down notification chains (N-02). Built before the state service,
  // because that service is one of the two places that tells it a sensor moved -- the other is
  // the ingestor, below.
  // The engine pokes the scheduler when it arms an alarm, and the scheduler drives the engine —
  // so one of the two references is late by construction. This is the late one, filled in the
  // moment the scheduler exists. A scheduler that sleeps until the next due time has to be told
  // when something arms an alarm with a nearer one (N-04).
  const wakeAlarms = { poke: (): void => {} };
  // The same arrangement for delivery: the engine queues a notification and the loop that sends
  // it is built later, so the reference is filled in the moment it exists (N-07).
  const wakeDelivery = { poke: (): void => {} };
  // A lost or frozen probe's sensors are held behind its Probe Health, per trigger (`M-22`).
  // Which probe each Probe Health reports on is known from here on: resolved from the tree before
  // the boot reconciliation below, and republished by every sweep. The other two sources are
  // built much later, so they are read through the late references.
  const probeHealthTargets = new ProbeHealthTargets();
  // And the Sensor Factories held for their inputs' probe (`M-26`), carried by that probe and laid
  // over the facts by the state service. Staged by the factory sweep and settled with its voucher
  // sets, in their transaction (`M-28`).
  const factoryReach = new FactoryReach();
  const episodes = new ProbeEpisodeIndex({
    lost: () => reachabilityRef,
    frozen: () => clockFreezeRef,
    alarms: () => probeHealthTargets,
    factories: () => factoryReach,
  });
  // A core-evaluated sensor is not scanned by the probe it sits under (`P-13`), so neither a
  // probe's outage nor the tree carries it: `ProbeReachability`, `ClockFreeze` and the engine's
  // fallback all leave these out (`M-26`).
  const coreEvaluatedTypes = catalogue
    .ids()
    .filter((id) => catalogue.declaration(id).evaluatedBy === 'core');
  const alarms = new AlarmEngine({
    logger,
    onArmed: () => {
      wakeAlarms.poke();
    },
    onQueued: () => {
      wakeDelivery.poke();
    },
    episodes,
    // Probe Health's five minutes, and nothing for any other type (`M-18`).
    recoveryHolds: holdsFrom(catalogue),
    coreEvaluatedTypes,
  });
  // Live state changes for the UI (U-02). Published after the commit, from `writeStateHistory`
  // — the one function every state change in the system goes through — so ingestion, a pause,
  // an acknowledgement, a simulated error and a dependency cascade all reach it without each
  // path having to remember.
  const stream = new StateBroadcaster({ logger });
  const publishStates: CommittedStates = (committed) => {
    // Floating on purpose, and safe because `publish` never rejects — see the guarantee on it
    // (`P-91`). This runs from `afterCommit`, whose hook loop try/catches only the synchronous
    // call, so a rejection here would reach `unhandledRejection` and shut the core down over a
    // repaint.
    void stream.publish(db, committed);
  };
  // Read through a closure because `R-05` needs this service to build and this service needs
  // its answer: the state machine asks "is this sensor's probe up" on every decision, and the
  // thing that knows is the probe endpoint's link, which is built much later. Nothing calls it
  // until a state is decided, which is long after both exist.
  // eslint-disable-next-line prefer-const -- assigned below, once reachability exists.
  let reachabilityRef: ProbeReachability | undefined;
  const noProbesDown: ReadonlySet<number> = new Set();
  // The same shape, for the sensors the core has stopped evaluating because of who vouched for
  // them (`A-29`). The check needs the state service to move them, so it is built after it.
  // eslint-disable-next-line prefer-const -- assigned below, once the check exists.
  let vouchingRef: SensorVouching | undefined;
  const nothingWithheld: ReadonlyMap<number, string> = new Map();
  // And for the sensors a probe's clock has frozen (`P-232`), which needs the endpoint.
  // eslint-disable-next-line prefer-const -- assigned below, once the endpoint exists.
  let clockFreezeRef: ClockFreeze | undefined;
  const noneFrozen: ReadonlySet<number> = new Set();
  const states = new SensorStateService({
    db,
    logger,
    settings: resolver,
    // Stateless, so a second instance is the same repository (`P-94`). It is here so that a
    // sensor still paused after a schedule window opens shows the operator's own words rather
    // than the name of the schedule that has just stopped applying.
    pauses: new PauseRepository(),
    alarms,
    onStatesCommitted: publishStates,
    unreachableSensors: () => reachabilityRef?.unreachableSensors() ?? noProbesDown,
    clockFrozenSensors: () => clockFreezeRef?.frozenSensors() ?? noneFrozen,
    unreachedFactories: () => factoryReach.unreached(),
    withheldSensors: () => vouchingRef?.withheld() ?? nothingWithheld,
  });
  // The configuration half of the same job: adding a trigger during an outage has to arm the
  // outage, and moving a subtree under one has to arm what arrives with it.
  const triggerSync = new TriggerSync({ engine: alarms, logger });
  // Which probe may report which sensor (`P-228`), and what was refused from each. Built here
  // because the invalidator below is what keeps the first honest across a move or a delete, and
  // the second is read by ingestion, queries, discovery and Probe Health alike.
  const ownership = new SensorOwnership({
    coreEvaluated: (sensorType) =>
      catalogue.has(sensorType) && catalogue.declaration(sensorType).evaluatedBy === 'core',
  });
  const refusals = new ProbeRefusals();
  const cacheInvalidator = new ResultCacheInvalidator({
    channels,
    sensors: states,
    owners: ownership,
    logger,
  });

  // What turns a schedule into `sensor_runtime.paused_by_schedule` (M-09). It rides the audit
  // sink for the same reason the config push does — assigning a schedule, editing one and
  // moving a device into a scheduled group are three code paths, and all three end in one.
  const schedulePauses = new SchedulePauses({ logger, states });
  const scheduleSync = new ScheduleSync({ pauses: schedulePauses, logger });

  // The last of M-08's four flags. Driven by state changes rather than by a clock, so it hangs
  // off the ingestor's transaction as well as the audit sink (M-11).
  const dependencyRepository = new DependencyRepository();
  const dependencyPauses = new DependencyPauses({
    logger,
    settings: resolver,
    repository: dependencyRepository,
    states,
  });
  const dependencySync = new DependencySync({ pauses: dependencyPauses, logger });
  // A move onto a live probe is the obvious remediation for a dead one, and it used to leave
  // every moved sensor reading Unknown for as long as the dead probe stayed away (`P-103`).
  // Named once, so no call site can quietly compose a different set (`P-111`).
  const reachabilitySync = new ReachabilitySync({
    reachability: () => reachabilityRef,
    logger,
  });
  // The clock-freeze overlay has the same defect for the same reason (`P-239`).
  const clockFreezeSync = new ClockFreezeSync({ clockFreeze: () => clockFreezeRef });

  const auditSinks: AuditSinkSet = {
    database: new DatabaseAuditSink(),
    logging: new LoggingAuditSink(logger),
    configNotifier,
    cacheInvalidator,
    scheduleSync,
    dependencySync,
    reachabilitySync,
    clockFreezeSync,
    triggerSync,
  };

  // Object rights (`A-03`), built here rather than beside the accounts because email needs it
  // first — a message goes to the people a template names only if they may read what it is about
  // (`M-19`) — and the voucher check before that: a sensor that republishes what it reads is
  // evaluated through the eyes of whoever vouched for it (`A-29`).
  const objectAccess = new AccessService({
    db,
    audit: new CompositeAuditSink(grantAuditSinks(auditSinks)),
    logger,
  });
  // One gate, so the write that records a voucher and the sweep that re-checks it ask each type
  // the same question about what it reads (`A-29`).
  const sensorTypeGate = catalogueSensorTypeGate(catalogue);
  const vouching = new SensorVouching({
    db,
    logger,
    sensorTypes: sensorTypeGate,
    sight: (principal, q) => objectAccess.visibilityFor(principal, q),
    // Off, the layer is off, and nobody's voucher is held against a sensor (`A-45`).
    requireAuthentication: config.api.requireAuthentication,
    states,
    // A master withheld while Down keeps holding until it is evaluated again, and one vouched for
    // again settles as any master returning from Down does (`M-23`).
    dependencies: dependencyPauses,
  });
  vouchingRef = vouching;
  // Who stands behind where each sensor's inherited credentials go (`A-41`), held through the set
  // `A-29` withholds with. Every configuration a probe is sent asks it.
  const credentialVouching = new CredentialVouching({
    db,
    logger,
    sensorTypes: sensorTypeGate,
    rights: (principal, objectIds, q) => objectAccess.resolveManyFor(principal, objectIds, q),
    vouching,
    audit: new CompositeAuditSink(credentialAdoptionAuditSinks(auditSinks)),
  });
  // Before anything is sent, and before the API can write: the installation vouches for every set
  // in use when this build first starts, so the upgrade withholds nothing (migration 060), and a
  // release that moves where a type sends a kind carries over only what it can show did not move.
  await credentialVouching.adopt();

  // One instance, because `D-07` reads a schedule's definition through it as well: a rediscovery
  // may be constrained by a permission window, and what an evaluator needs is the definition
  // rather than the view a UI wants.
  const scheduleRepository = new ScheduleRepository();

  const service = new ObjectService({
    db,
    repository: new ObjectRepository(),
    resolver,
    // Both, inside every mutation's own transaction: the table is what the history tab reads
    // and what S-10 made queryable, and the log is the plain-text audit component
    // CAPABILITIES.MD §9 lists — the copy that survives someone dropping the database.
    audit: new CompositeAuditSink(objectAuditSinks(auditSinks)),
    sensorTypes: sensorTypeGate,
    // A pause has to take effect now, not at the next scan (M-08): an operator pausing a device
    // for maintenance means now, and a sensor that alarmed thirty seconds into a planned outage
    // is the exact failure pausing exists to prevent.
    states,
    // Read-only: the pause view has to be able to say "held by the office-hours schedule", and
    // a schedule pauses through `sensor_runtime` rather than through `object_pause` (M-09).
    schedules: scheduleRepository,
    dependencies: dependencyRepository,
    dependencyDelays: dependencyPauses,
    vault,
    logger,
  });
  logSensorTypes(logger, catalogue);

  // **After the migration and before anything reads a channel's limits.** A default that only
  // reached installations created after the build declaring it would leave the same version of
  // the same software alarming on a new install and silent on an old one (`S-18`). Nothing an
  // operator has decided is touched, including a decision to clear a threshold.
  const declaredLimits = await applyDeclaredLimits({ db, logger, catalogue });
  if (declaredLimits.unmatched.length > 0) {
    // A declaration matching no channel is not an error — an installation with no probes has no
    // Probe Health sensor — but it is worth saying, because the other cause is a key that was
    // renamed on one side only.
    logger.debug(
      { channels: declaredLimits.unmatched },
      'sensor types declare limits for channels this installation has none of',
    );
  }

  // The library itself. Its own audit sink, so a schedule edit re-derives the flags in the same
  // transaction that changed it — the same composite the object service uses, because a
  // schedule change has to reach the probes exactly as an object change does.
  const scheduleAudit = new CompositeAuditSink(scheduleAuditSinks(auditSinks));
  const schedules = new ScheduleService({ db, audit: scheduleAudit, logger });
  await schedules.seedBuiltIns();

  // The trigger library (N-01). Audited and logged like everything else, but deliberately not
  // wired to the configuration notifier: a trigger decides who gets told about a sensor, not
  // what a probe scans, so pushing one to every probe would be churn for a change none of them
  // acts on. The database still bumps the owning object's version, so the next reconnect
  // carries it.
  const triggers = new TriggerService({
    db,
    audit: new CompositeAuditSink(triggerAuditSinks(auditSinks)),
    logger,
  });

  // What is sent, and how (N-05). Audited and logged like everything else; no sync, because a
  // template edit changes nothing about what is currently standing — only what a message will
  // say when one is next delivered.
  // What a message is built from (N-06). Constructed here so the installation-wide facts — the
  // public URL a link has to use and what this installation is called — are read once, from the
  // config, rather than guessed at delivery time.
  const messageContexts = new MessageContextLoader({
    settings: resolver,
    publicUrl: config.notifications.publicUrl,
    siteName: config.notifications.siteName,
  });
  const templates = new TemplateService({
    db,
    contexts: messageContexts,
    audit: new CompositeAuditSink([new DatabaseAuditSink(), new LoggingAuditSink(logger)]),
    logger,
  });

  const history = new HistoryService({ db, logger, store });
  // Notices when a maintenance window opens and when a timed pause runs out. Every read already
  // accounts for the clock; this is what turns a boundary into a transition, a log entry and a
  // configuration push.
  const pauseSweep = new PauseSweep({
    service,
    logger,
    onChanged: () => {
      configNotifier.flush();
    },
  });
  // **Awaited, for the reason the schedule sweep below is** (`P-131`, `G10`). This is the only
  // thing that applies a maintenance window whose `starts_at` passed while the core was down,
  // and `ProbeConfigService` filters on the flags it writes.
  await pauseSweep.start();
  lifecycle.onShutdown({
    name: 'pause-sweep',
    timeoutMs: 2_000,
    run: () => {
      pauseSweep.stop();
      return Promise.resolve();
    },
  });

  // Recomputes Sensor Factory sensors (T-21). They are the one type the core evaluates itself:
  // their inputs are channel values this process already holds, so asking a probe would mean
  // shipping other sensors' history out to it. The results go through `acceptResults` exactly as
  // a probe's do, which is what gives a factory sensor history, limits, dependencies and alarms
  // with no special case anywhere downstream.
  const factory = new FactoryService({
    db,
    logger,
    vouching,
    reach: factoryReach,
    ingest: async (results) => {
      await ingestion.acceptResults(IN_PROCESS_SOURCE.factory, {
        type: 'results',
        batchId: `factory-${String(Date.now())}`,
        results: [...results],
      });
    },
  });
  const factorySweep = new FactorySweep({ service: factory, logger });
  factorySweep.start();
  lifecycle.onShutdown({
    name: 'factory-sweep',
    timeoutMs: 2_000,
    run: () => {
      factorySweep.stop();
      return Promise.resolve();
    },
  });

  // Notices when a schedule's window opens or closes (M-09). On the wall-clock minute, which is
  // the resolution a schedule has; an installation that assigns none pays one `LIMIT 1` a
  // minute for it.
  const scheduleSweep = new ScheduleSweep({
    db,
    pauses: schedulePauses,
    // A master pausing because its window closed is switched off, not Down, so what it was
    // holding is released in the same transaction (`P-136`).
    dependencies: dependencyPauses,
    logger,
    onChanged: () => {
      configNotifier.flush();
    },
  });
  // **Awaited, here, before the probe endpoint exists** (`P-131`). A core that was down when a
  // window closed comes back with every `paused_by_schedule` flag as it was before the boundary,
  // and the configuration the probes are handed is built from those flags.
  await scheduleSweep.start();
  lifecycle.onShutdown({
    name: 'schedule-sweep',
    timeoutMs: 2_000,
    run: () => {
      scheduleSweep.stop();
      return Promise.resolve();
    },
  });

  // Fires notification chains as they fall due (N-04). One timer for the whole installation,
  // sleeping until the next due time: the due times themselves are rows, so a scheduler that
  // dies, restarts or sleeps too long sends late rather than not at all.
  const alarmScheduler = new AlarmScheduler({ db, engine: alarms, logger });
  wakeAlarms.poke = () => {
    alarmScheduler.wake();
  };
  alarmScheduler.start();

  // **One reconciliation at boot, because an arm can be lost across a restart** (`P-177`).
  // `AlarmEngine.react` is state-based and idempotent: a sensor that is Down with no standing
  // alarm gets one, and a sensor whose alarm already stands is held rather than re-armed. So a
  // single pass over the tree repairs every way an arm can go missing while the process is not
  // running — the ingestor's deferred reactions, which live only in memory and are dropped by a
  // restart mid-drain (`P-157`); a crash between a state write and its reaction; anything else
  // that decided a state and did not get to act on it.
  //
  // Not awaited before the port opens: it reads the current state, so running it a second later
  // gives the same answer, and blocking the API on a full-tree pass would trade a rare missed
  // alarm for a slow start on every boot. Failures are logged and nothing else depends on it.
  void db
    .query<{ id: string }>(`SELECT id::text AS id FROM object WHERE kind = 'root'`)
    .then(async (rows) => {
      const rootId = Number(rows[0]?.id ?? 0);
      if (rootId === 0) return;
      // Before the pass, so a probe that was lost before the restart has its alarm to hold its
      // sensors behind: they still read Unknown/`probe`, and without it the pass would arm a
      // trigger on Unknown once for each of them (`M-22`).
      await probeHealthTargets.refresh(db);
      // **Armed from now, not from the sensor's `since`** (`P-181`). The population this pass
      // exists for is sensors whose outage began before the restart, so their `since` is as old
      // as the outage — and every deadline computed from it, initial and escalation and repeat,
      // is already past. The sweep would fire all three on consecutive passes, for an outage
      // whose recovery may still be sitting in a probe's spool: the `P-146` storm, out of the
      // pass written to repair a missed alarm. Starting the clock here means the alarm still
      // happens and happens once, after its normal latency — by which time a drain has usually
      // said whether the outage is still real.
      const moved = await db.tx((q) =>
        alarms.reconcileSubtree(q, rootId, new Date(), { armFrom: 'now' }),
      );
      if (moved.armed > 0 || moved.cleared > 0) {
        logger.info(
          { armed: moved.armed, cleared: moved.cleared },
          'reconciled standing alarms at startup',
        );
      }
    })
    .catch((error: unknown) => {
      logger.error(
        describeError(error),
        'could not reconcile standing alarms at startup; a state change will still arm them',
      );
    });

  lifecycle.onShutdown({
    name: 'alarm-scheduler',
    timeoutMs: 2_000,
    run: () => {
      alarmScheduler.stop();
      return Promise.resolve();
    },
  });

  // What turns a queued obligation into a message somebody receives (N-07). Email is the only
  // transport so far; N-08 to N-10 add the rest, and a method with no transport leaves its
  // requests queued rather than failing them.
  const email = new EmailTransport({
    config: config.notifications.smtp,
    logger,
    recipients: new RecipientResolver({ db, access: objectAccess }),
  });
  if (!email.configured) {
    logger.warn(
      'no SMTP relay is configured; email notifications will queue and fail until one is set',
    );
  }
  // The method that covers most integrations (N-08). Its SSRF guard defaults to blocking
  // link-local only: a monitoring system posts to things inside its own network all day, and a
  // guard that refused them would be switched off.
  const webhook = new WebhookTransport({ config: config.notifications.webhook, logger });
  // Slack and Teams (N-09), through the same guard and the same policy: they are incoming-webhook
  // URLs like any other, and a self-hosted Mattermost accepting Slack's document is a common
  // enough target that exempting them would have been the wrong call.
  const chat = config.notifications.webhook;
  // One list, shared with N-14's test send — a test that went through a different set of
  // transports would be testing something the alarms do not use.
  const transports = [
    email,
    webhook,
    slackTransport({ config: chat, logger }),
    teamsTransport({ config: chat, logger }),
    // The escape hatch (N-10). Off until an operator configures a programs directory, because
    // without one a template could name any path on the machine.
    new ProgramTransport({ config: config.notifications.program, logger }),
  ];
  const dispatcher = new NotificationDispatcher({
    db,
    logger,
    contexts: messageContexts,
    transports,
    // Growing waits with half of each randomised (N-13). A relay that refused one message will
    // refuse the next one a second later, and a relay coming back from an hour's outage must not
    // meet every deferred message at the same instant.
    retry: {
      firstDelayMs: config.notifications.retry.firstDelaySeconds * 1_000,
      maxDelayMs: config.notifications.retry.maxDelaySeconds * 1_000,
      maxAttempts: config.notifications.retry.maxAttempts,
    },
  });
  // Read from the queue rather than counted in memory, so a core that restarted five minutes ago
  // does not report a clean sheet over a queue full of undelivered alarms (N-13). `P-12` turns
  // the same reader into channels on the Core Health sensor.
  // The same evaluation the dispatcher makes every pass, so health and delivery cannot disagree
  // about which templates are currently parked (`P-125`).
  const templateActivation = new TemplateActivation();
  const deliveryHealth = new DeliveryHealthReader({
    staleAfterMs: config.notifications.retry.staleAfterSeconds * 1_000,
    // Given to the reader rather than passed at each call (`R06`): Core Health passed it and
    // the API route did not, so the two answered different numbers for the same question.
    activation: templateActivation,
  });
  // What "send test notification" sends through (N-14), and the same transports the alarms use.
  const tester = new NotificationTester({
    db,
    logger,
    contexts: messageContexts,
    transports,
    audit: new CompositeAuditSink([new DatabaseAuditSink(), new LoggingAuditSink(logger)]),
    publicUrl: config.notifications.publicUrl,
    siteName: config.notifications.siteName,
  });
  const deliveryLoop = new DeliveryLoop({ dispatcher, logger });
  wakeDelivery.poke = () => {
    deliveryLoop.wake();
  };
  deliveryLoop.start();
  lifecycle.onShutdown({
    name: 'notification-delivery',
    timeoutMs: 5_000,
    run: async () => {
      deliveryLoop.stop();
      await dispatcher.close();
    },
  });

  // Discovery (`D-01`), built before the API so the routes can have it and before the probe
  // endpoint so the endpoint can have it as a sink. It dispatches *back* through the endpoint,
  // which does not exist yet — so `dispatch` reads it through a closure, the same shape the
  // probe's spool drain uses for its client. Nothing is sent until a probe connects, which is
  // long after both are built.
  // eslint-disable-next-line prefer-const -- assigned below, once the endpoint exists.
  let probeEndpointRef: ProbeEndpoint | undefined;
  // The same shape for the other direction: a finished run has to reach scheduled rediscovery
  // (`D-07`), which is built later because it needs this service. A run cannot finish before a
  // run has started, and no run starts until the API is up.
  // eslint-disable-next-line prefer-const -- assigned below, once rediscovery exists.
  let rediscoveryRef: RediscoveryService | undefined;
  const discovery = new DiscoveryService({
    db,
    audit: new CompositeAuditSink(discoveryAuditSinks(auditSinks)),
    logger,
    // The endpoint does not exist yet, so `offline` is the honest answer until it does — the
    // run waits and is offered again, which is exactly what happens to a probe that has not
    // connected. Reading a missing endpoint as `too-old` would fail runs during start-up.
    dispatch: (probeObjectId, message) =>
      probeEndpointRef?.sendSweep(probeObjectId, message) ?? { kind: 'offline' },
    onFinished: async (runId) => {
      await rediscoveryRef?.runFinished(runId);
    },
    refusals,
  });

  // What a probe should be scanning (`R-04`), built here rather than inline in the endpoint so
  // `R-09` can ask it about one sensor without a second copy of the rules — an assignment
  // assembled twice is an on-demand check that works when the scheduled one does not.
  const probeConfig = new ProbeConfigService({
    db,
    resolver,
    vault,
    // Only the kinds a type declared, so a probe running Ping never receives an SNMP community
    // string (`A-05`).
    credentialKindsFor: (sensorType) =>
      catalogue.has(sensorType) ? (catalogue.declaration(sensorType).credentialKinds ?? []) : [],
    // A Sensor Factory is computed here, from readings this process already holds, so it never
    // appears in a probe's assignment list (`T-21`).
    coreEvaluated: (sensorType) =>
      catalogue.has(sensorType) && catalogue.declaration(sensorType).evaluatedBy === 'core',
    // Only while whoever vouched for it can still write where it is stored (`A-41`).
    credentialCheck: credentialVouching,
  });

  // On-demand queries (`R-09`), reaching the endpoint through the same closure discovery uses
  // and for the same reason: the endpoint is built later, and until it is, `offline` is the
  // honest answer rather than a promise nobody can keep.
  const probeQueries = new ProbeQueryService({
    logger,
    refusals,
    sender: {
      sendQuery: (probeObjectId, message) =>
        probeEndpointRef?.sendQuery(probeObjectId, message) ?? { kind: 'offline' },
    },
  });
  lifecycle.onShutdown({
    name: 'probe-queries',
    timeoutMs: 1_000,
    run: () => {
      probeQueries.stop();
    },
  });

  // Provisioning (`D-04`). Built after the templates and before the API, and it takes the
  // object service rather than the database: creating a device or a sensor has to go through
  // the same validation, audit and version bookkeeping every other creation does — a discovery
  // that wrote rows directly would be a second way to make an object, with a second set of
  // rules to keep in step.
  const provisioner = new ProvisionService({
    objects: service,
    templates: deviceTemplates,
    logger,
    credentialsFor: (groupId) => credentialKindsInScope(db, groupId),
    recordDevice: (runId, address, deviceId) => discovery.recordDevice(runId, address, deviceId),
  });

  const provision = (runId: number, actor: Actor): Promise<ProvisionReport> =>
    provisionRun(
      {
        discovery,
        provisioner,
        existing: async (groupId) => {
          const [devices, sensors] = await Promise.all([
            devicesInGroup(db, groupId),
            sensorsInGroup(db, groupId),
          ]);
          return { devices, sensors };
        },
        vouchers: {
          authRequired: config.api.requireAuthentication,
          ruleWriter: async (ruleId) => (await rediscoveryRef?.writerOf(ruleId)) ?? null,
          rights: (principal, objectIds, q) => objectAccess.resolveManyFor(principal, objectIds, q),
        },
      },
      runId,
      actor,
    );

  // Scheduled rediscovery (`D-07`). Off by default in the strongest sense: there is no schedule
  // until somebody creates one, and a new one is created disabled with auto-provisioning
  // separately off.
  const rediscovery = new RediscoveryService({
    db,
    audit: new CompositeAuditSink(discoveryAuditSinks(auditSinks)),
    logger,
    discovery,
    // `M-09`'s calendar as a permission window, read through the repository rather than this
    // service learning how a schedule is stored.
    windowFor: async (id) => {
      // Through the repository the schedule service already holds: what a window needs is the
      // definition, and `ScheduleView` is the shape a UI wants rather than the shape an
      // evaluator does.
      const found = await scheduleRepository.get(db, id);
      return found?.definition ?? null;
    },
    provision: async (runId) => {
      // The same actor an unattended job always is. `A-01` will give this a real one.
      await provision(runId, { kind: 'anonymous', remoteAddress: 'scheduled-rediscovery' });
    },
  });
  rediscoveryRef = rediscovery;
  const rediscoverySweep = new RediscoverySweep({ service: rediscovery, logger });
  rediscoverySweep.start();
  lifecycle.onShutdown({
    name: 'rediscovery-sweep',
    timeoutMs: 2_000,
    run: () => rediscoverySweep.stop(),
  });

  // Who is allowed in (`R-01`). Built before the endpoint, because the endpoint asks it on
  // every handshake and a probe that connects during startup must not be admitted by default.
  const probeRegistry = new ProbeRegistry({
    db,
    audit: new CompositeAuditSink(probeAuditSinks(auditSinks)),
    logger,
    enrolmentKeys: config.probeEndpoint.accessKeys,
  });

  // Accounts and sessions (`A-01`). Built before the API, because the API's authentication hook
  // asks the session service on every request.
  // Every account, group, membership, password, second factor and token change is recorded in
  // its own transaction (`A-18`), by one sink set so no identity service can compose a different
  // one.
  const identityAudit = new CompositeAuditSink(identityAuditSinks(auditSinks));
  const accounts = new AccountService({ db, audit: identityAudit, logger });
  // How long a signed-in browser stays signed in is the operator's to set (`A-38`).
  const sessions = new SessionService({
    db,
    logger,
    idleTimeoutMs: config.sessions.idleTimeoutMinutes * 60_000,
    absoluteTimeoutMs: config.sessions.absoluteTimeoutHours * 3_600_000,
  });
  const userGroups = new GroupService({ db, audit: identityAudit, logger });
  const apiTokens = new TokenService({ db, audit: identityAudit, logger });
  const mfa = new TotpService({ db, audit: identityAudit, logger });
  const loginThrottle = new LoginThrottle({ db, logger });

  // **The v2 subsystems, and only in the full build profile** (`H-12`). The v1 build — the
  // release candidate — constructs no maps, libraries or reports; `profile.ts` says why, and is
  // the one place that decides it.
  const v2 = await startV2Subsystems(BUILD.profile, {
    db,
    logger,
    lifecycle,
    config: config.reports,
    access: objectAccess,
    history,
    auditSinks,
    email,
  });

  // **An installation with no accounts cannot be administered, and one with a known default
  // password is worse than one with none.** So the first administrator is created here with a
  // generated password, printed once where the operator installing this will see it, and flagged
  // to be replaced at the first login. Does nothing at all once any account exists.
  // **Said out loud, because the alternative is an operator staring at an empty page** (`P-172`).
  // `P-172` warned here that serving the web UI with authentication on gave an operator a page
  // that loaded and then failed every request it made. `U-17` is why that warning is gone: the
  // UI asks `GET /auth/session` before anything else and renders a login form when the answer
  // says it needs one. The generated administrator password below is what they log in with.

  const firstAdmin = await accounts.ensureFirstAdministrator();
  if (firstAdmin !== null) {
    // **The password goes to a file, not to the log, and that is not a detail.** Every logger in
    // this system redacts a field called `password` — correctly, because a credential in a log is
    // a credential in a log shipper, a search index and a backup. Renaming the field to slip past
    // that would be defeating a control that is doing its job. So the secret is written where the
    // installer already writes secrets: one file, owned by the service, mode 0600, and the log
    // says where it is.
    const passwordFile = join(config.service.dataDir, 'first-admin-password');
    await writeFile(
      passwordFile,
      `${firstAdmin.password}\n\n` +
        `This is the generated password for the '${firstAdmin.login}' account.\n` +
        `Log in, change it when prompted, then delete this file.\n`,
      { mode: 0o600 },
    );
    logger.warn(
      { login: firstAdmin.login, passwordFile },
      'created the first administrator — its generated password is in that file; ' +
        'change it at first login and delete the file',
    );
  }

  // Built after the ingestor and the probe endpoint, which are themselves built after the API so
  // a slow first housekeeping pass cannot delay the port opening. The route answers 503 for the
  // milliseconds in between, which is the honest answer: "starting" is not "everything is zero".
  // eslint-disable-next-line prefer-const -- assigned below, once the ingestor exists.
  let coreHealthRef: CoreHealthService | undefined;
  // eslint-disable-next-line prefer-const -- assigned below, once the probe endpoint exists.
  let probeHealthRef: ProbeHealthService | undefined;
  // eslint-disable-next-line prefer-const -- assigned below, once both health services exist.
  let metricsRef: MetricsExporter | undefined;

  const api = new ApiServer({
    config: config.api,
    publicUrl: config.notifications.publicUrl,
    logger,
    version: VERSION,
    build: BUILD,
    service,
    history,
    db,
    audit: new AuditRepository(),
    catalogue,
    lookups,
    schedules,
    discovery,
    deviceTemplates,
    provision,
    rediscovery,
    probeRegistry,
    queries: probeQueries,
    probeConfig,
    auth: {
      accounts,
      sessions,
      throttle: loginThrottle,
      groups: userGroups,
      access: objectAccess,
      tokens: apiTokens,
      totp: mfa,
      // **`A-03` and `A-04` have landed, so this is on** (`R11`). It was `false` here for as
      // long as there were no per-object rights to enforce — turning the guard on then would
      // have meant an installation where every account saw everything, which is worse than the
      // honest answer that authentication exists and is not yet load-bearing. Both of those
      // tickets are done and this very file reads `may_acknowledge` off the principal, so the
      // flag was the last thing holding the layer inert in the only wiring that ships.
      //
      // Now a configuration key, defaulting to on, because "off" is a real answer for an
      // install behind something else that authenticates — but it has to be an operator's
      // sentence in a file rather than a constant nobody revisits.
      required: config.api.requireAuthentication,
    },
    // Absent in the v1 profile, which is how their routes come to be absent (`H-12`).
    ...v2ApiOptions(v2),
    mapTiles: {
      urlTemplate: config.maps.tileUrl,
      attribution: config.maps.tileAttribution,
    },
    triggers,
    templates,
    deliveryHealth,
    coreHealth: () => coreHealthRef,
    probeHealth: () => probeHealthRef,
    metrics: () => metricsRef,
    tester,
    stream,
  });
  await api.build(VERSION, service);
  // A specific address that this host does not have yet, at boot, is waited for (`P-222`).
  await waitForLocalAddress({
    address: config.api.host,
    what: 'API',
    logger,
    starting: (status, ms) => {
      lifecycle.starting(status, ms);
    },
  });
  await api.start();
  lifecycle.onShutdown({ name: 'api', timeoutMs: 5_000, run: () => api.stop() });

  // Shutdown runs these in reverse, and the order is the point: the probe endpoint closes
  // first so nothing new arrives, then ingestion drains what it has already promised to store,
  // then housekeeping, then the API, and the database last of all — every one of them needs a
  // live pool right up until it is done.

  // The data lifecycle: rollups, compression, retention, orphan reaping. Started after the API
  // so a slow first pass — the one catching up after a long stop — cannot delay the port
  // opening.
  // What the housekeeper watches to decide whether the disk is about to stop it (`S-17`). Built
  // here rather than inside the housekeeper because it needs the data directory, which is a
  // service setting and not a housekeeping one.
  const disk = new DiskWatcher({
    logger,
    path: config.housekeeping.disk.path,
    dataDir: config.service.dataDir,
  });
  // The dead man's switch (`H-18`): off unless an operator named a receiver. It has no timer; the
  // housekeeping loop tells it as each pass ends, so a wedged pass sends nothing.
  const heartbeat = heartbeatFor(config, VERSION, logger);
  const housekeeper = new Housekeeper({
    db,
    logger,
    config: config.housekeeping,
    store,
    disk,
    // No reports to prune in a build that has none (`H-12`).
    reports: v2.reporting !== undefined,
    ...(heartbeat === undefined ? {} : { witness: heartbeat }),
  });
  housekeeper.start();
  lifecycle.onShutdown({
    name: 'housekeeping',
    timeoutMs: 15_000,
    run: async () => {
      // First, so the pass a stop cuts short is not reported as one that finished.
      heartbeat?.stop();
      await housekeeper.stop();
    },
  });

  // Ingestion writes readings; the housekeeper is what it tells about ranges that land behind a
  // rollup watermark, which is what a probe replaying its disk spool looks like (R-03).
  const ingestor = new Ingestor({
    db,
    logger,
    config: config.ingestion,
    lateData: housekeeper,
    // In the write's own transaction: a master's dependents must be paused by the time the
    // master's Down is visible, or a dependent's next result raises the alarm the dependency
    // exists to suppress (M-11).
    dependencies: dependencyPauses,
    // After the dependency reaction, in the same transaction: an alarm armed before the
    // dependencies settled is the alarm the dependency exists to suppress (M-17, N-02).
    alarms,
    onStatesCommitted: publishStates,
    // And afterwards, the probes: a check result is not a configuration change, so this is the
    // one write path the audit sink does not cover.
    onDependencyChange: () => {
      configNotifier.flush();
    },
  });
  lifecycle.onShutdown({
    name: 'ingestion',
    // Longer than the others: everything queued has been acknowledged as durable, so draining
    // is an obligation rather than a courtesy.
    timeoutMs: 20_000,
    run: () => ingestor.stop(),
  });
  const ingestion = new IngestionService({
    db,
    logger,
    ingestor,
    // Catch-up is paced separately from absolute queue pressure, so a fleet replaying their
    // spools cannot queue everyone else's live results behind them (R-03).
    pacer: new ReplayPacer({ config: config.ingestion.replay, logger }),
    resolver: channels,
    ownership,
    refusals,
    // A check a probe refused over where its credentials may go holds its sensor Unknown, and
    // never reaches the machine as a failed scan (`A-41c`).
    credentialRefusals: credentialVouching,
    // What turns an outcome into Up, Warning or Down (M-02). Its writes ride in the readings'
    // own transaction, so the two can never disagree about what happened.
    states,
    // Nothing older than the longest anything is kept (`P-231`); the retention decides it.
    maxResultAgeMs: maxResultAgeMs(config.housekeeping.retention),
  });

  // A lost probe is one alarm, not a thousand (`R-05`). Built before the endpoint, which is
  // what tells it when a link comes and goes.
  const reachability = new ProbeReachability({
    db,
    logger,
    states,
    // A master under a probe that has gone is Unknown, not Down, so whatever it was holding is
    // released here (`P-135`) — nothing else would ever notice, because the dependency reaction
    // runs on the transitions a result batch produced and a lost probe produces no results.
    dependencies: dependencyPauses,
    // A core-evaluated sensor is not scanned by the probe it happens to sit under, so a probe
    // outage says nothing about it (`P-13`). Probe Health depends on this: it is a sensor under
    // the probe it reports on, and without the exclusion the outage it exists to raise would be
    // the thing that silenced it.
    coreEvaluatedTypes,
    // And reconciled with the sensors it holds, so a trigger's view of it moves with them (`M-22`).
    probeAlarms: (probeObjectId) => probeHealthTargets.reportingOn(probeObjectId),
  });
  reachabilityRef = reachability;

  const probeEndpoint: ProbeEndpoint = new ProbeEndpoint({
    config: config.probeEndpoint,
    logger,
    coreVersion: VERSION,
    results: ingestion,
    discovery,
    registry: probeRegistry,
    reachability,
    probeConfig,
    queries: probeQueries,
  });
  probeEndpointRef = probeEndpoint;
  configNotifier.attach(probeEndpoint);
  // So approving or re-pointing a probe reaches the connection it already has (`P-189`).
  probeRegistry.attach(probeEndpoint);
  await waitForLocalAddress({
    address: config.probeEndpoint.host,
    what: 'probe endpoint',
    logger,
    starting: (status, ms) => {
      lifecycle.starting(status, ms);
    },
  });
  await probeEndpoint.start();
  lifecycle.onShutdown({
    name: 'config-push',
    timeoutMs: 1_000,
    run: () => {
      configNotifier.stop();
      cacheInvalidator.stop();
    },
  });
  lifecycle.onShutdown({
    name: 'probe-endpoint',
    timeoutMs: 5_000,
    run: () => probeEndpoint.stop(),
  });

  // The core watching itself (P-12), and CLAUDE.md's rule that it must: every subsystem with a
  // queue, a pool or a connection reports here. Built last because it reads all of them, and the
  // results go through `acceptResults` exactly as a probe's do — so Core Health has history,
  // limits, triggers and alarms with no special case anywhere downstream.
  // How much this machine has left (`P-208`), and the core's own cgroup ceiling (`P-210`), on a
  // two-second timer of their own. Core Health is read every thirty seconds, and `P-206` watched a
  // machine go from 8.5% available to a kernel kill in six. The probe reads the same way since
  // `P-218`; it had been reading at its heartbeat, which is 10 s as shipped.
  const memory = new MemorySampler();
  memory.start();
  lifecycle.onShutdown({
    name: 'machine-memory',
    timeoutMs: 1_000,
    run: () => {
      memory.stop();
      return Promise.resolve();
    },
  });

  const coreHealth = new CoreHealthService({
    db,
    logger,
    vouching,
    sources: {
      ingestion: () => ingestor.stats(),
      stream: () => stream.stats,
      probes: () => reachability.stats(),
      // **The parked set travels with the read** (`P-125`). A template outside its activation
      // schedule is holding messages because an operator said so; without this the oldest of them
      // drove `notifyOldest` up all night and put Core Health Down with "check the relay" for a
      // digest due at eight in the morning.
      delivery: async (q) => {
        const now = new Date();
        const suppressed = await templateActivation.suppressed(q, now);
        return deliveryHealth.read(q, now, suppressed.templateIds);
      },
      credentialsToReenter: async (q) => (await vault.setsWithUndeclaredKeys(q)).length,
      unboundedCredentials: (q) => vault.unboundedSets(q),
      alarms: () => alarmScheduler.stats,
      disk: () => housekeeper.stats.disk,
      evictedChunks: () => housekeeper.stats.evictedChunks,
      machineMemory: () => memory.machine.lowest(),
      limitMemory: () => memory.limit.lowest(),
      // What the log dropped and holds while the journal was not reading (`P-216` part 3), and the
      // local probe's drops beside it: one journal, one alarm, and Core Health owns it (`M-21`).
      ...(logOutput === undefined ? {} : { log: () => logOutput.stats() }),
      localProbeLog: async (q) => {
        const rows = await q.query<{ object_id: string }>(
          'SELECT object_id::text AS object_id FROM probe_config WHERE is_local',
        );
        const local = rows[0];
        if (local === undefined) return null;
        const link = probeEndpoint.linkFor(Number(local.object_id));
        if (!link.connected) return null;
        const dropped = link.health?.logDropped;
        const uptimeSeconds = link.health?.uptimeSeconds;
        return dropped === undefined || uptimeSeconds === undefined
          ? null
          : { droppedLines: dropped, uptimeSeconds, session: link.connectedAt.getTime() };
      },
      // The remote probes' clocks, to say whether this core's own is the one behind (`P-247`).
      // The local probe reads this core's clock, so it is left out, as Probe Health leaves it.
      probeClocks: async (q) => {
        const rows = await q.query<{ object_id: string }>(
          'SELECT object_id::text AS object_id FROM probe_config WHERE is_local',
        );
        return remoteClockOffsets(
          probeEndpoint.connectedProbeIds(),
          new Set(rows.map((row) => Number(row.object_id))),
          (probeObjectId) => probeEndpoint.linkFor(probeObjectId),
        );
      },
      queries: () => probeQueries.stats(),
      ingestionDiscards: () => ingestion.stats(),
      hosts: () => api.hostStats(),
      rateLimit: () => api.rateLimitStats(),
      ...(heartbeat === undefined ? {} : { heartbeat: () => heartbeat.stats() }),
      // Gaps in the v1 profile, which has no reporting to count (`H-12`).
      ...(v2.reporting === undefined ? {} : { reports: v2.reporting.stats }),
    },
    ingest: async (results) => {
      await ingestion.acceptResults(IN_PROCESS_SOURCE.coreHealth, {
        type: 'results',
        batchId: `core-health-${String(Date.now())}`,
        results: [...results],
      });
    },
  });
  coreHealthRef = coreHealth;
  // The other half of the same rule (P-13). Evaluated by the core because **a probe cannot
  // report its own absence**, which is the single most important thing this sensor says — R-05
  // made a lost probe one alarm rather than a thousand, and this is where that one alarm comes
  // from.
  // **A probe that is connected and silent is monitoring nothing** (`P-74`). `R-05` covers the
  // probe that goes away; nothing covered the one that stays and stops delivering, and a sensor
  // is re-evaluated only when a result arrives — so its sensors would hold their last state for
  // ever. Built before Probe Health because that reads its verdict.
  const deliveryWatch = new ProbeDeliveryWatch({
    db,
    logger,
    reachability,
    linkFor: (probeObjectId) => probeEndpoint.linkFor(probeObjectId),
  });

  // A probe whose clock reads earlier than its sensors' last results freezes them (`P-232`).
  // Moved the way a lost probe's sensors are, through the same two calls, so the alarms they
  // raise are a lost probe's and no more.
  const clockFreeze = new ClockFreeze({
    db,
    logger,
    states,
    dependencies: dependencyPauses,
    links: probeEndpoint,
    coreEvaluatedTypes,
    probeAlarms: (probeObjectId) => probeHealthTargets.reportingOn(probeObjectId),
  });
  clockFreezeRef = clockFreeze;
  const clockFreezeSweep = new PeriodicSweep({
    logger,
    component: 'clock-freeze-sweep',
    what: 'a probe clock sweep failed',
    run: () => clockFreeze.sweep().then(() => undefined),
    intervalMs: 30_000,
  });
  clockFreezeSweep.start();
  lifecycle.onShutdown({
    name: 'clock-freeze-sweep',
    timeoutMs: 2_000,
    run: () => {
      clockFreezeSweep.stop();
      return Promise.resolve();
    },
  });

  const probeHealth = new ProbeHealthService({
    db,
    logger,
    vouching,
    targets: probeHealthTargets,
    // A Probe Health moved off a probe during its loss lets go of what it held there (`M-27`).
    onReportersLost: async (probeObjectIds) => {
      await db.tx((q) => alarms.releaseProbes(q, probeObjectIds, new Date()));
    },
    sources: {
      link: (probeObjectId) => probeEndpoint.linkFor(probeObjectId),
      timeRefusals: (gid) => ingestion.timeRefusals(gid),
      refusals: (probeObjectId) => refusals.countsFor(probeObjectId),
      frozenSensors: (probeObjectId) => clockFreeze.frozenOn(probeObjectId),
      // The sweep, and only the sweep, drains the probes' folded memory lows (`P-219`, `P-245`).
      drainMemory: () => probeEndpoint.drainMemory(),
      // Every connected probe's log baseline is taken each sweep, recorded or not (`P-250`).
      connectedProbeIds: () => probeEndpoint.connectedProbeIds(),
    },
    delivery: deliveryWatch,
    ingest: async (results) => {
      await ingestion.acceptResults(IN_PROCESS_SOURCE.probeHealth, {
        type: 'results',
        batchId: `probe-health-${String(Date.now())}`,
        results: [...results],
      });
    },
  });
  probeHealthRef = probeHealth;
  const probeHealthSweep = new PeriodicSweep({
    logger,
    component: 'probe-health-sweep',
    what: 'a Probe Health sweep failed',
    run: () => probeHealth.sweep(),
    intervalMs: 30_000,
  });
  probeHealthSweep.start();
  lifecycle.onShutdown({
    name: 'probe-health-sweep',
    timeoutMs: 2_000,
    run: () => {
      probeHealthSweep.stop();
      return Promise.resolve();
    },
  });

  // Beside the other three, on the same period. Its own sweep rather than a step inside Probe
  // Health's, because it writes *state* through `ProbeReachability` while that one writes a
  // reading — and a failure in either must not take the other down with it.
  const deliverySweep = new PeriodicSweep({
    logger,
    component: 'probe-delivery-sweep',
    what: 'a probe delivery sweep failed',
    run: () => deliveryWatch.settle().then(() => undefined),
    intervalMs: 30_000,
  });
  deliverySweep.start();
  lifecycle.onShutdown({
    name: 'probe-delivery-sweep',
    timeoutMs: 2_000,
    run: () => {
      deliverySweep.stop();
      return Promise.resolve();
    },
  });

  const coreHealthSweep = new PeriodicSweep({
    logger,
    component: 'core-health-sweep',
    what: 'a Core Health sweep failed',
    run: () => coreHealth.sweep(),
    // The same thirty seconds the factory sweep uses, and for the same reason: a floor rather
    // than a ceiling, so a limit on the ingestion queue notices a stall within half a minute.
    intervalMs: 30_000,
  });
  coreHealthSweep.start();

  // The same numbers again for an external scraper (P-14), read from the health services rather
  // than from the subsystems a second time — a second implementation of a health question is a
  // second answer to it, and the day they disagree is the day nobody trusts either.
  metricsRef = new MetricsExporter({
    db,
    logger,
    coreHealth: () => coreHealthRef,
    probeHealth: () => probeHealthRef,
  });
  lifecycle.onShutdown({
    name: 'core-health-sweep',
    timeoutMs: 2_000,
    run: () => {
      coreHealthSweep.stop();
      return Promise.resolve();
    },
  });

  lifecycle.ready(`ms-core ${VERSION}`);
  logger.info('ready');

  await lifecycle.waitForShutdown();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  if (args.command === 'config-check') {
    // Before the bootstrap, deliberately: `bootstrap` loads the configuration and would exit on
    // a bad one with the process's own error path, which is exactly the message this command
    // exists to render properly.
    process.exitCode = runConfigCheck({
      schema: coreConfigSchema,
      service: 'ms-core',
      version: VERSION,
      argv: process.argv.slice(2),
      write: (line) => process.stdout.write(`${line}\n`),
      writeError: (line) => process.stderr.write(`${line}\n`),
    });
    return;
  }

  if (args.command === 'migrate') {
    const { config, logger } = bootstrap<CoreConfig>({
      schema: coreConfigSchema,
      version: VERSION,
      build: BUILD,
    });
    const exitCode = await runMigrateCommand({
      action: args.migrateAction,
      steps: args.steps,
      config,
      logger,
      write: (line) => process.stdout.write(`${line}\n`),
    });
    process.exitCode = exitCode;
    return;
  }

  await serve();
}

/**
 * Which engine the database has, and what it can do, or a refusal to start.
 *
 * **A database this build cannot use is a `ConfigError`** (`P-226`): no TimescaleDB extension, or
 * one older than `MINIMUM_TIMESCALEDB`. Restarting finds the same database and refuses again, so
 * it exits 78 and the unit's `RestartPreventExitStatus=` stops it at once, with the reason at the
 * top of `systemctl status` and the start limit left for the operator's restart (`P-222`).
 * Anything else the check throws keeps exit 1.
 */
export async function engineOrRefuse(
  store: Pick<TimeSeriesStore, 'capabilities'>,
  q: Queryable,
): Promise<EngineCapabilities> {
  try {
    return await store.capabilities(q);
  } catch (error) {
    if (error instanceof EngineError) throw new ConfigError(error.message, { cause: error });
    throw error;
  }
}

// Only run when executed as a program, so tests can import the parser.
if (process.argv[1] !== undefined && import.meta.filename === realpathSync(process.argv[1])) {
  main().catch((error: unknown) => {
    const { status, line } = startFailure(error);
    // Waited for, so a stalled journal cannot discard the one line that says why (`P-216` part 3).
    exitWithLine(status, line);
  });
}

/**
 * The devices already in a group, for `D-04`'s idempotency check.
 *
 * Direct rather than through `ObjectService.list`, because what is wanted is the whole group at
 * once with the one field that identifies a device — and paging through a listing API to build
 * an in-memory index would be a page size somebody has to tune.
 */
async function devicesInGroup(
  db: Database,
  groupId: number,
): Promise<{ id: number; name: string; host: string }[]> {
  const rows = await db.query<{ id: string; name: string; host: string | null }>(
    `SELECT o.id, o.name, d.host
     FROM object o
     JOIN device_config d ON d.object_id = o.id
     WHERE o.parent_id = $1 AND o.kind = 'device'`,
    [groupId],
  );
  return rows.map((row) => ({ id: Number(row.id), name: row.name, host: row.host ?? '' }));
}

/** Every sensor on those devices, so a re-run creates none of them twice. */
async function sensorsInGroup(
  db: Database,
  groupId: number,
): Promise<{ deviceId: number; sensorType: string; params: Record<string, unknown> }[]> {
  const rows = await db.query<{ parent_id: string; type: string; params: Record<string, unknown> }>(
    `SELECT s.parent_id, sc.type, sc.params
     FROM object s
     JOIN sensor_config sc ON sc.object_id = s.id
     JOIN object d ON d.id = s.parent_id
     WHERE d.parent_id = $1 AND d.kind = 'device' AND s.kind = 'sensor'`,
    [groupId],
  );
  return rows.map((row) => ({
    deviceId: Number(row.parent_id),
    sensorType: row.type,
    params: row.params,
  }));
}

/**
 * Which credential kinds a group could resolve, so a sensor that cannot authenticate is not made.
 *
 * The *ancestry*, not the group alone: credentials are an inheritable setting (`A-05`), so a
 * community set at the root reaches every group under it. Asking only about the group would
 * leave out most installations, which set their credentials once at the top.
 */
async function credentialKindsInScope(db: Database, groupId: number): Promise<Set<string>> {
  const rows = await db.query<{ kind: string }>(
    `WITH RECURSIVE ancestry AS (
       SELECT id, parent_id, 0 AS depth FROM object WHERE id = $1
       UNION ALL
       SELECT o.id, o.parent_id, a.depth + 1 FROM object o JOIN ancestry a ON o.id = a.parent_id
       WHERE a.depth < ${String(MAX_WALK_DEPTH)}
     )
     SELECT DISTINCT cs.kind FROM credential_set cs JOIN ancestry a ON a.id = cs.object_id`,
    [groupId],
  );
  return new Set(rows.map((row) => row.kind));
}
