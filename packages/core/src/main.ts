#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  bootstrap,
  coreConfigSchema,
  describeError,
  type CoreConfig,
  type Logger,
} from '@ms/shared';
import { standardCatalogue } from '@ms/sensors';
import { ApiServer } from './api/server.js';
import { runMigrateCommand, type MigrateAction } from './commands/migrate.js';
import { AuditRepository, CompositeAuditSink, DatabaseAuditSink } from './audit/store.js';
import { LoggingAuditSink } from './objects/audit.js';
import { ObjectRepository } from './objects/repository.js';
import { catalogueSensorTypeGate, logSensorTypes } from './objects/sensor-type-gate.js';
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
import { FactoryService } from './factory/service.js';
import { FactorySweep } from './factory/sweep.js';
import { ScheduleSync } from './schedules/sync.js';
import { AlarmEngine } from './notifications/engine.js';
import { AlarmScheduler } from './notifications/scheduler.js';
import { TriggerSync } from './notifications/sync.js';
import { MessageContextLoader } from './notifications/context.js';
import { EmailTransport } from './notifications/delivery/email.js';
import { NotificationDispatcher } from './notifications/dispatcher.js';
import { DeliveryHealthReader } from './notifications/health.js';
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
import { Database } from './db/pool.js';
import { Migrator } from './db/migrator.js';
import { MIGRATIONS } from './db/migrations/index.js';
import { loadLookups } from './lookups/loader.js';
import { loadDeviceTemplates } from './device-templates/loader.js';
import { ChannelResolver } from './ingestion/channels.js';
import { ResultCacheInvalidator } from './ingestion/invalidation.js';
import { Ingestor } from './ingestion/ingestor.js';
import { IngestionService } from './ingestion/service.js';
import { HistoryService } from './timeseries/history.js';
import { SqlTimeSeriesStore } from './timeseries/store.js';
import { Housekeeper } from './timeseries/housekeeper.js';
import { ProbeEndpoint } from './transport/probe-endpoint.js';
import { DiscoveryService } from './discovery/service.js';
import { ProvisionService, type ProvisionReport } from './discovery/provision.js';
import { DiscoveryError } from './discovery/errors.js';
import { RediscoveryService } from './discovery/rediscovery.js';
import { ProbeRegistry } from './probes/registry.js';
import { ProbeReachability } from './probes/reachability.js';
import { RediscoverySweep } from './discovery/rediscovery-sweep.js';
import type { Actor } from './objects/audit.js';
import { ReplayPacer } from './ingestion/replay-pacer.js';
import { ProbeConfigService } from './probes/config.js';
import { SensorStateService } from './state/service.js';
import { ConfigChangeNotifier } from './probes/notifier.js';
import { VERSION } from './version.js';

const USAGE = `ms-core ${VERSION}

  ms-core [--config <file>]              run the core server
  ms-core migrate status                 show applied and pending migrations
  ms-core migrate up                     apply pending migrations
  ms-core migrate down [--steps <n>]     roll back the most recent migration(s)

Configuration is layered: schema defaults, then the file, then MS_* environment variables.
`;

export interface ParsedArgs {
  command: 'serve' | 'migrate' | 'help';
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

/**
 * Brings the schema up to date at start-up when `database.autoMigrate` is set.
 *
 * Failing to migrate is fatal. A core running against a schema it does not understand writes
 * data it cannot read back, and that is worse than not starting.
 */
async function migrateOnStart(db: Database, logger: Logger): Promise<void> {
  const migrator = new Migrator({ db, logger, migrations: MIGRATIONS });
  const { applied } = await migrator.up();
  if (applied.length === 0) logger.debug('schema already up to date');
}

async function serve(): Promise<void> {
  const { config, logger, lifecycle } = bootstrap<CoreConfig>({
    schema: coreConfigSchema,
    version: VERSION,
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

  const { serverVersion } = await db.check();
  const store = new SqlTimeSeriesStore();
  // Which engine, and what it can do. Reported rather than assumed: a database started under
  // the Apache licence has no compaction, and the housekeeping loop needs to know that before
  // it spends every pass asking for it.
  const engine = await store.capabilities(db);
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
    await migrateOnStart(db, logger);
  } else {
    const status = await new Migrator({ db, logger, migrations: MIGRATIONS }).status();
    if (status.pending.length > 0) {
      // Refusing to start is the safe failure: the alternative is running against a schema
      // this build was not written for.
      throw new Error(
        `${String(status.pending.length)} schema migration(s) are pending and autoMigrate is off; run "ms-core migrate up"`,
      );
    }
  }

  const resolver = new InheritanceResolver({ db, logger });

  // Rides the audit sink, which every mutation already goes through, so no new mutation path
  // has to remember to tell the probes about itself (R-04).
  const configNotifier = new ConfigChangeNotifier({ logger });
  // Registered once, then sealed: a type appearing later would mean two probes disagreeing
  // about what a sensor is.
  const catalogue = standardCatalogue();

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
  });

  // Built here rather than beside the ingestion service, because the audit sink below has to
  // hold them: they cache channel limits and sensor states, and an edited limit that only took
  // effect after a restart would not be the "immediate effect" M-04 promises.
  const channels = new ChannelResolver({ logger, lookups });
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
  const alarms = new AlarmEngine({
    logger,
    onArmed: () => {
      wakeAlarms.poke();
    },
    onQueued: () => {
      wakeDelivery.poke();
    },
  });
  // Live state changes for the UI (U-02). Published after the commit, from `writeStateHistory`
  // — the one function every state change in the system goes through — so ingestion, a pause,
  // an acknowledgement, a simulated error and a dependency cascade all reach it without each
  // path having to remember.
  const stream = new StateBroadcaster({ logger });
  const publishStates: CommittedStates = (committed) => {
    void stream.publish(db, committed);
  };
  // Read through a closure because `R-05` needs this service to build and this service needs
  // its answer: the state machine asks "is this sensor's probe up" on every decision, and the
  // thing that knows is the probe endpoint's link, which is built much later. Nothing calls it
  // until a state is decided, which is long after both exist.
  // eslint-disable-next-line prefer-const -- assigned below, once reachability exists.
  let reachabilityRef: ProbeReachability | undefined;
  const noProbesDown: ReadonlySet<number> = new Set();
  const states = new SensorStateService({
    db,
    logger,
    settings: resolver,
    alarms,
    onStatesCommitted: publishStates,
    unreachableSensors: () => reachabilityRef?.unreachableSensors() ?? noProbesDown,
  });
  // The configuration half of the same job: adding a trigger during an outage has to arm the
  // outage, and moving a subtree under one has to arm what arrives with it.
  const triggerSync = new TriggerSync({ engine: alarms, logger });
  const cacheInvalidator = new ResultCacheInvalidator({ channels, sensors: states, logger });

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
    audit: new CompositeAuditSink([
      new DatabaseAuditSink(),
      new LoggingAuditSink(logger),
      configNotifier,
      cacheInvalidator,
      scheduleSync,
      dependencySync,
      triggerSync,
    ]),
    sensorTypes: catalogueSensorTypeGate(catalogue),
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

  // The library itself. Its own audit sink, so a schedule edit re-derives the flags in the same
  // transaction that changed it — the same composite the object service uses, because a
  // schedule change has to reach the probes exactly as an object change does.
  const scheduleAudit = new CompositeAuditSink([
    new DatabaseAuditSink(),
    new LoggingAuditSink(logger),
    configNotifier,
    scheduleSync,
    dependencySync,
  ]);
  const schedules = new ScheduleService({ db, audit: scheduleAudit, logger });
  await schedules.seedBuiltIns();

  // The trigger library (N-01). Audited and logged like everything else, but deliberately not
  // wired to the configuration notifier: a trigger decides who gets told about a sensor, not
  // what a probe scans, so pushing one to every probe would be churn for a change none of them
  // acts on. The database still bumps the owning object's version, so the next reconnect
  // carries it.
  const triggers = new TriggerService({
    db,
    audit: new CompositeAuditSink([
      new DatabaseAuditSink(),
      new LoggingAuditSink(logger),
      triggerSync,
    ]),
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
  pauseSweep.start();
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
    ingest: async (results) => {
      await ingestion.acceptResults('factory', {
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
    logger,
    onChanged: () => {
      configNotifier.flush();
    },
  });
  scheduleSweep.start();
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
  const email = new EmailTransport({ config: config.notifications.smtp, logger });
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
  const deliveryHealth = new DeliveryHealthReader({
    staleAfterMs: config.notifications.retry.staleAfterSeconds * 1_000,
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
    logger,
    // The endpoint does not exist yet, so `offline` is the honest answer until it does — the
    // run waits and is offered again, which is exactly what happens to a probe that has not
    // connected. Reading a missing endpoint as `too-old` would fail runs during start-up.
    dispatch: (probeObjectId, message) =>
      probeEndpointRef?.sendSweep(probeObjectId, message) ?? { kind: 'offline' },
    onFinished: async (runId) => {
      await rediscoveryRef?.runFinished(runId);
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

  const provision = async (runId: number, actor: Actor): Promise<ProvisionReport> => {
    const run = await discovery.get(runId);
    if (run === null) {
      throw new DiscoveryError(
        'DISCOVERY_RUN_NOT_FOUND',
        `there is no discovery run ${String(runId)}`,
        {
          context: { runId },
        },
      );
    }
    const [hosts, existingDevices, existingSensors] = await Promise.all([
      discovery.hosts(runId, 65_536),
      devicesInGroup(db, run.groupId),
      sensorsInGroup(db, run.groupId),
    ]);
    const report = await provisioner.provision({
      run,
      hosts,
      existingDevices,
      existingSensors,
      actor,
    });
    await discovery.recordProvisioning(runId, report);
    return report;
  };

  // Scheduled rediscovery (`D-07`). Off by default in the strongest sense: there is no schedule
  // until somebody creates one, and a new one is created disabled with auto-provisioning
  // separately off.
  const rediscovery = new RediscoveryService({
    db,
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
    logger,
    enrolmentKeys: config.probeEndpoint.accessKeys,
  });

  const api = new ApiServer({
    config: config.api,
    logger,
    version: VERSION,
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
    triggers,
    templates,
    deliveryHealth,
    tester,
    stream,
  });
  await api.build(VERSION, service);
  await api.start();
  lifecycle.onShutdown({ name: 'api', timeoutMs: 5_000, run: () => api.stop() });

  // Shutdown runs these in reverse, and the order is the point: the probe endpoint closes
  // first so nothing new arrives, then ingestion drains what it has already promised to store,
  // then housekeeping, then the API, and the database last of all — every one of them needs a
  // live pool right up until it is done.

  // The data lifecycle: rollups, compression, retention, orphan reaping. Started after the API
  // so a slow first pass — the one catching up after a long stop — cannot delay the port
  // opening.
  const housekeeper = new Housekeeper({ db, logger, config: config.housekeeping, store });
  housekeeper.start();
  lifecycle.onShutdown({
    name: 'housekeeping',
    timeoutMs: 15_000,
    run: () => housekeeper.stop(),
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
    // What turns an outcome into Up, Warning or Down (M-02). Its writes ride in the readings'
    // own transaction, so the two can never disagree about what happened.
    states,
  });

  // A lost probe is one alarm, not a thousand (`R-05`). Built before the endpoint, which is
  // what tells it when a link comes and goes.
  const reachability = new ProbeReachability({ db, logger, states });
  reachabilityRef = reachability;

  const probeEndpoint: ProbeEndpoint = new ProbeEndpoint({
    config: config.probeEndpoint,
    logger,
    coreVersion: VERSION,
    results: ingestion,
    discovery,
    registry: probeRegistry,
    reachability,
    probeConfig: new ProbeConfigService({
      db,
      resolver,
      vault,
      // Only the kinds a type declared, so a probe running Ping never receives an SNMP
      // community string (`A-05`).
      credentialKindsFor: (sensorType) =>
        catalogue.has(sensorType) ? (catalogue.declaration(sensorType).credentialKinds ?? []) : [],
      // A Sensor Factory is computed here, from readings this process already holds, so it never
      // appears in a probe's assignment list (`T-21`).
      coreEvaluated: (sensorType) =>
        catalogue.has(sensorType) && catalogue.declaration(sensorType).evaluatedBy === 'core',
    }),
  });
  probeEndpointRef = probeEndpoint;
  configNotifier.attach(probeEndpoint);
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

  if (args.command === 'migrate') {
    const { config, logger } = bootstrap<CoreConfig>({
      schema: coreConfigSchema,
      version: VERSION,
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

// Only run when executed as a program, so tests can import the parser.
if (process.argv[1] !== undefined && import.meta.filename === realpathSync(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`fatal: ${describeError(error).message}\n`);
    process.exit(1);
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
       SELECT id, parent_id FROM object WHERE id = $1
       UNION ALL
       SELECT o.id, o.parent_id FROM object o JOIN ancestry a ON o.id = a.parent_id
     )
     SELECT DISTINCT cs.kind FROM credential_set cs JOIN ancestry a ON a.id = cs.object_id`,
    [groupId],
  );
  return new Set(rows.map((row) => row.kind));
}
