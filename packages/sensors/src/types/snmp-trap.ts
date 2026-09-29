import type {
  ChannelDef,
  CheckContext,
  CheckExecution,
  ReceivedBatch,
  ReceivedNotification,
  SensorType,
} from '../contract.js';
import { readRule, ruleMatches, type TrapRule } from '../support/snmp/trap.js';

/**
 * SNMP traps and informs arriving at the probe (`T-06`).
 *
 * **The second shape of sensor, and the first one in the catalogue that is asked questions
 * rather than asking them.** There is no request here and no session: devices send when
 * something happens, the probe holds one listener on port 162 for all of them, and this sensor's
 * scan is the moment it reports what arrived since the last one. `ctx.received` is that batch.
 *
 * **The listener does not know this type exists.** It decodes, normalises v1 and v2c into one
 * shape (RFC 3584 — see `support/snmp/trap.ts`) and keeps a cursor per sensor. Every decision
 * lives here: which notifications are this sensor's, how they are counted, how many are kept to
 * read. That is what makes a trap sensor an ordinary one-file plugin instead of a special case
 * threaded through the probe, and it is why this whole type is testable against a fabricated
 * batch with no socket in the test.
 *
 * **A trap sensor is Up when traps arrive.** That inverts the usual reading and it is worth
 * stating: `count` is traps *in the last interval*, so the ordinary state of a healthy device is
 * zero, and the alarm is an upper limit. A sensor that went Down because nothing was sent would
 * alarm on every quiet night.
 *
 * **What it deliberately does not do is turn one trap into one alarm.** A device that has lost
 * an uplink sends the same trap every thirty seconds; one alarm per trap is exactly the failure
 * CLAUDE.md's "one outage, one alarm" rule exists to prevent. The count crosses a limit once and
 * stays there while the flood lasts, and the messages are there to say what it was.
 */

/** Enough rules for any one sensor; more than this is two sensors. */
const MAX_RULES = 20;

/** How many rendered lines the sensor carries in its message. */
const MAX_RETAINED = 20;

/** Sensor messages are read by a person, and a trap line can be long. */
const MAX_MESSAGE = 500;

export const snmpTrap: SensorType = {
  id: 'snmp.trap',
  category: 'SNMP',
  // No session, no device round trip: this reads a buffer the probe already filled.
  costHint: 'light',
  // None. The listener authenticates what it accepts, once, for the whole probe — a community
  // string per trap sensor would be a per-sensor answer to a question the socket asks first.
  credentialKinds: [],
  // What tells the probe to hand this sensor `ctx.received` rather than run a poll.
  listener: 'snmp-trap',

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sourceIsDevice: {
        type: 'boolean',
        default: true,
        title: 'Only this device',
        description:
          'On by default: the sensor counts only notifications whose sender is the device it ' +
          'sits under. Turn it off for a collector sensor that watches a whole subnet, and use ' +
          'the rules below to say which. A device addressed by name is looked up on the probe, ' +
          'and one whose name resolves to nothing fails the check rather than counting nothing.',
      },
      rules: {
        type: 'array',
        maxItems: MAX_RULES,
        default: [],
        title: 'Filter rules',
        description:
          'A notification counts when it matches *any* rule; with no rules at all, everything ' +
          'that got past “only this device” counts. Within one rule every field given must ' +
          'match, so adding a field always narrows.',
        items: {
          // The singular, for `U-12`'s repeating control: the fieldset is named for the
          // parameter and an entry inside it wants this.
          title: 'Rule',
          type: 'object',
          additionalProperties: false,
          properties: {
            source: {
              type: 'string',
              maxLength: 64,
              default: '',
              title: 'Sender',
              description:
                'The sending address. End it with a dot for a prefix — “10.1.” matches the ' +
                'whole range.',
            },
            trapOid: {
              type: 'string',
              maxLength: 255,
              default: '',
              title: 'Trap OID',
              description:
                'The notification’s OID. End it with a dot to match a whole subtree — ' +
                '“1.3.6.1.4.1.9.” is every Cisco trap. A v1 trap is matched by its RFC 3584 ' +
                'equivalent, so one rule catches both versions: linkDown is ' +
                '1.3.6.1.6.3.1.1.5.3 whichever way the device sent it.',
            },
            contains: {
              type: 'string',
              maxLength: 200,
              default: '',
              title: 'Text contains',
              description:
                'A substring of the rendered line, ignoring case — matched against the varbind ' +
                'values as well as the OID, which is how to catch a message a device puts in a ' +
                'string rather than in a trap number.',
            },
          },
        },
      },
      warnOnDropped: {
        type: 'boolean',
        default: true,
        title: 'Fail when notifications were missed',
        description:
          'The probe’s listener holds a bounded buffer. If more arrived than it could keep ' +
          'before this sensor next scanned, the count is short by a known number — and a trap ' +
          'sensor quietly under-reporting the flood it exists to report is worse than a failed ' +
          'check. Leave this on unless a deliberate flood is normal for this device.',
      },
    },
  },

  channels(): readonly ChannelDef[] {
    return [
      // Traps since the last scan, not a total: an upper limit on this is "more traps than
      // usual", which is the alarm somebody actually wants.
      { key: 'count', name: 'Traps', unit: '', isPrimary: true },
      { key: 'informs', name: 'Informs', unit: '' },
      // Everything that reached the listener and was not this sensor's. Not noise: it is how an
      // operator finds out a device is sending traps that no sensor is catching.
      { key: 'unmatched', name: 'Not matched', unit: '' },
      { key: 'dropped', name: 'Missed', unit: '' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const batch = context.received;
    if (batch === undefined) {
      // Not "zero traps". The probe has no listener running, or this build never attached one,
      // and reporting a confident zero would make a broken receiver look like a quiet network —
      // which is the one failure a trap sensor must never have.
      throw new Error(
        'no trap listener is running on this probe, so nothing could have been received — ' +
          'enable the SNMP trap listener in the probe’s configuration',
      );
    }
    if (batch.listener !== 'snmp-trap') {
      throw new Error(
        `this sensor was handed a batch from the "${batch.listener}" listener, which it cannot ` +
          'read',
      );
    }

    const rules = readRules(context.params);
    const onlyDevice = context.params['sourceIsDevice'] !== false;
    const host = context.target.host;

    // A trap's sender is an *address*; a device's host is often a name. Comparing the two
    // directly counts zero for ever on any device addressed by hostname — which looks exactly
    // like a quiet network, the one failure this type must not have. So the name is resolved,
    // and a name that will not resolve fails the check instead of reporting nothing. The
    // resolver is shared with the other listener types (`P-246`).
    const { canonicalAddress, fromDevice } = await import('../support/sender.js');
    const isDevice = onlyDevice ? await fromDevice(host, 'notifications') : null;

    const mine: ReceivedNotification[] = [];
    let unmatched = 0;
    for (const received of batch.items) {
      // The sender in the form a rule's `10.1.` prefix is written in: a dual-stack listener
      // reports an IPv4 sender as `::ffff:10.1.1.1`, which no such prefix would ever match.
      const source = canonicalAddress(received.source);
      const item = source === received.source ? received : { ...received, source };
      if (isDevice !== null && !isDevice(source)) {
        unmatched += 1;
        continue;
      }
      if (rules.length > 0 && !rules.some((rule) => ruleMatches(rule, item))) {
        unmatched += 1;
        continue;
      }
      mine.push(item);
    }

    const informs = mine.filter((item) => item.detail['kind'] === 'inform').length;
    const dropped = batch.dropped;

    const channels = [
      { key: 'count', value: mine.length },
      { key: 'informs', value: informs },
      { key: 'unmatched', value: unmatched },
      { key: 'dropped', value: dropped },
    ];

    if (dropped > 0 && context.params['warnOnDropped'] !== false) {
      // A failed check records *no* channel values, and that is the point rather than a cost:
      // the count is known to be short, and a gap is the honest reading for a number nobody
      // should act on. It is "no-data is not zero" applied to no-trustworthy-data. The escape
      // hatch is the parameter, for a device whose flood is expected.
      throw new Error(
        `${String(dropped)} notifications reached this probe but were overwritten before this ` +
          `sensor read them, so the count of ${String(mine.length)} is short by that much — the ` +
          'probe’s trap buffer is too small for this volume, or this sensor scans too rarely',
      );
    }

    return { channels, message: describe(mine, unmatched, batch) };
  },
};

function readRules(params: Readonly<Record<string, unknown>>): TrapRule[] {
  const raw = params['rules'];
  if (!Array.isArray(raw)) return [];
  const rules: TrapRule[] = [];
  for (const entry of raw) {
    const rule = readRule(entry);
    // An entry with every field blank matches everything, which makes every other rule
    // pointless. Almost always a half-finished row rather than an intent, so it is skipped —
    // and if *every* rule is blank the sensor falls back to "no rules", which matches everything
    // anyway, so nothing is lost either way.
    if (rule !== null && Object.keys(rule).length > 0) rules.push(rule);
  }
  return rules;
}

/** What an operator reads under the graph: how many, and the last few, newest first. */
function describe(
  mine: readonly ReceivedNotification[],
  unmatched: number,
  batch: ReceivedBatch,
): string {
  if (mine.length === 0) {
    const quiet = `no traps since ${batch.since.slice(0, 19)}Z`;
    return unmatched === 0 ? quiet : `${quiet}; ${String(unmatched)} not matched by this sensor`;
  }

  const head =
    `${String(mine.length)} trap${mine.length === 1 ? '' : 's'}` +
    (unmatched === 0 ? '' : `, ${String(unmatched)} not matched`);

  const lines: string[] = [];
  let used = head.length;
  for (const item of [...mine].reverse().slice(0, MAX_RETAINED)) {
    const line = `${item.at.slice(11, 19)} ${item.text}`;
    if (used + line.length + 2 > MAX_MESSAGE) break;
    used += line.length + 2;
    lines.push(line);
  }
  return [head, ...lines].join('; ');
}
