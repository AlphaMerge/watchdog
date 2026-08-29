/**
 * What an on-demand check answers with (`R-09`).
 *
 * **A failing check is a 200.** The question is "what does this sensor say right now", and
 * "it says the device refused the credential" is the answer — an error status would make the
 * client's failure path handle the one case an operator pressed the button to see. The response
 * carries the check's own outcome instead, and a 5xx is reserved for the *query* failing: no
 * probe, a probe too old, a deadline, a refusal.
 */
const checkChannelSchema = {
  $id: 'ms:checkChannel',
  type: 'object',
  additionalProperties: false,
  required: ['key', 'value'],
  properties: {
    key: { type: 'string' },
    value: { type: 'number' },
    name: { type: 'string' },
    unit: { type: 'string' },
    // The exact counter as the probe read it (`T-02`), passed through rather than converted:
    // this endpoint stores nothing, so nothing has turned it into a rate yet, and rounding it
    // into a double here would be the one number on the page that is wrong.
    counter: { type: 'string' },
    counterBits: { type: 'integer' },
  },
} as const;

export const checkResultSchema = {
  $id: 'ms:checkResult',
  type: 'object',
  additionalProperties: false,
  required: ['sensorId', 'at', 'outcome', 'message', 'durationMs', 'channels', 'stored'],
  properties: {
    sensorId: { type: 'integer' },
    at: { type: 'string' },
    outcome: { type: 'string', enum: ['ok', 'error'] },
    message: { type: 'string' },
    durationMs: { type: 'number' },
    channels: { type: 'array', items: { $ref: 'ms:checkChannel' } },
    /**
     * Always false, and said rather than assumed.
     *
     * A reading taken outside the schedule is not history: storing it would put a sample on the
     * graph at a time nothing was due, and an operator pressing the button ten times would draw
     * ten spikes into a channel whose interval is a minute. Saying so on every response is
     * cheaper than a client guessing, and it is the field that keeps the guess from changing
     * between releases.
     */
    stored: { type: 'boolean' },
  },
} as const;

export const QUERY_SCHEMAS = [checkChannelSchema, checkResultSchema];
