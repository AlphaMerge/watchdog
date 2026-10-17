import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CheckContext, CheckExecution, CheckRegistry } from '../../src/runner/types.js';

/**
 * A registry whose load waits for the test, for a check process whose ready line must be written
 * before its runner's start-up bound fires and read after it (`P-408`).
 *
 * The child reads its request, then imports this, which writes `<MS_TEST_GATE_DIR>/loading` and
 * waits for the test to create `<dir>/go`. The test creates it and at once holds its own event
 * loop until the bound has passed, so the ready line the child then writes cannot be read in
 * time. Its check writes `<dir>/started` first, which is after the ready line and after the
 * child's `SIGTERM` handler, so the test knows the line was written and that the child will
 * answer the runner's stop. Then it waits for its signal, writes `<dir>/answered`, and answers as
 * `params.answer` says: `aborted` throws, as a check that honours its signal does, and `ok`
 * returns a reading anyway.
 */
const dir = process.env['MS_TEST_GATE_DIR'];
if (dir === undefined) throw new Error('MS_TEST_GATE_DIR is not set');

mark('loading');
while (!existsSync(join(dir, 'go'))) await sleep(5);

const registry: CheckRegistry = {
  async execute(_sensorType: string, context: CheckContext): Promise<CheckExecution> {
    mark('started');
    await new Promise<void>((resolve) => {
      // A handle, so the process waits for its stop. Without one its loop is empty here, since
      // the check process's own timer is unref'd, and it exits with nothing said.
      const hold = setInterval(() => undefined, 1_000);
      const stop = (): void => {
        clearInterval(hold);
        resolve();
      };
      if (context.signal.aborted) stop();
      else context.signal.addEventListener('abort', stop, { once: true });
    });
    // Said before the answer, so the test knows the runner had an answer to read.
    mark('answered');
    if (context.params['answer'] === 'ok') {
      return { channels: [{ key: 'value', value: 1 }], message: 'answered after its stop' };
    }
    throw context.signal.reason instanceof Error ? context.signal.reason : new Error('aborted');
  },
};

/** Written to a temporary name and renamed, so the test never sees half a file. */
function mark(name: string): void {
  if (dir === undefined) return;
  writeFileSync(join(dir, `${name}.partial`), String(process.pid), 'utf8');
  renameSync(join(dir, `${name}.partial`), join(dir, name));
}

export default registry;
