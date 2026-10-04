/**
 * Response schemas are the load-bearing credential defence.
 *
 * Fastify serialises 2xx bodies with `fast-json-stringify` against the declared schema, so a
 * property absent from the schema is dropped even if a repository leaks it. There is no
 * `secret` property anywhere in this file, and a test walks every schema to keep it that way.
 */

// Imported rather than repeated: migration 003 defines the enum, `state/tables.ts` mirrors it
// under test, and a third copy here would be the one that drifts.
import { SENSOR_STATES } from '../../state/tables.js';

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

/** `ms:objectRef` in an answer about another object, its name null where unseen (`A-16`). */
const seenObjectRefSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'name'],
  properties: {
    id: { type: 'integer' },
    kind: { enum: OBJECT_KINDS },
    name: { type: ['string', 'null'] },
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
    state: { enum: SENSOR_STATES },
    paused: { type: 'boolean' },
    effective: { type: 'object', additionalProperties: { $ref: 'ms:resolvedSetting' } },
    // `include=path` on the listing (`P-214`). Declared, because `additionalProperties: false`
    // makes the serialiser drop whatever is not — silently, with a 200.
    path: {
      type: 'array',
      items: { $ref: 'ms:objectRef' },
      description: 'Ancestors, root first, excluding the object. Only when asked for.',
    },
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
    'inheritsTriggers',
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
    /** False fences this object off from its ancestors' notification triggers (`N-16`). */
    inheritsTriggers: { type: 'boolean' },
    version: { type: 'integer' },
    childCount: { type: 'integer' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    // device
    host: { type: 'string' },
    ipVersion: { enum: ['auto', 'v4', 'v6'] },
    // probe
    gid: { type: ['string', 'null'] },
    // sensor
    sensorType: { type: 'string' },
    /**
     * Never contains a parameter the type marked `writeOnly` — `ObjectService` strips them
     * before a detail reaches a route. `fast-json-stringify` cannot help here: `params` is
     * free-form by design, so the serialiser has no list of keys to omit.
     */
    params: { type: 'object', additionalProperties: true },
    redactedParams: { type: 'array', items: { type: 'string' } },
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
  required: ['key', 'description', 'schema', 'effective', 'inherited', 'own'],
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
    /**
     * What this setting would resolve to if the local override were discarded — the parent's
     * effective value, or the registry default at the root.
     *
     * Equal to `effective` whenever there is no override, and *different* from it exactly when
     * there is. `U-09`'s override toggle needs both: a control that only knew the effective
     * value could show what reverting does only by doing it.
     */
    inherited: {
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

/**
 * A channel's thresholds (`M-04`).
 *
 * Strict and fully required on the way out, because the repository normalises what is in the
 * jsonb column before anything reads it. `additionalProperties: false` is doing real work here:
 * the column is free-form, and this is what keeps a hand-edited row from serialising whatever
 * it happens to contain into an API response.
 */
export const channelLimitsSchema = {
  $id: 'ms:channelLimits',
  type: 'object',
  additionalProperties: false,
  required: [
    'enabled',
    'upperError',
    'upperWarning',
    'lowerWarning',
    'lowerError',
    'errorMessage',
    'warningMessage',
  ],
  properties: {
    enabled: { type: 'boolean' },
    upperError: { type: ['number', 'null'] },
    upperWarning: { type: ['number', 'null'] },
    lowerWarning: { type: ['number', 'null'] },
    lowerError: { type: ['number', 'null'] },
    errorMessage: { type: 'string' },
    warningMessage: { type: 'string' },
  },
} as const;

/**
 * The body of a limits PATCH.
 *
 * Every field optional, and every threshold nullable: absent leaves a limit alone, `null`
 * clears it. Non-finite numbers are refused here rather than stored — a NaN threshold compares
 * false against everything, so it would read as "configured" and behave as "off".
 */
export const channelLimitsPatchSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    enabled: { type: 'boolean' },
    upperError: { type: ['number', 'null'] },
    upperWarning: { type: ['number', 'null'] },
    lowerWarning: { type: ['number', 'null'] },
    lowerError: { type: ['number', 'null'] },
    errorMessage: { type: 'string', maxLength: 500 },
    warningMessage: { type: 'string', maxLength: 500 },
  },
} as const;

/**
 * The body of a processing PATCH (`M-07`).
 *
 * The factors are strings because the column is `numeric` and the read serves strings; taking a
 * number here and a string there would make a round trip lossy in one direction only. Every
 * field is optional, and `null` clears a spike bound or returns the decimals to automatic.
 */
export const channelProcessingPatchSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    // A decimal string. `pattern` rather than `type: number`, so 0.001 survives the round trip
    // exactly as the operator typed it.
    scaleMul: { type: 'string', pattern: '^-?[0-9]+(\\.[0-9]+)?$', maxLength: 40 },
    scaleDiv: { type: 'string', pattern: '^-?[0-9]+(\\.[0-9]+)?$', maxLength: 40 },
    decimals: { type: ['integer', 'null'], minimum: 0, maximum: 10 },
    spikeMin: { type: ['number', 'null'] },
    spikeMax: { type: ['number', 'null'] },
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
    'lookupId',
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
    limits: { $ref: 'ms:channelLimits' },
    spikeMin: { type: ['number', 'null'] },
    spikeMax: { type: ['number', 'null'] },
    showInGraph: { type: 'boolean' },
    showInTable: { type: 'boolean' },
    lookupId: { type: ['string', 'null'] },
  },
} as const;

/** No secret, no key id, no length, no hash. There is no field a secret could occupy. */
export const credentialViewSchema = {
  $id: 'ms:credentialView',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'publicParams', 'source', 'updatedAt', 'bounded'],
  properties: {
    kind: { enum: CREDENTIAL_KINDS },
    publicParams: { type: 'object', additionalProperties: true },
    source: { $ref: 'ms:settingSource' },
    updatedAt: { type: 'string' },
    bounded: {
      type: 'boolean',
      description:
        "Whether `allowedTargets`, or an SSH set's `hostKeys` with strict checking, bound where " +
        'the set goes (`A-41b`). False means `write` on the object it is stored on is trust ' +
        'with it.',
    },
    secretsSet: {
      type: 'array',
      items: { type: 'string' },
      description:
        'The names of the secret fields that hold a value, never the values (`U-21`). Only on a ' +
        'set stored on the object asked about, for its form to offer keep, replace and clear.',
    },
  },
} as const;

/** One reason's part of a credential write's four counts (`A-59`). */
const credentialWriteCounts = (which: string) =>
  ({
    type: 'object',
    additionalProperties: false,
    required: ['withholds', 'withheldBefore', 'newlyWithheld', 'noLongerWithheld'],
    description: which,
    properties: {
      withholds: { type: 'integer', minimum: 0 },
      withheldBefore: { type: 'integer', minimum: 0 },
      newlyWithheld: { type: 'integer', minimum: 0 },
      noLongerWithheld: { type: 'integer', minimum: 0 },
    },
  }) as const;

/**
 * What storing a set answers (`A-41b`): the set as a read shows it, and what the write did to where
 * it goes. Still no field a secret could occupy — `secretsCleared` is names.
 */
export const credentialWriteSchema = {
  $id: 'ms:credentialWrite',
  type: 'object',
  additionalProperties: false,
  required: [
    ...credentialViewSchema.required,
    'withholds',
    'withheldBefore',
    'newlyWithheld',
    'noLongerWithheld',
    'byReason',
    'secretsCleared',
  ],
  properties: {
    ...credentialViewSchema.properties,
    withholds: {
      type: 'integer',
      minimum: 0,
      description:
        'How many sensors beneath this set its allowed targets keep it from now, of those the ' +
        "caller can see: a sensor whose device's address is outside them, or whose device is " +
        'entered by name where the targets are addresses and the sensor’s type cannot be held ' +
        'to an address its probe checked. They are not sent the set and read Unknown. Zero for ' +
        'a set with no targets.',
    },
    withheldBefore: {
      type: 'integer',
      minimum: 0,
      description:
        'Of the sensors this set reaches now and the caller can see, how many a set’s targets ' +
        'kept it from before this write (`A-55`): this set’s as it was, or an ancestor’s where ' +
        'this write stores the first set of the kind here. `withholds` is this, plus ' +
        '`newlyWithheld`, less `noLongerWithheld`.',
    },
    newlyWithheld: {
      type: 'integer',
      minimum: 0,
      description:
        'How many sensors this write puts outside (`A-55`): kept from the set after it and not ' +
        'before, of those the caller can see. What a narrowing takes to Unknown.',
    },
    noLongerWithheld: {
      type: 'integer',
      minimum: 0,
      description:
        'How many sensors this write brings back inside (`A-55`): kept from a set before it ' +
        'and sent this one after, of those the caller can see.',
    },
    byReason: {
      type: 'object',
      additionalProperties: false,
      required: ['outside', 'unpinnable'],
      description:
        'The four counts above for each of the two reasons a sensor is outside (`A-59`), over ' +
        'the same sensors the caller can see, so each count above is the sum of its two ' +
        'parts. A sensor outside after the write is counted for the reason that holds after ' +
        'it, and one outside before for the reason that held then, so a sensor that stays ' +
        'outside for another reason moves between the two without being newly outside.',
      properties: {
        outside: credentialWriteCounts(
          'Sensors on a device whose address, or whose name, the allowed targets do not cover.',
        ),
        unpinnable: credentialWriteCounts(
          'Sensors on a device entered by name, where the targets that could cover it are ' +
            'addresses and the sensor’s type cannot be held to an address its probe checked: ' +
            'the set is not sent whatever the name resolves to.',
        ),
      },
    },
    secretsCleared: {
      type: 'array',
      items: { type: 'string' },
      description:
        'The secrets this write cleared because it widened where the set may go and did not ' +
        'send them again.',
    },
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
    gid: {
      type: ['string', 'null'],
      minLength: 1,
      maxLength: 128,
      description:
        'Binds this probe branch to a connected probe. R-01 replaces setting it by hand with ' +
        'an enrolment flow; until then it is how a probe is told which subtree it owns.',
    },
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
    // Only a probe branch can be claimed by a probe. Rejecting it here means no handler has to.
    {
      if: { properties: { kind: { enum: ['group', 'device', 'sensor'] } }, required: ['kind'] },
      then: { not: { required: ['gid'] } },
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
 * One node of a subtree created in a single request (`P-19`).
 *
 * The create schema with `parentId` swapped for a `parentRef`, and every conditional rule kept
 * as it stands: a bulk create that validated less than the single one would be a second, laxer
 * way in, which is how the strict path becomes the one nobody uses.
 */
export const treeNodeSchema = {
  $id: 'ms:treeNode',
  type: 'object',
  required: ['kind', 'name'],
  additionalProperties: false,
  properties: {
    kind: { enum: ['probe', 'group', 'device', 'sensor'] },
    ref: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: 'A handle for this node, unique in the request, so later nodes can hang off it.',
    },
    parentRef: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: 'The `ref` of this node’s parent. Absent means the request’s own `parentId`.',
    },
    ...objectFields,
    host: { type: 'string', minLength: 1, maxLength: 255 },
    ipVersion: { enum: ['auto', 'v4', 'v6'] },
    sensorType: { type: 'string', pattern: '^[a-z0-9]+(\\.[a-z0-9-]+)+$', maxLength: 100 },
    params: { type: 'object', additionalProperties: true },
    gid: { type: ['string', 'null'], minLength: 1, maxLength: 128 },
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
    {
      if: { properties: { kind: { enum: ['probe', 'group'] } }, required: ['kind'] },
      then: { not: { anyOf: [{ required: ['host'] }, { required: ['sensorType'] }] } },
    },
    {
      if: { properties: { kind: { enum: ['group', 'device', 'sensor'] } }, required: ['kind'] },
      then: { not: { required: ['gid'] } },
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

export const createTreeSchema = {
  $id: 'ms:createTree',
  type: 'object',
  required: ['parentId', 'nodes'],
  additionalProperties: false,
  properties: {
    parentId: { type: 'integer', minimum: 1 },
    nodes: {
      type: 'array',
      minItems: 1,
      // The v1 target exactly: five thousand objects is the largest tree `PLAN.md` states a
      // criterion for, so one request can build a whole v1 installation and no more.
      maxItems: 5_000,
      items: { $ref: 'ms:treeNode' },
    },
  },
} as const;

export const createTreeResultSchema = {
  $id: 'ms:createTreeResult',
  type: 'object',
  required: ['count', 'objects'],
  additionalProperties: false,
  properties: {
    count: { type: 'integer' },
    /**
     * Ids in the order the nodes were sent, so a caller matches by position without a `ref`.
     *
     * Ids rather than details: five thousand full objects is megabytes of response for something
     * the caller already knows, and the one thing they cannot know is what the ids came out as.
     */
    objects: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'kind'],
        additionalProperties: false,
        properties: {
          ref: { type: 'string' },
          id: { type: 'integer' },
          kind: { enum: OBJECT_KINDS },
        },
      },
    },
  },
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
    // Patch-only, and deliberately not on the create schema: nobody creates a device already
    // knowing it should notify nobody. It is a decision somebody makes about a subtree that
    // already exists.
    inheritsTriggers: { type: 'boolean' },
    host: { type: 'string', minLength: 1, maxLength: 255 },
    ipVersion: { enum: ['auto', 'v4', 'v6'] },
    params: { type: 'object', additionalProperties: true },
    // Null releases the claim, which is how a branch is handed to a replacement installation.
    gid: { type: ['string', 'null'], minLength: 1, maxLength: 128 },
  },
  allOf: [
    {
      if: { properties: { kind: { enum: ['root', 'probe', 'group'] } }, required: ['kind'] },
      then: { not: { anyOf: [{ required: ['host'] }, { required: ['params'] }] } },
    },
    {
      if: {
        properties: { kind: { enum: ['root', 'group', 'device', 'sensor'] } },
        required: ['kind'],
      },
      then: { not: { required: ['gid'] } },
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
          // A probe's name is null for a caller who cannot see it (`A-16`).
          properties: {
            from: { oneOf: [{ type: 'null' }, seenObjectRefSchema] },
            to: { oneOf: [{ type: 'null' }, seenObjectRefSchema] },
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
  required: [
    'object',
    'clonedCount',
    'grantsNotCarried',
    'droppedCredentialKinds',
    'settingsChanged',
  ],
  properties: {
    object: { $ref: 'ms:objectDetail' },
    grantsNotCarried: {
      type: 'integer',
      minimum: 0,
      description:
        'How many grants on what was copied the copy did not carry, because only an ' +
        'administrator may grant (`A-76`). Anybody else’s copy carries each `none`, and each ' +
        '`read` that narrows what its group holds where the copy landed, and no other group’s ' +
        '`read`, `write` or `full`. Each left behind is in the copy’s history as ' +
        '`grant.notCarried`. Always 0 for an administrator, whose copy carries every grant.',
    },
    clonedCount: {
      type: 'object',
      additionalProperties: false,
      required: ['group', 'device', 'sensor', 'channel', 'setting', 'trigger', 'total'],
      properties: {
        group: { type: 'integer' },
        device: { type: 'integer' },
        sensor: { type: 'integer' },
        channel: { type: 'integer' },
        setting: { type: 'integer' },
        trigger: {
          type: 'integer',
          description:
            'Notification triggers copied with the objects that own them (`P-141`). The clone ' +
            'already carried the trigger *fence* and none of the triggers behind it, so a ' +
            'cloned object with the fence up notified nobody and looked identical to one that ' +
            'did.',
        },
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
  channelLimitsSchema,
  channelRecordSchema,
  credentialViewSchema,
  credentialWriteSchema,
  objectSummarySchema,
  objectDetailSchema,
  moveResultSchema,
  cloneResultSchema,
  createObjectSchema,
  treeNodeSchema,
  createTreeSchema,
  createTreeResultSchema,
  updateObjectSchema,
  errorSchema,
];
