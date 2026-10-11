import type { ApiError } from '../api/client';
import type { DiscoveryLevel, RediscoveryCadence, RediscoveryRule } from '../api/types';
import { PROBE_ABOVE, probeIdFor, type ProbeChoice } from './discovery-model';

/**
 * The form behind a rediscovery rule, and what it sends (`D-11`).
 *
 * Separate from the component for `discovery-model.ts`'s reason: every decision here can be
 * wrong without anything failing. A time typed as `03:30` has to become minute 210 for a daily
 * rule and stay minute 30 for an hourly one; an edit has to send what changed and nothing else;
 * a community the form was never shown has to survive a save that did not mention it.
 */

/**
 * What happens to the stored community on an edit.
 *
 * **Three states, because the form cannot show the one it has.** The core never returns a
 * community (`P-55`), so an edit form starts without one, and "the box is empty" cannot mean
 * both "leave it alone" and "take it away". Keeping is the default, because it is what a person
 * who did not touch the box meant.
 */
export type CommunityChange = 'keep' | 'replace' | 'clear';

export interface RuleDraft {
  name: string;
  /** `PROBE_ABOVE` for a rule whose probe its reader cannot see, which the core leaves out. */
  probeId: ProbeChoice;
  groupId: number | null;
  range: string;
  level: DiscoveryLevel;
  templates: string[];
  cadence: RediscoveryCadence;
  /** `HH:MM` for a daily or weekly rule; minutes past the hour, as text, for an hourly one. */
  at: string;
  /** 0 is Monday, as the core counts. */
  weekday: number;
  /** Empty is the core's own zone. */
  timezone: string;
  /** An `M-09` schedule as a permission window, or null. */
  windowId: number | null;
  autoProvision: boolean;
  community: string;
  communityChange: CommunityChange;
}

export const EMPTY_RULE: RuleDraft = {
  name: '',
  probeId: null,
  groupId: null,
  range: '',
  level: 'standard',
  templates: [],
  cadence: 'daily',
  at: '03:00',
  weekday: 6,
  timezone: '',
  windowId: null,
  autoProvision: false,
  community: '',
  communityChange: 'keep',
};

/** Monday first, as the core numbers them. */
export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** The form as a rule would fill it, for an edit. The community is never among it. */
export function draftFromRule(rule: RediscoveryRule): RuleDraft {
  return {
    name: rule.name,
    probeId: rule.probeId ?? PROBE_ABOVE,
    groupId: rule.groupId,
    range: rule.range,
    level: rule.level,
    templates: [...rule.templates],
    cadence: rule.cadence,
    at: atFromMinute(rule.cadence, rule.cadenceMinute),
    weekday: rule.cadenceWeekday,
    timezone: rule.timezone ?? '',
    windowId: rule.scheduleId,
    autoProvision: rule.autoProvision,
    community: '',
    communityChange: 'keep',
  };
}

/** `210` as `03:30` for a daily or weekly rule, and as `30` past the hour for an hourly one. */
export function atFromMinute(cadence: RediscoveryCadence, minute: number): string {
  if (cadence === 'hourly') return String(minute % 60);
  const hours = Math.floor(minute / 60) % 24;
  return `${String(hours).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/**
 * The minute the core stores, or null when the text is not a time this cadence can have.
 *
 * An hourly rule takes minutes past the hour, 0–59; the others take a time of day, `H:MM` or
 * `HH:MM`. A daily rule typed as `90` is not a guess this function makes.
 */
export function minuteOf(cadence: RediscoveryCadence, at: string): number | null {
  const text = at.trim();
  if (cadence === 'hourly') {
    if (!/^\d{1,2}$/.test(text)) return null;
    const minute = Number(text);
    return minute <= 59 ? minute : null;
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Why the form cannot be saved yet, or null.
 *
 * One reason at a time, in the order the boxes appear, so the sentence beside a disabled button
 * points at the first box to fix rather than listing every empty one.
 */
export function whyNotSavable(draft: RuleDraft): string | null {
  if (draft.name.trim() === '') return 'Give the rule a name.';
  if (draft.probeId === null) return 'Choose a probe.';
  if (draft.groupId === null) return 'Choose a group.';
  if (draft.range.trim() === '') return 'Enter a range.';
  if (minuteOf(draft.cadence, draft.at) === null) {
    return draft.cadence === 'hourly'
      ? 'Minutes past the hour are 0 to 59.'
      : 'A time of day is HH:MM, from 00:00 to 23:59.';
  }
  if (draft.communityChange === 'replace' && draft.community === '') {
    return 'Enter the new SNMP community, or keep the stored one.';
  }
  return null;
}

/** What `POST /discovery/schedules` is sent for a new rule. Off, as every new rule is. */
export function createBody(draft: RuleDraft): Record<string, unknown> {
  return {
    groupId: draft.groupId,
    ...(draft.probeId === null ? {} : probeIdFor(draft.probeId)),
    name: draft.name.trim(),
    range: draft.range.trim(),
    level: draft.level,
    templates: draft.templates,
    cadence: draft.cadence,
    cadenceMinute: minuteOf(draft.cadence, draft.at) ?? 0,
    cadenceWeekday: draft.weekday,
    timezone: draft.timezone.trim() === '' ? null : draft.timezone.trim(),
    scheduleId: draft.windowId,
    autoProvision: draft.autoProvision,
    ...(draft.community === '' ? {} : { snmpCommunity: draft.community }),
  };
}

/**
 * What `PATCH /discovery/schedules/:id` is sent: what differs from the rule, and nothing else.
 *
 * **Only what changed**, so an edit made against a rule that has since moved on is refused for a
 * change it actually makes, and the audit entry lists what this person did. The group is not
 * among it: a rule in another group is another rule. The community is sent only when the person
 * chose to replace or clear it.
 */
export function patchBody(rule: RediscoveryRule, draft: RuleDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const minute = minuteOf(draft.cadence, draft.at) ?? rule.cadenceMinute;
  const timezone = draft.timezone.trim() === '' ? null : draft.timezone.trim();
  // A probe picked by id, and not the rule's: never the one above the group, which is no id to
  // send and is already the rule's (`A-80`).
  if (typeof draft.probeId === 'number' && draft.probeId !== rule.probeId) {
    out['probeId'] = draft.probeId;
  }
  if (draft.name.trim() !== rule.name) out['name'] = draft.name.trim();
  if (draft.range.trim() !== rule.range) out['range'] = draft.range.trim();
  if (draft.level !== rule.level) out['level'] = draft.level;
  if (!sameList(draft.templates, rule.templates)) out['templates'] = draft.templates;
  if (draft.cadence !== rule.cadence) out['cadence'] = draft.cadence;
  if (minute !== rule.cadenceMinute) out['cadenceMinute'] = minute;
  if (draft.weekday !== rule.cadenceWeekday) out['cadenceWeekday'] = draft.weekday;
  if (timezone !== rule.timezone) out['timezone'] = timezone;
  if (draft.windowId !== rule.scheduleId) out['scheduleId'] = draft.windowId;
  if (draft.autoProvision !== rule.autoProvision) out['autoProvision'] = draft.autoProvision;
  if (draft.communityChange === 'replace') out['snmpCommunity'] = draft.community;
  if (draft.communityChange === 'clear') out['snmpCommunity'] = '';
  return out;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * Whether a refused save was refused because somebody else saved first.
 *
 * **412 and nothing else**: HTTP's answer to a failed `If-Match`, and since `L-06` the one every
 * versioned thing gives — rules, objects, maps, reports and libraries. It accepted 409 while maps,
 * reports and libraries answered that, and a 409 is also a clash of names, which reloading does
 * not fix.
 */
export function isStale(error: Pick<ApiError, 'status'>): boolean {
  return error.status === 412;
}

/** `W/"3"`, as the core writes an `ETag` and reads `If-Match`. */
export function ifMatch(rule: Pick<RediscoveryRule, 'version'>): Record<string, string> {
  return { 'if-match': `W/"${String(rule.version)}"` };
}

/**
 * The one line under a rule's name that says what it will do next.
 *
 * A refused firing comes first: a rule that is on and due but refused every time it fires is the
 * state that looks healthy and is not, which is why `A-28` keeps the reason on the rule.
 */
export function ruleStatus(
  rule: Pick<RediscoveryRule, 'enabled' | 'nextRunAt' | 'lastProblem'>,
  format: (iso: string) => string = (iso) => new Date(iso).toLocaleString(),
): { tone: 'problem' | 'on' | 'off'; text: string } {
  if (rule.lastProblem !== '') {
    return {
      tone: 'problem',
      text: `The last time it was due, it did not start: ${rule.lastProblem}`,
    };
  }
  if (!rule.enabled) return { tone: 'off', text: 'Off. It will not run until it is switched on.' };
  if (rule.nextRunAt === null) return { tone: 'problem', text: 'On, but nothing is booked.' };
  return { tone: 'on', text: `Next run ${format(rule.nextRunAt)}.` };
}
