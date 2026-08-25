import {
  parsePeriods,
  type ScheduleAuthoring,
  type SchedulePolarity,
  type WeekInterval,
} from './definition.js';

/**
 * The schedules this build ships (`M-09`).
 *
 * A starting set, not a catalogue: every one of them is something an operator would otherwise
 * have to author on their first day, and between them they demonstrate both authoring modes and
 * both polarities — which is the other reason they exist, because "how do I say *not* at the
 * weekend" is answered by opening one of these rather than by reading the field reference.
 *
 * Seeded at startup by id, and never updated afterwards. An operator who edits "Weekdays" keeps
 * their edit across every restart and upgrade; what the id buys is a `built_in_id` the delete
 * path can refuse, so the documented set is always there to point at.
 */
export interface BuiltInSchedule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly polarity: SchedulePolarity;
  readonly authoredAs: ScheduleAuthoring;
  /** In the text form, because that is what a person reads when they check this file. */
  readonly periods: string;
}

const DEFINITIONS: readonly BuiltInSchedule[] = [
  {
    id: 'weekdays',
    name: 'Weekdays',
    description: 'Monday to Friday, around the clock. Nothing is monitored at the weekend.',
    polarity: 'active',
    authoredAs: 'grid',
    periods: 'mo:00:00-sa:00:00',
  },
  {
    id: 'weekends',
    name: 'Weekends',
    description: 'Saturday and Sunday only.',
    polarity: 'active',
    authoredAs: 'grid',
    periods: 'sa:00:00-su:24:00',
  },
  {
    id: 'office-hours',
    name: 'Office hours (Mon–Fri 08:00–18:00)',
    description:
      'The hours somebody is there to answer an alarm. Everything outside them is a pause, ' +
      'so an overnight failure is reported when the office opens rather than at 03:00.',
    polarity: 'active',
    authoredAs: 'grid',
    periods:
      'mo:08:00-mo:18:00 tu:08:00-tu:18:00 we:08:00-we:18:00 th:08:00-th:18:00 fr:08:00-fr:18:00',
  },
  {
    id: 'nights-and-weekends',
    name: 'Nights and weekends (18:00–08:00)',
    description:
      'The complement of office hours: batch windows, backups and overnight jobs, watched ' +
      'when nobody is using the systems they run on.',
    polarity: 'active',
    authoredAs: 'grid',
    periods:
      'mo:00:00-mo:08:00 mo:18:00-tu:08:00 tu:18:00-we:08:00 we:18:00-th:08:00 ' +
      'th:18:00-fr:08:00 fr:18:00-mo:00:00',
  },
  {
    id: 'weekend-maintenance',
    name: 'Weekend maintenance window (Fri 19:00 – Mon 06:00)',
    description:
      'Monitored at all times except the maintenance window. Written as the period to skip, ' +
      'which is how a change freeze is described in the change request it comes from.',
    polarity: 'inactive',
    authoredAs: 'periods',
    periods: 'fr:19:00-mo:06:00',
  },
];

export interface SeedSchedule extends Omit<BuiltInSchedule, 'periods'> {
  readonly periods: readonly WeekInterval[];
}

/**
 * The built-ins, parsed.
 *
 * Parsed here rather than written as intervals, so the file above stays readable and the
 * definitions go through exactly the validation an operator's own schedule does. A malformed
 * built-in throws at import: it would be a mistake in this file, and shipping a broken
 * schedule that only fails when somebody assigns it is worse than not starting.
 */
export function builtInSchedules(): SeedSchedule[] {
  return DEFINITIONS.map((definition) => {
    const parsed = parsePeriods(definition.periods);
    if ('problems' in parsed) {
      throw new Error(
        `the built-in schedule "${definition.id}" is malformed: ${parsed.problems.join('; ')}`,
      );
    }
    return { ...definition, periods: parsed.periods };
  });
}
