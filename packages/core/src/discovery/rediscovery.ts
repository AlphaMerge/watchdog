import type { Visibility } from '../auth/access.js';
import type { Logger } from '@ms/shared';
import type { DiscoveryLevel } from '@ms/shared';
import { isActiveAt, type ScheduleDefinition } from '../schedules/definition.js';
import {
  cadenceProblems,
  describeCadence,
  nextRun,
  type Cadence,
  type CadenceSpec,
} from '../schedules/cadence.js';
import type { Database } from '../db/pool.js';
import type { Actor, AuditSink, RediscoveryScheduleAudit } from '../objects/audit.js';
import { DiscoveryError } from './errors.js';
import type { DiscoveryService } from './service.js';

/**
 * Rediscovery schedules (`D-07`).
 *
 * **A schedule is a stencil, not a run.** It holds the parameters — range, level, community,
 * template filter — and each firing creates an ordinary `discovery_run` that behaves exactly
 * like one somebody started by hand. Nothing downstream has to know a run was scheduled, which
 * is what keeps `D-01` through `D-06` free of a second code path.
 *
 * **Off by default, twice over.** A schedule is created disabled, and `autoProvision` is
 * separately off: with it off, a rediscovery sweeps and identifies and an operator reviews the
 * plan before anything is created. `WORKFLOW.MD §2` is explicit that surprise objects are a
 * support burden, and a monitoring system that invents devices on its own is one an operator
 * stops trusting.
 *
 * **`D-04`'s idempotency is what makes auto-provisioning safe.** Provisioning a rediscovery
 * creates only what is not already there, so the flag genuinely means "the devices that have
 * appeared since" rather than "everything, again".
 */

export interface RediscoverySchedule {
  id: number;
  groupId: number;
  probeId: number;
  name: string;
  enabled: boolean;
  range: string;
  level: DiscoveryLevel;
  templates: string[];
  snmpCommunity: string;
  timeoutMs: number;
  concurrency: number;
  ratePerSecond: number;
  cadence: Cadence;
  cadenceMinute: number;
  cadenceWeekday: number;
  timezone: string | null;
  autoProvision: boolean;
  /** `M-09`'s weekly calendar as a permission window, or null. */
  scheduleId: number | null;
  lastRunAt: string | null;
  lastRunId: number | null;
  nextRunAt: string | null;
  /** `every Sunday at 03:00`. Computed, never stored — one place decides how it reads. */
  description: string;
}

/**
 * Who starts a scheduled run (`A-20`). The system, with the schedule named in the entry: the
 * person answerable for it is whoever created or enabled the schedule, which is its own entry.
 */
const SCHEDULER: Actor = { kind: 'system', component: 'rediscovery' };

export interface RediscoveryOptions {
  db: Database;
  /**
   * Where creating, switching and deleting a schedule is recorded, in the change's own
   * transaction (`A-20`). A schedule is standing configuration that creates objects on a timer.
   */
  audit: AuditSink;
  logger: Logger;
  discovery: DiscoveryService;
  /** `M-09`'s definition for a window, so this never learns how a schedule is stored. */
  windowFor: (scheduleId: number) => Promise<ScheduleDefinition | null>;
  /** Runs provisioning for a finished run. Absent means auto-provisioning cannot happen. */
  provision?: (runId: number) => Promise<void>;
  now?: () => Date;
}

export interface ScheduleInput {
  groupId: number;
  probeId: number;
  name: string;
  range: string;
  cadence: Cadence;
  cadenceMinute?: number;
  cadenceWeekday?: number;
  timezone?: string | null;
  level?: DiscoveryLevel;
  templates?: readonly string[];
  snmpCommunity?: string;
  timeoutMs?: number;
  concurrency?: number;
  ratePerSecond?: number;
  autoProvision?: boolean;
  scheduleId?: number | null;
  enabled?: boolean;
}

export class RediscoveryService {
  readonly #db: Database;
  readonly #audit: AuditSink;
  readonly #logger: Logger;
  readonly #discovery: DiscoveryService;
  readonly #windowFor: RediscoveryOptions['windowFor'];
  readonly #provision: RediscoveryOptions['provision'];
  readonly #now: () => Date;
  #fired = 0;
  #provisioned = 0;
  #skipped = 0;

  constructor(options: RediscoveryOptions) {
    this.#db = options.db;
    this.#audit = options.audit;
    this.#logger = options.logger.child({ component: 'rediscovery' });
    this.#discovery = options.discovery;
    this.#windowFor = options.windowFor;
    this.#provision = options.provision;
    this.#now = options.now ?? ((): Date => new Date());
  }

  stats(): { fired: number; provisioned: number; skipped: number } {
    return { fired: this.#fired, provisioned: this.#provisioned, skipped: this.#skipped };
  }

  async create(input: ScheduleInput, actor: Actor): Promise<RediscoverySchedule> {
    const spec = specOf(input);
    const problems = cadenceProblems(spec);
    if (problems.length > 0) {
      throw new DiscoveryError('DISCOVERY_SCHEDULE_INVALID', problems.join('; '), {
        context: { cadence: spec.cadence },
      });
    }
    // Computed before the insert so a schedule is never enabled with no next run — a row the
    // sweep would ignore for ever while the UI said it was on.
    const next =
      input.enabled === true ? await this.#nextFor(spec, input.scheduleId ?? null) : null;

    return this.#db.tx(async (q) => {
      const rows = await q.query<Record<string, unknown>>(
        `INSERT INTO discovery_schedule
         (group_id, probe_id, name, enabled, range_text, level, templates, snmp_community,
          timeout_ms, concurrency, rate_per_second, cadence, cadence_minute, cadence_weekday,
          timezone, auto_provision, schedule_id, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING *`,
        [
          input.groupId,
          input.probeId,
          input.name,
          input.enabled ?? false,
          input.range,
          input.level ?? 'standard',
          [...(input.templates ?? [])],
          input.snmpCommunity ?? '',
          input.timeoutMs ?? 1_000,
          input.concurrency ?? 32,
          input.ratePerSecond ?? 0,
          input.cadence,
          input.cadenceMinute ?? 0,
          input.cadenceWeekday ?? 0,
          input.timezone ?? null,
          input.autoProvision ?? false,
          input.scheduleId ?? null,
          next,
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new DiscoveryError('DISCOVERY_FAILED', 'the schedule could not be recorded', {
          context: { name: input.name },
        });
      }
      const created = read(row);
      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'discovery.schedule.created',
            objectId: created.groupId,
            scheduleId: created.id,
            after: auditOf(created),
          },
        ],
        this.#now(),
      );
      return created;
    });
  }

  /**
   * Turns a schedule on or off.
   *
   * Enabling computes the next run; disabling clears it, so a schedule that is off cannot be
   * found by the sweep even if something else went wrong.
   */
  async setEnabled(
    id: number,
    enabled: boolean,
    actor: Actor,
  ): Promise<RediscoverySchedule | null> {
    const current = await this.get(id);
    if (current === null) return null;
    const next = enabled ? await this.#nextFor(specOf(current), current.scheduleId) : null;
    return this.#db.tx(async (q) => {
      const before = await q.query<Record<string, unknown>>(
        `SELECT * FROM discovery_schedule WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const beforeRow = before[0];
      if (beforeRow === undefined) return null;
      const rows = await q.query<Record<string, unknown>>(
        `UPDATE discovery_schedule SET enabled = $2, next_run_at = $3, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, enabled, next],
      );
      const row = rows[0];
      if (row === undefined) return null;
      const previous = read(beforeRow);
      const updated = read(row);
      // Switching a schedule to the state it is already in rebooks its next run and changes
      // nothing anybody would look for, so it writes no entry.
      if (previous.enabled !== updated.enabled) {
        await this.#audit.record(
          q,
          actor,
          [
            {
              action: 'discovery.schedule.updated',
              objectId: updated.groupId,
              scheduleId: id,
              before: auditOf(previous),
              after: auditOf(updated),
            },
          ],
          this.#now(),
        );
      }
      return updated;
    });
  }

  async get(id: number): Promise<RediscoverySchedule | null> {
    const rows = await this.#db.query<Record<string, unknown>>(
      `SELECT * FROM discovery_schedule WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : read(row);
  }

  /**
   * The schedules provisioning into groups the reader can see (`A-12`) — a schedule's name, range
   * and cadence describe a branch of somebody's network.
   */
  async list(visibility: Visibility, groupId?: number): Promise<RediscoverySchedule[]> {
    const values: unknown[] = [groupId ?? null];
    const visible = visibility.where('group_id', (value) => `$${String(values.push(value))}`);
    const rows = await this.#db.query<Record<string, unknown>>(
      `SELECT * FROM discovery_schedule
       WHERE ($1::bigint IS NULL OR group_id = $1) AND ${visible}
       ORDER BY id`,
      values,
    );
    return rows.map(read);
  }

  async remove(id: number, actor: Actor): Promise<boolean> {
    return this.#db.tx(async (q) => {
      const rows = await q.query<Record<string, unknown>>(
        `DELETE FROM discovery_schedule WHERE id = $1 RETURNING *`,
        [id],
      );
      const row = rows[0];
      if (row === undefined) return false;
      const removed = read(row);
      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'discovery.schedule.deleted',
            objectId: removed.groupId,
            scheduleId: id,
            before: auditOf(removed),
          },
        ],
        this.#now(),
      );
      return true;
    });
  }

  /**
   * Starts whatever is due, and books the next one.
   *
   * **The next run is booked before the discovery starts**, so a start that throws does not
   * leave the schedule due for ever — which would be a sweep that retried the same failing run
   * every minute rather than once a day. The same reasoning `D-02`'s stall guard came from,
   * arrived at before the failure rather than after it.
   */
  async tick(): Promise<number> {
    const now = this.#now();
    const due = await this.#db.query<Record<string, unknown>>(
      `SELECT * FROM discovery_schedule
       WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1
       ORDER BY next_run_at`,
      [now.toISOString()],
    );

    let started = 0;
    for (const row of due) {
      const schedule = read(row);
      const next = await this.#nextFor(specOf(schedule), schedule.scheduleId, now);
      await this.#db.query(
        `UPDATE discovery_schedule SET next_run_at = $2, updated_at = now() WHERE id = $1`,
        [schedule.id, next],
      );

      try {
        // The schedule rides on the run from its insert, so the run's audit entry can name it.
        const run = await this.#discovery.start(
          {
            groupId: schedule.groupId,
            probeId: schedule.probeId,
            range: schedule.range,
            level: schedule.level,
            templates: schedule.templates,
            snmpCommunity: schedule.snmpCommunity,
            timeoutMs: schedule.timeoutMs,
            concurrency: schedule.concurrency,
            ratePerSecond: schedule.ratePerSecond,
            scheduleId: schedule.id,
          },
          SCHEDULER,
        );
        await this.#db.query(
          `UPDATE discovery_schedule SET last_run_at = now(), last_run_id = $2 WHERE id = $1`,
          [schedule.id, run.id],
        );
        this.#fired += 1;
        started += 1;
        this.#logger.info(
          { scheduleId: schedule.id, runId: run.id, range: schedule.range, nextRunAt: next },
          'rediscovery started',
        );
      } catch (error) {
        // The schedule keeps its booking either way. A group that was deleted, a probe that was
        // removed — both are ordinary and neither should stop the other schedules in this tick.
        this.#logger.error(
          { scheduleId: schedule.id, err: error instanceof Error ? error.message : 'unknown' },
          'a rediscovery could not be started',
        );
      }
    }
    return started;
  }

  /**
   * Provisions a finished run, if the schedule that started it said to.
   *
   * Called when a run reaches `done`. **Only for a run a schedule started**: a run somebody
   * started by hand is theirs to provision, and doing it for them would be creating objects
   * nobody asked for — which is the exact thing this whole ticket is careful about.
   */
  async runFinished(runId: number): Promise<boolean> {
    const rows = await this.#db.query<{ auto_provision: boolean }>(
      `SELECT s.auto_provision
       FROM discovery_run r JOIN discovery_schedule s ON s.id = r.schedule_id
       WHERE r.id = $1`,
      [runId],
    );
    const schedule = rows[0];
    if (schedule === undefined) return false;
    if (!schedule.auto_provision) {
      // Sweeping and identifying without creating is the *point* of the flag being off: the
      // plan is there for an operator to look at, and `GET /discovery/:id/plan` is how.
      this.#skipped += 1;
      return false;
    }
    if (this.#provision === undefined) return false;

    await this.#provision(runId);
    this.#provisioned += 1;
    this.#logger.info({ runId }, 'a scheduled rediscovery provisioned what it found');
    return true;
  }

  /** The next firing, honouring a permission window when one is attached. */
  async #nextFor(
    spec: CadenceSpec,
    scheduleId: number | null,
    from?: Date,
  ): Promise<string | null> {
    const start = from ?? this.#now();
    if (scheduleId === null) {
      // A minute past, so a schedule enabled at exactly its firing time books the *next* one
      // rather than firing immediately — which would surprise somebody who enabled it at 03:00.
      return nextRun(spec, new Date(start.getTime() + 60_000))?.toISOString() ?? null;
    }
    const definition = await this.#windowFor(scheduleId);
    if (definition === null) {
      // The window is gone. Booking without it is the safer of the two wrongs: a rediscovery
      // that runs when it should not is visible, and one that silently never runs again is not.
      this.#logger.warn({ scheduleId }, 'the permission window is missing; booking without it');
      return nextRun(spec, new Date(start.getTime() + 60_000))?.toISOString() ?? null;
    }
    return (
      nextRun(spec, new Date(start.getTime() + 60_000), (at) =>
        isActiveAt(definition, at),
      )?.toISOString() ?? null
    );
  }
}

function specOf(input: {
  cadence: Cadence;
  cadenceMinute?: number;
  cadenceWeekday?: number;
  timezone?: string | null;
}): CadenceSpec {
  return {
    cadence: input.cadence,
    minute: input.cadenceMinute ?? 0,
    weekday: input.cadenceWeekday ?? 0,
    timezone: input.timezone ?? null,
  };
}

function read(row: Record<string, unknown>): RediscoverySchedule {
  const spec: CadenceSpec = {
    cadence: row['cadence'] as Cadence,
    minute: Number(row['cadence_minute']),
    weekday: Number(row['cadence_weekday']),
    timezone: typeof row['timezone'] === 'string' ? row['timezone'] : null,
  };
  return {
    id: Number(row['id']),
    groupId: Number(row['group_id']),
    probeId: Number(row['probe_id']),
    name: String(row['name']),
    enabled: row['enabled'] === true,
    range: String(row['range_text']),
    level: row['level'] as DiscoveryLevel,
    templates: Array.isArray(row['templates']) ? (row['templates'] as string[]) : [],
    snmpCommunity: typeof row['snmp_community'] === 'string' ? row['snmp_community'] : '',
    timeoutMs: Number(row['timeout_ms']),
    concurrency: Number(row['concurrency']),
    ratePerSecond: Number(row['rate_per_second']),
    cadence: spec.cadence,
    cadenceMinute: spec.minute,
    cadenceWeekday: spec.weekday,
    timezone: spec.timezone,
    autoProvision: row['auto_provision'] === true,
    scheduleId: row['schedule_id'] == null ? null : Number(row['schedule_id']),
    lastRunAt: row['last_run_at'] == null ? null : iso(row['last_run_at']),
    lastRunId: row['last_run_id'] == null ? null : Number(row['last_run_id']),
    nextRunAt: row['next_run_at'] == null ? null : iso(row['next_run_at']),
    description: describeCadence(spec),
  };
}

/**
 * A schedule as the audit log records it (`A-20`): the cadence as the sentence the UI shows, and
 * the community as whether there is one, never as itself.
 */
function auditOf(schedule: RediscoverySchedule): RediscoveryScheduleAudit {
  return {
    name: schedule.name,
    probeId: schedule.probeId,
    range: schedule.range,
    level: schedule.level,
    templates: schedule.templates.join(', '),
    community: schedule.snmpCommunity !== '',
    cadence: schedule.description,
    timezone: schedule.timezone ?? '',
    window: schedule.scheduleId,
    autoProvision: schedule.autoProvision,
    enabled: schedule.enabled,
    timeoutMs: schedule.timeoutMs,
    concurrency: schedule.concurrency,
    ratePerSecond: schedule.ratePerSecond,
  };
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
