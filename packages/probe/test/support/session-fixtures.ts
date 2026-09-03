import type { CheckRegistry, SessionCounters } from '../../src/runner/types.js';
import base from './check-fixtures.js';

/**
 * The fixture registry, plus session-pool counters (`P-36`).
 *
 * **Separate from `check-fixtures.ts` on purpose.** Most of the pool's tests need a registry
 * that keeps *no* pools, because "absent means absent" is the behaviour they cover — a build
 * with no session pools must gap the channels rather than publish zeros. Adding the counters to
 * the shared fixture would have quietly removed that case from every one of them.
 *
 * The numbers climb per check so a test can tell one worker's report from another's, and so a
 * sum across workers is distinguishable from any single worker's contribution.
 */
let checks = 0;

const registry: CheckRegistry = {
  execute(sensorType, context) {
    checks += 1;
    return base.execute(sensorType, context);
  },
  sessionCounters(): SessionCounters {
    return { open: 2, overflowed: checks, evicted: checks * 2, opened: checks * 3 };
  },
};

export default registry;
