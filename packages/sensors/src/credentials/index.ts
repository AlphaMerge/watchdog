import { MAX_ALLOWED_TARGETS, parseAllowedTarget } from '@ms/shared';
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
import { DATABASE_CREDENTIAL_SCHEMA } from '../support/db/schema.js';
import { acceptedHostKeys } from '../support/ssh/credentials.js';

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
  /**
   * The public fields that bound where each secret may go (`A-41b`), by secret. Every secret is
   * bound to `allowedTargets` at least, and `assertSplittable` refuses a kind that leaves one out.
   * When a write widens what one of these fields allows, the secrets bound to it are cleared
   * unless the same write sends them again: whoever may edit a set without knowing its password
   * may narrow where it goes, and may not widen it (`widenedFields`).
   */
  readonly secretDestinations: Readonly<Record<string, readonly string[]>>;
}

/**
 * Where a set may be sent, on every kind (`A-41b`). The entries are `@ms/shared`'s
 * `parseAllowedTarget`; the vault refuses a write holding one that does not parse.
 */
const ALLOWED_TARGETS: JsonSchema = {
  type: 'array',
  maxItems: MAX_ALLOWED_TARGETS,
  items: { type: 'string', minLength: 1, maxLength: 255 },
  title: 'Allowed targets',
  description:
    'The devices this set may be sent to: host names, *.domain patterns, addresses and CIDR ' +
    'ranges. A device inside them receives it whoever created the device, and one outside does ' +
    'not, whoever created it. Leave it empty and the set goes wherever somebody with write on ' +
    'this object vouches for. A device named by host name is inside only a name or a *.domain: ' +
    'addresses and ranges match devices given as addresses. Adding an entry, or emptying the ' +
    'list, needs the password again.',
};

/** What every kind's secrets are bound to, and SSH's, which a server key bounds as well. */
const TO_TARGETS = ['allowedTargets'] as const;
const TO_TARGETS_AND_KEYS = [
  'allowedTargets',
  'hostKeys',
  'hostKeyFingerprint',
  'hostKeyPolicy',
] as const;

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
      properties: { ...SNMP_CREDENTIAL_SCHEMA, allowedTargets: ALLOWED_TARGETS },
    },
    secretDestinations: { community: TO_TARGETS, authKey: TO_TARGETS, privKey: TO_TARGETS },
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
      properties: { ...SSH_CREDENTIAL_SCHEMA, allowedTargets: ALLOWED_TARGETS },
    },
    secretDestinations: {
      password: TO_TARGETS_AND_KEYS,
      privateKey: TO_TARGETS_AND_KEYS,
      passphrase: TO_TARGETS_AND_KEYS,
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
      properties: { ...HTTP_CREDENTIAL_SCHEMA, allowedTargets: ALLOWED_TARGETS },
    },
    secretDestinations: { password: TO_TARGETS, token: TO_TARGETS },
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
      properties: { ...MAIL_CREDENTIAL_SCHEMA, allowedTargets: ALLOWED_TARGETS },
    },
    secretDestinations: { password: TO_TARGETS },
  },
  {
    id: 'database',
    name: 'Database',
    description:
      'Used by every database sensor on this object and everything below it. Give it `SELECT` ' +
      'on what it is watching and nothing else: these sensors run whatever query they are ' +
      'given, and the account’s rights are the only thing between a mistyped one and a change ' +
      'to the data.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { ...DATABASE_CREDENTIAL_SCHEMA, allowedTargets: ALLOWED_TARGETS },
    },
    secretDestinations: { password: TO_TARGETS },
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
  // Every secret says what bounds where it goes, and that is `allowedTargets` at least (`A-41b`):
  // a secret bound to nothing would survive a write that sent the set anywhere.
  const secrets = secretFields(definition);
  const declared = new Set(publicFields(definition));
  for (const secret of secrets) {
    const bound = definition.secretDestinations[secret];
    if (bound === undefined || !bound.includes('allowedTargets')) {
      throw new Error(
        `credential kind "${definition.id}" does not bind its secret "${secret}" to ` +
          'allowedTargets in secretDestinations, so widening where the set may go would keep it',
      );
    }
    const unknown = bound.filter((field) => !declared.has(field));
    if (unknown.length > 0) {
      throw new Error(
        `credential kind "${definition.id}" binds "${secret}" to ${unknown.join(', ')}, which it ` +
          'does not declare as a public field',
      );
    }
  }
  for (const listed of Object.keys(definition.secretDestinations)) {
    if (!secrets.includes(listed)) {
      throw new Error(
        `credential kind "${definition.id}" binds "${listed}" in secretDestinations, which is ` +
          'not one of its secrets',
      );
    }
  }
}

/** The property names a kind declares and does not mark `writeOnly`: its public half (`A-43`). */
export function publicFields(definition: CredentialKindDefinition): readonly string[] {
  const properties = (definition.schema as { properties?: Record<string, JsonSchema> }).properties;
  if (properties === undefined) return [];
  return Object.entries(properties)
    .filter(([, property]) => (property as { writeOnly?: boolean }).writeOnly !== true)
    .map(([name]) => name);
}

/**
 * What of a stored `public_params` its kind declares public (`A-43`).
 *
 * Every read of a credential set goes through this. Until `A-43` a write was never checked
 * against its kind, so a mistyped secret key (`comunity` for `community`) was stored here in the
 * clear, and a read returned it. A write can no longer do that; this is what keeps a row written
 * before then from being returned.
 */
export function declaredPublic(
  definition: CredentialKindDefinition,
  stored: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const declared = new Set(publicFields(definition));
  return Object.fromEntries(Object.entries(stored).filter(([key]) => declared.has(key)));
}

/** The keys of a stored `public_params` that its kind does not declare public (`A-43`). */
export function undeclaredKeys(
  definition: CredentialKindDefinition,
  stored: Readonly<Record<string, unknown>>,
): string[] {
  const declared = new Set(publicFields(definition));
  return Object.keys(stored).filter((key) => !declared.has(key));
}

/**
 * The schema a submitted record is checked against before it is split (`A-43`).
 *
 * The kind's own, with the two differences a write needs. A secret may be `null`, which unsets
 * it. On a set that already exists, a secret is never required, because one the write leaves out
 * is kept. Everything else stands, `additionalProperties: false` above all: a key the kind does
 * not declare is refused, where `splitCredential` would have stored it as public.
 */
export function writeSchema(definition: CredentialKindDefinition, existing: boolean): JsonSchema {
  const schema = definition.schema as {
    properties?: Record<string, JsonSchema>;
    required?: readonly string[];
  };
  const secrets = new Set(secretFields(definition));
  // A secret is a plain string (`assertSplittable`), so widening its type is the whole change,
  // and an error still names the field rather than a branch of a combinator.
  const properties = Object.fromEntries(
    Object.entries(schema.properties ?? {}).map(([name, property]) =>
      secrets.has(name) ? [name, { ...property, type: ['string', 'null'] }] : [name, property],
    ),
  );
  const required = (schema.required ?? []).filter((name) => !(existing && secrets.has(name)));
  return {
    ...definition.schema,
    properties,
    ...(required.length === 0 ? {} : { required }),
  };
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

/**
 * What bounds where a set may go (`A-41b`), read from its public half.
 *
 * `targets` is `allowedTargets` as written, empty when it names none. `hostKeys` is the server
 * keys an SSH set may be used with, and only when it lists some in `hostKeys` and checks them
 * strictly; null otherwise, and always for every other kind. **The one `hostKeyFingerprint` a
 * set held before `A-41b` is checked by the probe, and bounds nothing here**: counting it would
 * have handed every existing strict SSH set to anyone who can write a device beneath it, on the
 * day of the upgrade, with nobody having chosen that.
 */
export interface CredentialRestriction {
  readonly targets: readonly string[];
  readonly hostKeys: readonly string[] | null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
}

export function restrictionOf(
  kind: string,
  values: Readonly<Record<string, unknown>>,
): CredentialRestriction {
  const targets = strings(values['allowedTargets'])
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const listed = strings(values['hostKeys']).some((key) => key.trim() !== '');
  const strict = values['hostKeyPolicy'] !== 'accept-any';
  return {
    targets,
    hostKeys: kind === 'ssh' && listed && strict ? acceptedHostKeys(values) : null,
  };
}

/**
 * Whether a set is bound at all. A restricted set goes to whatever is inside its bounds, whoever
 * asks, and nowhere else; an unrestricted one goes where `A-41`'s voucher says.
 */
export function isRestricted(restriction: CredentialRestriction): boolean {
  return restriction.targets.length > 0 || restriction.hostKeys !== null;
}

/** An entry as it is compared: the parsed form, or the text itself when it does not parse. */
function canonical(entry: string): string {
  const parsed = parseAllowedTarget(entry);
  if (typeof parsed === 'string') return entry.trim();
  switch (parsed.kind) {
    case 'name':
      return parsed.name;
    case 'suffix':
      return `*.${parsed.suffix}`;
    case 'address':
      return parsed.address;
    case 'range':
      return `${parsed.network}/${String(parsed.prefix)}`;
  }
}

/** Whether every entry of `narrower` is already in `wider`. */
function covers(wider: readonly string[], narrower: readonly string[]): boolean {
  return narrower.every((entry) => wider.includes(entry));
}

/**
 * The public fields whose bound a write widened (`A-41b`): the secrets bound to them are cleared
 * unless the write sends them again.
 *
 * **Only a bound that was there can widen.** Adding targets to a set with none, or removing some
 * from a set that has them, narrows it, and the secret stays. Adding an entry that was not there,
 * or emptying the list, widens it, even when the new entry sits inside an old range: telling that
 * apart would be a comparison of ranges to save somebody typing a password, and getting it wrong
 * would send one somewhere new. SSH's key bound widens the same way, and when strict checking is
 * turned off.
 */
export function widenedFields(
  kind: string,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): string[] {
  const was = restrictionOf(kind, before);
  const now = restrictionOf(kind, after);
  const widened: string[] = [];
  const wasTargets = was.targets.map(canonical);
  if (
    wasTargets.length > 0 &&
    (now.targets.length === 0 || !covers(wasTargets, now.targets.map(canonical)))
  ) {
    widened.push('allowedTargets');
  }
  if (was.hostKeys !== null && (now.hostKeys === null || !covers(was.hostKeys, now.hostKeys))) {
    widened.push('hostKeys', 'hostKeyFingerprint', 'hostKeyPolicy');
  }
  return widened;
}
