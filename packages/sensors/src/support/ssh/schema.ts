import type { JsonSchema } from '../../contract.js';

/**
 * The SSH credential parameters, and the transport ones every SSH sensor type takes (`T-07`).
 *
 * **Flat, not a `oneOf` on the authentication method**, for the same hard reason the SNMP one is:
 * the catalogue refuses a `writeOnly` property inside a combinator, because the redactor cannot
 * know which branch matched without evaluating the schema — and here the consequence is worse
 * than a leaked API field, since `splitCredential` uses the same annotation to decide what gets
 * encrypted. A private key landing in `public_params` would be a private key the API returns.
 * So password and key are both plain properties and `readCredentials` decides between them.
 */
export const SSH_CREDENTIAL_SCHEMA: Readonly<Record<string, JsonSchema>> = {
  username: {
    type: 'string',
    maxLength: 255,
    title: 'User name',
    description:
      'The account to log in as. A monitoring account wants no more than read access and a ' +
      'shell — most of these sensors run `df`, `uptime` and `cat /proc/meminfo`.',
  },
  password: {
    type: 'string',
    maxLength: 1_024,
    writeOnly: true,
    title: 'Password',
    description: 'For password authentication. Leave empty when using a private key.',
  },
  privateKey: {
    type: 'string',
    maxLength: 32_768,
    writeOnly: true,
    title: 'Private key',
    description:
      'An OpenSSH or PEM private key, pasted whole including its BEGIN and END lines. A key ' +
      'takes precedence over a password when both are set, so moving a device from one to the ' +
      'other is a matter of filling this in.',
  },
  passphrase: {
    type: 'string',
    maxLength: 1_024,
    writeOnly: true,
    title: 'Key passphrase',
    description: 'Only if the private key above is encrypted.',
  },
  hostKeyPolicy: {
    enum: ['strict', 'accept-any'],
    default: 'strict',
    title: 'Host key checking',
    description:
      '`strict` refuses to log in unless the server presents the fingerprint below — which is ' +
      'what stops a password being handed to whatever answered on port 22. `accept-any` ' +
      'connects to anything and says so in every sensor message; it authenticates the server ' +
      'not at all, and is only reasonable on a network you already trust completely.',
  },
  hostKeyFingerprint: {
    type: 'string',
    maxLength: 128,
    default: '',
    title: 'Host key fingerprint',
    description:
      'The server’s key, as `ssh-keygen -lf` prints it — SHA256: followed by base64. Leave it ' +
      'empty and the first check will fail *telling you the fingerprint it saw*; compare that ' +
      'against the machine and paste it here to accept it. That is deliberate: it is the ' +
      'comparison that makes trusting a key on first sight worth anything. One key, for a set ' +
      'on one device; list them under host keys for a set that several servers share.',
  },
  hostKeys: {
    type: 'array',
    maxItems: 64,
    items: { type: 'string', minLength: 1, maxLength: 128 },
    title: 'Host keys',
    description:
      'Every server this set may log in to, by its key, as `ssh-keygen -lf` prints it (`A-41b`). ' +
      'The fingerprint above is accepted as well. With any listed and checking strict, the set ' +
      'goes to a device whoever created it, if the device is inside the allowed targets or there ' +
      'are none, because a server whose key is not here is never sent the password. Adding a ' +
      'key needs the password again.',
  },
};

/** Where to connect and how long to wait. */
export const SSH_TRANSPORT_SCHEMA: Readonly<Record<string, JsonSchema>> = {
  port: {
    type: 'integer',
    minimum: 1,
    maximum: 65_535,
    default: 22,
    title: 'Port',
  },
  connectTimeoutMs: {
    type: 'integer',
    minimum: 1_000,
    maximum: 120_000,
    default: 15_000,
    title: 'Connect timeout',
    description:
      'The whole handshake — TCP, key exchange and authentication. Separate from the command ' +
      'timeout because a slow login and a slow script are different faults with different fixes.',
  },
  commandTimeoutMs: {
    type: 'integer',
    minimum: 1_000,
    maximum: 300_000,
    default: 30_000,
    title: 'Command timeout',
    description:
      'How long one command may run. Reaching it fails the check and closes the channel, not ' +
      'the connection — the other sensors on this device are still using it.',
  },
};

/** A complete `paramsSchema` for an SSH sensor type: transport plus whatever the type needs. */
export function sshParamsSchema(
  own: Readonly<Record<string, JsonSchema>> = {},
  required: readonly string[] = [],
): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    ...(required.length === 0 ? {} : { required: [...required] }),
    properties: {
      // Deliberately *not* the credential fields: unlike SNMP's `T-01`, which predated `A-05`,
      // SSH arrived after it. Credentials live on the device and are inherited (`A-05`); a
      // per-sensor copy would be one more place to rotate a key that is already in the vault.
      ...SSH_TRANSPORT_SCHEMA,
      ...own,
    },
  };
}
