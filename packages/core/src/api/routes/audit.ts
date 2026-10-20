// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import type { Visibility } from '../../auth/access.js';
import type { FieldChange } from '../../audit/diff.js';
import { AUDIT_CATEGORIES, type AuditEntry, type AuditRepository } from '../../audit/store.js';
import type { Database, Queryable } from '../../db/pool.js';
import { ACTOR_KINDS, type ActorKind } from '../../objects/audit.js';
import { DEPENDENCY_MASTER_ID } from '../../settings/registry.js';
import { ADMIN, clears, onObject, visibilityOf } from '../authorization.js';

export interface AuditRoutesOptions {
  db: Database;
  audit: AuditRepository;
}

const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
} as const;

/**
 * The id of the oldest entry already seen. Audit ids are monotonic, so this is a keyset cursor
 * that happens to be readable — there is nothing to hide in it, and an operator debugging a
 * paging problem can see where they are. A value outside it is told so in words (`P-372`).
 */
const beforeCursor = {
  type: 'string',
  pattern: '^[0-9]{1,19}$',
  'x-patternMessage':
    'must be an audit entry id, 1 to 19 digits, such as the last page’s nextBefore',
} as const;

const auditQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    before: beforeCursor,
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
  },
} as const;

interface AuditQueryString {
  before?: string;
  limit: number;
}

/** The global list's own filters, on top of paging. */
const logQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    objectId: { type: 'integer', minimum: 1 },
    // One category or several; a repeat is taken, being `= ANY(…)` (`P-365`).
    category: {
      oneOf: [
        { enum: [...AUDIT_CATEGORIES] },
        {
          type: 'array',
          items: { enum: [...AUDIT_CATEGORIES] },
          maxItems: AUDIT_CATEGORIES.length,
        },
      ],
    },
    // One of `ACTOR_KINDS`, which is `audit_log_actor_kind_check`, so a kind outside it can match
    // no entry (`P-362`). As `category` is: one value or several, at most as many as there are
    // kinds. A repeat is taken, as in every such filter (`P-365`): it is `= ANY(…)`, so
    // `?actorKind=user&actorKind=user` answers what one does (`KIND_FILTER` in `objects.ts`).
    actorKind: {
      oneOf: [
        { enum: [...ACTOR_KINDS] },
        { type: 'array', items: { enum: [...ACTOR_KINDS] }, maxItems: ACTOR_KINDS.length },
      ],
    },
    actorRef: {
      type: 'string',
      maxLength: 64,
      description:
        'One specific actor — a user id, a token id, a component name. "Everything this person ' +
        'did" is the question an audit log gets opened for, and `actorKind` cannot answer it: ' +
        'it narrows to all users, which during an incident is everybody. Pair it with ' +
        '`actorKind`, because an id is only unique within a kind.',
    },
    from: { type: 'string', maxLength: 64 },
    to: { type: 'string', maxLength: 64 },
    before: beforeCursor,
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
  },
} as const;

interface LogQueryString extends AuditQueryString {
  objectId?: number;
  category?: string | string[];
  actorKind?: ActorKind | ActorKind[];
  actorRef?: string;
  from?: string;
  to?: string;
}

/** Accepts one or several, because a query string spells both the same way. */
function many(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/** A date that parsed, or undefined — the filter is dropped rather than the request refused. */
function when(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/**
 * The summary fields that count objects beneath an entry's object (`A-46`): a pause's, a resume's,
 * an acknowledgement's and a drill's sensors, a move's objects and a clone's copies. Each was
 * counted over whoever acted — an administrator counts everything — so for a reader with a hole
 * beneath the object it counts the hole.
 */
const COUNTS: readonly string[] = ['sensorsAffected', 'movedCount', 'clonedCount'];

/**
 * Every place an entry names another object by id, rewritten through `f` (`A-51`): where an
 * object moved from and to, and the probes it left and joined; the parent a reorder was among;
 * the source of a clone; and a dependency's master, before and after.
 */
function throughNamed(entry: AuditEntry, f: (value: unknown) => unknown): AuditEntry {
  const summary = (keys: readonly string[]): Record<string, unknown> => {
    const out = { ...entry.summary };
    for (const key of keys) if (key in out) out[key] = f(out[key]);
    return out;
  };
  const diff = (field: string): FieldChange[] =>
    entry.diff.map((change) =>
      change.field === field
        ? { ...change, before: f(change.before), after: f(change.after) }
        : change,
    );
  switch (entry.action) {
    case 'object.moved':
      return { ...entry, summary: summary(['fromProbeId', 'toProbeId']), diff: diff('parentId') };
    case 'object.reordered':
      return { ...entry, summary: summary(['parentId']) };
    case 'object.cloned':
      return { ...entry, summary: summary(['sourceId']) };
    case 'setting.set':
    case 'setting.reverted':
      return entry.summary['key'] === DEPENDENCY_MASTER_ID.key
        ? { ...entry, diff: diff(`setting.${DEPENDENCY_MASTER_ID.key}`) }
        : entry;
    default:
      return entry;
  }
}

/**
 * An object's history as this reader may have it (`A-46`).
 *
 * **What an entry counts is fixed when it is written, over somebody else's view**, and cannot be
 * counted again for this reader's. So a count goes for a reader who cannot see everything beneath
 * the object, and a reorder's positions for one who cannot see every sibling; what the entry says
 * happened stays. A reader who sees it all, an administrator always, keeps both — and a hole
 * filled in later brings them back, since nothing was deleted.
 *
 * **An id that names an object this reader cannot see reads null** (`A-51`), as one that names
 * an object since deleted does: the place something moved from, a clone's source, a master.
 */
async function asSeenBy(
  q: Queryable,
  objectId: number,
  items: readonly AuditEntry[],
  visibility: Visibility,
): Promise<AuditEntry[]> {
  if (visibility.everything) return [...items];
  const counts = (entry: AuditEntry): boolean => COUNTS.some((key) => key in entry.summary);
  const hidesBeneath = items.some(counts) && (await visibility.hidesBeneath(q, objectId));

  // Per parent, because an object's reorders are among the siblings of wherever it was then.
  const hidesSiblings = new Map<number, boolean>();
  for (const entry of items) {
    const parentId = entry.summary['parentId'];
    if (entry.action !== 'object.reordered' || typeof parentId !== 'number') continue;
    if (!hidesSiblings.has(parentId)) {
      hidesSiblings.set(parentId, await visibility.hidesChildOf(q, parentId));
    }
  }

  const named: number[] = [];
  for (const entry of items) {
    throughNamed(entry, (value) => {
      if (typeof value === 'number') named.push(value);
      return value;
    });
  }
  const seen = named.length === 0 ? new Set<number>() : await visibility.visibleAmong(q, named);

  return items.map((entry) => {
    const parentId = entry.summary['parentId'];
    const shown = throughNamed(entry, (value) =>
      typeof value === 'number' && !seen.has(value) ? null : value,
    );
    if (entry.action === 'object.reordered' && typeof parentId === 'number') {
      return hidesSiblings.get(parentId) === true ? { ...shown, diff: [] } : shown;
    }
    if (!hidesBeneath || !counts(entry)) return shown;
    return {
      ...shown,
      summary: Object.fromEntries(
        Object.entries(shown.summary).filter(([key]) => !COUNTS.includes(key)),
      ),
    };
  });
}

export async function auditRoutes(
  app: FastifyInstance,
  options: AuditRoutesOptions,
): Promise<void> {
  const { db, audit } = options;

  app.get<{ Params: { id: number }; Querystring: AuditQueryString }>(
    '/objects/:id/audit',
    {
      config: onObject('read'),
      schema: {
        tags: ['audit'],
        // A probe's trust entries are an administrator's since `A-46`; hidden ids null since
        // `A-51`.
        description:
          "An object's configuration history, newest first: who changed it, when, and what " +
          'changed. Page with `before`, using the `nextBefore` from the previous page. ' +
          'Sensor parameters changed are listed in `summary.paramsChanged` by key. Values ' +
          'appear in `diff` for parameters the sensor type does not mark `writeOnly`; a ' +
          'credential never appears in either, in any entry, at any age. **Grant entries are ' +
          "an administrator's**, as the grants themselves are: `full` on an object does not " +
          'let an account read who else may see it, so for anybody else they are left out ' +
          "and a page is still a full page of the rest. **So are a probe's trust entries** " +
          '— its address, where it may connect from and the notes on it — as ' +
          '`GET /probes` is. **A count of what is beneath the object** (`sensorsAffected`, ' +
          '`movedCount`, `clonedCount`) is left out for a reader who cannot see all of it, ' +
          "and a reorder's positions for one who cannot see every sibling: each was counted " +
          'over whoever acted, and would count what this reader cannot see. **An id naming an ' +
          'object the reader cannot see reads null**: where a move came from and went, ' +
          "the probes it left and joined, a reorder's parent, a clone's source and a " +
          "dependency's master.",
        params: idParams,
        querystring: auditQuery,
        response: { 200: { $ref: 'ms:auditPage' } },
      },
    },
    async (request) => {
      const { before, limit } = request.query;

      // Deliberately no existence check, and therefore no 404. The entry most worth reading is
      // the one recording a deletion, and it is written about an object that no longer exists;
      // refusing to serve history for something that has been deleted would hide exactly the
      // change someone came here to find.
      //
      // **Grant entries only for whoever may read the grants** (`A-26`). `GET
      // /objects/:id/access` is `ADMIN`, and its own entries say the same thing a line at a
      // time: which group may do what here, and who set it. `full` on an object does not let
      // an account read its grants, so it does not let it read their history either.
      //
      // **Probe-trust entries the same way** (`A-46`). `GET /probes` is `ADMIN`: where a probe
      // last called from, where it may call from and the notes on it are infrastructure, and a
      // branch handed its own site's probe was never granted them.
      const visibility = await visibilityOf(request);
      const items = await db.tx(async (q) =>
        asSeenBy(
          q,
          request.params.id,
          await audit.list(q, {
            objectId: request.params.id,
            ...(clears(request, 'admin') ? {} : { withoutCategories: ['grant', 'probe'] }),
            ...(before === undefined ? {} : { before }),
            limit,
          }),
          visibility,
        ),
      );

      return {
        items,
        nextBefore: items.length < limit ? null : (items.at(-1)?.id ?? null),
      };
    },
  );

  app.get<{ Querystring: LogQueryString }>(
    '/audit',
    {
      config: ADMIN,
      schema: {
        tags: ['audit'],
        description:
          'Configuration history across the whole installation, newest first — the object ' +
          'history third of the Logs view. Filter by `category` (the ' +
          "action's first segment), by `actorKind`, by time, or to one object. **`objectId` is " +
          'that object exactly, never its subtree**: the entry most worth reading is the one ' +
          'recording a deletion, and an object that has been deleted has no parent left to be ' +
          'found through, so a subtree walk would drop precisely those. Page with `before`.',
        querystring: logQuery,
        response: { 200: { $ref: 'ms:auditPage' } },
      },
    },
    async (request) => {
      const { objectId, category, actorKind, actorRef, from, to, before, limit } = request.query;
      const categories = many(category);
      const actorKinds = many(actorKind);
      const since = when(from);
      const until = when(to);

      const items = await db.tx((q) =>
        audit.list(q, {
          ...(objectId === undefined ? {} : { objectId }),
          ...(categories === undefined ? {} : { categories }),
          ...(actorKinds === undefined ? {} : { actorKinds }),
          ...(actorRef === undefined ? {} : { actorRef }),
          ...(since === undefined ? {} : { from: since }),
          ...(until === undefined ? {} : { to: until }),
          ...(before === undefined ? {} : { before }),
          limit,
        }),
      );

      return {
        items,
        nextBefore: items.length < limit ? null : (items.at(-1)?.id ?? null),
      };
    },
  );

  await Promise.resolve();
}
