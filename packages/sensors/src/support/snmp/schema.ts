import type { JsonSchema } from '../../contract.js';

/**
 * The credential parameters every SNMP sensor type takes (`T-01`).
 *
 * **Flat, not a `oneOf` on version, and that is a hard constraint rather than a style.** The
 * catalogue refuses to register a type with a `writeOnly` property inside a combinator, because
 * `ObjectService.#redact` cannot know which branch matched without evaluating the schema — and a
 * redactor that guesses either leaks a community string or deletes a live one
 * (`docs/adding-a-sensor-type.md`). The natural shape here *is* a union: v1 and v2c want a
 * community, v3 wants a user and two keys. Expressing it as one would put every secret in this
 * layer inside a combinator, so instead every field is a plain property and the combinations are
 * checked in `readCredentials`, which returns a sentence rather than an Ajv path.
 *
 * Spread it into a type's own `paramsSchema` properties. It is deliberately not a `$ref`: the
 * schema is shipped to the browser to generate a form, and a form generator resolving refs
 * across type boundaries is a second thing to keep working.
 */
export const SNMP_CREDENTIAL_SCHEMA: Readonly<Record<string, JsonSchema>> = {
  version: {
    enum: ['v1', 'v2c', 'v3'],
    default: 'v2c',
    title: 'SNMP version',
    description:
      'v2c is what most devices speak and sends the community string in clear text. v3 is the ' +
      'only version with authentication and encryption. v1 has no bulk transfer and no 64-bit ' +
      'counters, so a busy interface wraps in minutes — use it only for a device that offers ' +
      'nothing else.',
  },
  community: {
    type: 'string',
    maxLength: 255,
    writeOnly: true,
    title: 'Community string',
    description: 'For v1 and v2c. Read-only access is enough; this never writes to a device.',
  },
  username: {
    type: 'string',
    maxLength: 255,
    title: 'User name',
    description: 'For v3. The USM user configured on the agent.',
  },
  level: {
    enum: ['noAuthNoPriv', 'authNoPriv', 'authPriv'],
    default: 'authPriv',
    title: 'Security level',
    description:
      'For v3. authPriv authenticates and encrypts; authNoPriv authenticates only, so the ' +
      'values travel in clear text; noAuthNoPriv does neither.',
  },
  authProtocol: {
    enum: ['md5', 'sha', 'sha224', 'sha256', 'sha384', 'sha512'],
    default: 'sha',
    title: 'Authentication protocol',
    description: 'For v3 at authNoPriv or authPriv. Must match the agent exactly.',
  },
  authKey: {
    type: 'string',
    maxLength: 255,
    writeOnly: true,
    title: 'Authentication key',
    description: 'For v3 at authNoPriv or authPriv. At least eight characters, per RFC 3414.',
  },
  privProtocol: {
    enum: ['des', 'aes', 'aes256b', 'aes256r'],
    default: 'aes',
    title: 'Privacy protocol',
    description:
      'For v3 at authPriv. aes256b and aes256r are the two incompatible 256-bit AES variants ' +
      '(Blumenthal and Reeder); there is no way to detect which an agent wants, and the wrong ' +
      'one fails as a decryption error.',
  },
  privKey: {
    type: 'string',
    maxLength: 255,
    writeOnly: true,
    title: 'Privacy key',
    description: 'For v3 at authPriv. At least eight characters, per RFC 3414.',
  },
  context: {
    type: 'string',
    maxLength: 255,
    title: 'Context name',
    description: 'For v3 against an agent that proxies several contexts. Usually left empty.',
  },
};

/** The transport parameters: where to send, how long to wait, how hard to try. */
export const SNMP_TRANSPORT_SCHEMA: Readonly<Record<string, JsonSchema>> = {
  port: {
    type: 'integer',
    minimum: 1,
    maximum: 65_535,
    default: 161,
    title: 'Port',
    description: 'The agent’s UDP port. 161 unless somebody has moved it.',
  },
  timeoutMs: {
    type: 'integer',
    minimum: 100,
    maximum: 60_000,
    default: 5_000,
    title: 'Timeout',
    description:
      'Per attempt, not for the check. With retries set to 1 a check can take twice this long ' +
      'before it gives up.',
  },
  retries: {
    type: 'integer',
    minimum: 0,
    maximum: 5,
    default: 1,
    title: 'Retries',
    description:
      'SNMP runs over UDP, so a lost request looks exactly like a silent agent. One retry ' +
      'absorbs ordinary packet loss; more mostly delays a genuine failure being reported.',
  },
};

/**
 * A complete `paramsSchema` for an SNMP sensor type: the credentials, the transport, and
 * whatever the type itself needs.
 *
 * A helper rather than a base object to extend, because `additionalProperties: false` and the
 * `required` list have to be composed rather than inherited, and a type that spread the fields
 * by hand would eventually forget one of them.
 */
export function snmpParamsSchema(
  own: Readonly<Record<string, JsonSchema>> = {},
  required: readonly string[] = [],
): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    ...(required.length === 0 ? {} : { required: [...required] }),
    properties: {
      ...SNMP_CREDENTIAL_SCHEMA,
      ...SNMP_TRANSPORT_SCHEMA,
      ...own,
    },
  };
}
