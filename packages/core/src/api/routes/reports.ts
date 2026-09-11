// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { AuthError } from '../../auth/errors.js';
import type { AccessRight } from '../../auth/access.js';
import { REPORT_KINDS, type ReportGrant, type ReportRow } from '../../reports/repository.js';
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
    span: { type: 'object', additionalProperties: true },
    outputs: { type: 'object', additionalProperties: true },
    schedule: { type: 'object', additionalProperties: true },
    /**
     * The security context, and **`available` is the half a client has to act on**.
     * `login` is always the account this report was set to render through; `available` is false
     * once that account has been deleted, which means the report cannot run until somebody points
     * it at a live account (`E-03`). Two fields rather than a nullable one, so a UI can say
     * "renders as alice — that account is gone" instead of "renders as nobody".
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
    span: { type: 'object', additionalProperties: true },
    outputs: { type: 'object', additionalProperties: true },
    schedule: { type: 'object', additionalProperties: true },
    runAs: { type: 'string', maxLength: 64 },
  },
} as const;

function serialise(report: ReportRow): Record<string, unknown> {
  return {
    id: report.id,
    name: report.name,
    description: report.description,
    kind: report.kind,
    subjects: report.subjects,
    span: report.span,
    outputs: report.outputs,
    schedule: report.schedule,
    runAs: { login: report.runAsLogin, available: report.runAsUserId !== null },
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

export function reportRoutes(app: FastifyInstance, options: ReportRouteOptions): void {
  const { reports } = options;

  const viewerOf = (request: {
    principal?: { userId: number; role: ReportViewer['role']; scope?: AccessRight } | undefined;
  }): ReportViewer => {
    const principal = request.principal;
    if (principal === undefined) {
      throw new AuthError('AUTH_REQUIRED', 'this request needs a session; log in first');
    }
    return principal.scope === undefined
      ? { userId: principal.userId, role: principal.role }
      : { userId: principal.userId, role: principal.role, scope: principal.scope };
  };

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
    async (request) => ({ items: (await reports.list(viewerOf(request))).map(serialise) }),
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
    async (request) => serialise(await reports.get(viewerOf(request), Number(request.params.id))),
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
          'making it is the only safe default.',
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
      return reply.code(201).send(serialise(created));
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
      return serialise(updated);
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
