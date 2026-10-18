import { join } from 'node:path';
import { pino } from 'pino';
import { LookupHelper } from '../../src/resolver/lookup-helper.js';

/**
 * A probe in miniature for the lookup helper's process tests (`P-432`): starts a helper on the
 * scripted child and says on stdout how it went.
 *
 * - `start-and-return` (U15): starts it, says `up` or `not up`, and returns, leaving the helper
 *   running. Every handle the helper holds is unref'd, so the process must exit by itself.
 * - `hold <fifo>…` (U13): starts it, asks `fifo:<path>` for each FIFO, so each holds one of the
 *   child's libuv threads in `open()`, says the child's pid, and stays up until killed.
 */

const [mode, ...fifos] = process.argv.slice(2);
const helper = new LookupHelper({
  logger: pino({ level: 'silent' }),
  childModule: join(import.meta.dirname, 'scripted-helper-child.js'),
  limits: { startWaitMs: 60_000, startMs: 60_000 },
});
const up = await helper.start();
if (mode === 'hold') {
  for (const fifo of fifos) {
    helper.ask({ host: `fifo:${fifo}`, family: 4, max: 64 }).catch(() => {
      // Lost with the child, as the test means it to be.
    });
  }
  process.stdout.write(`${String(helper.pid())}\n`);
  setInterval(() => {}, 60_000);
} else {
  process.stdout.write(up ? 'up\n' : 'not up\n');
}
