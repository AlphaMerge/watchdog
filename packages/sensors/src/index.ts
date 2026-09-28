export type {
  ChannelDef,
  ChannelLimitDefaults,
  CheckContext,
  CheckExecution,
  CheckTarget,
  CostHint,
  JsonSchema,
  PreviewExpectation,
  PreviewInput,
  PreviewResult,
  PreviewRow,
  PreviewSelection,
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

// The session pools, exported so the probe can report what they are doing (`P-36`). The pools
// themselves stay where the transports are; what crosses this boundary is their counters, and
// only because nothing else in the system could see a bound being passed.
export { snmpPool } from './support/snmp/pool.js';
export type { SnmpPoolStats } from './support/snmp/pool.js';
export { sshPool } from './support/ssh/pool.js';
export type { SshPoolStats } from './support/ssh/pool.js';

// The same split for syslog (`T-20`): the parser and the renderer are pure functions over plain
// data, and the sockets live behind the `@ms/sensors/syslog` subpath.
export {
  FACILITIES,
  SEVERITIES,
  facilityName,
  parseSyslog,
  renderSyslog,
  severityName,
  type Severity,
  type SyslogMessage,
} from './support/syslog/parse.js';

export {
  SENSOR_TYPE_ID,
  SensorCatalogue,
  SensorTypeError,
  type ParamProblem,
  type ParamValidation,
  type SensorTypeSummary,
} from './catalogue.js';

import type { BuildProfile } from '@ms/shared';
import { SensorCatalogue } from './catalogue.js';
import type { SensorType } from './contract.js';
import { icmpPing } from './types/icmp-ping.js';
import { dnsBlocklist } from './types/dns-blocklist.js';
import { dnsRecord } from './types/dns-record.js';
import { icmpJitter } from './types/icmp-jitter.js';
import { portRange } from './types/port-range.js';
import { httpAdvanced } from './types/http-advanced.js';
import { httpTransaction } from './types/http-transaction.js';
import { restCustom } from './types/rest-custom.js';
import { mailImap } from './types/mail-imap.js';
import { mailPop3 } from './types/mail-pop3.js';
import { mailRoundTrip } from './types/mail-roundtrip.js';
import { mailSmtp } from './types/mail-smtp.js';
import { dbMssql } from './types/db-mssql.js';
import { dbMysql } from './types/db-mysql.js';
import { dbPostgresql } from './types/db-postgresql.js';
import { exeScript } from './types/exe-script.js';
import { exeScriptAdvanced } from './types/exe-script-advanced.js';
import { flowCollector } from './types/flow.js';
import { syslogReceiver } from './types/syslog.js';
import { coreFactory } from './types/core-factory.js';
import { coreHealth } from './types/core-health.js';
import { probeHealth } from './types/probe-health.js';
import { httpContent } from './types/http-content.js';
import { httpRequest } from './types/http.js';
import { portTcp } from './types/port-tcp.js';
import { tlsCertificate } from './types/tls-certificate.js';
import { tlsSecurity } from './types/tls-security.js';
import { snmpTraffic } from './types/snmp-traffic.js';
import { snmpCustom } from './types/snmp-custom.js';
import { snmpCustomString } from './types/snmp-custom-string.js';
import { snmpTable } from './types/snmp-table.js';
import { snmpCpu } from './types/snmp-cpu.js';
import { snmpDiskFree } from './types/snmp-disk-free.js';
import { snmpMemory } from './types/snmp-memory.js';
import { snmpUptime } from './types/snmp-uptime.js';
import { snmpTrap } from './types/snmp-trap.js';
import { sshDiskFree } from './types/ssh-disk-free.js';
import { sshLoad } from './types/ssh-load.js';
import { sshMeminfo } from './types/ssh-meminfo.js';
import { sshScript } from './types/ssh-script.js';
import { windowsCpu } from './types/windows-cpu.js';
import { windowsMemory } from './types/windows-memory.js';
import { windowsService } from './types/windows-service.js';
import { windowsVolume } from './types/windows-volume.js';

/**
 * The types every installation gets.
 *
 * `T-13`…`T-16` extend `http`; `T-10` adds the Windows set on `T-09`'s transport; `T-20` adds
 * the syslog receiver on the listener contract `snmp.trap` established.
 *
 * A type is added by writing one file under `src/types/` and listing it here. See
 * `docs/adding-a-sensor-type.md`.
 */
export { coreHealth, CORE_HEALTH_CHANNELS, CORE_HEALTH_COUNTERS } from './types/core-health.js';
export { probeHealth, PROBE_HEALTH_CHANNELS, PROBE_HEALTH_COUNTERS } from './types/probe-health.js';

export const BUILT_IN_SENSOR_TYPES: readonly SensorType[] = [
  icmpPing,
  dnsBlocklist,
  dnsRecord,
  icmpJitter,
  portRange,
  httpAdvanced,
  httpTransaction,
  restCustom,
  mailSmtp,
  mailPop3,
  mailImap,
  mailRoundTrip,
  dbPostgresql,
  dbMysql,
  dbMssql,
  exeScript,
  exeScriptAdvanced,
  syslogReceiver,
  flowCollector,
  coreFactory,
  coreHealth,
  probeHealth,
  httpContent,
  httpRequest,
  portTcp,
  tlsCertificate,
  tlsSecurity,
  snmpTraffic,
  snmpCustom,
  snmpCustomString,
  snmpTable,
  snmpCpu,
  snmpDiskFree,
  snmpMemory,
  snmpUptime,
  snmpTrap,
  sshDiskFree,
  sshLoad,
  sshMeminfo,
  sshScript,
  windowsCpu,
  windowsMemory,
  windowsService,
  windowsVolume,
];

const WINDOWS_IS_1_1 =
  'it runs PowerShell on a Windows probe, and 1.0 is Linux-only — Windows is release 1.1';

/**
 * The built-in types the v1 build profile leaves out (`H-12`), each with the reason an operator
 * reads when a probe is asked for one anyway.
 *
 * Keyed by the types' own ids rather than by strings typed here, so a renamed type cannot quietly
 * stop being withheld. **Withheld, not removed**: every one of them stays in the tree and in the
 * full profile.
 */
export const WITHHELD_FROM_V1: ReadonlyMap<string, string> = new Map([
  // Never constructed by a shipped probe even in the full profile (`B-07`), so in v1 a flow
  // sensor could only fail for ever.
  [flowCollector.id, 'flow monitoring is v2 (`V2-01`)'],
  [windowsCpu.id, WINDOWS_IS_1_1],
  [windowsMemory.id, WINDOWS_IS_1_1],
  [windowsService.id, WINDOWS_IS_1_1],
  [windowsVolume.id, WINDOWS_IS_1_1],
]);

/** The built-in types a build of `profile` carries, in catalogue order. */
export function sensorTypesFor(profile: BuildProfile): readonly SensorType[] {
  if (profile === 'full') return BUILT_IN_SENSOR_TYPES;
  return BUILT_IN_SENSOR_TYPES.filter((type) => !WITHHELD_FROM_V1.has(type.id));
}

/**
 * Why a build of `profile` does not carry `id`, or undefined when it does or never heard of it.
 *
 * For the message, not the decision: the catalogue decides by not containing the type.
 */
export function withheldReason(profile: BuildProfile, id: string): string | undefined {
  return profile === 'v1' ? WITHHELD_FROM_V1.get(id) : undefined;
}

export function standardCatalogue(
  types: readonly SensorType[] = BUILT_IN_SENSOR_TYPES,
): SensorCatalogue {
  const catalogue = new SensorCatalogue();
  for (const type of types) catalogue.register(type);
  return catalogue.seal();
}
