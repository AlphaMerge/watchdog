/**
 * A service's first thirty lines, run as a child so a test can stall its output and end it
 * (`P-216` part 3). The mode is the first argument; markers go to the descriptor the test is
 * reading, never the stalled one.
 */
import { writeSync } from 'node:fs';
import { probeConfigSchema } from '../../src/config/schema.js';
import { bootstrap } from '../../src/lifecycle/bootstrap.js';
import type { LogOutput } from '../../src/logging/output.js';

const mode = process.argv[2];

/** Writes to a non-blocking descriptor until it will take no more; how much it took. */
function fill(fd: number): number {
  const chunk = Buffer.from(`${'x'.repeat(1023)}\n`);
  let took = 0;
  for (;;) {
    try {
      took += writeSync(fd, chunk);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') return took;
      throw error;
    }
  }
}

/**
 * Full, and staying full. **A pipe that refuses once is not stalled**: the test's end is a Node
 * stream, which keeps reading into its own buffer while nobody consumes it, so the pipe empties
 * again a moment later. Full is when a pause has passed and it still takes nothing.
 */
function stall(fd: number): void {
  const nap = new Int32Array(new SharedArrayBuffer(4));
  fill(fd);
  for (;;) {
    Atomics.wait(nap, 0, 0, 100);
    if (fill(fd) === 0) return;
  }
}

function marker(fd: number, line: string): void {
  writeSync(fd, `${line}\n`);
}

if (mode === 'config') {
  // The refusal writes to standard error before any logger exists. Stall that first.
  void process.stderr;
  stall(2);
  marker(1, 'stalled');
  bootstrap({ schema: probeConfigSchema, version: '0.0.0-test', argv: [], env: process.env });
  marker(1, 'unreachable: bootstrap returned');
  process.exit(3);
}

const { logger, lifecycle, logOutput } = bootstrap({
  schema: probeConfigSchema,
  version: '0.0.0-test',
  argv: [],
  env: {},
});
const output = logOutput as LogOutput;

if (mode === 'flood') {
  // The journal never reads. How long any one line takes is the claim: it must not wait.
  let slowestMs = 0;
  let lines = 0;
  while (output.stats().droppedLines < 1_000 && lines < 2_000_000) {
    const started = performance.now();
    logger.info({ line: lines, padding: 'y'.repeat(100) }, 'filler');
    slowestMs = Math.max(slowestMs, performance.now() - started);
    lines += 1;
  }
  marker(2, JSON.stringify({ lines, slowestMs, ...output.stats() }));
  // Nothing more to say, and an exit would flush: the test ends it.
  await new Promise<never>(() => {
    setInterval(() => undefined, 1 << 30);
  });
}

// SIGTERM and an uncaught exception: stall standard output with log lines, then end. Stalled
// is a backlog that a pause, with the output's retries in it, has not moved (see `stall`).
let line = 0;
for (;;) {
  while (output.stats().backlogBytes === 0 && line < 2_000_000) {
    logger.info({ line }, 'filler');
    line += 1;
  }
  const held = output.stats().backlogBytes;
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (output.stats().backlogBytes === held) break;
}
marker(2, `stalled ${String(line)}`);
if (mode === 'uncaught') {
  setTimeout(() => {
    throw new Error('the check that nobody caught');
  }, 50);
}
await lifecycle.waitForShutdown();
