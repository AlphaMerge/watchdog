/**
 * A schedule on the wire (`M-09`).
 *
 * Both forms come back on every read, whichever one authored it: the text periods for the
 * operator who thinks in `fr:19:00-mo:06:00`, the grid for the one who thinks in shaded cells,
 * and `gridIsExact` so a UI can say that switching editors will round rather than letting
 * somebody find out by saving.
 */
export const scheduleSchema = {
  $id: 'ms:schedule',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'name',
    'description',
    'polarity',
    'authoredAs',
    'timezone',
    'effectiveTimezone',
    'periods',
    'grid',
    'gridIsExact',
    'builtIn',
    'active',
    'nextChangeAt',
    'usedBy',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    description: { type: 'string' },
    /** What the periods mean: the times monitoring runs, or the times it is suspended. */
    polarity: { enum: ['active', 'inactive'] },
    /** Which editor wrote it last. A hint for the UI; nothing evaluates it. */
    authoredAs: { enum: ['grid', 'periods'] },
    timezone: { type: ['string', 'null'] },
    effectiveTimezone: { type: 'string' },
    periods: { type: 'string' },
    grid: {
      type: 'array',
      items: { type: 'array', items: { type: 'boolean' } },
    },
    gridIsExact: { type: 'boolean' },
    builtIn: { type: 'boolean' },
    /** Whether it is monitoring at the moment the request was served. */
    active: { type: 'boolean' },
    nextChangeAt: { type: ['string', 'null'], format: 'date-time' },
    usedBy: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const scheduleInputSchema = {
  $id: 'ms:scheduleInput',
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 500 },
    polarity: { enum: ['active', 'inactive'], default: 'active' },
    /** IANA name, or null for the zone the core runs in. */
    timezone: { type: ['string', 'null'], maxLength: 80 },
    periods: { type: 'string', maxLength: 4000 },
    grid: {
      type: 'array',
      minItems: 7,
      maxItems: 7,
      items: { type: 'array', minItems: 24, maxItems: 24, items: { type: 'boolean' } },
    },
  },
} as const;

export const SCHEDULE_SCHEMAS = [scheduleSchema, scheduleInputSchema];
