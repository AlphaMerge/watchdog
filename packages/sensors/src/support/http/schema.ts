import type { JsonSchema } from '../../contract.js';

/**
 * The HTTP credential kind (`T-13`).
 *
 * **Flat, and both schemes side by side**, for the reason the SNMP and SSH ones are: the
 * catalogue refuses a `writeOnly` inside a combinator, because the same annotation decides what
 * gets encrypted — a bearer token landing in `public_params` would be a token the API returns.
 * So `token` and `password` are plain properties and the sensor decides which to send, preferring
 * the token. That preference is deliberate: an operator moving a device from basic auth to a
 * bearer token fills the token in and expects it to be used, rather than having to clear the old
 * password first.
 */
export const HTTP_CREDENTIAL_SCHEMA: Readonly<Record<string, JsonSchema>> = {
  username: {
    type: 'string',
    maxLength: 255,
    title: 'User name',
    description: 'For HTTP basic authentication. Leave empty when using a bearer token.',
  },
  password: {
    type: 'string',
    maxLength: 1_024,
    writeOnly: true,
    title: 'Password',
    description: 'For HTTP basic authentication.',
  },
  token: {
    type: 'string',
    maxLength: 4_096,
    writeOnly: true,
    title: 'Bearer token',
    description:
      'Sent as `Authorization: Bearer …`. Takes precedence over the user name and password ' +
      'above, so moving a device from basic authentication to a token is a matter of filling ' +
      'this in.',
  },
};
