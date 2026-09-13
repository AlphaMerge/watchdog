// `worker-startup-memory.mjs`'s `gc` variant: a check worker that collects once its registry has
// loaded. Measured for `P-206` and not shipped -- it shortens the start-up plateau but not the peak,
// and it needs a V8 flag set after the VM has started.
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');
await import(new URL('../../packages/probe/dist/src/runner/check-worker.js', import.meta.url).href);
gc();
