import type {
  ChannelDef,
  CheckContext,
  CheckExecution,
  ReceivedNotification,
  SensorType,
} from '../contract.js';
import { SEVERITIES } from '../support/syslog/parse.js';
import { earlierNote } from '../support/earlier.js';

/**
 * What arrived on the probe's syslog port since this sensor last looked (`T-20`).
 *
 * **The second listener sensor, and it reuses `T-06`'s contract unchanged** — which is the point
 * of having had a contract. The probe owns one socket; a check runs in whichever worker is free
 * and only while it is running, so the socket cannot live in one; `CheckContext.received` hands
 * each sensor what it has not seen. Nothing about that needed changing for a second protocol.
 *
 * **Counting by severity is the reading, and matching is the alarm.** A syslog sensor that only
 * counted lines would go Down on a busy night and Up on a quiet one, which is noise. The channels
 * here are per-severity counts, so a limit says "more than five errors a minute" — the thing an
 * operator actually means — and the match rule says "and tell me when this text appears at all".
 *
 * **Two things it refuses to call zero.** A listener that is not running on this probe, and a
 * buffer that overwrote messages before this sensor read them. Both fail the check, because a
 * receiver that was never switched on must not look like a quiet network, and a sensor that
 * silently undercounted the flood it exists to report is the worst possible version of it.
 *
 * **Retention is bounded and it is not a log store.** The last few matching lines ride along in
 * the message so an operator can see *what* arrived without opening anything else. Anything more
 * is a logging system, which this is not pretending to be.
 */

export const SYSLOG_LISTENER = 'syslog';

/** Enough to see what happened without turning a sensor message into a log file. */
const MAX_RETAINED = 5;

interface Rule {
  readonly field: string;
  readonly contains: string;
  readonly equals: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
};

/** Exported for its own tests: a rule read wrongly is a sensor watching the wrong messages. */
export function readRules(params: Readonly<Record<string, unknown>>): Rule[] {
  const raw = params['match'];
  if (!Array.isArray(raw)) return [];
  const out: Rule[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const field = text(entry, 'field') || 'message';
    const contains = text(entry, 'contains');
    const equals = text(entry, 'equals');
    if (contains === '' && equals === '') continue;
    out.push({ field, contains, equals });
  }
  return out;
}

/**
 * Whether one message matches every rule.
 *
 * **All of them, not any.** A rule list reading "facility is auth" and "message contains failed"
 * means failed authentications; if it meant "or", adding a second rule would *widen* the sensor,
 * which is the opposite of what anybody typing a second rule intends.
 */
export function matches(notification: ReceivedNotification, rules: readonly Rule[]): boolean {
  if (rules.length === 0) return true;
  for (const rule of rules) {
    const actual = fieldOf(notification, rule.field);
    if (rule.equals !== '' && actual.toLowerCase() !== rule.equals.toLowerCase()) return false;
    if (rule.contains !== '' && !actual.toLowerCase().includes(rule.contains.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function fieldOf(notification: ReceivedNotification, field: string): string {
  if (field === 'source') return notification.source;
  if (field === 'text') return notification.text;
  const detail = notification.detail;
  // `structured.foo@123.bar` reaches RFC 5424 structured data, which is flattened by the parser
  // into keys of exactly that shape — so a rule can name one without a query language.
  if (field.startsWith('structured.')) {
    const structured = detail['structured'];
    if (!isRecord(structured)) return '';
    const value = structured[field.slice('structured.'.length)];
    return typeof value === 'string' ? value : '';
  }
  const value = detail[field];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

export const syslogReceiver: SensorType = {
  id: 'syslog.receiver',
  category: 'Log',
  costHint: 'light',
  listener: SYSLOG_LISTENER,

  paramsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sourceIsDevice: {
        type: 'boolean',
        default: true,
        title: 'Only this device',
        description:
          'Counts only messages whose sender is the device this sensor sits under. Turn it off ' +
          'for a sensor watching a relay, which forwards other hosts’ messages under its own ' +
          'address — “which host said this” and “which host sent it to us” are different ' +
          'questions and only one of them is in the packet header. A device addressed by name is ' +
          'looked up on the probe, and one whose name resolves to nothing fails the check rather ' +
          'than counting nothing.',
      },
      match: {
        type: 'array',
        maxItems: 10,
        default: [],
        title: 'Match rules',
        description:
          'A message must satisfy **all** of these to be counted. Empty counts everything. If ' +
          'this meant “any”, adding a second rule would widen the sensor, which is the opposite ' +
          'of what anybody typing one intends.',
        items: {
          // The singular, for `U-12`'s repeating control: the fieldset is named for the
          // parameter and an entry inside it wants this.
          title: 'Rule',
          type: 'object',
          additionalProperties: false,
          properties: {
            field: {
              type: 'string',
              maxLength: 60,
              default: 'message',
              title: 'Field',
              description:
                'message · hostname · appName · procId · msgId · severityName · facilityName · ' +
                'source · text, or structured.id@enterprise.param for RFC 5424 structured data.',
            },
            contains: { type: 'string', maxLength: 200, default: '', title: 'Contains' },
            equals: { type: 'string', maxLength: 200, default: '', title: 'Equals' },
          },
        },
      },
      minSeverity: {
        enum: ['', ...SEVERITIES],
        default: '',
        title: 'At least this severe',
        description:
          'Ignores anything less severe. Emergency is the most severe and debug the least, so ' +
          '“warning” counts warnings, errors, criticals, alerts and emergencies.',
      },
      retain: {
        type: 'integer',
        minimum: 0,
        maximum: MAX_RETAINED,
        default: 3,
        title: 'Lines to show',
        description:
          'The most recent matching lines, in this sensor’s message, so an operator can see what ' +
          'arrived without opening anything else. This is not a log store and is not trying to be.',
      },
    },
  },

  channels(): readonly ChannelDef[] {
    return [
      // Counting *all* matching messages is the primary, because that is what a limit is set on.
      { key: 'messages', name: 'Messages', unit: '', isPrimary: true },
      // Per severity, so a limit can say "more than five errors a minute" — which is the thing
      // an operator means. A single count goes Down on a busy night and Up on a quiet one.
      { key: 'emergency', name: 'Emergency', unit: '' },
      { key: 'alert', name: 'Alert', unit: '' },
      { key: 'critical', name: 'Critical', unit: '' },
      { key: 'error', name: 'Error', unit: '' },
      { key: 'warning', name: 'Warning', unit: '' },
      { key: 'notice', name: 'Notice', unit: '' },
      { key: 'informational', name: 'Informational', unit: '' },
      { key: 'debug', name: 'Debug', unit: '' },
      { key: 'senders', name: 'Distinct senders', unit: '' },
    ];
  },

  async execute(context: CheckContext): Promise<CheckExecution> {
    const batch = context.received;
    if (batch === undefined || batch.listener !== SYSLOG_LISTENER) {
      // Never a zero. A receiver that was never switched on must not look like a quiet network.
      throw new Error(
        'this probe’s syslog listener is not running, so there is nothing to count — enable ' +
          '`syslogListener` in the probe’s configuration. A sensor reporting zero here would ' +
          'say the network is quiet, which is not what is being observed',
      );
    }
    if (batch.dropped > 0) {
      // With what a resuming scan did not read: a flood the ring could not date always leaves a
      // full buffer dropped, so `undated` is only ever named here (`P-274`).
      throw new Error(
        `${String(batch.dropped)} message${batch.dropped === 1 ? '' : 's'} were overwritten ` +
          'before this sensor read them — the probe’s syslog buffer is smaller than the flood ' +
          'it is seeing, or this sensor scans too rarely for the volume. Reporting the rest ' +
          'as a count would undercount exactly the incident this sensor exists to find' +
          earlierNote(batch, 'messages'),
      );
    }

    const rules = readRules(context.params);
    const floor = severityFloor(context.params['minSeverity']);
    const onlyThisDevice = context.params['sourceIsDevice'] !== false;
    const retain = Math.min(MAX_RETAINED, Number(context.params['retain'] ?? 3));
    // A sender is an address and a device's host is often a name (`P-246`). Compared as strings,
    // a device addressed by name counted nothing, for ever, and read Up at zero, where no limit
    // can fire. The name is resolved, and one that resolves to nothing fails the check.
    const isDevice = onlyThisDevice
      ? await (await import('../support/sender.js')).fromDevice(context.target.host, 'messages')
      : null;

    const counts = new Map<string, number>(SEVERITIES.map((name) => [name, 0]));
    const senders = new Set<string>();
    const recent: string[] = [];
    let total = 0;

    for (const item of batch.items) {
      if (isDevice !== null && !isDevice(item.source)) continue;
      const severity = Number(item.detail['severity'] ?? 7);
      if (floor !== null && severity > floor) continue;
      if (!matches(item, rules)) continue;

      total += 1;
      senders.add(item.source);
      const rawName = item.detail['severityName'];
      const name = typeof rawName === 'string' ? rawName : 'debug';
      counts.set(name, (counts.get(name) ?? 0) + 1);
      recent.push(item.text);
      if (recent.length > retain) recent.shift();
    }

    return {
      channels: [
        { key: 'messages', value: total },
        ...SEVERITIES.map((name) => ({ key: name, value: counts.get(name) ?? 0 })),
        { key: 'senders', value: senders.size },
      ],
      message:
        `${String(total)} message${total === 1 ? '' : 's'} since ${batch.since}` +
        (recent.length === 0 ? '' : `; ${recent.join(' | ')}`) +
        earlierNote(batch, 'messages'),
    };
  },
};

/** The numeric code at or below which a message is severe enough to count. */
function severityFloor(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const at = SEVERITIES.indexOf(raw as (typeof SEVERITIES)[number]);
  return at < 0 ? null : at;
}
