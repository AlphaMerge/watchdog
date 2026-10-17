import { nameLookups, snmpPool, sshPool } from '@ms/sensors';
import { missingTypeError, probeCatalogue } from '../catalogue.js';
import type {
  CheckContext,
  CheckExecution,
  CheckRegistry,
  LookupCounters,
  SessionCounters,
} from './types.js';

/**
 * The registry a probe runs (P-05), loaded by path into each pool worker.
 *
 * Built once per worker at import time and sealed, so a check can never be running against a
 * catalogue that is still being assembled. An unregistered type raises `UNKNOWN_SENSOR_TYPE`,
 * which the pool reports as its own phase rather than as one more failing check — the
 * distinction matters, because a missing type fails identically for ever and no amount of
 * retrying will change it.
 *
 * The catalogue is this build's profile of the built-in set (`H-12`), so a v1 probe carries no
 * flow and no Windows types, and says so by name when it is asked for one.
 */
const catalogue = probeCatalogue();

const registry: CheckRegistry = {
  execute(sensorType: string, context: CheckContext): Promise<CheckExecution> {
    // An `UNKNOWN_SENSOR_TYPE` naming the id, which is the message an operator needs: which
    // sensor type, and — when this build's profile left it out — why.
    if (!catalogue.has(sensorType)) return Promise.reject(missingTypeError(sensorType));
    // Through the catalogue, not the type: it is what scrubs the message of every secret the
    // check held before the result leaves this worker (`S-19`).
    return catalogue.execute(sensorType, context);
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

  /**
   * This worker's name lookups (`A-66`): those its checks are waiting for, those they gave up on
   * and the resolver has not answered yet, and how many were given up. The pool sums them.
   */
  lookupCounters(): LookupCounters {
    return nameLookups.stats();
  },
};

export default registry;
