/**
 * The historic-data response (S-08).
 *
 * Like every response schema here this is also the serialisation filter — a property absent
 * from it is dropped from the body — so it has to describe the whole shape, including the
 * nulls. Those nulls are the point: `avg`, `min`, `max` and `count` are dense arrays aligned to
 * `buckets`, and a gap is a `null` rather than a missing entry or a zero.
 */

const nullableNumbers = {
  type: 'array',
  items: { type: ['number', 'null'] },
} as const;

export const queryAdjustmentSchema = {
  $id: 'ms:queryAdjustment',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'reason', 'requestedDays', 'effectiveDays'],
      properties: {
        kind: { const: 'range-shortened' },
        reason: { type: 'string' },
        requestedDays: { type: 'number' },
        effectiveDays: { type: 'number' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'reason', 'requestedSeconds', 'effectiveSeconds'],
      properties: {
        kind: { const: 'resolution-coarsened' },
        reason: { type: 'string' },
        requestedSeconds: { type: 'integer' },
        effectiveSeconds: { type: 'integer' },
      },
    },
  ],
} as const;

export const historyChannelSchema = {
  $id: 'ms:historyChannel',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'key', 'name', 'unit', 'avg', 'min', 'max', 'count'],
  properties: {
    id: { type: 'integer' },
    key: { type: 'string' },
    name: { type: 'string' },
    unit: { type: 'string' },
    avg: nullableNumbers,
    min: nullableNumbers,
    max: nullableNumbers,
    count: nullableNumbers,
  },
} as const;

export const sensorHistorySchema = {
  $id: 'ms:sensorHistory',
  type: 'object',
  additionalProperties: false,
  required: [
    'sensorId',
    'from',
    'to',
    'resolutionSeconds',
    'bucketCount',
    'source',
    'segments',
    'adjustments',
    'buckets',
    'channels',
  ],
  properties: {
    sensorId: { type: 'integer' },
    from: { type: 'string' },
    to: { type: 'string' },
    resolutionSeconds: { type: 'integer' },
    bucketCount: { type: 'integer' },
    source: { type: 'string' },
    segments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['table', 'from', 'to'],
        properties: {
          table: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
        },
      },
    },
    adjustments: { type: 'array', items: { $ref: 'ms:queryAdjustment' } },
    buckets: { type: 'array', items: { type: 'string' } },
    channels: { type: 'array', items: { $ref: 'ms:historyChannel' } },
  },
} as const;

/**
 * A channel's current reading (`U-04`).
 *
 * `value` and `at` are nullable together, and the null is load-bearing: it is how the API says
 * "nothing recent", as distinct from a reading of zero. Anything that flattened one into the
 * other here would undo the rule the whole storage layer is built around.
 */
export const channelValueSchema = {
  $id: 'ms:channelValue',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'key', 'name', 'unit', 'value', 'at'],
  properties: {
    id: { type: 'integer' },
    key: { type: 'string' },
    name: { type: 'string' },
    unit: { type: 'string' },
    value: { type: ['number', 'null'] },
    at: { type: ['string', 'null'] },
  },
} as const;

export const sensorValuesSchema = {
  $id: 'ms:sensorValues',
  type: 'object',
  additionalProperties: false,
  required: ['sensorId', 'readAt', 'notBefore', 'intervalSeconds', 'channels'],
  properties: {
    sensorId: { type: 'integer' },
    readAt: { type: 'string' },
    notBefore: { type: 'string' },
    intervalSeconds: { type: 'integer' },
    channels: { type: 'array', items: { $ref: 'ms:channelValue' } },
  },
} as const;

export const HISTORY_SCHEMAS = [
  queryAdjustmentSchema,
  historyChannelSchema,
  sensorHistorySchema,
  channelValueSchema,
  sensorValuesSchema,
];
