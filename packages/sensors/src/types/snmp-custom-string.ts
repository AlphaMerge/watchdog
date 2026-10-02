import type { ChannelDef, CheckContext, CheckExecution, SensorType } from '../contract.js';
import { scrubberOf } from '../support/secrets.js';
import { SNMP_SECRET_DESTINATIONS, snmpParamsSchema } from '../support/snmp/schema.js';
import { MAX_PATTERN } from '../support/pattern.js';

/**
 * One arbitrary string OID, with a regular expression and a lookup (`T-03`).
 *
 * **A channel holds a number, so a string sensor has to produce one.** That is not a limitation
 * to work around — it is what makes the reading gradeable, graphable and rollup-able like every
 * other channel. The two useful ways to get there are both here: pull a number *out* of the text
 * ("Temp: 41.5C" → 41.5), or ask whether the text matches at all ("does `sysDescr` still say
 * Cisco" → 1 or 0). Anything else an operator wants to see about the string is in the message,
 * which carries what the device actually said.
 *
 * **The lookup is where a status string becomes a state** (`M-06`). A device reporting
 * `"batteryNormal"` is not a measurement and has no threshold: match it to 1, map 1 through a
 * lookup, and the sensor is Up with a phrase rather than a number nobody can set a limit on.
 */
export const snmpCustomString: SensorType = {
  id: 'snmp.custom.string',
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
        title: 'OID',
        description:
          'The object to read, in numeric form. Include the instance — a scalar ends in .0.',
      },
      pattern: {
        type: 'string',
        maxLength: MAX_PATTERN,
        default: '',
        title: 'Pattern',
        description:
          'A regular expression. With a capture group the first group is used — `Temp: ' +
          '([0-9.]+)C` against "Temp: 41.5C" gives 41.5. Without one, the whole match is used. ' +
          'Leave it empty to use the whole string. Matching is done against the first 4 KB of ' +
          'what the device returned.',
      },
      mode: {
        enum: ['number', 'match'],
        default: 'number',
        title: 'What to report',
        description:
          '`number` parses what the pattern found and reports it, failing the check if the text ' +
          'is not a number — for a device that reports a measurement as text. `match` reports 1 ' +
          'when the pattern matches and 0 when it does not, which is how to watch for a phrase.',
      },
      lookup: {
        type: 'string',
        maxLength: 100,
        default: '',
        title: 'Lookup',
        description:
          'The id of a lookup that turns the reported number into a state and a phrase — for ' +
          'example ms.snmp.if-oper-status. Without one the reading is judged by limits, which ' +
          'is the wrong tool for a status code. A lookup this installation has not loaded is ' +
          'reported rather than fatal.',
      },
      channelName: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        default: 'Value',
        title: 'Channel name',
      },
      unit: { type: 'string', maxLength: 50, default: '', title: 'Unit' },
    },
    ['oid'],
  ),

  channels(params: Readonly<Record<string, unknown>>): readonly ChannelDef[] {
    const lookup = typeof params['lookup'] === 'string' ? params['lookup'].trim() : '';
    return [
      {
        key: 'value',
        name: typeof params['channelName'] === 'string' ? params['channelName'] : 'Value',
        unit: typeof params['unit'] === 'string' ? params['unit'] : '',
        isPrimary: true,
        // Only when one was named: a channel declaring `lookup: ''` would have the core hunting
        // for a lookup with an empty id and reporting it missing on every scan.
        ...(lookup === '' ? {} : { lookup }),
      },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const scrub = scrubberOf(context);
    const { snmpCheck, stringOf, isException, normaliseOid, compilePattern, extract } =
      await import('../support/snmp/index.js');

    const asked = context.params['oid'];
    const oid = normaliseOid(typeof asked === 'string' ? asked : '');
    const raw = context.params['pattern'];
    const source = typeof raw === 'string' ? raw : '';
    // Checked before the request, so a bad pattern fails without troubling the device — and
    // fails with the same sentence every scan rather than intermittently. The match itself runs
    // in a sandbox with a watchdog; see `extract.ts` for why.
    if (source !== '') compilePattern(source);
    const pattern = source === '' ? null : source;
    const mode = context.params['mode'] === 'match' ? ('match' as const) : ('number' as const);

    return snmpCheck(context, async (session, signal) => {
      const [varbind] = await session.get([oid], signal);
      if (varbind === undefined || isException(varbind)) {
        throw new Error(
          `${context.target.host} has no object at ${oid} — it answered "no such object"`,
        );
      }

      const text = stringOf(varbind);
      if (text === null) {
        throw new Error(`${oid} returned ${varbind.type}, which carries no text`);
      }

      const found = extract(text, pattern, mode);

      if (found.kind === 'too-slow') {
        // A pattern that backtracks. It fails *this check* rather than holding the worker until
        // the pool terminates it, and it names the pattern, which is the thing to go and fix.
        throw new Error(
          `matching /${source}/ against ${oid} was still running after ` +
            `${String(found.afterMs)} ms and was stopped — the pattern backtracks on what this ` +
            'device returns; a nested quantifier such as (a+)+ is the usual cause',
        );
      }

      if (found.kind === 'no-match') {
        if (mode === 'match') {
          // Not a failure: "the phrase is gone" is the reading, and 0 is what a limit or a
          // lookup is set against. The message carries what the device said instead.
          return {
            channels: [{ key: 'value', value: 0 }],
            message: `${oid} did not match /${source}/ — it says "${clip(scrub(text))}"`,
          };
        }
        throw new Error(
          `${oid} did not match /${source}/ — the device says "${clip(scrub(text))}", and this sensor ` +
            'needs a number out of it',
        );
      }

      if (found.kind === 'not-a-number') {
        throw new Error(
          `${oid} matched "${clip(scrub(found.matched))}", which is not a number — use the match mode ` +
            'to report whether the pattern is there, rather than what it says',
        );
      }

      return {
        channels: [{ key: 'value', value: found.value }],
        // The raw string, always. It is the thing an operator opened the sensor to read, and the
        // only way to tell "the pattern is wrong" from "the device changed what it reports".
        message: `${oid} = "${clip(scrub(text))}"${
          found.matched === text ? '' : ` → "${clip(scrub(found.matched))}"`
        }`,
      };
    });
  },
};

/** Device strings can be kilobytes; a sensor message is read by a person. */
function clip(text: string, limit = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}
