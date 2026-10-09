// Side-effect import: @fastify/swagger augments FastifySchema with `description`, which the
// generated OpenAPI document carries into the API reference (H-07).
import '@fastify/swagger';
import { MAX_EXCEPTION_ADDRESSES } from '@ms/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ObjectError } from '../../objects/errors.js';
import { actorFor } from '../authentication.js';
import type { ObjectService } from '../../objects/service.js';
import type { BulkOperation, BulkService } from '../../objects/bulk.js';
import type { TreePlanInput } from '../../objects/tree-plan.js';
import { MAX_BULK } from '../../objects/bulk.js';
import { MAX_SETTING_KEY, settingRegistry } from '../../settings/registry.js';
import { MAX_TAG, MAX_TAGS } from '../../libraries/nodes.js';
import type { FailingSensors } from '../../objects/stored-params-check.js';
import type {
  CreateObjectInput,
  DeleteExpectation,
  ListSort,
  ObjectDetail,
  ObjectKind,
  SiblingMove,
  UpdateObjectInput,
} from '../../objects/types.js';
import { channelLimitsPatchSchema, channelProcessingPatchSchema } from '../schemas/objects.js';
import {
  acknowledgeRequestSchema,
  ACK_PRESETS,
  pauseRequestSchema,
  PAUSE_PRESETS,
} from '../schemas/pause.js';
import { SENSOR_STATES } from '../../state/tables.js';
import type { ChannelLimitsPatch } from '../../state/limits.js';
import {
  OBJECT_KINDS,
  WRITABLE_KINDS,
  type CarriedGrants,
  type ChannelProcessing,
  type ChannelRecord,
} from '../../objects/types.js';
import { CREDENTIAL_SET_KINDS } from '../../settings/inheritance.js';
import { decodeCursor } from '../pagination.js';
import { etagFor, optionalIfMatch, requireIfMatch, viewedChain } from '../preconditions.js';
import {
  ADMIN,
  INSTALLATION,
  READS,
  WRITES,
  clears,
  every,
  onBodyObject,
  onDerivedObject,
  onObject,
  onQueryObject,
  onSubtree,
  reachOf,
  sightOf,
  toAcknowledge,
  visibilityOf,
  writerFor,
} from '../authorization.js';
import {
  atLeast,
  type AccessService,
  type SubtreeAccess,
  type Visibility,
} from '../../auth/access.js';
import { AuthError } from '../../auth/errors.js';

/**
 * Which grants this caller's clone carries (`A-76`): every one for whoever may grant, which is
 * the bar the grant routes hold (`ADMIN`, role and token scope both), and only the restrictions
 * for anybody else. One function for the direct, in-place and bulk clones, so the three agree.
 */
function grantsCarriedBy(request: FastifyRequest): CarriedGrants {
  return clears(request, 'admin') ? 'all' : 'restrictions';
}

/** An outcome for an id the caller may not change, in the shape the route already returns. */
interface RefusedOutcome {
  objectId: number;
  ok: false;
  problem: string;
  code: string;
}

/**
 * Splits a bulk selection into the ids this principal may write and the ones it may not.
 *
 * Batched: `resolveManyFor` is one query for the whole selection, because a bulk request is
 * exactly the shape that turns a per-object walk into six hundred round trips.
 *
 * `subtree` is for an operation that takes everything beneath each object with it — a delete,
 * a move — and asks for `write` on all of it, as `onSubtree` does for one object (`A-35`).
 * Without it a cascading delete of a device read the count out of the refusal and destroyed
 * the sensor carved out of it.
 */
async function partitionByRight(
  access: AccessService | undefined,
  authorizing: boolean,
  request: FastifyRequest,
  ids: readonly number[],
  subtree: boolean,
): Promise<{ allowed: number[]; refused: RefusedOutcome[] }> {
  const principal = request.principal;
  if (!authorizing || access === undefined || principal === undefined) {
    return { allowed: [...ids], refused: [] };
  }
  const rights: ReadonlyMap<number, SubtreeAccess> = subtree
    ? await access.resolveSubtreesFor(principal, ids)
    : new Map(
        [...(await access.resolveManyFor(principal, ids))].map(([id, right]) => [
          id,
          { own: right, weakest: right },
        ]),
      );
  const allowed: number[] = [];
  const refused: RefusedOutcome[] = [];
  for (const id of ids) {
    const right = rights.get(id) ?? { own: 'none', weakest: 'none' };
    if (atLeast(right.weakest, 'write')) {
      allowed.push(id);
      continue;
    }
    refused.push({
      objectId: id,
      ok: false,
      // Says that there is something beneath, and never what or how much (`A-16`).
      problem: atLeast(right.own, 'write')
        ? 'this account may not change everything beneath that object'
        : 'this account may not change that object',
      code: 'AUTH_FORBIDDEN',
    });
  }
  return { allowed, refused };
}

export interface ObjectRoutesOptions {
  service: ObjectService;
  /** Bulk operations over a selection (`D-09`). */
  bulk: BulkService;
  /**
   * Folded into the cache validator for inheritance-bearing responses. The last input to a
   * resolved setting is its registry default, which lives in code — so an upgrade has to
   * invalidate the caches even when no row changed. See `validatorSalt` for why this is the
   * commit and not the version (`H-11`).
   */
  validatorSalt: string;
  /**
   * Present whenever authentication is on, and the bulk route is why (`A-11`).
   *
   * Every other object route names its object in the path, so the global guard resolves the
   * right before the handler runs. A bulk request names its objects in the body — a list of
   * them — and one bar for the whole request cannot express "this account may pause four of
   * these six". So the ids are partitioned here, and the ones it may not touch come back as
   * ordinary failed outcomes rather than failing the request: a selection made in a tree view
   * routinely includes something the operator cannot see.
   */
  access?: AccessService;
  /**
   * Whether the authorisation layer is switched on for this installation (`R10`).
   *
   * **The partition has to ask, because it is the one check that does not live in the hook.**
   * Every other bar in `A-11` stands down when `auth.required` is false; this one is a call in a
   * handler, so without the flag it kept resolving per-object rights in an installation where
   * nothing else did — and `AccessService` treats a role as a ceiling, never a grant, so a
   * perfectly ordinary `readwrite` account with no `object_access` row was refused *every* id in
   * a bulk selection while the single-object route beside it succeeded for the same object.
   */
  authorizing?: boolean;
  /**
   * The sensors whose stored parameters their type now refuses (`StoredParamsCheck`, `P-375`),
   * which the listing's `invalidParams` filter narrows to. Absent where nothing checks them — the
   * route tests — and then the filter answers that it is not known.
   */
  invalidParams?: { failing(): FailingSensors };
}

/**
 * How soon to ask again while the start-up pass is still reading (`P-375`). It went over 20,000
 * sensors in a third of a second when measured (`P-358`), so a few seconds is generous.
 */
const PARAMS_CHECK_RETRY_SECONDS = 5;

interface ListQuery {
  parentId?: number;
  kind?: string | string[];
  tag?: string | string[];
  q?: string;
  host?: string;
  priorityMin?: number;
  sort?: ListSort;
  effective?: string | string[];
  invalidParams?: 'true';
  include?: string;
  cursor?: string;
  limit?: number;
}

const asArray = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/**
 * Each value once, in the order first given (`P-365`). A repeated filter value is taken, not
 * refused: see `KIND_FILTER`.
 */
const distinct = (value: string | string[] | undefined): string[] => [...new Set(asArray(value))];

/**
 * One kind or several, both validated against the same list.
 *
 * **A repeat is taken, on purpose** (`P-365`), here and in every filter that takes one value or
 * several (`tag`, `effective`; the audit log's `category` and `actorKind`, the alarms' and the
 * state log's `state`, its `cause`, the notification log's `status`). No `uniqueItems`. Each is a
 * set — `= ANY(…)`, tags intersected, settings resolved per key — so `?kind=device&kind=device`
 * answers exactly what `?kind=device` does, and the listing takes each value once (`distinct`, and
 * tags case-folded in the repository), so a repeat costs nothing either. Refusing it would turn a
 * right answer into a 400, and the web client forwards its own page's parameters, which a person
 * can edit or bookmark with a repeat in them. Contrast `P-353`'s empty tag and `P-362`'s unknown
 * actor kind, refused because they answered *wrongly*, with an empty page. `maxItems` still bounds
 * the list at the number of values there are, so a repeat counts toward it.
 */
const KIND_FILTER = {
  oneOf: [
    { enum: [...OBJECT_KINDS] },
    { type: 'array', items: { enum: [...OBJECT_KINDS] }, maxItems: OBJECT_KINDS.length },
  ],
} as const;

/**
 * `tag` and `effective` take one value or several, and both forms are bounded alike (`P-347`):
 * the string and each element of the array by `minLength` and `maxLength`, the array by
 * `maxItems`. An empty value is refused in either form (`P-353`): `?tag=` is a tag no object
 * can carry, so it matched nothing, and `?effective=` reached the handler as an unknown key. A
 * type list rather than `KIND_FILTER`'s `oneOf`, which `P-337` kept so as not to change what
 * Fastify's `coerceTypes` does with it; the length bounds only read a string and `maxItems` only
 * an array.
 *
 * A tag is held to what an object's own tags are (`objectFields`: 100 characters, 50 of them),
 * as a library rule's effective-tag filter is. The filter is all-of over own and inherited tags,
 * and 50 is the most one object can carry itself: a search box sends one or two. A repeated tag,
 * in any case, is taken and walked once (`P-365`, at `KIND_FILTER`).
 */
const TAG_FILTER = {
  type: ['string', 'array'],
  items: { type: 'string', minLength: 1, maxLength: MAX_TAG },
  minLength: 1,
  maxLength: MAX_TAG,
  maxItems: MAX_TAGS,
} as const;

/**
 * A setting key is held to the length the settings routes take one in a path, and the list to
 * the number of keys there are: any more has a repeat in it. A repeat within that is taken and
 * resolved once (`P-365`, at `KIND_FILTER`). A key that fits and is unknown is still the
 * handler's refusal, which lists the known ones.
 */
const EFFECTIVE_FILTER = {
  type: ['string', 'array'],
  items: { type: 'string', minLength: 1, maxLength: MAX_SETTING_KEY },
  minLength: 1,
  maxLength: MAX_SETTING_KEY,
  maxItems: settingRegistry.keys.length,
} as const;

/**
 * The ids `?invalidParams=true` narrows to, or the 503 that says they are not known yet (`P-375`).
 *
 * **Not the part read so far.** Before the start-up pass has gone over every sensor the set is a
 * lower bound, and a listing of it would read as the answer — "these are the sensors to mend" —
 * to a client that had no reason to look for a flag beside it, as an empty list with a flag would
 * read as "none". Core Health's channel gaps for the same reason, and the two agree: the count is
 * a number exactly when this is a list. Waiting is short (the pass reads 20,000 sensors in a third
 * of a second), so it says when to ask again; after a pass that stopped short, it says the next
 * start checks again, and has no `Retry-After`, since asking again will not change it.
 */
function failingSensors(source: { failing(): FailingSensors } | undefined): readonly number[] {
  const answer: FailingSensors = source?.failing() ?? { kind: 'stopped' };
  switch (answer.kind) {
    case 'known':
      return answer.ids;
    case 'checking':
      throw new ObjectError(
        'OBJECT_PARAMS_NOT_CHECKED',
        'the start-up check of stored sensor parameters has not read every sensor yet; ask again ' +
          'in a few seconds',
        {
          context: { phase: 'stored-params-check' },
          details: { pass: 'checking' },
          retryAfterSeconds: PARAMS_CHECK_RETRY_SECONDS,
        },
      );
    case 'stopped':
      throw new ObjectError(
        'OBJECT_PARAMS_NOT_CHECKED',
        source === undefined
          ? 'this core does not check stored sensor parameters'
          : 'the start-up check of stored sensor parameters stopped before it had read every ' +
              'sensor (the core log says why); the next start checks again',
        { context: { phase: 'stored-params-check' }, details: { pass: 'stopped' } },
      );
  }
}

function assertKnownSettingKeys(keys: readonly string[]): void {
  for (const key of keys) {
    if (!settingRegistry.has(key)) {
      throw new ObjectError('OBJECT_INVALID', `unknown setting key "${key}"`, {
        context: { phase: 'validate-query' },
        details: { knownKeys: settingRegistry.keys },
      });
    }
  }
}

/**
 * Path and query parameters are validated at the boundary like every other input. Declaring
 * them also makes Fastify coerce `?limit=100` to a number, so the handler's types are honest
 * about what it actually receives.
 */
const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  // `object.id` is bigint, but a JS number is only exact below 2^53 and PostgreSQL rejects
  // anything past bigint outright. Bounding it here turns a driver-level 500 into a 400.
  properties: { id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
} as const;

/**
 * A credential write asked for as a preview (`U-21`): run whole, and rolled back.
 *
 * On the route that writes rather than beside it, so the bar is the write's own and there is one
 * handler to keep right. An enumeration and not a boolean, as `effective` is on the read: a
 * mistyped value is refused, where coercion would have made `?dryRun=yes` a real write.
 */
const dryRunQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { dryRun: { type: 'string', enum: ['true', 'false'] } },
} as const;

const credentialKindParams = {
  type: 'object',
  required: ['id', 'kind'],
  additionalProperties: false,
  properties: {
    id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    // Not an enum of the database's `credential_kind`: the service refuses a kind with no
    // transport behind it, and a 400 from the schema would say "not one of six" where the
    // service says which ones this build can actually use.
    kind: { type: 'string', minLength: 1, maxLength: 40 },
  },
} as const;

const settingKeyParams = {
  type: 'object',
  required: ['id', 'key'],
  additionalProperties: false,
  properties: {
    id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    key: { type: 'string', minLength: 1, maxLength: MAX_SETTING_KEY },
  },
} as const;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    parentId: { type: 'integer', minimum: 1 },
    // Enumerated here so an unknown kind is a 400 from the boundary rather than a 500 from
    // PostgreSQL failing to cast it to object_kind.
    // `oneOf`, not a top-level `enum` beside `items`: Fastify gives a string for one occurrence
    // and an array for several, and an `enum` is checked against the *whole* value — so the
    // array form failed validation and `?kind=device&kind=sensor` was a 400, even though the
    // handler has always called `asArray` on it. Found by `M-15`, which needed the same shape.
    kind: KIND_FILTER,
    tag: TAG_FILTER,
    q: {
      type: 'string',
      maxLength: 500,
      description:
        'Search: a case-insensitive substring of the name or, on a device, of its host. ' +
        '`%` and `_` are literal.',
    },
    host: {
      type: 'string',
      maxLength: 255,
      description: "A device's host exactly, case-insensitive. A substring is `q`'s job.",
    },
    priorityMin: { type: 'integer', minimum: 1, maximum: 5 },
    sort: { enum: ['name', 'id', 'manual'], default: 'name' },
    effective: EFFECTIVE_FILTER,
    invalidParams: {
      type: 'string',
      enum: ['true'],
      description:
        'Only the sensors whose stored parameters their type now refuses — what Core Health ' +
        'counts as `sensorsWithInvalidParams` — among what the caller can see, beside any other ' +
        'filter. Each is a sensor still running as stored; an edit sending its parameters is ' +
        'refused until they are mended, and the 400 names the paths. 503 ' +
        '`OBJECT_PARAMS_NOT_CHECKED` until the start-up check has read every sensor, with ' +
        '`Retry-After` while it is reading, and without when it stopped short: the next start ' +
        'checks again.',
    },
    include: {
      type: 'string',
      maxLength: 200,
      description:
        'Comma-separated expansions. `path` gives every item its ancestors, root first and ' +
        'excluding the item — what `/objects/{id}/ancestors` returns, for the whole page in ' +
        'one walk.',
    },
    cursor: { type: 'string', maxLength: 2048 },
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
  },
} as const;

const treeQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    maxDepth: { type: 'integer', minimum: 1, maximum: 20, default: 3 },
    limit: { type: 'integer', minimum: 1, maximum: 5000, default: 1000 },
    // `oneOf`, not a top-level `enum` beside `items`: Fastify gives a string for one occurrence
    // and an array for several, and an `enum` is checked against the *whole* value — so the
    // array form failed validation and `?kind=device&kind=sensor` was a 400, even though the
    // handler has always called `asArray` on it. Found by `M-15`, which needed the same shape.
    kind: KIND_FILTER,
    effective: EFFECTIVE_FILTER,
  },
} as const;

/**
 * Every state is `required`, so the histogram is a full one whether or not a state occurs.
 * `fast-json-stringify` would otherwise drop the zeros and leave each caller writing `?? 0`.
 */
const countsResponse = {
  type: 'object',
  additionalProperties: false,
  required: ['objects', 'sensorStates'],
  properties: {
    objects: {
      type: 'object',
      additionalProperties: false,
      required: ['probe', 'group', 'device', 'sensor', 'total'],
      properties: {
        probe: { type: 'integer' },
        group: { type: 'integer' },
        device: { type: 'integer' },
        sensor: { type: 'integer' },
        total: {
          type: 'integer',
          description:
            'Every object in the subtree, the one asked about included — so for the root it ' +
            'is one more than the four kinds sum to.',
        },
      },
    },
    sensorStates: {
      type: 'object',
      additionalProperties: false,
      required: [...SENSOR_STATES],
      properties: Object.fromEntries(SENSOR_STATES.map((state) => [state, { type: 'integer' }])),
    },
  },
};

const INCLUDE_TOKENS = ['settings', 'channels', 'credentials', 'ancestors'] as const;

/**
 * An object's answer is the caller's own (`A-32`): what it holds depends on their grants, and it
 * may be revalidated but never stored by a shared cache, which could otherwise hand one account's
 * copy to another behind the same proxy. The form the other per-caller routes send.
 */
const PRIVATE = 'private, max-age=0, must-revalidate';
type IncludeToken = (typeof INCLUDE_TOKENS)[number];

/** A listing's expansions. `path` is `ancestors` per row, named for what a row renders. */
const LIST_INCLUDE_TOKENS = ['path'] as const;

function parseTokens<T extends string>(raw: string | undefined, known: readonly T[]): Set<T> {
  const out = new Set<T>();
  if (raw === undefined || raw === '') return out;
  for (const token of raw.split(',').map((t) => t.trim())) {
    if (!(known as readonly string[]).includes(token)) {
      throw new ObjectError('OBJECT_INVALID', `unknown include token "${token}"`, {
        context: { phase: 'validate-query' },
        details: { known: [...known] },
      });
    }
    out.add(token as T);
  }
  return out;
}

const parseInclude = (raw: string | undefined): Set<IncludeToken> =>
  parseTokens(raw, INCLUDE_TOKENS);

/**
 * The ids of a sensor's retired channels, sorted, for the detail's validator (`P-322` review):
 * the one part of `?include=channels` that a reading, rather than a write, can change.
 */
const retiredOf = (channels: readonly ChannelRecord[]): string =>
  channels
    .filter((channel) => channel.retired)
    .map((channel) => channel.id)
    .sort((a, b) => a - b)
    .join(',');

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins are async by contract
export async function objectRoutes(
  app: FastifyInstance,
  options: ObjectRoutesOptions,
): Promise<void> {
  const { service, validatorSalt, bulk, access } = options;
  const authorizing = options.authorizing ?? false;

  /**
   * A write's answer, with the children its caller can see (`A-46`). An edit or a reorder of a
   * container answered `childCount` over every child, holes included, where a read of the same
   * object counts only what its reader can see (`A-12`).
   */
  const answerFor = async (
    request: FastifyRequest,
    detail: ObjectDetail,
  ): Promise<ObjectDetail> => {
    const visibility = await visibilityOf(request);
    return visibility.everything
      ? detail
      : { ...detail, childCount: await service.visibleChildCount(detail.id, visibility) };
  };

  const sendDetail = async (
    request: FastifyRequest,
    reply: FastifyReply,
    id: number,
    include: Set<IncludeToken>,
    status = 200,
  ): Promise<void> => {
    const object = await service.get(id);
    const body: Record<string, unknown> = { ...object };
    const visibility = await visibilityOf(request);

    // **A count of the children the reader can see** (`A-12`). Asked separately, and only when
    // something is hidden, so the common case pays nothing for it.
    const childCount = visibility.everything
      ? undefined
      : await service.visibleChildCount(id, visibility);
    if (childCount !== undefined) body['childCount'] = childCount;
    if (include.has('settings')) body['settings'] = await service.settings(id);
    let retired: string | undefined;
    if (include.has('channels') && object.kind === 'sensor') {
      const channels = await service.channels(id);
      body['channels'] = channels;
      retired = retiredOf(channels);
    }
    if (include.has('credentials')) body['credentials'] = await service.credentials(id, true);
    if (include.has('ancestors')) body['ancestors'] = await service.ancestors(id, visibility);

    await reply
      .status(status)
      .header('ETag', await detailTag(request, object, include, visibility, childCount, retired))
      .header('cache-control', PRIVATE)
      .send(body);
  };

  /** Undefined rather than null, so `etagFor` falls back to the plain version tag. */
  const validatorFor = async (id: number, visibility?: Visibility): Promise<string | undefined> =>
    (await service.chainValidator(id, validatorSalt, visibility)) ?? undefined;

  /**
   * The validator for this caller's answer about an object: the render and the 304 build it here,
   * so that they cannot disagree.
   *
   * A response carrying inherited content needs a validator that covers what it inherited, or the
   * next conditional request gets a 304 built from this object's version alone (`S-13`).
   *
   * **A restricted caller's answer also holds what their grants decide** (`A-32`): the count of
   * the children they can see and, with `?include=ancestors`, a path trimmed to what they can
   * read. Neither moves the object's version or its chain, so a grant or a hole that changed them
   * was answered "not modified". The access epoch moves with every grant, membership and move.
   * The principal keeps one account's tag from matching a copy cached for another. The count
   * changes with neither: a sensor created under a device moves no epoch.
   *
   * **The chain is the part of it the answer can show** (`A-49`). A restricted caller's covers the
   * ancestors their view keeps, so an edit to one they cannot see is not told them by a changed
   * tag on an unchanged body — unless the answer carries inherited settings or credentials, which
   * hidden ancestors hand down by design.
   *
   * **Every caller's tag covers the count of children** (`A-49`), a caller who sees everything
   * too: no trigger touches a parent when a child is created, deleted or moved, so a tag without
   * it answered 304 with the old count. Folded into the chain part, which makes an all-seeing
   * caller's tag `W/"<version>-<hex>"` where it was `W/"<version>"`; `If-Match` reads either.
   */
  const detailTag = async (
    request: FastifyRequest,
    object: { id: number; version: number; childCount: number },
    include: ReadonlySet<IncludeToken>,
    visibility: Visibility,
    childCount: number | undefined,
    /**
     * `retiredOf` the channels the answer carries, when it carries them (`P-322` review).
     * `retired` is derived from `sample` on every read, and a reading moves it without moving
     * the object's version or chain, so without this a client revalidating `?include=channels`
     * kept a 304 on a channel a reading had made live again, and retention dropping the reading
     * that kept one live left it shown live. Folded into the chain as a view is (`A-32`), so the
     * tag stays one `If-Match` reads.
     */
    retired?: string,
  ): Promise<string> => {
    const inheritsHidden = include.has('settings') || include.has('credentials');
    const chain =
      include.size === 0
        ? undefined
        : await validatorFor(object.id, inheritsHidden ? undefined : visibility);
    const derived = retired === undefined ? '' : `|retired:${retired}`;
    if (visibility.everything) {
      return etagFor(object.version, viewedChain(chain, `#${String(object.childCount)}${derived}`));
    }
    const view =
      `${sightOf(request).key}@${String(visibility.epoch)}#${String(childCount)}` + derived;
    return etagFor(object.version, viewedChain(chain, view));
  };

  // ── 1. list ──────────────────────────────────────────────────────────────────────────────
  app.get<{ Querystring: ListQuery }>(
    '/objects',
    {
      // Everything the caller can see, filtered inside the query (`A-12`); `parentId` scopes it
      // to one object's children, and naming one the caller cannot read is refused rather than
      // answered with the visible part of it.
      config: onQueryObject('read', 'parentId', { optional: true }),
      schema: {
        tags: ['objects'],
        querystring: listQuery,
        description:
          'Flat filtered listing, keyset-paginated. `q` searches names and device hosts as a ' +
          'case-insensitive substring; `host` is an exact match on a device host. ' +
          '`include=path` gives each item its ancestors, so a flat search result can say where ' +
          'each match is. Note: under sort=name an object renamed ' +
          'mid-pagination can be returned twice or missed — inherent to keyset paging and ' +
          'acceptable for a UI. Anything that must be exact (bulk selection, config export) ' +
          'must use sort=id, which is immutable.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'nextCursor'],
            properties: {
              items: { type: 'array', items: { $ref: 'ms:objectSummary' } },
              nextCursor: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const query = request.query;
      const sort: ListSort =
        query.sort === 'id' ? 'id' : query.sort === 'manual' ? 'manual' : 'name';
      // A manual arrangement is a fact about one parent's children. Ordering a filtered slice of
      // the whole tree by it would interleave positions from unrelated groups into something
      // deterministic and meaningless, so it is refused rather than served.
      if (sort === 'manual' && query.parentId === undefined) {
        throw new ObjectError(
          'OBJECT_INVALID',
          'sort=manual needs a parentId to be manual within',
          {
            context: { phase: 'validate-query' },
          },
        );
      }
      const limit = query.limit ?? 100;
      const effective = distinct(query.effective);
      assertKnownSettingKeys(effective);
      const include = parseTokens(query.include, LIST_INCLUDE_TOKENS);
      const kinds = distinct(query.kind) as ObjectKind[];
      const failing =
        query.invalidParams === 'true' ? failingSensors(options.invalidParams) : undefined;

      const page = await service.list(
        {
          ...(query.parentId === undefined ? {} : { parentId: query.parentId }),
          ...(kinds.length === 0 ? {} : { kinds }),
          ...(asArray(query.tag).length === 0 ? {} : { tags: asArray(query.tag) }),
          ...(query.q === undefined ? {} : { q: query.q }),
          ...(query.host === undefined ? {} : { host: query.host }),
          ...(query.priorityMin === undefined
            ? {}
            : { priorityMin: query.priorityMin as 1 | 2 | 3 | 4 | 5 }),
          // The ids, as a filter inside the listing's own query: the caller's visibility, the
          // limit and the cursor apply to them as to any other (`P-375`).
          ...(failing === undefined ? {} : { ids: failing }),
        },
        {
          limit,
          sort,
          cursor: query.cursor === undefined ? null : decodeCursor(query.cursor, sort),
        },
        await visibilityOf(request),
        { effective, path: include.has('path') },
      );

      await reply.send(page);
    },
  );

  // ── 3. root ──────────────────────────────────────────────────────────────────────────────
  app.get<{ Querystring: { include?: string } }>(
    '/objects/root',
    {
      // **The root is an object like any other** (`A-12`). A route that served it to anybody with
      // a login handed a branch account the installation's name, its settings and a count of
      // every probe — the containers above a granted branch are outside it. Such an account's
      // tree starts at `/objects/tops`.
      config: INSTALLATION,
      schema: {
        tags: ['objects'],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { include: { type: 'string', maxLength: 200 } },
        },
        response: { 200: { $ref: 'ms:objectDetail' } },
      },
    },
    async (request, reply) => {
      const root = await service.getRoot();
      await sendDetail(request, reply, root.id, parseInclude(request.query.include));
    },
  );

  // ── 3b. tops ─────────────────────────────────────────────────────────────────────────────
  app.get(
    '/objects/tops',
    {
      config: READS,
      schema: {
        tags: ['objects'],
        summary: 'Where the caller’s tree starts',
        description:
          'The objects the caller can read whose parent it cannot. For an account that can ' +
          'read the root, that is the root. For one granted a few branches, it is the top of ' +
          'each: the containers above a granted branch are outside it, so their names are ' +
          'never shown and the tree starts at the branches instead — and a grant re-opened ' +
          'inside a hole the caller cannot see is a top of its own, because no expansion ' +
          'reaches it. Ordered by name.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: { $ref: 'ms:objectSummary' } } },
          },
        },
      },
    },
    async (request, reply) => {
      await reply.send({ items: await service.tops(await visibilityOf(request)) });
    },
  );

  // ── 16. setting definitions ──────────────────────────────────────────────────────────────
  app.get(
    '/setting-definitions',
    {
      config: READS,
      schema: {
        tags: ['settings'],
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['key', 'schema', 'default', 'description'],
                  properties: {
                    key: { type: 'string' },
                    schema: { type: 'object', additionalProperties: true },
                    default: {},
                    description: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      await reply.send({
        items: settingRegistry.definitions().map((d) => ({
          key: d.key,
          schema: d.schema,
          default: d.default,
          description: d.description,
        })),
      });
    },
  );

  // ── 2. create ────────────────────────────────────────────────────────────────────────────
  app.post<{ Body: CreateObjectInput }>(
    '/objects',
    {
      config: onBodyObject('write', 'parentId'),
      schema: {
        tags: ['objects'],
        body: { $ref: 'ms:createObject' },
        response: { 201: { $ref: 'ms:objectDetail' } },
      },
    },
    async (request, reply) => {
      const created = await service.create(await writerFor(request), request.body);
      await reply
        .status(201)
        .header('Location', `/api/v1/objects/${String(created.id)}`)
        .header('ETag', etagFor(created.version))
        .send(created);
    },
  );

  // ── 3. create a subtree (`P-19`) ─────────────────────────────────────────────────────────
  app.post<{ Body: TreePlanInput }>(
    '/objects/tree',
    {
      // The same bar `POST /objects` carries, for the same reason and on the same field: this
      // route creates the identical objects under the identical `parentId`, only more of them
      // (`G05`).
      config: onBodyObject('write', 'parentId'),
      schema: {
        tags: ['objects'],
        summary: 'Create a whole subtree in one request',
        description:
          'Creates many objects at once, under one `parentId`, with nodes naming their parent ' +
          'by `ref` where that parent is also being created here. **One transaction**: the ' +
          'whole subtree appears or none of it does, which is what a discovery run needs — a ' +
          'half-provisioned device is worse than a failed one, because nothing says which ' +
          'half.\n\n' +
          'Every object goes through the same validation, the same hierarchy rules, the same ' +
          'channel declaration and the same audit log as `POST /objects`; what is not paid is a ' +
          'request, a transaction and a tree lock **per object**. Refusals name the node by its ' +
          'index and its `ref`, because a caller sending five thousand cannot act on ' +
          '"invalid request".\n\n' +
          'The answer is ids in the order the nodes were sent, not full objects: five thousand ' +
          'of those is megabytes of response describing what the caller already wrote, and the ' +
          'one thing they could not know is the ids.',
        body: { $ref: 'ms:createTree' },
        response: { 201: { $ref: 'ms:createTreeResult' } },
      },
    },
    async (request, reply) => {
      const result = await service.createTree(await writerFor(request), request.body);
      await reply.status(201).send(result);
    },
  );

  // ── 4. read ──────────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: number }; Querystring: { include?: string } }>(
    '/objects/:id',
    {
      config: onObject('read'),
      schema: {
        tags: ['objects'],
        description:
          'One object. Send the `ETag` back as `If-None-Match` for a 304 when nothing in the ' +
          'answer has changed: the tag covers what it inherits with `?include=`, and, for an ' +
          'account that does not see everything, what its grants decide, so a grant that ' +
          'changes the answer changes the tag. The answer is `Cache-Control: private`.',
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { include: { type: 'string', maxLength: 200 } },
        },
        response: { 200: { $ref: 'ms:objectDetail' } },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const include = parseInclude(request.query.include);
      const ifNoneMatch = request.headers['if-none-match'];

      // Answered before the read, which is the point: the validator is one recursive walk of
      // (id, version) up the ancestor chain, against a full render that resolves every
      // inherited setting and credential for every level of it.
      //
      // `?include=settings` and `?include=credentials` show values inherited from ancestors, and
      // an ancestor's change does not bump *this* object's version — so a tag built from the
      // version alone would let a 304 hide a revoked credential or a changed scan interval from
      // a client doing exactly what the protocol tells it to. The chain digest is what closes
      // that (S-13), and it covers a re-parenting as well as an edit.
      if (ifNoneMatch !== undefined) {
        const object = await service.get(id);
        const visibility = await visibilityOf(request);
        const childCount = visibility.everything
          ? undefined
          : await service.visibleChildCount(id, visibility);
        // `retired` is read, not versioned (`P-322`), so it is asked here too: one query of the
        // sensor's channels, still short of the full render.
        const retired =
          include.has('channels') && object.kind === 'sensor'
            ? retiredOf(await service.channels(id))
            : undefined;
        const current = await detailTag(request, object, include, visibility, childCount, retired);
        if (ifNoneMatch === current) {
          await reply.status(304).header('ETag', current).header('cache-control', PRIVATE).send();
          return;
        }
      }

      await sendDetail(request, reply, id, include);
    },
  );

  // ── 5. update ────────────────────────────────────────────────────────────────────────────
  app.patch<{ Params: { id: number }; Body: UpdateObjectInput }>(
    '/objects/:id',
    {
      config: onObject('write'),
      schema: {
        tags: ['objects'],
        description:
          'Changes what it is given and keeps the rest. **Where a sensor sends its inherited ' +
          "credentials** — a device's host or address family, or a sensor parameter its type " +
          'says chooses the listener — **needs `write` on the object those credentials are ' +
          'stored on** (`A-41`), and is otherwise refused with 403 naming the kind and that ' +
          "object, never the secret. A device's new host also clears the secrets held in its " +
          "sensors' own parameters, which the audit lists; enter them again.",
        params: idParams,
        body: { $ref: 'ms:updateObject' },
        response: { 200: { $ref: 'ms:objectDetail' } },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const pre = requireIfMatch(request.headers['if-match']);
      const updated = await service.update(await writerFor(request), id, request.body, pre);
      await reply.header('ETag', etagFor(updated.version)).send(await answerFor(request, updated));
    },
  );

  // ── 6. delete ────────────────────────────────────────────────────────────────────────────
  app.delete<{ Params: { id: number }; Querystring: { expectedDescendants?: number } }>(
    '/objects/:id',
    {
      // **Everything beneath it, not just the object** (`A-35`). A delete destroys the subtree,
      // and there is no recycle bin: `write` on a device whose sensor is carved `none` must not
      // be a way to destroy the sensor — nor its refusal a way to count what the hole holds.
      config: onSubtree('write'),
      schema: {
        tags: ['objects'],
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { expectedDescendants: { type: 'integer', minimum: 0 } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'kind', 'name', 'deleted'],
            properties: {
              id: { type: 'integer' },
              // Never `root`, which cannot be deleted (`P-351`).
              kind: { type: 'string', enum: [...WRITABLE_KINDS] },
              name: { type: 'string' },
              deleted: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const expected = request.query.expectedDescendants;
      const expectation: DeleteExpectation =
        expected === undefined ? { kind: 'leafOnly' } : { kind: 'exact', descendants: expected };

      const report = await service.delete(
        actorFor(request),
        id,
        expectation,
        optionalIfMatch(request.headers['if-match']),
      );

      // Always 200 with a receipt, never 204: uniform for clients, and the operator gets to
      // see what was destroyed.
      await reply.send({
        id: report.id,
        kind: report.kind,
        name: report.name,
        deleted: report.deleted,
      });
    },
  );

  // ── 6b. reorder among siblings ────────────────────────────────────────────────────────────
  app.post<{ Params: { id: number }; Body: { move: SiblingMove } }>(
    '/objects/:id/order',
    {
      config: onObject('write'),
      schema: {
        tags: ['objects'],
        description:
          "Moves an object within its parent's children, the way PRTG's move up / move down " +
          'does. Siblings nobody has arranged keep sorting by name, so a tree that has never ' +
          'been ordered by hand reads exactly as it did before. Listings honour the ' +
          'arrangement through `GET /objects?parentId=…&sort=manual` and through the tree ' +
          'endpoint, which always does. A move that changes nothing is a no-op, not an error. ' +
          '**Among the siblings the caller can see** (`A-46`): every other sibling keeps its ' +
          'place, "up" passes the nearest one the caller can see, and the top it can see is ' +
          'the top.',
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['move'],
          properties: { move: { enum: ['up', 'down', 'first', 'last'] } },
        },
        response: { 200: { $ref: 'ms:objectDetail' } },
      },
    },
    async (request, reply) => {
      const reordered = await service.reorder(
        actorFor(request),
        request.params.id,
        request.body.move,
        optionalIfMatch(request.headers['if-match']),
        await visibilityOf(request),
      );
      await reply
        .header('ETag', etagFor(reordered.version))
        .send(await answerFor(request, reordered));
    },
  );

  // ── 7. move ──────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: number }; Body: { targetParentId: number } }>(
    '/objects/:id/move',
    {
      // **Both ends** (`G06`). Taking the object needs `write` on it; putting it somewhere needs
      // `write` there. Checking only the source lets an operator relocate a device into a branch
      // they were denied — and out of the branch whose owners could see it. And taking it means
      // taking everything beneath it (`A-35`): a move carries a hole with it and changes what it
      // inherits, which is a change to objects the caller may not change.
      config: every(onSubtree('write'), onBodyObject('write', 'targetParentId')),
      schema: {
        tags: ['objects'],
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['targetParentId'],
          properties: { targetParentId: { type: 'integer', minimum: 1 } },
        },
        response: { 200: { $ref: 'ms:moveResult' } },
      },
    },
    async (request, reply) => {
      const result = await service.move(
        await writerFor(request),
        request.params.id,
        request.body.targetParentId,
        optionalIfMatch(request.headers['if-match']),
        // Whether a device's exception to the target policy may cross to another probe, cleared
        // (`A-64`): the grant routes' bar, as a clone's grants are.
        grantsCarriedBy(request),
      );
      await reply
        .header('ETag', etagFor(result.object.version))
        .send(await service.moveSeenBy(result, await visibilityOf(request)));
    },
  );

  // ── 8. clone ─────────────────────────────────────────────────────────────────────────────
  app.post<{
    Params: { id: number };
    // A clone with no options is a legitimate request, so the body may be absent entirely.
    Body: { targetParentId?: number; name?: string } | undefined;
  }>(
    '/objects/:id/clone',
    {
      // Both ends (`G06`). With no `targetParentId` the copy lands beside its source, in the
      // source's parent, and that is a second object: `write` on the source says nothing about
      // it when the source is itself where a grant was made, so it is asked for as `POST
      // /objects` asks for `write` on the parent (`A-35`). What beneath the source is copied is
      // the service's to decide, from the caller's visibility.
      config: every(
        onObject('write'),
        onBodyObject('write', 'targetParentId', { optional: true }),
        onDerivedObject(
          'write',
          'a clone made in place',
          async (request) => {
            const body = request.body as { targetParentId?: unknown } | null | undefined;
            if (body?.targetParentId !== undefined && body.targetParentId !== null) {
              return { kind: 'unasked' };
            }
            // An integer by now: `onObject` above refuses a path id that is not one. The root
            // has no parent, and cloning it is the service's to refuse.
            const parent = await service.parentOf(Number((request.params as { id: unknown }).id));
            return parent === null ? { kind: 'unasked' } : { kind: 'object', id: parent };
          },
          // The source is one the caller may write, so it is not absent. Its parent is one they
          // may not see, so the refusal does not name it.
          (request) =>
            new AuthError(
              'AUTH_FORBIDDEN',
              'a clone made in place goes beside its source, and this account may not write there',
              {
                objectId: Number((request.params as { id: unknown }).id),
                needed: 'write',
                via: 'a clone made in place',
              },
            ),
        ),
      ),
      schema: {
        tags: ['objects'],
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            targetParentId: { type: 'integer', minimum: 1 },
            name: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
        response: { 201: { $ref: 'ms:cloneResult' } },
      },
    },
    async (request, reply) => {
      const result = await service.clone(
        await writerFor(request),
        request.params.id,
        request.body ?? {},
        await visibilityOf(request),
        grantsCarriedBy(request),
      );
      await reply
        .status(201)
        .header('Location', `/api/v1/objects/${String(result.object.id)}`)
        .header('ETag', etagFor(result.object.version))
        .send(result);
    },
  );

  // ── 8b. bulk operations (`D-09`) ─────────────────────────────────────────────────────────
  app.post<{
    Body: {
      ids: number[];
      operation: string;
      targetParentId?: number;
      cascade?: boolean;
      key?: string;
      value?: unknown;
      minutes?: number;
      until?: string;
      from?: string;
      message?: string;
    };
  }>(
    '/objects/bulk',
    {
      // The ids are partitioned per object in the handler; the destination of a `move` or a
      // `clone` is one object for the whole request, so it is a bar like any other (`G06`).
      config: every(WRITES, onBodyObject('write', 'targetParentId', { optional: true })),
      schema: {
        tags: ['objects'],
        description:
          'Applies one operation to a selection. **Each object is atomic and the batch is ' +
          'best-effort**: the report names every object that did not change and why, rather ' +
          'than failing the request. An operator who selects forty sensors and pauses them, one ' +
          'of which a colleague deleted a moment ago, wants thirty-nine paused and a line ' +
          'naming the fortieth — all-or-nothing would give them neither.\n\n' +
          'The selection is explicit ids, never a filter. A client enumerating a selection with ' +
          '`GET /objects` **must** page with `sort=id`: under `sort=name` a keyset scan can ' +
          'return a renamed object twice or skip it, so a bulk delete would miss objects the ' +
          'operator chose.\n\n' +
          `At most ${String(MAX_BULK)} objects, because each one takes the tree lock in turn ` +
          'and a larger selection is a filter rather than a selection. Repeated ids are ' +
          'collapsed and counted, never applied twice.',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['ids', 'operation'],
          properties: {
            ids: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_BULK,
              items: { type: 'integer', minimum: 1 },
            },
            operation: {
              type: 'string',
              enum: ['pause', 'resume', 'move', 'clone', 'delete', 'setting', 'revertSetting'],
            },
            targetParentId: {
              type: 'integer',
              minimum: 1,
              description: 'Required by `move` and `clone`.',
            },
            cascade: {
              type: 'boolean',
              default: false,
              description:
                '`delete` only. False refuses an object that has children, which is the safe ' +
                'default: a selection of six groups is six subtrees and nobody counted them.',
            },
            key: { type: 'string', description: 'Required by `setting` and `revertSetting`.' },
            value: {
              description:
                '`setting` only. To go back to the inherited value use `revertSetting` — the ' +
                'same split the single-object routes make between `PUT` and `DELETE`, and not ' +
                'a null here, which is a legitimate stored value for a setting whose schema ' +
                'allows one.',
            },
            minutes: { type: 'integer', minimum: 1, description: '`pause` only.' },
            until: { type: 'string', format: 'date-time', description: '`pause` only.' },
            from: { type: 'string', format: 'date-time', description: '`pause` only.' },
            message: { type: 'string', maxLength: 500, description: '`pause` only.' },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['requested', 'succeeded', 'failed', 'duplicates', 'outcomes'],
            properties: {
              requested: { type: 'integer' },
              succeeded: { type: 'integer' },
              failed: { type: 'integer' },
              duplicates: { type: 'integer' },
              outcomes: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['objectId', 'ok'],
                  properties: {
                    objectId: { type: 'integer' },
                    ok: { type: 'boolean' },
                    problem: { type: 'string' },
                    code: { type: 'string' },
                    createdId: { type: 'integer' },
                    grantsNotCarried: {
                      type: 'integer',
                      description:
                        '`clone` only: the positive grants the copy did not carry, as the ' +
                        'single clone’s answer counts them (`A-76`).',
                    },
                    deleted: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      // **Duplicates are collapsed before the partition, not after it** (`G07`). `BulkService`
      // collapses the ids it is handed, so collapsing only on the allowed side made the report
      // depend on the caller's rights: the same selection answered `duplicates: 1` with one
      // outcome row for an object the account may write, and `duplicates: 0` with two identical
      // failure rows for one it may not. The route's own description promises neither.
      const sent = request.body.ids;
      const unique = [...new Set(sent)];
      const operation = request.body.operation;
      const { allowed, refused } = await partitionByRight(
        access,
        authorizing,
        request,
        unique,
        operation === 'delete' || operation === 'move',
      );
      const applied =
        allowed.length === 0
          ? { succeeded: 0, failed: 0, outcomes: [] }
          : await bulk.apply(
              await writerFor(request),
              allowed,
              operationFrom(request.body, grantsCarriedBy(request)),
              await visibilityOf(request),
            );
      await reply.send({
        ...applied,
        // `requested` is the selection after collapsing, which is what `BulkReport` documents
        // and what the outcome rows count.
        requested: unique.length,
        duplicates: sent.length - unique.length,
        failed: applied.failed + refused.length,
        outcomes: [...applied.outcomes, ...refused],
      });
    },
  );

  // ── 9. subtree ───────────────────────────────────────────────────────────────────────────
  app.get<{
    Params: { id: number };
    Querystring: {
      maxDepth?: number;
      limit?: number;
      kind?: string | string[];
      effective?: string | string[];
    };
  }>(
    '/objects/:id/tree',
    {
      config: onObject('read'),
      schema: {
        tags: ['objects'],
        params: idParams,
        querystring: treeQuery,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'truncated'],
            properties: {
              items: { type: 'array', items: { $ref: 'ms:objectSummary' } },
              truncated: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const effective = distinct(request.query.effective);
      assertKnownSettingKeys(effective);
      const kinds = distinct(request.query.kind) as ObjectKind[];
      const result = await service.subtree(
        request.params.id,
        {
          maxDepth: request.query.maxDepth ?? 3,
          limit: request.query.limit ?? 1000,
          ...(kinds.length === 0 ? {} : { kinds }),
        },
        await visibilityOf(request),
        effective,
      );
      await reply.send(result);
    },
  );

  // ── 9b. subtree counts ───────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: number } }>(
    '/objects/:id/counts',
    {
      config: onObject('read'),
      schema: {
        tags: ['objects'],
        params: idParams,
        summary: 'Exact totals for a subtree',
        description:
          'How many objects of each kind are under this one, and what state its sensors are ' +
          'in. Unlike `/tree` there is no depth and no limit: the counting happens in the ' +
          'database and only the totals cross the wire.\n\n' +
          'Use this wherever a page shows a **number** rather than rows. Counting a page of ' +
          '`/tree` gives the right answer for a small installation and a quietly wrong one for ' +
          'a large installation, which is the worst way for a number to be wrong.',
        response: { 200: countsResponse },
      },
    },
    async (request, reply) => {
      await reply.send(await service.counts(request.params.id, await visibilityOf(request)));
    },
  );

  app.get(
    '/objects/counts',
    {
      config: READS,
      schema: {
        tags: ['objects'],
        summary: 'Exact totals for everything the caller can see',
        description:
          'The same totals as `/objects/:id/counts`, over every object the caller can read ' +
          'rather than under one. For an account that can read the root it is the root’s ' +
          'counts; for one granted a few branches it is theirs, with nothing outside them ' +
          'counted — which the root’s own counts, refused to that account, could not give.',
        response: { 200: countsResponse },
      },
    },
    async (request, reply) => {
      await reply.send(await service.visibleCounts(await visibilityOf(request)));
    },
  );

  // ── 10. ancestors ────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: number } }>(
    '/objects/:id/ancestors',
    {
      config: onObject('read'),
      schema: {
        tags: ['objects'],
        params: idParams,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: { $ref: 'ms:objectRef' } } },
          },
        },
      },
    },
    async (request, reply) => {
      await reply.send({
        items: await service.ancestors(request.params.id, await visibilityOf(request)),
      });
    },
  );

  // ── 11. channels ─────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: number } }>(
    '/objects/:id/channels',
    {
      config: onObject('read'),
      schema: {
        tags: ['channels'],
        params: idParams,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: { $ref: 'ms:channelRecord' } } },
          },
        },
      },
    },
    async (request, reply) => {
      await reply.send({ items: await service.channels(request.params.id) });
    },
  );

  /**
   * How a channel is judged: its limits (`M-04`), its lookup (`M-06`), or both.
   *
   * `PATCH` on the channel rather than a resource per field, because `M-07` adds scaling
   * factors, decimals and the spike filter to the same row and they should not each grow an
   * endpoint. `additionalProperties: false` says plainly which fields exist today rather than
   * ignoring the rest.
   */
  app.patch<{
    Params: { id: number; key: string };
    Body: {
      limits?: ChannelLimitsPatch;
      lookupId?: string | null;
      processing?: Partial<ChannelProcessing>;
    };
  }>(
    '/objects/:id/channels/:key',
    {
      config: onObject('write'),
      schema: {
        tags: ['channels'],
        description:
          'Sets a channel’s error and warning limits, the lookup that decides its state, or ' +
          'both. `limits` is a patch: `null` clears one threshold, an absent field leaves it ' +
          'alone. Both are immediate — a reading past an error limit, or one a lookup maps to ' +
          'an error, sets the sensor Down on the very first sample with no two-step rule. A ' +
          'channel with a lookup is judged by it *instead of* its limits. Limits that ' +
          'contradict each other are refused with the reason; a `lookupId` this installation ' +
          'has not loaded is accepted and reported, because a sensor type may ship ahead of ' +
          'its lookup file. `processing` sets the scaling factors, the spike filter and the ' +
          'decimal places — scaling is applied before anything judges the reading, and before ' +
          'the spike filter, so both bounds and limits are numbers in the channel’s own unit. ' +
          'Changing a factor does not rewrite readings already stored, so the graph steps at ' +
          'the moment of the change.',
        params: {
          type: 'object',
          required: ['id', 'key'],
          additionalProperties: false,
          properties: {
            id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            key: { type: 'string', minLength: 1, maxLength: 100 },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            limits: channelLimitsPatchSchema,
            lookupId: { type: ['string', 'null'], minLength: 1, maxLength: 100 },
            processing: channelProcessingPatchSchema,
          },
        },
        response: { 200: { $ref: 'ms:channelRecord' } },
      },
    },
    async (request, reply) => {
      const updated = await service.patchChannel(
        actorFor(request),
        request.params.id,
        request.params.key,
        request.body,
        optionalIfMatch(request.headers['if-match']),
      );
      await reply.send(updated);
    },
  );

  // ── 11b. pause (M-08) ────────────────────────────────────────────────────────────────────

  app.post<{
    Params: { id: number };
    Body: { minutes?: number; until?: string; from?: string; message?: string };
  }>(
    '/objects/:id/pause',
    {
      config: onObject('write'),
      schema: {
        tags: ['state'],
        description:
          'Pauses an object and every sensor beneath it. Give `minutes` for a duration, `until` ' +
          'for a moment, or neither to pause indefinitely — until a person says otherwise. ' +
          `A UI offers ${PAUSE_PRESETS.join(', ')} minutes as presets, but any duration is ` +
          'accepted. Takes effect immediately: the sensors change state in this request, and ' +
          'their probe stops being told to scan them. Pausing an already-paused object replaces ' +
          'the reason and the deadline rather than stacking, which is what extending a ' +
          'maintenance window means. ' +
          'Give `from` with `until` for a **maintenance window** — the same pause, scheduled ' +
          'rather than immediate. Nothing is paused until it starts; the object reads `pending` ' +
          'until then and can be cancelled at any point by resuming it.',
        params: idParams,
        body: pauseRequestSchema,
        response: { 200: { $ref: 'ms:pauseView' } },
      },
    },
    async (request, reply) => {
      const { minutes, until, from, message } = request.body;
      const pause =
        from !== undefined && until !== undefined
          ? ({ kind: 'window', from: new Date(from), until: new Date(until) } as const)
          : minutes !== undefined
            ? ({ kind: 'duration', minutes } as const)
            : until !== undefined
              ? ({ kind: 'until', until: new Date(until) } as const)
              : ({ kind: 'indefinite' } as const);

      const view = await service.pause(
        actorFor(request),
        request.params.id,
        pause,
        message ?? '',
        optionalIfMatch(request.headers['if-match']),
      );
      await reply.send(await service.pauseSeenBy(view, await visibilityOf(request)));
    },
  );

  app.delete<{ Params: { id: number } }>(
    '/objects/:id/pause',
    {
      config: onObject('write'),
      schema: {
        tags: ['state'],
        description:
          'Resumes an object, or cancels a maintenance window it has not reached yet. Only the ' +
          'object that was directly paused can be resumed — a sensor paused because its device ' +
          'is paused has nothing of its own to clear, and the 409 names the object to resume ' +
          'instead. **By id alone when the caller cannot see it** (`A-16`): a pause inherited ' +
          'from a container above the caller’s branch, or a master in another branch, is ' +
          'named in the 409 as `GET` names it, with `pausedByName` or `masterName` null. A ' +
          'resumed sensor reads Unknown until its next scan, never the state it had before the ' +
          'pause, which the system has not checked since.',
        params: idParams,
        response: { 200: { $ref: 'ms:pauseView' } },
      },
    },
    async (request, reply) => {
      const visibility = await visibilityOf(request);
      const view = await service.resume(
        actorFor(request),
        request.params.id,
        visibility,
        optionalIfMatch(request.headers['if-match']),
      );
      await reply.send(await service.pauseSeenBy(view, visibility));
    },
  );

  app.get<{ Params: { id: number } }>(
    '/objects/:id/pause',
    {
      config: onObject('read'),
      schema: {
        tags: ['state'],
        description:
          'Whether this object is paused, why, until when, and whether this is the one that can ' +
          'be resumed.',
        params: idParams,
        response: { 200: { $ref: 'ms:pauseView' } },
      },
    },
    async (request, reply) => {
      // Never cached: a timed pause expires on its own, with no write for a validator to move.
      void reply.header('cache-control', 'no-store');
      await reply.send(
        await service.pauseSeenBy(
          await service.pauseState(request.params.id),
          await visibilityOf(request),
        ),
      );
    },
  );

  // ── 11d. acknowledgement (M-13) ──────────────────────────────────────────────────────────

  app.post<{
    Params: { id: number };
    Body: { minutes?: number; until?: string; message?: string };
  }>(
    '/objects/:id/acknowledge',
    {
      config: toAcknowledge(),
      schema: {
        tags: ['state'],
        description:
          'Acknowledges a Down alarm: the sensor reads Down (Acknowledged), notifications stop, ' +
          'and monitoring carries on exactly as before. Give `minutes` for a duration, `until` ' +
          'for a moment, or neither to acknowledge indefinitely. ' +
          `A UI offers ${ACK_PRESETS.join(', ')} minutes as presets. ` +
          'On a device or a group this acknowledges every sensor beneath it that is Down **at ' +
          'this moment** — a snapshot, not a rule, so a sensor that fails later is a new alarm — ' +
          'and that the caller could acknowledge by naming it; the rest are listed in `skipped`. ' +
          'The message becomes the sensor’s last message. It clears on recovery, on expiry, on ' +
          'pause-then-resume, or by DELETE.',
        params: idParams,
        body: acknowledgeRequestSchema,
        response: { 200: { $ref: 'ms:acknowledgementView' } },
      },
    },
    async (request, reply) => {
      const { minutes, until, message } = request.body;
      const acknowledgement =
        minutes !== undefined
          ? ({ kind: 'duration', minutes } as const)
          : until !== undefined
            ? ({ kind: 'until', until: new Date(until) } as const)
            : ({ kind: 'indefinite' } as const);

      await reply.send(
        await service.acknowledge(
          actorFor(request),
          request.params.id,
          acknowledgement,
          await visibilityOf(request),
          reachOf(request, 'acknowledge'),
          message,
        ),
      );
    },
  );

  app.delete<{ Params: { id: number } }>(
    '/objects/:id/acknowledge',
    {
      config: toAcknowledge(),
      schema: {
        tags: ['state'],
        description:
          'Withdraws an acknowledgement, so the alarm reads Down again and notifications ' +
          'resume. The three things that clear one on their own — recovery, expiry and ' +
          'pause-then-resume — are all events; this is the one for "I acknowledged the wrong ' +
          'sensor".',
        params: idParams,
        response: { 200: { $ref: 'ms:acknowledgementView' } },
      },
    },
    async (request, reply) => {
      await reply.send(
        await service.clearAcknowledgement(
          actorFor(request),
          request.params.id,
          await visibilityOf(request),
          reachOf(request, 'acknowledge'),
        ),
      );
    },
  );

  // ── 11e. simulated error (M-14) ──────────────────────────────────────────────────────────

  app.post<{ Params: { id: number }; Body: { message?: string } }>(
    '/objects/:id/simulate-error',
    {
      config: onObject('write'),
      schema: {
        tags: ['state'],
        description:
          'Forces sensors Down so a notification chain can be tested end to end. ' +
          '**This fires the real chain at real people** — which is the point, since a chain ' +
          'nobody has seen fire is a chain nobody knows works. The sensor reads Down with cause ' +
          '`simulated`, never `scan`, so a forced outage cannot be mistaken for a real one; the ' +
          'message becomes its last message; the action is audited. On a device or a group this ' +
          'forces **every** sensor beneath it, whatever state it was in, that the caller may ' +
          'write; the rest are listed in `skipped`. Pausing still wins, so ' +
          'a sensor somebody switched off will not start paging anyone.',
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { message: { type: 'string', maxLength: 500 } },
        },
        response: { 200: { $ref: 'ms:simulatedErrorView' } },
      },
    },
    async (request, reply) => {
      await reply.send(
        await service.simulateError(
          actorFor(request),
          request.params.id,
          true,
          await visibilityOf(request),
          reachOf(request, 'write'),
          request.body.message,
        ),
      );
    },
  );

  app.delete<{ Params: { id: number } }>(
    '/objects/:id/simulate-error',
    {
      config: onObject('write'),
      schema: {
        tags: ['state'],
        description:
          'Lifts a simulated error. The sensors return to what they actually measure straight ' +
          'away — unlike a resume, which yields Unknown, because a forced sensor never stopped ' +
          'being scanned: the force changes what its readings *mean*, not whether it takes any.',
        params: idParams,
        response: { 200: { $ref: 'ms:simulatedErrorView' } },
      },
    },
    async (request, reply) => {
      await reply.send(
        await service.simulateError(
          actorFor(request),
          request.params.id,
          false,
          await visibilityOf(request),
          reachOf(request, 'write'),
        ),
      );
    },
  );

  // ── 11c. dependency (M-11) ───────────────────────────────────────────────────────────────

  app.put<{
    Params: { id: number };
    Body: {
      mode: 'parent' | 'object' | 'device' | 'none';
      masterId?: number;
      delaySeconds?: number;
    };
  }>(
    '/objects/:id/dependency',
    {
      // **And read on the master** (`A-12`). A dependency on a sensor the caller cannot see would
      // tell them, by pausing theirs, every time it went Down — a hidden object's state, read
      // through a visible one's. Held by the service, on the writer's sight, because the settings
      // route and a bulk `setting` can name a master too, and one check holds all three (`A-77`).
      config: onObject('write'),
      schema: {
        tags: ['dependencies'],
        description:
          'Sets what this object depends on. `parent` inherits from above, `object` names a ' +
          'master sensor, `none` depends on nothing, and `device` makes **this sensor** the ' +
          'master for its parent device — which is what auto-discovery sets on a Ping sensor, ' +
          'and what pauses the rest of a device when it stops answering. ' +
          'A master pauses its dependents only when it is genuinely Down or Down (Acknowledged); ' +
          'pausing a master by hand or by schedule does not. `delaySeconds` keeps dependents ' +
          'paused after the master recovers, so a flapping link does not alarm on every bounce. ' +
          'A dependency that would form a loop is refused: a loop of masters can never recover. ' +
          'The master has to be a sensor the caller can read, here, through the settings route ' +
          'and in bulk alike; one they cannot read is refused as one that does not exist, and ' +
          'a step of a refused loop they cannot see reads `null` in `details.path` (`A-77`).',
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['mode'],
          properties: {
            mode: { enum: ['parent', 'object', 'device', 'none'] },
            masterId: { type: 'integer', minimum: 1 },
            delaySeconds: { type: 'integer', minimum: 0, maximum: 86_400 },
          },
        },
        response: { 200: { $ref: 'ms:pauseView' } },
      },
    },
    async (request, reply) => {
      const { mode, masterId, delaySeconds } = request.body;
      const view = await service.setDependency(
        await writerFor(request),
        request.params.id,
        mode,
        masterId,
        delaySeconds,
        optionalIfMatch(request.headers['if-match']),
      );
      await reply.send(await service.pauseSeenBy(view, await visibilityOf(request)));
    },
  );

  // ── 12. settings ─────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: number }; Querystring: { asChildOf?: number } }>(
    '/objects/:id/settings',
    {
      // `asChildOf` is read too (`A-12`): projecting under a parent is reading what that parent
      // would hand down, and a hidden one's settings are not the caller's to read.
      config: every(onObject('read'), onQueryObject('read', 'asChildOf', { optional: true })),
      schema: {
        tags: ['settings'],
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { asChildOf: { type: 'integer', minimum: 1 } },
        },
        description:
          'Effective and own values together. ?asChildOf=<parentId> projects what the object ' +
          'would resolve to under a different parent — the move confirmation dialog, without ' +
          'performing the move.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['objectId', 'asChildOf', 'settings'],
            properties: {
              objectId: { type: 'integer' },
              asChildOf: { type: ['integer', 'null'] },
              settings: { type: 'array', items: { $ref: 'ms:settingView' } },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const asChildOf = request.query.asChildOf;
      await reply.send({
        objectId: id,
        asChildOf: asChildOf ?? null,
        settings: await service.settings(id, asChildOf),
      });
    },
  );

  // ── 13. set a setting ────────────────────────────────────────────────────────────────────
  app.put<{ Params: { id: number; key: string }; Body: { value: unknown } }>(
    '/objects/:id/settings/:key',
    {
      config: onObject('write'),
      schema: {
        tags: ['settings'],
        params: settingKeyParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['value'],
          properties: { value: {} },
        },
        response: { 200: { $ref: 'ms:settingView' } },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const key = request.params.key;
      assertKnownSettingKeys([key]);

      // A writer, so that a dependency's master is held to the read bar the dependency route's
      // is (`A-77`).
      await service.setSetting(
        await writerFor(request),
        id,
        key,
        request.body.value,
        optionalIfMatch(request.headers['if-match']),
      );
      const view = (await service.settings(id)).find((s) => s.key === key);
      await reply.send(view);
    },
  );

  // ── 14. revert a setting ─────────────────────────────────────────────────────────────────
  app.delete<{ Params: { id: number; key: string } }>(
    '/objects/:id/settings/:key',
    {
      config: onObject('write'),
      schema: {
        tags: ['settings'],
        params: settingKeyParams,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'reverted', 'effective', 'own'],
            properties: {
              key: { type: 'string' },
              reverted: { type: 'boolean' },
              effective: {
                type: 'object',
                additionalProperties: false,
                required: ['value', 'source'],
                properties: { value: {}, source: { $ref: 'ms:settingSource' } },
              },
              own: { type: 'null' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const key = request.params.key;
      assertKnownSettingKeys([key]);

      const reverted = await service.clearSetting(
        actorFor(request),
        id,
        key,
        optionalIfMatch(request.headers['if-match']),
      );
      const view = (await service.settings(id)).find((s) => s.key === key);
      // The newly effective value comes back with the response, so the form repaints without
      // a second round trip.
      await reply.send({ key, reverted, effective: view?.effective, own: null });
    },
  );

  // ── 14b. one device's exception to its probe's target policy ─────────────────────────────
  app.put<{ Params: { id: number }; Body: { addresses: string[] } }>(
    '/objects/:id/target-policy-exception',
    {
      // **The bar the grant routes hold** (`A-64`): an administrator, with a `full` token. The
      // target policy exists because whoever may write a device could otherwise point a probe
      // at the cloud's metadata service; an exception that account could write would be the
      // policy turned off by the person it is there for.
      config: ADMIN,
      schema: {
        tags: ['objects'],
        summary:
          'Set or clear the addresses one device may reach although its probe’s policy refuses them',
        description:
          'The addresses of this device its probe may connect to although `probe.targetPolicy` ' +
          'refuses them (`A-64`), replacing any it had; an empty list clears it. **Only an ' +
          'administrator**, with a `full` token, may change it; anyone who may read the device ' +
          'sees it, as `targetPolicyException` on the device. **A device only, and never ' +
          'inherited**: a group, a probe or the root is refused with 409, and a device has none ' +
          'until one is set here: a clone or a template starts without one. **Addresses, one at ' +
          'a time**: not a name, a range or a zone, not multicast or the unspecified address, ' +
          'and never a cloud instance-metadata service (`169.254.169.254`, `169.254.170.2`, ' +
          '`fd00:ec2::254`), each refused with 400. A sensor on the device whose host is a ' +
          'name connects only when every address the name resolves to is allowed by the ' +
          'policy or named here. Takes `If-Match`. Audited as an update of the device. Reaches ' +
          'a probe at protocol 28 or later; an older probe refuses those addresses as before.',
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['addresses'],
          properties: {
            addresses: {
              type: 'array',
              maxItems: MAX_EXCEPTION_ADDRESSES,
              items: { type: 'string', minLength: 1, maxLength: 64 },
            },
          },
        },
        response: { 200: { $ref: 'ms:objectDetail' } },
      },
    },
    async (request, reply) => {
      const updated = await service.setTargetPolicyException(
        actorFor(request),
        request.params.id,
        request.body.addresses,
        optionalIfMatch(request.headers['if-match']),
      );
      await reply.header('ETag', etagFor(updated.version)).send(await answerFor(request, updated));
    },
  );

  // ── 15. credentials ──────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: number }; Querystring: { effective?: string } }>(
    '/objects/:id/credentials',
    {
      config: onObject('read'),
      schema: {
        tags: ['credentials'],
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { effective: { type: 'string', enum: ['true', 'false'] } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: { $ref: 'ms:credentialView' } } },
          },
        },
      },
    },
    async (request, reply) => {
      const includeInherited = request.query.effective !== 'false';
      await reply.send({
        items: await service.credentials(request.params.id, includeInherited),
      });
    },
  );

  // ── 15b. the sets with no bounds ─────────────────────────────────────────────────────────
  app.get(
    '/credentials/unbounded',
    {
      // Everything the caller can see, filtered by it (`A-12`): the list has no object in its
      // path to hold a bar against, and a set on a hidden object is simply not in it.
      config: READS,
      schema: {
        tags: ['credentials'],
        description:
          'The credential sets with no `allowedTargets` and no SSH `hostKeys`, each with the ' +
          'object it is stored on (`U-21`). `write` on that object is trust with the set ' +
          '(`A-41`), so this is the list to work through. **Only sets on objects the caller can ' +
          "see**: Core Health's `credentialsUnbounded` counts the installation's, and may be " +
          'higher. No secret, and no public field either: the set itself is read from its object.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['objectId', 'objectKind', 'objectName', 'kind', 'updatedAt'],
                  properties: {
                    objectId: { type: 'integer' },
                    objectKind: { type: 'string', enum: [...OBJECT_KINDS] },
                    objectName: { type: 'string' },
                    kind: { type: 'string', enum: [...CREDENTIAL_SET_KINDS] },
                    updatedAt: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      await reply
        .header('cache-control', PRIVATE)
        .send({ items: await service.unboundedCredentials(await visibilityOf(request)) });
    },
  );

  // ── 16. the kinds an operator can store, and the form for each ───────────────────────────
  app.get(
    '/credential-kinds',
    {
      config: READS,
      schema: {
        tags: ['credentials'],
        description:
          'The credential kinds this build can use, with the JSON Schema a form is generated ' +
          'from (`A-05`). Fields marked `writeOnly` are the secret half: they are encrypted at ' +
          'rest and **never returned by any route, to anyone**, so a form renders them as ' +
          '"set" with Replace and Clear rather than as a filled input. A kind absent from this ' +
          'list has no transport behind it yet, and storing a password nothing authenticates ' +
          'with is worse than not offering the field.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'name', 'description', 'schema'],
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    schema: { type: 'object', additionalProperties: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      await reply.send({ items: service.credentialKinds() });
    },
  );

  // ── 17. store a credential set ───────────────────────────────────────────────────────────
  app.put<{
    Params: { id: number; kind: string };
    Querystring: { dryRun?: string };
    Body: { values: Record<string, unknown> };
  }>(
    '/objects/:id/credentials/:kind',
    {
      config: onObject('write'),
      schema: {
        tags: ['credentials'],
        description:
          'Stores the credential set of this kind on this object, where everything below it ' +
          'inherits it (`CAPABILITIES.MD §10`). **A secret this omits is kept**, exactly as a ' +
          "sensor's `writeOnly` parameter is: a read never returns the value, so a client " +
          'cannot send it back, and replacing the whole record would delete the community ' +
          'string every time somebody corrected the SNMP version beside it. Send the field with ' +
          'a value to rotate it, or `null` to remove it. **`values` is checked against the ' +
          'kind**, and a field it does not declare is refused with 400 naming it: a secret ' +
          'sent under a mistyped name would otherwise be stored as a public field. The ' +
          'response carries no secret. **Storing a set here vouches for sending it** wherever ' +
          'the sensors beneath that now inherit it send it (`A-41`). **Unless it has ' +
          '`allowedTargets`, or an SSH set `hostKeys`** (`A-41b`): then it goes to every sensor ' +
          'inside them whoever wrote the sensor, and to none outside, and `withholds` says how ' +
          'many sensors beneath are outside now. **What this write changes is beside it** ' +
          '(`A-55`): `withheldBefore` is how many of the same sensors were outside before, ' +
          '`newlyWithheld` how many the write puts outside and `noLongerWithheld` how many it ' +
          'brings back, so a save that touches no target answers zero for both whatever ' +
          '`withholds` is. A sensor on a device entered by name is outside targets that are ' +
          'addresses when its type cannot be held to an address its probe checked; one whose ' +
          'type can is not counted, since its probe decides at each scan. **`byReason` gives ' +
          'each of the four for that case apart from a device the targets do not cover** ' +
          '(`A-59`), as `unpinnable` and `outside`. ' +
          'A write that widens them (an entry added, the ' +
          'list emptied, strict key checking turned off) clears the secrets it does not send ' +
          'again, and `secretsCleared` names them. **`?dryRun=true` is the same write, rolled ' +
          'back** (`U-21`): the same checks, the same refusals and the same answer, with nothing ' +
          'stored and nothing in the history, so a form can say what a save will do before it ' +
          'is confirmed. It is held to `write` on the object before anything is worked out, as ' +
          'the write is. **Every one of the four counts, whole and by reason, is of the sensors ' +
          'the caller can see**: with a `none` carved beneath the object, the sensors inside it ' +
          'are kept from the set and not counted here. The installation’s log keeps the whole ' +
          'numbers (outside after the write, put there by it, brought back by it); the history ' +
          'this API serves carries no count for a credential write.',
        params: credentialKindParams,
        querystring: dryRunQuery,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['values'],
          properties: { values: { type: 'object', additionalProperties: true } },
        },
        response: { 200: { $ref: 'ms:credentialWrite' } },
      },
    },
    async (request, reply) => {
      await reply.send(
        await service.setCredential(
          await writerFor(request),
          request.params.id,
          request.params.kind,
          request.body.values,
          optionalIfMatch(request.headers['if-match']),
          { preview: request.query.dryRun === 'true', visibility: await visibilityOf(request) },
        ),
      );
    },
  );

  // ── 18. remove a credential set ──────────────────────────────────────────────────────────
  app.delete<{ Params: { id: number; kind: string }; Querystring: { dryRun?: string } }>(
    '/objects/:id/credentials/:kind',
    {
      config: onObject('write'),
      schema: {
        tags: ['credentials'],
        description:
          'Removes the credential set defined *on this object*. It does not leave the object ' +
          'without credentials: whatever an ancestor defines comes back into force, and the ' +
          'response says which, so removing a device-level community string tells you the ' +
          "group's one is now in use rather than leaving it to be discovered. **403** when the " +
          'set that comes back into force would reach a sensor somewhere nobody with `write` on ' +
          'where it is stored vouched for, and you do not have that `write` either (`A-41`); ' +
          'the set stays. `sensors` is how many sensors beneath were using the set, **of ' +
          'those the caller can see**. ' +
          '**`?dryRun=true` is the same removal, rolled back** (`U-21`): what would lose the ' +
          'set and what would come into force, or the same 403, with the set left where it is.',
        params: credentialKindParams,
        querystring: dryRunQuery,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'removed', 'sensors', 'nowInherited'],
            properties: {
              // The kind asked to remove, which the vault refuses unless this build can use it,
              // so one of the database's kinds (`P-351`).
              kind: { type: 'string', enum: [...CREDENTIAL_SET_KINDS] },
              removed: { type: 'boolean' },
              sensors: {
                type: 'integer',
                minimum: 0,
                description:
                  'How many sensors at or beneath this object resolved this kind to the set ' +
                  'removed, of those the caller can see. Zero when there was no set to remove.',
              },
              nowInherited: {
                oneOf: [{ $ref: 'ms:credentialView' }, { type: 'null' }],
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const outcome = await service.clearCredential(
        await writerFor(request),
        request.params.id,
        request.params.kind,
        optionalIfMatch(request.headers['if-match']),
        { preview: request.query.dryRun === 'true', visibility: await visibilityOf(request) },
      );
      await reply.send({ kind: request.params.kind, ...outcome });
    },
  );
}

/**
 * The request body as an operation.
 *
 * A flat body with an `operation` discriminator rather than six endpoints, because a UI's bulk
 * bar is one control with a menu on it and six routes would be six things to keep in step. The
 * fields each operation needs are validated here rather than by the schema: JSON Schema can say
 * "targetParentId is an integer" but not "targetParentId is required when operation is move"
 * without `oneOf`, which produces error messages naming all six branches for a mistake in one.
 */
function operationFrom(
  body: {
    operation: string;
    targetParentId?: number;
    cascade?: boolean;
    key?: string;
    value?: unknown;
    minutes?: number;
    until?: string;
    from?: string;
    message?: string;
  },
  grants: CarriedGrants,
): BulkOperation {
  const needs = <T>(value: T | undefined, field: string): T => {
    if (value === undefined) {
      throw new ObjectError('OBJECT_INVALID', `${body.operation} needs ${field}`, {
        context: { phase: 'validate-request' },
        details: { operation: body.operation, missing: field },
      });
    }
    return value;
  };

  switch (body.operation) {
    case 'resume':
      return { kind: 'resume' };
    case 'move':
      return {
        kind: 'move',
        targetParentId: needs(body.targetParentId, 'targetParentId'),
        grants,
      };
    case 'clone':
      return {
        kind: 'clone',
        targetParentId: needs(body.targetParentId, 'targetParentId'),
        grants,
      };
    case 'delete':
      return { kind: 'delete', cascade: body.cascade ?? false };
    case 'setting':
      // `??` would turn an explicit null into a null and a *missing* value into one too. The
      // difference matters: setting a nullable setting to null is a real request, and leaving
      // `value` out is a malformed one.
      return { kind: 'setting', key: needs(body.key, 'key'), value: needs(body.value, 'value') };
    case 'revertSetting':
      return { kind: 'revertSetting', key: needs(body.key, 'key') };
    case 'pause': {
      // The same four-way read the single-object pause route does. One place would be better;
      // two places that disagree would be worse than either, so this mirrors it exactly.
      const request =
        body.from !== undefined && body.until !== undefined
          ? ({ kind: 'window', from: new Date(body.from), until: new Date(body.until) } as const)
          : body.minutes !== undefined
            ? ({ kind: 'duration', minutes: body.minutes } as const)
            : body.until !== undefined
              ? ({ kind: 'until', until: new Date(body.until) } as const)
              : ({ kind: 'indefinite' } as const);
      return { kind: 'pause', request, message: body.message ?? '' };
    }
    default:
      // Unreachable through the API, whose schema enumerates the six. Here so the switch is
      // total and a seventh added to the schema alone fails loudly rather than silently.
      throw new ObjectError('OBJECT_INVALID', `there is no bulk operation "${body.operation}"`, {
        context: { phase: 'validate-request' },
        details: { operation: body.operation },
      });
  }
}
