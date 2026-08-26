import type { SensorState } from '../state/tables.js';
import type { NotificationReason } from './chain.js';

/**
 * The six modes of `CAPABILITIES.MD §5.2`, in the order that table lists them.
 *
 * The distinction that matters is between the two *first* modes and the two *all* modes. "First
 * Down immediately" sends one message and collects the rest of the storm; "all Downs
 * immediately" sends every Down and only collects the warnings and the recoveries. An operator
 * choosing between them is choosing whether a forty-sensor outage is one message or forty.
 */
export const SUMMARISATION_MODES = [
  'always-immediate',
  'first-down',
  'first-down-and-up',
  'downs-immediate',
  'downs-and-ups-immediate',
  'always-summarise',
] as const;

export type SummarisationMode = (typeof SUMMARISATION_MODES)[number];

/** What `CAPABILITIES.MD` calls the default, and what PRTG defaults to as well. */
export const DEFAULT_SUMMARISATION: SummarisationMode = 'first-down-and-up';

export function isSummarisationMode(value: unknown): value is SummarisationMode {
  return typeof value === 'string' && (SUMMARISATION_MODES as readonly string[]).includes(value);
}

export function describeSummarisationModes(): { id: SummarisationMode; description: string }[] {
  return SUMMARISATION_MODES.map((id) => ({ id, description: MODE_DESCRIPTIONS[id] }));
}

const MODE_DESCRIPTIONS: Readonly<Record<SummarisationMode, string>> = {
  'always-immediate': 'Send every notification as soon as it falls due. Never summarise.',
  'first-down': 'Send the first Down of a window immediately, then summarise everything.',
  'first-down-and-up':
    'Send the first Down and the first Up of a window immediately, then summarise everything.',
  'downs-immediate': 'Send every Down immediately; summarise recoveries and warnings.',
  'downs-and-ups-immediate': 'Send every Down and every Up immediately; summarise the rest.',
  'always-summarise': 'Collect everything into a digest, including the first message.',
};

/**
 * What a notification *is*, for the purpose of deciding how fast to send it.
 *
 * Three kinds rather than two, because two of the modes say "summarise others" and there has to
 * be an *others*. A Warning is the case: it is not the outage the Down modes are about, and it is
 * not the all-clear either.
 */
export type MessageKind = 'down' | 'up' | 'other';

/**
 * Which kind a queued notification is.
 *
 * **A threshold breach counts as a Down, and that is a decision.** The mode names are written in
 * terms of Down and Up, so reading them literally would make a disk filling up an "other" and
 * hold it for the window — an operator who asked for "all Downs immediately" would get a late
 * digest about a full disk. Between a message that is noisier than asked for and one that is
 * later than asked for, an alarm system takes the noisy one.
 */
export function kindOf(request: {
  readonly reason: NotificationReason;
  readonly state: SensorState | null;
}): MessageKind {
  // A recovery is an Up whatever state the trigger was armed on: it is the message that says
  // the thing that was wrong is no longer wrong.
  if (request.reason === 'recovery' || request.reason === 'clear') return 'up';
  if (request.reason === 'threshold') return 'down';
  switch (request.state) {
    case 'up':
      return 'up';
    case 'down':
    case 'down_acknowledged':
    case 'down_partial':
      return 'down';
    default:
      return 'other';
  }
}

/** What to do with one notification: send it now, or put it in the digest. */
export type Disposition = 'immediate' | 'held';

/**
 * The whole of the mode table, in one function.
 *
 * `released` is the kinds that have already gone out immediately inside the open window, which is
 * what makes "first" mean first.
 */
export function disposition(
  mode: SummarisationMode,
  kind: MessageKind,
  released: readonly MessageKind[],
): Disposition {
  switch (mode) {
    case 'always-immediate':
      return 'immediate';
    case 'always-summarise':
      return 'held';
    case 'first-down':
      return kind === 'down' && !released.includes('down') ? 'immediate' : 'held';
    case 'first-down-and-up':
      if (kind === 'other') return 'held';
      return released.includes(kind) ? 'held' : 'immediate';
    case 'downs-immediate':
      return kind === 'down' ? 'immediate' : 'held';
    case 'downs-and-ups-immediate':
      return kind === 'other' ? 'held' : 'immediate';
  }
}

/**
 * Whether this mode ever holds anything.
 *
 * `always-immediate` never opens a window, which keeps the common single-alarm case from
 * carrying a row that exists only to be closed empty.
 */
export function summarises(mode: SummarisationMode): boolean {
  return mode !== 'always-immediate';
}

// -------------------------------------------------------------------------------------------
// Building the digest.
// -------------------------------------------------------------------------------------------

/**
 * `CAPABILITIES.MD §5.2`'s limits: about a thousand characters and twenty-five notifications per
 * message, splitting the overflow into further messages.
 *
 * Both caps exist for the same reason and neither is arbitrary: a mail client truncates a long
 * message, an SMS gateway rejects one, and a digest that arrives cut in half has lost exactly the
 * notifications at the end — which in a cascading failure are the ones that explain it.
 */
export const MAX_DIGEST_LINES = 25;
export const MAX_DIGEST_CHARS = 1000;

export interface DigestPart<T> {
  readonly members: readonly T[];
  readonly lines: readonly string[];
}

/**
 * Splits a window's notifications into as many messages as the caps require.
 *
 * A single line longer than the character cap gets a message to itself rather than being dropped
 * or cut: it is somebody's alarm, and the cap is there to keep messages readable, not to decide
 * which outages are worth reporting.
 */
export function splitDigest<T>(
  entries: readonly { readonly member: T; readonly line: string }[],
  caps: { readonly maxLines?: number; readonly maxChars?: number } = {},
): DigestPart<T>[] {
  const maxLines = caps.maxLines ?? MAX_DIGEST_LINES;
  const maxChars = caps.maxChars ?? MAX_DIGEST_CHARS;

  const parts: DigestPart<T>[] = [];
  let members: T[] = [];
  let lines: string[] = [];
  let chars = 0;

  for (const entry of entries) {
    const cost = entry.line.length + 1;
    const full = lines.length >= maxLines || (lines.length > 0 && chars + cost > maxChars);
    if (full) {
      parts.push({ members, lines });
      members = [];
      lines = [];
      chars = 0;
    }
    members.push(entry.member);
    lines.push(entry.line);
    chars += cost;
  }
  if (lines.length > 0) parts.push({ members, lines });
  return parts;
}

/** How many of each kind a digest covers, for its subject line. */
export function countKinds(kinds: readonly MessageKind[]): Record<MessageKind, number> {
  const counts: Record<MessageKind, number> = { down: 0, up: 0, other: 0 };
  for (const kind of kinds) counts[kind] += 1;
  return counts;
}

/**
 * A digest's subject.
 *
 * Generated rather than templated, because the operator's own subject line is written about *one*
 * sensor — `"%sensor on %device is %status"` says nothing useful about twelve of them. Their
 * wording is not thrown away: it becomes each line of the body, rendered per notification, so a
 * digest reads in the words they chose.
 */
export function digestSubject(options: {
  readonly siteName: string;
  readonly counts: Record<MessageKind, number>;
  readonly total: number;
  readonly part: number;
  readonly parts: number;
}): string {
  const { counts } = options;
  const detail = [
    counts.down > 0 ? `${String(counts.down)} down` : '',
    counts.up > 0 ? `${String(counts.up)} up` : '',
    counts.other > 0 ? `${String(counts.other)} other` : '',
  ]
    .filter((part) => part !== '')
    .join(', ');
  const noun = options.total === 1 ? 'notification' : 'notifications';
  const of = options.parts > 1 ? ` (${String(options.part)} of ${String(options.parts)})` : '';
  const site = options.siteName === '' ? '' : `${options.siteName}: `;
  return `${site}${String(options.total)} ${noun}${detail === '' ? '' : ` — ${detail}`}${of}`;
}
