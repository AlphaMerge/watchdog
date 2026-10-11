import { SnmpSessionPool, withSnmp } from '@ms/sensors/snmp';
import type { CheckRegistry, SessionCounters } from '../../src/runner/types.js';

/**
 * A registry whose one check reads an SNMP agent through a real session pool (`P-256`).
 *
 * The shipped pool is a module singleton with a 60-second idle window, which no test can wait
 * out. This one is the same class with a window of `IDLE_MS`, so a worker's sessions close on
 * the pool's own timer while the test watches what the probe reports about them.
 */
export const IDLE_MS = 200;

const pool = new SnmpSessionPool({ idleMs: IDLE_MS });

const SYS_DESCR = '1.3.6.1.2.1.1.1.0';

const registry: CheckRegistry = {
  async execute(sensorType, context) {
    if (sensorType !== 'test.snmp-get') throw new Error(`no fixture for ${sensorType}`);
    const port = Number(context.params['port']);
    const timeoutMs = Number(context.params['requestTimeoutMs'] ?? 1_000);
    await withSnmp(
      { host: context.target.host, port },
      { version: 'v2c', community: 'public' },
      { timeoutMs, retries: 0 },
      (session) => session.get([SYS_DESCR], context.signal),
      pool,
    );
    return { channels: [{ key: 'value', value: 1 }], message: 'answered' };
  },
  sessionCounters(): SessionCounters {
    const stats = pool.stats();
    return {
      open: stats.sessions,
      overflowed: stats.overflowed,
      evicted: stats.evicted,
      opened: stats.opened,
    };
  },
};

export default registry;
