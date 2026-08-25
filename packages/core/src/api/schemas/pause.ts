import { PAUSE_PRESET_MINUTES, MAX_PAUSE_MINUTES } from '../../state/pause.js';

/**
 * Why an object is paused (`M-08`).
 *
 * `resumable` is the field a bare boolean cannot express: a sensor under a paused device is
 * paused, and offering a resume button on it would be offering something that does not work.
 */
export const pauseViewSchema = {
  $id: 'ms:pauseView',
  type: 'object',
  additionalProperties: false,
  required: [
    'objectId',
    'paused',
    'resumable',
    'source',
    'pausedAt',
    'pausedUntil',
    'message',
    'inheritedFrom',
    'schedule',
  ],
  properties: {
    objectId: { type: 'integer' },
    paused: { type: 'boolean' },
    resumable: { type: 'boolean' },
    source: { enum: ['manual', 'parent', 'schedule', null] },
    pausedAt: { type: ['string', 'null'] },
    /** `null` while paused indefinitely — until a person says otherwise. */
    pausedUntil: { type: ['string', 'null'] },
    message: { type: 'string' },
    /** Who did it. No secret can occupy either field. */
    actor: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['kind', 'label'],
      properties: { kind: { type: 'string' }, label: { type: ['string', 'null'] } },
    },
    inheritedFrom: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['objectId', 'name'],
      properties: { objectId: { type: 'integer' }, name: { type: 'string' } },
    },
    /** The schedule in effect here (`M-09`), whether it is monitoring, and where it is set. */
    schedule: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['id', 'name', 'active', 'nextChangeAt', 'definedOn'],
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        active: { type: 'boolean' },
        nextChangeAt: { type: ['string', 'null'] },
        definedOn: { type: 'integer' },
      },
    },
  },
} as const;

/**
 * How long to pause for.
 *
 * At most one of `minutes` and `until`; neither is indefinite. Any duration is accepted, not
 * only the presets — a preset list is a convenience for the common case, and an operator who
 * needs 45 minutes should not have to pick an hour and remember to come back.
 */
export const pauseRequestSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    minutes: { type: 'integer', minimum: 1, maximum: MAX_PAUSE_MINUTES },
    until: { type: 'string', minLength: 1, maxLength: 64 },
    message: { type: 'string', maxLength: 500 },
  },
  not: { required: ['minutes', 'until'] },
} as const;

export const PAUSE_PRESETS = PAUSE_PRESET_MINUTES;
export const PAUSE_SCHEMAS = [pauseViewSchema];
