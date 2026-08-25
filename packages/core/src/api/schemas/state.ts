import { PAUSE_SOURCES, SENSOR_STATES, SENSOR_STATE_CAUSES } from '../../state/tables.js';

export const sensorStateSchema = {
  $id: 'ms:sensorState',
  type: 'object',
  additionalProperties: false,
  required: [
    'sensorId',
    'state',
    'cause',
    'message',
    'since',
    'lastResultAt',
    'consecutiveFailures',
    'pausedBy',
    'acknowledged',
    'simulatedError',
  ],
  properties: {
    sensorId: { type: 'integer' },
    state: { enum: SENSOR_STATES },
    cause: { enum: SENSOR_STATE_CAUSES },
    /** The probe's last message. Whatever context the check carried, never a credential. */
    message: { type: 'string' },
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
    simulatedError: { type: 'boolean' },
  },
} as const;

export const STATE_SCHEMAS = [sensorStateSchema];
