#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
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
import { ObjectService } from './objects/service.js';
import { PauseSweep } from './objects/pause-sweep.js';
import { DependencyPauses } from './dependencies/pauses.js';
import { DependencyRepository } from './dependencies/repository.js';
import { DependencySync } from './dependencies/sync.js';
import { SchedulePauses } from './schedules/pauses.js';
import { ScheduleRepository } from './schedules/repository.js';
import { ScheduleService } from './schedules/service.js';
import { ScheduleSweep } from './schedules/sweep.js';
import { ScheduleSync } from './schedules/sync.js';
import { AlarmEngine } from './notifications/engine.js';
import { AlarmScheduler } from './notifications/scheduler.js';
import { TriggerSync } from './notifications/sync.js';
import { TemplateService } from './notifications/templates.js';
import { TriggerService } from './triggers/service.js';
import { InheritanceResolver } from './settings/inheritance.js';
import { Database } from './db/pool.js';
import { Migrator } from './db/migrator.js';
import { MIGRATIONS } from './db/migrations/index.js';
import { loadLookups } from './lookups/loader.js';
import { ChannelResolver } from './ingestion/channels.js';
import { ResultCacheInvalidator } from './ingestion/invalidation.js';
import { Ingestor } from './ingestion/ingestor.js';
import { IngestionService } from './ingestion/service.js';
import { HistoryService } from './timeseries/history.js';
import { SqlTimeSeriesStore } from './timeseries/store.js';
import { Housekeeper } from './timeseries/housekeeper.js';
import { ProbeEndpoint } from './transport/probe-endpoint.js';
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

  // Built-ins, then whatever the operator wrote under <dataDir>/lookups, later winning by id
  // (M-06). Loaded before anything can report a reading, because a channel resolved without its
  // lookup would be judged by nothing until the next time its cache went cold.
  const lookups = await loadLookups({
    directory: join(config.service.dataDir, 'lookups'),
    logger,
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
  const alarms = new AlarmEngine({
    logger,
    onArmed: () => {
      wakeAlarms.poke();
    },
  });
  const states = new SensorStateService({ db, logger, settings: resolver, alarms });
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
    schedules: new ScheduleRepository(),
    dependencies: dependencyRepository,
    dependencyDelays: dependencyPauses,
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
  const templates = new TemplateService({
    db,
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
    triggers,
    templates,
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

  const probeEndpoint = new ProbeEndpoint({
    config: config.probeEndpoint,
    logger,
    coreVersion: VERSION,
    results: ingestion,
    probeConfig: new ProbeConfigService({ db, resolver }),
  });
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
