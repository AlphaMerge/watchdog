/**
 * The SNMP session layer (`T-01`) — everything `T-02`…`T-06` build on.
 *
 * A sensor type imports from here and never from `net-snmp`, which is confined to `session.ts`
 * and the declaration beside it. That boundary is ADR-001 Decision 6's "single maintainer" risk
 * made cheap: the dependency is one import and one `.d.ts`, so it can be vendored or replaced
 * without touching a sensor type.
 *
 * Import it from inside `execute`, never at the top of a sensor-type module — the core loads the
 * catalogue for schemas and channel declarations and must not pay for a UDP stack it never uses
 * (`docs/adding-a-sensor-type.md`).
 */
export {
  credentialFingerprint,
  describeCredentials,
  readCredentials,
  SnmpCredentialError,
  type SnmpAuthProtocol,
  type SnmpCommunityCredentials,
  type SnmpCredentials,
  type SnmpPrivProtocol,
  type SnmpSecurityLevel,
  type SnmpV3Credentials,
  type SnmpVersion,
} from './credentials.js';

export {
  compareOids,
  formatOid,
  indexUnder,
  isPrefixOf,
  normaliseOid,
  OidError,
  parseOid,
} from './oid.js';

export {
  isException,
  numberOf,
  SnmpError,
  SnmpSession,
  stringOf,
  worstCaseMs,
  type SnmpPhase,
  type SnmpSessionOptions,
  type SnmpTarget,
  type SnmpType,
  type SnmpVarbind,
} from './session.js';

export {
  snmpPool,
  SnmpSessionPool,
  withSnmp,
  type SnmpLease,
  type SnmpPoolOptions,
  type SnmpPoolStats,
} from './pool.js';

export { SNMP_CREDENTIAL_SCHEMA, snmpParamsSchema } from './schema.js';

export { snmpCheck, type SnmpCheckOptions } from './check.js';

export {
  DISK_TYPES,
  HR,
  humanBytes,
  humanDuration,
  percentOf,
  storageAt,
  storageRows,
  SYS_UPTIME,
  TICKS_PER_SECOND,
  TICKS_WRAP_DAYS,
  UCD,
  uptimeOf,
  type StorageAmounts,
  type StorageRow,
  type Uptime,
} from './mibs.js';

export {
  compilePattern,
  extract,
  MATCH_TIMEOUT_MS,
  MAX_PATTERN,
  MAX_SUBJECT,
  PatternError,
  type Extracted,
  type ExtractMode,
} from './extract.js';
