import { sshPool } from '@ms/sensors';
import real from '../../src/runner/catalogue-registry.js';
import type { CheckContext, CheckExecution, CheckRegistry } from '../../src/runner/types.js';

/**
 * The probe's own registry, with a count of how many checks this thread had in hand at once and
 * a check that reads this thread's SSH pool (`A-65`).
 *
 * The SSH sensors that run through it are the shipped ones, on the shipped pool: what is added
 * only watches.
 */
let inFlight = 0;
let peak = 0;

const registry: CheckRegistry = {
  async execute(sensorType: string, context: CheckContext): Promise<CheckExecution> {
    if (sensorType === 'test.ssh-pool') {
      const stats = sshPool.stats();
      return {
        channels: [
          { key: 'peak', value: peak },
          { key: 'acquired', value: stats.acquired },
          { key: 'opened', value: stats.opened },
          { key: 'joined', value: stats.joined },
          { key: 'reused', value: stats.reused },
        ],
        message: 'this worker’s SSH pool',
      };
    }
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      return await real.execute(sensorType, context);
    } finally {
      inFlight -= 1;
    }
  },
};

export default registry;
