#!/usr/bin/env node
import { bootstrap, describeError, probeConfigSchema, type ProbeConfig } from '@ms/shared';
import { CheckPool } from './runner/pool.js';
import { mkdir } from 'node:fs/promises';
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
      sendResults: (results) => coreClient.sendResults(results),
    },
    logger,
    batchMaxRows: config.probe.spoolBatchMaxRows,
  });

  const pool = new CheckPool({
    logger,
    size: config.probe.workerPoolSize,
    queueMaxLength: config.probe.checkQueueMaxLength,
    abortGraceMs: config.probe.checkAbortGraceMs,
    onResult: (result, meta) => {
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
    },
  });
  await pool.start();
  lifecycle.onShutdown({ name: 'check-pool', timeoutMs: 10_000, run: () => pool.stop() });

  // The scheduler hands due sensors to the pool and returns. `onDue` runs on the wheel's own
  // thread, so it must never wait for a check — `submit` is fire-and-forget by design.
  const wheel = new TimingWheel({
    logger,
    onDue: (due) => {
      for (const sensorId of due) {
        const assignment = assignments.get(sensorId);
        if (assignment === undefined) continue;
        pool.submit({
          sensorId,
          sensorType: assignment.sensorType,
          target: assignment.target,
          params: assignment.params,
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
    onConfig: (update) => assignments.apply(update),
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

  // Phase 2 continues here: the child-process runner (P-03), the listeners and the disk spool
  // (R-02) register themselves, each adding its own shutdown hook.
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
