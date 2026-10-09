import { standardCatalogue, type SensorType } from '@ms/sensors';
import type { CheckContext, CheckExecution, CheckRegistry } from '../../src/runner/types.js';

/**
 * A registry whose one check says which target policy it was handed (`A-65`).
 *
 * **Through a real catalogue**, built the way `catalogue-registry.ts` builds the probe's, because
 * that is what reads `MS_TARGET_POLICY` and puts the policy on every check's target. A fixture
 * that read the variable itself would show the variable arrived and not that a check is held to
 * it.
 */
const echo: SensorType = {
  id: 'test.policy',
  category: 'Test',
  costHint: 'light',
  declaresEveryChannel: true,
  paramsSchema: { type: 'object', additionalProperties: true, properties: {} },
  channels() {
    return [{ key: 'value', name: 'Value', unit: '#', isPrimary: true }];
  },
  execute(context: CheckContext): Promise<CheckExecution> {
    return Promise.resolve({
      channels: [{ key: 'value', value: 1 }],
      message: `policy=${String(context.target.policy)}`,
    });
  },
};

const catalogue = standardCatalogue([echo]);

const registry: CheckRegistry = {
  execute(sensorType: string, context: CheckContext): Promise<CheckExecution> {
    return catalogue.execute(sensorType, context);
  },
};

export default registry;
