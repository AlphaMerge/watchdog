import type { CheckTarget, JsonSchema } from '../../contract.js';
import type { TargetPolicy } from '@ms/shared';
import type { PinnedAddress, ResolveHost } from '../pinned-target.js';

/**
 * The mail credential, and the transport parameters every mail sensor takes (`T-17`).
 *
 * **Flat, not a `oneOf`**, for the reason the SNMP, SSH and HTTP ones are: the catalogue refuses
 * a `writeOnly` inside a combinator, because `splitCredential` uses the same annotation to decide
 * what gets encrypted, and a password landing in `public_params` is a password the API returns.
 *
 * **One kind for all four sensors, even though a relay and a mailbox are different accounts.**
 * They are different *credential sets*, not different kinds — set the relay's on the group and
 * the mailbox's on the device, and inheritance resolves each sensor to the nearest one. Two kinds
 * would mean an operator choosing between them in a form, which is a question about our data
 * model rather than about their mail server.
 */
export const MAIL_CREDENTIAL_SCHEMA: Readonly<Record<string, JsonSchema>> = {
  username: {
    type: 'string',
    maxLength: 255,
    title: 'User name',
    description:
      'Leave empty for a relay that accepts unauthenticated mail from this host — plenty of ' +
      'internal ones do, and a monitoring check has no business inventing an account.',
  },
  password: {
    type: 'string',
    maxLength: 1_024,
    writeOnly: true,
    title: 'Password',
  },
};

/** Where to connect and how, shared by all four so an operator learns it once. */
export const MAIL_TRANSPORT_SCHEMA: Readonly<Record<string, JsonSchema>> = {
  port: {
    type: 'integer',
    minimum: 0,
    maximum: 65_535,
    default: 0,
    title: 'Port',
    description: 'Zero uses this protocol’s own — the description above says which.',
  },
  security: {
    enum: ['none', 'starttls', 'tls'],
    default: 'starttls',
    title: 'Encryption',
    description:
      '`starttls` connects in the clear and upgrades, and **fails when the server does not ' +
      'offer it** rather than quietly continuing — a sensor that downgraded silently would ' +
      'report a healthy server while sending the password in plain text. `tls` is encrypted ' +
      'from the first byte. `none` is neither, and is only reasonable for a relay that takes no ' +
      'password at all.',
  },
  verifyTls: {
    type: 'boolean',
    default: true,
    title: 'Verify the certificate',
    description:
      'On by default. Turning it off means the connection is encrypted against nobody in ' +
      'particular, so the sensor says so in its message on every scan rather than once here.',
  },
  timeoutMs: {
    type: 'integer',
    minimum: 1_000,
    maximum: 300_000,
    default: 20_000,
    title: 'Timeout',
    description:
      'Per step of the conversation, not for the whole check. A mail server that has stopped ' +
      'answering looks exactly like one that is thinking, and only a deadline tells them apart.',
  },
};

/** The transport options those parameters describe. */
export function readTransport(
  params: Readonly<Record<string, unknown>>,
  /**
   * The check's whole target, not its host and family apart (`A-41c`): the pinned address goes
   * wherever the host goes, so no mail type can pass one and forget the other.
   */
  target: CheckTarget,
  defaults: { readonly plain: number; readonly tls: number },
): {
  host: string;
  port: number;
  security: 'none' | 'tls' | 'starttls';
  verifyTls: boolean;
  timeoutMs: number;
  ipVersion: 'auto' | 'v4' | 'v6';
  pinned?: PinnedAddress;
  targetPolicy?: TargetPolicy;
  resolve?: ResolveHost;
} {
  const raw = params['security'];
  const security = raw === 'none' || raw === 'tls' ? raw : 'starttls';
  const declared = Number(params['port'] ?? 0);
  return {
    host: target.host,
    port: declared > 0 ? declared : security === 'tls' ? defaults.tls : defaults.plain,
    security,
    verifyTls: params['verifyTls'] !== false,
    timeoutMs: Number(params['timeoutMs'] ?? 20_000),
    ipVersion: target.ipVersion,
    ...(target.pinned === undefined ? {} : { pinned: target.pinned }),
    // And the probe's target policy with the resolver it is checked through (`A-57`).
    ...(target.policy === undefined ? {} : { targetPolicy: target.policy }),
    ...(target.resolve === undefined ? {} : { resolve: target.resolve }),
  };
}

/** The credential, or a failure that names the kind rather than an authentication error later. */
export function readCredential(
  credentials: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): { username: string; password: string } {
  const credential = credentials['mail'] ?? {};
  const username = credential['username'];
  const password = credential['password'];
  return {
    username: typeof username === 'string' ? username : '',
    password: typeof password === 'string' ? password : '',
  };
}

/** Said on every scan rather than once at configuration time. */
export function securityNote(security: string, verifyTls: boolean): string[] {
  const notes: string[] = [];
  if (security === 'none') notes.push('this connection is not encrypted');
  else if (!verifyTls) notes.push('the certificate is not being verified');
  return notes;
}
