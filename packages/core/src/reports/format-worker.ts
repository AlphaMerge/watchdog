import { parentPort, workerData } from 'node:worker_threads';
import { configureWorker, formatJob } from './format-job.js';
import type { FormatReady, FormatRequest } from './formatter.js';

/**
 * A report formatting worker (`P-204`).
 *
 * **One job at a time** — `ReportFormatter` guarantees it — and nothing here decides anything: it
 * takes a document the core already built and hands back the bytes `renderOutputs` would have
 * produced on the main thread. That is the whole point. `P-203` measured every format holding the
 * core's event loop for its entire duration, up to a second and a half, and two reports at once
 * making a concurrent request wait 2.6 s; the work is the same here, it just waits on nobody.
 *
 * Imports only the rendering half of the reports module, so a worker does not load a database
 * client, a mail transport or an HTTP server it will never use.
 */

/* c8 ignore next 2 -- a worker without a parent port cannot have been started by the pool */
if (parentPort === null) throw new Error('report format worker started outside a worker thread');
const port = parentPort;
configureWorker(workerData);

port.on('message', (request: FormatRequest) => {
  void formatJob(request).then(({ reply, transfer }) => {
    port.postMessage(reply, transfer);
  });
});
// Last, and only once: every import above has loaded, so the job's clock can start (`P-211`).
port.postMessage({ type: 'ready' } satisfies FormatReady);
