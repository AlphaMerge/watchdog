import { standardCatalogue } from '@ms/sensors';
import type { CheckContext, CheckExecution, CheckRegistry } from './types.js';

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
};

export default registry;
