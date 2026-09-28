import type { Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';
import type { Visibility } from '../auth/access.js';
import type { Actor, AuditSink, ScheduleAudit } from '../objects/audit.js';
import { ObjectError } from '../objects/errors.js';
import { builtInSchedules } from './built-in.js';
import {
  formatPeriods,
  gridToIntervals,
  isActiveAt,
  isKnownTimeZone,
  nextChangeAfter,
  normaliseIntervals,
  parsePeriods,
  toGrid,
  validateDefinition,
  zoneOf,
  type ScheduleAuthoring,
  type ScheduleDefinition,
  type ScheduleGrid,
  type SchedulePolarity,
} from './definition.js';
import { ScheduleRepository, type ScheduleWrite, type StoredSchedule } from './repository.js';

export interface ScheduleServiceOptions {
  db: Database;
  audit: AuditSink;
  logger: Logger;
  repository?: ScheduleRepository;
}

/** What a client sends. Exactly one of `periods` and `grid` — two would be two answers. */
export interface ScheduleInput {
  readonly name: string;
  readonly description?: string;
  /**
   * Ignored when a `grid` is given: the grid's marked cells are the monitored hours already
   * (`P-127`). Meaningful only alongside `periods`.
   */
  readonly polarity?: SchedulePolarity;
  readonly timezone?: string | null;
  /** The text form, `ww:hh:mm-ww:hh:mm` separated by spaces or commas. */
  readonly periods?: string;
  /** `grid[day][hour]`, Monday first. */
  readonly grid?: ScheduleGrid;
}

/** A schedule as the API serves it: what it is, and what it means right now. */
export interface ScheduleView {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly polarity: SchedulePolarity;
  readonly authoredAs: ScheduleAuthoring;
  readonly timezone: string | null;
  /** The zone it is actually read in, once `null` has been resolved to the core's own. */
  readonly effectiveTimezone: string;
  readonly periods: string;
  readonly grid: boolean[][];
  /** False when the periods have minute-level edges the hourly grid cannot draw exactly. */
  readonly gridIsExact: boolean;
  readonly builtIn: boolean;
  /** Whether this schedule is monitoring at the moment it was asked. */
  readonly active: boolean;
  /** When that answer next changes, or `null` for a schedule that never does. */
  readonly nextChangeAt: string | null;
  /** How many objects assign it directly. */
  readonly usedBy: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Creating, editing and deleting schedules (`M-09`).
 *
 * Beside `ObjectService` rather than inside it, because a schedule is not in the object tree:
 * it has no parent, no children, no position among siblings and no state. What it shares with
 * an object is the audit sink, which is how a schedule edit reaches the probes and the sensors
 * it affects — `ScheduleSync` rides the same sink and recomputes the pause flags inside this
 * service's own transaction.
 */
export class ScheduleService {
  readonly #db: Database;
  readonly #repo: ScheduleRepository;
  readonly #audit: AuditSink;
  readonly #logger: Logger;

  constructor(options: ScheduleServiceOptions) {
    this.#db = options.db;
    this.#repo = options.repository ?? new ScheduleRepository();
    this.#audit = options.audit;
    this.#logger = options.logger.child({ component: 'schedules' });
  }

  /**
   * Inserts the schedules this build ships, once.
   *
   * Insert-if-absent by built-in id, never update: an operator who narrows "Office hours" to
   * 09:00–17:00 keeps that across every restart and upgrade. A build that adds a new built-in
   * gets it on the next start; one that changes an existing built-in's definition changes it
   * for new installations only, which is the honest behaviour — silently rewriting a schedule
   * somebody is relying on would move when several thousand sensors are watched.
   */
  async seedBuiltIns(): Promise<number> {
    let inserted = 0;
    await this.#db.tx(async (q) => {
      for (const schedule of builtInSchedules()) {
        const created = await this.#repo.seed(
          q,
          {
            name: schedule.name,
            description: schedule.description,
            authoredAs: schedule.authoredAs,
            definition: {
              periods: schedule.periods,
              polarity: schedule.polarity,
              timezone: null,
            },
          },
          schedule.id,
        );
        if (created) inserted += 1;
      }
    });
    if (inserted > 0) this.#logger.info({ inserted }, 'built-in schedules seeded');
    return inserted;
  }

  /** `usedBy` counts only the objects the reader can see (`A-12`). */
  async list(visibility: Visibility, now = new Date()): Promise<ScheduleView[]> {
    const [schedules, usage] = await Promise.all([
      this.#repo.list(this.#db),
      this.#repo.usageCounts(this.#db, visibility),
    ]);
    return schedules.map((schedule) => toView(schedule, usage.get(schedule.id) ?? 0, now));
  }

  /**
   * One schedule. `usedBy` is the count `list` would give it — which it was not: this took the
   * length of `usedBy`'s fifty-row page, the mistake `P-129` fixed for the delete refusal, and
   * counted objects in every branch (`A-12`).
   */
  async get(id: number, visibility: Visibility, now = new Date()): Promise<ScheduleView> {
    const schedule = await this.#repo.get(this.#db, id);
    if (schedule === null) throw notFound(id);
    const usage = await this.#repo.usageCounts(this.#db, visibility);
    return toView(schedule, usage.get(id) ?? 0, now);
  }

  async create(actor: Actor, input: ScheduleInput, now = new Date()): Promise<ScheduleView> {
    const write = this.#parse(input);
    return this.#db.tx(async (q) => {
      const id = await this.#repo.create(q, write, null);
      await this.#audit.record(
        q,
        actor,
        [{ action: 'schedule.created', objectId: null, scheduleId: id, after: auditOf(write) }],
        now,
      );
      const created = await this.#repo.get(q, id);
      if (created === null) throw notFound(id);
      return toView(created, 0, now);
    });
  }

  /**
   * Replaces a schedule.
   *
   * Whole-document, not a patch: a schedule is five fields and a period list, and a partial
   * update of a period list is a merge nobody can define — is a period that is absent removed,
   * or unmentioned? The editor holds the whole thing anyway.
   *
   * `usedBy` in the answer is `get`'s count, among what the caller can see (`A-25`). It was the
   * length of `usedBy`'s fifty-row page over every branch — the mistake `P-129` fixed for the
   * delete refusal and `A-12` fixed for `get`, left here.
   */
  async update(
    actor: Actor,
    id: number,
    input: ScheduleInput,
    visibility: Visibility,
    now = new Date(),
  ): Promise<ScheduleView> {
    const write = this.#parse(input);
    return this.#db.tx(async (q) => {
      const before = await this.#repo.get(q, id);
      if (before === null) throw notFound(id);

      await this.#repo.update(q, id, write);
      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'schedule.updated',
            objectId: null,
            scheduleId: id,
            before: auditOf(toWrite(before)),
            after: auditOf(write),
          },
        ],
        now,
      );

      const after = await this.#repo.get(q, id);
      if (after === null) throw notFound(id);
      const usage = await this.#repo.usageCounts(q, visibility);
      return toView(after, usage.get(id) ?? 0, now);
    });
  }

  /**
   * Deletes a schedule, unless something still points at it.
   *
   * `object_setting.value` is jsonb and cannot carry a foreign key, so the check is here rather
   * than in the schema — and it names the objects rather than counting them, because "3 objects
   * still use this" is a refusal nobody can act on.
   *
   * A built-in is never deletable. It costs nothing to keep, the documented set is what the
   * field reference points at, and an installation that has deleted "Weekdays" has a manual
   * that is wrong.
   */
  async delete(actor: Actor, id: number, now = new Date()): Promise<void> {
    await this.#db.tx(async (q) => {
      const before = await this.#repo.get(q, id);
      if (before === null) throw notFound(id);

      if (before.builtInId !== null) {
        throw new ObjectError(
          'OBJECT_NOT_DELETABLE',
          `"${before.name}" is a built-in schedule; edit it instead of deleting it`,
          { context: { phase: 'schedules' }, details: { scheduleId: id } },
        );
      }

      const users = await this.#repo.usedBy(q, id);
      if (users.length > 0) {
        // **The count, not the page's length** (`P-129`). `usedBy` returns fifty rows, so a
        // schedule assigned to two hundred objects said "assigned to 50 object(s)". The operator
        // clears fifty, tries again, and is told fifty again.
        const total = await this.#repo.usedByCount(q, id);
        throw new ObjectError(
          'OBJECT_NOT_DELETABLE',
          `"${before.name}" is still assigned to ${String(total)} object(s); ` +
            'clear the assignment first',
          {
            context: { phase: 'schedules' },
            details: { scheduleId: id, usedBy: users, usedByTotal: total },
          },
        );
      }

      const templates = await this.#repo.templatesUsing(q, id);
      if (templates.length > 0) {
        throw new ObjectError(
          'OBJECT_NOT_DELETABLE',
          `"${before.name}" is still the activation schedule of ` +
            `${String(templates.length)} notification template(s)`,
          {
            context: { phase: 'schedules' },
            details: { scheduleId: id, usedByTemplates: templates },
          },
        );
      }

      // **The third user of a schedule, and the one nothing was checking** (`P-130`). A
      // rediscovery rule's permitted window is a `RESTRICT` foreign key, so the delete reached
      // the database and came back as a constraint violation — a 500 with a constraint name in
      // it, for an operator doing something ordinary and correctable. Named, like the other two.
      const rediscovery = await this.#repo.rediscoveryUsing(q, id);
      if (rediscovery.length > 0) {
        throw new ObjectError(
          'OBJECT_NOT_DELETABLE',
          `"${before.name}" is still the permitted window of ` +
            `${String(rediscovery.length)} rediscovery rule(s)`,
          {
            context: { phase: 'schedules' },
            details: { scheduleId: id, usedByRediscovery: rediscovery },
          },
        );
      }

      await this.#repo.delete(q, id);
      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'schedule.deleted',
            objectId: null,
            scheduleId: id,
            before: auditOf(toWrite(before)),
          },
        ],
        now,
      );
    });
  }

  /**
   * Turns what a client sent into what gets stored, or says why it cannot.
   *
   * Both authoring modes land here and normalise into the same intervals, so a schedule
   * authored as a grid and the same schedule typed as periods are the same rows — which is
   * what makes the evaluator, the sweep and the round-trip test possible at all.
   */
  #parse(input: ScheduleInput): ScheduleWrite {
    const problems: string[] = [];
    const name = input.name.trim();
    if (name === '') problems.push('a schedule needs a name');

    const hasPeriods = input.periods !== undefined && input.periods.trim() !== '';
    const hasGrid = input.grid !== undefined;
    if (hasPeriods === hasGrid) {
      problems.push(
        hasGrid
          ? 'give either periods or a grid, not both — two authorings of one schedule cannot ' +
              'both be the answer'
          : 'give the periods, either as text or as a grid',
      );
    }

    let periods = input.grid === undefined ? [] : gridToIntervals(input.grid);
    let authoredAs: ScheduleAuthoring = hasGrid ? 'grid' : 'periods';
    if (hasPeriods && !hasGrid) {
      const parsed = parsePeriods(input.periods ?? '');
      if ('problems' in parsed) problems.push(...parsed.problems);
      else periods = parsed.periods;
      authoredAs = 'periods';
    }

    const timezone = input.timezone ?? null;
    if (timezone !== null && !isKnownTimeZone(timezone)) {
      problems.push(`"${timezone}" is not a time zone this system knows`);
    }

    const definition: ScheduleDefinition = {
      periods: normaliseIntervals(periods),
      // **A grid is always `active`, whatever polarity came with it** (`P-127`). The grid's marked
      // cells *are* the monitored hours — `toGrid` applies the polarity on the way out, so a
      // schedule stored as "inactive during these periods" is served as a grid of the hours it
      // does monitor. A client that read that view and sent it back unchanged, which is what a
      // form does, was storing the monitored hours as the *inactive* ones: a maintenance window
      // became the only time anything was watched, and the round trip did it silently.
      //
      // Polarity is not a second degree of freedom on top of a grid; it is the thing the grid has
      // already resolved. An operator who wants to express the complement types the periods.
      //
      // **Which makes `polarity` a field of `periods`, and the contract now says so** (`R19`).
      // It did not: `POST /schedules` and `ms:scheduleInput` both advertised the enum with no
      // qualification, so a client written to the documented contract — a grid of six days with
      // `polarity: 'inactive'`, meaning "pause during these" — was answered 201 and stored as
      // "monitor only during these", the exact complement of what it asked for.
      //
      // Refusing that combination was the other option and is the wrong one here: a schedule
      // stored as `inactive` periods is *served* as `polarity: 'inactive'` alongside a grid of
      // the hours it does monitor, so the round trip this coercion exists for sends exactly
      // that pair. Refusing it would break the case `P-127` fixed. The documentation is what
      // was wrong.
      polarity: hasGrid ? 'active' : (input.polarity ?? 'active'),
      timezone,
    };
    if (problems.length === 0) problems.push(...validateDefinition(definition));

    if (problems.length > 0) {
      throw new ObjectError('OBJECT_INVALID', 'this schedule cannot be saved', {
        context: { phase: 'schedules' },
        details: { problems },
      });
    }

    return {
      name,
      description: input.description?.trim() ?? '',
      authoredAs,
      definition,
    };
  }
}

function notFound(id: number): ObjectError {
  return new ObjectError('OBJECT_NOT_FOUND', `no schedule ${String(id)}`, {
    context: { phase: 'schedules' },
    details: { scheduleId: id },
  });
}

function toWrite(schedule: StoredSchedule): ScheduleWrite {
  return {
    name: schedule.name,
    description: schedule.description,
    authoredAs: schedule.authoredAs,
    definition: schedule.definition,
  };
}

function auditOf(write: ScheduleWrite): ScheduleAudit {
  return {
    name: write.name,
    description: write.description,
    polarity: write.definition.polarity,
    timezone: write.definition.timezone,
    periods: formatPeriods(write.definition.periods),
  };
}

function toView(schedule: StoredSchedule, usedBy: number, now: Date): ScheduleView {
  const { grid, exact } = toGrid(schedule.definition);
  return {
    id: schedule.id,
    name: schedule.name,
    description: schedule.description,
    polarity: schedule.definition.polarity,
    authoredAs: schedule.authoredAs,
    timezone: schedule.definition.timezone,
    effectiveTimezone: zoneOf(schedule.definition),
    periods: formatPeriods(schedule.definition.periods),
    grid,
    gridIsExact: exact,
    builtIn: schedule.builtInId !== null,
    active: isActiveAt(schedule.definition, now),
    nextChangeAt: nextChangeAfter(schedule.definition, now)?.toISOString() ?? null,
    usedBy,
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
  };
}
