#!/usr/bin/env node
import {
  bootstrap,
  describeError,
  probeConfigSchema,
  runConfigCheck,
  type CheckResult,
  type ProbeConfig,
} from '@ms/shared';
import { standardCatalogue } from '@ms/sensors';
import { SCRIPT_DIR_ENV } from '@ms/sensors/script';
import { POWERSHELL_ENV } from '@ms/sensors/windows';
import { autoPoolCeilingMax, CheckPool, defaultPoolSize } from './runner/pool.js';
import { poolDemand } from './runner/demand.js';
import { ICMP_PING_CHECK_MS, POOL_DEMAND_MARGIN } from './measured.js';
import { ProcessRunner } from './runner/process-runner.js';
import { QueryRunner } from './queries/runner.js';
import type { ResultMeta } from './runner/types.js';
import { LISTENER_ID, TrapListener } from './listeners/trap-listener.js';
import { LISTENER_ID as SYSLOG_LISTENER_ID, SyslogListener } from './listeners/syslog-listener.js';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AssignmentStore } from './scheduler/assignments.js';
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

/**
 * What a check is assumed to cost before this probe has run one of that type.
 *
 * `icmp.ping` after `P-07` — the type we ship, and a fair stand-in for anything that waits for a
 * packet. Deliberately not the smallest plausible number: a low guess derives a ceiling under
 * the floor and reproduces `P-32`, and measurement replaces it within one interval anyway.
 *
 * Imported rather than retyped (`P-35`): this constant existing in three files under three names
 * is what let `P-31` and `P-32` happen.
 */
const ASSUMED_CHECK_MS = ICMP_PING_CHECK_MS;

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
  const spoolResult = (result: CheckResult, meta: ResultMeta): void => {
    logger.debug(
      { sensorId: result.sensorId, outcome: result.outcome, phase: meta.phase },
      'check finished',
    );
    // Straight to disk, then woken so the drain offers it immediately if the core is up.
    // The pool's callback is synchronous and must not wait for a write: `append` serialises
    // internally, so ordering holds without the scheduler ever blocking on the filesystem.
    void spool
      .append([result])
      .then(() => {
        drain.wake();
      })
      .catch((error: unknown) => {
        // A spool that cannot write is a probe that will lose readings, and the only thing
        // worse than losing them is losing them quietly.
        logger.error(
          { ...describeError(error), sensorId: result.sensorId },
          'could not spool a result',
        );
      });
  };

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
  const wheel = new TimingWheel({
    logger,
    onDue: (due) => {
      for (const sensorId of due) {
        const assignment = assignments.get(sensorId);
        if (assignment === undefined) continue;
        // A listener sensor is handed what arrived since its last scan instead of polling. The
        // drain is a slice of a ring buffer — O(what arrived) and no I/O — so it is safe on the
        // wheel's own thread, which must never wait for anything.
        const wants = listenerFor.get(assignment.sensorType);
        const received =
          wants === LISTENER_ID && trapListener !== undefined
            ? trapListener.drain(sensorId)
            : wants === SYSLOG_LISTENER_ID && syslogListener !== undefined
              ? syslogListener.drain(sensorId)
              : undefined;
        const runner = isolated.has(assignment.sensorType) ? processRunner : pool;
        runner.submit({
          sensorId,
          sensorType: assignment.sensorType,
          target: assignment.target,
          params: assignment.params,
          ...(assignment.credentials === undefined ? {} : { credentials: assignment.credentials }),
          ...(received === undefined ? {} : { received }),
          timeoutMs: assignment.timeoutMs,
        });
      }
    },
  });
  // Constructed before the wheel is started: `onDue` closes over this binding, and a tick that
  // fired first would find it in the temporal dead zone.
  const assignments = new AssignmentStore(wheel);

  // ── the pool ceiling, derived from the work this probe was actually given (`P-34`) ──────────
  //
  // **Only when the operator has not said otherwise.** A non-zero `workerPoolSize` is somebody's
  // statement about how much memory this probe may use, and a derived number must not overrule
  // it — `size > 0` therefore means a fixed ceiling exactly as before, and this loop does
  // nothing. At the default of 0 the probe sizes itself, which is the case `P-32` showed a
  // constant cannot serve: 48 was under the floor for `icmp.ping` at the v1 target and 64 is
  // more than a probe watching fast checks needs at the same sensor count.
  const autoSize = config.probe.workerPoolSize <= 0;
  const sizePool = (): void => {
    if (!autoSize) return;
    const demand = poolDemand(assignments.values(), (type) => pool.typicalDurationMs(type), {
      fallbackMs: ASSUMED_CHECK_MS,
      min: defaultPoolSize(),
      max: autoPoolCeilingMax(),
      margin: POOL_DEMAND_MARGIN,
    });
    if (demand.clamped && demand.required * POOL_DEMAND_MARGIN > autoPoolCeilingMax()) {
      // Visible rather than silent (`WORKFLOW.MD` §5). The pool will also saturate and raise
      // `poolUsage` on Probe Health, which is the alarm an operator already has a trigger on;
      // this names the number that was refused so the log says what to do about it.
      logger.warn(
        { required: Math.ceil(demand.required), cap: autoPoolCeilingMax() },
        'workload needs more workers than a probe may derive for itself; set workerPoolSize',
      );
    }
    pool.setMaxSize(demand.ceiling);
  };

  // Durations drift as networks do, so the ceiling is recomputed on a timer as well as on every
  // config push. Thirty seconds is far below the interval of anything it sizes for and far above
  // the cost of summing five thousand assignments.
  if (autoSize) {
    const sizeTimer = setInterval(sizePool, 30_000);
    sizeTimer.unref();
    lifecycle.onShutdown({
      name: 'pool-sizer',
      timeoutMs: 1_000,
      run: () => {
        clearInterval(sizeTimer);
      },
    });
  }

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
    spool: () => spool.stats(),
    // How much is waiting is the spool's; whether any of it is *moving* is only the drain's, and
    // the difference is the whole of `615c9f3` — a full spool and a healthy link read identically
    // without it.
    drain: () => drain.stats(),
  });

  const coreClient = new CoreClient({
    config,
    logger,
    agentVersion: VERSION,
    health: () => health.report(),
    onStateChange: (state) => {
      logger.info({ linkState: state }, 'link state changed');
      // The backlog is the first thing to move once the link is back.
      if (state === 'connected') drain.wake();
    },
    onConfig: (update) => {
      const size = assignments.apply(update);
      // A deleted sensor should stop costing a cursor. Cheap, and it runs only on a config push.
      trapListener?.retain(assignments.ids());
      // The workload just changed, so the ceiling derived from it is stale (`P-34`). Sized here
      // rather than only on the timer because a config push is exactly when a probe goes from
      // fifty sensors to five thousand, and discovering that a tick later is a tick of backlog.
      sizePool();
      return size;
    },
    onSweep: (message) => {
      switch (message.kind) {
        case 'start':
          sweeps.start(message.job);
          return;
        case 'cancel':
          sweeps.cancel(message.runId);
          return;
        case 'identify':
          identifications.start(message.job);
          return;
        case 'identify-cancel':
          identifications.cancel(message.runId);
          return;
      }
    },
    onQuery: (message) => {
      switch (message.kind) {
        case 'run':
          queries.run(message.queryId, message.query, message.timeoutMs);
          return;
        case 'cancel':
          queries.cancel(message.queryId);
          return;
      }
    },
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
