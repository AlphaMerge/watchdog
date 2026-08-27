/**
 * The syslog transport (`T-20`).
 *
 * A subpath export like `@ms/sensors/snmp`, and for the same reason: the probe's listener needs
 * the sockets and the parser, and nothing that only registers sensor types should have to load
 * `node:dgram` and `node:net` to find out what types exist.
 */
export { openSyslogReceiver, drain } from './receiver.js';
export type { ReceivedSyslog, SyslogReceiver, SyslogReceiverOptions } from './receiver.js';
export {
  FACILITIES,
  MAX_LINE,
  SEVERITIES,
  facilityName,
  parseSyslog,
  renderSyslog,
  severityName,
} from './parse.js';
export type { Severity, SyslogMessage } from './parse.js';
