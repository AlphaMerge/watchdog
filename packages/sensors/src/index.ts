export type {
  ChannelDef,
  CheckContext,
  CheckExecution,
  CostHint,
  JsonSchema,
  SensorType,
  SensorTypeDeclaration,
} from './contract.js';

export {
  SensorCatalogue,
  SensorTypeError,
  type ParamProblem,
  type ParamValidation,
  type SensorTypeSummary,
} from './catalogue.js';

import { SensorCatalogue } from './catalogue.js';
import type { SensorType } from './contract.js';

/**
 * The types every installation gets.
 *
 * Empty on purpose: `P-05` is the contract and the registry, and the first four types are
 * `P-08` (Ping), `P-09` (HTTP), `P-10` (Port) and `P-11` (DNS). Until one of them lands, a
 * catalogue built here registers nothing and the core refuses to create sensors — which is the
 * truth, and better than accepting configuration for a check that cannot run.
 *
 * A type is added by writing one file under `src/types/` and listing it here. See
 * `docs/adding-a-sensor-type.md`.
 */
export const BUILT_IN_SENSOR_TYPES: readonly SensorType[] = [];

export function standardCatalogue(
  types: readonly SensorType[] = BUILT_IN_SENSOR_TYPES,
): SensorCatalogue {
  const catalogue = new SensorCatalogue();
  for (const type of types) catalogue.register(type);
  return catalogue.seal();
}
