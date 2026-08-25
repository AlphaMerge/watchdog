import type { Queryable } from '../db/pool.js';
import { parseLimits, type ChannelLimits } from '../state/limits.js';
import type { SensorState } from '../state/tables.js';
import type { ChannelDraft } from './sensor-type-gate.js';
import { ObjectError, notFound } from './errors.js';
import type {
  ChannelRecord,
  CloneCounts,
  CountsByKind,
  CreateObjectInput,
  IpVersion,
  ListSort,
  ObjectDetail,
  ObjectFilter,
  ObjectId,
  ObjectKind,
  ObjectRef,
  ObjectSummary,
  Page,
  PageRequest,
  Precondition,
  Priority,
  SubtreeOptions,
  SubtreeResult,
  UpdateObjectInput,
} from './types.js';

/**
 * A hard ceiling on every recursive walk.
 *
 * Cycles are prevented three ways over — a trigger, a pre-check and the tree lock — but a
 * recursive CTE over a cyclic tree does not return a wrong answer, it never returns at all.
 * For a monitoring system a hang is the worst failure mode there is, so every walk is bounded.
 * Migration 001's own cycle check uses the same 1,000-hop limit.
 */
const MAX_WALK_DEPTH = 1000;

/** One advisory-lock namespace for every structural change to the tree. */
const TREE_LOCK = `hashtext('ms:object-tree')::bigint`;

interface ObjectRow {
  id: string;
  parent_id: string | null;
  kind: ObjectKind;
  name: string;
  tags: string[];
  priority: number;
  comments: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  child_count: string;
  host: string | null;
  ip_version: string | null;
  sensor_type: string | null;
  params: Record<string, unknown> | null;
  probe_gid: string | null;
}

interface SummaryRow {
  id: string;
  parent_id: string | null;
  kind: ObjectKind;
  name: string;
  tags: string[];
  priority: number;
  version: number;
  has_children: boolean;
  /** Read for the manual cursor only; deliberately absent from `ObjectSummary`. */
  sort_order: number | null;
  depth?: number;
  host: string | null;
  sensor_type: string | null;
  state: SensorState | null;
}

/** Columns every detail read needs, joined to the two kind-specific side tables. */
const DETAIL_COLUMNS = `
  o.id, o.parent_id, o.kind, o.name, o.tags, o.priority, o.comments,
  o.version, o.created_at, o.updated_at,
  (SELECT count(*) FROM object c WHERE c.parent_id = o.id) AS child_count,
  dc.host, dc.ip_version,
  sc.type AS sensor_type, sc.params,
  pc.gid AS probe_gid
`;

const DETAIL_FROM = `
  FROM object o
  LEFT JOIN device_config dc ON dc.object_id = o.id
  LEFT JOIN sensor_config sc ON sc.object_id = o.id
  LEFT JOIN probe_config pc ON pc.object_id = o.id
  LEFT JOIN sensor_runtime sr ON sr.object_id = o.id
`;

/**
 * `hasChildren` is an EXISTS that stops at the first row, not a count: a disclosure triangle
 * needs a boolean, and an exact count per row costs a lateral aggregate on every page.
 */
const SUMMARY_COLUMNS = `
  o.id, o.parent_id, o.kind, o.name, o.tags, o.priority, o.version, o.sort_order,
  EXISTS (SELECT 1 FROM object c WHERE c.parent_id = o.id) AS has_children,
  dc.host, sc.type AS sensor_type, sr.state
`;

/**
 * The order every listing of children uses (S-14).
 *
 * Manual position first, then name, then id. `NULLS LAST` is what makes an unarranged tree read
 * exactly as it did before the column existed: null is "the operator has not expressed an
 * opinion", and those siblings fall to the bottom in name order rather than claiming the top.
 */
const SIBLING_ORDER = 'o.sort_order NULLS LAST, o.name, o.id';

function toDetail(row: ObjectRow): ObjectDetail {
  const base = {
    id: Number(row.id),
    name: row.name,
    tags: row.tags,
    priority: row.priority as Priority,
    comments: row.comments,
    version: row.version,
    childCount: Number(row.child_count),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };

  switch (row.kind) {
    case 'root':
      return { ...base, kind: 'root', parentId: null };
    case 'probe':
      return {
        ...base,
        kind: 'probe',
        parentId: Number(row.parent_id),
        gid: row.probe_gid ?? null,
      };
    case 'group':
      return { ...base, kind: 'group', parentId: Number(row.parent_id) };
    case 'device':
      return {
        ...base,
        kind: 'device',
        parentId: Number(row.parent_id),
        host: row.host ?? '',
        ipVersion: (row.ip_version ?? 'auto') as IpVersion,
      };
    case 'sensor':
      return {
        ...base,
        kind: 'sensor',
        parentId: Number(row.parent_id),
        sensorType: row.sensor_type ?? '',
        params: row.params ?? {},
        // The repository deals in what is stored. Redaction is the service's job, because the
        // probe config push (R-04) needs the real values and reads it through here too.
        redactedParams: [],
      };
  }
}

function toSummary(row: SummaryRow): ObjectSummary {
  return {
    id: Number(row.id),
    parentId: row.parent_id === null ? null : Number(row.parent_id),
    kind: row.kind,
    name: row.name,
    tags: row.tags,
    priority: row.priority as Priority,
    version: row.version,
    hasChildren: row.has_children,
    ...(row.depth === undefined ? {} : { depth: row.depth }),
    ...(row.host === null ? {} : { host: row.host }),
    ...(row.sensor_type === null ? {} : { sensorType: row.sensor_type }),
    // Present for a sensor and absent for everything else, rather than defaulted to `unknown`:
    // a group has no state, and one that read as Unknown would be indistinguishable from a
    // sensor that has never reported.
    ...(row.state === null ? {} : { state: row.state }),
  };
}

/**
 * All SQL over the object tree, and no transactions.
 *
 * Every method takes the executor it should run on, so the service can compose several of them
 * into one atomic unit under one advisory lock. A repository that opened its own transaction
 * would make bulk operations (D-09) and discovery provisioning (D-04) impossible to make
 * atomic without rewriting every signature.
 */
export class ObjectRepository {
  // ── locks ────────────────────────────────────────────────────────────────────────────────

  /**
   * Taken by create and clone. Shared locks do not conflict with each other, so provisioning
   * thousands of devices in parallel is unaffected — but a structural operation cannot run
   * while they are in flight, which is what makes a deletion report exact.
   */
  async lockTreeShared(q: Queryable): Promise<void> {
    await q.query(`SELECT pg_advisory_xact_lock_shared(${TREE_LOCK})`);
  }

  /**
   * Taken by move and delete.
   *
   * The cycle trigger in migration 001 is not sufficient on its own: under READ COMMITTED its
   * `SELECT parent_id FROM object WHERE id = ancestor` takes no lock and cannot see another
   * transaction's uncommitted `parent_id`, so "move A under B" and "move B under A" can both
   * pass and both commit — producing exactly the unreachable, undeletable subtree that
   * migration 001's own comment warns about.
   */
  async lockTreeExclusive(q: Queryable): Promise<void> {
    await q.query(`SELECT pg_advisory_xact_lock(${TREE_LOCK})`);
  }

  // ── reads ────────────────────────────────────────────────────────────────────────────────

  async get(q: Queryable, id: ObjectId): Promise<ObjectDetail | null> {
    const rows = await q.query<ObjectRow>(
      `SELECT ${DETAIL_COLUMNS} ${DETAIL_FROM} WHERE o.id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : toDetail(row);
  }

  /**
   * Everything `create` needs to know about a prospective parent: that it exists, what kind it
   * is, and whether it may hold this kind of child (S-16).
   *
   * Two savings over what this replaced, and the second is the one that matters at scale.
   *
   * It used to be two round trips — read the parent, then ask a function whether the parent's
   * kind accepts the child's — where the second call's only input was a value the first had
   * already returned.
   *
   * And it used to read the parent's *whole detail*, side-table joins and all, including a
   * `count(*)` of its children, to use one column. That count grows with the parent: every new
   * sensor under a device with a thousand of them counted a thousand rows to answer a question
   * about kinds. Create is the hottest write path in the system and it now reads two values.
   */
  async getParentFor(
    q: Queryable,
    parentId: ObjectId,
    childKind: ObjectKind,
  ): Promise<{ kind: ObjectKind; accepts: boolean } | null> {
    const rows = await q.query<{ kind: ObjectKind; accepts: boolean }>(
      `SELECT o.kind, object_parent_kind_is_valid($2, o.kind) AS accepts
       FROM object o
       WHERE o.id = $1`,
      [parentId, childKind],
    );
    const row = rows[0];
    return row === undefined ? null : { kind: row.kind, accepts: row.accepts };
  }

  async getMany(q: Queryable, ids: readonly ObjectId[]): Promise<ObjectDetail[]> {
    if (ids.length === 0) return [];
    const rows = await q.query<ObjectRow>(
      `SELECT ${DETAIL_COLUMNS} ${DETAIL_FROM} WHERE o.id = ANY($1) ORDER BY o.id`,
      [ids],
    );
    return rows.map(toDetail);
  }

  async getRoot(q: Queryable): Promise<ObjectDetail> {
    const rows = await q.query<ObjectRow>(
      `SELECT ${DETAIL_COLUMNS} ${DETAIL_FROM} WHERE o.kind = 'root'`,
    );
    const row = rows[0];
    if (row === undefined) {
      // Migration 001 seeds exactly one root; its absence means the schema is not intact.
      throw new ObjectError('OBJECT_NOT_FOUND', 'the object tree has no root', {
        context: { phase: 'lookup-root' },
      });
    }
    return toDetail(row);
  }

  /**
   * Keyset pagination, never OFFSET. Measured on 50,000 siblings: a deep OFFSET page costs
   * 12.3 ms and 40,344 buffers against 0.2 ms and ~150 for the keyset equivalent — and an
   * offset silently skips and duplicates rows while discovery is provisioning into the tree.
   */
  async list(q: Queryable, filter: ObjectFilter, page: PageRequest): Promise<Page<ObjectSummary>> {
    const where: string[] = [];
    const values: unknown[] = [];
    const add = (value: unknown): string => {
      values.push(value);
      return `$${String(values.length)}`;
    };

    if (filter.parentId !== undefined) where.push(`o.parent_id = ${add(filter.parentId)}`);
    if (filter.kinds !== undefined && filter.kinds.length > 0) {
      where.push(`o.kind = ANY(${add(filter.kinds)}::object_kind[])`);
    }
    if (filter.tags !== undefined && filter.tags.length > 0) {
      // CAPABILITIES.MD §1: "Tags + inherited parent tags … used for filtering". An object
      // carries its ancestors' tags as well as its own, so tagging a group "berlin" must find
      // every device and sensor beneath it — which is the whole point of tagging a group.
      //
      // Matching own tags only would silently return a subset, and a filter that quietly
      // under-reports is worse than one that errors.
      //
      // Written as "objects in the subtree of anything that carries the tag": the folded GIN
      // index finds the few tagged roots, then the walk descends from them. The alternative —
      // walking up from every candidate row — is a recursive CTE per row.
      where.push(`o.id IN (
        WITH RECURSIVE tagged AS (
          SELECT id, 0 AS depth FROM object WHERE tags_folded(tags) @> ${add(filter.tags.map((t) => t.toLowerCase()))}::text[]
          UNION ALL
          SELECT c.id, tagged.depth + 1
          FROM object c JOIN tagged ON c.parent_id = tagged.id
          WHERE tagged.depth < ${String(MAX_WALK_DEPTH)}
        )
        SELECT id FROM tagged
      )`);
    }
    if (filter.q !== undefined && filter.q !== '') {
      where.push(`o.name ILIKE ${add(`%${escapeLike(filter.q)}%`)}`);
    }
    if (filter.host !== undefined && filter.host !== '') {
      where.push(`lower(dc.host) = ${add(filter.host.toLowerCase())}`);
    }
    if (filter.priorityMin !== undefined) where.push(`o.priority >= ${add(filter.priorityMin)}`);

    const cursor = page.cursor;
    if (cursor !== null) {
      if (cursor.sort === 'name') {
        where.push(`(o.name, o.id) > (${add(cursor.name ?? '')}, ${add(cursor.id)})`);
      } else if (cursor.sort === 'manual') {
        // Three branches, because null is a position rather than a missing value. A row with a
        // manual position comes after the cursor when its (position, name, id) is greater; a row
        // without one comes after every row that has one, and after the cursor's own (name, id)
        // when the cursor had none either. Written out rather than folded into a COALESCE with a
        // sentinel, because a sentinel is a value some operator eventually types in.
        const position = cursor.order;
        if (position === null) {
          where.push(
            `(o.sort_order IS NULL AND (o.name, o.id) > (${add(cursor.name ?? '')}, ${add(cursor.id)}))`,
          );
        } else {
          where.push(
            `(o.sort_order IS NULL
              OR (o.sort_order, o.name, o.id) > (${add(position)}, ${add(cursor.name ?? '')}, ${add(cursor.id)}))`,
          );
        }
      } else {
        where.push(`o.id > ${add(cursor.id)}`);
      }
    }

    const order =
      page.sort === 'name' ? 'o.name, o.id' : page.sort === 'manual' ? SIBLING_ORDER : 'o.id';
    const limit = add(page.limit + 1); // one extra row answers "is there a next page?"

    const rows = await q.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} ${DETAIL_FROM}
       ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
       ORDER BY ${order}
       LIMIT ${limit}`,
      values,
    );

    const hasMore = rows.length > page.limit;
    const page_ = hasMore ? rows.slice(0, page.limit) : rows;
    // Built from the raw row, not the summary: the manual cursor needs `sort_order`, and that
    // is deliberately not part of what a client sees.
    const last = page_.at(-1);

    return {
      items: page_.map(toSummary),
      nextCursor: hasMore && last !== undefined ? encodeCursorFor(page.sort, last) : null,
    };
  }

  /**
   * A bounded depth-first slice for the tree's first paint. Not cursor-paginated: a stable
   * depth-first cursor needs a materialised sort path, which is a second cursor codec and a
   * class of bug (separator-bearing names) for a case the UI does not have — a truncated
   * response degrades to lazy expansion through `list`.
   */
  async subtree(q: Queryable, id: ObjectId, options: SubtreeOptions): Promise<SubtreeResult> {
    const rows = await q.query<SummaryRow & { depth: number }>(
      `
      WITH RECURSIVE walk AS (
        SELECT o.id, o.parent_id, 0 AS depth, ARRAY[coalesce(sibling_key(o.sort_order), '9999999999'), o.name, o.id::text] AS path
        FROM object o
        WHERE o.id = $1

        UNION ALL

        SELECT c.id, c.parent_id, walk.depth + 1,
               walk.path || coalesce(sibling_key(c.sort_order), '9999999999') || c.name || c.id::text
        FROM object c
        JOIN walk ON c.parent_id = walk.id
        WHERE walk.depth + 1 <= $2
      )
      SELECT ${SUMMARY_COLUMNS}, walk.depth
      ${DETAIL_FROM}
      JOIN walk ON walk.id = o.id
      WHERE $4::object_kind[] IS NULL OR o.kind = ANY($4::object_kind[]) OR walk.depth = 0
      ORDER BY walk.path
      LIMIT $3
      `,
      [id, options.maxDepth, options.limit + 1, options.kinds ?? null],
    );

    const truncated = rows.length > options.limit;
    return {
      items: (truncated ? rows.slice(0, options.limit) : rows).map(toSummary),
      truncated,
    };
  }

  /** Root-first, excluding the object itself — the breadcrumb U-03 renders. */
  async ancestors(q: Queryable, id: ObjectId): Promise<ObjectRef[]> {
    const rows = await q.query<{ id: string; kind: ObjectKind; name: string; depth: number }>(
      `
      WITH RECURSIVE chain AS (
        SELECT o.id, o.parent_id, o.kind, o.name, 0 AS depth
        FROM object o
        WHERE o.id = $1

        UNION ALL

        SELECT parent.id, parent.parent_id, parent.kind, parent.name, chain.depth + 1
        FROM object parent
        JOIN chain ON parent.id = chain.parent_id
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT id, kind, name, depth FROM chain WHERE depth > 0 ORDER BY depth DESC
      `,
      [id],
    );
    return rows.map((row) => ({ id: Number(row.id), kind: row.kind, name: row.name }));
  }

  /**
   * A cache validator covering everything a response about this object can inherit (S-13).
   *
   * A digest of `(id, version)` for the object and every ancestor, in order. Two properties
   * matter, and only the first is obvious:
   *
   *   - **Values.** Every side table that feeds a response — `object_setting`, `credential_set`,
   *     `sensor_config`, `device_config`, `channel` — bumps its owning object's version by
   *     trigger (migration 002), so any change an ancestor could contribute moves that
   *     ancestor's version.
   *   - **Membership.** Moving an ancestor changes which objects are in the chain at all, and
   *     the inherited values change with it. This is why the digest is over the whole chain
   *     rather than the maximum version along it: versions are per-object counters, so
   *     re-parenting a subtree can leave the maximum untouched while every inherited setting
   *     changes underneath it.
   *
   * `salt` carries the build version, because the last input to a resolved setting is the
   * registry default — which lives in code, and changes when the code does.
   *
   * md5 because this is a cache validator, not a security primitive: it has to change when the
   * input changes, not resist an adversary choosing the input.
   */
  async chainValidator(q: Queryable, id: ObjectId, salt: string): Promise<string | null> {
    const rows = await q.query<{ validator: string | null }>(
      `
      WITH RECURSIVE chain AS (
        SELECT o.id, o.parent_id, o.version, 0 AS depth
        FROM object o
        WHERE o.id = $1

        UNION ALL

        SELECT parent.id, parent.parent_id, parent.version, chain.depth + 1
        FROM object parent
        JOIN chain ON parent.id = chain.parent_id
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT md5(
               string_agg(id::text || ':' || version::text, ',' ORDER BY depth) || $2
             ) AS validator
      FROM chain
      `,
      [id, salt],
    );
    // No rows at all means no such object; the caller reads it and gets the 404.
    return rows[0]?.validator ?? null;
  }

  /**
   * Writes a sensor's channels in one statement rather than one apiece.
   *
   * Nothing declares channels yet — `permissiveSensorTypeGate` returns none until `P-05` ships
   * the registry — so today this is a no-op that costs nothing. The moment a real sensor type
   * declares three or five channels it is the difference between one round trip per create and
   * six, on the path a 5,000-sensor provisioning run repeats five thousand times.
   */
  /**
   * Returns the count written and the owner's version *after* the write.
   *
   * The version matters: `channel` is a side table, and writing it fires the trigger that
   * invalidates the sensor's ETag. A create that returned the version it read before inserting
   * channels would hand back a tag that is already stale — the same trap S-16 documented for
   * `sensor_config`. It cannot come from the INSERT's own `RETURNING`, because a CTE sees the
   * snapshot the statement began with, which is the version before the trigger fired.
   */
  async createChannels(
    q: Queryable,
    sensorId: ObjectId,
    drafts: readonly ChannelDraft[],
  ): Promise<{ created: number; ownerVersion: number | null }> {
    if (drafts.length === 0) return { created: 0, ownerVersion: null };
    const rows = await q.query<{ id: number }>(
      `INSERT INTO channel (sensor_id, key, name, unit, is_primary)
       SELECT $1, key, name, unit, is_primary
       FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[])
            AS d(key, name, unit, is_primary)
       RETURNING id`,
      [
        sensorId,
        drafts.map((draft) => draft.key),
        drafts.map((draft) => draft.name),
        drafts.map((draft) => draft.unit ?? ''),
        drafts.map((draft) => draft.isPrimary ?? false),
      ],
    );
    // A primary-key lookup, and only on sensor creation.
    const [owner] = await q.query<{ version: number }>('SELECT version FROM object WHERE id = $1', [
      sensorId,
    ]);
    return { created: rows.length, ownerVersion: owner === undefined ? null : owner.version };
  }

  /**
   * The ids of an object's children in the order they are shown, for a reorder to splice.
   *
   * The caller holds the exclusive tree lock while it reads this and writes the result back;
   * two operators dragging in the same group otherwise interleave into an order neither chose.
   */
  async siblingOrder(q: Queryable, parentId: ObjectId): Promise<ObjectId[]> {
    const rows = await q.query<{ id: string }>(
      `SELECT o.id FROM object o WHERE o.parent_id = $1 ORDER BY ${SIBLING_ORDER}`,
      [parentId],
    );
    return rows.map((row) => Number(row.id));
  }

  /**
   * Writes a dense 0..n-1 arrangement for one parent's children.
   *
   * Dense rather than sparse-with-gaps: gaps buy cheaper single moves, at the price of a
   * renumbering pass that eventually has to happen anyway and a second failure mode when it does
   * not. A parent has tens of children, not millions.
   *
   * Only rows whose position actually moves are written, so dragging one item in a long list
   * does not bump the version of every sibling that stayed where it was.
   */
  async writeSiblingOrder(
    q: Queryable,
    parentId: ObjectId,
    ordered: readonly ObjectId[],
  ): Promise<number> {
    if (ordered.length === 0) return 0;
    const rows = await q.query<{ id: string }>(
      `UPDATE object o
       SET sort_order = w.pos
       FROM unnest($1::bigint[], $2::int[]) AS w(id, pos)
       WHERE o.id = w.id
         AND o.parent_id = $3
         AND o.sort_order IS DISTINCT FROM w.pos
       RETURNING o.id`,
      [[...ordered], ordered.map((_, index) => index), parentId],
    );
    return rows.length;
  }

  async channels(q: Queryable, sensorId: ObjectId): Promise<ChannelRecord[]> {
    const rows = await q.query<{
      id: number;
      sensor_id: string;
      key: string;
      name: string;
      unit: string;
      is_primary: boolean;
      scale_mul: string;
      scale_div: string;
      decimals: number | null;
      limits: unknown;
      spike_min: number | null;
      spike_max: number | null;
      show_in_graph: boolean;
      show_in_table: boolean;
    }>(
      `SELECT id, sensor_id, key, name, unit, is_primary, scale_mul, scale_div, decimals,
              limits, spike_min, spike_max, show_in_graph, show_in_table
       FROM channel WHERE sensor_id = $1
       ORDER BY is_primary DESC, key`,
      [sensorId],
    );

    return rows.map((row) => ({
      id: row.id,
      sensorId: Number(row.sensor_id),
      key: row.key,
      name: row.name,
      unit: row.unit,
      isPrimary: row.is_primary,
      scaleMul: row.scale_mul,
      scaleDiv: row.scale_div,
      decimals: row.decimals,
      limits: parseLimits(row.limits),
      spikeMin: row.spike_min,
      spikeMax: row.spike_max,
      showInGraph: row.show_in_graph,
      showInTable: row.show_in_table,
    }));
  }

  /** One channel by the key its sensor type gave it, or null. */
  async channel(q: Queryable, sensorId: ObjectId, key: string): Promise<ChannelRecord | null> {
    const all = await this.channels(q, sensorId);
    return all.find((channel) => channel.key === key) ?? null;
  }

  /**
   * Writes a channel's thresholds.
   *
   * The whole normalised object, not a merge in SQL: the merge happened in the service, against
   * a row it read in this transaction, and doing it again in a `jsonb ||` expression would be a
   * second implementation of the same rule that could disagree about what `null` means.
   */
  async setChannelLimits(
    q: Queryable,
    sensorId: ObjectId,
    key: string,
    limits: ChannelLimits,
  ): Promise<boolean> {
    const rows = await q.query<{ id: number }>(
      `UPDATE channel SET limits = $3::jsonb
       WHERE sensor_id = $1 AND key = $2
       RETURNING id`,
      [sensorId, key, JSON.stringify(limits)],
    );
    return rows.length > 0;
  }

  // ── tree predicates: the database's own rules, never restated in TypeScript ───────────────

  async isValidParentKind(q: Queryable, child: ObjectKind, parent: ObjectKind): Promise<boolean> {
    const rows = await q.query<{ valid: boolean }>(
      'SELECT object_parent_kind_is_valid($1, $2) AS valid',
      [child, parent],
    );
    return rows[0]?.valid ?? false;
  }

  /**
   * The named ancestor path from a candidate parent up to the root, when that path passes
   * through `id` — which is exactly when the move would create a cycle.
   *
   * The pre-check exists for the *error*, not the safety: the trigger raises SQLSTATE 23514
   * for both a cycle and a kind violation, and callers switch on SQLSTATE rather than text.
   */
  async wouldCycle(
    q: Queryable,
    id: ObjectId,
    candidateParentId: ObjectId,
  ): Promise<ObjectRef[] | null> {
    const rows = await q.query<{ id: string; kind: ObjectKind; name: string; depth: number }>(
      `
      WITH RECURSIVE up AS (
        SELECT o.id, o.parent_id, o.kind, o.name, 0 AS depth
        FROM object o
        WHERE o.id = $1

        UNION ALL

        SELECT parent.id, parent.parent_id, parent.kind, parent.name, up.depth + 1
        FROM object parent
        JOIN up ON parent.id = up.parent_id
        WHERE up.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT id, kind, name, depth FROM up ORDER BY depth
      `,
      // `id` is not a parameter: the walk starts at the candidate parent, and membership is
      // checked below. A bound parameter the statement never mentions makes PostgreSQL fail
      // with "could not determine data type of parameter $1".
      [candidateParentId],
    );

    const path = rows.map((row) => ({
      id: Number(row.id),
      kind: row.kind,
      name: row.name,
    }));

    // The walk starts at the candidate parent itself, so moving an object under itself is
    // already covered: `id` appears in the path at depth 0.
    return path.some((ref) => ref.id === id) ? path : null;
  }

  /** The probe an object belongs to, for the cross-probe move report. */
  async nearestProbe(q: Queryable, id: ObjectId): Promise<ObjectRef | null> {
    const rows = await q.query<{ id: string; kind: ObjectKind; name: string }>(
      `
      WITH RECURSIVE up AS (
        SELECT o.id, o.parent_id, o.kind, o.name, 0 AS depth
        FROM object o
        WHERE o.id = $1

        UNION ALL

        SELECT parent.id, parent.parent_id, parent.kind, parent.name, up.depth + 1
        FROM object parent
        JOIN up ON parent.id = up.parent_id
        WHERE up.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT id, kind, name FROM up WHERE kind = 'probe' ORDER BY depth LIMIT 1
      `,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : { id: Number(row.id), kind: row.kind, name: row.name };
  }

  /** One enumeration, feeding both the delete confirmation and the audit payload. */
  async enumerateSubtree(
    q: Queryable,
    id: ObjectId,
  ): Promise<{ refs: ObjectRef[]; counts: CountsByKind }> {
    const rows = await q.query<{
      id: string;
      kind: ObjectKind;
      name: string;
      channels: string;
      credential_sets: string;
    }>(
      `
      WITH RECURSIVE subtree AS (
        SELECT id, parent_id, kind, name, 0 AS depth FROM object WHERE id = $1

        UNION ALL

        SELECT c.id, c.parent_id, c.kind, c.name, subtree.depth + 1
        FROM object c
        JOIN subtree ON c.parent_id = subtree.id
        WHERE subtree.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT s.id, s.kind, s.name,
             (SELECT count(*) FROM channel ch WHERE ch.sensor_id = s.id) AS channels,
             (SELECT count(*) FROM credential_set cs WHERE cs.object_id = s.id) AS credential_sets
      FROM subtree s
      `,
      [id],
    );

    const counts = {
      probe: 0,
      group: 0,
      device: 0,
      sensor: 0,
      total: rows.length,
      channels: 0,
      credentialSets: 0,
    };

    const refs: ObjectRef[] = [];
    for (const row of rows) {
      refs.push({ id: Number(row.id), kind: row.kind, name: row.name });
      if (row.kind !== 'root') counts[row.kind] += 1;
      counts.channels += Number(row.channels);
      counts.credentialSets += Number(row.credential_sets);
    }

    return { refs, counts };
  }

  async countSubtree(q: Queryable, id: ObjectId): Promise<number> {
    const rows = await q.query<{ count: string }>(
      `
      WITH RECURSIVE subtree AS (
        SELECT id, 0 AS depth FROM object WHERE id = $1
        UNION ALL
        SELECT c.id, subtree.depth + 1 FROM object c JOIN subtree ON c.parent_id = subtree.id
        WHERE subtree.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT count(*) AS count FROM subtree
      `,
      [id],
    );
    return Number(rows[0]?.count ?? 0);
  }

  // ── writes ───────────────────────────────────────────────────────────────────────────────

  async create(q: Queryable, input: CreateObjectInput): Promise<ObjectDetail> {
    const rows = await q.query<{ id: string }>(
      `INSERT INTO object (parent_id, kind, name, tags, priority, comments)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        input.parentId,
        input.kind,
        input.name,
        input.tags ?? [],
        input.priority ?? 3,
        input.comments ?? '',
      ],
    );
    const id = Number(rows[0]?.id);

    if (input.kind === 'probe') {
      // Always a row, so reads never have to tell "unclaimed" from "no row at all".
      await q.query('INSERT INTO probe_config (object_id, gid) VALUES ($1, $2)', [
        id,
        input.gid ?? null,
      ]);
    } else if (input.kind === 'device') {
      await q.query('INSERT INTO device_config (object_id, host, ip_version) VALUES ($1, $2, $3)', [
        id,
        input.host,
        input.ipVersion ?? 'auto',
      ]);
    } else if (input.kind === 'sensor') {
      await q.query('INSERT INTO sensor_config (object_id, type, params) VALUES ($1, $2, $3)', [
        id,
        input.sensorType,
        JSON.stringify(input.params ?? {}),
      ]);
    }

    const created = await this.get(q, id);
    if (created === null) throw notFound(id);
    return created;
  }

  /**
   * The version predicate *is* the lock — no `SELECT … FOR UPDATE` on this path. Zero rows
   * updated plus an existence re-check inside the same transaction tells 404 from 412.
   */
  async update(
    q: Queryable,
    id: ObjectId,
    patch: UpdateObjectInput,
    pre: Precondition,
  ): Promise<ObjectDetail> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    const add = (value: unknown): string => {
      values.push(value);
      return `$${String(values.length)}`;
    };

    if (patch.name !== undefined) sets.push(`name = ${add(patch.name)}`);
    if (patch.tags !== undefined) sets.push(`tags = ${add(patch.tags)}`);
    if (patch.priority !== undefined) sets.push(`priority = ${add(patch.priority)}`);
    if (patch.comments !== undefined) sets.push(`comments = ${add(patch.comments)}`);

    // One statement guards the whole patch, whether or not it changes a column on `object`.
    //
    // It has to come first and it has to be an UPDATE. The side-table writes below fire
    // triggers that bump `version`, so a check performed afterwards would be comparing the
    // caller's ETag against a number this very statement had already incremented — every
    // host-only or params-only patch would 412 against its own fresh ETag. And a plain SELECT
    // beforehand would not do either: under READ COMMITTED it takes no lock, so a concurrent
    // writer's bump stays invisible and the lost update the precondition exists to prevent
    // slips through. The `WHERE ... AND version = $n` predicate is the lock.
    const assignments = sets.length > 0 ? sets.join(', ') : 'updated_at = now()';
    const predicate = pre.kind === 'version' ? ` AND version = ${add(pre.expected)}` : '';
    const updated = await q.query<{ id: string }>(
      `UPDATE object SET ${assignments} WHERE id = $1${predicate} RETURNING id`,
      values,
    );
    if (updated.length === 0) await this.#explainFailedPrecondition(q, id, pre);

    if (patch.kind === 'probe' && patch.gid !== undefined) {
      // Upsert: a probe object created before migration 007 has a row, but one created by a
      // path that predates this write would not, and a missing row must not silently drop a
      // claim. The unique index is what rejects a gid another branch already holds.
      await q.query(
        `INSERT INTO probe_config (object_id, gid) VALUES ($1, $2)
         ON CONFLICT (object_id) DO UPDATE SET gid = EXCLUDED.gid`,
        [id, patch.gid],
      );
    }

    if (patch.kind === 'device' && (patch.host !== undefined || patch.ipVersion !== undefined)) {
      const deviceSets: string[] = [];
      const deviceValues: unknown[] = [id];
      const addDevice = (value: unknown): string => {
        deviceValues.push(value);
        return `$${String(deviceValues.length)}`;
      };
      if (patch.host !== undefined) deviceSets.push(`host = ${addDevice(patch.host)}`);
      if (patch.ipVersion !== undefined) {
        deviceSets.push(`ip_version = ${addDevice(patch.ipVersion)}`);
      }
      await q.query(
        `UPDATE device_config SET ${deviceSets.join(', ')} WHERE object_id = $1`,
        deviceValues,
      );
    }

    if (patch.kind === 'sensor' && patch.params !== undefined) {
      await q.query('UPDATE sensor_config SET params = $2 WHERE object_id = $1', [
        id,
        JSON.stringify(patch.params),
      ]);
    }

    const after = await this.get(q, id);
    if (after === null) throw notFound(id);
    return after;
  }

  async reparent(
    q: Queryable,
    id: ObjectId,
    targetParentId: ObjectId,
    pre: Precondition,
  ): Promise<void> {
    const values: unknown[] = [id, targetParentId];
    let predicate = '';
    if (pre.kind === 'version') {
      values.push(pre.expected);
      predicate = ' AND version = $3';
    }
    const rows = await q.query<{ id: string }>(
      `UPDATE object SET parent_id = $2 WHERE id = $1${predicate} RETURNING id`,
      values,
    );
    if (rows.length === 0) await this.#explainFailedPrecondition(q, id, pre);
  }

  /**
   * Deletes by an explicit id set rather than by the root alone, so `RETURNING` names every
   * destroyed object — rows removed by the FK cascade would not appear — and the receipt can
   * be asserted rather than assumed.
   */
  async deleteIds(q: Queryable, ids: readonly ObjectId[]): Promise<ObjectRef[]> {
    if (ids.length === 0) return [];
    const rows = await q.query<{ id: string; kind: ObjectKind; name: string }>(
      'DELETE FROM object WHERE id = ANY($1) RETURNING id, kind, name',
      [ids],
    );
    return rows.map((row) => ({ id: Number(row.id), kind: row.kind, name: row.name }));
  }

  /**
   * Deep-copies a subtree, set-based, one statement per depth level.
   *
   * Per depth level rather than one ordered statement because `object_check_hierarchy()` is a
   * BEFORE ROW trigger that does `SELECT kind FROM object WHERE id = NEW.parent_id`, and
   * PostgreSQL does not guarantee a row inserted earlier in the same multi-row statement is
   * visible to a later row's trigger. Inserting depth by depth makes every parent visible to
   * its children. Tree depth is bounded in practice, so a 5,000-object clone is roughly ten
   * statements rather than 5,000 round trips.
   *
   * Never reads `credential_set.secret`, and never copies a credential row at all.
   */
  async copySubtree(
    q: Queryable,
    sourceId: ObjectId,
    targetParentId: ObjectId,
    rootName: string,
    maxObjects: number,
  ): Promise<{ cloneRootId: ObjectId; counts: CloneCounts; droppedCredentialKinds: string[] }> {
    // Suppresses the ETag bump on side-table inserts: these objects are seconds old and no
    // client holds a validator for them. O(rows) extra UPDATEs become zero.
    await q.query(`SET LOCAL ms.bulk_load = 'on'`);

    // ON COMMIT DROP is not enough: bulk operations (D-09) will clone several subtrees inside
    // one transaction, and the second call would find the table still there with stale rows.
    await q.query('DROP TABLE IF EXISTS clone_map');
    await q.query(`
      CREATE TEMP TABLE clone_map (
        src_id bigint PRIMARY KEY,
        new_id bigint NOT NULL,
        depth  int NOT NULL
      ) ON COMMIT DROP
    `);

    await q.query(
      `
      WITH RECURSIVE src AS (
        SELECT id, parent_id, 0 AS depth FROM object WHERE id = $1
        UNION ALL
        SELECT c.id, c.parent_id, src.depth + 1
        FROM object c JOIN src ON c.parent_id = src.id
        WHERE src.depth < ${String(MAX_WALK_DEPTH)}
      )
      INSERT INTO clone_map (src_id, new_id, depth)
      SELECT id, nextval(pg_get_serial_sequence('object', 'id')), depth FROM src
      `,
      [sourceId],
    );

    const sizeRows = await q.query<{ count: string; max_depth: number }>(
      'SELECT count(*) AS count, coalesce(max(depth), 0) AS max_depth FROM clone_map',
    );
    const total = Number(sizeRows[0]?.count ?? 0);
    const maxDepth = sizeRows[0]?.max_depth ?? 0;

    if (total > maxObjects) {
      throw new ObjectError(
        'OBJECT_CLONE_TOO_LARGE',
        `cloning ${String(total)} objects exceeds the limit of ${String(maxObjects)}`,
        {
          context: { objectId: sourceId, phase: 'clone' },
          details: { limit: maxObjects, actual: total },
        },
      );
    }

    for (let depth = 0; depth <= maxDepth; depth += 1) {
      await q.query(
        `
        INSERT INTO object (id, parent_id, kind, name, tags, priority, comments)
        OVERRIDING SYSTEM VALUE
        SELECT m.new_id,
               CASE WHEN m.depth = 0 THEN $1 ELSE pm.new_id END,
               o.kind,
               CASE WHEN m.depth = 0 THEN $2 ELSE o.name END,
               o.tags, o.priority, o.comments
        FROM clone_map m
        JOIN object o ON o.id = m.src_id
        LEFT JOIN clone_map pm ON pm.src_id = o.parent_id
        WHERE m.depth = $3
        `,
        [targetParentId, rootName, depth],
      );
    }

    await q.query(`
      INSERT INTO sensor_config (object_id, type, params)
      SELECT m.new_id, sc.type, sc.params
      FROM clone_map m JOIN sensor_config sc ON sc.object_id = m.src_id
    `);

    await q.query(`
      INSERT INTO device_config (object_id, host, ip_version)
      SELECT m.new_id, dc.host, dc.ip_version
      FROM clone_map m JOIN device_config dc ON dc.object_id = m.src_id
    `);

    // New channel ids mean the clone has no history for free: samples (S-05) are keyed by
    // channel_id, so there is no path by which a clone could render its source's graph.
    const channelRows = await q.query<{ count: string }>(`
      WITH inserted AS (
        INSERT INTO channel (sensor_id, key, name, unit, is_primary, scale_mul, scale_div,
                             decimals, limits, spike_min, spike_max, show_in_graph, show_in_table)
        SELECT m.new_id, ch.key, ch.name, ch.unit, ch.is_primary, ch.scale_mul, ch.scale_div,
               ch.decimals, ch.limits, ch.spike_min, ch.spike_max, ch.show_in_graph,
               ch.show_in_table
        FROM clone_map m JOIN channel ch ON ch.sensor_id = m.src_id
        RETURNING 1
      )
      SELECT count(*) AS count FROM inserted
    `);

    // Own rows only. "Inherited" is the *absence* of a row, so INSERT … SELECT copies exactly
    // the explicit overrides — materialising inherited values would convert inheritance into
    // overrides across the whole clone and silently invert revert-to-inherit.
    const settingRows = await q.query<{ count: string }>(`
      WITH inserted AS (
        INSERT INTO object_setting (object_id, key, value)
        SELECT m.new_id, os.key, os.value
        FROM clone_map m JOIN object_setting os ON os.object_id = m.src_id
        RETURNING 1
      )
      SELECT count(*) AS count FROM inserted
    `);

    const droppedRows = await q.query<{ kind: string }>(`
      SELECT DISTINCT cs.kind
      FROM credential_set cs JOIN clone_map m ON m.src_id = cs.object_id
      ORDER BY cs.kind
    `);

    const kindRows = await q.query<{ kind: ObjectKind; count: string }>(`
      SELECT o.kind, count(*) AS count
      FROM clone_map m JOIN object o ON o.id = m.new_id
      GROUP BY o.kind
    `);

    const rootRows = await q.query<{ new_id: string }>(
      'SELECT new_id FROM clone_map WHERE depth = 0',
    );

    const counts: CloneCounts = {
      group: countOf(kindRows, 'group'),
      device: countOf(kindRows, 'device'),
      sensor: countOf(kindRows, 'sensor'),
      channel: Number(channelRows[0]?.count ?? 0),
      setting: Number(settingRows[0]?.count ?? 0),
      total,
    };

    return {
      cloneRootId: Number(rootRows[0]?.new_id),
      counts,
      droppedCredentialKinds: droppedRows.map((row) => row.kind),
    };
  }

  async #explainFailedPrecondition(q: Queryable, id: ObjectId, pre: Precondition): Promise<never> {
    const rows = await q.query<{ version: number; updated_at: Date }>(
      'SELECT version, updated_at FROM object WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw notFound(id);
    if (pre.kind === 'version') throw versionConflict(id, pre.expected, row.version);
    // The row exists and no precondition was given, so the update matched nothing for a
    // reason we do not model. Better to say so than to report success.
    throw new ObjectError('OBJECT_INVALID', `object ${String(id)} could not be updated`, {
      context: { objectId: id, phase: 'update' },
    });
  }
}

export function versionConflict(id: ObjectId, expected: number, actual: number): ObjectError {
  return new ObjectError(
    'OBJECT_VERSION_CONFLICT',
    `object ${String(id)} has changed since it was read (expected version ${String(expected)}, found ${String(actual)})`,
    {
      context: { objectId: id, phase: 'precondition' },
      details: { expected, actual },
    },
  );
}

export function encodeCursorFor(sort: ListSort, last: SummaryRowLike): string {
  const payload = {
    v: 1,
    sort,
    name: sort === 'id' ? null : last.name,
    order: sort === 'manual' ? last.sort_order : null,
    id: Number(last.id),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Just enough of a row to mint a cursor from, so tests can pass a literal. */
export interface SummaryRowLike {
  id: string | number;
  name: string;
  sort_order: number | null;
}

function countOf(rows: readonly { kind: ObjectKind; count: string }[], kind: ObjectKind): number {
  return Number(rows.find((row) => row.kind === kind)?.count ?? 0);
}

/** `%` and `_` are wildcards in LIKE; a search for "a_b" must not match "axb". */
function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export type { CloneCounts };
