import '@fastify/swagger';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ProbeRegistryError, type ProbeRegistry } from '../../probes/registry.js';
import { actorFor } from '../authentication.js';
import { ADMIN } from '../authorization.js';

export interface ProbeRoutesOptions {
  registry: ProbeRegistry;
}

const registrationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'gid',
    'status',
    'displayName',
    'protocolAcceptedAt',
    'protocolRefusedAt',
    'firstSeenAt',
  ],
  properties: {
    gid: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'approved', 'revoked'] },
    displayName: { type: 'string' },
    agentVersion: { type: 'string' },
    protocolVersion: { type: 'integer' },
    protocolAcceptedAt: {
      type: ['string', 'null'],
      format: 'date-time',
      description:
        'When a handshake this core accepted spoke `protocolVersion` (U-33). `null` beside a ' +
        'version a hello was refused over, and for one recorded before the core kept the time. ' +
        'Not `lastSeenAt`, which a hello refused over its version moves too.',
    },
    protocolRefusedAt: {
      type: ['string', 'null'],
      format: 'date-time',
      description:
        'When a hello was last refused over `protocolVersion` (U-35). `null` beside a version a ' +
        'handshake this core accepted, and for one recorded before the core kept the time. ' +
        'Never set beside `protocolAcceptedAt`. A `protocolVersion` of 0 with this set is a ' +
        'probe that claimed 0 and was refused; with neither time it is a probe that has not ' +
        'connected since the core started recording versions.',
    },
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
    skew: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'explanation'],
      description:
        'What this probe’s protocol version means against this core (R-06). `outdated` is the ' +
        'one worth reading: such a probe connects and heartbeats normally and is refused every ' +
        'feature listed in `missing`, so a probe below protocol 3 looks healthy while scanning ' +
        'nothing at all. `ahead` is a probe newer than this core (P-178): it is admitted and ' +
        'the pair speaks `ownVersion`, so the end to upgrade is this one. `incompatible` is a ' +
        'version this core refuses at the handshake; its `explanation` says whether the last ' +
        'hello was refused over it (`protocolRefusedAt`) or a core with a lower floor accepted ' +
        'it and this one will refuse it at the next (U-35). `unknown` is a 0 with neither time: ' +
        'nothing recorded.',
      properties: {
        // Every kind `describeSkew` returns (`P-313`): the serializer does not check an enum, so
        // a missing one went out anyway while the reference told a client it could not.
        kind: {
          type: 'string',
          enum: ['unknown', 'current', 'outdated', 'ahead', 'incompatible'],
        },
        peerVersion: { type: 'integer' },
        ownVersion: { type: 'integer' },
        missing: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' },
        // The same thing in one sentence, so a caller need not reassemble it.
        explanation: { type: 'string' },
      },
    },
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
      // **An administrator's list, like every decision taken on it** (`A-12`). Approving,
      // revoking and fencing a probe are all `ADMIN`; the queue they are taken from names every
      // probe in the installation, the address each last called from and what it is allowed to
      // call from — infrastructure, and nothing a branch of the tree was ever granted.
      config: ADMIN,
      schema: {
        tags: ['probes'],
        summary: 'Every probe this core knows, and what was decided about it',
        description:
          'Includes the ones waiting for approval, which is the list worth opening: a probe in ' +
          '`pending` is connected and doing nothing, on purpose. `lastAddress` is beside each ' +
          'one because "a probe called backup-01 wants in" is not a decision anybody can make ' +
          'and "from 10.4.2.9" is. `protocolVersion` is what the probe declared at its last ' +
          'handshake that was accepted or was refused over the version itself, and ' +
          '`protocolAcceptedAt` is when an accepted one spoke it: `null` when that handshake ' +
          'was refused, and for a version recorded before the core kept the time. ' +
          '`protocolRefusedAt` is when a hello was last refused over it, the other way round, ' +
          'so a refusal at 0 is not read as nothing recorded. `lastSeenAt` is the last hello ' +
          'that proved it is this probe (its key accepted, not revoked, from an address its ' +
          'filter allows), accepted or refused over its version, so it is not when the version ' +
          'was spoken. `displayName`, `agentVersion` and `lastAddress` are from that hello too: ' +
          'a hello refused before proving its identity changes nothing here, and is in the core ' +
          'log and Core Health `probeHellosUnproven` instead. ' +
          '`skew.kind` is `unknown`, `current`, `outdated`, `ahead` (a probe newer than this ' +
          'core, which is admitted and speaks this core’s version) or `incompatible` (one this ' +
          'core refuses at the handshake).',
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
      config: ADMIN,
      schema: {
        tags: ['probes'],
        summary: 'Approve a probe onto a branch of the tree',
        description:
          'Binds this identity to a probe object. The probe is issued a key of its own at its ' +
          '**next handshake**, not here: approving a machine that is switched off is an ' +
          'ordinary thing to do, and a key delivered in a welcome it never received would lock ' +
          'it out. Nobody ever sees that key — it goes straight to the probe over the ' +
          'authenticated link, so it never passes through a clipboard or a support ticket. A ' +
          'probe that is already connected has its connection closed and comes back on its own ' +
          'retry — about a second — because the handshake is where both the key and the first ' +
          'configuration are issued. It said "starts scanning without reconnecting" until ' +
          '`P-189`, which was not implemented: the session\u2019s approval is fixed at ' +
          'admission, so a probe approved after it connected sat there scanning nothing.',
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
      return await registry.approve(gid, objectId, actorFor(request), { local: local ?? false });
    },
  );

  app.post(
    '/probes/:gid/revoke',
    {
      config: ADMIN,
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
      return await registry.revoke(gid, note ?? '', actorFor(request));
    },
  );

  app.put(
    '/probes/:gid/allow-from',
    {
      config: ADMIN,
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
      return await registry.setAllowFrom(gid, allowFrom, actorFor(request));
    },
  );

  app.delete(
    '/probes/:gid',
    {
      config: ADMIN,
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
      if (!(await registry.remove(gid, actorFor(request)))) {
        throw new ProbeRegistryError('PROBE_NOT_FOUND', `there is no probe ${gid}`);
      }
      await reply.code(204).send();
      return reply;
    },
  );
}
