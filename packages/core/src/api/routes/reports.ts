// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { AuthError } from '../../auth/errors.js';
import type { AccessRight } from '../../auth/access.js';
import { REPORT_KINDS, type ReportGrant, type ReportRow } from '../../reports/repository.js';
import { REPORT_SPAN_KINDS, MAX_SPAN_OFFSET, planReportSpan } from '../../reports/span.js';
import { REPORT_FREQUENCIES, describeSchedule, validateSchedule } from '../../reports/cadence.js';
import type { ReportRun, ReportRunner, ReportRunRepository } from '../../reports/runs.js';
import {
  REPORT_DELIVERY_MODES,
  REPORT_FORMATS,
  MAX_RECIPIENTS,
  type ReportFormat,
} from '../../reports/outputs.js';
import type { ReportOutputRepository } from '../../reports/delivery.js';
import { ReportError } from '../../reports/errors.js';
import type { ReportContext } from '../../reports/context.js';
import type { ReportRenderer } from '../../reports/render.js';
import type { Database } from '../../db/pool.js';
import { OBJECT_KINDS } from '../../objects/types.js';
import { QUERY_ADJUSTMENT_KINDS, SERIES_SOURCES } from '../../timeseries/query.js';
import { ACCOUNT_ROLES } from '../../auth/accounts.js';
import type { ReportFormatter } from '../../reports/formatter.js';
import { MAX_PDF_PAGES, mediaTypeOf } from '../../reports/media.js';
import type { ReportService, ReportViewer } from '../../reports/service.js';
import { actorFor } from '../authentication.js';
import { READS, writesIn } from '../authorization.js';
import { grantParams, idParams, pathId } from '../params.js';
import { etagFor } from '../preconditions.js';

/**
 * The report CRUD surface (`E-01`, `CAPABILITIES.MD §6`).
 *
 * Deliberately the same shape as `routes/maps.ts`: the right decided per report inside the
 * service, `If-Match` on the write, 404 rather than 403 for a report the caller may not see, and
 * 204 from the grant routes. Two first-class grantable things should not have two
 * different-feeling APIs. **And every change declares `write`, which the hook checks** (`A-14`),
 * for the reason `routes/maps.ts` gives: `READS` everywhere let a read-only account and a
 * read-scoped token create reports, because creating one has no report to hold a right on.
 *
 * **What this file does not do is run anything.** `E-08` adds "run now" and the schedule; `E-04`
 * adds the output. A report here is a saved intention.
 */

export interface ReportRouteOptions {
  reports: ReportService;
  /**
   * Resolves the security context (`E-03`). Required rather than optional, and on purpose: an
   * optional one would make "no context resolver" a silent second meaning for "no checks".
   */
  context: ReportContext;
  /** Turns a report into a document (`E-04`). Required for the same reason `context` is. */
  renderer: ReportRenderer;
  /** Runs one, on demand or on a schedule (`E-08`). */
  runner: ReportRunner;
  runs: ReportRunRepository;
  /** What a run produced, and the bytes behind it (`E-09`). */
  outputStore: ReportOutputRepository;
  /**
   * Formats a document off the event loop (`P-204`). The render route answers from it, so a
   * hundred people pressing "render" at once queue for two workers rather than freezing the core.
   */
  formatter: ReportFormatter;
  db: Database;
}

/** Every change to a report: `write` here, and the right on the report in `ReportService`. */
const REPORT_WRITES = writesIn('ReportService');

/**
 * `/reports/:id/runs/:runId/:format` (`L-06`). The format is one a run can have stored, so a
 * name PostgreSQL cannot take as text — one carrying a NUL — is a 400 rather than a 500.
 */
const outputParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'runId', 'format'],
  properties: {
    id: pathId,
    runId: pathId,
    format: { type: 'string', enum: [...REPORT_FORMATS, 'zip'] },
  },
} as const;

/** `If-Match` read the way `routes/maps.ts` reads it: 428 when missing, 400 when not a version. */
function expectedVersion(header: string | undefined, reportId: number): number {
  if (header === undefined || header.trim() === '') {
    throw new ReportError(
      'REPORT_PRECONDITION_REQUIRED',
      'this request requires an If-Match header carrying the version the edit was based on',
      { context: { reportId, phase: 'precondition' } },
    );
  }
  const version = Number(header.replace(/^W\/|"/g, ''));
  if (!Number.isInteger(version)) {
    throw new ReportError('REPORT_INVALID', `If-Match must carry a report version, got ${header}`, {
      context: { reportId, phase: 'precondition' },
    });
  }
  return version;
}

interface ReportBody {
  name: string;
  description?: string;
  kind: string;
  subjects?: { objectIds: number[] };
  span?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  schedule?: Record<string, unknown>;
  runAs?: string;
}

/**
 * The span document, which `E-02` gave a shape (`CAPABILITIES.MD §6`).
 *
 * `additionalProperties: false` on purpose: a typo in `timezone` that the schema waved through
 * would resolve in the core's own zone and produce a month that is right to within a few hours,
 * which is the kind of wrong nobody notices until an audit.
 */
const spanSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { type: 'string', enum: [...REPORT_SPAN_KINDS] },
    /** Periods back from now: 1 is the last complete one, 0 the one in progress. */
    offset: { type: 'integer', minimum: 0, maximum: MAX_SPAN_OFFSET },
    timezone: { type: 'string', maxLength: 64 },
    from: { type: 'string' },
    to: { type: 'string' },
    resolutionSeconds: { type: 'integer', minimum: 1 },
  },
} as const;

/**
 * What the span works out to right now, and what the rules did to it.
 *
 * **Read-only, and computed per request rather than stored**, because "last month" is a different
 * fortnight every month. It is on the response at all because `§6`'s rules are not cosmetic: an
 * author who pinned five-minute averaging over a quarter has to be told it will be rendered hourly
 * *while they are still looking at the form*, not discover it in a PDF a month later.
 */
const resolvedSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to', 'label', 'timezone', 'bucketSeconds', 'source', 'adjustments'],
  properties: {
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
    label: { type: 'string' },
    timezone: { type: 'string' },
    bucketSeconds: { type: 'integer' },
    /** Which rollup tier answers — the visible consequence of the averaging rule. */
    source: {
      // Computed per request from the rollup tiers and never stored (`P-361`).
      type: 'string',
      enum: [...SERIES_SOURCES],
      description:
        'The table the span would be read from: raw `sample`, or a rollup tier (`sample_5m`, ' +
        '`sample_1h`, `sample_1d`).',
    },
    adjustments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['kind', 'reason'],
        properties: {
          kind: { type: 'string', enum: [...QUERY_ADJUSTMENT_KINDS] },
          reason: {
            type: 'string',
            description:
              'A sentence for a person, naming the rule and its numbers. Free text: switch on ' +
              '`kind`.',
          },
        },
      },
    },
  },
} as const;

/** Set when the span cannot be resolved at all, which is the only state `resolved` cannot describe. */
const unresolvableSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message'],
  properties: { code: { type: 'string' }, message: { type: 'string' } },
} as const;

/**
 * How often a report runs (`E-08`, `CAPABILITIES.MD §6`).
 *
 * `additionalProperties: false` for the reason the span's is: a `weekday` on a monthly report is
 * a setting somebody made and nothing honours, and silently accepting it is worse than refusing
 * it. The service refuses the same combinations again — the schema cannot know that `scheduleId`
 * names a schedule that exists, and the two checks answer different halves.
 */
const scheduleSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { type: 'string', enum: [...REPORT_FREQUENCIES] },
    /** Minutes past the hour for `hourly`, past midnight for everything coarser. */
    minute: { type: 'integer', minimum: 0, maximum: 1439 },
    weekday: { type: 'integer', minimum: 0, maximum: 6 },
    dayOfMonth: { type: 'integer', minimum: 1, maximum: 31 },
    month: { type: 'integer', minimum: 1, maximum: 12 },
    timezone: { type: 'string', maxLength: 64 },
    /** A `M-09` schedule whose active periods gate this (`§4`). */
    scheduleId: { type: 'integer', minimum: 1 },
  },
} as const;

/**
 * What a report renders and where it goes (`E-09`, `E-07`, `E-06`, `CAPABILITIES.MD §6`).
 *
 * All four of `§6`'s formats, taken from `REPORT_FORMATS` so a format the renderer does not have
 * cannot be admitted here. `ADR-005` Decision 3 and migrations 050 and 051 record how the stored
 * list grew to match.
 */
const outputsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    formats: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', enum: [...REPORT_FORMATS] },
    },
    delivery: { type: 'string', enum: [...REPORT_DELIVERY_MODES] },
    /** Addresses, not accounts — see `outputs.ts` on why the audience is not the security context. */
    recipients: {
      type: 'array',
      maxItems: MAX_RECIPIENTS,
      items: { type: 'string', maxLength: 320 },
    },
    /** One archive rather than several attachments. */
    zip: { type: 'boolean' },
  },
} as const;

const outputFileResponse = {
  type: 'object',
  additionalProperties: false,
  required: ['format', 'filename', 'byteSize', 'sha256', 'createdAt'],
  properties: {
    format: { type: 'string', enum: [...REPORT_FORMATS, 'zip'] },
    filename: { type: 'string' },
    byteSize: { type: 'integer' },
    sha256: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

const runResponse = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'reportId',
    'trigger',
    'requestedBy',
    'state',
    'queuedAt',
    'startedAt',
    'finishedAt',
    'durationMs',
    'spanLabel',
    'sections',
    'unavailable',
    'cells',
    'errorCode',
    'errorMessage',
    'delivery',
  ],
  properties: {
    id: { type: 'integer' },
    reportId: { type: 'integer' },
    trigger: { type: 'string', enum: ['manual', 'scheduled'] },
    requestedBy: { type: 'string' },
    state: { type: 'string', enum: ['running', 'succeeded', 'failed'] },
    queuedAt: { type: 'string', format: 'date-time' },
    startedAt: { type: ['string', 'null'], format: 'date-time' },
    finishedAt: { type: ['string', 'null'], format: 'date-time' },
    durationMs: { type: ['integer', 'null'] },
    /** The period it covered, as the report labelled it — "do we have August" is the question. */
    spanLabel: { type: 'string' },
    sections: { type: ['integer', 'null'] },
    unavailable: { type: ['integer', 'null'] },
    cells: { type: ['integer', 'null'] },
    errorCode: { type: 'string' },
    errorMessage: { type: 'string' },
    /**
     * Where the document went (`E-09`).
     *
     * `none` is a run nobody asked to have delivered. `pending` has bytes and an address and has
     * not gone yet. `failed` is terminal: it will not be retried again without somebody acting,
     * which is the half of the rule that says a delivery failure must not be silent.
     */
    delivery: {
      type: 'object',
      additionalProperties: false,
      required: ['state', 'attempts', 'error', 'nextAttemptAt', 'deliveredAt'],
      properties: {
        state: { type: 'string', enum: ['none', 'pending', 'sent', 'failed'] },
        attempts: { type: 'integer' },
        error: { type: 'string' },
        nextAttemptAt: { type: ['string', 'null'], format: 'date-time' },
        deliveredAt: { type: ['string', 'null'], format: 'date-time' },
      },
    },
    /** What this run produced and still holds. Empty once an email-only report has been sent. */
    outputs: { type: 'array', items: outputFileResponse },
  },
} as const;

const reportResponse = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'name',
    'description',
    'kind',
    'subjects',
    'span',
    'outputs',
    'schedule',
    'scheduleSummary',
    'nextRunAt',
    'lastRunAt',
    'runAs',
    'version',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    description: { type: 'string' },
    kind: { type: 'string', enum: [...REPORT_KINDS] },
    subjects: { type: 'object', additionalProperties: true },
    span: spanSchema,
    resolved: resolvedSchema,
    unresolvable: unresolvableSchema,
    outputs: outputsSchema,
    schedule: scheduleSchema,
    /** `every Monday at 03:00`, so a client need not restate the rules to show them. */
    scheduleSummary: { type: 'string' },
    /** When the scheduler will next run this. **Null is not an error** — see the description. */
    nextRunAt: { type: ['string', 'null'], format: 'date-time' },
    lastRunAt: { type: ['string', 'null'], format: 'date-time' },
    /**
     * The security context, and **`available` is the half a client has to act on**.
     *
     * `login` is always the account this report was set to render through; `available` is false
     * once it has been **deleted or disabled**, either of which means the report will refuse to
     * run until somebody points it at a live account. Two fields rather than a nullable one, so a
     * UI can say "renders as alice — that account is gone" instead of "renders as nobody".
     */
    runAs: {
      type: 'object',
      additionalProperties: false,
      required: ['login', 'available'],
      properties: { login: { type: 'string' }, available: { type: 'boolean' } },
    },
    version: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const grantResponse = {
  type: 'object',
  additionalProperties: false,
  required: ['groupId', 'groupName', 'right', 'grantedAt', 'grantedBy'],
  properties: {
    groupId: { type: 'integer' },
    groupName: { type: 'string' },
    right: { type: 'string', enum: ['none', 'read', 'write', 'full'] },
    grantedAt: { type: 'string', format: 'date-time' },
    grantedBy: { type: 'string' },
  },
} as const;

const reportBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'kind'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    description: { type: 'string', maxLength: 1000 },
    kind: { type: 'string', enum: [...REPORT_KINDS] },
    subjects: {
      type: 'object',
      additionalProperties: false,
      required: ['objectIds'],
      properties: { objectIds: { type: 'array', items: { type: 'integer' } } },
    },
    span: spanSchema,
    outputs: outputsSchema,
    schedule: scheduleSchema,
    runAs: { type: 'string', maxLength: 64 },
  },
} as const;

/**
 * The window a span works out to, or why it does not work out to one.
 *
 * **A span that cannot resolve must not fail the read.** The one case that reaches this is an
 * `offset: 0` span asked for before its period has started — a month-to-date report fetched at
 * 00:00:00 on the 1st — and answering 500 for a listing because one of twenty reports is a
 * minute early would be a worse bug than the one it reports. The refusal travels as a field on
 * that report instead, which is also the only way a UI can say which one it is.
 */
function resolveFor(report: ReportRow, now: Date): Record<string, unknown> {
  try {
    const { window, plan } = planReportSpan(report.span, now);
    return {
      resolved: {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        label: window.label,
        timezone: window.timezone,
        bucketSeconds: plan.bucketSeconds,
        source: plan.source,
        adjustments: window.adjustments,
      },
    };
  } catch (error) {
    if (error instanceof ReportError) {
      return { unresolvable: { code: error.code, message: error.message } };
    }
    throw error;
  }
}

function serialise(report: ReportRow, now: Date): Record<string, unknown> {
  return {
    id: report.id,
    name: report.name,
    description: report.description,
    kind: report.kind,
    subjects: report.subjects,
    span: report.span,
    ...resolveFor(report, now),
    outputs: report.outputs,
    schedule: report.schedule,
    // Regenerated rather than stored: one description of what a schedule means, beside the code
    // that acts on it. A stored summary is a second copy that goes stale on the first edit.
    scheduleSummary: describeSchedule(validateSchedule(report.schedule)),
    nextRunAt: report.nextRunAt?.toISOString() ?? null,
    lastRunAt: report.lastRunAt?.toISOString() ?? null,
    runAs: {
      login: report.runAsLogin,
      // **Both ways of losing a context, not just the one `E-01` could see.** A deleted account
      // nulls the id; a disabled one keeps its row and would otherwise read as available on a
      // report that refuses to run (`E-03`).
      available: report.runAsUserId !== null && !report.runAsDisabled,
    },
    version: report.version,
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString(),
  };
}

function serialiseGrant(grant: ReportGrant): Record<string, unknown> {
  return {
    groupId: grant.groupId,
    groupName: grant.groupName,
    right: grant.right,
    grantedAt: grant.grantedAt.toISOString(),
    grantedBy: grant.grantedBy,
  };
}

/**
 * The viewer behind a request, or a refusal.
 *
 * At module scope rather than inside `reportRoutes`, because `reportRenderRoute` is registered
 * separately for its schema exemption and must reach the same one — two copies would be two
 * chances for one of them to forget the `scope` ceiling.
 */
function viewerOf(request: {
  principal?: { userId: number; role: ReportViewer['role']; scope?: AccessRight } | undefined;
}): ReportViewer {
  const principal = request.principal;
  if (principal === undefined) {
    throw new AuthError('AUTH_REQUIRED', 'this request needs a session; log in first');
  }
  return principal.scope === undefined
    ? { userId: principal.userId, role: principal.role }
    : { userId: principal.userId, role: principal.role, scope: principal.scope };
}

function serialiseRun(
  run: ReportRun,
  outputs: readonly {
    format: string;
    filename: string;
    byteSize: number;
    sha256: string;
    createdAt: Date;
  }[] = [],
): Record<string, unknown> {
  return {
    id: run.id,
    reportId: run.reportId,
    trigger: run.trigger,
    requestedBy: run.requestedBy,
    state: run.state,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    durationMs: run.durationMs,
    spanLabel: run.spanLabel,
    sections: run.sections,
    unavailable: run.unavailable,
    cells: run.cells,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    delivery: {
      state: run.delivery.state,
      attempts: run.delivery.attempts,
      error: run.delivery.error,
      nextAttemptAt: run.delivery.nextAttemptAt?.toISOString() ?? null,
      deliveredAt: run.delivery.deliveredAt?.toISOString() ?? null,
    },
    outputs: outputs.map((file) => ({
      format: file.format,
      filename: file.filename,
      byteSize: file.byteSize,
      sha256: file.sha256,
      createdAt: file.createdAt.toISOString(),
    })),
  };
}

/** How many past runs one listing shows. A month of hourly runs is more than anybody reads. */
const RUNS_PER_PAGE = 50;

export function reportRoutes(app: FastifyInstance, options: ReportRouteOptions): void {
  const { reports, context, runner, runs, outputStore, db } = options;

  app.get(
    '/reports',
    {
      config: READS,
      schema: {
        tags: ['reports'],
        summary: 'The reports this account may see',
        description:
          'By name. An administrator sees every report; everybody else sees the ones a group ' +
          'they belong to has been granted.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: reportResponse } },
          },
        },
      },
    },
    async (request) => {
      // One clock for the whole listing, so twenty reports on the same span all name the same
      // window rather than drifting apart by however long the loop took.
      const now = new Date();
      return { items: (await reports.list(viewerOf(request))).map((one) => serialise(one, now)) };
    },
  );

  app.get<{ Params: { id: number } }>(
    '/reports/:id',
    {
      config: READS,
      schema: {
        params: idParams,
        tags: ['reports'],
        summary: 'One report',
        description:
          'A report this account may not read answers 404 rather than 403, so the error cannot ' +
          'be used to enumerate which ids exist. The `ETag` is the version, to send back as ' +
          '`If-Match`.',
        response: { 200: reportResponse },
      },
    },
    async (request, reply) => {
      const report = await reports.get(viewerOf(request), request.params.id);
      return reply.header('ETag', etagFor(report.version)).send(serialise(report, new Date()));
    },
  );

  app.post<{ Body: ReportBody }>(
    '/reports',
    {
      config: REPORT_WRITES,
      schema: {
        tags: ['reports'],
        summary: 'Create a report',
        description:
          'The creator’s primary group is granted full access in the same transaction, or a ' +
          'non-administrator would create a report and immediately lose sight of it. `runAs` ' +
          'defaults to the caller: a report renders through somebody’s eyes, and the person ' +
          'making it is the only safe default. **Naming any other account needs an ' +
          'administrator**, and a login that does not exist is refused in the same words as ' +
          'one that does, so the refusal cannot be used to list accounts.\n\n' +
          '`span` names a calendar period — `{ kind, offset, timezone }` for `day`, `week`, ' +
          '`month`, `quarter` and `year`, or `{ kind: "custom", from, to }` with ISO 8601 ' +
          'instants. **`offset` counts periods back and defaults to 1**, the last complete one: ' +
          'a monthly report fires on the 1st, and "this month" would be two hours long. `0` is ' +
          'the period in progress and ends now. Weeks start on Monday (ISO 8601), and the zone ' +
          'defaults to the core’s own. Add `resolutionSeconds` to pin an averaging interval.\n\n' +
          'The response carries `resolved`: the window the span works out to right now, the ' +
          'bucket width, the rollup tier that will answer, and anything the rules changed — ' +
          'a span of 40 days or more is averaged over at least an hour, and one over 500 days ' +
          'is shortened to 365. A span that cannot resolve yet answers `unresolvable` instead.',
        body: reportBody,
        response: { 201: reportResponse },
      },
    },
    async (request, reply) => {
      const created = await reports.create(viewerOf(request), request.body, actorFor(request));
      return reply
        .code(201)
        .header('ETag', etagFor(created.version))
        .send(serialise(created, new Date()));
    },
  );

  app.patch<{
    Params: { id: number };
    Body: Partial<ReportBody>;
    Headers: { 'if-match'?: string };
  }>(
    '/reports/:id',
    {
      config: REPORT_WRITES,
      schema: {
        params: idParams,
        tags: ['reports'],
        summary: 'Change a report',
        description:
          '`If-Match` carries the version this edit was made against, and is refused with 428 ' +
          'when missing and 412 `REPORT_CHANGED` when it has moved on. Changing `runAs` needs ' +
          'full access rather than write: it decides whose data the output contains, which is ' +
          'the same class of act as granting access. **Full is enough only to point it at ' +
          'yourself** — naming any other account needs an administrator, as it does on create.',
        body: { ...reportBody, required: [] },
        response: { 200: reportResponse },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const updated = await reports.update(
        viewerOf(request),
        id,
        expectedVersion(request.headers['if-match'], id),
        request.body,
        actorFor(request),
      );
      return reply.header('ETag', etagFor(updated.version)).send(serialise(updated, new Date()));
    },
  );

  app.delete<{ Params: { id: number } }>(
    '/reports/:id',
    {
      config: REPORT_WRITES,
      schema: {
        params: idParams,
        tags: ['reports'],
        summary: 'Delete a report',
        description: 'Needs full access, because deleting one takes its grants with it.',
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      await reports.remove(viewerOf(request), request.params.id, actorFor(request));
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: number } }>(
    '/reports/:id/subjects',
    {
      config: READS,
      schema: {
        params: idParams,
        tags: ['reports'],
        summary: 'What this report would contain, as its security context sees it',
        description:
          'A report renders through a named account, not through whoever is asking (`§6`). This ' +
          'route answers the same question the renderer will: which of the objects the report ' +
          'names that account can actually read.\n\n' +
          '**Reading this needs only `read` on the report, and that is the act-as grant working ' +
          'as designed** — granting somebody access to a report grants them everything its ' +
          '`runAs` account can see, whatever their own rights are. Grant reports the way you ' +
          'would grant the account they run as.\n\n' +
          '`unavailable` lists ids this report will not render, and deliberately does not say ' +
          'whether each is deleted or merely out of scope: a `write` holder on a report needs no ' +
          'access to the object tree, and telling the two apart would make this an existence ' +
          'oracle for every id in the installation. The distinction is in the core log.\n\n' +
          'Answers 422 when the account has been deleted or disabled — understood request, real ' +
          'report, no scope to render it through, and no right the caller could hold would fix it.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['runAs', 'visible', 'unavailable'],
            properties: {
              runAs: {
                type: 'object',
                additionalProperties: false,
                required: ['login', 'role'],
                properties: {
                  login: { type: 'string' },
                  // `user_account.role`, which `user_account_role_check` holds (`P-361`).
                  role: { type: 'string', enum: [...ACCOUNT_ROLES] },
                },
              },
              visible: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'kind', 'name'],
                  properties: {
                    id: { type: 'integer' },
                    kind: { type: 'string', enum: [...OBJECT_KINDS] },
                    name: { type: 'string' },
                  },
                },
              },
              unavailable: { type: 'array', items: { type: 'integer' } },
            },
          },
        },
      },
    },
    async (request) => {
      const report = await reports.get(viewerOf(request), request.params.id);
      const resolved = await context.subjectsFor(report);
      return {
        runAs: { login: resolved.principal.login, role: resolved.principal.role },
        visible: resolved.visible,
        unavailable: resolved.unavailable,
      };
    },
  );

  app.post<{ Params: { id: number } }>(
    '/reports/:id/runs',
    {
      config: REPORT_WRITES,
      schema: {
        params: idParams,
        tags: ['reports'],
        summary: 'Run this report now',
        // Delivery is `E-09`'s.
        description:
          'Renders the report against its span and its security context, and records the ' +
          'outcome. **Needs `write`, not `read`** — a render is minutes of work against the same ' +
          'database serving live checks, so starting one is a write even though it changes ' +
          'nothing about the report.\n\n' +
          '**One run at a time.** A report already rendering answers 409 rather than queueing: a ' +
          'button pressed six times must not become six renders competing for the same pool. The ' +
          'constraint is a partial unique index, so two requests racing lose at the database ' +
          'rather than in a window between a check and an insert.\n\n' +
          'Where the rendered document goes is the report’s `outputs.delivery`: `store` keeps it ' +
          'for download, `store-and-email` keeps it and emails it, and `email` emails it and ' +
          'keeps it only until it has been sent. The run’s `delivery` says whether it has been ' +
          'sent, and the run’s `outputs` lists the files it still holds. The run records that ' +
          'it ran, what period it covered, how large it was, and why it failed if it did, which ' +
          'is what tells an operator at 09:00 whether last night worked.',
        response: { 201: runResponse },
      },
    },
    async (request, reply) => {
      const report = await reports.require(viewerOf(request), request.params.id, 'write');
      const run = await runner.runNow(report, request.principal?.login ?? '');
      return reply.code(201).send(serialiseRun(run, await outputStore.list(db, run.id)));
    },
  );

  app.get<{ Params: { id: number } }>(
    '/reports/:id/runs',
    {
      config: READS,
      schema: {
        params: idParams,
        tags: ['reports'],
        summary: 'When this report ran, and what happened',
        description:
          `Newest first, at most ${String(RUNS_PER_PAGE)} of them. A run that failed carries the ` +
          'same code the API would have answered with, so an operator reading this and an ' +
          'operator reading a 422 are told the same thing.\n\n' +
          'A run left `failed` with `REPORT_INTERRUPTED` was in flight when the core stopped. It ' +
          'is marked at the next startup rather than left `running` for ever — the partial unique ' +
          'index over `running` would otherwise keep that report unrunnable.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: runResponse } },
          },
        },
      },
    },
    async (request) => {
      const report = await reports.get(viewerOf(request), request.params.id);
      const listed = await runs.list(db, report.id, RUNS_PER_PAGE);
      // One query for every run's outputs rather than one per run: a page of fifty would
      // otherwise be fifty round trips to say how big things are.
      const files = await outputStore.listFor(
        db,
        listed.map((one) => one.id),
      );
      return {
        items: listed.map((one) => serialiseRun(one, files.get(one.id) ?? [])),
      };
    },
  );

  app.get<{ Params: { id: number } }>(
    '/reports/:id/access',
    {
      config: READS,
      schema: {
        params: idParams,
        tags: ['reports'],
        summary: 'Which groups may see this report',
        description: 'Needs full access: who else can read a report is not a read-only detail.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: grantResponse } },
          },
        },
      },
    },
    async (request) => ({
      items: (await reports.grants(viewerOf(request), request.params.id)).map(serialiseGrant),
    }),
  );

  app.put<{ Params: { id: number; groupId: number }; Body: { right: AccessRight } }>(
    '/reports/:id/access/:groupId',
    {
      config: REPORT_WRITES,
      schema: {
        params: grantParams,
        tags: ['reports'],
        summary: 'Grant a group access to this report',
        description:
          'Needs full access, so a write holder may edit what a report measures without ' +
          'deciding who else reads it. Granting twice replaces rather than failing.',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['right'],
          properties: { right: { type: 'string', enum: ['none', 'read', 'write', 'full'] } },
        },
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      await reports.grant(
        viewerOf(request),
        request.params.id,
        request.params.groupId,
        request.body.right,
        actorFor(request),
      );
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: number; groupId: number } }>(
    '/reports/:id/access/:groupId',
    {
      config: REPORT_WRITES,
      schema: {
        params: grantParams,
        tags: ['reports'],
        summary: 'Take a group’s access away',
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      await reports.revoke(
        viewerOf(request),
        request.params.id,
        request.params.groupId,
        actorFor(request),
      );
      return reply.code(204).send();
    },
  );
}

/**
 * A rendered report, as HTML, CSV or XML (`E-04`, `E-07`).
 *
 * Registered on its own because it answers text rather than JSON, which is the one thing the
 * response-schema guard cannot filter — the same exemption `mapBackgroundRoute` takes, declared
 * next to the registration so it covers this route and not the seven beside it.
 */
export function reportRenderRoute(app: FastifyInstance, options: ReportRouteOptions): void {
  const { reports, renderer, formatter } = options;

  app.get<{ Params: { id: number }; Querystring: { format?: string } }>(
    '/reports/:id/render',
    {
      config: READS,
      schema: {
        params: idParams,
        tags: ['reports'],
        summary: 'Render this report now, as HTML, CSV, XML or PDF',
        // The PDF layout is `ADR-006`'s, and the security context `E-03`'s.
        description:
          'Runs the report against its span and its security context and answers the document. ' +
          '`?format=html` (the default), `?format=csv`, `?format=xml` or `?format=pdf`.\n\n' +
          '**An interval with no reading is a gap, in every format** — an empty field in CSV, ' +
          '`—` in HTML and in PDF, and `xsi:nil="true"` in XML, never a zero and never the ' +
          'previous value carried forward. A row whose channels are all empty is still printed: ' +
          'dropping it would make the table claim the period was shorter than it was.\n\n' +
          'A PDF is laid out by this service rather than by a browser, so it has a ' +
          'page limit as well as a value limit: a report over ' +
          `${String(MAX_PDF_PAGES)} pages answers 422 with the count and what to narrow.\n\n` +
          'Subjects the report’s account cannot read are counted in the document rather than ' +
          'omitted from it, and answer as ids without saying which are deleted. A report ' +
          'whose account has been deleted or disabled answers 422, and one that would render more ' +
          'values than the limit answers 422 with the count and what to narrow — refused rather ' +
          'than truncated, because a report quietly missing its last four hundred sensors is the ' +
          'failure this whole surface exists to avoid.',
      },
    },
    async (request, reply) => {
      const format = request.query.format ?? 'html';
      if (!(REPORT_FORMATS as readonly string[]).includes(format)) {
        throw new ReportError('REPORT_INVALID', `there is no report format called "${format}"`, {
          context: { phase: 'render' },
          details: { format },
        });
      }
      const report = await reports.get(viewerOf(request), request.params.id);
      const document = await renderer.build(report);

      const slug = report.name.replaceAll(/[^\w.-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'report';
      return (
        reply
          .type(mediaTypeOf(format))
          // `inline` rather than `attachment`: an operator following a link wants to look at it. The
          // filename still travels, so saving it produces something named after the report.
          .header('content-disposition', `inline; filename="${slug}.${format}"`)
          .send(await formatter.format(format as ReportFormat, document))
      );
    },
  );
}

/**
 * Downloading a stored report (`E-09`, `ADR-005`).
 *
 * Registered beside `reportRenderRoute` and exempt from the response-schema guard for the same
 * reason: it answers bytes. The second route in this system to do so after `G-05`'s background,
 * and it borrows that one's caching shape — the output's own SHA-256 as a strong `ETag`, honoured
 * on `If-None-Match`, because a stored report never changes and re-downloading a megabyte to be
 * told so is waste.
 */
export function reportDownloadRoute(app: FastifyInstance, options: ReportRouteOptions): void {
  const { reports, runs, outputStore, db } = options;

  app.get<{
    Params: { id: number; runId: number; format: string };
    Headers: { 'if-none-match'?: string };
  }>(
    '/reports/:id/runs/:runId/:format',
    {
      config: READS,
      schema: {
        params: outputParams,
        tags: ['reports'],
        summary: 'Download what a run produced',
        // An email-only report keeps nothing once sent: `ADR-005`, Decision 4.
        description:
          'The stored document, as `html`, `csv`, `xml`, `pdf` or `zip` depending on what the ' +
          'report was set ' +
          'to render. The bytes carry their own SHA-256 as a strong `ETag`; send `If-None-Match` ' +
          'and a second download is a 304.\n\n' +
          '**An email-only report keeps nothing once it has been delivered**, and answers 404 ' +
          'here. It is stored between rendering and sending because a ' +
          'retry needs the bytes, and a re-render months later is a different document.',
      },
    },
    async (request, reply) => {
      // Read on the *report* is the gate, and the run has to belong to it: without that check a
      // caller who may read one report could download any run by guessing an id.
      const report = await reports.get(viewerOf(request), request.params.id);
      const runId = request.params.runId;
      const run = await runs.find(db, runId);
      if (run === undefined || run.reportId !== report.id) {
        throw new ReportError('REPORT_NOT_FOUND', `run ${String(runId)} does not exist`, {
          context: { reportId: report.id, phase: 'download' },
        });
      }

      const stored = await outputStore.read(db, runId, request.params.format);
      if (stored === undefined) {
        throw new ReportError(
          'REPORT_NOT_FOUND',
          `run ${String(runId)} has no ${request.params.format} output`,
          { context: { reportId: report.id, phase: 'download' } },
        );
      }

      const etag = `"${stored.sha256}"`;
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();

      return (
        reply
          .type(mediaTypeOf(stored.format))
          .header('etag', etag)
          // The URL is stable and the bytes behind it never change, so revalidation is cheap and
          // correct. `ADR-003` Decision 4 explains why this is not an immutable max-age.
          .header('cache-control', 'private, max-age=0, must-revalidate')
          .header('content-disposition', `attachment; filename="${stored.filename}"`)
          // Belt and braces around a stored document: `G-05` serves an operator's image the same
          // way, and a report is HTML somebody's browser would happily execute.
          .header('x-content-type-options', 'nosniff')
          .send(stored.body)
      );
    },
  );
}
