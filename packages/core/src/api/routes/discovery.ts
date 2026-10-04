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
import { DiscoveryError, runNotFound } from '../../discovery/errors.js';
import { probeFor, requireProbeInView } from '../../discovery/scope.js';
import type { Queryable } from '../../db/pool.js';
import type { DiscoveryService } from '../../discovery/service.js';
import type { ProvisionReport, ProvisionSight } from '../../discovery/provision.js';
import type { Actor } from '../../objects/audit.js';
import type { RediscoveryService, SchedulePatch } from '../../discovery/rediscovery.js';
import { etagFor } from '../preconditions.js';
import {
  COMPUTES,
  onBodyObject,
  onObject,
  onObjectOf,
  onQueryObject,
  reachOf,
  visibilityOf,
} from '../authorization.js';
import { actorFor } from '../authentication.js';

export interface DiscoveryRouteOptions {
  /** For asking whether a probe a caller names is one they can see (`A-77`). */
  db: Queryable;
  discovery: DiscoveryService;
  /** Absent until D-04 is wired; the provision route then does not exist. */
  provision?: (runId: number, actor: Actor, sight: ProvisionSight) => Promise<ProvisionReport>;
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
  /**
   * A run is read with a right on the group it provisions into, as it is cancelled with one
   * (`A-12`). Its hosts are addresses and fingerprints on somebody's network, and a role check
   * handed every run in the installation to an account granted one branch. A run in a group
   * the caller cannot read is not there, in the words an unused id gets (`A-37`).
   */
  const groupOfRun = async (id: number): Promise<number | null> =>
    (await discovery.get(id))?.groupId ?? null;
  const toReadRun = onObjectOf('read', 'this run', groupOfRun, runNotFound);

  app.addSchema(runSchema);

  app.post(
    '/discovery/preview',
    {
      // Parses a range and estimates it. No scan is started and nothing is written.
      config: COMPUTES,
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
      // A discovery run provisions devices and sensors into `groupId`, which makes it a creation
      // under a parent named in the body — the case `onBodyObject` exists for (`G05`). What it
      // provisions is audited as the objects it creates, and starting it is audited as
      // `discovery.started` (`A-20`): an action rather than configuration, recorded as
      // `report.ran` is, because the run row goes with its group and the question does not.
      config: onBodyObject('write', 'groupId'),
      schema: {
        tags: ['discovery'],
        summary: 'Start a discovery run',
        description:
          'Sweeps a range from one probe into one group. The probe is named rather than chosen: ' +
          'discovery is a local-network job, so the probe that can reach 10.0.0.0/24 is the one ' +
          'on that network. It has to be the probe the group is under, and one the caller can ' +
          'read: any other is refused `DISCOVERY_PROBE_INVALID` in the same words, so that a ' +
          'probe above the caller’s branch is answered as an id nobody used (`A-77`). Left out, ' +
          'it is the probe the group is under, which is how a writer granted a branch below a ' +
          'probe they cannot see starts one.',
        body: {
          type: 'object',
          required: ['groupId', 'range'],
          additionalProperties: false,
          properties: {
            groupId: { type: 'integer', minimum: 1 },
            probeId: {
              type: 'integer',
              minimum: 1,
              description:
                'The probe the group is under. Left out, that probe is used; named, it has to be ' +
                'that one and one the caller can read (`A-77`).',
            },
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
        probeId?: number;
        range: string;
        timeoutMs?: number;
        concurrency?: number;
        ratePerSecond?: number;
        level?: DiscoveryLevel;
        snmpCommunity?: string;
        templates?: string[];
      };
      parse(body.range);
      // A probe the caller cannot see is answered as a wrong one, or the right one is an oracle.
      const probeId = await probeFor(
        options.db,
        await visibilityOf(request),
        body.groupId,
        body.probeId,
      );
      const run = await discovery.start({ ...body, probeId }, actorFor(request));
      await reply.code(201).send(run);
      return reply;
    },
  );

  app.get(
    '/discovery/:id',
    {
      config: toReadRun,
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
      if (run === null) throw runNotFound(id);
      return run;
    },
  );

  app.get(
    '/discovery/:id/summary',
    {
      config: toReadRun,
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
            required: [
              'runId',
              'range',
              'status',
              'headline',
              'scanned',
              'found',
              'created',
              'errors',
              'timing',
            ],
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
                required: [
                  'addresses',
                  'swept',
                  'alive',
                  'unreachable',
                  'failed',
                  'identified',
                  'complete',
                ],
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
      if (summary === null) throw runNotFound(id);
      return summary;
    },
  );

  app.get(
    '/discovery/:id/hosts',
    {
      config: toReadRun,
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
      if ((await discovery.get(id)) === null) throw runNotFound(id);
      return { items: await discovery.hosts(id, limit ?? 1_000) };
    },
  );

  app.post(
    '/discovery/:id/cancel',
    {
      // The run belongs to a group, and so does the right to stop it (`G05`).
      config: onObjectOf('write', 'this run', groupOfRun, runNotFound),
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
      const run = await discovery.cancel(id, actorFor(request));
      if (run !== null) return run;
      // A run that exists but has already finished is not an error worth a 404: the operator
      // asked for it to stop and it is stopped. Anything else is genuinely missing.
      const existing = await discovery.get(id);
      if (existing === null) throw runNotFound(id);
      return existing;
    },
  );

  if (options.provision !== undefined) {
    const provision = options.provision;
    app.post(
      '/discovery/:id/provision',
      {
        // This is the route that actually creates the devices, and the group it creates them in
        // is on the run rather than in the request — so the right is resolved by asking the run
        // (`G05`).
        config: onObjectOf('write', 'this run', groupOfRun, runNotFound),
        schema: {
          tags: ['discovery'],
          summary: 'Create the devices and sensors this run found',
          description:
            '**Idempotent.** Devices are matched on address, then reverse name, then short name ' +
            'within the target group, and only sensors that are not already there are created — ' +
            'so running this twice creates nothing the second time. That matters because a ' +
            'discovery is re-run: on a schedule, or by an operator who has configured a ' +
            'credential and wants the sensors it unlocks.\n\n' +
            '**A run whose rule was deleted creates nothing** (`A-41`): the account that wrote ' +
            'the rule vouched for sending the group’s credentials to the addresses it found, and ' +
            'deleting the rule withdraws that. With accounts on, the run is failed with the ' +
            'reason “its rule was deleted”, recorded in the audit log, and this answers 409 ' +
            '`DISCOVERY_RUN_FAILED` with the same sentence. Start a new run to provision those ' +
            'addresses.\n\n' +
            '**Nor does a run whose group has since moved under another probe** (`P-241`): what ' +
            'it found was read from the old probe’s network, and would become devices in the ' +
            'new one’s branch. The run is failed with the reason “its group moved to another ' +
            'probe”, recorded in the audit log, and this answers 409 `DISCOVERY_RUN_FAILED` with ' +
            'that sentence. Start a new run from the group’s new probe.\n\n' +
            '**It answers its caller in their own view** (`A-77`). A host at the address of a ' +
            'device the caller cannot see is reported in `problems` as “a device outside your ' +
            'view already has this address”, with no id and nothing created under the device; ' +
            'a sensor a template names that is already there and hidden is reported the same way ' +
            'and not counted in `sensorsSkipped`; and nothing is added to a device the caller ' +
            'may read and not write. An administrator is answered as before.',
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
        if ((await discovery.get(id)) === null) throw runNotFound(id);
        // The caller, not the address they called from: every object this creates is audited
        // under this actor, and "anonymous" beside a device an administrator provisioned is a
        // record saying nobody did it (`A-20`). And it answers them in their own view: it matches,
        // reports and writes under only the devices they can see and write (`A-77`).
        return provision(id, actorFor(request), {
          visibility: await visibilityOf(request),
          writes: reachOf(request, 'write'),
        });
      },
    );
  }

  app.get(
    '/discovery/:id/problems',
    {
      config: toReadRun,
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
      // Not an empty list: that is the answer for a run that went cleanly (`A-37`).
      if ((await discovery.get(id)) === null) throw runNotFound(id);
      return { items: await discovery.problems(id) };
    },
  );

  app.get(
    '/objects/:id/discovery',
    {
      config: onObject('read'),
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
        // **`snmpCommunity` is deliberately absent** (`P-55`). It is a credential, and CLAUDE.md
        // says a credential is never returned by any API route, to anyone, including
        // administrators. It was declared here, which meant all three responses built from this
        // schema — the list, the 201 from create, and the 200 from the enabled toggle — echoed
        // the stored community back in cleartext.
        //
        // Removing the property is the whole fix rather than the start of one: this schema is
        // `additionalProperties: false`, so Fastify now strips the field on the way out even
        // though the service still carries it, which is exactly what the probe needs it to do.
        // Nothing reads it back. The edit (`D-11`) takes a community without being shown one:
        // absent keeps the stored value, which is how a form that never had it saves.
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
        lastProblem: {
          type: 'string',
          description:
            'Why the last firing started nothing, or empty. A rule whose group has moved under ' +
            'another probe is refused when it fires, and this is where that is said (`A-28`).',
        },
        nextRunAt: { type: ['string', 'null'] },
        description: { type: 'string' },
        version: {
          type: 'integer',
          description: 'What `If-Match` carries back on an edit; also the `ETag` (`D-11`).',
        },
      },
    } as const;

    /**
     * The group a rule provisions into, for the routes addressed by a rule's id (`D-11`).
     *
     * A rule in a group the caller cannot read is not there, in the words an unused id gets: the
     * guard answers both with `noSuchRule`, so trying ids learns nothing about another branch
     * (`A-16`, `A-37`).
     */
    const ruleGroup = onObjectOf(
      'write',
      'this schedule',
      async (id) => (await rediscovery.get(id))?.groupId ?? null,
      noSuchRule,
    );

    app.get(
      '/discovery/schedules',
      {
        // The schedules provisioning into groups the caller can read, and `groupId` has to be
        // one of them (`A-12`).
        config: onQueryObject('read', 'groupId', { optional: true }),
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
        return { items: await rediscovery.list(await visibilityOf(request), groupId) };
      },
    );

    app.post(
      '/discovery/schedules',
      {
        // Same shape as starting a run, and with `autoProvision` it is a standing instruction to
        // keep creating objects in that group (`G05`).
        config: onBodyObject('write', 'groupId'),
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
            required: ['groupId', 'name', 'range', 'cadence'],
            additionalProperties: false,
            properties: {
              groupId: { type: 'integer', minimum: 1 },
              probeId: {
                type: 'integer',
                minimum: 1,
                description:
                  'The probe the group is under. Left out, that probe is used; named, it has to be ' +
                  'that one and one the caller can read (`A-77`).',
              },
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
              level: {
                type: 'string',
                enum: ['ping', 'standard', 'detailed'],
                default: 'standard',
              },
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
        const input = request.body as Omit<
          Parameters<RediscoveryService['create']>[0],
          'probeId'
        > & {
          probeId?: number;
        };
        const probeId = await probeFor(
          options.db,
          await visibilityOf(request),
          input.groupId,
          input.probeId,
        );
        const created = await rediscovery.create({ ...input, probeId }, actorFor(request));
        await reply.code(201).header('ETag', etagFor(created.version)).send(created);
        return reply;
      },
    );

    app.post(
      '/discovery/schedules/:id/enabled',
      {
        // Enabling a schedule with `autoProvision` set is how objects start appearing in a
        // group on their own, so it is guarded on that group (`G05`).
        config: ruleGroup,
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
      async (request: FastifyRequest, reply) => {
        const { id } = request.params as { id: number };
        const { enabled } = request.body as { enabled: boolean };
        const updated = await rediscovery.setEnabled(id, enabled, actorFor(request));
        if (updated === null) throw noSuchRule(id);
        await reply.header('ETag', etagFor(updated.version)).send(updated);
        return reply;
      },
    );

    app.patch(
      '/discovery/schedules/:id',
      {
        // `write` on the rule's group, found through the caller's visibility (`ruleGroup`), and
        // any new probe checked against that group in the service (`A-28`).
        config: ruleGroup,
        schema: {
          tags: ['discovery'],
          summary: 'Change a schedule',
          description:
            '`If-Match` carries the version the edit was made against (`W/"3"`, from the rule’s ' +
            '`version` or the `ETag` of the answer that returned it). Without it the request is ' +
            'refused with 428, and against a version that is no longer current with 412: two ' +
            'people editing one rule must not have the second silently undo the first. Whether ' +
            'it is on has its own route. The group cannot change — a rule in another group is ' +
            'another rule — and the probe must be the one the group is under. `snmpCommunity` ' +
            'left out keeps the stored one, and an empty one clears it; it is never returned. ' +
            'A community stays with where it is sent: an edit that changes `range` or `probeId` ' +
            'and leaves `snmpCommunity` out clears the stored one, and the audit entry says so ' +
            '— send it again with the edit to keep scanning with it. ' +
            'An edit that changes something clears `lastProblem`, and one that changes nothing ' +
            'keeps its version.',
          params: idParams,
          body: {
            type: 'object',
            additionalProperties: false,
            minProperties: 1,
            properties: {
              probeId: { type: 'integer', minimum: 1 },
              name: { type: 'string', minLength: 1, maxLength: 200 },
              range: { type: 'string', minLength: 1, maxLength: 4000 },
              cadence: { type: 'string', enum: ['hourly', 'daily', 'weekly'] },
              cadenceMinute: { type: 'integer', minimum: 0, maximum: 1439 },
              cadenceWeekday: { type: 'integer', minimum: 0, maximum: 6 },
              timezone: { type: ['string', 'null'] },
              level: { type: 'string', enum: ['ping', 'standard', 'detailed'] },
              templates: { type: 'array', items: { type: 'string' } },
              snmpCommunity: { type: 'string', maxLength: 128 },
              timeoutMs: { type: 'integer', minimum: 100, maximum: 60_000 },
              concurrency: { type: 'integer', minimum: 1, maximum: 512 },
              ratePerSecond: { type: 'number', minimum: 0, maximum: 100_000 },
              autoProvision: { type: 'boolean' },
              scheduleId: { type: ['integer', 'null'] },
            },
          },
          response: { 200: scheduleSchema },
        },
      },
      async (request: FastifyRequest, reply) => {
        const { id } = request.params as { id: number };
        const patch = request.body as SchedulePatch;
        // Only a probe the caller names anew: the rule's own is in every read of it (`A-77`).
        const current = patch.probeId === undefined ? null : await rediscovery.get(id);
        if (current !== null && patch.probeId !== undefined && patch.probeId !== current.probeId) {
          await requireProbeInView(
            options.db,
            await visibilityOf(request),
            current.groupId,
            patch.probeId,
          );
        }
        const updated = await rediscovery.update(
          id,
          expectedVersion(request.headers['if-match'], id),
          patch,
          actorFor(request),
        );
        if (updated === null) throw noSuchRule(id);
        await reply.header('ETag', etagFor(updated.version)).send(updated);
        return reply;
      },
    );

    app.delete(
      '/discovery/schedules/:id',
      {
        config: ruleGroup,
        schema: {
          tags: ['discovery'],
          summary: 'Delete a schedule',
          params: idParams,
          response: { 204: { type: 'null' } },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: number };
        if (!(await rediscovery.remove(id, actorFor(request)))) throw noSuchRule(id);
        await reply.code(204).send();
        return reply;
      },
    );
  }
}

/** One answer for a rule that is not there and one the caller cannot see (`A-16`). */
function noSuchRule(id: number): DiscoveryError {
  return new DiscoveryError(
    'DISCOVERY_RUN_NOT_FOUND',
    `there is no rediscovery schedule ${String(id)}`,
    {
      context: { id },
    },
  );
}

/**
 * The version an edit was made against, from `If-Match` (`D-11`) — `W/"3"`, as `etagFor` writes
 * it, or a bare `"3"`. Missing is 428 and not a version is 400, as an object's edit answers.
 */
function expectedVersion(header: string | undefined, id: number): number {
  if (header === undefined || header.trim() === '') {
    throw new DiscoveryError(
      'DISCOVERY_PRECONDITION_REQUIRED',
      'this request requires an If-Match header carrying the version the edit was based on',
      { context: { scheduleId: id, phase: 'precondition' } },
    );
  }
  const match = /^(?:W\/)?"(\d{1,15})"$/.exec(header.trim());
  if (match === null) {
    throw new DiscoveryError(
      'DISCOVERY_SCHEDULE_INVALID',
      `If-Match must be an ETag of the form W/"<version>", got ${header}`,
      { context: { scheduleId: id, phase: 'precondition' } },
    );
  }
  return Number(match[1]);
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
