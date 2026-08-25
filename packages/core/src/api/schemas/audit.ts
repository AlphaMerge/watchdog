/**
 * The audit log response (S-10).
 *
 * `summary` and the diff's `before`/`after` are free-form by nature — they carry whatever the
 * changed field held — so this schema cannot filter them the way the object schemas filter
 * credentials. The defence is upstream instead: `toRow` in `audit/store.ts` decides what goes
 * in, and sensor parameters go in **by key only**, never by value, because they are the one
 * object field that can hold a secret before P-05's redaction lands.
 */

const ACTOR_KINDS = ['user', 'token', 'system', 'anonymous'] as const;
void ACTOR_KINDS;

export const auditActorSchema = {
  $id: 'ms:auditActor',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'userId', 'login'],
      properties: {
        kind: { const: 'user' },
        userId: { type: 'integer' },
        login: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'tokenId'],
      properties: { kind: { const: 'token' }, tokenId: { type: 'integer' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'component'],
      properties: { kind: { const: 'system' }, component: { type: 'string' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'remoteAddress'],
      properties: { kind: { const: 'anonymous' }, remoteAddress: { type: 'string' } },
    },
  ],
} as const;

export const auditEntrySchema = {
  $id: 'ms:auditEntry',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'at', 'action', 'objectId', 'objectKind', 'actor', 'summary', 'diff'],
  properties: {
    // bigint: a string on the wire, because a JS number stops being exact at 2^53.
    id: { type: 'string' },
    at: { type: 'string' },
    action: { type: 'string' },
    objectId: { type: ['integer', 'null'] },
    objectKind: { type: ['string', 'null'] },
    actor: { $ref: 'ms:auditActor' },
    summary: { type: 'object', additionalProperties: true },
    diff: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'before', 'after'],
        properties: {
          field: { type: 'string' },
          // Whatever the field held. An empty schema serialises the value as it stands.
          before: {},
          after: {},
        },
      },
    },
  },
} as const;

export const auditPageSchema = {
  $id: 'ms:auditPage',
  type: 'object',
  additionalProperties: false,
  required: ['items', 'nextBefore'],
  properties: {
    items: { type: 'array', items: { $ref: 'ms:auditEntry' } },
    /** Pass back as `before` for the next page. Null when the history has been walked to its end. */
    nextBefore: { type: ['string', 'null'] },
  },
} as const;

export const AUDIT_SCHEMAS = [auditActorSchema, auditEntrySchema, auditPageSchema];
