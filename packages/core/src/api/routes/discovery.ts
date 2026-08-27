// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  DISCOVERY_LEVELS,
  estimateSeconds,
  IpRangeError,
  parseIpRange,
  type DiscoveryLevel,
} from '@ms/shared';
import { DiscoveryError } from '../../discovery/errors.js';
import type { DiscoveryService } from '../../discovery/service.js';
import type { ProvisionReport } from '../../discovery/provision.js';
import type { Actor } from '../../objects/audit.js';
import type { RediscoveryService } from '../../discovery/rediscovery.js';

export interface DiscoveryRouteOptions {
  discovery: DiscoveryService;
  /** Absent until D-04 is wired; the provision route then does not exist. */
  provision?: (runId: number, actor: Actor) => Promise<ProvisionReport>;
  /** Absent until D-07 is wired; the rediscovery routes then do not exist. */
  rediscovery?: RediscoveryService;
}

const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const runSchema = {
  $id: 'ms:discoveryRun',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'groupId', 'probeId', 'range', 'total', 'cursor', 'found', 'failed', 'status'],
  properties: {
    id: { type: 'integer' },
    groupId: { type: 'integer' },
    probeId: { type: 'integer' },
    range: { type: 'string' },
    total: { type: 'integer' },
    cursor: { type: 'integer' },
    found: { type: 'integer' },
    failed: { type: 'integer' },
    status: {
      type: 'string',
      enum: ['queued', 'running', 'identifying', 'done', 'cancelled', 'failed'],
    },
    level: { type: 'string', enum: ['ping', 'standard', 'detailed'] },
    templates: { type: 'array', items: { type: 'string' } },
    identified: { type: 'integer' },
    // `additionalProperties: false` here means a field missing from this list is stripped from
    // the response rather than merely undocumented. `D-10` read a run's `scheduleId` and every
    // run came back without one, so `!== null` was true for all of them and every row on the
    // page was labelled "scheduled" — found by looking at the page, not by any test.
    scheduleId: { type: ['integer', 'null'] },
    devicesCreated: { type: 'integer' },
    devicesMatched: { type: 'integer' },
    sensorsCreated: { type: 'integer' },
    provisionedAt: { type: ['string', 'null'] },
    message: { type: 'string' },
    timeoutMs: { type: 'integer' },
    concurrency: { type: 'integer' },
    ratePerSecond: { type: 'number' },
    createdAt: { type: 'string' },
    startedAt: { type: ['string', 'null'] },
    finishedAt: { type: ['string', 'null'] },
  },
} as const;

/**
 * Discovery runs (`D-01`).
 *
 * **A run is created, watched and cancelled — never edited.** Changing the range of a sweep
 * halfway through would make its cursor mean something different from what it meant when the
 * addresses behind it were swept, and the progress an operator is watching would jump. A
 * different range is a different run, and runs are cheap.
 *
 * `/preview` exists so a form can say "that is 65,534 addresses and about forty minutes" before
 * the operator commits, which is the one piece of advice that stops a mistyped mask becoming a
 * sixteen-million-address sweep. It parses with the same code the run will.
 */
export function discoveryRoutes(app: FastifyInstance, options: DiscoveryRouteOptions): void {
  const { discovery } = options;
  app.addSchema(runSchema);

  app.post(
    '/discovery/preview',
    {
      schema: {
        tags: ['discovery'],
        summary: 'What a range means, and what each level would cost',
        description:
          'Parses a range and estimates every level, so an operator picks one knowing what it ' +
          'costs rather than finding out. The same parser and the same level table the run ' +
          'uses, so a range that previews is a range that will start and an estimate is about ' +
          'the run that actually happens.',
        body: {
          type: 'object',
          required: ['range'],
          additionalProperties: false,
          properties: {
            range: { type: 'string', minLength: 1, maxLength: 4000 },
            timeoutMs: { type: 'integer', minimum: 100, maximum: 60_000, default: 1_000 },
            concurrency: { type: 'integer', minimum: 1, maximum: 512, default: 32 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['range', 'total', 'levels'],
            properties: {
              range: { type: 'string' },
              total: { type: 'integer' },
              levels: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'name', 'description', 'minSeconds', 'maxSeconds', 'ports'],
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    minSeconds: {
                      type: 'integer',
                      description:
                        'If every address answers: the sweep is quick and every host is identified.',
                    },
                    maxSeconds: {
                      type: 'integer',
                      description:
                        'If none do: the sweep pays a full timeout each and there is nothing to identify.',
                    },
                    ports: {
                      type: 'integer',
                      description: 'How many ports each host is asked about.',
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    (request: FastifyRequest) => {
      const body = request.body as { range: string; timeoutMs?: number; concurrency?: number };
      const range = parse(body.range);
      const sweepTimeoutMs = body.timeoutMs ?? 1_000;
      const sweepConcurrency = body.concurrency ?? 32;
      return {
        range: range.text,
        total: range.size,
        levels: DISCOVERY_LEVELS.map((level) => {
          const estimate = estimateSeconds({
            level: level.id,
            addresses: range.size,
            sweepTimeoutMs,
            sweepConcurrency,
            // The bound the service uses when it dispatches identification (`D-02`).
            identifyConcurrency: 8,
          });
          return {
            id: level.id,
            name: level.name,
            description: level.description,
            minSeconds: estimate.min,
            maxSeconds: estimate.max,
            ports: level.ports.length,
          };
        }),
      };
    },
  );

  app.post(
    '/discovery',
    {
      schema: {
        tags: ['discovery'],
        summary: 'Start a discovery run',
        description:
          'Sweeps a range from one probe into one group. The probe is named rather than chosen: ' +
          'discovery is a local-network job, so the probe that can reach 10.0.0.0/24 is the one ' +
          'on that network.',
        body: {
          type: 'object',
          required: ['groupId', 'probeId', 'range'],
          additionalProperties: false,
          properties: {
            groupId: { type: 'integer', minimum: 1 },
            probeId: { type: 'integer', minimum: 1 },
            range: { type: 'string', minLength: 1, maxLength: 4000 },
            timeoutMs: { type: 'integer', minimum: 100, maximum: 60_000 },
            concurrency: { type: 'integer', minimum: 1, maximum: 512 },
            // 0 means the concurrency bound is the only limit. A rate is what an operator
            // reaches for on a network where a burst of pings sets off an intrusion detector.
            ratePerSecond: { type: 'number', minimum: 0, maximum: 100_000 },
            level: {
              type: 'string',
              enum: ['ping', 'standard', 'detailed'],
              default: 'standard',
              description:
                'How hard to look. `POST /discovery/preview` reports what each one costs on ' +
                'this range, which is worth reading before starting a detailed sweep of a /16.',
            },
            templates: {
              type: 'array',
              maxItems: 100,
              default: [],
              items: { type: 'string', minLength: 1, maxLength: 100 },
              description:
                'Template ids this run may use. Empty means all of them. A filter rather than ' +
                'a fourth level, because “detailed, but only these templates” is a thing ' +
                'somebody wants and a level could not express it.',
            },
            snmpCommunity: {
              type: 'string',
              maxLength: 128,
              default: '',
              description:
                'Tried read-only against every host during identification, and skipped when ' +
                'empty. `sysDescr` and `sysObjectID` are the two most informative things a ' +
                'device will tell you, and this is the only credential identification has: it ' +
                'runs before anybody has told the system anything about these hosts, so v3 — ' +
                'which needs a username and a passphrase per device — is not available to it.',
            },
          },
        },
        response: { 201: { $ref: 'ms:discoveryRun' } },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        groupId: number;
        probeId: number;
        range: string;
        timeoutMs?: number;
        concurrency?: number;
        ratePerSecond?: number;
        level?: DiscoveryLevel;
        snmpCommunity?: string;
        templates?: string[];
      };
      parse(body.range);
      const run = await discovery.start(body);
      await reply.code(201).send(run);
      return reply;
    },
  );

  app.get(
    '/discovery/:id',
    {
      schema: {
        tags: ['discovery'],
        summary: 'A run and how far it has got',
        params: idParams,
        response: { 200: { $ref: 'ms:discoveryRun' } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: number };
      const run = await discovery.get(id);
      if (run === null) throw notFound(id);
      return run;
    },
  );

  app.get(
    '/discovery/:id/summary',
    {
      schema: {
        tags: ['discovery'],
        summary: 'What a run did — scanned, found, created, errors',
        description:
          'Derived from the run and its hosts rather than stored, so it cannot drift from what ' +
          'happened and a second provisioning pass updates it for free. `headline` is one ' +
          'sentence for the top of a page; everything under it is the same story precisely. ' +
          'The errors are here rather than behind a second request, because a run that created ' +
          'eleven devices and could not create two is exactly the case where somebody stops ' +
          'reading at the good number.',
        params: idParams,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['runId', 'range', 'status', 'headline', 'scanned', 'found', 'created', 'errors', 'timing'],
            properties: {
              runId: { type: 'integer' },
              groupId: { type: 'integer' },
              probeId: { type: 'integer' },
              scheduleId: {
                type: ['integer', 'null'],
                description:
                  'The rediscovery schedule that started it (`D-07`), or null for a run ' +
                  'somebody started. What tells an operator where a run they did not start ' +
                  'came from.',
              },
              range: { type: 'string' },
              level: { type: 'string' },
              status: { type: 'string' },
              headline: { type: 'string' },
              scanned: {
                type: 'object',
                additionalProperties: false,
                required: ['addresses', 'swept', 'alive', 'unreachable', 'failed', 'identified', 'complete'],
                properties: {
                  addresses: { type: 'integer' },
                  swept: { type: 'integer' },
                  alive: { type: 'integer' },
                  unreachable: { type: 'integer' },
                  failed: { type: 'integer' },
                  identified: { type: 'integer' },
                  complete: { type: 'boolean' },
                },
              },
              found: {
                type: 'object',
                additionalProperties: false,
                required: ['byKind', 'byVendor'],
                properties: {
                  byKind: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['kind', 'count'],
                      properties: {
                        // `unidentified` is not a `DeviceKind`: it is a host identification never
                        // looked at, which is a different answer from the classifier's `unknown`.
                        kind: { type: 'string' },
                        count: { type: 'integer' },
                      },
                    },
                  },
                  byVendor: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['vendor', 'count'],
                      properties: { vendor: { type: 'string' }, count: { type: 'integer' } },
                    },
                  },
                },
              },
              created: {
                type: 'object',
                additionalProperties: false,
                required: ['devices', 'matched', 'sensors'],
                properties: {
                  devices: { type: 'integer' },
                  matched: { type: 'integer' },
                  sensors: { type: 'integer' },
                  provisionedAt: { type: ['string', 'null'] },
                },
              },
              errors: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['address', 'problem'],
                  properties: { address: { type: 'string' }, problem: { type: 'string' } },
                },
              },
              timing: {
                type: 'object',
                additionalProperties: false,
                required: ['createdAt'],
                properties: {
                  createdAt: { type: 'string' },
                  startedAt: { type: ['string', 'null'] },
                  finishedAt: { type: ['string', 'null'] },
                  durationMs: { type: ['integer', 'null'] },
                  addressesPerSecond: { type: ['number', 'null'] },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: number };
      const summary = await discovery.summary(id);
      if (summary === null) throw notFound(id);
      return summary;
    },
  );

  app.get(
    '/discovery/:id/hosts',
    {
      schema: {
        tags: ['discovery'],
        summary: 'The addresses a run found alive',
        description:
          'In address order rather than the order they answered, because an operator reading a ' +
          'list of them is looking for gaps.',
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 65_536, default: 1_000 } },
        },
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
                  required: ['address'],
                  properties: {
                    address: { type: 'string' },
                    rttMs: { type: ['number', 'null'] },
                    // Null until identification has run, and for a run at `level: 'ping'`. Null
                    // rather than absent: "not identified yet" is a state a client renders, and
                    // a missing key is indistinguishable from a client that did not ask.
                    fingerprint: { type: ['object', 'null'], additionalProperties: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: number };
      const { limit } = request.query as { limit?: number };
      if ((await discovery.get(id)) === null) throw notFound(id);
      return { items: await discovery.hosts(id, limit ?? 1_000) };
    },
  );

  app.post(
    '/discovery/:id/cancel',
    {
      schema: {
        tags: ['discovery'],
        summary: 'Stop a run',
        description:
          'Recorded immediately and sent to the probe as well, so a cancel works even while the ' +
          'probe is disconnected — otherwise the sweep would resume the moment it came back.',
        params: idParams,
        response: { 200: { $ref: 'ms:discoveryRun' } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: number };
      const run = await discovery.cancel(id);
      if (run !== null) return run;
      // A run that exists but has already finished is not an error worth a 404: the operator
      // asked for it to stop and it is stopped. Anything else is genuinely missing.
      const existing = await discovery.get(id);
      if (existing === null) throw notFound(id);
      return existing;
    },
  );

  if (options.provision !== undefined) {
    const provision = options.provision;
    app.post(
      '/discovery/:id/provision',
      {
        schema: {
          tags: ['discovery'],
          summary: 'Create the devices and sensors this run found',
          description:
            '**Idempotent.** Devices are matched on address, then reverse name, then short name ' +
            'within the target group, and only sensors that are not already there are created — ' +
            'so running this twice creates nothing the second time. That matters because a ' +
            'discovery is re-run: on a schedule, or by an operator who has configured a ' +
            'credential and wants the sensors it unlocks.',
          params: idParams,
          response: {
            200: {
              type: 'object',
              additionalProperties: false,
              required: ['devicesCreated', 'matched', 'sensorsCreated', 'sensorsSkipped'],
              properties: {
                devicesCreated: { type: 'integer' },
                matched: { type: 'integer', description: 'Devices that already existed.' },
                sensorsCreated: { type: 'integer' },
                sensorsSkipped: {
                  type: 'integer',
                  description: 'Sensors a template named that were already there.',
                },
                mastersSet: {
                  type: 'integer',
                  description:
                    'Devices whose reachability sensor became their master object, so one ' +
                    'unreachable host is one alarm rather than a device’s worth.',
                },
                problems: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['address', 'problem'],
                    properties: { address: { type: 'string' }, problem: { type: 'string' } },
                  },
                },
                devices: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['address', 'deviceId', 'created'],
                    properties: {
                      address: { type: 'string' },
                      deviceId: { type: 'integer' },
                      created: { type: 'boolean' },
                      sensors: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      async (request: FastifyRequest) => {
        const { id } = request.params as { id: number };
        if ((await discovery.get(id)) === null) throw notFound(id);
        return provision(id, { kind: 'anonymous', remoteAddress: request.ip });
      },
    );
  }

  app.get(
    '/discovery/:id/problems',
    {
      schema: {
        tags: ['discovery'],
        summary: 'What a run could not create, and why',
        params: idParams,
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
                  required: ['address', 'problem'],
                  properties: { address: { type: 'string' }, problem: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest) => {
      const { id } = request.params as { id: number };
      return { items: await discovery.problems(id) };
    },
  );

  app.get(
    '/objects/:id/discovery',
    {
      schema: {
        tags: ['discovery'],
        summary: 'What this group has been discovering, newest first',
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: { $ref: 'ms:discoveryRun' } } },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: number };
      const { limit } = request.query as { limit?: number };
      return { items: await discovery.list(id, limit ?? 25) };
    },
  );

  if (options.rediscovery !== undefined) {
    // Under `/discovery`, like everything else here, and `schedules` rather than `rediscovery`
    // because it is the resource's name and the prefix already says which kind. It sits beside
    // `/discovery/:id`, whose `:id` is a run: a static segment wins over a parametric one in
    // Fastify's router, so the two cannot collide however they are ordered here. **Not `M-09`'s
    // `/schedules`** — those are weekly windows for pausing sensors, and one of them may be
    // attached to one of these as a permission window, which is the only relation they have.
    const rediscovery = options.rediscovery;
    const scheduleSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'groupId', 'name', 'enabled', 'range', 'cadence', 'description'],
      properties: {
        id: { type: 'integer' },
        groupId: { type: 'integer' },
        probeId: { type: 'integer' },
        name: { type: 'string' },
        enabled: { type: 'boolean' },
        range: { type: 'string' },
        level: { type: 'string' },
        templates: { type: 'array', items: { type: 'string' } },
        snmpCommunity: { type: 'string' },
        timeoutMs: { type: 'integer' },
        concurrency: { type: 'integer' },
        ratePerSecond: { type: 'number' },
        cadence: { type: 'string' },
        cadenceMinute: { type: 'integer' },
        cadenceWeekday: { type: 'integer' },
        timezone: { type: ['string', 'null'] },
        autoProvision: { type: 'boolean' },
        scheduleId: { type: ['integer', 'null'] },
        lastRunAt: { type: ['string', 'null'] },
        lastRunId: { type: ['integer', 'null'] },
        nextRunAt: { type: ['string', 'null'] },
        description: { type: 'string' },
      },
    } as const;

    app.get(
      '/discovery/schedules',
      {
        schema: {
          tags: ['discovery'],
          summary: 'Rediscovery schedules',
          description:
            'Empty on almost every installation, because there is no schedule until somebody ' +
            'creates one and a new one is created **disabled**. Surprise objects are a support ' +
            'burden, and a monitoring system that invents devices on its own is one an operator ' +
            'stops trusting.',
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: { groupId: { type: 'integer', minimum: 1 } },
          },
          response: {
            200: {
              type: 'object',
              additionalProperties: false,
              required: ['items'],
              properties: { items: { type: 'array', items: scheduleSchema } },
            },
          },
        },
      },
      async (request: FastifyRequest) => {
        const { groupId } = request.query as { groupId?: number };
        return { items: await rediscovery.list(groupId) };
      },
    );

    app.post(
      '/discovery/schedules',
      {
        schema: {
          tags: ['discovery'],
          summary: 'Create a rediscovery schedule',
          description:
            'Created **disabled** unless `enabled` says otherwise, and with `autoProvision` off: ' +
            'a rediscovery then sweeps and identifies, and an operator reviews the plan at ' +
            '`GET /discovery/:id/plan` before anything is created. Turning `autoProvision` on is ' +
            'safe because provisioning is idempotent — it creates what has appeared since and ' +
            'nothing else.',
          body: {
            type: 'object',
            required: ['groupId', 'probeId', 'name', 'range', 'cadence'],
            additionalProperties: false,
            properties: {
              groupId: { type: 'integer', minimum: 1 },
              probeId: { type: 'integer', minimum: 1 },
              name: { type: 'string', minLength: 1, maxLength: 200 },
              range: { type: 'string', minLength: 1, maxLength: 4000 },
              cadence: { type: 'string', enum: ['hourly', 'daily', 'weekly'] },
              cadenceMinute: {
                type: 'integer',
                minimum: 0,
                maximum: 1439,
                default: 0,
                description:
                  'Minutes past the hour for an hourly cadence, past midnight for the others.',
              },
              cadenceWeekday: {
                type: 'integer',
                minimum: 0,
                maximum: 6,
                default: 0,
                description: '0 is Monday. Read only for a weekly cadence.',
              },
              timezone: {
                type: ['string', 'null'],
                default: null,
                description:
                  'A cadence is a statement about local time — 02:30 has to be 02:30 in both ' +
                  'halves of the year — so it is stored as one. Null is the core’s own zone.',
              },
              level: { type: 'string', enum: ['ping', 'standard', 'detailed'], default: 'standard' },
              templates: { type: 'array', items: { type: 'string' }, default: [] },
              snmpCommunity: { type: 'string', maxLength: 128, default: '' },
              timeoutMs: { type: 'integer', minimum: 100, maximum: 60_000, default: 1_000 },
              concurrency: { type: 'integer', minimum: 1, maximum: 512, default: 32 },
              ratePerSecond: { type: 'number', minimum: 0, maximum: 100_000, default: 0 },
              autoProvision: { type: 'boolean', default: false },
              scheduleId: {
                type: ['integer', 'null'],
                default: null,
                description:
                  'A schedule (`M-09`) used as a *permission window*: “weekly, but not during ' +
                  'the change freeze”. It answers a different question from the cadence — is it ' +
                  'allowed now, versus when is it next due — which is why both exist.',
              },
              enabled: { type: 'boolean', default: false },
            },
          },
          response: { 201: scheduleSchema },
        },
      },
      async (request, reply) => {
        const created = await rediscovery.create(
          request.body as Parameters<RediscoveryService['create']>[0],
        );
        await reply.code(201).send(created);
        return reply;
      },
    );

    app.post(
      '/discovery/schedules/:id/enabled',
      {
        schema: {
          tags: ['discovery'],
          summary: 'Turn a schedule on or off',
          description:
            'Enabling computes the next run; disabling clears it, so a schedule that is off ' +
            'cannot be found by the sweep even if something else went wrong.',
          params: idParams,
          body: {
            type: 'object',
            required: ['enabled'],
            additionalProperties: false,
            properties: { enabled: { type: 'boolean' } },
          },
          response: { 200: scheduleSchema },
        },
      },
      async (request: FastifyRequest) => {
        const { id } = request.params as { id: number };
        const { enabled } = request.body as { enabled: boolean };
        const updated = await rediscovery.setEnabled(id, enabled);
        if (updated === null) {
          throw new DiscoveryError('DISCOVERY_RUN_NOT_FOUND', `there is no rediscovery schedule ${String(id)}`, {
            context: { id },
          });
        }
        return updated;
      },
    );

    app.delete(
      '/discovery/schedules/:id',
      {
        schema: {
          tags: ['discovery'],
          summary: 'Delete a schedule',
          params: idParams,
          response: { 204: { type: 'null' } },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: number };
        if (!(await rediscovery.remove(id))) {
          throw new DiscoveryError('DISCOVERY_RUN_NOT_FOUND', `there is no rediscovery schedule ${String(id)}`, {
            context: { id },
          });
        }
        await reply.code(204).send();
        return reply;
      },
    );
  }
}

/** The parser's own sentence reaches the operator, rather than "invalid range". */
function parse(text: string): ReturnType<typeof parseIpRange> {
  try {
    return parseIpRange(text);
  } catch (error) {
    if (error instanceof IpRangeError) {
      throw new DiscoveryError('DISCOVERY_RANGE_INVALID', error.message, {
        context: { range: text },
      });
    }
    throw error;
  }
}

function notFound(id: number): DiscoveryError {
  return new DiscoveryError('DISCOVERY_RUN_NOT_FOUND', `there is no discovery run ${String(id)}`, {
    context: { id },
  });
}
