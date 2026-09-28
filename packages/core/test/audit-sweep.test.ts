import { PROTOCOL_VERSION } from '@ms/shared';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import * as OTPAuth from 'otpauth';
import { ApiServer } from '../src/api/server.js';
import { AccessService } from '../src/auth/access.js';
import { AccountService } from '../src/auth/accounts.js';
import { GroupService } from '../src/auth/groups.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { SessionService } from '../src/auth/sessions.js';
import { TokenService } from '../src/auth/tokens.js';
import { TotpService } from '../src/auth/totp.js';
import { AuditRepository, DatabaseAuditSink } from '../src/audit/store.js';
import { TriggerService } from '../src/triggers/service.js';
import { TemplateService } from '../src/notifications/templates.js';
import { MessageContextLoader } from '../src/notifications/context.js';
import { ScheduleService } from '../src/schedules/service.js';
import { HistoryService } from '../src/timeseries/history.js';
import { DiscoveryService } from '../src/discovery/service.js';
import { RediscoveryService } from '../src/discovery/rediscovery.js';
import { DeviceTemplateCatalogue } from '../src/device-templates/catalogue.js';
import { ProbeRegistry } from '../src/probes/registry.js';
import { ProbeQueryService } from '../src/probes/queries.js';
import { ProbeConfigService } from '../src/probes/config.js';
import { InheritanceResolver } from '../src/settings/inheritance.js';
import { NotificationTester } from '../src/notifications/test-send.js';
import { MapRepository } from '../src/maps/repository.js';
import { MapResolver } from '../src/maps/resolver.js';
import { MapService } from '../src/maps/service.js';
import { LibraryRepository } from '../src/libraries/repository.js';
import { LibraryService } from '../src/libraries/service.js';
import { ReportRepository } from '../src/reports/repository.js';
import { ReportService } from '../src/reports/service.js';
import { ReportContext } from '../src/reports/context.js';
import { ReportRenderer } from '../src/reports/render.js';
import { ReportRunner, ReportRunRepository } from '../src/reports/runs.js';
import { ReportOutputRepository } from '../src/reports/delivery.js';
import { ReportFormatter } from '../src/reports/formatter.js';
import { writeRuntimes, writeStateHistory } from '../src/state/runtime.js';
import type { Database } from '../src/db/pool.js';
import type { Actor } from '../src/objects/audit.js';
import {
  createScratchDatabase,
  databaseAvailable,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, silent, testActor, type Harness } from './support/tree.js';
import { testCatalogue } from './support/sensor-types.js';

/**
 * Every change the API makes is in the audit log, or says in its own source why not (`A-17`).
 *
 * **Derived, the way `A-10`'s sweep is derived.** The routes come from `server.routes`, not from a
 * list in this file, so a mutating route added tomorrow is in the sweep by existing. What this
 * file does hold is one *fixture* per route — how to call it so that it succeeds — because no
 * derivation can invent a valid map id or a sensor in the Down state. A route with no fixture
 * fails here by name, so the table cannot fall behind: the route that nobody wrote a fixture for
 * is the route nobody proved audits anything.
 *
 * **A route answers for itself when it writes nothing**, beside its handler: `notAudited` for
 * what is not configuration (a session, a test send), `auditGap` for what should be audited and
 * is not yet, owned by a ticket that removes the declaration. Those are read back here and held
 * to having a reason — and are the only way out of the sweep.
 *
 * **Redaction is swept too.** A secret is planted through the credentials route, and no row this
 * file causes may contain it (`S-10`, `A-10`).
 */

const available = await databaseAvailable();

const PLANTED_SECRET = 'sweep-planted-community-7f3a';

/** A request that should succeed and leave at least one audit row. */
interface Call {
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
}

/** Somebody other than the sweeper, for the routes that change the account making the call. */
interface Person {
  readonly id: number;
  readonly login: string;
  readonly password: string;
}

/** The ids and helpers a fixture draws on. Each fixture makes what it will change, fresh. */
interface Kit {
  readonly probeId: number;
  readonly groupId: number;
  readonly teamId: number;
  readonly cookie: string;
  readonly name: (prefix: string) => string;
  readonly group: (parentId?: number) => Promise<number>;
  readonly pingSensor: () => Promise<number>;
  readonly downSensor: () => Promise<number>;
  /** A probe identity that has connected and is waiting in the queue, by gid. */
  readonly pendingProbe: () => Promise<string>;
  /** A probe object nothing is bound to yet, for an approval to bind one to. */
  readonly probeObject: () => Promise<number>;
  readonly post: (url: string, payload: unknown) => Promise<{ id: number; version: number }>;
  /** A fresh account, and a user group it can be put in (`A-18`). */
  readonly person: () => Promise<Person>;
  readonly userGroup: () => Promise<number>;
  readonly join: (groupId: number, userId: number) => Promise<void>;
  /** A session for somebody, and a POST made in it, for the routes that act on their caller. */
  readonly signIn: (person: Person) => Promise<string>;
  readonly as: <T>(cookie: string, url: string, payload?: unknown) => Promise<T>;
  readonly totpCode: (secret: string) => string;
  /** Everything a fixture handled that signs somebody in; no audit row may contain any of it. */
  readonly planted: string[];
}

type Fixture = (kit: Kit) => Promise<Call>;

/** A 24-byte PNG header: all `readImage` reads, and all a background needs. */
function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const id = (value: number): string => String(value);

/**
 * How to make each audited route succeed, keyed as `server.routes` spells it.
 *
 * Grouped by module. Each one makes its own subject rather than sharing one, so a delete here
 * cannot take away what a later fixture was counting on.
 */
const FIXTURES: Record<string, Fixture> = {
  // ------------------------------------------------------------------------------- objects
  'POST /api/v1/objects': (k) =>
    Promise.resolve({
      url: '/api/v1/objects',
      payload: { kind: 'group', parentId: k.probeId, name: k.name('created') },
    }),
  'POST /api/v1/objects/tree': (k) =>
    Promise.resolve({
      url: '/api/v1/objects/tree',
      payload: { parentId: k.probeId, nodes: [{ kind: 'group', name: k.name('tree') }] },
    }),
  'PATCH /api/v1/objects/:id': async (k) => ({
    url: `/api/v1/objects/${id(await k.group())}`,
    headers: { 'if-match': 'W/"1"' },
    payload: { kind: 'group', name: k.name('renamed') },
  }),
  'DELETE /api/v1/objects/:id': async (k) => ({ url: `/api/v1/objects/${id(await k.group())}` }),
  'POST /api/v1/objects/:id/order': async (k) => {
    const parent = await k.group();
    const first = await k.group(parent);
    await k.group(parent);
    return { url: `/api/v1/objects/${id(first)}/order`, payload: { move: 'down' } };
  },
  'POST /api/v1/objects/:id/move': async (k) => ({
    url: `/api/v1/objects/${id(await k.group())}/move`,
    payload: { targetParentId: await k.group() },
  }),
  'POST /api/v1/objects/:id/clone': async (k) => ({
    url: `/api/v1/objects/${id(await k.group())}/clone`,
    payload: { targetParentId: k.probeId, name: k.name('clone') },
  }),
  'POST /api/v1/objects/bulk': async (k) => ({
    url: '/api/v1/objects/bulk',
    payload: { ids: [await k.group()], operation: 'pause', minutes: 5 },
  }),
  'PATCH /api/v1/objects/:id/channels/:key': async (k) => ({
    url: `/api/v1/objects/${id(await k.pingSensor())}/channels/rtt`,
    payload: { limits: { upperError: 500 } },
  }),
  'POST /api/v1/objects/:id/pause': async (k) => ({
    url: `/api/v1/objects/${id(await k.group())}/pause`,
    payload: { minutes: 5 },
  }),
  'DELETE /api/v1/objects/:id/pause': async (k) => {
    const target = await k.group();
    await k.post(`/api/v1/objects/${id(target)}/pause`, { minutes: 5 });
    return { url: `/api/v1/objects/${id(target)}/pause` };
  },
  'POST /api/v1/objects/:id/acknowledge': async (k) => ({
    url: `/api/v1/objects/${id(await k.downSensor())}/acknowledge`,
    payload: { message: 'looking into it' },
  }),
  'DELETE /api/v1/objects/:id/acknowledge': async (k) => {
    const sensor = await k.downSensor();
    await k.post(`/api/v1/objects/${id(sensor)}/acknowledge`, { message: 'looking' });
    return { url: `/api/v1/objects/${id(sensor)}/acknowledge` };
  },
  'POST /api/v1/objects/:id/simulate-error': async (k) => ({
    url: `/api/v1/objects/${id(await k.pingSensor())}/simulate-error`,
    payload: { message: 'drill' },
  }),
  'DELETE /api/v1/objects/:id/simulate-error': async (k) => {
    const sensor = await k.pingSensor();
    await k.post(`/api/v1/objects/${id(sensor)}/simulate-error`, { message: 'drill' });
    return { url: `/api/v1/objects/${id(sensor)}/simulate-error` };
  },
  'PUT /api/v1/objects/:id/dependency': async (k) => ({
    url: `/api/v1/objects/${id(await k.pingSensor())}/dependency`,
    payload: { mode: 'none' },
  }),
  'PUT /api/v1/objects/:id/settings/:key': async (k) => ({
    url: `/api/v1/objects/${id(await k.group())}/settings/scan.intervalSeconds`,
    payload: { value: 300 },
  }),
  'DELETE /api/v1/objects/:id/settings/:key': async (k) => {
    const target = await k.group();
    const url = `/api/v1/objects/${id(target)}/settings/scan.intervalSeconds`;
    await k.post(url, { value: 300 }).catch(() => undefined);
    return { url };
  },
  'PUT /api/v1/objects/:id/credentials/:kind': async (k) => ({
    url: `/api/v1/objects/${id(await k.group())}/credentials/snmp`,
    payload: { values: { community: PLANTED_SECRET } },
  }),
  'DELETE /api/v1/objects/:id/credentials/:kind': async (k) => {
    const target = await k.group();
    const url = `/api/v1/objects/${id(target)}/credentials/snmp`;
    await k.post(url, { values: { community: PLANTED_SECRET } }).catch(() => undefined);
    return { url };
  },

  // -------------------------------------------------------------------------------- grants
  'PUT /api/v1/objects/:id/access/:groupId': async (k) => ({
    url: `/api/v1/objects/${id(await k.group())}/access/${id(k.teamId)}`,
    payload: { right: 'read' },
  }),
  'DELETE /api/v1/objects/:id/access/:groupId': async (k) => {
    const url = `/api/v1/objects/${id(await k.group())}/access/${id(k.teamId)}`;
    await k.post(url, { right: 'read' });
    return { url };
  },

  // ---------------------------------------------------------------------------------- maps
  'POST /api/v1/maps': (k) =>
    Promise.resolve({ url: '/api/v1/maps', payload: { name: k.name('map') } }),
  'PATCH /api/v1/maps/:id': async (k) => {
    const map = await k.post('/api/v1/maps', { name: k.name('map') });
    return {
      url: `/api/v1/maps/${id(map.id)}`,
      headers: { 'if-match': String(map.version) },
      payload: { priority: 5 },
    };
  },
  'DELETE /api/v1/maps/:id': async (k) => ({
    url: `/api/v1/maps/${id((await k.post('/api/v1/maps', { name: k.name('map') })).id)}`,
  }),
  'POST /api/v1/maps/:id/shares': async (k) => ({
    url: `/api/v1/maps/${id((await k.post('/api/v1/maps', { name: k.name('map') })).id)}/shares`,
    payload: { label: 'wall', expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
  }),
  'DELETE /api/v1/maps/:id/shares/:shareId': async (k) => {
    const map = await k.post('/api/v1/maps', { name: k.name('map') });
    const made = (await k.post(`/api/v1/maps/${id(map.id)}/shares`, {
      label: 'wall',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    })) as unknown as { share: { id: number } };
    return { url: `/api/v1/maps/${id(map.id)}/shares/${id(made.share.id)}` };
  },
  'POST /api/v1/maps/:id/background': async (k) => ({
    url: `/api/v1/maps/${id((await k.post('/api/v1/maps', { name: k.name('map') })).id)}/background`,
    headers: { 'content-type': 'image/png' },
    payload: png(64, 48),
  }),
  'DELETE /api/v1/maps/:id/background': async (k) => {
    const map = await k.post('/api/v1/maps', { name: k.name('map') });
    await k.post(`/api/v1/maps/${id(map.id)}/background`, png(64, 48));
    return { url: `/api/v1/maps/${id(map.id)}/background` };
  },
  'PUT /api/v1/maps/:id/access/:groupId': async (k) => ({
    url: `/api/v1/maps/${id((await k.post('/api/v1/maps', { name: k.name('map') })).id)}/access/${id(k.teamId)}`,
    payload: { right: 'read' },
  }),
  'DELETE /api/v1/maps/:id/access/:groupId': async (k) => {
    const map = await k.post('/api/v1/maps', { name: k.name('map') });
    const url = `/api/v1/maps/${id(map.id)}/access/${id(k.teamId)}`;
    await k.post(url, { right: 'read' });
    return { url };
  },

  // ------------------------------------------------------------------------------- reports
  'POST /api/v1/reports': (k) =>
    Promise.resolve({
      url: '/api/v1/reports',
      payload: { name: k.name('report'), kind: 'table_only' },
    }),
  'PATCH /api/v1/reports/:id': async (k) => {
    const report = await k.post('/api/v1/reports', { name: k.name('report'), kind: 'table_only' });
    return {
      url: `/api/v1/reports/${id(report.id)}`,
      headers: { 'if-match': String(report.version) },
      payload: { description: 'edited' },
    };
  },
  'DELETE /api/v1/reports/:id': async (k) => ({
    url: `/api/v1/reports/${id((await k.post('/api/v1/reports', { name: k.name('report'), kind: 'table_only' })).id)}`,
  }),
  'POST /api/v1/reports/:id/runs': async (k) => ({
    url: `/api/v1/reports/${id((await k.post('/api/v1/reports', { name: k.name('report'), kind: 'table_only' })).id)}/runs`,
    payload: {},
  }),
  'PUT /api/v1/reports/:id/access/:groupId': async (k) => ({
    url: `/api/v1/reports/${id((await k.post('/api/v1/reports', { name: k.name('report'), kind: 'table_only' })).id)}/access/${id(k.teamId)}`,
    payload: { right: 'read' },
  }),
  'DELETE /api/v1/reports/:id/access/:groupId': async (k) => {
    const report = await k.post('/api/v1/reports', { name: k.name('report'), kind: 'table_only' });
    const url = `/api/v1/reports/${id(report.id)}/access/${id(k.teamId)}`;
    await k.post(url, { right: 'read' });
    return { url };
  },

  // ----------------------------------------------------------------------------- libraries
  'POST /api/v1/libraries': (k) =>
    Promise.resolve({
      url: '/api/v1/libraries',
      payload: { name: k.name('library') },
    }),
  'PATCH /api/v1/libraries/:id': async (k) => {
    const library = await k.post('/api/v1/libraries', { name: k.name('library') });
    return {
      url: `/api/v1/libraries/${id(library.id)}`,
      headers: { 'if-match': String(library.version) },
      payload: { priority: 5 },
    };
  },
  'DELETE /api/v1/libraries/:id': async (k) => ({
    url: `/api/v1/libraries/${id((await k.post('/api/v1/libraries', { name: k.name('library') })).id)}`,
  }),
  'PUT /api/v1/libraries/:id/access/:groupId': async (k) => ({
    url: `/api/v1/libraries/${id((await k.post('/api/v1/libraries', { name: k.name('library') })).id)}/access/${id(k.teamId)}`,
    payload: { right: 'read' },
  }),
  'DELETE /api/v1/libraries/:id/access/:groupId': async (k) => {
    const library = await k.post('/api/v1/libraries', { name: k.name('library') });
    const url = `/api/v1/libraries/${id(library.id)}/access/${id(k.teamId)}`;
    await k.post(url, { right: 'read' });
    return { url };
  },

  // ----------------------------------------------------------------------------- schedules
  'POST /api/v1/schedules': (k) =>
    Promise.resolve({
      url: '/api/v1/schedules',
      payload: { name: k.name('schedule'), periods: 'mo:09:00-mo:17:00' },
    }),
  'PUT /api/v1/schedules/:id': async (k) => {
    const schedule = await k.post('/api/v1/schedules', {
      name: k.name('schedule'),
      periods: 'mo:09:00-mo:17:00',
    });
    return {
      url: `/api/v1/schedules/${id(schedule.id)}`,
      payload: { name: k.name('schedule'), periods: 'tu:09:00-tu:17:00' },
    };
  },
  'DELETE /api/v1/schedules/:id': async (k) => ({
    url: `/api/v1/schedules/${id((await k.post('/api/v1/schedules', { name: k.name('schedule'), periods: 'mo:09:00-mo:17:00' })).id)}`,
  }),

  // -------------------------------------------------------------------- triggers, templates
  'POST /api/v1/objects/:id/triggers': async (k) => ({
    url: `/api/v1/objects/${id(await k.pingSensor())}/triggers`,
    payload: { kind: 'state', settings: { state: 'down' }, enabled: true },
  }),
  'PUT /api/v1/triggers/:id': async (k) => {
    const trigger = await k.post(`/api/v1/objects/${id(await k.pingSensor())}/triggers`, {
      kind: 'state',
      settings: { state: 'down' },
      enabled: true,
    });
    return {
      url: `/api/v1/triggers/${id(trigger.id)}`,
      payload: { kind: 'state', settings: { state: 'down' }, enabled: false },
    };
  },
  'DELETE /api/v1/triggers/:id': async (k) => {
    const trigger = await k.post(`/api/v1/objects/${id(await k.pingSensor())}/triggers`, {
      kind: 'state',
      settings: { state: 'down' },
      enabled: true,
    });
    return { url: `/api/v1/triggers/${id(trigger.id)}` };
  },
  'POST /api/v1/templates': (k) =>
    Promise.resolve({
      url: '/api/v1/templates',
      payload: { name: k.name('template'), method: 'email', settings: {} },
    }),
  'PUT /api/v1/templates/:id': async (k) => {
    const template = await k.post('/api/v1/templates', {
      name: k.name('template'),
      method: 'email',
      settings: {},
    });
    return {
      url: `/api/v1/templates/${id(template.id)}`,
      payload: { name: k.name('template'), method: 'email', settings: {}, enabled: false },
    };
  },
  'DELETE /api/v1/templates/:id': async (k) => ({
    url: `/api/v1/templates/${id((await k.post('/api/v1/templates', { name: k.name('template'), method: 'email', settings: {} })).id)}`,
  }),

  // -------------------------------------------------------------------------------- probes
  'POST /api/v1/probes/:gid/approve': async (k) => ({
    url: `/api/v1/probes/${await k.pendingProbe()}/approve`,
    payload: { objectId: await k.probeObject() },
  }),
  'POST /api/v1/probes/:gid/revoke': async (k) => ({
    url: `/api/v1/probes/${await k.pendingProbe()}/revoke`,
    payload: { note: 'swept' },
  }),
  'PUT /api/v1/probes/:gid/allow-from': async (k) => ({
    url: `/api/v1/probes/${await k.pendingProbe()}/allow-from`,
    payload: { allowFrom: ['10.0.0.0/24'] },
  }),
  'DELETE /api/v1/probes/:gid': async (k) => ({
    url: `/api/v1/probes/${await k.pendingProbe()}`,
  }),

  // ----------------------------------------------------------------------------- discovery
  // The community is the planted secret in both places a discovery takes one: a run and a
  // schedule each record whether there is one, and never what it is.
  'POST /api/v1/discovery': (k) =>
    Promise.resolve({
      url: '/api/v1/discovery',
      payload: {
        groupId: k.groupId,
        probeId: k.probeId,
        range: '192.0.2.0/30',
        snmpCommunity: PLANTED_SECRET,
      },
    }),
  'POST /api/v1/discovery/:id/cancel': async (k) => {
    const run = await k.post('/api/v1/discovery', {
      groupId: k.groupId,
      probeId: k.probeId,
      range: '192.0.2.4/30',
    });
    return { url: `/api/v1/discovery/${id(run.id)}/cancel` };
  },
  'POST /api/v1/discovery/schedules': (k) =>
    Promise.resolve({
      url: '/api/v1/discovery/schedules',
      payload: {
        groupId: k.groupId,
        probeId: k.probeId,
        name: k.name('rediscovery'),
        range: '192.0.2.8/30',
        cadence: 'daily',
        snmpCommunity: PLANTED_SECRET,
      },
    }),
  'POST /api/v1/discovery/schedules/:id/enabled': async (k) => {
    const schedule = await k.post('/api/v1/discovery/schedules', {
      groupId: k.groupId,
      probeId: k.probeId,
      name: k.name('rediscovery'),
      range: '192.0.2.12/30',
      cadence: 'weekly',
    });
    return {
      url: `/api/v1/discovery/schedules/${id(schedule.id)}/enabled`,
      payload: { enabled: true },
    };
  },
  'DELETE /api/v1/discovery/schedules/:id': async (k) => {
    const schedule = await k.post('/api/v1/discovery/schedules', {
      groupId: k.groupId,
      probeId: k.probeId,
      name: k.name('rediscovery'),
      range: '192.0.2.16/30',
      cadence: 'hourly',
    });
    return { url: `/api/v1/discovery/schedules/${id(schedule.id)}` };
  },
  // Provisioning creates objects, and objects are audited as they are created. The stub below
  // creates one through the object service with the actor the route handed it — the property
  // this sweep is about is that the route passes the caller through, not the planner.
  'POST /api/v1/discovery/:id/provision': async (k) => {
    const run = await k.post('/api/v1/discovery', {
      groupId: k.groupId,
      probeId: k.probeId,
      range: '10.9.9.0/30',
    });
    return { url: `/api/v1/discovery/${id(run.id)}/provision`, payload: {} };
  },

  // ------------------------------------------------------------------------------ identity
  // `A-18`. The routes that change the account making the call — a password, a second factor, a
  // token — are called in a session of somebody made for the purpose, so the sweeper's own session
  // is never the thing a fixture changes out from under the rest of the sweep.
  'POST /api/v1/groups': (k) =>
    Promise.resolve({ url: '/api/v1/groups', payload: { name: k.name('Sweep group') } }),
  'PUT /api/v1/groups/:id': async (k) => ({
    url: `/api/v1/groups/${id(await k.userGroup())}`,
    payload: { name: k.name('Renamed group') },
  }),
  'DELETE /api/v1/groups/:id': async (k) => ({ url: `/api/v1/groups/${id(await k.userGroup())}` }),
  'PUT /api/v1/groups/:id/members/:userId': async (k) => ({
    url: `/api/v1/groups/${id(k.teamId)}/members/${id((await k.person()).id)}`,
    payload: {},
  }),
  'DELETE /api/v1/groups/:id/members/:userId': async (k) => {
    const person = await k.person();
    await k.join(k.teamId, person.id);
    return { url: `/api/v1/groups/${id(k.teamId)}/members/${id(person.id)}` };
  },
  'PUT /api/v1/accounts/:id/primary-group/:groupId': async (k) => {
    const person = await k.person();
    const other = await k.userGroup();
    await k.join(k.teamId, person.id);
    await k.join(other, person.id);
    return { url: `/api/v1/accounts/${id(person.id)}/primary-group/${id(other)}` };
  },
  'POST /api/v1/auth/tokens': async (k) => {
    const person = await k.person();
    return {
      url: '/api/v1/auth/tokens',
      headers: { cookie: await k.signIn(person) },
      payload: { name: k.name('token'), scope: 'read' },
    };
  },
  'DELETE /api/v1/auth/tokens/:id': async (k) => {
    const person = await k.person();
    const cookie = await k.signIn(person);
    const issued = await k.as<{ token: { id: number }; secret: string }>(
      cookie,
      '/api/v1/auth/tokens',
      { name: k.name('token') },
    );
    k.planted.push(issued.secret);
    return { url: `/api/v1/auth/tokens/${id(issued.token.id)}`, headers: { cookie } };
  },
  'POST /api/v1/auth/password': async (k) => {
    const person = await k.person();
    const next = `${person.password}-next`;
    k.planted.push(next);
    return {
      url: '/api/v1/auth/password',
      headers: { cookie: await k.signIn(person) },
      payload: { currentPassword: person.password, newPassword: next },
    };
  },
  'POST /api/v1/auth/mfa/confirm': async (k) => {
    const person = await k.person();
    const cookie = await k.signIn(person);
    const { secret } = await k.as<{ secret: string }>(cookie, '/api/v1/auth/mfa/enrol');
    k.planted.push(secret);
    return {
      url: '/api/v1/auth/mfa/confirm',
      headers: { cookie },
      payload: { code: k.totpCode(secret) },
    };
  },
  'POST /api/v1/auth/mfa/disable': async (k) => {
    const { person, cookie } = await enrolled(k);
    return {
      url: '/api/v1/auth/mfa/disable',
      headers: { cookie },
      payload: { password: person.password },
    };
  },
  'POST /api/v1/auth/mfa/recovery-codes': async (k) => ({
    url: '/api/v1/auth/mfa/recovery-codes',
    headers: { cookie: (await enrolled(k)).cookie },
  }),
};

/** Somebody signed in with a confirmed second factor, whose secret and codes are planted. */
async function enrolled(k: Kit): Promise<{ person: Person; cookie: string }> {
  const person = await k.person();
  const cookie = await k.signIn(person);
  const { secret } = await k.as<{ secret: string }>(cookie, '/api/v1/auth/mfa/enrol');
  const { recoveryCodes } = await k.as<{ recoveryCodes: string[] }>(
    cookie,
    '/api/v1/auth/mfa/confirm',
    { code: k.totpCode(secret) },
  );
  k.planted.push(secret, ...recoveryCodes, ...recoveryCodes.map((code) => code.replace('-', '')));
  return { person, cookie };
}

describe(
  'every change is audited, or says why not',
  { skip: available ? false : 'no database' },
  () => {
    let scratch: ScratchDatabase;
    let db: Database;
    let app: FastifyInstance;
    let server: ApiServer;
    let harness: Harness;
    let formatter: ReportFormatter;
    let kit: Kit;
    /** Whose session each cookie is, so an entry is held to naming whoever made the call. */
    const signedIn = new Map<string, string>();
    const planted: string[] = [];

    before(async () => {
      scratch = await createScratchDatabase('auditsweep');
      db = scratch.db;
      harness = await buildHarness(db, { states: true });
      const states = harness.states;
      assert.ok(states !== undefined);
      // The harness captures the object service's entries in memory; the sweep counts rows, so
      // they go to the table as well, through the transaction they were recorded in.
      harness.audit.also = new DatabaseAuditSink();

      const accounts = new AccountService({ audit: new DatabaseAuditSink(), db, logger: silent });
      const access = new AccessService({ db, audit: harness.audit, logger: silent });
      const registry = new ProbeRegistry({
        db,
        audit: harness.audit,
        logger: silent,
        enrolmentKeys: ['sweep-key'],
      });
      const groups = new GroupService({ audit: new DatabaseAuditSink(), db, logger: silent });
      const discovery = new DiscoveryService({
        db,
        audit: harness.audit,
        logger: silent,
        dispatch: () => ({ kind: 'sent' }),
      });
      const history = new HistoryService({ db, logger: silent });
      const reportRepository = new ReportRepository();
      const reportContext = new ReportContext({
        db,
        repository: reportRepository,
        access,
        logger: silent,
      });
      const reportRenderer = new ReportRenderer({
        context: reportContext,
        history,
        logger: silent,
      });
      const reportRuns = new ReportRunRepository();
      const audit = new DatabaseAuditSink();
      formatter = new ReportFormatter({ logger: silent });
      const messageContexts = new MessageContextLoader({
        settings: harness.resolver,
        publicUrl: 'https://monitoring.example.test',
        siteName: 'sweep',
      });

      server = new ApiServer({
        config: {
          host: '127.0.0.1',
          port: 0,
          webRoot: '',
          allowedOrigins: [],
          requireAuthentication: true,
        },
        logger: silent,
        version: '9.9.9',
        service: harness.service,
        history,
        db,
        audit: new AuditRepository(),
        catalogue: testCatalogue(),
        maps: new MapService({ db, repository: new MapRepository(), audit, logger: silent }),
        mapResolver: new MapResolver({ db, access, history }),
        libraries: new LibraryService({
          db,
          repository: new LibraryRepository(),
          audit,
          logger: silent,
        }),
        reports: {
          service: new ReportService({ db, repository: reportRepository, audit, logger: silent }),
          context: reportContext,
          renderer: reportRenderer,
          runner: new ReportRunner({
            db,
            reports: reportRepository,
            runs: reportRuns,
            renderer: reportRenderer,
            logger: silent,
            // As `main()` wires it: the run is the auditable act (`E-08`).
            audit: async (event) => {
              await audit.record(
                db,
                { kind: 'user', userId: 0, login: event.requestedBy },
                [
                  {
                    action: 'report.ran',
                    objectId: null,
                    reportId: event.reportId,
                    runId: event.runId,
                    reportName: event.reportName,
                    trigger: event.trigger,
                    requestedBy: event.requestedBy,
                    runAs: event.runAs,
                    spanLabel: event.spanLabel,
                    outcome: event.outcome,
                    errorCode: event.errorCode,
                  },
                ],
                new Date(),
              );
            },
          }),
          runs: reportRuns,
          outputStore: new ReportOutputRepository(),
          formatter,
        },
        triggers: new TriggerService({ db, audit, logger: silent }),
        templates: new TemplateService({ db, audit, logger: silent, contexts: messageContexts }),
        schedules: new ScheduleService({ db, audit, logger: silent }),
        discovery,
        provision: async (_runId: number, actor: Actor) => {
          await harness.service.create(actor, {
            kind: 'group',
            parentId: kit.groupId,
            name: kit.name('provisioned'),
          });
          return {
            devicesCreated: 1,
            matched: 0,
            sensorsCreated: 0,
            sensorsSkipped: 0,
            mastersSet: 0,
            problems: [],
            devices: [],
          };
        },
        rediscovery: new RediscoveryService({
          db,
          audit: harness.audit,
          logger: silent,
          discovery,
          windowFor: () => Promise.resolve(null),
          provision: () => Promise.resolve(),
        }),
        deviceTemplates: new DeviceTemplateCatalogue(() => true),
        probeRegistry: registry,
        queries: new ProbeQueryService({
          logger: silent,
          sender: { sendQuery: () => ({ kind: 'offline' as const }) },
        }),
        probeConfig: new ProbeConfigService({
          db,
          resolver: new InheritanceResolver({ db, logger: silent }),
        }),
        tester: new NotificationTester({
          db,
          logger: silent,
          contexts: messageContexts,
          transports: [],
          audit,
        }),
        auth: {
          accounts,
          sessions: new SessionService({ db, logger: silent }),
          throttle: new LoginThrottle({ db, logger: silent, sleep: () => Promise.resolve() }),
          groups,
          access,
          tokens: new TokenService({ audit: new DatabaseAuditSink(), db, logger: silent }),
          totp: new TotpService({ audit: new DatabaseAuditSink(), db, logger: silent }),
          required: true,
        },
      });
      await server.build('9.9.9', harness.service);
      app = server.app;

      const probe = await harness.service.create(testActor, {
        kind: 'probe',
        parentId: harness.rootId,
        name: 'sweep-probe',
      });
      const device = await harness.service.create(testActor, {
        kind: 'device',
        parentId: probe.id,
        name: 'sweep-device',
        host: '127.0.0.1',
      });
      const group = await harness.service.create(testActor, {
        kind: 'group',
        parentId: probe.id,
        name: 'sweep-group',
      });
      const team = await groups.create({ name: 'Sweep team' }, testActor);

      // An administrator: the sweep is about whether a change that *happens* is recorded, so the
      // caller must be one every route lets through.
      const account = await accounts.create(
        {
          login: 'sweeper',
          password: 'correct-horse-battery',
          role: 'admin',
        },
        testActor,
      );
      const admins = (await groups.list()).find((one) => one.isAdmin);
      assert.ok(admins);
      await groups.addMember(admins.id, account.id, testActor);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { login: 'sweeper', password: 'correct-horse-battery' },
      });
      assert.equal(login.statusCode, 200);
      const setCookie = login.headers['set-cookie'];
      const cookie = (Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '')).split(
        ';',
      )[0];
      assert.ok(cookie !== undefined && cookie !== '');

      let seq = 0;
      const name = (prefix: string): string => {
        seq += 1;
        return `${prefix}-${String(seq)}`;
      };
      const pingSensor = async (): Promise<number> =>
        (
          await harness.service.create(testActor, {
            kind: 'sensor',
            parentId: device.id,
            name: name('ping'),
            sensorType: 'icmp.ping',
          })
        ).id;

      const signIn = async (person: Person): Promise<string> => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { login: person.login, password: person.password },
        });
        assert.equal(response.statusCode, 200, `${person.login} could not sign in`);
        const header = response.headers['set-cookie'];
        const value = (Array.isArray(header) ? (header[0] ?? '') : (header ?? '')).split(';')[0];
        assert.ok(value !== undefined && value !== '');
        signedIn.set(value, person.login);
        return value;
      };

      kit = {
        probeId: probe.id,
        groupId: group.id,
        teamId: team.id,
        cookie,
        name,
        person: async () => {
          const who = name('person');
          const password = `${who}-planted-password`;
          planted.push(password);
          const created = await accounts.create(
            { login: who, password, role: 'readwrite' },
            testActor,
          );
          return { id: created.id, login: who, password };
        },
        userGroup: async () => (await groups.create({ name: name('Sweep group') }, testActor)).id,
        join: (groupId, userId) => groups.addMember(groupId, userId, testActor),
        signIn,
        as: async <T>(session: string, url: string, payload?: unknown): Promise<T> => {
          const response = await app.inject({
            method: 'POST',
            url,
            headers: { cookie: session },
            ...(payload === undefined ? {} : { payload: payload as never }),
          });
          assert.ok(
            response.statusCode < 300,
            `arranging ${url} answered ${String(response.statusCode)}: ${response.body}`,
          );
          return response.json<T>();
        },
        totpCode: (secret) =>
          new OTPAuth.TOTP({
            algorithm: 'SHA1',
            digits: 6,
            period: 30,
            secret: OTPAuth.Secret.fromBase32(secret),
          }).generate(),
        planted,
        group: async (parentId = group.id) =>
          (await harness.service.create(testActor, { kind: 'group', parentId, name: name('g') }))
            .id,
        pingSensor,
        pendingProbe: async () => {
          const gid = name('probe-gid');
          await registry.admit({
            gid,
            displayName: gid,
            agentVersion: '0.1.0',
            protocolVersion: PROTOCOL_VERSION,
            accessKey: 'sweep-key',
            remoteAddress: '192.0.2.200',
          });
          return gid;
        },
        probeObject: async () =>
          (
            await harness.service.create(testActor, {
              kind: 'probe',
              parentId: harness.rootId,
              name: name('probe'),
            })
          ).id,
        // Down through the state machine rather than by writing the column: two failures, because
        // the default policy warns for one interval first.
        downSensor: async () => {
          const sensorId = await pingSensor();
          const at = new Date();
          for (const [index, when] of [at, new Date(at.getTime() + 60_000)].entries()) {
            const decisions = await states.decide([
              { sensorId, at: when, outcome: 'error', message: `failure ${String(index + 1)}` },
            ]);
            await db.tx(async (q) => {
              await writeStateHistory(q, decisions.transitions);
              await writeRuntimes(q, decisions.runtimes);
            });
          }
          return sensorId;
        },
        post: async (url, payload) => {
          const isBytes = Buffer.isBuffer(payload);
          const response = await app.inject({
            method:
              url.includes('/access/') ||
              url.includes('/credentials/') ||
              url.includes('/settings/')
                ? 'PUT'
                : 'POST',
            url,
            headers: {
              cookie,
              ...(isBytes ? { 'content-type': 'image/png' } : {}),
            },
            payload: payload as never,
          });
          assert.ok(
            response.statusCode < 300,
            `arranging ${url} answered ${String(response.statusCode)}: ${response.body}`,
          );
          return response.body === ''
            ? { id: 0, version: 0 }
            : response.json<{ id: number; version: number }>();
        },
      };
    });

    after(async () => {
      await formatter.close();
      await scratch.drop();
    });

    const changing = () => server.routes.filter((route) => route.method !== 'GET' && route.changes);

    it('has changes to sweep, so a silent zero is not a pass', () => {
      assert.ok(changing().length > 60, `only ${String(changing().length)} changing routes found`);
    });

    it('holds every route that writes nothing to a reason, in its own source', () => {
      const unexplained = changing()
        .filter((route) => route.audit !== undefined)
        .filter((route) =>
          route.audit?.kind === 'gap'
            ? !/^[A-Z]-\d+$/.test(route.audit.ticket)
            : route.audit?.kind === 'exempt' && route.audit.why.trim().length < 10,
        )
        .map((route) => `${route.method} ${route.url}`);
      assert.deepEqual(unexplained, [], 'a declaration with no ticket or no reason');
    });

    it('has no fixture for a route that is not in the sweep', () => {
      // A fixture left behind by a route that was removed, or that learnt to declare itself, is a
      // table drifting from the code; better to say so than to carry it.
      const swept = new Set(
        changing()
          .filter((route) => route.audit === undefined)
          .map((route) => `${route.method} ${route.url}`),
      );
      const stale = Object.keys(FIXTURES).filter((key) => !swept.has(key));
      assert.deepEqual(stale, [], 'fixtures for routes the sweep does not call');
    });

    it('records an audit entry for every change that does not say why not', async () => {
      const problems: string[] = [];
      const last = async (): Promise<number> =>
        Number(
          (
            await db.query<{ n: string }>('SELECT coalesce(max(id), 0)::text AS n FROM audit_log')
          )[0]?.n,
        );

      for (const route of changing()) {
        if (route.audit !== undefined) continue;
        const key = `${route.method} ${route.url}`;
        const fixture = FIXTURES[key];
        if (fixture === undefined) {
          problems.push(`${key}: no fixture — write one, or declare why it is not audited`);
          continue;
        }
        let call: Call;
        try {
          call = await fixture(kit);
        } catch (error) {
          problems.push(`${key}: the fixture could not arrange it — ${String(error)}`);
          continue;
        }
        const before = await last();
        const response = await app.inject({
          method: route.method as 'POST',
          url: call.url,
          headers: { cookie: kit.cookie, ...call.headers },
          ...(call.payload === undefined ? {} : { payload: call.payload as never }),
        });
        if (response.statusCode >= 300) {
          problems.push(
            `${key}: answered ${String(response.statusCode)} — ${response.body.slice(0, 200)}`,
          );
          continue;
        }
        const written = await db.query<{ action: string; actor_kind: string; actor_label: string }>(
          `SELECT action, actor_kind, actor_label FROM audit_log WHERE id > $1 ORDER BY id`,
          [before],
        );
        if (written.length === 0) problems.push(`${key}: succeeded and wrote no audit entry`);
        // **And names who did it.** An entry that exists and names somebody else is a false
        // record: the provision route wrote every device it created as `anonymous` from an
        // address, with an administrator logged in, until `A-20`. Who did it is the sweeper,
        // or the person a self-service fixture signed in to change their own account (`A-18`).
        const caller = signedIn.get(call.headers?.['cookie'] ?? '') ?? 'sweeper';
        for (const row of written) {
          if (row.actor_kind !== 'user' || row.actor_label !== caller) {
            problems.push(
              `${key}: ${row.action} names ${row.actor_kind} ${row.actor_label}, not the caller`,
            );
          }
        }
      }
      assert.deepEqual(problems, [], `\n  ${problems.join('\n  ')}`);
    });

    it('never records the secret it was handed', async () => {
      // Every row this file caused, including the credential it planted, as text.
      const leaked = await db.query<{ action: string }>(
        `SELECT action FROM audit_log
       WHERE summary::text LIKE '%' || $1 || '%' OR diff::text LIKE '%' || $1 || '%'`,
        [PLANTED_SECRET],
      );
      assert.deepEqual(leaked, []);
      // And the plant happened, so the absence above means something.
      const set = await db.query(`SELECT 1 FROM audit_log WHERE action = 'credential.set'`);
      assert.ok(set.length > 0, 'no credential was set, so the redaction check proved nothing');
    });

    it('never records a password, token, TOTP secret or recovery code a route handled', async () => {
      // `A-18`: what the identity fixtures sent and were sent back, in every rendering a careless
      // serialiser could give it.
      const rows = await db.query<{ row: string }>(
        `SELECT concat_ws(' ', actor_label, summary::text, diff::text) AS row FROM audit_log`,
      );
      const text = rows.map((one) => one.row).join('\n');
      const leaks: string[] = [];
      for (const secret of new Set(planted)) {
        const bytes = Buffer.from(secret);
        for (const [how, form] of [
          ['text', secret],
          ['base64', bytes.toString('base64')],
          ['hex', bytes.toString('hex')],
          ['bytes', JSON.stringify([...bytes]).slice(1, -1)],
        ] as const) {
          if (text.includes(form)) leaks.push(`${secret.slice(0, 6)}… as ${how}`);
        }
      }
      assert.deepEqual(leaks, []);
      const kinds = new Set(
        (await db.query<{ action: string }>(`SELECT DISTINCT action FROM audit_log`)).map(
          (one) => one.action,
        ),
      );
      for (const action of ['account.passwordChanged', 'account.mfaEnabled', 'token.revoked']) {
        assert.ok(
          kinds.has(action),
          `no ${action} entry, so its absence of secrets proves nothing`,
        );
      }
      assert.ok(planted.length > 20, `only ${String(planted.length)} secrets were planted`);
    });
  },
);
