#!/usr/bin/env node
import {
  bootstrap,
  describeError,
  probeConfigSchema,
  runConfigCheck,
  type ProbeConfig,
  type SensorAssignment,
} from '@ms/shared';
import { standardCatalogue } from '@ms/sensors';
import { SCRIPT_DIR_ENV } from '@ms/sensors/script';
import { POWERSHELL_ENV } from '@ms/sensors/windows';
import { CheckPool } from './runner/pool.js';
import { ProcessRunner } from './runner/process-runner.js';
import { QueryRunner } from './queries/runner.js';
import { resultSink } from './result-sink.js';
import { LISTENER_ID, TrapListener } from './listeners/trap-listener.js';
import { LISTENER_ID as SYSLOG_LISTENER_ID, SyslogListener } from './listeners/syslog-listener.js';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AssignmentStore } from './scheduler/assignments.js';
import { coreHandlers } from './core-handlers.js';
import { dueDispatcher, type DueListener } from './due-dispatch.js';
import { CheckFlowWatchdog } from './health/check-flow.js';
import { poolSizer } from './pool-sizer.js';
import { ResultSpool } from './spool/spool.js';
import { SpoolDrain } from './spool/drain.js';
import { TimingWheel } from './scheduler/wheel.js';
import { SweepRunner } from './discovery/sweep.js';
import { pingOnce } from './discovery/ping-probe.js';
import { IdentifyRunner } from './discovery/identify-runner.js';
import { LIVE_SOURCES } from './discovery/sources.js';
import { ProbeHealthReporter } from './health/report.js';
import { CoreClient } from './transport/core-client.js';
import { VERSION } from './version.js';

/**
 * `ms-probe config check` — the only verb this service has, and it earns its place (`H-03`).
 *
 * `install.sh` runs it against the configuration already on disk, with the *new* build, before
 * it restarts anything. Handled before `bootstrap` because bootstrap is what would fail on a bad
 * configuration, with the process's own error path rather than the message this exists to print.
 *
 * Anything else is the server, exactly as before. A typo must not silently start a second probe,
 * so `config <anything but check>` is a usage error rather than a fall-through.
 */
function configCheckRequested(argv: readonly string[]): 'check' | 'usage' | 'none' {
  const positional = argv.filter((one) => !one.startsWith('-'));
  // `--config <path>` puts a path in the positional list; the verb is only ever the first word.
  if (positional[0] !== 'config') return 'none';
  return argv[argv.indexOf('config') + 1] === 'check' ? 'check' : 'usage';
}

async function main(): Promise<void> {
  const requested = configCheckRequested(process.argv.slice(2));
  if (requested !== 'none') {
    if (requested === 'usage') {
      process.stderr.write(
        `ms-probe ${VERSION}\n\n  ms-probe [--config <file>]\n  ms-probe config check\n`,
      );
      process.exitCode = 2;
      return;
    }
    process.exitCode = runConfigCheck({
      schema: probeConfigSchema,
      service: 'ms-probe',
      version: VERSION,
      argv: process.argv.slice(2),
      write: (line) => process.stdout.write(`${line}\n`),
      writeError: (line) => process.stderr.write(`${line}\n`),
    });
    return;
  }

  const { config, logger, lifecycle } = bootstrap<ProbeConfig>({
    schema: probeConfigSchema,
    version: VERSION,
  });

  logger.info(
    {
      core: `${config.core.host}:${String(config.core.port)}`,
      spoolDir: config.probe.spoolDir,
      displayName: config.probe.displayName,
    },
    'probe configured',
  );

  // Results go to disk before anything else touches them: a probe that cannot reach the core
  // keeps scanning and keeps them, where PRTG buffers in RAM and loses the lot on a restart.
  await mkdir(config.probe.spoolDir, { recursive: true });
  const spool = await ResultSpool.open({
    dir: config.probe.spoolDir,
    maxBytes: config.probe.spoolMaxBytes,
    segmentMaxBytes: config.probe.spoolSegmentMaxBytes,
    logger,
  });

  // Constructed here, before anything that can produce a result: the pool's callback wakes it,
  // and a check finishing before this binding existed would be a temporal-dead-zone crash.
  // `client` reads `coreClient` through a getter, so the two can need each other without
  // either having to exist first; nothing runs until `drain.start()`.
  // **Annotated rather than inferred.** Probe Health reads the drain, the core client is what
  // the drain sends through, and the client is built with the health reporter — so the three
  // now refer to each other in a cycle that inference cannot unwind. Naming this one type is
  // enough to break it.
  const drain: SpoolDrain = new SpoolDrain({
    spool,
    client: {
      get connected() {
        return coreClient.connected;
      },
      sendResults: (results, backlog) => coreClient.sendResults(results, backlog),
    },
    logger,
    batchMaxRows: config.probe.spoolBatchMaxRows,
    catchUpMaxRows: config.probe.spoolCatchUpMaxRows,
  });

  // One sink for both runners: a check that ran in a process of its own is spooled, drained and
  // acknowledged exactly like one that ran in a worker, because to everything downstream it is
  // the same reading.
  // **The single sink both runners settle into** (`P-76`), which is what makes one watchdog able
  // to see every completion however the check ended. Declared before `spoolResult` so it can be
  // told; the assignments that give it intervals arrive further down, so it reads them lazily.
  const checkFlow = new CheckFlowWatchdog({
    // Through a closure for the reason the dispatcher's `assignments` is: the store is built
    // after the wheel, so reading the binding here would be its temporal dead zone.
    intervalFor: (sensorId: number): number | undefined =>
      assignments.get(sensorId)?.intervalSeconds,
    // Over the assignments rather than over what has completed: a probe where nothing has ever
    // come back has no completions to count, and reported `behind: 0` for being 100% behind.
    assigned: (): Iterable<number> => assignments.ids(),
  });

  // Extracted, because the rule it carries — an error is a completion — could not be asserted
  // while it lived here (`P-83`). `result-sink.ts` says why.
  const spoolResult = resultSink({ logger, spool, drain, checkFlow });

  // Where PowerShell is, for the Windows sensors (`T-09`). In *this* process's environment
  // rather than a runner's `childEnv`, because a Windows check runs in a worker and a worker
  // inherits the probe's environment — and resolved here for the same reason `scriptDir` is,
  // so a relative path in the config file means what the operator who wrote it meant.
  if (config.probe.powerShellPath !== '') {
    process.env[POWERSHELL_ENV] =
      config.probe.powerShellPath.includes('/') || config.probe.powerShellPath.includes('\\')
        ? resolve(config.probe.powerShellPath)
        : config.probe.powerShellPath;
  }

  const pool = new CheckPool({
    logger,
    size: config.probe.workerPoolSize,
    minSize: config.probe.workerPoolMinSize,
    idleShrinkMs: config.probe.workerPoolIdleShrinkMs,
    queueMaxLength: config.probe.checkQueueMaxLength,
    abortGraceMs: config.probe.checkAbortGraceMs,
    onResult: spoolResult,
  });
  await pool.start();
  lifecycle.onShutdown({ name: 'check-pool', timeoutMs: 10_000, run: () => pool.stop() });

  // Checks that run in a process of their own (`P-03`). Same submit/callback contract as the
  // pool, same spooling on the way out — the only difference is where the check runs, which is
  // the sensor type's declaration and not this file's business to decide.
  const processRunner = new ProcessRunner({
    logger,
    maxConcurrent: config.probe.processRunnerMaxConcurrent,
    queueMaxLength: config.probe.processRunnerQueueMaxLength,
    memoryLimitMb: config.probe.processMemoryLimitMb,
    ...(config.probe.processUid > 0 ? { uid: config.probe.processUid } : {}),
    ...(config.probe.processGid > 0 ? { gid: config.probe.processGid } : {}),
    // The one probe-level policy setting an isolated check is given (`T-19`). Absent when no
    // script directory is configured, which makes an EXE/Script sensor fail saying so rather
    // than run something from wherever it happened to be started.
    // Resolved here, against the *probe's* working directory, because that is what every other
    // path in this config file is relative to (`spoolDir`, the TLS files). The check runs in a
    // child process whose working directory is its own, so a relative path handed straight
    // through would be resolved against somewhere nobody configured.
    ...(config.probe.scriptDir === ''
      ? {}
      : { childEnv: { [SCRIPT_DIR_ENV]: resolve(config.probe.scriptDir) } }),
    onResult: spoolResult,
  });
  lifecycle.onShutdown({
    name: 'process-runner',
    timeoutMs: 30_000,
    run: () => processRunner.stop(),
  });

  // Which sensor types are fed by a listener rather than by polling (`T-06`), asked of the
  // catalogue rather than matched on an id here: `T-20`'s syslog receiver is already the second
  // one, and a probe with a hardcoded type id would need editing for each.
  //
  // Building the catalogue in this thread is cheap and does not load a protocol stack: a type's
  // heavy imports live inside `execute`, which only a worker ever calls.
  const listenerFor = new Map<string, string>();
  // And which run in a process of their own (`P-03`), asked the same way and for the same reason.
  const isolated = new Set<string>();
  for (const summary of standardCatalogue().summaries()) {
    const declaration = standardCatalogue().declaration(summary.id);
    if (declaration.listener !== undefined) listenerFor.set(summary.id, declaration.listener);
    if (declaration.isolation === 'process') isolated.add(summary.id);
  }

  const trapListener = config.trapListener.enabled
    ? new TrapListener({
        logger,
        port: config.trapListener.port,
        address: config.trapListener.address,
        transport: config.trapListener.transport,
        communities: config.trapListener.communities,
        bufferSize: config.trapListener.bufferSize,
      })
    : undefined;
  if (trapListener !== undefined) {
    await trapListener.start();
    lifecycle.onShutdown({
      name: 'trap-listener',
      timeoutMs: 5_000,
      run: () => trapListener.stop(),
    });
  }

  const syslogListener = config.syslogListener.enabled
    ? new SyslogListener({
        logger,
        port: config.syslogListener.port,
        address: config.syslogListener.address,
        udp: config.syslogListener.udp,
        tcp: config.syslogListener.tcp,
        ipVersion: config.syslogListener.ipVersion,
        senders: config.syslogListener.senders,
        bufferSize: config.syslogListener.bufferSize,
      })
    : undefined;
  if (syslogListener !== undefined) {
    await syslogListener.start();
    lifecycle.onShutdown({
      name: 'syslog-listener',
      timeoutMs: 5_000,
      run: () => syslogListener.stop(),
    });
  }

  // The scheduler hands due sensors to the pool and returns. `onDue` runs on the wheel's own
  // thread, so it must never wait for a check — `submit` is fire-and-forget by design.
  // A listener the operator disabled is simply absent, which is what lets the dispatcher do one
  // lookup rather than a chain of conditionals per listener kind.
  const listeners = new Map<string, DueListener>();
  if (trapListener !== undefined) listeners.set(LISTENER_ID, trapListener);
  if (syslogListener !== undefined) listeners.set(SYSLOG_LISTENER_ID, syslogListener);

  const wheel = new TimingWheel({
    logger,
    onDue: dueDispatcher({
      // A closure with its return type written down, not the binding itself. `assignments` is
      // constructed below because it needs the wheel, so reading it here would be its temporal
      // dead zone — and leaving the type to inference makes `wheel` circular through it.
      assignments: {
        get: (sensorId: number): SensorAssignment | undefined => assignments.get(sensorId),
      },
      listenerFor,
      listeners,
      isolated,
      pool,
      processRunner,
      onDispatch: (sensorId, timeoutMs, runner) => {
        checkFlow.dispatched(sensorId, timeoutMs, runner);
      },
    }),
  });
  // Constructed before the wheel is started: `onDue` closes over this binding, and a tick that
  // fired first would find it in the temporal dead zone.
  const assignments = new AssignmentStore(wheel);
  // A sensor that has left stops being this probe's business, and its per-sensor state goes with
  // it — otherwise the watchdog keeps one entry for every sensor ever assigned (`P-77`).
  assignments.onDrop((sensorId) => {
    checkFlow.forget(sensorId);
  });
  // And the other half (`P-80`): a sensor's four intervals start when this probe becomes
  // responsible for it, not when the process did. Without this a reconnect's chunked config push
  // reported thousands of healthy sensors as behind schedule.
  assignments.onAdd((sensorId) => {
    checkFlow.assigned(sensorId);
  });

  // ── the pool ceiling, derived from the work this probe was actually given (`P-34`) ──────────
  //
  // The policy lives in `pool-sizer.ts` so that `scripts/sizing/autosize.mjs` runs the same loop
  // this does rather than a model of it (`P-43`, `P-44`).
  const sizer = poolSizer({
    logger,
    pool,
    assignments: () => assignments.values(),
    configuredSize: config.probe.workerPoolSize,
  });
  sizer.start();
  lifecycle.onShutdown({
    name: 'pool-sizer',
    timeoutMs: 1_000,
    run: () => {
      sizer.stop();
    },
  });

  wheel.start();
  lifecycle.onShutdown({
    name: 'scheduler',
    timeoutMs: 5_000,
    run: () => {
      wheel.stop();
      logger.info({ scheduler: wheel.stats(), pool: pool.stats() }, 'scheduler stopped');
    },
  });

  // On-demand queries (`R-09`). Its own pool of one, beside the scheduled one, because a person
  // watching a spinner should not queue behind whatever was due on the same tick — and because a
  // query must never be able to displace monitoring, however many arrive.
  const queries = new QueryRunner({
    logger,
    answer: (message) => {
      coreClient.sendQueryResult(message);
    },
  });
  await queries.start();
  lifecycle.onShutdown({ name: 'query-runner', timeoutMs: 10_000, run: () => queries.stop() });

  // The discovery sweep (`D-01`). Constructed before the client because the client's `onSweep`
  // hands straight to it, and it reports back through `coreClient` — the same getter pattern
  // the drain uses, for the same reason: the two need each other and neither can exist first.
  const sweeps = new SweepRunner({
    logger,
    probe: pingOnce,
    // **What keeps a sweep from starving live checks.** A queued check is a scan that is already
    // late; the sweep stands down entirely while there is one, and counts the time it spent
    // doing so, because backpressure is visible and never silent (CLAUDE.md).
    queueDepth: () => pool.stats().queued,
    onProgress: (runId, cursor, found, failed) => {
      coreClient.sendSweep({ type: 'sweep-progress', runId, cursor, found, failed });
    },
    onFinished: (runId, ending, cursor, message) => {
      coreClient.sendSweep({ type: 'sweep-finished', runId, ending, cursor, message });
    },
  });
  lifecycle.onShutdown({
    name: 'sweep-runner',
    timeoutMs: 5_000,
    run: () => {
      // Each run reports as cancelled, which leaves it `queued` on the core — so a restart
      // resumes from the cursor rather than starting the range again.
      sweeps.stop();
      return Promise.resolve();
    },
  });

  // The second stage (`D-02`). Its own runner rather than a mode on the sweep: the unit of work
  // is a dozen sockets and a resolver query rather than one UDP echo, so it carries its own far
  // lower concurrency, and the two resume independently.
  const identifications = new IdentifyRunner({
    logger,
    sources: LIVE_SOURCES,
    queueDepth: () => pool.stats().queued,
    onProgress: (runId, cursor, found) => {
      coreClient.sendSweep({ type: 'identify-progress', runId, cursor, found });
    },
    onFinished: (runId, ending, cursor, message) => {
      coreClient.sendSweep({ type: 'identify-finished', runId, ending, cursor, message });
    },
  });
  lifecycle.onShutdown({
    name: 'identify-runner',
    timeoutMs: 5_000,
    run: () => {
      identifications.stop();
      return Promise.resolve();
    },
  });

  // The probe's half of Probe Health (`P-13`, `P-04`): scheduler lag, pool saturation, the
  // deferred and refused counts, and the spool depth. Only the probe can measure any of them —
  // and the core's half, which is whether this probe is answering at all, is exactly the half
  // that still works when it is not.
  const health = new ProbeHealthReporter({
    scheduler: () => wheel.stats(),
    pool: () => pool.stats(),
    // The second runner. EXE and Script checks never touch the pool above, so its counters say
    // nothing about them — which is how `P-61` went unnoticed: ten numbers, computed and read by
    // nobody, while a probe saturated by shell-outs looked healthy.
    children: () => processRunner.stats(),
    checkFlow: () => checkFlow.stats(),
    // Only when this probe runs that listener. What the channels are for is `rejected`: a device
    // sending the wrong community has every message dropped before the ring, so the sensor reads
    // a quiet network rather than a receiver turning everything away (`P-64`).
    ...(trapListener === undefined ? {} : { trapListener: () => trapListener.stats() }),
    ...(syslogListener === undefined ? {} : { syslogListener: () => syslogListener.stats() }),
    spool: () => spool.stats(),
    // How much is waiting is the spool's; whether any of it is *moving* is only the drain's, and
    // the difference is the whole of `615c9f3` — a full spool and a healthy link read identically
    // without it.
    drain: () => drain.stats(),
  });

  /**
   * What this probe does when the core says something (`P-43`).
   *
   * Kept out of here on purpose. `main()` builds collaborators and owns their lifecycles; the
   * policy — what runs per message, what waits for a push to settle, which listeners are swept —
   * lives in a module a test can construct. `P-41` and `P-42` were both defects in that policy,
   * four lines apart, and neither could be pinned by a test while it was written inline here.
   */
  const handlers = coreHandlers({
    logger,
    assignments,
    // Both of them, together, so forgetting one is visible (`P-42`).
    listeners: [trapListener, syslogListener].filter((one) => one !== undefined),
    sizePool: sizer.size,
    wakeDrain: () => {
      drain.wake();
    },
    sweeps,
    identifications,
    queries,
  });
  lifecycle.onShutdown({
    name: 'config-settle',
    timeoutMs: 1_000,
    run: () => {
      handlers.stop();
    },
  });

  const coreClient = new CoreClient({
    config,
    logger,
    agentVersion: VERSION,
    health: () => health.report(),
    onStateChange: handlers.onStateChange,
    onConfig: handlers.onConfig,
    onSweep: handlers.onSweep,
    onQuery: handlers.onQuery,
  });
  coreClient.start();
  lifecycle.onShutdown({
    name: 'core-client',
    timeoutMs: 5_000,
    run: () => coreClient.stop(),
  });

  drain.start();
  // Ordered after the client on purpose: the drain stops offering batches before the socket
  // goes, so nothing is left in flight with no way to be answered.
  lifecycle.onShutdown({
    name: 'spool-drain',
    timeoutMs: 5_000,
    run: async () => {
      await drain.stop();
      logger.info({ drain: drain.stats(), spool: spool.stats() }, 'spool drain stopped');
      await spool.close();
    },
  });

  // Phase 2 continues here: the child-process runner (P-03) registers itself, and `T-20` adds
  // the syslog receiver beside the trap listener above, on the same `CheckContext.received`
  // contract.
  //
  // The probe reports ready as soon as it is running: it is *not* waiting for the core. A
  // probe that cannot reach the core still scans and spools (WORKFLOW.MD §10).

  lifecycle.ready(`ms-probe ${VERSION}`);
  logger.info('ready');

  await lifecycle.waitForShutdown();
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${describeError(error).message}\n`);
  process.exit(1);
});
