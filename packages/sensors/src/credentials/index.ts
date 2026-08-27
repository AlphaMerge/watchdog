import type { JsonSchema } from '../contract.js';
// Straight to the schema module, never through `support/snmp/index.js`.
//
// That barrel re-exports `session.ts`, which imports `net-snmp` at the top. The core loads this
// registry to validate a write and to generate a form, and it never runs a check — so importing
// the barrel would drag a UDP stack into a process with no use for it, which is the same rule
// `docs/adding-a-sensor-type.md` states for `execute`.
import { SNMP_CREDENTIAL_SCHEMA } from '../support/snmp/schema.js';
import { SSH_CREDENTIAL_SCHEMA } from '../support/ssh/schema.js';
import { HTTP_CREDENTIAL_SCHEMA } from '../support/http/schema.js';
import { MAIL_CREDENTIAL_SCHEMA } from '../support/mail/schema.js';

/**
 * The credential kinds an installation can store (`A-05`).
 *
 * Mirrors the `credential_kind` enum in migration 001, but only the kinds something can actually
 * *use*: a kind with no transport behind it would offer an operator a form for credentials
 * nothing would ever authenticate with, and a forgotten password in a database is worse than an
 * absent feature. `T-17` added `mail`, which took a migration because the kind is a column value; `T-09` adds `windows`, which is already in the enum and so is one entry here.
 *
 * **A kind is a schema, and the schema does the same three jobs it does for a sensor type**
 * (`docs/adding-a-sensor-type.md`): it validates the write, it generates the form, and — the
 * part with teeth here — `writeOnly` marks which fields are the secret. That last one is not a
 * display hint: it is what splits the record between `credential_set.public_params`, which is
 * stored in the clear and returned by the API, and `credential_set.secret`, which is encrypted
 * and returned to nobody. One annotation, one split, in one place.
 */
export interface CredentialKindDefinition {
  /** Matches the `credential_kind` enum. Stable forever — it is a column value. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** `writeOnly` properties are the secret half. Plain properties only — see below. */
  readonly schema: JsonSchema;
}

export const CREDENTIAL_KINDS: readonly CredentialKindDefinition[] = [
  {
    id: 'snmp',
    name: 'SNMP',
    description:
      'Used by every SNMP sensor on this object and everything below it. Set it once on the ' +
      'device — or on the group, if a whole rack shares a community string.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { ...SNMP_CREDENTIAL_SCHEMA },
    },
  },
  {
    id: 'ssh',
    name: 'SSH',
    description:
      'Used by every SSH sensor on this object and everything below it. A monitoring account ' +
      'needs no more than a shell and read access. The host key fingerprint here is what stops ' +
      'the password being handed to whatever answers on port 22.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { ...SSH_CREDENTIAL_SCHEMA },
    },
  },
  {
    id: 'http',
    name: 'HTTP',
    description:
      'Used by every HTTP Advanced sensor on this object and everything below it. A hundred ' +
      'sensors against one API rotate their token here, in one place — a token typed into each ' +
      'sensor’s parameters would be a hundred places to rotate it.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { ...HTTP_CREDENTIAL_SCHEMA },
    },
  },
  {
    id: 'mail',
    name: 'Mail',
    description:
      'Used by every mail sensor on this object and everything below it. A relay account and a ' +
      'mailbox account are two credential *sets* of this one kind, not two kinds — set the ' +
      'relay’s on the group and the mailbox’s on the device, and inheritance resolves each ' +
      'sensor to the nearest one.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { ...MAIL_CREDENTIAL_SCHEMA },
    },
  },
];

const BY_ID = new Map(CREDENTIAL_KINDS.map((kind) => [kind.id, kind]));

export function credentialKind(id: string): CredentialKindDefinition | undefined {
  return BY_ID.get(id);
}

export function credentialKindIds(): readonly string[] {
  return CREDENTIAL_KINDS.map((kind) => kind.id);
}

/**
 * The property names a kind marks `writeOnly` — its secret half.
 *
 * Top-level only, and deliberately so. The redactor for sensor parameters walks nested objects,
 * but here the split is not cosmetic: a `writeOnly` buried inside a combinator cannot be located
 * without evaluating which branch matched, and the consequence is not a leaked field in a
 * response but a secret written to `public_params` in the clear. `assertSplittable` refuses such
 * a schema at startup rather than letting it be discovered in a database.
 */
export function secretFields(definition: CredentialKindDefinition): readonly string[] {
  const properties = (definition.schema as { properties?: Record<string, JsonSchema> }).properties;
  if (properties === undefined) return [];
  return Object.entries(properties)
    .filter(([, property]) => (property as { writeOnly?: boolean }).writeOnly === true)
    .map(([name]) => name);
}

/**
 * Refuses a kind whose secrets could not be split out reliably. Called at start-up.
 *
 * The same rule the sensor-type catalogue enforces, for the same reason and with a worse failure
 * if it is skipped: a sensor type that gets this wrong leaks a parameter through an API response,
 * and a credential kind that gets it wrong writes a community string into a column the API
 * returns by design.
 */
export function assertSplittable(definition: CredentialKindDefinition): void {
  const schema = definition.schema as Record<string, unknown>;
  for (const combinator of ['oneOf', 'anyOf', 'allOf', 'not', 'if']) {
    if (combinator in schema) {
      throw new Error(
        `credential kind "${definition.id}" uses "${combinator}" at its root; a secret inside a ` +
          'combinator cannot be separated from the public parameters without evaluating which ' +
          'branch matched, and guessing wrong writes it in the clear',
      );
    }
  }
  const properties = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, property] of Object.entries(properties)) {
    if (property['writeOnly'] !== true) continue;
    if (property['type'] !== 'string') {
      throw new Error(
        `credential kind "${definition.id}" marks "${name}" write-only but not a string; the ` +
          'vault seals strings',
      );
    }
  }
  if (secretFields(definition).length === 0) {
    throw new Error(
      `credential kind "${definition.id}" marks nothing write-only, so it would store no secret ` +
        'at all — that is a kind with no reason to be encrypted',
    );
  }
}

/**
 * Splits a submitted record into what is stored in the clear and what is sealed.
 *
 * Everything not marked `writeOnly` is public. That direction matters: a new field added to a
 * kind's schema without an annotation ends up *public*, which is visible and reportable, rather
 * than silently unencrypted-but-assumed-secret. The catalogue check above is what stops a field
 * that should have been sealed from being added without one.
 */
export function splitCredential(
  definition: CredentialKindDefinition,
  values: Readonly<Record<string, unknown>>,
): { publicParams: Record<string, unknown>; secret: Record<string, unknown> } {
  const secrets = new Set(secretFields(definition));
  const publicParams: Record<string, unknown> = {};
  const secret: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (secrets.has(key)) secret[key] = value;
    else publicParams[key] = value;
  }
  return { publicParams, secret };
}
