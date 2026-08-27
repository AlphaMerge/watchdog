export type {
  ChannelDef,
  CheckContext,
  CheckExecution,
  CheckTarget,
  CostHint,
  JsonSchema,
  SensorType,
  SensorTypeDeclaration,
} from './contract.js';

export {
  assertSplittable,
  credentialKind,
  credentialKindIds,
  CREDENTIAL_KINDS,
  secretFields,
  splitCredential,
  type CredentialKindDefinition,
} from './credentials/index.js';

export {
  SensorCatalogue,
  SensorTypeError,
  type ParamProblem,
  type ParamValidation,
  type SensorTypeSummary,
} from './catalogue.js';

import { SensorCatalogue } from './catalogue.js';
import type { SensorType } from './contract.js';
import { icmpPing } from './types/icmp-ping.js';
import { snmpTraffic } from './types/snmp-traffic.js';
import { snmpCustom } from './types/snmp-custom.js';
import { snmpCustomString } from './types/snmp-custom-string.js';
import { snmpTable } from './types/snmp-table.js';
import { snmpCpu } from './types/snmp-cpu.js';
import { snmpDiskFree } from './types/snmp-disk-free.js';
import { snmpMemory } from './types/snmp-memory.js';
import { snmpUptime } from './types/snmp-uptime.js';

/**
 * The types every installation gets.
 *
 * `P-09` (HTTP), `P-10` (Port) and `P-11` (DNS) are the next three; `T-06` (traps) is the
 * rest of the SNMP set.
 *
 * A type is added by writing one file under `src/types/` and listing it here. See
 * `docs/adding-a-sensor-type.md`.
 */
export const BUILT_IN_SENSOR_TYPES: readonly SensorType[] = [
  icmpPing,
  snmpTraffic,
  snmpCustom,
  snmpCustomString,
  snmpTable,
  snmpCpu,
  snmpDiskFree,
  snmpMemory,
  snmpUptime,
];

export function standardCatalogue(
  types: readonly SensorType[] = BUILT_IN_SENSOR_TYPES,
): SensorCatalogue {
  const catalogue = new SensorCatalogue();
  for (const type of types) catalogue.register(type);
  return catalogue.seal();
}
