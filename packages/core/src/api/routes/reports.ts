// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { AuthError } from '../../auth/errors.js';
import type { AccessRight } from '../../auth/access.js';
import { REPORT_KINDS, type ReportGrant, type ReportRow } from '../../reports/repository.js';
import { REPORT_SPAN_KINDS, MAX_SPAN_OFFSET, planReportSpan } from '../../reports/span.js';
import { ReportError } from '../../reports/errors.js';
import type { ReportContext } from '../../reports/context.js';
import type { ReportRenderer } from '../../reports/render.js';
import { renderCsv, renderHtml } from '../../reports/table.js';
import type { ReportService, ReportViewer } from '../../reports/service.js';
import { READS } from '../authorization.js';

/**
 * The report CRUD surface (`E-01`, `CAPABILITIES.MD §6`).
 *
 * Deliberately the same shape as `routes/maps.ts`: `READS` as the access marker with the right
 * decided per report inside the service, `If-Match` on the write, 404 rather than 403 for a report
 * the caller may not see, and 204 from the grant routes. Two first-class grantable things should
 * not have two different-feeling APIs.
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
    source: { type: 'string' },
    adjustments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['kind', 'reason'],
        properties: { kind: { type: 'string' }, reason: { type: 'string' } },
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
    outputs: { type: 'object', additionalProperties: true },
    schedule: { type: 'object', additionalProperties: true },
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
    outputs: { type: 'object', additionalProperties: true },
    schedule: { type: 'object', additionalProperties: true },
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

export function reportRoutes(app: FastifyInstance, options: ReportRouteOptions): void {
  const { reports, context } = options;

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

  app.get<{ Params: { id: string } }>(
    '/reports/:id',
    {
      config: READS,
      schema: {
        tags: ['reports'],
        summary: 'One report',
        description:
          'A report this account may not read answers 404 rather than 403, so the error cannot ' +
          'be used to enumerate which ids exist.',
        response: { 200: reportResponse },
      },
    },
    async (request) =>
      serialise(await reports.get(viewerOf(request), Number(request.params.id)), new Date()),
  );

  app.post<{ Body: ReportBody }>(
    '/reports',
    {
      config: READS,
      schema: {
        tags: ['reports'],
        summary: 'Create a report',
        description:
          'The creator’s primary group is granted full access in the same transaction, or a ' +
          'non-administrator would create a report and immediately lose sight of it. `runAs` ' +
          'defaults to the caller: a report renders through somebody’s eyes, and the person ' +
          'making it is the only safe default.\n\n' +
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
      const created = await reports.create(
        viewerOf(request),
        request.body,
        request.principal?.login ?? '',
      );
      return reply.code(201).send(serialise(created, new Date()));
    },
  );

  app.patch<{
    Params: { id: string };
    Body: Partial<ReportBody>;
    Headers: { 'if-match'?: string };
  }>(
    '/reports/:id',
    {
      config: READS,
      schema: {
        tags: ['reports'],
        summary: 'Change a report',
        description:
          '`If-Match` carries the version this edit was made against. Changing `runAs` needs ' +
          'full access rather than write: it decides whose data the output contains, which is ' +
          'the same class of act as granting access.',
        body: { ...reportBody, required: [] },
        response: { 200: reportResponse },
      },
    },
    async (request) => {
      const expected = Number(request.headers['if-match']?.replace(/^W\/|"/g, ''));
      if (!Number.isInteger(expected)) {
        throw new AuthError('AUTH_REQUIRED', 'If-Match must carry the version being edited');
      }
      const updated = await reports.update(
        viewerOf(request),
        Number(request.params.id),
        expected,
        request.body,
        request.principal?.login ?? '',
      );
      return serialise(updated, new Date());
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/reports/:id',
    {
      config: READS,
      schema: {
        tags: ['reports'],
        summary: 'Delete a report',
        description: 'Needs full access, because deleting one takes its grants with it.',
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      await reports.remove(
        viewerOf(request),
        Number(request.params.id),
        request.principal?.login ?? '',
      );
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    '/reports/:id/subjects',
    {
      config: READS,
      schema: {
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
                properties: { login: { type: 'string' }, role: { type: 'string' } },
              },
              visible: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'kind', 'name'],
                  properties: {
                    id: { type: 'integer' },
                    kind: { type: 'string' },
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
      const report = await reports.get(viewerOf(request), Number(request.params.id));
      const resolved = await context.subjectsFor(report);
      return {
        runAs: { login: resolved.principal.login, role: resolved.principal.role },
        visible: resolved.visible,
        unavailable: resolved.unavailable,
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/reports/:id/access',
    {
      config: READS,
      schema: {
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
      items: (await reports.grants(viewerOf(request), Number(request.params.id))).map(
        serialiseGrant,
      ),
    }),
  );

  app.put<{ Params: { id: string; groupId: string }; Body: { right: AccessRight } }>(
    '/reports/:id/access/:groupId',
    {
      config: READS,
      schema: {
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
        Number(request.params.id),
        Number(request.params.groupId),
        request.body.right,
        request.principal?.login ?? '',
      );
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string; groupId: string } }>(
    '/reports/:id/access/:groupId',
    {
      config: READS,
      schema: {
        tags: ['reports'],
        summary: 'Take a group’s access away',
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      await reports.revoke(
        viewerOf(request),
        Number(request.params.id),
        Number(request.params.groupId),
        request.principal?.login ?? '',
      );
      return reply.code(204).send();
    },
  );
}

/**
 * A rendered report, as HTML or CSV (`E-04`).
 *
 * Registered on its own because it answers text rather than JSON, which is the one thing the
 * response-schema guard cannot filter — the same exemption `mapBackgroundRoute` takes, declared
 * next to the registration so it covers this route and not the seven beside it.
 */
export function reportRenderRoute(app: FastifyInstance, options: ReportRouteOptions): void {
  const { reports, renderer } = options;

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/reports/:id/render',
    {
      config: READS,
      schema: {
        tags: ['reports'],
        summary: 'Render this report now, as HTML or CSV',
        description:
          'Runs the report against its span and its security context and answers the document. ' +
          '`?format=html` (the default) or `?format=csv`.\n\n' +
          '**An interval with no reading is a gap, in both formats** — an empty field in CSV and ' +
          '`—` in HTML, never a zero and never the previous value carried forward. A row whose ' +
          'channels are all empty is still printed: dropping it would make the table claim the ' +
          'period was shorter than it was.\n\n' +
          'Subjects the report’s account cannot read are counted in the document rather than ' +
          'omitted from it, and answer as ids without saying which are deleted (`E-03`). A report ' +
          'whose account has been deleted or disabled answers 422, and one that would render more ' +
          'values than the limit answers 422 with the count and what to narrow — refused rather ' +
          'than truncated, because a report quietly missing its last four hundred sensors is the ' +
          'failure this whole surface exists to avoid.',
      },
    },
    async (request, reply) => {
      const format = request.query.format ?? 'html';
      if (format !== 'html' && format !== 'csv') {
        throw new ReportError('REPORT_INVALID', `there is no report format called "${format}"`, {
          context: { phase: 'render' },
          details: { format },
        });
      }
      const report = await reports.get(viewerOf(request), Number(request.params.id));
      const document = await renderer.build(report);

      const slug = report.name.replaceAll(/[^\w.-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'report';
      return (
        reply
          .type(format === 'csv' ? 'text/csv; charset=utf-8' : 'text/html; charset=utf-8')
          // `inline` rather than `attachment`: an operator following a link wants to look at it. The
          // filename still travels, so saving it produces something named after the report.
          .header('content-disposition', `inline; filename="${slug}.${format}"`)
          .send(format === 'csv' ? renderCsv(document) : renderHtml(document))
      );
    },
  );
}
