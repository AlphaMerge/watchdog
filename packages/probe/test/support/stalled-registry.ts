// First, so the pid is on disk before anything else this module loads (see `pid-first.ts`).
import './pid-first.js';
import registry from './check-fixtures.js';

/**
 * The fixture registry, slow or broken to import on purpose, for a check process (`P-260`).
 *
 * A probe's check process imports the catalogue before it can run its check, and `P-258`
 * measured that import at 0.45–14.8 s on a loaded machine. This stands in for that import, told
 * how to behave through the environment the runner hands its child (`childEnv`), since the
 * request on stdin is read by the child and not by the registry:
 *
 * - `MS_TEST_REGISTRY_PID_FILE`: written with this process's id first (`pid-first.ts`), so a
 *   test can see that a child it gave up on is gone.
 * - `MS_TEST_REGISTRY_DELAY_MS`: how long the import takes. `forever` holds the event loop open
 *   and never finishes, which is the load a start-up bound exists for.
 * - `MS_TEST_REGISTRY_THROW`: the import fails with this message.
 * - `MS_TEST_REGISTRY_EXIT`: the process exits with this code while loading.
 * - `MS_TEST_REGISTRY_SIGNAL`: the process sends itself this signal while loading, which is how a
 *   native module crashing during the load looks from outside.
 */
const delay = process.env['MS_TEST_REGISTRY_DELAY_MS'] ?? '0';
if (delay === 'forever') {
  await new Promise<never>(() => {
    // A handle, so the process waits rather than exiting on an empty event loop.
    setInterval(() => undefined, 1_000);
  });
}
await new Promise((resolve) => setTimeout(resolve, Number(delay)));

const exitCode = process.env['MS_TEST_REGISTRY_EXIT'];
if (exitCode !== undefined) process.exit(Number(exitCode));

const signal = process.env['MS_TEST_REGISTRY_SIGNAL'];
if (signal !== undefined) {
  process.kill(process.pid, signal);
  // The signal is delivered asynchronously; nothing below should run meanwhile.
  await new Promise<never>(() => {
    setInterval(() => undefined, 1_000);
  });
}

const failure = process.env['MS_TEST_REGISTRY_THROW'];
if (failure !== undefined) throw new Error(failure);

export default registry;
