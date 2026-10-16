import { ACTOR_KINDS } from '../../objects/audit.js';
import { PAUSE_SOURCES, SENSOR_STATES, SENSOR_STATE_CAUSES } from '../../state/tables.js';

/**
 * Where a failed check failed (`P-285`), as the probe named it: the phase, and the plain host it
 * was acting on when it named one. An object, used as `failureField`, which says the `null`: where
 * nothing was named — a success, a probe below protocol 35, a check that threw a plain error —
 * and where the state is not the check's to explain (a limit, a lookup, a pause, an
 * acknowledgement). The message says the same in prose.
 */
export const checkFailureSchema = {
  $id: 'ms:checkFailure',
  type: 'object',
  description:
    'Where a failed check failed, as the probe named it (protocol 35): the phase, and the plain ' +
    'host it was acting on when it named one. The message says the same in prose.',
  additionalProperties: false,
  required: ['phase'],
  properties: {
    phase: {
      type: 'string',
      description:
        'A word, open rather than an enum: a transport’s (`connect`, `authenticate`, ' +
        '`host-key`, `exec`, `walk`, `query`) or the probe’s own (`timeout`, `startup`).',
    },
    target: {
      type: 'string',
      description:
        'A host, an address, or either with a port. Never a URL, a user name or a password.',
    },
  },
} as const;

/**
 * `failure` wherever a reply carries one: the object or `null`, the way `nowInherited` carries a
 * credential view (`oneOf` beside a `$ref`, so the reference says nullable rather than leaving a
 * reader to find the `null` in a description).
 */
export const failureField = {
  oneOf: [{ $ref: 'ms:checkFailure' }, { type: 'null' }],
  description:
    '`null` where nothing was named — a success, an older probe, a check that threw a plain ' +
    'error — and where the state is not the check’s to explain: a limit, a lookup, a pause, an ' +
    'acknowledgement.',
} as const;

export const sensorStateSchema = {
  $id: 'ms:sensorState',
  type: 'object',
  additionalProperties: false,
  required: [
    'sensorId',
    'state',
    'cause',
    'message',
    'failure',
    'since',
    'lastResultAt',
    'consecutiveFailures',
    'pausedBy',
    'acknowledged',
    'acknowledgedBy',
    'simulatedError',
  ],
  properties: {
    sensorId: { type: 'integer' },
    state: { enum: SENSOR_STATES },
    cause: { enum: SENSOR_STATE_CAUSES },
    /** The probe's last message. Whatever context the check carried, never a credential. */
    message: { type: 'string' },
    /** Where the check the message speaks for failed (`P-285`), beside it and by its rule. */
    failure: failureField,
    since: { type: 'string' },
    lastResultAt: { type: ['string', 'null'] },
    consecutiveFailures: { type: 'integer' },
    /**
     * Every pause source currently holding this sensor, not just the one being reported.
     *
     * An array because the four are a set, not a chain (`docs/state-machine.md` §3): a UI that
     * offered "resume" against the reported cause alone would leave the sensor paused and look
     * broken. The reported cause is in `cause`, and it is the first of these.
     */
    pausedBy: { type: 'array', items: { enum: PAUSE_SOURCES } },
    acknowledged: { type: 'boolean' },
    acknowledgedUntil: { type: ['string', 'null'] },
    /** Who acknowledged it (`M-13`). No secret can occupy either field. */
    acknowledgedBy: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['kind', 'label'],
      properties: { kind: { enum: ACTOR_KINDS }, label: { type: ['string', 'null'] } },
    },
    simulatedError: { type: 'boolean' },
  },
} as const;

export const STATE_SCHEMAS = [checkFailureSchema, sensorStateSchema];
