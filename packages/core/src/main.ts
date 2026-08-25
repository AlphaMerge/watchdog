#!/usr/bin/env node
import { realpathSync } from 'node:fs';
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
import { InheritanceResolver } from './settings/inheritance.js';
import { Database } from './db/pool.js';
import { Migrator } from './db/migrator.js';
import { MIGRATIONS } from './db/migrations/index.js';
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

  // Built here rather than beside the ingestion service, because the audit sink below has to
  // hold them: they cache channel limits and sensor states, and an edited limit that only took
  // effect after a restart would not be the "immediate effect" M-04 promises.
  const channels = new ChannelResolver({ logger });
  const states = new SensorStateService({ db, logger });
  const cacheInvalidator = new ResultCacheInvalidator({ channels, sensors: states, logger });

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
    ]),
    sensorTypes: catalogueSensorTypeGate(catalogue),
    logger,
  });
  logSensorTypes(logger, catalogue);

  const history = new HistoryService({ db, logger, store });
  const api = new ApiServer({
    config: config.api,
    logger,
    version: VERSION,
    service,
    history,
    db,
    audit: new AuditRepository(),
    catalogue,
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
