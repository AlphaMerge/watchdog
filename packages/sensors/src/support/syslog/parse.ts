/**
 * Syslog, both of the formats devices actually send (`T-20`).
 *
 * **Written here because npm has no maintained option**, which is CLAUDE.md's stated reason for
 * the syslog, NetFlow and WMI transports. It is also not much: syslog is a priority in angle
 * brackets and then a line of text whose shape depends on how old the sender is.
 *
 * **Two formats, and the older one is not optional.** RFC 5424 (2009) is what anything modern
 * emits; RFC 3164 (2001, and explicitly "informational, describing what is observed") is what a
 * switch bought in 2014 still sends, and a receiver that only understood the new one would be a
 * receiver that works against a test rig and not against a network. They are told apart by the
 * character after the priority: 5424 begins with a version digit and a space, 3164 with a month.
 *
 * **A message that parses badly still becomes a notification.** The alternative — dropping it —
 * loses exactly the line somebody needs during an incident, because the devices that emit
 * malformed syslog are disproportionately the ones going wrong. What cannot be parsed lands in
 * `message` with the facility and severity taken from the priority, which is the part every
 * sender gets right.
 */

/** RFC 5424 §6.2.1. Index is the numeric code. */
export const SEVERITIES = [
  'emergency',
  'alert',
  'critical',
  'error',
  'warning',
  'notice',
  'informational',
  'debug',
] as const;

export type Severity = (typeof SEVERITIES)[number];

/** RFC 5424 §6.2.1, the codes with names. Beyond 23 a sender is inventing them. */
export const FACILITIES = [
  'kernel',
  'user',
  'mail',
  'daemon',
  'auth',
  'syslog',
  'lpr',
  'news',
  'uucp',
  'cron',
  'authpriv',
  'ftp',
  'ntp',
  'audit',
  'alert',
  'clock',
  'local0',
  'local1',
  'local2',
  'local3',
  'local4',
  'local5',
  'local6',
  'local7',
] as const;

export interface SyslogMessage {
  /** 0–191 as sent. Kept because a filter on the raw number is sometimes what somebody wants. */
  readonly priority: number;
  readonly facility: number;
  readonly facilityName: string;
  readonly severity: number;
  readonly severityName: Severity;
  /** The sender's own clock when it said so, ISO-8601, or null when it sent no usable one. */
  readonly timestamp: string | null;
  readonly hostname: string;
  /** `TAG` in 3164, `APP-NAME` in 5424. */
  readonly appName: string;
  readonly procId: string;
  readonly msgId: string;
  readonly message: string;
  /** 3164 or 5424, or 'raw' when there was no priority at all. */
  readonly format: '3164' | '5424' | 'raw';
  /** RFC 5424 structured data, flattened to `id@enterprise.param`. Empty for 3164. */
  readonly structured: Readonly<Record<string, string>>;
}

/** Longest line this will look at. RFC 5424 allows any length; a receiver must not. */
export const MAX_LINE = 64 * 1024;

export function severityName(code: number): Severity {
  return SEVERITIES[code] ?? 'debug';
}

export function facilityName(code: number): string {
  return FACILITIES[code] ?? `facility${String(code)}`;
}

export function parseSyslog(line: string): SyslogMessage {
  const text = (line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line).replace(/\0+$/, '').trim();

  const priorityMatch = /^<(\d{1,3})>/.exec(text);
  if (priorityMatch === null) {
    // No priority at all. Some devices — and every `logger -n` typo — send a bare line. RFC 3164
    // §4.3.3 says to treat it as facility 1 severity 5, and that is better than discarding it.
    return raw(text, 13);
  }
  const priority = Number(priorityMatch[1]);
  if (priority > 191) return raw(text, priority);

  const rest = text.slice(priorityMatch[0].length);

  // RFC 5424: `<PRI>VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP MSGID SP SD [MSG]`
  const five = /^(\d{1,2})\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*/.exec(rest);
  if (five !== null && five[1] === '1') {
    const after = rest.slice(five[0].length);
    const { structured, message } = readStructuredData(after);
    return {
      ...codes(priority),
      timestamp: isoOrNull(nilToEmpty(five[2] ?? '')),
      hostname: nilToEmpty(five[3] ?? ''),
      appName: nilToEmpty(five[4] ?? ''),
      procId: nilToEmpty(five[5] ?? ''),
      msgId: nilToEmpty(five[6] ?? ''),
      message,
      format: '5424',
      structured,
    };
  }

  // RFC 3164: `<PRI>MMM dd hh:mm:ss HOSTNAME TAG[pid]: MSG`
  const three = /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+(.*)$/s.exec(rest);
  if (three !== null) {
    const remainder = three[3] ?? '';
    // The tag ends at the first character that is not alphanumeric — RFC 3164 §4.1.3, and it is
    // why `sshd[1234]:` yields `sshd` and `1234` rather than one field nobody can filter on.
    const tag = /^([A-Za-z0-9_./-]{1,48})(?:\[(\d+)\])?:?\s*/.exec(remainder);
    return {
      ...codes(priority),
      timestamp: legacyTimestamp(three[1] ?? ''),
      hostname: three[2] ?? '',
      appName: tag?.[1] ?? '',
      procId: tag?.[2] ?? '',
      msgId: '',
      message: tag === null ? remainder.trim() : remainder.slice(tag[0].length).trim(),
      format: '3164',
      structured: {},
    };
  }

  // A priority and then something this does not recognise. Still a message.
  return { ...raw(rest, priority), format: 'raw' };
}

function codes(priority: number): {
  priority: number;
  facility: number;
  facilityName: string;
  severity: number;
  severityName: Severity;
} {
  const facility = Math.floor(priority / 8);
  const severity = priority % 8;
  return {
    priority,
    facility,
    facilityName: facilityName(facility),
    severity,
    severityName: severityName(severity),
  };
}

function raw(text: string, priority: number): SyslogMessage {
  return {
    ...codes(priority),
    timestamp: null,
    hostname: '',
    appName: '',
    procId: '',
    msgId: '',
    message: text,
    format: 'raw',
    structured: {},
  };
}

/** `-` is RFC 5424's NIL value and means "the sender has nothing to put here". */
function nilToEmpty(value: string): string {
  return value === '-' ? '' : value;
}

function isoOrNull(value: string): string | null {
  if (value === '') return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/**
 * RFC 3164's timestamp has no year.
 *
 * So it is guessed, and the guess has one interesting case: a message stamped December arriving
 * in January is last year's, not next year's. Getting that backwards puts a line eleven months
 * into the future, where nothing looking at a time range will ever find it again.
 */
function legacyTimestamp(stamp: string, now: Date = new Date()): string | null {
  const at = Date.parse(`${stamp} ${String(now.getUTCFullYear())} UTC`);
  if (Number.isNaN(at)) return null;
  const guessed = new Date(at);
  if (guessed.getTime() - now.getTime() > 86_400_000) {
    return new Date(Date.parse(`${stamp} ${String(now.getUTCFullYear() - 1)} UTC`)).toISOString();
  }
  return guessed.toISOString();
}

/**
 * RFC 5424 §6.3 structured data, flattened.
 *
 * `[exampleSDID@32473 iut="3" eventID="1011"]` becomes
 * `{'exampleSDID@32473.iut': '3', 'exampleSDID@32473.eventID': '1011'}`, which is a shape a
 * filter rule can name without a query language.
 */
function readStructuredData(text: string): {
  structured: Record<string, string>;
  message: string;
} {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('-')) return { structured: {}, message: trimmed.slice(1).trim() };
  if (!trimmed.startsWith('[')) return { structured: {}, message: trimmed };

  const structured: Record<string, string> = {};
  let at = 0;
  while (at < trimmed.length && trimmed[at] === '[') {
    const end = closingBracket(trimmed, at);
    if (end < 0) break;
    const element = trimmed.slice(at + 1, end);
    const space = element.search(/\s/);
    const id = space < 0 ? element : element.slice(0, space);
    if (space >= 0) {
      // `name="value"`, with `\"`, `\]` and `\\` escaped per §6.3.3.
      const params = element.slice(space + 1);
      const pattern = /([A-Za-z0-9@._-]+)="((?:[^"\\]|\\.)*)"/g;
      let found: RegExpExecArray | null;
      while ((found = pattern.exec(params)) !== null) {
        structured[`${id}.${found[1] ?? ''}`] = (found[2] ?? '').replace(/\\(["\]\\])/g, '$1');
      }
    }
    at = end + 1;
  }
  return { structured, message: trimmed.slice(at).trim() };
}

/** The `]` that closes the element at `from`, skipping escaped ones. */
function closingBracket(text: string, from: number): number {
  let inQuotes = false;
  for (let at = from + 1; at < text.length; at += 1) {
    const character = text[at];
    if (character === '\\') {
      at += 1;
      continue;
    }
    if (character === '"') inQuotes = !inQuotes;
    else if (character === ']' && !inQuotes) return at;
  }
  return -1;
}

/**
 * One line, for retention and for a sensor's message.
 *
 * The source address is included because a syslog sensor sits under a *device* and a relay
 * forwards other hosts' messages under its own address — so "which host said this" and "which
 * host sent it to us" are different questions, and only one of them is in the packet header.
 */
export function renderSyslog(source: string, message: SyslogMessage): string {
  const who = [message.hostname, message.appName].filter((part) => part !== '').join(' ');
  return (
    `${message.facilityName}.${message.severityName} from ${source}` +
    (who === '' ? '' : ` (${who})`) +
    (message.message === '' ? '' : `: ${message.message}`)
  );
}
