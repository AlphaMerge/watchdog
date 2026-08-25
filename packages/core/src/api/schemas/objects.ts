/**
 * Response schemas are the load-bearing credential defence.
 *
 * Fastify serialises 2xx bodies with `fast-json-stringify` against the declared schema, so a
 * property absent from the schema is dropped even if a repository leaks it. There is no
 * `secret` property anywhere in this file, and a test walks every schema to keep it that way.
 */

const OBJECT_KINDS = ['root', 'probe', 'group', 'device', 'sensor'] as const;
const CREDENTIAL_KINDS = ['snmp', 'windows', 'ssh', 'vmware', 'database', 'http'] as const;

export const settingSourceSchema = {
  $id: 'ms:settingSource',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'objectId'],
      properties: { kind: { const: 'own' }, objectId: { type: 'integer' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'objectId', 'depth'],
      properties: {
        kind: { const: 'inherited' },
        objectId: { type: 'integer' },
        depth: { type: 'integer' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: { kind: { const: 'default' } },
    },
  ],
} as const;

export const objectRefSchema = {
  $id: 'ms:objectRef',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'name'],
  properties: {
    id: { type: 'integer' },
    kind: { enum: OBJECT_KINDS },
    name: { type: 'string' },
  },
} as const;

export const resolvedSettingSchema = {
  $id: 'ms:resolvedSetting',
  type: 'object',
  additionalProperties: false,
  required: ['key', 'value', 'source'],
  properties: {
    key: { type: 'string' },
    value: {},
    source: { $ref: 'ms:settingSource' },
  },
} as const;

export const objectSummarySchema = {
  $id: 'ms:objectSummary',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'parentId', 'kind', 'name', 'tags', 'priority', 'version', 'hasChildren'],
  properties: {
    id: { type: 'integer' },
    parentId: { type: ['integer', 'null'] },
    kind: { enum: OBJECT_KINDS },
    name: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    priority: { type: 'integer' },
    version: { type: 'integer' },
    hasChildren: { type: 'boolean' },
    depth: { type: 'integer' },
    host: { type: 'string' },
    sensorType: { type: 'string' },
    effective: { type: 'object', additionalProperties: { $ref: 'ms:resolvedSetting' } },
  },
} as const;

export const objectDetailSchema = {
  $id: 'ms:objectDetail',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'kind',
    'parentId',
    'name',
    'tags',
    'priority',
    'comments',
    'version',
    'childCount',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'integer' },
    kind: { enum: OBJECT_KINDS },
    parentId: { type: ['integer', 'null'] },
    name: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    priority: { type: 'integer' },
    comments: { type: 'string' },
    version: { type: 'integer' },
    childCount: { type: 'integer' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    // device
    host: { type: 'string' },
    ipVersion: { enum: ['auto', 'v4', 'v6'] },
    // sensor
    sensorType: { type: 'string' },
    params: { type: 'object', additionalProperties: true },
    // expansions
    settings: { type: 'array', items: { $ref: 'ms:settingView' } },
    channels: { type: 'array', items: { $ref: 'ms:channelRecord' } },
    credentials: { type: 'array', items: { $ref: 'ms:credentialView' } },
    ancestors: { type: 'array', items: { $ref: 'ms:objectRef' } },
  },
} as const;

export const settingViewSchema = {
  $id: 'ms:settingView',
  type: 'object',
  additionalProperties: false,
  required: ['key', 'description', 'schema', 'effective', 'own'],
  properties: {
    key: { type: 'string' },
    description: { type: 'string' },
    schema: { type: 'object', additionalProperties: true },
    effective: {
      type: 'object',
      additionalProperties: false,
      required: ['value', 'source'],
      properties: { value: {}, source: { $ref: 'ms:settingSource' } },
    },
    // null means no override — distinct from { value } meaning "overridden to the value the
    // parent happens to have". The override toggle depends on telling those apart.
    own: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['value'],
          properties: { value: {} },
        },
      ],
    },
  },
} as const;

export const channelRecordSchema = {
  $id: 'ms:channelRecord',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'sensorId',
    'key',
    'name',
    'unit',
    'isPrimary',
    'scaleMul',
    'scaleDiv',
    'decimals',
    'limits',
    'spikeMin',
    'spikeMax',
    'showInGraph',
    'showInTable',
  ],
  properties: {
    id: { type: 'integer' },
    sensorId: { type: 'integer' },
    key: { type: 'string' },
    name: { type: 'string' },
    unit: { type: 'string' },
    isPrimary: { type: 'boolean' },
    // `numeric` columns: strings on the wire, never a lossy JS number.
    scaleMul: { type: 'string' },
    scaleDiv: { type: 'string' },
    decimals: { type: ['integer', 'null'] },
    limits: { type: 'object', additionalProperties: true },
    spikeMin: { type: ['number', 'null'] },
    spikeMax: { type: ['number', 'null'] },
    showInGraph: { type: 'boolean' },
    showInTable: { type: 'boolean' },
  },
} as const;

/** No secret, no key id, no length, no hash. There is no field a secret could occupy. */
export const credentialViewSchema = {
  $id: 'ms:credentialView',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'publicParams', 'source', 'updatedAt'],
  properties: {
    kind: { enum: CREDENTIAL_KINDS },
    publicParams: { type: 'object', additionalProperties: true },
    source: { $ref: 'ms:settingSource' },
    updatedAt: { type: 'string' },
  },
} as const;

const objectFields = {
  name: { type: 'string', minLength: 1, maxLength: 500 },
  tags: {
    type: 'array',
    maxItems: 50,
    items: { type: 'string', minLength: 1, maxLength: 100 },
  },
  priority: { type: 'integer', minimum: 1, maximum: 5 },
  comments: { type: 'string', maxLength: 10_000 },
} as const;

export const createObjectSchema = {
  $id: 'ms:createObject',
  type: 'object',
  required: ['kind', 'parentId', 'name'],
  additionalProperties: false,
  properties: {
    kind: { enum: ['probe', 'group', 'device', 'sensor'] },
    parentId: { type: 'integer' },
    ...objectFields,
    host: { type: 'string', minLength: 1, maxLength: 255 },
    ipVersion: { enum: ['auto', 'v4', 'v6'] },
    sensorType: { type: 'string', pattern: '^[a-z0-9]+(\\.[a-z0-9-]+)+$', maxLength: 100 },
    params: { type: 'object', additionalProperties: true },
  },
  allOf: [
    {
      if: { properties: { kind: { const: 'device' } }, required: ['kind'] },
      then: { required: ['host'] },
    },
    {
      if: { properties: { kind: { const: 'sensor' } }, required: ['kind'] },
      then: { required: ['sensorType'] },
    },
    // A group has no host and a device has no sensor type. Rejecting the mismatch here means
    // no handler has to hand-check it.
    {
      if: { properties: { kind: { enum: ['probe', 'group'] } }, required: ['kind'] },
      then: { not: { anyOf: [{ required: ['host'] }, { required: ['sensorType'] }] } },
    },
    {
      if: { properties: { kind: { const: 'device' } }, required: ['kind'] },
      then: { not: { required: ['sensorType'] } },
    },
    {
      if: { properties: { kind: { const: 'sensor' } }, required: ['kind'] },
      then: { not: { required: ['host'] } },
    },
  ],
} as const;

/**
 * `parentId` is absent from every branch, so `PATCH {parentId: 7}` is a 400 from the schema
 * rather than a hand-written special case. `sensorType` is absent because a sensor's type is
 * immutable: changing it would keep the channel rows and their history while the measurement
 * underneath them changed meaning.
 */
export const updateObjectSchema = {
  $id: 'ms:updateObject',
  type: 'object',
  required: ['kind'],
  minProperties: 2,
  additionalProperties: false,
  properties: {
    kind: { enum: OBJECT_KINDS },
    ...objectFields,
    host: { type: 'string', minLength: 1, maxLength: 255 },
    ipVersion: { enum: ['auto', 'v4', 'v6'] },
    params: { type: 'object', additionalProperties: true },
  },
  allOf: [
    {
      if: { properties: { kind: { enum: ['root', 'probe', 'group'] } }, required: ['kind'] },
      then: { not: { anyOf: [{ required: ['host'] }, { required: ['params'] }] } },
    },
    {
      if: { properties: { kind: { const: 'device' } }, required: ['kind'] },
      then: { not: { required: ['params'] } },
    },
    {
      if: { properties: { kind: { const: 'sensor' } }, required: ['kind'] },
      then: { not: { anyOf: [{ required: ['host'] }, { required: ['ipVersion'] }] } },
    },
  ],
} as const;

const settingChangeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'before', 'after'],
  properties: {
    key: { type: 'string' },
    before: { $ref: 'ms:resolvedSetting' },
    after: { $ref: 'ms:resolvedSetting' },
  },
} as const;

export const moveResultSchema = {
  $id: 'ms:moveResult',
  type: 'object',
  additionalProperties: false,
  required: [
    'object',
    'fromParentId',
    'toParentId',
    'movedCount',
    'probeChanged',
    'settingsChanged',
    'credentialsChanged',
  ],
  properties: {
    object: { $ref: 'ms:objectDetail' },
    fromParentId: { type: 'integer' },
    toParentId: { type: 'integer' },
    movedCount: { type: 'integer' },
    probeChanged: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'to'],
          properties: {
            from: { oneOf: [{ type: 'null' }, { $ref: 'ms:objectRef' }] },
            to: { oneOf: [{ type: 'null' }, { $ref: 'ms:objectRef' }] },
          },
        },
      ],
    },
    settingsChanged: { type: 'array', items: settingChangeSchema },
    // Credentials are inherited, so moving a device out of the group that held its SNMP
    // community silently breaks it. Reported by kind and by where it came from — never a value.
    credentialsChanged: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'before', 'after'],
        properties: {
          kind: { enum: CREDENTIAL_KINDS },
          before: { enum: ['own', 'inherited', 'none'] },
          after: { enum: ['own', 'inherited', 'none'] },
        },
      },
    },
  },
} as const;

export const cloneResultSchema = {
  $id: 'ms:cloneResult',
  type: 'object',
  additionalProperties: false,
  required: ['object', 'clonedCount', 'droppedCredentialKinds', 'settingsChanged'],
  properties: {
    object: { $ref: 'ms:objectDetail' },
    clonedCount: {
      type: 'object',
      additionalProperties: false,
      required: ['group', 'device', 'sensor', 'channel', 'setting', 'total'],
      properties: {
        group: { type: 'integer' },
        device: { type: 'integer' },
        sensor: { type: 'integer' },
        channel: { type: 'integer' },
        setting: { type: 'integer' },
        total: { type: 'integer' },
      },
    },
    // Kinds only, never values: says in the 201 why the clone cannot authenticate yet.
    droppedCredentialKinds: { type: 'array', items: { enum: CREDENTIAL_KINDS } },
    settingsChanged: { type: 'array', items: settingChangeSchema },
  },
} as const;

export const errorSchema = {
  $id: 'ms:error',
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message', 'context', 'details'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        context: { type: 'object', additionalProperties: true },
        details: { type: 'object', additionalProperties: true },
        correlationId: { type: 'string' },
      },
    },
  },
} as const;

export const SHARED_SCHEMAS = [
  settingSourceSchema,
  objectRefSchema,
  resolvedSettingSchema,
  settingViewSchema,
  channelRecordSchema,
  credentialViewSchema,
  objectSummarySchema,
  objectDetailSchema,
  moveResultSchema,
  cloneResultSchema,
  createObjectSchema,
  updateObjectSchema,
  errorSchema,
];
