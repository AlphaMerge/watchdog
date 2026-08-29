import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';

/**
 * A sensor whose readings come from other sensors' readings (`T-21`).
 *
 * **The only type in the catalogue that is evaluated by the core rather than run on a probe**,
 * and it has to be: its inputs are channel values the core already holds, and asking a probe to
 * compute them would mean shipping other sensors' history out to it. So `evaluatedBy: 'core'`
 * keeps it out of every probe's assignment list, and `execute` here exists only to fail loudly
 * if that ever stops being true.
 *
 * **What it is for.** Questions no single check can answer: total throughput across four
 * uplinks, how many of a cluster's members are up, one channel as a percentage of another on a
 * different device. It also does what PRTG's Sensor Factory is most used for — one sensor to
 * alarm on instead of twelve, which is `CLAUDE.md`'s "one outage, one alarm" bought cheaply.
 *
 * **The channels are declared here rather than discovered**, because each one *is* a formula an
 * operator wrote: there is nothing to discover. The first is the one the sensor is judged by.
 */
export const coreFactory: SensorType = {
  id: 'core.factory',
  category: 'Custom',
  // Arithmetic over rows the core already has. It costs one query, not a network round trip.
  costHint: 'light',
  evaluatedBy: 'core',

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['channels'],
    properties: {
      channels: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        title: 'Channels',
        description:
          'Each row is one channel and one formula. The first is the channel this sensor is ' +
          'judged by.',
        items: {
          // The singular, for `U-12`'s repeating control: the fieldset is named for the
          // parameter and an entry inside it wants this.
          title: 'Channel',
          type: 'object',
          additionalProperties: false,
          required: ['key', 'formula'],
          properties: {
            key: {
              type: 'string',
              minLength: 1,
              maxLength: 40,
              pattern: '^[A-Za-z0-9_.-]+$',
              title: 'Channel key',
              description: 'Stable. Renaming it starts a new channel with no history.',
            },
            name: { type: 'string', maxLength: 80, default: '', title: 'Channel name' },
            unit: { type: 'string', maxLength: 20, default: '', title: 'Unit' },
            formula: {
              type: 'string',
              minLength: 1,
              maxLength: 2_000,
              title: 'Formula',
              description:
                'Arithmetic over other sensors’ channels. ' +
                'channel(42, “traffic.in”) + channel(43, “traffic.in”) · ' +
                'percent(channel(7, “used”), channel(7, “total”)) · ' +
                'status(11) + status(12) — status is 1 when that sensor is Up and 0 otherwise. ' +
                'min, max, avg, sum, abs, round, floor, ceil, percent and default are available. ' +
                'A channel with no reading makes the whole formula a **gap**, never a zero, so a ' +
                'total cannot quietly lose a term — write default(…, 0) where absence really ' +
                'does mean none.',
            },
          },
        },
      },
      maxAgeSeconds: {
        type: 'integer',
        minimum: 30,
        maximum: 86_400,
        default: 600,
        title: 'Ignore readings older than',
        description:
          'A source sensor that stopped reporting leaves its last value behind for ever. Past ' +
          'this age it counts as absent — which makes the formula a gap rather than a number ' +
          'computed from something that stopped being true an hour ago.',
      },
    },
  },

  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
    const raw = params['channels'];
    if (!Array.isArray(raw) || raw.length === 0) {
      return [{ key: 'value', name: 'Value', unit: '', isPrimary: true }];
    }
    const out: ChannelDef[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const key = typeof record['key'] === 'string' ? record['key'].trim() : '';
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
      out.push({
        key,
        name: name === '' ? key : name,
        unit: typeof record['unit'] === 'string' ? record['unit'] : '',
        ...(out.length === 0 ? { isPrimary: true } : {}),
      });
    }
    return out.length === 0 ? [{ key: 'value', name: 'Value', unit: '', isPrimary: true }] : out;
  },

  execute(_context: CheckContext): Promise<CheckExecution> {
    // Unreachable unless the assignment filter has been broken. Loud rather than silent: a
    // factory sensor that started being scanned by a probe would report Down for ever with no
    // explanation of why, and the explanation is exactly one line long.
    return Promise.reject(
      new Error(
        'a Sensor Factory is evaluated by the core, not by a probe — this sensor should never ' +
          'have been assigned to one, and something is wrong with the probe configuration path',
      ),
    );
  },
};
