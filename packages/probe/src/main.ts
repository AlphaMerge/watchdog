#!/usr/bin/env node
import {
  bootstrap,
  describeError,
  probeConfigSchema,
  type CheckResult,
  type ProbeConfig,
} from '@ms/shared';
import { standardCatalogue } from '@ms/sensors';
import { SCRIPT_DIR_ENV } from '@ms/sensors/script';
import { CheckPool } from './runner/pool.js';
import { ProcessRunner } from './runner/process-runner.js';
import type { ResultMeta } from './runner/types.js';
import { LISTENER_ID, TrapListener } from './listeners/trap-listener.js';
import { LISTENER_ID as SYSLOG_LISTENER_ID, SyslogListener } from './listeners/syslog-listener.js';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AssignmentStore } from './scheduler/assignments.js';
import { ResultSpool } from './spool/spool.js';
import { SpoolDrain } from './spool/drain.js';
import { TimingWheel } from './scheduler/wheel.js';
import { CoreClient } from './transport/core-client.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
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
  const drain = new SpoolDrain({
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

  const pool = new CheckPool({
    logger,
    size: config.probe.workerPoolSize,
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

  wheel.start();
  lifecycle.onShutdown({
    name: 'scheduler',
    timeoutMs: 5_000,
    run: () => {
      wheel.stop();
      logger.info({ scheduler: wheel.stats(), pool: pool.stats() }, 'scheduler stopped');
    },
  });

  const coreClient = new CoreClient({
    config,
    logger,
    agentVersion: VERSION,
    onStateChange: (state) => {
      logger.info({ linkState: state }, 'link state changed');
      // The backlog is the first thing to move once the link is back.
      if (state === 'connected') drain.wake();
    },
    onConfig: (update) => {
      const size = assignments.apply(update);
      // A deleted sensor should stop costing a cursor. Cheap, and it runs only on a config push.
      trapListener?.retain(assignments.ids());
      return size;
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
