import { BroadcastChannel } from 'node:worker_threads';

/**
 * A format worker that does not finish starting until the test says so (`P-211`).
 *
 * A pool cannot see into a worker's start-up — it is loading until it says `ready` — so testing
 * what the pool does meanwhile needs a worker held there for as long as the test likes, rather than
 * for as long as the machine's load happens to make it. This one says `waiting` on the
 * `format-worker-gate` channel and, when it hears `open`, becomes `misbehaving-format-worker.ts`,
 * which loads the real job code and says `ready`. Until then it holds no listener on its port, so a
 * job handed to it waits there exactly as it would for a worker still loading `pdfkit`.
 */
const gate = new BroadcastChannel('format-worker-gate');
let opened = false;
gate.onmessage = (event) => {
  if (opened || event.data !== 'open') return;
  opened = true;
  // Closed only once the real worker is loaded: until its port has a listener, the channel is what
  // keeps this thread alive.
  void import('./misbehaving-format-worker.js').finally(() => {
    gate.close();
  });
};
gate.postMessage('waiting');
