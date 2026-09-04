import { existsSync } from 'node:fs';
import registry from './check-fixtures.js';

/**
 * The fixture registry, but importable only while a sentinel file is absent (`P-80`).
 *
 * The pool imports its registry by path in each new worker, so this is the only way to make
 * *some* worker starts fail while the workers already running stay healthy — the state the pool's
 * latch could not previously tell apart from "nothing can start at all". A test creates the file
 * named by `MS_TEST_BREAK_REGISTRY`, and every worker spawned from then on dies during bootstrap
 * while the ones already up keep taking checks.
 *
 * Read at module top level on purpose: that is where a registry that cannot be loaded fails in
 * production too, which is the failure `P-62`'s latch was built for.
 */
const sentinel = process.env['MS_TEST_BREAK_REGISTRY'];
if (sentinel !== undefined && sentinel !== '' && existsSync(sentinel)) {
  throw new Error('registry unavailable');
}

export default registry;
