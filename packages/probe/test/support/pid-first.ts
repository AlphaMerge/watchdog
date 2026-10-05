import { renameSync, writeFileSync } from 'node:fs';

/**
 * Writes this process's id to `MS_TEST_REGISTRY_PID_FILE`, before anything else the stalled
 * registry loads (`P-260`).
 *
 * A module of its own, imported first, because static imports are evaluated in order before the
 * importing module's body: written in `stalled-registry.ts` itself it came after the check
 * fixtures had loaded, which is boot time a loaded machine can stretch past a test's start-up
 * bound. Written to a temporary name and renamed, so a reader never sees half of it.
 */
const pidFile = process.env['MS_TEST_REGISTRY_PID_FILE'];
if (pidFile !== undefined) {
  writeFileSync(`${pidFile}.partial`, String(process.pid), 'utf8');
  renameSync(`${pidFile}.partial`, pidFile);
}
