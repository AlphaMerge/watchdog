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
export type {
  FlowDecodeFailure,
  NetflowV5Datagram,
  NetflowV5Header,
  NetflowV5Record,
  SamplingMode,
} from './netflow5.js';
