export type {
  ChannelDef,
  CheckContext,
  CheckExecution,
  CheckTarget,
  CostHint,
  JsonSchema,
  ReceivedBatch,
  ReceivedNotification,
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

// The trap domain module, and only it: pure functions over plain data with no protocol import,
// so the core and the probe can both read it without pulling in a UDP stack. The *receiver*
// lives behind the `@ms/sensors/snmp` subpath, which does import `net-snmp` (`T-06`).
export {
  genericNameOf,
  GENERIC_TRAPS,
  readRule,
  renderTrap,
  ruleMatches,
  SNMP_TRAP_OID,
  SYS_UPTIME_0,
  trapOidFromV1,
  trapOidFromVarbinds,
  type TrapDetail,
  type TrapKind,
  type TrapRule,
  type TrapVarbind,
  type TrapVersion,
} from './support/snmp/trap.js';

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
import { snmpTrap } from './types/snmp-trap.js';

/**
 * The types every installation gets.
 *
 * `P-09` (HTTP), `P-10` (Port) and `P-11` (DNS) are the next three, and `T-20` adds the
 * syslog receiver on the same listener contract `snmp.trap` established.
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
  snmpTrap,
];

export function standardCatalogue(
  types: readonly SensorType[] = BUILT_IN_SENSOR_TYPES,
): SensorCatalogue {
  const catalogue = new SensorCatalogue();
  for (const type of types) catalogue.register(type);
  return catalogue.seal();
}
