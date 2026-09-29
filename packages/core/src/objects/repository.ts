import { createHash } from 'node:crypto';
import type { Queryable } from '../db/pool.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';
import type { AccessRight, Visibility } from '../auth/access.js';
import { limitsFromDeclaration, parseLimits, type ChannelLimits } from '../state/limits.js';
import { SENSOR_STATES, type SensorState } from '../state/tables.js';
import type { ChannelDraft } from './sensor-type-gate.js';
import { ObjectError, notFound } from './errors.js';
import type {
  ChannelProcessing,
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
  SubtreeCounts,
  SubtreeOptions,
  SubtreeResult,
  UpdateObjectInput,
} from './types.js';

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
  inherits_triggers: boolean;
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
  paused: boolean;
}

/** Columns every detail read needs, joined to the two kind-specific side tables. */
const DETAIL_COLUMNS = `
  o.id, o.parent_id, o.kind, o.name, o.tags, o.priority, o.comments, o.inherits_triggers,
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
  LEFT JOIN object_pause op ON op.object_id = o.id
`;

/**
 * `hasChildren` is an EXISTS that stops at the first row, not a count: a disclosure triangle
 * needs a boolean, and an exact count per row costs a lateral aggregate on every page.
 *
 * **It counts only children the reader can see** (`A-12`). A device whose one sensor has been
 * carved out with `none` has no children as far as that reader is concerned, and a disclosure
 * triangle that opened onto nothing would be the hole announcing itself. Every row it is asked of
 * is one the reader can see, so the condition is `Visibility.whereChildOfVisible`'s, with no walk.
 */
function summaryColumns(children: string): string {
  return `
  o.id, o.parent_id, o.kind, o.name, o.tags, o.priority, o.version, o.sort_order,
  EXISTS (SELECT 1 FROM object c WHERE c.parent_id = o.id AND ${children}) AS has_children,
  dc.host, sc.type AS sensor_type, sr.state,
  -- The clock, not just the row: a pause whose deadline has passed is not a pause, and the
  -- sweep that deletes the row runs on a coarse timer (M-08).
  (op.object_id IS NOT NULL AND (op.paused_until IS NULL OR op.paused_until > now())) AS paused
`;
}

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
    inheritsTriggers: row.inherits_triggers,
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
    ...(row.paused ? { paused: true } : {}),
  };
}

/** A grant a clone carried from its source onto one of the copies (`A-35`). */
export interface CopiedGrant {
  /** The copy it now sits on. */
  objectId: ObjectId;
  groupId: number;
  groupName: string;
  right: AccessRight;
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
  async list(
    q: Queryable,
    filter: ObjectFilter,
    page: PageRequest,
    visibility: Visibility,
  ): Promise<Page<ObjectSummary>> {
    const where: string[] = [];
    const values: unknown[] = [];
    const add = (value: unknown): string => {
      values.push(value);
      return `$${String(values.length)}`;
    };

    // **Inside the query, not after it** (`A-12`). Filtering a page once it has come back hands
    // a caller 37 rows for `limit=100` and a cursor that skips; as a condition here, the limit,
    // the cursor and the "is there a next page" row are all counted over what the reader can
    // see.
    if (!visibility.everything) where.push(visibility.where('o.id', add));

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
      //
      // **One walk per tag, intersected** (`P-102`). A single walk whose base case demanded
      // every tag at once could only match a chain where one object carried all of them, so an
      // AND-filter whose tags are spread across levels matched nothing at all: a group tagged
      // `paris`, a device under it tagged `production`, and `?tag=paris&tag=production` returning
      // an empty page. The effective-tag rule everything else uses is the union of an object's
      // own tags with its ancestors' — `MessageContextLoader` computes exactly that for `%tags`,
      // so a notification would name both tags on a sensor a search for those two tags could not
      // find.
      //
      // An object effectively carries a tag exactly when it is in the subtree of something that
      // carries it, so "carries all of them" is the intersection of those subtrees. That keeps
      // the cheap shape — each walk still starts from the few rows the GIN index finds — rather
      // than accumulating tags down a walk of the whole tree on every filtered list.
      for (const tag of filter.tags) {
        where.push(`o.id IN (
        WITH RECURSIVE tagged AS (
          SELECT id, 0 AS depth FROM object WHERE tags_folded(tags) @> ${add([tag.toLowerCase()])}::text[]
          UNION ALL
          SELECT c.id, tagged.depth + 1
          FROM object c JOIN tagged ON c.parent_id = tagged.id
          WHERE tagged.depth < ${String(MAX_WALK_DEPTH)}
        )
        SELECT id FROM tagged
      )`);
      }
    }
    if (filter.q !== undefined && filter.q !== '') {
      // Names and hosts, because that is what the tree's search box promises and an address is
      // what somebody looking for a device usually has (`P-212`). Only a device has a
      // `device_config` row; everywhere else the LEFT JOIN leaves `dc.host` null, the second
      // ILIKE is null, and `name OR null` is decided by the name alone — so groups, probes and
      // sensors are still found by name and never by a host they do not have. A sensor is not
      // found by its device's host: the device is the match, and the sensors are one level down.
      //
      // Unindexed, as the name match already was: neither column has a trigram index, and
      // `device_config_host_idx` is on `lower(host)` for the exact `host` filter below.
      const pattern = add(`%${escapeLike(filter.q)}%`);
      where.push(`(o.name ILIKE ${pattern} OR dc.host ILIKE ${pattern})`);
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

    // **The page is chosen first, and only its rows are joined to the rest** (`A-12`). With
    // visibility in the `WHERE`, a reader granted a quarter of the tree has thousands of rows that
    // match before the `LIMIT`, and joining each to its configuration, runtime and pause before
    // sorting cost more than choosing them — 20,000 index lookups for a page of 100. The filters
    // read only the object and a device's host, so the inner query can decide the page alone.
    const rows = await q.query<SummaryRow>(
      `SELECT ${summaryColumns(visibility.whereChildOfVisible('c.id', add))} ${DETAIL_FROM}
       WHERE o.id IN (
         SELECT o.id
         FROM object o
         LEFT JOIN device_config dc ON dc.object_id = o.id
         ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
         ORDER BY ${order}
         LIMIT ${limit}
       )
       ORDER BY ${order}`,
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
  async subtree(
    q: Queryable,
    id: ObjectId,
    options: SubtreeOptions,
    visibility: Visibility,
  ): Promise<SubtreeResult> {
    const values: unknown[] = [id, options.maxDepth, options.limit + 1, options.kinds ?? null];
    const add = (value: unknown): string => `$${String(values.push(value))}`;
    // **A `none` carved below a readable root is honoured** (`A-12`): the route checks the root,
    // and this is what checks everything under it. The walk still descends through a hole,
    // because a grant further down can re-open it and the resolver says that object is readable.
    const visible = visibility.where('o.id', add);
    const children = visibility.whereChildOfVisible('c.id', add);
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
      SELECT ${summaryColumns(children)}, walk.depth
      ${DETAIL_FROM}
      JOIN walk ON walk.id = o.id
      WHERE ($4::object_kind[] IS NULL OR o.kind = ANY($4::object_kind[]) OR walk.depth = 0)
        AND ${visible}
      ORDER BY walk.path
      LIMIT $3
      `,
      values,
    );

    const truncated = rows.length > options.limit;
    return {
      items: (truncated ? rows.slice(0, options.limit) : rows).map(toSummary),
      truncated,
    };
  }

  /**
   * How many of this object's children the reader can see (`A-12`).
   *
   * `childCount` on a detail counts every child, which is right for everybody who sees them all
   * and a count of the hole for anybody who does not. Asked only for a reader who does not, and
   * only of an object that reader may read — the detail route's own bar — so a child is visible
   * unless it is a hidden boundary itself, and there is no walk to pay for.
   */
  async visibleChildCount(q: Queryable, id: ObjectId, visibility: Visibility): Promise<number> {
    const values: unknown[] = [id];
    const visible = visibility.whereChildOfVisible(
      'c.id',
      (value) => `$${String(values.push(value))}`,
    );
    const rows = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM object c WHERE c.parent_id = $1 AND ${visible}`,
      values,
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * The objects the reader can see whose parent it cannot — where its tree starts (`A-12`).
   *
   * The root, for anybody who can see it. For an account granted a few branches, the tops of
   * those branches: the containers above them are outside what it was granted, so its tree cannot
   * start at the root and be navigated down, and this is how it starts at the branches instead.
   * **And a grant re-opened inside a hole**, because its parent is hidden and so no expansion
   * reaches it — "no visible ancestor" would drop it, and the account would be granted an object
   * it has no way to find.
   *
   * **Only a boundary can be a top.** Visibility changes only where a grant sits, and the root is
   * visible only through a grant on itself, so a visible object under a hidden parent is always a
   * visible boundary. Those are a handful, and each is kept when its parent is hidden.
   */
  async tops(q: Queryable, visibility: Visibility): Promise<ObjectSummary[]> {
    const values: unknown[] = [];
    const add = (value: unknown): string => `$${String(values.push(value))}`;
    const children = visibility.whereChildOfVisible('c.id', add);

    const candidates = visibility.seenBoundaries();
    if (candidates === null) {
      const rows = await q.query<SummaryRow>(
        `SELECT ${summaryColumns(children)} ${DETAIL_FROM} WHERE o.parent_id IS NULL`,
        values,
      );
      return rows.map(toSummary);
    }
    if (candidates.length === 0) return [];

    const ids = add(candidates);
    const parent = visibility.where('o.parent_id', add);
    const rows = await q.query<SummaryRow>(
      `
      SELECT ${summaryColumns(children)}
      ${DETAIL_FROM}
      WHERE o.id = ANY(${ids}::bigint[])
        AND (o.parent_id IS NULL OR NOT ${parent})
      ORDER BY o.name, o.id
      `,
      values,
    );
    return rows.map(toSummary);
  }

  /**
   * Root-first, excluding the object itself — the breadcrumb U-03 renders.
   *
   * **Trimmed to what the reader can see** (`A-12`). The containers above a granted branch are
   * outside it: a customer granted one group gets a breadcrumb that starts at that group, and
   * never learns what the probe above it is called.
   */
  async ancestors(q: Queryable, id: ObjectId, visibility: Visibility): Promise<ObjectRef[]> {
    const values: unknown[] = [id];
    const visible = visibility.where('id', (value) => `$${String(values.push(value))}`);
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
      SELECT id, kind, name, depth FROM chain WHERE depth > 0 AND ${visible} ORDER BY depth DESC
      `,
      values,
    );
    return rows.map((row) => ({ id: Number(row.id), kind: row.kind, name: row.name }));
  }

  /**
   * `ancestors` for a whole page of objects in one walk (`P-214`) — what a flat search result
   * needs to say *which* `Ping` it is, without a breadcrumb request per row.
   *
   * The same chain as `ancestors`, root first and excluding the object, one walk per origin in a
   * single statement. An id with no row gets no entry, rather than an empty path that would read
   * as "directly under nothing": the object was deleted between the caller's read and this one.
   */
  async paths(
    q: Queryable,
    ids: readonly ObjectId[],
    visibility: Visibility,
  ): Promise<Map<ObjectId, ObjectRef[]>> {
    const out = new Map<ObjectId, ObjectRef[]>();
    if (ids.length === 0) return out;

    const rows = await q.query<{
      origin: string;
      id: string;
      kind: ObjectKind;
      name: string;
      depth: number;
    }>(
      `
      WITH RECURSIVE chain AS (
        SELECT o.id AS origin, o.id, o.parent_id, o.kind, o.name, 0 AS depth
        FROM object o
        WHERE o.id = ANY($1::bigint[])

        UNION ALL

        SELECT chain.origin, parent.id, parent.parent_id, parent.kind, parent.name, chain.depth + 1
        FROM object parent
        JOIN chain ON parent.id = chain.parent_id
        WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT origin, id, kind, name, depth FROM chain ORDER BY origin, depth DESC
      `,
      [ids],
    );

    const chains = new Map<ObjectId, typeof rows>();
    for (const row of rows) {
      const origin = Number(row.origin);
      const chain = chains.get(origin);
      if (chain === undefined) chains.set(origin, [row]);
      else chain.push(row);
    }
    for (const [origin, chain] of chains) {
      // **Trimmed to what the reader can see** (`A-12`), by the rule the breadcrumb follows: the
      // containers above a granted branch are outside it, and a hole in the middle of a path is
      // skipped. Decided on the whole root-first chain, the object included, which is what
      // `Visibility.trim` needs — a boundary anywhere on it can change the answer below it.
      const seen = new Set(visibility.trim(chain.map((row) => Number(row.id))));
      // Depth 0 is the object itself: read so that an existing root still gets its empty path,
      // and left out of that path, as `ancestors` leaves it out of the breadcrumb.
      out.set(
        origin,
        chain
          .filter((row) => row.depth > 0 && seen.has(Number(row.id)))
          .map((row) => ({ id: Number(row.id), kind: row.kind, name: row.name })),
      );
    }
    return out;
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
   *
   * **Given a restricted `visibility`, only the ancestors it keeps are covered** (`A-49`): the
   * object and the steps of its path `Visibility.trim` leaves, which are what a trimmed breadcrumb
   * shows. Over the whole chain, a rename or a comment on an ancestor the reader cannot see moved
   * their tag and answered them 200 with an unchanged body — the one bit, and the time, of an edit
   * they were not to know of. A caller whose answer carries what hidden ancestors hand down, the
   * inherited settings and credentials, is not given one, and is covered by all of it.
   */
  async chainValidator(
    q: Queryable,
    id: ObjectId,
    salt: string,
    visibility?: Visibility,
  ): Promise<string | null> {
    if (visibility !== undefined && !visibility.everything) {
      return this.#visibleChainValidator(q, id, salt, visibility);
    }
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

  /** `chainValidator` over the object and the ancestors `visibility` keeps (`A-49`). */
  async #visibleChainValidator(
    q: Queryable,
    id: ObjectId,
    salt: string,
    visibility: Visibility,
  ): Promise<string | null> {
    const rows = await q.query<{ id: string; version: string; depth: number }>(
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
      SELECT id::text AS id, version::text AS version, depth FROM chain ORDER BY depth DESC
      `,
      [id],
    );
    if (rows.length === 0) return null;
    // Decided on the whole root-first path, as the breadcrumb is. The object itself is kept: the
    // reader is answered about it only because they can see it.
    const kept = new Set(visibility.trim(rows.map((row) => Number(row.id))));
    const covered = rows
      .filter((row) => kept.has(Number(row.id)))
      .reverse()
      .map((row) => `${row.id}:${row.version}`);
    return createHash('md5')
      .update(covered.join(',') + salt)
      .digest('hex');
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
  ): Promise<number> {
    if (drafts.length === 0) return 0;
    const rows = await q.query<{ id: number }>(
      `INSERT INTO channel (sensor_id, key, name, unit, is_primary, lookup_id, counter_bits,
                            limits, limits_source)
       SELECT $1, key, name, unit, is_primary, lookup_id, counter_bits,
              COALESCE(limits, '{}'::jsonb),
              CASE WHEN limits IS NULL THEN 'unset' ELSE 'declared' END
       FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[], $6::text[], $7::smallint[],
                   $8::jsonb[])
            AS d(key, name, unit, is_primary, lookup_id, counter_bits, limits)
       RETURNING id`,
      [
        sensorId,
        drafts.map((draft) => draft.key),
        drafts.map((draft) => draft.name),
        drafts.map((draft) => draft.unit ?? ''),
        drafts.map((draft) => draft.isPrimary ?? false),
        drafts.map((draft) => draft.lookup ?? null),
        drafts.map((draft) => draft.counterBits ?? null),
        drafts.map((draft) => declaredLimitsJson(draft)),
      ],
    );
    return rows.length;
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
   *
   * **`unseen` are written without a version bump** (`A-46`, migration 066): the siblings the
   * caller cannot see, which a reorder keeps where they are. One of them is written only when its
   * row does not hold its place yet — on a parent nobody had arranged, where a NULL sorts after
   * every place and would slide it to the end. Nothing its owners hold goes stale over that. The
   * setting that spares them is cleared straight after their statement, so the rows written after
   * it, and anything else in the transaction, bump as ever.
   */
  async writeSiblingOrder(
    q: Queryable,
    parentId: ObjectId,
    ordered: readonly ObjectId[],
    unseen: ReadonlySet<ObjectId> = new Set(),
  ): Promise<number> {
    const write = async (ids: readonly ObjectId[]): Promise<number> => {
      if (ids.length === 0) return 0;
      const rows = await q.query<{ id: string }>(
        `UPDATE object o
         SET sort_order = w.pos
         FROM unnest($1::bigint[], $2::int[]) AS w(id, pos)
         WHERE o.id = w.id
           AND o.parent_id = $3
           AND o.sort_order IS DISTINCT FROM w.pos
         RETURNING o.id`,
        [[...ids], ids.map((id) => ordered.indexOf(id)), parentId],
      );
      return rows.length;
    };

    let written = 0;
    const hidden = ordered.filter((id) => unseen.has(id));
    if (hidden.length > 0) {
      await q.query(`SELECT set_config('ms.sibling_order_only', 'on', true)`);
      written += await write(hidden);
      await q.query(`SELECT set_config('ms.sibling_order_only', 'off', true)`);
    }
    return written + (await write(ordered.filter((id) => !unseen.has(id))));
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
      lookup_id: string | null;
    }>(
      `SELECT id, sensor_id, key, name, unit, is_primary, scale_mul, scale_div, decimals,
              limits, spike_min, spike_max, show_in_graph, show_in_table, lookup_id
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
      lookupId: row.lookup_id,
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
      // `limits_source` moves to `operator` and stays there. A person clearing every threshold
      // writes `{}`, which is indistinguishable from a channel nobody has touched — so without
      // this the next start would put the declared default back on top of a deliberate removal
      // (`S-18`).
      `UPDATE channel SET limits = $3::jsonb, limits_source = 'operator'
       WHERE sensor_id = $1 AND key = $2
       RETURNING id`,
      [sensorId, key, JSON.stringify(limits)],
    );
    return rows.length > 0;
  }

  /** Scaling, spike filter and decimal places (`M-07`), written as one row of settings. */
  async setChannelProcessing(
    q: Queryable,
    sensorId: ObjectId,
    key: string,
    processing: ChannelProcessing,
  ): Promise<boolean> {
    const rows = await q.query<{ id: number }>(
      `UPDATE channel
       SET scale_mul = $3::numeric, scale_div = $4::numeric,
           decimals = $5, spike_min = $6, spike_max = $7
       WHERE sensor_id = $1 AND key = $2
       RETURNING id`,
      [
        sensorId,
        key,
        processing.scaleMul,
        processing.scaleDiv,
        processing.decimals,
        processing.spikeMin,
        processing.spikeMax,
      ],
    );
    return rows.length > 0;
  }

  /** Points a channel at a lookup, or at none (`M-06`). */
  async setChannelLookup(
    q: Queryable,
    sensorId: ObjectId,
    key: string,
    lookupId: string | null,
  ): Promise<boolean> {
    const rows = await q.query<{ id: number }>(
      `UPDATE channel SET lookup_id = $3
       WHERE sensor_id = $1 AND key = $2
       RETURNING id`,
      [sensorId, key, lookupId],
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

  /**
   * The sensors at or under these objects whose type is one of these (`A-29`).
   *
   * For the check a write runs on what it leaves behind: a moved group carries its sensors to a
   * new audience, and a cloned one copies their parameters. Handed sensor ids, it is a walk of
   * nothing, which is what `create` and `update` pass.
   */
  async sensorsOfTypesAtOrUnder(
    q: Queryable,
    ids: readonly ObjectId[],
    types: readonly string[],
  ): Promise<
    { id: ObjectId; name: string; sensorType: string; params: Record<string, unknown> }[]
  > {
    if (ids.length === 0 || types.length === 0) return [];
    const rows = await q.query<{
      id: string;
      name: string;
      type: string;
      params: Record<string, unknown>;
    }>(
      `
      WITH RECURSIVE subtree AS (
        SELECT id, 0 AS depth FROM object WHERE id = ANY($1::bigint[])

        UNION ALL

        SELECT c.id, subtree.depth + 1
        FROM object c
        JOIN subtree ON c.parent_id = subtree.id
        WHERE subtree.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT o.id, o.name, sc.type, sc.params
      -- Distinct ids rather than distinct rows: two of the objects asked about can be one
      -- inside the other, and comparing whole parameter documents to find that out is waste.
      FROM (SELECT DISTINCT id FROM subtree) walked
      JOIN object o ON o.id = walked.id
      JOIN sensor_config sc ON sc.object_id = o.id
      WHERE sc.type = ANY($2::text[])
      ORDER BY o.id
      `,
      [ids, types],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      sensorType: row.type,
      params: row.params,
    }));
  }

  /**
   * Records who vouched for these sensors (`A-29`, migration 059): an account, or the installation.
   *
   * Written by the write that passed the check, in its transaction, so a sensor never carries a
   * voucher that was not checked against what it names now.
   */
  async recordVoucher(
    q: Queryable,
    sensorIds: readonly ObjectId[],
    voucher: { kind: 'account'; userId: number } | { kind: 'installation' },
  ): Promise<void> {
    if (sensorIds.length === 0) return;
    await q.query(
      `UPDATE sensor_config SET vouched_by = $2, vouched_by_user = $3
       WHERE object_id = ANY($1::bigint[])`,
      [sensorIds, voucher.kind, voucher.kind === 'account' ? voucher.userId : null],
    );
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

  /**
   * Kind and state totals for a whole subtree, aggregated in the database (`U-14`).
   *
   * **`count(*)` has no limit to exceed**, which is the whole reason this exists beside
   * `subtree`. Counting the rows of a bounded depth-first read gives an answer that is exact
   * for a small installation and quietly wrong for a large one — the failure mode a number on
   * an overview page can least afford, because a number is read as a fact.
   *
   * **One query, not two.** The state histogram is a second grouping column that is null for
   * everything which is not a sensor, so the walk — the expensive half — happens once. That
   * leaves at most a dozen rows: four kinds, and eight states under one of them.
   */
  async subtreeCounts(q: Queryable, id: ObjectId, visibility: Visibility): Promise<SubtreeCounts> {
    const values: unknown[] = [id];
    // **Absent, not counted** (`A-12`). A total that included a hole would say how many sensors
    // are down in a branch the reader cannot see.
    const visible = visibility.where('s.id', (value) => `$${String(values.push(value))}`);
    const rows = await q.query<{ kind: ObjectKind; state: SensorState | null; n: number }>(
      `
      WITH RECURSIVE subtree AS (
        SELECT id, kind, 0 AS depth FROM object WHERE id = $1
        UNION ALL
        SELECT c.id, c.kind, subtree.depth + 1
        FROM object c JOIN subtree ON c.parent_id = subtree.id
        WHERE subtree.depth < ${String(MAX_WALK_DEPTH)}
      )
      SELECT s.kind,
             -- Null for every other kind, so the two groupings share one walk. A sensor with no
             -- runtime row has never reported, which is exactly Unknown.
             CASE WHEN s.kind = 'sensor' THEN coalesce(sr.state, 'unknown') END AS state,
             count(*)::int AS n
      FROM subtree s
      LEFT JOIN sensor_runtime sr ON sr.object_id = s.id AND s.kind = 'sensor'
      WHERE ${visible}
      GROUP BY 1, 2
      `,
      values,
    );

    const objects = { probe: 0, group: 0, device: 0, sensor: 0, total: 0 };
    const sensorStates = Object.fromEntries(SENSOR_STATES.map((state) => [state, 0])) as Record<
      SensorState,
      number
    >;

    // `count(*)::int` and not the default bigint, which `pg` hands over as a string.
    for (const row of rows) {
      objects.total += row.n;
      if (row.kind !== 'root') objects[row.kind] += row.n;
      if (row.state !== null) sensorStates[row.state] += row.n;
    }

    return { objects, sensorStates };
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

  /**
   * Writes the object row and its kind's configuration row, and returns the id.
   *
   * **Deliberately does not read the object back.** It used to, and the detail it returned was
   * wrong by the time the caller had it: declaring a sensor's channels bumps the owner's version
   * by trigger, so `create` read the row, `createChannels` re-read the version, and the service
   * patched one into the other. Two reads to answer what one read after the writes answers
   * exactly. The caller does the read when the object is finished (`P-29`).
   */
  async insert(q: Queryable, input: CreateObjectInput): Promise<ObjectId> {
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

    return id;
  }

  /**
   * Writes one level of a subtree in one statement each (`P-19`).
   *
   * **The ids come back in input order, and the sort is what recovers it.** The sequence is
   * advanced once per row as the rows are produced, so sorting the returned ids ascending gives
   * back the order they were produced in. Relying on the order of the `RETURNING` rows
   * themselves would not be sound; relying on the order a sequence hands numbers out within one
   * statement is.
   *
   * The `ORDER BY d.ord` asks for the production order explicitly. **A function scan over
   * `jsonb_to_recordset` yields array order anyway, so no test can currently tell whether it is
   * there** — it is a guarantee requested rather than one demonstrated, and it costs a sort of a
   * few thousand rows. What *is* demonstrated is the property it protects: a test builds a wide
   * subtree and checks every child against its parent in the database.
   *
   * The hierarchy trigger still fires per row, which is right: the kind rules are the database's
   * and this path does not get a private version of them. What it stops paying is a statement, a
   * round trip and a transaction per object.
   */
  async createLevel(
    q: Queryable,
    nodes: readonly { parentId: ObjectId; input: CreateObjectInput }[],
  ): Promise<ObjectId[]> {
    if (nodes.length === 0) return [];

    // **`jsonb_to_recordset` rather than parallel `unnest` arrays, and `tags` is the reason.**
    // `unnest` flattens a multidimensional array completely, so a column of *lists* cannot go
    // through it — five nodes with two tags each arrive as ten rows of one string. JSON carries
    // the nesting, and ragged lists as well, which a Postgres array literal does not.
    const rows = await q.query<{ id: string }>(
      `INSERT INTO object (parent_id, kind, name, tags, priority, comments)
       SELECT d.parent_id, d.kind::object_kind, d.name,
              ARRAY(SELECT jsonb_array_elements_text(d.tags)),
              d.priority, d.comments
       FROM jsonb_to_recordset($1::jsonb)
            AS d(ord int, parent_id bigint, kind text, name text, tags jsonb,
                 priority smallint, comments text)
       ORDER BY d.ord
       RETURNING id`,
      [
        JSON.stringify(
          nodes.map((node, index) => ({
            ord: index,
            parent_id: node.parentId,
            kind: node.input.kind,
            name: node.input.name,
            tags: node.input.tags ?? [],
            priority: node.input.priority ?? 3,
            comments: node.input.comments ?? '',
          })),
        ),
      ],
    );
    const ids = rows.map((row) => Number(row.id)).sort((a, b) => a - b);
    /* c8 ignore next 3 -- the insert either writes every row or throws */
    if (ids.length !== nodes.length) {
      throw new Error(`inserted ${String(ids.length)} objects for ${String(nodes.length)} nodes`);
    }

    // One statement per kind rather than per object. Probes, devices and sensors each have a
    // side table, and a level is usually all one kind — a level of five hundred devices is one
    // insert here, not five hundred.
    const probes: { id: ObjectId; gid: string | null }[] = [];
    const devices: { id: ObjectId; host: string; ipVersion: string }[] = [];
    const sensors: { id: ObjectId; type: string; params: string }[] = [];
    nodes.forEach((node, index) => {
      const id = ids[index];
      /* c8 ignore next -- lengths were checked above */
      if (id === undefined) return;
      if (node.input.kind === 'probe') {
        probes.push({ id, gid: node.input.gid ?? null });
      } else if (node.input.kind === 'device') {
        devices.push({
          id,
          host: node.input.host,
          ipVersion: node.input.ipVersion ?? 'auto',
        });
      } else if (node.input.kind === 'sensor') {
        sensors.push({
          id,
          type: node.input.sensorType,
          params: JSON.stringify(node.input.params ?? {}),
        });
      }
    });

    if (probes.length > 0) {
      await q.query(
        `INSERT INTO probe_config (object_id, gid)
         SELECT * FROM unnest($1::bigint[], $2::text[])`,
        [probes.map((p) => p.id), probes.map((p) => p.gid)],
      );
    }
    if (devices.length > 0) {
      await q.query(
        `INSERT INTO device_config (object_id, host, ip_version)
         SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[])`,
        [devices.map((d) => d.id), devices.map((d) => d.host), devices.map((d) => d.ipVersion)],
      );
    }
    if (sensors.length > 0) {
      await q.query(
        `INSERT INTO sensor_config (object_id, type, params)
         SELECT object_id, type, params::jsonb
         FROM unnest($1::bigint[], $2::text[], $3::text[]) AS d(object_id, type, params)`,
        [sensors.map((s) => s.id), sensors.map((s) => s.type), sensors.map((s) => s.params)],
      );
    }

    return ids;
  }

  /**
   * Declares channels for many sensors at once (`P-19`).
   *
   * The single-sensor version reads the owner's version back so a caller gets an ETag that does
   * not 412 on its own first write. Nothing here needs that: a bulk create answers with ids
   * rather than with details, and a caller who wants an ETag reads the object.
   */
  async createChannelsFor(
    q: Queryable,
    drafts: readonly { sensorId: ObjectId; draft: ChannelDraft }[],
  ): Promise<number> {
    if (drafts.length === 0) return 0;
    const rows = await q.query<{ id: number }>(
      `INSERT INTO channel (sensor_id, key, name, unit, is_primary, lookup_id, counter_bits,
                            limits, limits_source)
       SELECT sensor_id, key, name, unit, is_primary, lookup_id, counter_bits,
              COALESCE(limits, '{}'::jsonb),
              CASE WHEN limits IS NULL THEN 'unset' ELSE 'declared' END
       FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::boolean[],
                   $6::text[], $7::smallint[], $8::jsonb[])
            AS d(sensor_id, key, name, unit, is_primary, lookup_id, counter_bits, limits)
       RETURNING id`,
      [
        drafts.map((entry) => entry.sensorId),
        drafts.map((entry) => entry.draft.key),
        drafts.map((entry) => entry.draft.name),
        drafts.map((entry) => entry.draft.unit ?? ''),
        drafts.map((entry) => entry.draft.isPrimary ?? false),
        drafts.map((entry) => entry.draft.lookup ?? null),
        drafts.map((entry) => entry.draft.counterBits ?? null),
        drafts.map((entry) => declaredLimitsJson(entry.draft)),
      ],
    );
    return rows.length;
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
    if (patch.inheritsTriggers !== undefined) {
      sets.push(`inherits_triggers = ${add(patch.inheritsTriggers)}`);
    }

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
   *
   * **Only what `visibility` sees is copied** (`A-35`), and the source must be visible to it —
   * the route's `write` on the source is what makes it so. The walk stops at every hidden child,
   * so a `none` carved beneath the source is neither copied nor counted: copied, it would be a
   * readable, writable duplicate of a hole, carrying the hidden sensors' `writeOnly` parameters,
   * and the count would say how many objects the hole holds.
   *
   * **The grants on the copied objects are copied too**, every group's, as their settings are:
   * own rows only, so the copy inherits from where it lands and keeps the exceptions its source
   * was given. Without them a `none` carved for another group on something the caller can see
   * vanished from the copy, and that group read it. They are returned for the audit.
   */
  async copySubtree(
    q: Queryable,
    sourceId: ObjectId,
    targetParentId: ObjectId,
    rootName: string,
    maxObjects: number,
    visibility: Visibility,
  ): Promise<{
    cloneRootId: ObjectId;
    counts: CloneCounts;
    droppedCredentialKinds: string[];
    grants: CopiedGrant[];
  }> {
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

    // Every row the walk admits has a visible parent, which is the one shape
    // `whereChildOfVisible` answers for without a walk of its own.
    const walkValues: unknown[] = [sourceId];
    const seen = visibility.whereChildOfVisible(
      'c.id',
      (value) => `$${String(walkValues.push(value))}`,
    );
    await q.query(
      `
      WITH RECURSIVE src AS (
        SELECT id, parent_id, 0 AS depth FROM object WHERE id = $1
        UNION ALL
        SELECT c.id, c.parent_id, src.depth + 1
        FROM object c JOIN src ON c.parent_id = src.id
        WHERE src.depth < ${String(MAX_WALK_DEPTH)} AND ${seen}
      )
      INSERT INTO clone_map (src_id, new_id, depth)
      SELECT id, nextval(pg_get_serial_sequence('object', 'id')), depth FROM src
      `,
      walkValues,
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
        INSERT INTO object
          (id, parent_id, kind, name, tags, priority, comments, inherits_triggers)
        OVERRIDING SYSTEM VALUE
        SELECT m.new_id,
               CASE WHEN m.depth = 0 THEN $1 ELSE pm.new_id END,
               o.kind,
               CASE WHEN m.depth = 0 THEN $2 ELSE o.name END,
               -- The fence copies with the object (N-16): a clone of a lab device is still a
               -- lab device, and one that started notifying nobody must not start notifying.
               o.tags, o.priority, o.comments, o.inherits_triggers
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

    // **The triggers travel with the fence** (`P-141`). The clone already copies
    // `inherits_triggers` — a clone of a lab device is still a lab device — and copied none of
    // the triggers the fence exists to protect. A cloned object with the fence up inherited
    // nothing and owned nothing: it notified *nobody*, which is the one failure a monitoring
    // system must not arrive at quietly, and the object looked identical to a working one.
    //
    // `enabled` travels too: a trigger somebody switched off is switched off on the copy.
    const triggerRows = await q.query<{ count: string }>(`
      WITH inserted AS (
        INSERT INTO notification_trigger (object_id, kind, settings, enabled)
        SELECT m.new_id, t.kind, t.settings, t.enabled
        FROM clone_map m JOIN notification_trigger t ON t.object_id = m.src_id
        RETURNING 1
      )
      SELECT count(*) AS count FROM inserted
    `);

    // Asked before it is written because the insert bumps the access epoch whether or not it
    // inserts anything (migration 052), and most clones carry no grant at all: a bulk clone of
    // five hundred devices would otherwise send every open stream back to re-resolve.
    const granted = await q.query<{ any: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM object_access a JOIN clone_map m ON m.src_id = a.object_id
      ) AS any
    `);
    const grantRows =
      granted[0]?.any === true
        ? await q.query<{
            object_id: string;
            group_id: string;
            name: string;
            right_: AccessRight;
          }>(`
            WITH inserted AS (
              INSERT INTO object_access (object_id, group_id, right_, granted_by)
              SELECT m.new_id, a.group_id, a.right_, a.granted_by
              FROM clone_map m JOIN object_access a ON a.object_id = m.src_id
              RETURNING object_id, group_id, right_
            )
            SELECT i.object_id::text AS object_id, i.group_id::text AS group_id, g.name, i.right_
            FROM inserted i JOIN user_group g ON g.id = i.group_id
            ORDER BY i.object_id, lower(g.name)
          `)
        : [];

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
      trigger: Number(triggerRows[0]?.count ?? 0),
      total,
    };

    return {
      cloneRootId: Number(rootRows[0]?.new_id),
      counts,
      droppedCredentialKinds: droppedRows.map((row) => row.kind),
      grants: grantRows.map((row) => ({
        objectId: Number(row.object_id),
        groupId: Number(row.group_id),
        groupName: row.name,
        right: row.right_,
      })),
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

/**
 * A draft's declared thresholds as a `jsonb` parameter, or null where the type declares none.
 *
 * Null rather than `'{}'`, because the two insert statements read it to decide `limits_source`:
 * a channel with no declaration is `unset` and eligible for one later, and one with a
 * declaration is `declared` from the moment it exists (`S-18`).
 */
function declaredLimitsJson(draft: ChannelDraft): string | null {
  return draft.limits === undefined ? null : JSON.stringify(limitsFromDeclaration(draft.limits));
}
