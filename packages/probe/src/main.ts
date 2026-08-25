#!/usr/bin/env node
import { bootstrap, describeError, probeConfigSchema, type ProbeConfig } from '@ms/shared';
import { CheckPool } from './runner/pool.js';
import { AssignmentStore } from './scheduler/assignments.js';
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

  const pool = new CheckPool({
    logger,
    size: config.probe.workerPoolSize,
    queueMaxLength: config.probe.checkQueueMaxLength,
    abortGraceMs: config.probe.checkAbortGraceMs,
    onResult: (result, meta) => {
      // R-02 and R-03 replace this with the disk spool and the ordered stream to the core.
      // Logging until then is honest: the results exist, and nothing yet carries them.
      logger.debug(
        { sensorId: result.sensorId, outcome: result.outcome, phase: meta.phase },
        'check finished',
      );
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
    },
    onConfig: (update) => assignments.apply(update),
  });
  coreClient.start();
  lifecycle.onShutdown({
    name: 'core-client',
    timeoutMs: 5_000,
    run: () => coreClient.stop(),
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
