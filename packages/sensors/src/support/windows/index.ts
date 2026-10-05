export {
  ENV_MATCH,
  RESULT_MARKER,
  WindowsError,
  asRows,
  buildScript,
  isRecord,
  numberFrom,
  readEnvelope,
  type Envelope,
} from './envelope.js';
export {
  AUTHENTICATIONS,
  POWERSHELL_ENV,
  POWERSHELL_GRACE_MS,
  runPowerShell,
  type Authentication,
  type PowerShellOptions,
  type PowerShellRun,
} from './powershell.js';
export { WINDOWS_SCHEMA, hasCredential, windowsOptions } from './schema.js';
