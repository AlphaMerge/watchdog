import { snmpPool, sshPool, standardCatalogue } from '@ms/sensors';
import type { CheckContext, CheckExecution, CheckRegistry, SessionCounters } from './types.js';

/**
 * The registry a probe runs (P-05), loaded by path into each pool worker.
 *
 * Built once per worker at import time and sealed, so a check can never be running against a
 * catalogue that is still being assembled. An unregistered type raises `UNKNOWN_SENSOR_TYPE`,
 * which the pool reports as its own phase rather than as one more failing check — the
 * distinction matters, because a missing type fails identically for ever and no amount of
 * retrying will change it.
 */
const catalogue = standardCatalogue();

const registry: CheckRegistry = {
  execute(sensorType: string, context: CheckContext): Promise<CheckExecution> {
    // `type()` throws SensorTypeError('UNKNOWN_SENSOR_TYPE') naming the id, which is the
    // message an operator needs: which sensor type, not "cannot read property of undefined".
    return catalogue.type(sensorType).execute(context);
  },

  /**
   * The session pools this worker owns, summed (`P-36`).
   *
   * **Summed rather than reported per protocol**, because the question an operator has is about
   * this probe's file descriptors and session churn, and that is one budget however it is spent.
   * A per-protocol split would be two more channels answering a question nobody asked first —
   * and the sensor that overflowed is already named in the log.
   *
   * Both pools are module singletons *inside this worker thread*, so these are one worker's
   * numbers. The pool in the main thread sums them across workers.
   */
  sessionCounters(): SessionCounters {
    const snmp = snmpPool.stats();
    const ssh = sshPool.stats();
    return {
      open: snmp.sessions + ssh.connections,
      overflowed: snmp.overflowed + ssh.overflowed,
      evicted: snmp.evicted + ssh.evicted,
      opened: snmp.opened + ssh.opened,
    };
  },
};

export default registry;
