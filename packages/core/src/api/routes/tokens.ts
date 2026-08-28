import '@fastify/swagger';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuthError } from '../../auth/errors.js';
import type { TokenService } from '../../auth/tokens.js';
import type { RequestPrincipal } from '../authentication.js';

export interface TokenRoutesOptions {
  tokens: TokenService;
}

const tokenSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'prefix', 'scope', 'createdAt'],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    prefix: {
      type: 'string',
      description:
        'The first few characters, so a list of tokens is readable. Never enough to use — the ' +
        'rest is shown once at creation and is unrecoverable afterwards.',
    },
    scope: {
      type: 'string',
      enum: ['none', 'read', 'write', 'full'],
      description:
        'A ceiling, not a grant. The effective right is the lesser of this, the account’s role ' +
        'and what its groups grant on the object — so a token can only ever be less than its ' +
        'owner.',
    },
    expiresAt: { type: ['string', 'null'] },
    lastUsedAt: { type: ['string', 'null'] },
    revokedAt: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
  },
} as const;

/**
 * API tokens (`A-06`).
 *
 * **Every route here is about the caller's *own* tokens.** There is no route to list or mint a
 * token for somebody else — an administrator who could would be an administrator who could act
 * as any account without leaving a trace that says so. Revoking somebody else's access is done
 * by disabling their account, which stops every token they hold at once.
 */
export function tokenRoutes(app: FastifyInstance, options: TokenRoutesOptions): void {
  const { tokens } = options;

  const principalOf = (request: FastifyRequest): RequestPrincipal => {
    const principal = request.principal;
    if (principal === undefined) {
      throw new AuthError('AUTH_REQUIRED', 'this request needs a session; log in first');
    }
    return principal;
  };

  app.get<{ Querystring: { includeRevoked?: string } }>(
    '/auth/tokens',
    {
      schema: {
        tags: ['auth'],
        summary: 'The API tokens this account holds',
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { includeRevoked: { type: 'string', enum: ['true', 'false'] } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: tokenSchema } },
          },
        },
      },
    },
    async (request) => {
      const principal = principalOf(request);
      const includeRevoked = request.query.includeRevoked === 'true';
      return { items: await tokens.listFor(principal.userId, includeRevoked) };
    },
  );

  app.post<{ Body: { name: string; scope?: 'none' | 'read' | 'write' | 'full'; expiresAt?: string } }>(
    '/auth/tokens',
    {
      schema: {
        tags: ['auth'],
        summary: 'Issue an API token',
        description:
          'The secret is in this response and nowhere else, ever again — only its hash is stored. ' +
          'A scope higher than the account’s own role is lowered to it rather than refused, ' +
          'because the request is coherent and the answer is simply "that is as much as you have".',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            scope: { type: 'string', enum: ['none', 'read', 'write', 'full'], default: 'read' },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
        response: {
          201: {
            type: 'object',
            additionalProperties: false,
            required: ['token', 'secret'],
            properties: {
              token: tokenSchema,
              secret: {
                type: 'string',
                description: 'Shown once. Store it now; it cannot be retrieved again.',
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      // **A token cannot mint a token.** Otherwise a leaked read-scoped token is one request away
      // from a full-scoped one, and the scope stops being a limit at all.
      if (principal.tokenId !== undefined) {
        throw new AuthError(
          'AUTH_FORBIDDEN',
          'an API token cannot issue another; log in to manage tokens',
        );
      }
      const issued = await tokens.issue(
        { userId: principal.userId, role: principal.role },
        {
          name: request.body.name,
          ...(request.body.scope === undefined ? {} : { scope: request.body.scope }),
          ...(request.body.expiresAt === undefined
            ? {}
            : { expiresAt: new Date(request.body.expiresAt) }),
        },
      );
      return reply.status(201).send(issued);
    },
  );

  app.delete<{ Params: { id: number } }>(
    '/auth/tokens/:id',
    {
      schema: {
        tags: ['auth'],
        summary: 'Revoke one of this account’s tokens',
        description:
          'Scoped to the caller’s own tokens: a token id is a small integer, and revoking ' +
          'somebody else’s would otherwise be one guess away.',
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'integer', minimum: 1 } },
        },
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      const revoked = await tokens.revoke(principal.userId, request.params.id, principal.login);
      if (!revoked) {
        throw new AuthError('TOKEN_NOT_FOUND', 'no live token of yours with that id');
      }
      return reply.status(204).send();
    },
  );
}
