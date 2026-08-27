import '@fastify/swagger';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ProbeRegistryError, type ProbeRegistry } from '../../probes/registry.js';

export interface ProbeRoutesOptions {
  registry: ProbeRegistry;
}

const registrationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['gid', 'status', 'displayName', 'firstSeenAt'],
  properties: {
    gid: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'approved', 'revoked'] },
    displayName: { type: 'string' },
    agentVersion: { type: 'string' },
    protocolVersion: { type: 'integer' },
    lastAddress: { type: 'string' },
    allowFrom: { type: 'array', items: { type: 'string' } },
    hasOwnKey: {
      type: 'boolean',
      description:
        'Whether a key has been issued to this probe. Never the key — it is sent once, in the ' +
        'welcome that approves it, and no route can read it back.',
    },
    objectId: { type: ['integer', 'null'] },
    note: { type: 'string' },
    firstSeenAt: { type: 'string' },
    lastSeenAt: { type: ['string', 'null'] },
    decidedAt: { type: ['string', 'null'] },
  },
} as const;

const gidParams = {
  type: 'object',
  additionalProperties: false,
  required: ['gid'],
  properties: { gid: { type: 'string', minLength: 1, maxLength: 128 } },
} as const;

/**
 * Which probes this installation trusts (`R-01`).
 *
 * **A probe that has connected is not a probe that may scan.** Everything here is the gap
 * between the two: the queue of machines that have arrived, the act of approving one onto a
 * branch of the tree, and the act of refusing one. A probe waits in `pending` — connected,
 * heartbeating, holding no configuration at all — until somebody decides.
 */
export function probeRoutes(app: FastifyInstance, options: ProbeRoutesOptions): void {
  const { registry } = options;

  app.get(
    '/probes',
    {
      schema: {
        tags: ['probes'],
        summary: 'Every probe this core knows, and what was decided about it',
        description:
          'Includes the ones waiting for approval, which is the list worth opening: a probe in ' +
          '`pending` is connected and doing nothing, on purpose. `lastAddress` is beside each ' +
          'one because "a probe called backup-01 wants in" is not a decision anybody can make ' +
          'and "from 10.4.2.9" is.',
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { status: { type: 'string', enum: ['pending', 'approved', 'revoked'] } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: registrationSchema } },
          },
        },
      },
    },
    async (request: FastifyRequest) => {
      const { status } = request.query as { status?: 'pending' | 'approved' | 'revoked' };
      return { items: await registry.list(status) };
    },
  );

  app.post(
    '/probes/:gid/approve',
    {
      schema: {
        tags: ['probes'],
        summary: 'Approve a probe onto a branch of the tree',
        description:
          'Binds this identity to a probe object. The probe is issued a key of its own at its ' +
          '**next handshake**, not here: approving a machine that is switched off is an ' +
          'ordinary thing to do, and a key delivered in a welcome it never received would lock ' +
          'it out. Nobody ever sees that key — it goes straight to the probe over the ' +
          'authenticated link, so it never passes through a clipboard or a support ticket. A ' +
          'probe that is already connected starts scanning without reconnecting.',
        params: gidParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['objectId'],
          properties: {
            objectId: {
              type: 'integer',
              minimum: 1,
              description: 'The probe object this identity owns from now on.',
            },
            local: {
              type: 'boolean',
              default: false,
              description:
                'Whether this is the probe running beside the core. A local probe cannot be ' +
                'deleted, matching PRTG. Said explicitly rather than guessed: an address proves ' +
                'nothing on a host with several interfaces, and "the first one approved" is ' +
                'wrong for anybody who stood up a remote probe first.',
            },
          },
        },
        response: { 200: registrationSchema },
      },
    },
    async (request: FastifyRequest) => {
      const { gid } = request.params as { gid: string };
      const { objectId, local } = request.body as { objectId: number; local?: boolean };
      return await registry.approve(gid, objectId, { local: local ?? false });
    },
  );

  app.post(
    '/probes/:gid/revoke',
    {
      schema: {
        tags: ['probes'],
        summary: 'Refuse a probe from now on',
        description:
          'The record is kept rather than deleted, so the same identity cannot come back by ' +
          'simply reconnecting and so the log of what was refused survives the decision. The ' +
          'branch is released, because the sensors under it — and their history and their ' +
          'thresholds — should outlive the machine that was scanning them.',
        params: gidParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            note: {
              type: 'string',
              maxLength: 1000,
              default: '',
              description: 'Why, for the operator who finds this months later.',
            },
          },
        },
        response: { 200: registrationSchema },
      },
    },
    async (request: FastifyRequest) => {
      const { gid } = request.params as { gid: string };
      const { note } = (request.body ?? {}) as { note?: string };
      return await registry.revoke(gid, note ?? '');
    },
  );

  app.put(
    '/probes/:gid/allow-from',
    {
      schema: {
        tags: ['probes'],
        summary: 'Narrow where one probe may connect from',
        description:
          'Ranges in the same spellings a discovery takes — `10.0.0.0/24`, `10.0.0.1-50`, a ' +
          'single address — with no size cap, because stating that your probes live in ' +
          '`10.0.0.0/8` is a fact about a network rather than a request to enumerate it. An ' +
          'empty list means anywhere, which is the default: a stolen key is worth much less ' +
          'when it only works from one subnet, and only the operator can say which one.',
        params: gidParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['allowFrom'],
          properties: {
            allowFrom: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 200 } },
          },
        },
        response: { 200: registrationSchema },
      },
    },
    async (request: FastifyRequest) => {
      const { gid } = request.params as { gid: string };
      const { allowFrom } = request.body as { allowFrom: string[] };
      return await registry.setAllowFrom(gid, allowFrom);
    },
  );

  app.delete(
    '/probes/:gid',
    {
      schema: {
        tags: ['probes'],
        summary: 'Forget a probe entirely',
        description:
          'Different from revoking: a forgotten probe that connects again enrols as a stranger ' +
          'and waits in the queue. Use it when the machine is genuinely gone.',
        params: gidParams,
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const { gid } = request.params as { gid: string };
      if (!(await registry.remove(gid))) {
        throw new ProbeRegistryError('PROBE_NOT_FOUND', `there is no probe ${gid}`);
      }
      await reply.code(204).send();
      return reply;
    },
  );
}
