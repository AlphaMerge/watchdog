import type { CheckContext } from '../../contract.js';
import { refuseBlockedAddress } from '../checked-target.js';
import { scrubberOf } from '../secrets.js';
import { AUTHENTICATIONS, type Authentication, type PowerShellOptions } from './powershell.js';

/**
 * The parameters and credential every Windows sensor shares (`T-09`).
 *
 * One place, so a new Windows type cannot invent a second spelling of "which machine" or forget
 * that a blank host means this one.
 */
export const WINDOWS_SCHEMA = {
  host: {
    type: 'string',
    maxLength: 253,
    default: '',
    title: 'Machine',
    description:
      'Empty uses this device’s own host. Set it only where the machine to query is not the ' +
      'one this device is reached on. `.`, `localhost` or a loopback address means this probe’s ' +
      'own machine, which needs no credential and no WinRM configured at all.',
  },
  authentication: {
    enum: [...AUTHENTICATIONS],
    default: 'Default',
    title: 'Authentication',
    description:
      '`Default` negotiates — Kerberos in a domain, NTLM outside one — and is right almost ' +
      'everywhere. `Kerberos` refuses to fall back, which is what turns a silent downgrade into ' +
      'a failed check. `Basic` needs HTTPS on the far end. CredSSP is deliberately absent: it ' +
      'hands the credential to the monitored machine, so one compromised server would hold the ' +
      'account that reaches every other one.',
  },
  timeoutMs: {
    type: 'integer',
    minimum: 1_000,
    maximum: 300_000,
    default: 30_000,
    title: 'Timeout',
    description:
      'Generous by the standards of the other transports, because starting PowerShell is ' +
      'expensive before anything is queried and a first WinRM connection negotiates ' +
      'authentication.',
  },
} as const;

/**
 * The transport options for a check, from its parameters and its credential.
 *
 * **The credential is read from `context.credentials`, never from the parameters.** That is
 * where the vault puts it, it is encrypted at rest, and the API never gives it back — a Windows
 * password in `params` would be returned by every read of the object.
 */
export function windowsOptions(context: CheckContext): PowerShellOptions {
  const declared = typeof context.params['host'] === 'string' ? context.params['host'].trim() : '';
  const named = declared === '' ? context.target.host : declared;
  // **An address is held to the probe's target policy; a name is not resolved here** (`A-57`).
  // PowerShell resolves a name itself, and Kerberos wants the name, so a check of the name
  // would be on an answer the connection never uses.
  if (!isLocal(named)) {
    refuseBlockedAddress(
      named,
      context.target.policy,
      'connect to',
      context.target.policyException,
    );
  }

  const raw = context.credentials['windows'] ?? {};
  const username = typeof raw['username'] === 'string' ? raw['username'].trim() : '';
  const password = typeof raw['password'] === 'string' ? raw['password'] : '';
  const domain = typeof raw['domain'] === 'string' ? raw['domain'].trim() : '';

  const declaredAuth = context.params['authentication'];
  const authentication: Authentication = (AUTHENTICATIONS as readonly string[]).includes(
    String(declaredAuth),
  )
    ? (declaredAuth as Authentication)
    : 'Default';

  return {
    // **The machine, always — never "local because there is no credential".** An earlier version
    // of this blanked the host when no Windows credential was configured, which made a sensor
    // pointed at `server01` quietly measure the probe's own box and file the numbers under
    // `server01`. A silently wrong reading, and the worst kind: everything about it looks
    // healthy. A credential is *optional* because a domain service account already has a token
    // the far end accepts, and `New-CimSession -ComputerName` with no `-Credential` uses it;
    // absent credentials mean "use who I am", not "ask somewhere else".
    host: isLocal(named) ? '' : named,
    timeoutMs: Number(context.params['timeoutMs'] ?? 30_000),
    // What PowerShell printed is scrubbed before it is cut into a message (`S-21`).
    scrub: scrubberOf(context),
    // Ended on the check's cancel as on its own timeout (`P-262`).
    signal: context.signal,
    ...(username === ''
      ? {}
      : {
          credential: {
            // `DOMAIN\user` is what `New-CimSession` wants, and an operator who typed the domain
            // into its own field should not have to know that.
            username:
              domain === '' || username.includes('\\') ? username : `${domain}\\${username}`,
            password,
            authentication,
          },
        }),
  };
}

/**
 * Whether a name means "the machine this probe is on".
 *
 * `.` is WMI's own spelling of the local computer and appears in every example Microsoft
 * publishes, so an operator who types it means it. The loopback names are here because a device
 * created for the probe's own host is the obvious way somebody sets up "monitor this probe" —
 * and going out over WinRM to reach the machine the query is already running on would need WinRM
 * configured on a box that has no reason to have it.
 */
function isLocal(host: string): boolean {
  const name = host.trim().toLowerCase();
  return (
    name === '' || name === '.' || name === 'localhost' || name === '127.0.0.1' || name === '::1'
  );
}

/** True when this check has a Windows credential to use. */
export function hasCredential(context: CheckContext): boolean {
  const raw = context.credentials['windows'] ?? {};
  return typeof raw['username'] === 'string' && raw['username'].trim() !== '';
}
