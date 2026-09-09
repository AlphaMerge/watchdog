/**
 * The flow transport (`B-01`).
 *
 * A subpath export like `@ms/sensors/syslog`, and for the same reason: the probe's listener needs
 * the decoder and, from `B-02`, the socket — and nothing that only registers sensor types should
 * have to load `node:dgram` to find out what types exist.
 */
export {
  FlowDecodeError,
  NETFLOW_V5,
  V5_HEADER_BYTES,
  V5_MAX_RECORDS,
  V5_RECORD_BYTES,
  decodeNetflowV5,
  flowWindow,
} from './netflow5.js';
export { IPFIX, NETFLOW_V9, decodeFlowSets, isTemplatedVersion } from './netflow9.js';
export type { DecodedFlowSets, FlowFields, FlowSetHeader } from './netflow9.js';
export { TemplateCache, VARIABLE_LENGTH } from './templates.js';
export type {
  Template,
  TemplateCacheOptions,
  TemplateCacheStats,
  TemplateField,
  TemplateKey,
} from './templates.js';
export { openFlowReceiver } from './receiver.js';
export type { FlowReceiver, FlowReceiverOptions, ReceivedFlow } from './receiver.js';
export type {
  FlowDecodeFailure,
  NetflowV5Datagram,
  NetflowV5Header,
  NetflowV5Record,
  SamplingMode,
} from './netflow5.js';
