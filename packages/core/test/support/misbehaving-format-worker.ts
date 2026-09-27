import { parentPort, workerData } from 'node:worker_threads';
import { configureWorker, formatJob } from '../../src/reports/format-job.js';
import type { FormatReady, FormatRequest } from '../../src/reports/formatter.js';

/**
 * A format worker that does what it is told by the report's name (`P-204`).
 *
 * `crash` exits mid-job, `hang` never answers, and anything else is formatted by the real job
 * code — so the pool's handling of a dead or stuck worker is tested against a real worker thread,
 * without that behaviour living anywhere in shipped code.
 */
if (parentPort === null) throw new Error('started outside a worker thread');
const port = parentPort;
configureWorker(workerData);

port.on('message', (request: FormatRequest) => {
  if (request.name === 'crash') process.exit(3);
  if (request.name === 'hang') return;
  void formatJob(request).then(({ reply, transfer }) => {
    port.postMessage(reply, transfer);
  });
});
port.postMessage({ type: 'ready' } satisfies FormatReady);
