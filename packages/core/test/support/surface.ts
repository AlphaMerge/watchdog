import type { BuildStamp } from '@ms/shared';
import { ApiServer, type ApiServerOptions } from '../../src/api/server.js';
import { AuditRepository } from '../../src/audit/store.js';
import { AccessService } from '../../src/auth/access.js';
import { AccountService } from '../../src/auth/accounts.js';
import { GroupService } from '../../src/auth/groups.js';
import { SessionService } from '../../src/auth/sessions.js';
import { LoginThrottle } from '../../src/auth/throttle.js';
import { TokenService } from '../../src/auth/tokens.js';
import { TotpService } from '../../src/auth/totp.js';
import { DependencyRepository } from '../../src/dependencies/repository.js';
import { DeviceTemplateCatalogue } from '../../src/device-templates/catalogue.js';
import { LookupCatalogue } from '../../src/lookups/catalogue.js';
import type { AuditSink } from '../../src/objects/audit.js';
import type { AuditSinkSet } from '../../src/objects/audit-composition.js';
import { ObjectRepository } from '../../src/objects/repository.js';
import { catalogueSensorTypeGate } from '../../src/objects/sensor-type-gate.js';
import { ObjectService } from '../../src/objects/service.js';
import { coreCatalogue, startV2Subsystems, v2ApiOptions } from '../../src/profile.js';
import { ScheduleRepository } from '../../src/schedules/repository.js';
import { InheritanceResolver } from '../../src/settings/inheritance.js';
import { HistoryService } from '../../src/timeseries/history.js';
import { CredentialVault } from '../../src/vault/service.js';
import { VaultKeyring } from '../../src/vault/keyring.js';
import { VaultSealer } from '../../src/vault/sealer.js';
import { silent } from './tree.js';

/**
 * A core's API built without a database (`H-13`), the way `scripts/docs/api-reference.mjs`
 * builds one, but with its profile taken from a build stamp and its v2 decision taken from
 * `profile.ts`. That is the same function `main.ts` calls, so what this server answers is what
 * that build answers.
 *
 * **Registration is pure; only handlers query.** So the database is a stub that throws when it is
 * touched, and so are the services a route group is gated on. A handler that runs here fails
 * with a 500, which still answers the question this is built for: does the route exist?
 */

/** `GET /api/v1/objects/{id}`, the way the runbook's table and the API reference spell it. */
export type RouteKey = `${string} ${string}`;

export interface SurfaceServer {
  readonly server: ApiServer;
  /** Every route the router registered, HEAD and OPTIONS aside. */
  readonly registered: readonly RouteKey[];
  close(): Promise<void>;
}

export interface SurfaceOptions {
  /** `auth.required`: on to ask what answers without a credential, off to reach every handler. */
  readonly required: boolean;
  /**
   * `profile` builds the v2 subsystems the way `main.ts` does, from the stamp. `stubbed` passes all
   * of them, the way the API reference does, so a test can check that the harness does see a v2
   * route when one is registered.
   */
  readonly v2: 'profile' | 'stubbed';
}

// Never queried by registration. A handler that reaches for it fails loudly, not silently.
const unusable = new Proxy(
  {},
  {
    get(): never {
      throw new Error('the surface harness has no database; it only registers routes');
    },
  },
) as never;
const stub = {} as never;

const nothing: AuditSink = { record: () => Promise.resolve() };
const noAudit: AuditSinkSet = {
  database: nothing,
  logging: nothing,
  configNotifier: nothing,
  cacheInvalidator: nothing,
  scheduleSync: nothing,
  dependencySync: nothing,
  reachabilitySync: nothing,
  clockFreezeSync: nothing,
  triggerSync: nothing,
};

/**
 * The options `main.ts` passes to `ApiServer`, as stubs, minus the v2 ones.
 *
 * **Named so that a test can compare its keys with `main.ts`'s own.** A harness that passed a
 * service `main.ts` forgets would answer routes the shipped core does not. That is how `G-01`'s
 * maps API went unmounted for a phase while every test of it passed.
 */
export function baseOptions(stamp: BuildStamp, required: boolean): ApiServerOptions {
  const catalogue = coreCatalogue(stamp.profile);
  const resolver = new InheritanceResolver({ db: unusable, logger: silent });
  const service = new ObjectService({
    db: unusable,
    repository: new ObjectRepository(),
    resolver,
    audit: nothing,
    vault: new CredentialVault({
      resolver,
      sealer: new VaultSealer(VaultKeyring.fromKeys([{ id: 'surface', key: Buffer.alloc(32, 7) }])),
      logger: silent,
    }),
    sensorTypes: catalogueSensorTypeGate(catalogue),
    schedules: new ScheduleRepository(),
    dependencies: new DependencyRepository(),
    logger: silent,
  });
  return {
    config: {
      host: '127.0.0.1',
      port: 0,
      webRoot: '',
      allowedOrigins: [],
      requireAuthentication: required,
    },
    logger: silent,
    version: stamp.version,
    build: stamp,
    service,
    history: new HistoryService({ db: unusable, logger: silent }),
    db: unusable,
    audit: new AuditRepository(),
    catalogue,
    lookups: new LookupCatalogue().seal(),
    schedules: stub,
    discovery: stub,
    // Real and empty, rather than a stub, so that asking for a template reaches the route's own
    // refusal (`P-221`) instead of failing on the stub.
    deviceTemplates: new DeviceTemplateCatalogue((id) => catalogue.has(id)).seal(),
    provision: () => Promise.resolve(stub),
    rediscovery: stub,
    probeRegistry: stub,
    queries: stub,
    probeConfig: stub,
    auth: {
      accounts: new AccountService({ db: unusable, audit: nothing, logger: silent }),
      sessions: new SessionService({ db: unusable, logger: silent }),
      throttle: new LoginThrottle({ db: unusable, logger: silent, sleep: () => Promise.resolve() }),
      groups: new GroupService({ db: unusable, audit: nothing, logger: silent }),
      access: new AccessService({ db: unusable, audit: nothing, logger: silent }),
      tokens: new TokenService({ db: unusable, audit: nothing, logger: silent }),
      totp: new TotpService({ db: unusable, audit: nothing, logger: silent }),
      required,
    },
    mapTiles: { urlTemplate: '', attribution: '' },
    triggers: stub,
    templates: stub,
    deliveryHealth: stub,
    coreHealth: () => undefined,
    probeHealth: () => undefined,
    metrics: () => undefined,
    tester: stub,
    stream: stub,
  };
}

/** The v2 services, as the API reference passes them: every one, and none of them usable. */
const STUBBED_V2: Pick<ApiServerOptions, 'maps' | 'mapResolver' | 'libraries' | 'reports'> = {
  maps: stub,
  mapResolver: stub,
  libraries: stub,
  reports: {
    service: stub,
    context: stub,
    renderer: stub,
    runner: stub,
    runs: stub,
    outputStore: stub,
    formatter: stub,
  },
};

export async function surfaceServer(
  stamp: BuildStamp,
  options: SurfaceOptions,
): Promise<SurfaceServer> {
  const v2 =
    options.v2 === 'stubbed'
      ? STUBBED_V2
      : v2ApiOptions(
          await startV2Subsystems(stamp.profile, {
            db: unusable,
            logger: silent,
            lifecycle: stub,
            config: unusable,
            access: stub,
            history: stub,
            auditSinks: noAudit,
            email: stub,
          }),
        );
  const base = baseOptions(stamp, options.required);
  const server = new ApiServer({ ...base, ...v2 });

  const registered: RouteKey[] = [];
  server.app.addHook('onRoute', (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      registered.push(`${String(method)} ${route.url.replace(/:([a-zA-Z]+)/gu, '{$1}')}`);
    }
  });
  await server.build(stamp.version, base.service);
  await server.app.ready();
  return { server, registered, close: () => server.app.close() };
}

/** A URL for a route: every parameter `1`, which each of them accepts or refuses in a handler. */
export function concrete(path: string): string {
  return path.replace(/\{[a-zA-Z]+\}/gu, '1').replace(/\*$/u, 'x');
}
