import type { Queryable } from '../db/pool.js';
import { isActiveAt, nextChangeAfter, type ScheduleDefinition } from '../schedules/definition.js';

/** What an installation does with a notification that falls due while its template is inactive. */
export type WhenInactive = 'queue' | 'discard';

export const WHEN_INACTIVE = ['queue', 'discard'] as const satisfies readonly WhenInactive[];

export function isWhenInactive(value: unknown): value is WhenInactive {
  return value === 'queue' || value === 'discard';
}

/** One template that is not accepting messages at this moment, and why. */
export interface Suppression {
  readonly templateId: number;
  readonly scheduleId: number;
  readonly scheduleName: string;
  readonly whenInactive: WhenInactive;
  /** When it comes back, or null for a schedule with no further boundary. */
  readonly activeAt: Date | null;
}

export interface Suppressed {
  /** Templates whose notifications wait for the schedule to reopen. */
  readonly queued: Suppression[];
  /** Templates whose notifications are thrown away instead. */
  readonly discarded: Suppression[];
  /** Every suppressed template id, for a query that only needs to exclude them. */
  readonly templateIds: number[];
}

const NOTHING: Suppressed = { queued: [], discarded: [], templateIds: [] };

interface Row {
  template_id: string;
  template_name: string;
  when_inactive: string;
  schedule_id: string;
  schedule_name: string;
  periods: { start: number; end: number }[];
  polarity: 'active' | 'inactive';
  timezone: string | null;
}

/**
 * Which templates are switched off by the clock right now (`N-12`).
 *
 * **Evaluated at delivery rather than when the alarm is queued, and that is the useful reading of
 * the feature.** An operator setting a template to office hours is saying "do not send me this
 * outside office hours" — about the *message*, not about the outage. A notification queued at
 * 17:59 and delivered at 18:01 is an out-of-hours message and is treated as one.
 *
 * **In TypeScript rather than SQL, deliberately.** A schedule is a statement about local time
 * with its own IANA zone (`M-09`), evaluated through `Intl` so office hours move with daylight
 * saving. Reimplementing that in SQL would be a second answer to the same question, and the two
 * would disagree twice a year — on exactly the nights nobody is awake to notice. An installation
 * has tens of templates, so asking in TypeScript costs one small query per pass.
 */
export class TemplateActivation {
  /**
   * The templates that are inactive at `now`.
   *
   * Only the ones with a schedule are read at all, which is a partial index and almost always
   * an empty result.
   */
  async suppressed(q: Queryable, now: Date): Promise<Suppressed> {
    const rows = await q.query<Row>(
      `SELECT t.id::text AS template_id, t.name AS template_name, t.when_inactive,
              s.id::text AS schedule_id, s.name AS schedule_name,
              s.periods, s.polarity, s.timezone
       FROM notification_template t
       JOIN schedule s ON s.id = t.schedule_id
       WHERE t.schedule_id IS NOT NULL`,
    );
    if (rows.length === 0) return NOTHING;

    const queued: Suppression[] = [];
    const discarded: Suppression[] = [];
    for (const row of rows) {
      const definition: ScheduleDefinition = {
        periods: row.periods,
        polarity: row.polarity,
        timezone: row.timezone,
      };
      if (isActiveAt(definition, now)) continue;
      const suppression: Suppression = {
        templateId: Number(row.template_id),
        scheduleId: Number(row.schedule_id),
        scheduleName: row.schedule_name,
        whenInactive: isWhenInactive(row.when_inactive) ? row.when_inactive : 'queue',
        activeAt: nextChangeAfter(definition, now),
      };
      if (suppression.whenInactive === 'discard') discarded.push(suppression);
      else queued.push(suppression);
    }

    return {
      queued,
      discarded,
      templateIds: [...queued, ...discarded].map((one) => one.templateId),
    };
  }
}

/** What goes in `last_error` for a discarded notification, which is not an error. */
export function discardReason(suppression: Suppression): string {
  const until =
    suppression.activeAt === null ? '' : `; it is active again at ${suppression.activeAt.toISOString()}`;
  return `discarded: the template is outside its "${suppression.scheduleName}" schedule${until}`;
}
