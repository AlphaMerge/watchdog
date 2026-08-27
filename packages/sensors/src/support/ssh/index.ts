/**
 * The SSH session layer (`T-07`) — what `T-08` builds on.
 *
 * A sensor type imports from here and never from `ssh2`, which is confined to `session.ts` and
 * the declaration beside it. Import it from *inside* `execute`, never at the top of a sensor-type
 * module: the core loads the catalogue for schemas and channel declarations and must not pay for
 * a crypto stack it never uses (`docs/adding-a-sensor-type.md`).
 */
export {
  credentialFingerprint,
  describeCredentials,
  readCredentials,
  SshCredentialError,
  type SshAuthMethod,
  type SshCredentials,
  type SshKeyCredentials,
  type SshPasswordCredentials,
} from './credentials.js';

export {
  describeVerdict,
  fingerprintOf,
  matchesFingerprint,
  verifyHostKey,
  type HostKeyPolicy,
  type HostKeyVerdict,
} from './host-key.js';

export {
  SshError,
  SshSession,
  type SshExecResult,
  type SshPhase,
  type SshSessionOptions,
  type SshTarget,
} from './session.js';

export {
  sshPool,
  SshSessionPool,
  withSsh,
  type SshLease,
  type SshPoolOptions,
  type SshPoolStats,
} from './pool.js';

export { SSH_CREDENTIAL_SCHEMA, SSH_TRANSPORT_SCHEMA, sshParamsSchema } from './schema.js';

export { hostKeyNote, sshCheck, type SshCheckOptions } from './check.js';
