import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { SNMP_SECRET_DESTINATIONS, snmpParamsSchema } from '../support/snmp/schema.js';

/**
 * One arbitrary numeric OID (`T-03`).
 *
 * **The type that makes the long tail somebody else's problem.** `CAPABILITIES.MD §15` says the
 * full 250-sensor catalogue is out of scope because the long tail is vendor-MIB wrappers, and
 * this plus a device template covers it generically: a UPS battery charge, a chassis temperature,
 * a queue depth — anything an agent exposes as a number is a sensor without anybody writing a
 * type for it.
 *
 * **Gauge or counter is asked rather than guessed.** The two need different arithmetic — a gauge
 * is the value, a counter is a rate the core derives (`T-02`) — and the OID alone does not say
 * which the operator wants. Guessing from the varbind type is tempting and wrong in both
 * directions: a Counter32 an operator genuinely wants graphed as a total would be turned into a
 * rate, and an Integer that happens to be monotonic would not. The device *is* consulted, but to
 * check the answer rather than to make it: a mismatch between what was asked for and what came
 * back goes in the message, which is where a puzzled operator looks.
 */
const COUNTER_TYPES = new Set(['Counter', 'Counter64']);

export const snmpCustom: SensorType = {
  id: 'snmp.custom',
  category: 'SNMP',
  costHint: 'medium',
  secretDestinations: SNMP_SECRET_DESTINATIONS,
  credentialKinds: ['snmp'],
  pinnedKinds: ['snmp'],

  paramsSchema: snmpParamsSchema(
    {
      oid: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        pattern: '^\\.?[0-9]+(\\.[0-9]+)*$',
        'x-patternMessage':
          'must be a numeric OID, digits separated by dots, such as 1.3.6.1.2.1.1.3.0',
        title: 'OID',
        description:
          'The object to read, in numeric form — for example 1.3.6.1.2.1.25.3.3.1.2.1. Include ' +
          'the instance: a scalar ends in .0, and a table column needs its row index. Reading ' +
          'the column without one returns "no such object", because the column is not itself an ' +
          'object.',
      },
      mode: {
        enum: ['gauge', 'counter'],
        default: 'gauge',
        // The edit form shows it read-only on an existing sensor; the core refuses the change
        // either way (`P-303`, `U-34`).
        'x-createOnly': true,
        title: 'Reading type',
        description:
          'A gauge is stored as it is read — a temperature, a percentage, a queue depth. A ' +
          'counter only ever goes up and is stored as a *rate*: the difference between two ' +
          'readings over the time between them, which is what an Interface or Errors counter ' +
          'is for. Choosing counter for a gauge produces nonsense, so the sensor says when the ' +
          'device disagrees with this setting. It cannot be changed once the sensor exists, ' +
          'since its stored history would mean two things: add a new sensor to read the other way.',
      },
      channelName: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        default: 'Value',
        title: 'Channel name',
        description: 'What to call the reading — "Battery charge", "Inlet temperature".',
      },
      unit: {
        type: 'string',
        maxLength: 50,
        default: '',
        title: 'Unit',
        description:
          'Shown on the axis and beside the value. For a counter this is the unit *per second*, ' +
          'since that is what gets stored: enter "octets" and the channel reads "octets/s".',
      },
    },
    ['oid'],
  ),

  // Only `value`, gauge or counter: a channel a later build drops is retired (`P-320`).
  declaresEveryChannel: true,

  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
    const name = typeof params['channelName'] === 'string' ? params['channelName'] : 'Value';
    const unit = typeof params['unit'] === 'string' ? params['unit'] : '';
    const counting = params['mode'] === 'counter';
    return [
      {
        key: 'value',
        name,
        unit: counting && unit !== '' ? `${unit}/s` : unit,
        isPrimary: true,
        // 64 declared, and the reading corrects it — the device may return a Counter32
        // (`T-02`). A 32-bit wrap read as a 64-bit counter looks exactly like a reset.
        ...(counting ? { counter: { bits: 64 as const } } : {}),
      },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const { snmpCheck, numberOf, stringOf, isException, normaliseOid } =
      await import('../support/snmp/index.js');

    const asked = context.params['oid'];
    const oid = normaliseOid(typeof asked === 'string' ? asked : '');
    const counting = context.params['mode'] === 'counter';

    return snmpCheck(context, async (session, signal) => {
      const [varbind] = await session.get([oid], signal);
      if (varbind === undefined || isException(varbind)) {
        throw new Error(
          `${context.target.host} has no object at ${oid} — it answered "no such object", ` +
            'which is also what an agent says about a table column asked for without a row index',
        );
      }

      const notes: string[] = [];
      const isCounter = COUNTER_TYPES.has(varbind.type);
      if (counting && !isCounter) {
        // Not a failure: an operator may know their vendor exposes a counter as an Integer. But
        // it is the single most likely reason a graph looks wrong, so it is said out loud.
        notes.push(
          `this sensor treats ${oid} as a counter, and the device returned a ${varbind.type}`,
        );
      }
      if (!counting && isCounter) {
        notes.push(
          `${oid} is a ${varbind.type}, which only ever goes up — set the reading type to ` +
            'counter to graph it as a rate',
        );
      }

      if (counting) {
        // Exact text, not a number: a Counter64 past 2^53 loses its low bits as a double, and
        // the core divides the difference between two of these (`T-02`).
        const exact = stringOf(varbind);
        if (exact === null || !/^\d+$/.test(exact)) {
          throw new Error(
            `${oid} returned ${varbind.type} "${String(varbind.value)}", which is not a counter`,
          );
        }
        return {
          channels: [
            {
              key: 'value',
              value: Number(exact),
              counter: exact,
              counterBits: varbind.type === 'Counter' ? (32 as const) : (64 as const),
            },
          ],
          message: [`${oid} = ${exact} (${varbind.type})`, ...notes].join('; '),
        };
      }

      const value = numberOf(varbind);
      if (value === null) {
        throw new Error(
          `${oid} returned ${varbind.type} "${String(varbind.value)}", which is not a number — ` +
            'use SNMP Custom String for a text object',
        );
      }
      return {
        channels: [{ key: 'value', value }],
        message: [`${oid} = ${String(value)} (${varbind.type})`, ...notes].join('; '),
      };
    });
  },
};
