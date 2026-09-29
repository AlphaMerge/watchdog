import {
  levelDefinition,
  parseIpRange,
  type Fingerprint,
  type IdentifyJob,
  type SweepEnding,
  type SweepHost,
  type SweepJob,
} from '@ms/shared';
import type { DiscoveryLevel, Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';
import type { Actor, AuditSink } from '../objects/audit.js';
import type { ProbeRefusals } from '../probes/refusals.js';
import { DiscoveryError } from './errors.js';
import { readFingerprint } from './fingerprint.js';
import { isUnderProbe, requireGroupProbe } from './scope.js';
import { describeRun, type DiscoverySummary } from './summary.js';

/**
 * Discovery runs, from the core's side (`D-01`).
 *
 * **The core owns the cursor and the probe owns the pinging**, and that split is the whole
 * design. A sweep has to survive a probe restart, a reconnect and a core failover; the only
 * thing that survives all three is a row. So the probe reports how far it has got, the core
 * writes it, and a resume is the core sending back what it last wrote. Re-sweeping a few
 * addresses is free — the unique key on `(run_id, address)` makes a repeated host a no-op — so
 * the cursor is advanced *after* the hosts in the same message are stored, never before.
 *
 * **A run is assigned to a probe, not to whichever one is free.** Discovery is a
 * local-network job: the probe that can reach `10.0.0.0/24` is the one on that network, and
 * `WORKFLOW.MD §14` already says local-only checks belong to the probe that can see them.
 *
 * **Only one run per probe at a time.** Two sweeps from one probe would each stand down for the
 * other's traffic and for live checks, and the operator's mental model — "discovery is running"
 * — has no room for two. A second run queues.
 */

/** One address a run found, and what it turned out to be. */
export interface DiscoveredHost {
  address: string;
  rttMs: number | null;
  /** Null until `D-02` has identified it, and for a run at `level: 'ping'`. */
  fingerprint: Fingerprint | null;
}

/**
 * Why a run a deleted rule started creates nothing (`A-41`): nobody stands behind the addresses
 * it found any more.
 */
export const RULE_DELETED = 'its rule was deleted';

/**
 * Why a run whose group moved under another probe creates nothing (`P-241`): what it found was
 * read from the old probe's network, and the group's devices now live on the new one's.
 */
export const GROUP_MOVED = 'its group moved to another probe';

/** Who fails a run the core found out of place while offering it, with nobody asking. */
const DISCOVERY: Actor = { kind: 'system', component: 'discovery' };

export interface DiscoveryRunRow {
  id: number;
  groupId: number;
  probeId: number;
  range: string;
  total: number;
  cursor: number;
  found: number;
  failed: number;
  status: 'queued' | 'running' | 'identifying' | 'done' | 'cancelled' | 'failed';
  /** How hard this run looks (`D-06`). `ping` stops after the sweep. */
  level: DiscoveryLevel;
  /** Which templates provisioning may use, empty meaning all of them (`D-06`). */
  templates: string[];
  identified: number;
  identifyCursor: number;
  /**
   * The rediscovery schedule that started this run, or null for one somebody started (`D-07`).
   *
   * On the row rather than only in `discovery_schedule.last_run_id`, because the question is
   * asked from the run's end: an operator looking at a run they did not start wants to know
   * where it came from, and a schedule holds only its most recent one.
   *
   * **Deleting the schedule takes this with it** — the column is `ON DELETE SET NULL`, so runs
   * a deleted schedule made read as operator-started from then on. That is the wrong half of a
   * trade with no cheap right answer here: `RESTRICT` would make a schedule undeletable once it
   * had ever run, and dropping the foreign key would leave an id pointing at nothing an
   * operator could look up. Recording the schedule's *name* on the run at firing time is the
   * fix, and it is a migration rather than a comment; noted here so it is a known limitation
   * rather than a surprise.
   */
  scheduleId: number | null;
  /**
   * The account that started the run, or null for the system and for an installation with no
   * accounts (`A-20`). It vouches for where the run's credentials go (`A-41`).
   */
  createdBy: number | null;
  snmpCommunity: string;
  devicesCreated: number;
  devicesMatched: number;
  sensorsCreated: number;
  provisionedAt: string | null;
  message: string;
  timeoutMs: number;
  concurrency: number;
  ratePerSecond: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * The slice of the database this service uses.
 *
 * Structural rather than the concrete `Database`, so the tests can drive it with a stub and so
 * nothing here can reach for a transaction or a listener it has no business with.
 */

export interface DiscoveryServiceOptions {
  db: Database;
  /**
   * Where starting and stopping a run is recorded, in the run's own transaction (`A-20`).
   *
   * Required: a sweep sends traffic across somebody's network with a credential, and "who started
   * that?" is asked after the fact — sometimes after the group the run belonged to, and the run
   * with it, has been deleted.
   */
  audit: AuditSink;
  logger: Logger;
  /**
   * Sends a message to a connected probe.
   *
   * **Three answers, not two** (`R-06`). `offline` means wait — the run is offered again on
   * reconnect, which is also how a probe restart resumes a sweep. `too-old` means this probe
   * will never accept the message, and a run left queued against it waits forever with nothing
   * said, which is the failure `R-06` names.
   */
  dispatch: (probeId: number, message: DispatchMessage) => SweepDelivery;
  /**
   * Told when a run reaches `done`, so `D-07` can provision one it scheduled.
   *
   * A callback rather than this service knowing about rediscovery: a run does not care why it
   * was started, and giving it a reason to would put a scheduling concern inside the thing that
   * sweeps a network.
   */
  onFinished?: (runId: number) => Promise<void>;
  /** Where a message about another probe's run is counted, for Probe Health (`P-228`). */
  refusals?: ProbeRefusals;
}

/**
 * Exactly what the probe endpoint's `sendSweep` answers, mirrored here for the same reason
 * `DispatchMessage` is: this service does not import the transport, and the two declarations
 * meet where `main.ts` wires them, which is where TypeScript checks that they still agree.
 */
export type SweepDelivery =
  | { kind: 'sent' }
  | { kind: 'offline' }
  | { kind: 'too-old'; protocolVersion: number; needs: number };

/** Exactly what the probe endpoint's `sendSweep` takes, so there is one shape and no mapping. */
export type DispatchMessage =
  | { kind: 'start'; job: SweepJob }
  | { kind: 'cancel'; runId: number }
  | { kind: 'identify'; job: IdentifyJob }
  | { kind: 'identify-cancel'; runId: number };

export interface StartRequest {
  groupId: number;
  probeId: number;
  range: string;
  timeoutMs?: number;
  concurrency?: number;
  ratePerSecond?: number;
  level?: DiscoveryLevel;
  snmpCommunity?: string;
  templates?: readonly string[];
  /** The rediscovery schedule starting this run (`D-07`), recorded on the run and its entry. */
  scheduleId?: number;
}

/** How many hosts one `identify-start` names, so a /16 does not become a megabyte of addresses. */
const IDENTIFY_BATCH = 4_096;

/**
 * How many times one batch may be offered without its cursor moving before the run fails.
 *
 * **A liveness bound, added after a live run spun 298 times in three minutes.** A fingerprint
 * that PostgreSQL refused — a NUL byte from a binary banner, `22P05` — made the write throw, so
 * the cursor never advanced; the probe reported the pass finished, this offered the same batch
 * again, and the pair looped as fast as the network allowed. Every layer behaved correctly on
 * its own: the endpoint caught the error rather than dropping the connection, the probe answered
 * every job it was given, and the service resumed from the cursor it had. What was missing was
 * anybody noticing that no progress was being made.
 *
 * Three, because a genuine transient — a lock, a failover — clears in one retry, and a fourth
 * attempt at the same batch is a permanent fault wearing a retry's clothes.
 */
const MAX_STALLED_OFFERS = 3;

export class DiscoveryService {
  readonly #db: Database;
  readonly #audit: AuditSink;
  readonly #logger: Logger;
  readonly #dispatch: DiscoveryServiceOptions['dispatch'];
  readonly #onFinished: DiscoveryServiceOptions['onFinished'];
  readonly #refusals: ProbeRefusals | undefined;
  #started = 0;
  #resumed = 0;
  #hostsStored = 0;
  #identifiedCount = 0;
  #stalled = 0;
  #foreign = 0;
  /** Per run: the cursor an offer was last made at, and how many times from there. */
  readonly #offers = new Map<number, { cursor: number; times: number }>();

  constructor(options: DiscoveryServiceOptions) {
    this.#db = options.db;
    this.#audit = options.audit;
    this.#logger = options.logger.child({ component: 'discovery' });
    this.#dispatch = options.dispatch;
    this.#onFinished = options.onFinished;
    this.#refusals = options.refusals;
  }

  stats(): {
    started: number;
    resumed: number;
    hostsStored: number;
    identified: number;
    /** Runs failed for making no progress. Visible, because a stall that nobody counts recurs. */
    stalled: number;
    /** Messages refused because another probe's run was named in them (`P-228`). */
    foreign: number;
  } {
    return {
      started: this.#started,
      resumed: this.#resumed,
      hostsStored: this.#hostsStored,
      identified: this.#identifiedCount,
      stalled: this.#stalled,
      foreign: this.#foreign,
    };
  }

  /**
   * Whether the probe that sent a message about this run is the one it was dispatched to
   * (`P-228`). Counted and logged when not.
   *
   * **Every path a probe drives goes through this first, and every write after it carries
   * `AND probe_id` as well.** A run's probe never changes once it is recorded, so the check alone
   * would do; the predicate on the writes is there so that a path added later without the check
   * still writes nothing for the wrong probe, and so that the rule can be read off each statement.
   *
   * Before `P-228` the messages named a run and nothing else, and the service updated `WHERE id =
   * $1`: any probe could add hosts to another's run, write the fingerprints provisioning turns
   * into devices, and finish it — which is what provisions it (`D-07`).
   *
   * A run that no longer exists is refused without being foreign: its group was deleted while
   * the probe was still sweeping, which is ordinary.
   */
  async #fromItsProbe(from: number | null, runId: number, what: string): Promise<boolean> {
    const [row] = await this.#db.query<{ probe_id: string }>(
      'SELECT probe_id::text AS probe_id FROM discovery_run WHERE id = $1',
      [runId],
    );
    if (row === undefined) {
      this.#refusals?.refused(from);
      this.#logger.debug({ runId, from, what }, 'a probe reported on a run that no longer exists');
      return false;
    }
    if (from !== null && Number(row.probe_id) === from) return true;
    this.#foreign += 1;
    this.#refusals?.foreign(from);
    this.#logger.warn(
      { runId, what, runProbe: Number(row.probe_id), from },
      'a probe reported on a discovery run dispatched to another probe; refused',
    );
    return false;
  }

  /**
   * Records a run and offers it to its probe.
   *
   * The range is parsed here as well as on the probe — not out of distrust, but because an
   * operator who typed a /8 should be told so while the form is still open, and because `total`
   * has to be right before a progress bar means anything.
   */
  async start(request: StartRequest, actor: Actor): Promise<DiscoveryRunRow> {
    // Throws `IpRangeError` for anything unusable, which the API surfaces as a 400 with the
    // sentence the parser wrote rather than "invalid range".
    const range = parseIpRange(request.range);

    // **`created_by` is filled at last** (`A-20`): the column has existed since migration 025 and
    // nothing wrote it. The audit entry is the durable answer; this is the one the run carries.
    const run = await this.#db.tx(async (q) => {
      await requireGroupProbe(q, request.groupId, request.probeId);
      const rows = await q.query<Record<string, unknown>>(
        `INSERT INTO discovery_run
           (group_id, probe_id, range_text, total, timeout_ms, concurrency, rate_per_second,
            created_by, level, snmp_community, templates, schedule_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          request.groupId,
          request.probeId,
          range.text,
          range.size,
          request.timeoutMs ?? 1_000,
          request.concurrency ?? 32,
          request.ratePerSecond ?? 0,
          actor.kind === 'user' ? actor.userId : null,
          request.level ?? 'standard',
          request.snmpCommunity ?? '',
          [...(request.templates ?? [])],
          request.scheduleId ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new DiscoveryError('DISCOVERY_FAILED', 'the run could not be recorded');
      }
      const created = read(row);
      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'discovery.started',
            objectId: created.groupId,
            runId: created.id,
            probeId: created.probeId,
            range: created.range,
            level: created.level,
            templates: created.templates.join(', '),
            community: created.snmpCommunity !== '',
            scheduleId: created.scheduleId,
          },
        ],
        new Date(),
      );
      return created;
    });

    this.#started += 1;
    this.#logger.info(
      { runId: run.id, range: range.text, total: range.size, probeId: request.probeId },
      'discovery run created',
    );
    // Best effort: a probe that is not connected picks the run up on its next `resume`, which is
    // the same path a probe restart takes. Nothing is lost by the offer failing. After the commit,
    // so a probe is never offered a run that rolled back.
    await this.pump(request.probeId);
    return run;
  }

  /**
   * Offers a probe the run it should be doing, if it is not already doing it.
   *
   * Called when a probe connects and after any change to the queue. Idempotent by construction:
   * sending `sweep-start` for a run the probe is already running supersedes it with the same
   * cursor, which is a no-op the probe reports honestly rather than a duplicate sweep.
   */
  async pump(probeId: number): Promise<void> {
    let run: DiscoveryRunRow;
    // Failed, not offered, when its group has moved under another probe since it started, and
    // the next run in this probe's queue is offered instead. A run found out of place is not
    // selected again, so this ends whatever failing it did to the row.
    const outOfPlace: number[] = [];
    for (;;) {
      const rows = await this.#db.query<Record<string, unknown>>(
        `SELECT * FROM discovery_run
         WHERE probe_id = $1 AND status IN ('queued', 'running', 'identifying')
           AND NOT (id = ANY($2::bigint[]))
         ORDER BY id
         LIMIT 1`,
        [probeId, outOfPlace],
      );
      const row = rows[0];
      if (row === undefined) return;
      run = read(row);
      if (!(await this.failIfGroupMoved(run))) break;
      outOfPlace.push(run.id);
    }

    if (run.status === 'identifying') {
      await this.#offerIdentify(run);
      return;
    }
    const sent = this.#dispatch(run.probeId, {
      kind: 'start',
      job: {
        runId: run.id,
        range: run.range,
        cursor: run.cursor,
        timeoutMs: run.timeoutMs,
        concurrency: run.concurrency,
        ratePerSecond: run.ratePerSecond,
      },
    });
    if (sent.kind === 'too-old') {
      await this.#failForSkew(run.id, 'discovery sweep', sent);
      return;
    }
    if (sent.kind !== 'sent') return;

    if (run.status === 'queued') {
      await this.#db.query(
        `UPDATE discovery_run SET status = 'running', started_at = COALESCE(started_at, now())
         WHERE id = $1 AND status = 'queued'`,
        [run.id],
      );
    } else {
      this.#resumed += 1;
      this.#logger.info({ runId: run.id, cursor: run.cursor }, 'discovery run resumed');
    }
  }

  /**
   * Fails a run whose probe can never accept it, and says which probe and what version (`R-06`).
   *
   * **The alternative is what this replaces: nothing.** A run offered to a probe that is too old
   * stayed `queued`, was offered again on the next pump, was refused again, and reported
   * "waiting for a probe" for as long as anybody left it — a state indistinguishable from a
   * probe that is merely offline and about to come back. Waiting is right for an offline probe
   * and wrong here, because no amount of waiting changes the probe's build.
   */
  async #failForSkew(
    runId: number,
    stage: string,
    delivery: { protocolVersion: number; needs: number },
  ): Promise<void> {
    const message =
      `the probe assigned to this run speaks protocol ${String(delivery.protocolVersion)}, ` +
      `and ${stage} needs ${String(delivery.needs)} — upgrade the probe and start the run again`;
    this.#logger.error({ runId, ...delivery }, 'discovery run failed: the probe is too old');
    await this.#db.query(
      `UPDATE discovery_run SET status = 'failed', message = $2, finished_at = now()
       WHERE id = $1 AND status IN ('queued', 'running', 'identifying')`,
      [runId, message],
    );
    this.#offers.delete(runId);
  }

  /**
   * Stores what a sweep found and moves the cursor.
   *
   * **Hosts first, cursor second, in that order and in one statement each.** A cursor written
   * ahead of the hosts it covers is a host silently missed if the core stops in between — and
   * the run would report itself complete, so nobody would ever know to look.
   *
   * The cursor only ever moves forward. A probe that resumed from an older position and reported
   * it would otherwise walk the run backwards, and the range would be swept twice.
   */
  async progress(
    from: number | null,
    runId: number,
    cursor: number,
    found: readonly SweepHost[],
    failed: number,
  ): Promise<void> {
    if (!(await this.#fromItsProbe(from, runId, 'sweep-progress'))) return;
    if (found.length > 0) {
      // One statement for the batch. `ON CONFLICT DO NOTHING` is what makes a resume free: a
      // replayed address is already there and inserting it again changes nothing.
      const values: unknown[] = [runId, from];
      const tuples = found.map((host, at) => {
        values.push(host.address, host.rttMs);
        return `($${String(at * 2 + 3)}::inet, $${String(at * 2 + 4)}::numeric)`;
      });
      const inserted = await this.#db.query<{ address: string }>(
        `INSERT INTO discovery_host (run_id, address, rtt_ms)
         SELECT $1::bigint, v.address, v.rtt_ms
         FROM (VALUES ${tuples.join(', ')}) AS v(address, rtt_ms)
         WHERE EXISTS (SELECT 1 FROM discovery_run WHERE id = $1 AND probe_id = $2)
         ON CONFLICT (run_id, address) DO NOTHING
         RETURNING host(address) AS address`,
        values,
      );
      this.#hostsStored += inserted.length;
      // `found` counts distinct hosts, so it is incremented by what was actually inserted rather
      // than by what was offered — otherwise a resume inflates the total the summary reports.
      if (inserted.length > 0) {
        await this.#db.query(
          `UPDATE discovery_run SET found = found + $2 WHERE id = $1 AND probe_id = $3`,
          [runId, inserted.length, from],
        );
      }
    }

    await this.#db.query(
      `UPDATE discovery_run
       SET cursor = GREATEST(cursor, $2), failed = failed + $3
       WHERE id = $1 AND probe_id = $4 AND status = 'running'`,
      [runId, cursor, failed, from],
    );
  }

  /**
   * Records how a sweep ended.
   *
   * `cancelled` and `failed` are terminal; `superseded` is not an ending at all — it means a
   * newer `sweep-start` for the same run took over, so the run stays running and the message is
   * dropped. Treating it as an ending would mark a run finished at the moment it restarted.
   */
  async finished(
    from: number | null,
    runId: number,
    ending: SweepEnding,
    cursor: number,
    message: string,
  ): Promise<void> {
    if (ending === 'superseded') return;
    if (!(await this.#fromItsProbe(from, runId, 'sweep-finished'))) return;

    // A sweep that covered its range hands over to identification rather than ending — the two
    // are stages of one run, because an operator starts one discovery and watches one thing
    // finish. `level: 'ping'` is how somebody says they want the addresses and nothing else, and
    // a sweep that found nothing has nothing to identify.
    if (ending === 'done') {
      const run = await this.get(runId);
      if (
        run !== null &&
        run.status === 'running' &&
        levelDefinition(run.level).identify &&
        run.found > 0
      ) {
        // Straight to identification, not through `pump`, so the group is asked about here.
        if (await this.failIfGroupMoved(run)) return;
        await this.#db.query(
          `UPDATE discovery_run SET status = 'identifying', cursor = GREATEST(cursor, $2)
           WHERE id = $1 AND probe_id = $3 AND status = 'running'`,
          [runId, cursor, from],
        );
        const moved = await this.get(runId);
        if (moved !== null) await this.#offerIdentify(moved);
        this.#logger.info({ runId, hosts: run.found }, 'sweep finished; identifying');
        return;
      }
    }

    // A cancelled run goes back to `queued` only if the operator did not ask for the cancel —
    // which is the shutdown case, and is why the probe reports `cancelled` on stop. The
    // difference is recorded in `status` before the message arrives: `cancel()` sets it, so a
    // run still `running` here was stopped by something other than the operator. A run the core
    // failed (`fail()`) keeps its status and its reason: a sweep that finished after its rule was
    // deleted must not come back `done` and be provisioned (`A-41`).
    const ended = await this.#db.query<{ status: DiscoveryRunRow['status'] }>(
      `UPDATE discovery_run
       SET cursor = GREATEST(cursor, $2),
           status = CASE
             WHEN status = 'cancelled' THEN 'cancelled'
             WHEN status = 'failed' THEN 'failed'
             WHEN $3 = 'done' THEN 'done'
             WHEN $3 = 'failed' THEN 'failed'
             ELSE 'queued'
           END,
           message = CASE WHEN status = 'failed' THEN message ELSE $4 END,
           finished_at = CASE WHEN status = 'failed' THEN finished_at
                              WHEN $3 = 'cancelled' AND status <> 'cancelled' THEN NULL
                              ELSE now() END
       WHERE id = $1 AND probe_id = $5
       RETURNING status`,
      [runId, cursor, ending, message, from],
    );
    this.#logger.info({ runId, ending, cursor }, 'discovery run ended');
    if (ending === 'done' && ended[0]?.status !== 'failed') await this.#announceFinished(runId);
  }

  /**
   * Tells whoever is listening that a run is complete.
   *
   * Never lets a listener's failure become the run's: the run *is* finished, the row says so,
   * and a rediscovery that could not provision is a separate problem with its own log line.
   */
  async #announceFinished(runId: number): Promise<void> {
    if (this.#onFinished === undefined) return;
    try {
      await this.#onFinished(runId);
    } catch (error) {
      this.#logger.error(
        { runId, err: error instanceof Error ? error.message : 'unknown' },
        'a listener failed after a discovery run finished',
      );
    }
  }

  /**
   * Offers the hosts a sweep found, from wherever identification has got to.
   *
   * **The addresses are read fresh each time, in the same order every time**, because the cursor
   * is an index into that order. `ORDER BY discovery_host.address` on the `inet` column is what
   * makes it stable — anything else and a resumed pass would identify a different host from the
   * one the cursor was counting.
   */
  async #offerIdentify(run: DiscoveryRunRow): Promise<void> {
    // **A batch offered again and again from the same cursor is not making progress.** See
    // `MAX_STALLED_OFFERS`: the loop this prevents was found live and cost nothing to any
    // individual component, which is exactly why it needs catching here rather than by any of
    // them.
    const seen = this.#offers.get(run.id);
    const times = seen !== undefined && seen.cursor === run.identifyCursor ? seen.times + 1 : 1;
    this.#offers.set(run.id, { cursor: run.identifyCursor, times });
    if (times > MAX_STALLED_OFFERS) {
      this.#stalled += 1;
      this.#offers.delete(run.id);
      this.#logger.error(
        { runId: run.id, cursor: run.identifyCursor, attempts: times },
        'identification is not making progress; failing the run',
      );
      await this.#db.query(
        `UPDATE discovery_run
         SET status = 'failed', finished_at = now(),
             message = 'identification stopped making progress at host ' || identify_cursor ||
                       ' — the core log says why the fingerprints could not be stored'
         WHERE id = $1 AND status = 'identifying'`,
        [run.id],
      );
      return;
    }

    const rows = await this.#db.query<{ address: string }>(
      `SELECT host(address) AS address
       FROM discovery_host WHERE run_id = $1
       ORDER BY discovery_host.address
       OFFSET $2 LIMIT $3`,
      [run.id, run.identifyCursor, IDENTIFY_BATCH],
    );
    if (rows.length === 0) {
      // Nothing left to identify. Recorded here rather than waiting for the probe to say so,
      // because a batch of zero would otherwise be a run that stayed `identifying` for ever.
      const done = await this.#db.query(
        `UPDATE discovery_run SET status = 'done', finished_at = now()
         WHERE id = $1 AND status = 'identifying'
         RETURNING id`,
        [run.id],
      );
      this.#offers.delete(run.id);
      // Only a run this statement finished is announced: one failed or cancelled meanwhile is
      // over for another reason, and announcing it would provision what nobody stands behind.
      if (done.length === 0) return;
      this.#logger.info({ runId: run.id }, 'discovery run finished');
      await this.#announceFinished(run.id);
      return;
    }

    const offered = this.#dispatch(run.probeId, {
      kind: 'identify',
      job: {
        runId: run.id,
        addresses: rows.map((row) => row.address),
        // Zero, not the run's cursor: the batch *is* the remaining work, so the probe counts
        // from the start of what it was handed and the core adds its own offset back on.
        cursor: 0,
        // The level's own budget, not the sweep's: a sweep's timeout is how long to wait for an
        // ICMP echo, and identification's is how long to wait for a TCP handshake, a resolver
        // and an SNMP agent. Conflating them made `detailed` no more patient than `standard`.
        timeoutMs: levelDefinition(run.level).identifyTimeoutMs,
        ports: [...levelDefinition(run.level).ports],
        // Its own bound, far below the sweep's: each host here opens a dozen TCP connections, a
        // UDP socket and a resolver query, and thirty-two of those at once is four hundred file
        // descriptors and a burst that looks exactly like a port scan to anything watching.
        concurrency: 8,
        community: run.snmpCommunity,
      },
    });
    if (offered.kind === 'too-old') {
      await this.#failForSkew(run.id, 'identification', offered);
    }
  }

  /**
   * Stores fingerprints and moves the identification cursor.
   *
   * The probe counts from the start of the batch it was handed, so its cursor is *added* to the
   * one the core holds rather than replacing it — otherwise a resumed pass reporting `40` would
   * walk the run back to its fortieth host.
   */
  async identified(
    from: number | null,
    runId: number,
    batchCursor: number,
    raw: readonly unknown[],
  ): Promise<void> {
    if (!(await this.#fromItsProbe(from, runId, 'identify-progress'))) return;
    // **Validated here, and this is a real boundary rather than a formality.** The wire schema
    // deliberately does not enumerate a fingerprint's fields — the shape grows, and a schema
    // that refused a newer probe's perfectly good answer would defeat the version negotiation —
    // so the check happens where the meaning is known. TypeScript would not have caught the gap
    // either: `DiscoverySink` declares `unknown[]` and this method's parameters are bivariant,
    // so a `Fingerprint[]` signature compiled and would have written whatever arrived straight
    // into a jsonb column that `D-03` then matches templates against.
    const found = raw.map(readFingerprint).filter((one): one is Fingerprint => one !== null);
    if (found.length < raw.length) {
      this.#logger.warn(
        { runId, offered: raw.length, usable: found.length },
        'a probe sent fingerprints this core cannot read',
      );
    }
    if (found.length > 0) {
      // `WHERE h.run_id = $1` rather than a blind update by address: a fingerprint for an address
      // this run never found is a probe answering about the wrong run, and writing it would put a
      // host into a run that never saw it. `fingerprint IS NULL` makes a replay free, the same
      // way the sweep's `ON CONFLICT DO NOTHING` does.
      const values: unknown[] = [runId, from];
      const tuples = found.map((one, at) => {
        values.push(one.address, JSON.stringify(one));
        return `($${String(at * 2 + 3)}::inet, $${String(at * 2 + 4)}::jsonb)`;
      });
      const updated = await this.#db.query<{ address: string }>(
        `UPDATE discovery_host AS h
         SET fingerprint = v.fingerprint
         FROM (VALUES ${tuples.join(', ')}) AS v(address, fingerprint), discovery_run r
         WHERE h.run_id = $1 AND h.address = v.address AND h.fingerprint IS NULL
           AND r.id = h.run_id AND r.probe_id = $2
         RETURNING host(h.address) AS address`,
        values,
      );
      this.#identifiedCount += updated.length;
      if (updated.length > 0) {
        await this.#db.query(
          `UPDATE discovery_run SET identified = identified + $2 WHERE id = $1 AND probe_id = $3`,
          [runId, updated.length, from],
        );
      }
    }

    await this.#db.query(
      `UPDATE discovery_run
       SET identify_cursor = identify_cursor + $2
       WHERE id = $1 AND probe_id = $3 AND status = 'identifying'`,
      [runId, batchCursor, from],
    );
  }

  /**
   * Records how an identification pass ended, and offers the next batch if there is one.
   *
   * A `done` here does not necessarily finish the run: a large sweep is many batches, and the run
   * is only over when a batch comes back empty — which `#offerIdentify` decides, in one place.
   */
  async identifyFinished(
    from: number | null,
    runId: number,
    ending: SweepEnding,
    message: string,
  ): Promise<void> {
    if (ending === 'superseded') return;
    if (!(await this.#fromItsProbe(from, runId, 'identify-finished'))) return;

    if (ending === 'failed') {
      await this.#db.query(
        `UPDATE discovery_run SET status = 'failed', message = $2, finished_at = now()
         WHERE id = $1 AND probe_id = $3 AND status = 'identifying'`,
        [runId, message, from],
      );
      return;
    }
    if (ending === 'cancelled') {
      // The same rule the sweep follows: a probe restarting reports `cancelled` for everything it
      // was doing, and the run stays `identifying` so the next connect resumes it. A run the
      // operator cancelled is already `cancelled`, and this touches nothing.
      return;
    }

    const run = await this.get(runId);
    if (run === null || run.status !== 'identifying') return;
    // The next batch goes straight to the probe too, so a group that moved mid-identification
    // stops it here.
    if (await this.failIfGroupMoved(run)) return;
    await this.#offerIdentify(run);
  }

  /** Asks the probe to stop, and records the operator's decision immediately. */
  async cancel(runId: number, actor: Actor): Promise<DiscoveryRunRow | null> {
    this.#offers.delete(runId);
    // A run that had already finished writes no entry: nothing was stopped.
    const run = await this.#db.tx(async (q) => {
      const rows = await q.query<Record<string, unknown>>(
        `UPDATE discovery_run
         SET status = 'cancelled', finished_at = now()
         WHERE id = $1 AND status IN ('queued', 'running', 'identifying')
         RETURNING *`,
        [runId],
      );
      const row = rows[0];
      if (row === undefined) return null;
      const cancelled = read(row);
      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'discovery.cancelled',
            objectId: cancelled.groupId,
            runId,
            range: cancelled.range,
          },
        ],
        new Date(),
      );
      return cancelled;
    });
    if (run === null) return null;
    // Recorded first, sent second. A cancel the probe never receives — because it is not
    // connected — must still stop the run, or the operator's click did nothing and the sweep
    // resumes the moment the probe comes back.
    // Both stages, rather than whichever the status said: the statement above has already
    // changed it, so it no longer says which stage was running — and a cancel for a stage that
    // was not running is a no-op the probe answers honestly.
    this.#dispatch(run.probeId, { kind: 'cancel', runId });
    this.#dispatch(run.probeId, { kind: 'identify-cancel', runId });
    return run;
  }

  /**
   * Ends a run for a reason the core found, and says which (`A-41`).
   *
   * A run whose rule was deleted fails with "its rule was deleted": nobody stands behind the
   * addresses it found any more, so nothing is created from them. `failed` is terminal — a probe
   * that reports the sweep done afterwards changes nothing — so this is also what stops a run
   * that is still going, and the probe is told to stop it as a cancel tells it. A run that had
   * already failed writes no second entry. Null when there is no such run.
   */
  async fail(runId: number, reason: string, actor: Actor): Promise<DiscoveryRunRow | null> {
    this.#offers.delete(runId);
    const ended = await this.#db.tx(async (q) => {
      const before = await q.query<{ status: DiscoveryRunRow['status'] }>(
        `SELECT status FROM discovery_run WHERE id = $1 FOR UPDATE`,
        [runId],
      );
      const was = before[0]?.status;
      if (was === undefined || was === 'failed') return null;
      const rows = await q.query<Record<string, unknown>>(
        `UPDATE discovery_run SET status = 'failed', message = $2, finished_at = now()
         WHERE id = $1
         RETURNING *`,
        [runId, reason],
      );
      const row = rows[0];
      if (row === undefined) return null;
      const failed = read(row);
      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'discovery.failed',
            objectId: failed.groupId,
            runId,
            range: failed.range,
            reason,
          },
        ],
        new Date(),
      );
      return { run: failed, going: was === 'queued' || was === 'running' || was === 'identifying' };
    });
    if (ended === null) return null;
    this.#logger.info({ runId, reason }, 'discovery run failed');
    if (ended.going) {
      this.#dispatch(ended.run.probeId, { kind: 'cancel', runId });
      this.#dispatch(ended.run.probeId, { kind: 'identify-cancel', runId });
    }
    return ended.run;
  }

  /**
   * Fails a run whose group is no longer under the probe it started on (`P-241`).
   *
   * A run keeps its probe, and the rule that a run uses the probe its group is under was checked
   * only when it started. An operator who then moved the group under probe B left the run on A:
   * A went on sweeping from its own network, and what it found was provisioned into B's branch,
   * as devices B may not be able to reach. So it is asked again wherever the run goes to its
   * probe (`pump`, and the two offers of identification that do not pass through it), and
   * before anything is provisioned from it (`provisionRun`). The run fails with
   * {@link GROUP_MOVED} through `fail`, which records it and tells the probe to stop.
   *
   * True when the run is out of place. It then no longer goes anywhere, whether this call failed
   * it or an earlier one had.
   */
  async failIfGroupMoved(
    run: Pick<DiscoveryRunRow, 'id' | 'groupId' | 'probeId'>,
    actor: Actor = DISCOVERY,
  ): Promise<boolean> {
    if (await isUnderProbe(this.#db, run.groupId, run.probeId)) return false;
    this.#logger.warn(
      { runId: run.id, groupId: run.groupId, probeId: run.probeId },
      'a discovery run’s group moved to another probe; failing the run',
    );
    await this.fail(run.id, GROUP_MOVED, actor);
    return true;
  }

  async get(runId: number): Promise<DiscoveryRunRow | null> {
    const rows = await this.#db.query<Record<string, unknown>>(
      `SELECT * FROM discovery_run WHERE id = $1`,
      [runId],
    );
    const row = rows[0];
    return row === undefined ? null : read(row);
  }

  async list(groupId: number, limit = 25): Promise<DiscoveryRunRow[]> {
    const rows = await this.#db.query<Record<string, unknown>>(
      `SELECT * FROM discovery_run WHERE group_id = $1 ORDER BY id DESC LIMIT $2`,
      [groupId, Math.min(Math.max(limit, 1), 200)],
    );
    return rows.map(read);
  }

  /** The live hosts a run found, in address order, with whatever `D-02` learnt about them. */
  async hosts(runId: number, limit = 1_000): Promise<DiscoveredHost[]> {
    const rows = await this.#db.query<{
      address: string;
      rtt_ms: string | null;
      fingerprint: unknown;
    }>(
      // `discovery_host.address`, qualified, and that is not decoration. A bare `address` in
      // ORDER BY binds to the *output* column — the text this select renamed — so the rows come
      // back sorted as strings and 10.0.0.10 precedes 10.0.0.9. The whole reason the column is
      // `inet` is to sort as an address, and an operator scanning the list for gaps is exactly
      // who a string sort misleads. Found by the test that asserts the order.
      `SELECT host(address) AS address, rtt_ms, fingerprint
       FROM discovery_host WHERE run_id = $1
       ORDER BY discovery_host.address LIMIT $2`,
      [runId, Math.min(Math.max(limit, 1), 65_536)],
    );
    return rows.map((row) => {
      const fingerprint = readFingerprint(row.fingerprint);
      return {
        address: row.address,
        rttMs: row.rtt_ms === null ? null : Number(row.rtt_ms),
        // Null rather than an absent key: "not identified yet" is a state a client renders, and
        // a missing field would be indistinguishable from a client that forgot to ask.
        fingerprint,
      };
    });
  }

  /** Which device a host became (`D-04`), so a re-run knows what it already made. */
  async recordDevice(runId: number, address: string, deviceId: number): Promise<void> {
    await this.#db.query(
      `UPDATE discovery_host SET device_id = $3
       WHERE run_id = $1 AND address = $2::inet`,
      [runId, address, deviceId],
    );
  }

  /**
   * Records what a provisioning pass did, and what it could not do.
   *
   * **Counts are added rather than assigned.** Provisioning can be run twice — an operator who
   * configured a credential and wants the sensors it unlocks — and the run's total is what it
   * created across all of them, not what the last one happened to do.
   */
  async recordProvisioning(
    runId: number,
    report: {
      devicesCreated: number;
      matched: number;
      sensorsCreated: number;
      problems: readonly { address: string; problem: string }[];
    },
  ): Promise<void> {
    await this.#db.query(
      `UPDATE discovery_run
       SET devices_created = devices_created + $2,
           devices_matched = devices_matched + $3,
           sensors_created = sensors_created + $4,
           provisioned_at = now()
       WHERE id = $1`,
      [runId, report.devicesCreated, report.matched, report.sensorsCreated],
    );

    if (report.problems.length > 0) {
      // One row per address, so several failing sensors on one host become one line an operator
      // reads rather than eight that say the same thing. The primary key would refuse them
      // anyway; joining them here is what keeps the *last* one from being the only one kept.
      const byAddress = new Map<string, string[]>();
      for (const one of report.problems) {
        const held = byAddress.get(one.address);
        if (held === undefined) byAddress.set(one.address, [one.problem]);
        else held.push(one.problem);
      }
      const values: unknown[] = [runId];
      const tuples = [...byAddress].map(([address, problems], at) => {
        values.push(address, problems.join('; ').slice(0, 2_000));
        return `($1, $${String(at * 2 + 2)}::inet, $${String(at * 2 + 3)})`;
      });
      // A second attempt that failed differently replaces the first record: what an operator
      // needs is why it is *still* failing, not an archaeology of every attempt.
      await this.#db.query(
        `INSERT INTO discovery_problem (run_id, address, problem)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (run_id, address) DO UPDATE SET problem = EXCLUDED.problem, at = now()`,
        values,
      );
    }
  }

  /**
   * Everything a run did, in one object (`D-08`).
   *
   * Three statements rather than one join, because the counts are one row and the breakdowns are
   * aggregates over a different table: a join would multiply the run row by the number of kinds
   * and leave every count to be divided back out. All three are indexed reads of one run.
   */
  async summary(runId: number): Promise<DiscoverySummary | null> {
    const run = await this.get(runId);
    if (run === null) return null;

    // A null kind is a host with no fingerprint — never identified — which `describeRun` keeps
    // distinct from the classifier's own `unknown`. Ordered by count so the breakdown reads as
    // "mostly Linux" without anybody having to sort it.
    const kinds = await this.#db.query<{ kind: string | null; count: number }>(
      `SELECT fingerprint->>'kind' AS kind, count(*)::int AS count
       FROM discovery_host WHERE run_id = $1
       GROUP BY 1 ORDER BY count DESC, kind NULLS LAST`,
      [runId],
    );
    // Vendors only where one was found: "23 hosts, vendor unknown" is the default state of a
    // vendor column and says nothing, where the kind breakdown's null is a real answer.
    const vendors = await this.#db.query<{ vendor: string; count: number }>(
      `SELECT fingerprint->>'vendor' AS vendor, count(*)::int AS count
       FROM discovery_host
       WHERE run_id = $1 AND fingerprint->>'vendor' IS NOT NULL
       GROUP BY 1 ORDER BY count DESC, vendor`,
      [runId],
    );

    // `count(*)::int` rather than the default bigint, which node-postgres hands over as a
    // *string* to keep 64-bit values exact — and `"3" > "12"` would have sorted the breakdown
    // wrong in a way that only shows up past ten of something.
    return describeRun(run, kinds, vendors, await this.problems(runId));
  }

  /** What a provisioning pass could not create, and why. */
  async problems(runId: number): Promise<{ address: string; problem: string }[]> {
    const rows = await this.#db.query<{ address: string; problem: string }>(
      `SELECT host(address) AS address, problem
       FROM discovery_problem WHERE run_id = $1
       ORDER BY discovery_problem.address`,
      [runId],
    );
    return rows.map((row) => ({ address: row.address, problem: row.problem }));
  }

  /**
   * Marks every run a probe was doing as needing a resume, on disconnect.
   *
   * Not `failed`: a probe that dropped is coming back, and its run is a cursor away from
   * continuing. Marking it failed would make an operator restart a sweep that only needed to
   * wait.
   */
  async probeDisconnected(probeId: number): Promise<void> {
    await this.#db.query(
      // A run mid-identification stays `identifying`: its own cursor says where to pick up, and
      // sending it back to `queued` would re-run the sweep it has already finished.
      `UPDATE discovery_run SET status = 'queued' WHERE probe_id = $1 AND status = 'running'`,
      [probeId],
    );
  }
}

function read(row: Record<string, unknown>): DiscoveryRunRow {
  return {
    id: Number(row['id']),
    groupId: Number(row['group_id']),
    probeId: Number(row['probe_id']),
    range: String(row['range_text']),
    total: Number(row['total']),
    cursor: Number(row['cursor']),
    found: Number(row['found']),
    failed: Number(row['failed']),
    status: row['status'] as DiscoveryRunRow['status'],
    level: readLevel(row['level']),
    templates: Array.isArray(row['templates']) ? (row['templates'] as string[]) : [],
    identified: Number(row['identified'] ?? 0),
    identifyCursor: Number(row['identify_cursor'] ?? 0),
    scheduleId: row['schedule_id'] == null ? null : Number(row['schedule_id']),
    createdBy: row['created_by'] == null ? null : Number(row['created_by']),
    devicesCreated: Number(row['devices_created'] ?? 0),
    devicesMatched: Number(row['devices_matched'] ?? 0),
    sensorsCreated: Number(row['sensors_created'] ?? 0),
    provisionedAt: row['provisioned_at'] == null ? null : iso(row['provisioned_at']),
    snmpCommunity: typeof row['snmp_community'] === 'string' ? row['snmp_community'] : '',
    message: typeof row['message'] === 'string' ? row['message'] : '',
    timeoutMs: Number(row['timeout_ms']),
    concurrency: Number(row['concurrency']),
    ratePerSecond: Number(row['rate_per_second']),
    createdAt: iso(row['created_at']),
    startedAt: row['started_at'] === null ? null : iso(row['started_at']),
    finishedAt: row['finished_at'] === null ? null : iso(row['finished_at']),
  };
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** A level from the database, defaulting rather than throwing — see `levelDefinition`. */
function readLevel(value: unknown): DiscoveryLevel {
  return value === 'ping' || value === 'detailed' ? value : 'standard';
}
