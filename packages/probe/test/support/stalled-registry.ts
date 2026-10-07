// First, so the pid is on disk before anything else this module loads (see `pid-first.ts`).
import './pid-first.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BroadcastChannel } from 'node:worker_threads';
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
 *
 * And for a pool's workers (`P-263`), which share the probe's environment, so a test needs some of
 * them to hang and not others:
 *
 * - `MS_TEST_REGISTRY_HANG_DIR` and `MS_TEST_REGISTRY_SCRIPT`: what each load does, in the order
 *   the loads begin, as a comma-separated list of `hang` (for ever), `throw` (the import fails) and
 *   `load` (as usual). Loads past the end of the list load as usual. A load claims its place by
 *   creating `<dir>/<n>`, which only one thread can do, so each entry is taken exactly once however
 *   the starts interleave.
 * - `MS_TEST_REGISTRY_CHANNEL`: a `BroadcastChannel` a hanging load posts `{ ticket, at }` on when
 *   it starts to hang and every 100 ms after, so a test can see when one began and that it ended.
 */
const hangDir = process.env['MS_TEST_REGISTRY_HANG_DIR'];
if (hangDir !== undefined) {
  const script = (process.env['MS_TEST_REGISTRY_SCRIPT'] ?? '').split(',').filter(Boolean);
  const ticket = claim(hangDir, script.length);
  const action = ticket === undefined ? 'load' : script[ticket];
  if (action === 'throw') throw new Error('this registry fails to load on purpose');
  if (action === 'hang' && ticket !== undefined) {
    const name = process.env['MS_TEST_REGISTRY_CHANNEL'];
    const channel = name === undefined ? undefined : new BroadcastChannel(name);
    const beat = (): void => {
      channel?.postMessage({ ticket, at: Date.now() });
    };
    beat();
    await new Promise<never>(() => {
      // A handle, so the thread waits rather than ending, and a heartbeat its terminate stops.
      setInterval(beat, 100);
    });
  }
}

/** The first free ticket below `count`, claimed, or undefined when every one is taken. */
function claim(dir: string, count: number): number | undefined {
  for (let ticket = 0; ticket < count; ticket += 1) {
    try {
      mkdirSync(join(dir, String(ticket)));
      return ticket;
    } catch {
      // Taken by another load; try the next.
    }
  }
  return undefined;
}

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
