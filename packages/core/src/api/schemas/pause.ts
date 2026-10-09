import { PAUSE_PRESET_MINUTES, MAX_PAUSE_MINUTES } from '../../state/pause.js';
import { ACK_PRESET_MINUTES, MAX_ACK_MINUTES } from '../../state/acknowledgement.js';
import { ACTOR_KINDS } from '../../objects/audit.js';
import { SENSOR_STATES } from '../../state/tables.js';

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
    'pending',
    'resumable',
    'source',
    'pausedAt',
    'startsAt',
    'pausedUntil',
    'message',
    'inheritedFrom',
    'schedule',
    'dependency',
  ],
  properties: {
    objectId: { type: 'integer' },
    paused: { type: 'boolean' },
    /** A maintenance window that is scheduled and has not begun (`M-10`). */
    pending: { type: 'boolean' },
    resumable: { type: 'boolean' },
    source: { enum: ['manual', 'parent', 'schedule', 'dependency', null] },
    pausedAt: { type: ['string', 'null'] },
    /** When it takes effect. Later than `pausedAt` only for a maintenance window. */
    startsAt: { type: ['string', 'null'] },
    /** `null` while paused indefinitely — until a person says otherwise. */
    pausedUntil: { type: ['string', 'null'] },
    message: { type: 'string' },
    /** Who did it. No secret can occupy either field. */
    actor: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['kind', 'label'],
      properties: { kind: { enum: ACTOR_KINDS }, label: { type: ['string', 'null'] } },
    },
    inheritedFrom: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['objectId', 'name'],
      // Null when the caller cannot see the object the pause comes from (`A-12`).
      properties: { objectId: { type: 'integer' }, name: { type: ['string', 'null'] } },
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
    /** The master this object depends on (`M-11`), and whether it is holding it right now. */
    dependency: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['masterId', 'masterName', 'masterState', 'holding', 'releasesAt', 'definedOn'],
      properties: {
        masterId: { type: 'integer' },
        // Both null when the caller cannot see the master (`A-12`); `holding` is this object's.
        masterName: { type: ['string', 'null'] },
        // `sensor_runtime.state`, a `sensor_state_kind` (`P-351`).
        masterState: { enum: [...SENSOR_STATES, null] },
        holding: { type: 'boolean' },
        releasesAt: { type: ['string', 'null'] },
        definedOn: { type: 'integer' },
      },
    },
  },
} as const;

/**
 * How long to pause for, and — for a maintenance window — from when.
 *
 * At most one of `minutes` and `until`; neither is indefinite. Any duration is accepted, not
 * only the presets — a preset list is a convenience for the common case, and an operator who
 * needs 45 minutes should not have to pick an hour and remember to come back.
 *
 * `from` with `until` is a maintenance window (`M-10`): the same pause, scheduled rather than
 * immediate. It is the same endpoint because it is the same fact — one object, the same
 * cascade, the same resume — and a second endpoint would be a second set of rules to keep in
 * step with the first.
 */
export const pauseRequestSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    minutes: { type: 'integer', minimum: 1, maximum: MAX_PAUSE_MINUTES },
    until: { type: 'string', minLength: 1, maxLength: 64 },
    /** Start of a maintenance window. Requires `until`: an outage with no end is not a window. */
    from: { type: 'string', minLength: 1, maxLength: 64 },
    message: { type: 'string', maxLength: 500 },
  },
  // A duration and a moment are two answers to one question, and a window's start needs an end
  // — an outage with no end is not a window, it is a pause somebody will forget about.
  // Each name a `not` requires is declared `true`, which constrains nothing, because strict mode
  // refuses a `required` its own schema does not declare (`P-383`).
  allOf: [
    { not: { properties: { minutes: true, until: true }, required: ['minutes', 'until'] } },
    { not: { properties: { minutes: true, from: true }, required: ['minutes', 'from'] } },
  ],
  dependencies: { from: ['until'] },
} as const;

/**
 * How long to acknowledge for (`M-13`).
 *
 * The same shape as a pause request minus the window: an acknowledgement is about an outage that
 * is happening now, so there is nothing to schedule.
 */
export const acknowledgeRequestSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    minutes: { type: 'integer', minimum: 1, maximum: MAX_ACK_MINUTES },
    until: { type: 'string', minLength: 1, maxLength: 64 },
    message: { type: 'string', maxLength: 500 },
  },
  not: { properties: { minutes: true, until: true }, required: ['minutes', 'until'] },
} as const;

export const acknowledgementViewSchema = {
  $id: 'ms:acknowledgementView',
  type: 'object',
  additionalProperties: false,
  required: [
    'objectId',
    'acknowledged',
    'refused',
    'skipped',
    'acknowledgedAt',
    'acknowledgedUntil',
    'message',
  ],
  properties: {
    objectId: { type: 'integer' },
    /** The sensors this acted on. Acknowledging a device covers what is Down beneath it. */
    acknowledged: { type: 'array', items: { type: 'integer' } },
    /** Sensors that were not Down, and so will still alarm. */
    refused: { type: 'array', items: { type: 'integer' } },
    /** Sensors beneath it the caller could not acknowledge by name, left as they were. */
    skipped: { type: 'array', items: { type: 'integer' } },
    acknowledgedAt: { type: ['string', 'null'] },
    /** `null` is indefinite — until it recovers, or somebody clears it. */
    acknowledgedUntil: { type: ['string', 'null'] },
    message: { type: 'string' },
  },
} as const;

export const simulatedErrorViewSchema = {
  $id: 'ms:simulatedErrorView',
  type: 'object',
  additionalProperties: false,
  required: ['objectId', 'simulated', 'sensors', 'skipped', 'message'],
  properties: {
    objectId: { type: 'integer' },
    simulated: { type: 'boolean' },
    /** On a container, every sensor beneath it — not only the ones that were Down. */
    sensors: { type: 'array', items: { type: 'integer' } },
    /** Sensors beneath it the caller may not write, left as they were. */
    skipped: { type: 'array', items: { type: 'integer' } },
    message: { type: 'string' },
  },
} as const;

export const PAUSE_PRESETS = PAUSE_PRESET_MINUTES;
export const ACK_PRESETS = ACK_PRESET_MINUTES;
export const PAUSE_SCHEMAS = [pauseViewSchema, acknowledgementViewSchema, simulatedErrorViewSchema];
