#!/usr/bin/env node
// Generates `docs/api-reference.md` from the OpenAPI document the API itself produces (H-07).
// This file builds the document and checks or writes the page; `api-reference-render.mjs` renders
// it, and is what `packages/core/test/api-reference-render.test.ts` tests against a fixture.
//
//     node scripts/docs/api-reference.mjs            # write
//     node scripts/docs/api-reference.mjs --check    # exit 1 if it is out of date
//
// The document is not hand-maintained and neither is this: every route in `packages/core` is
// declared with a JSON Schema that Fastify validates against and `@fastify/swagger` turns into
// OpenAPI, so the reference is a rendering of the thing that actually runs. A route added without
// a schema shows up here as a route with no documented body, which is the visible version of a
// problem that is otherwise invisible.
//
// **No database is involved.** Route registration is pure — the schemas are declared at
// registration and the handlers are the only part that queries — so this builds a real
// `ApiServer` against services that have a connection they never use, and asks Fastify for the
// document. That is what makes it runnable in CI and in the test suite rather than only against
// a live installation.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absentFromRelease, renderApiReference, routeKeyOf } from './api-reference-render.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const target = join(root, 'docs', 'api-reference.md');
const core = join(root, 'packages', 'core', 'dist', 'src');

const { ApiServer } = await import(join(core, 'api/server.js'));
const { ObjectService } = await import(join(core, 'objects/service.js'));
const { ObjectRepository } = await import(join(core, 'objects/repository.js'));
const { InheritanceResolver } = await import(join(core, 'settings/inheritance.js'));
const { CredentialVault } = await import(join(core, 'vault/service.js'));
const { VaultKeyring } = await import(join(core, 'vault/keyring.js'));
const { VaultSealer } = await import(join(core, 'vault/sealer.js'));
const { ScheduleRepository } = await import(join(core, 'schedules/repository.js'));
const { DependencyRepository } = await import(join(core, 'dependencies/repository.js'));
const { AuditRepository } = await import(join(core, 'audit/store.js'));
const { HistoryService } = await import(join(core, 'timeseries/history.js'));
const { AccessService } = await import(join(core, 'auth/access.js'));
const { AccountService } = await import(join(core, 'auth/accounts.js'));
const { GroupService } = await import(join(core, 'auth/groups.js'));
const { LoginThrottle } = await import(join(core, 'auth/throttle.js'));
const { SessionService } = await import(join(core, 'auth/sessions.js'));
const { TokenService } = await import(join(core, 'auth/tokens.js'));
const { TotpService } = await import(join(core, 'auth/totp.js'));
const { catalogueSensorTypeGate } = await import(join(core, 'objects/sensor-type-gate.js'));
const { startV2Subsystems, v2ApiOptions } = await import(join(core, 'profile.js'));
const { standardCatalogue } = await import(join(root, 'packages/sensors/dist/src/index.js'));

const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
// Never queried: nothing below runs a handler. A stub rather than a scratch database is what lets
// this run in CI without Postgres, and it fails loudly rather than silently if that stops holding.
const unusable = new Proxy(
  {},
  {
    get() {
      throw new Error('the documentation generator has no database; it only registers routes');
    },
  },
);
// Never called, for the same reason: every service that records a change needs somewhere to.
const noAudit = { record: () => Promise.resolve() };

const catalogue = standardCatalogue();

// **Every optional service, because half of the routes are gated on one.** `queryRoutes`,
// `scheduleRoutes`, `discoveryRoutes`, `probeRoutes`, `deviceTemplateRoutes`, `triggerRoutes`,
// `templateRoutes`, `streamRoutes`, `notificationRoutes` and `healthRoutes` each register only
// when their service was passed — so a generator that passed none would produce a reference
// missing a third of the API and say nothing about it. `assertComplete` below is the guard: this
// list is checked against the route modules `server.ts` actually registers, so a route group
// added later cannot go quietly undocumented.
//
// They are stubs, not instances. Registration reads the schemas, never the service; the handlers
// are the only part that would touch these, and no handler runs here.
const stub = {};

/**
 * Maps, libraries and reports, every one a stub, so that the page lists their routes too. What a
 * release build is given of them instead is `profile.ts`'s answer; see `absentFromRelease` below.
 */
const STUBBED_V2 = {
  maps: stub,
  // Without one, `GET /maps/:id/view` is simply not registered — and a reference that
  // silently omits a route is exactly what this generator exists to prevent (`H-07`).
  mapResolver: stub,
  libraries: stub,
  reports: {
    service: stub,
    context: stub,
    renderer: stub,
    runner: stub,
    runs: stub,
    outputStore: stub,
  },
};

/**
 * A core's API with every route registered and no handler able to run, given `v2` of the v2
 * subsystems. Each call builds its own services, so two servers share nothing.
 */
function apiServer(v2) {
  const resolver = new InheritanceResolver({ db: unusable, logger: silent });
  const service = new ObjectService({
    db: unusable,
    repository: new ObjectRepository(),
    resolver,
    audit: { record: () => Promise.resolve() },
    vault: new CredentialVault({
      resolver,
      sealer: new VaultSealer(VaultKeyring.fromKeys([{ id: 'docs', key: Buffer.alloc(32, 7) }])),
      logger: silent,
    }),
    sensorTypes: catalogueSensorTypeGate(catalogue),
    schedules: new ScheduleRepository(),
    dependencies: new DependencyRepository(),
    logger: silent,
  });
  const server = new ApiServer({
    config: { host: '127.0.0.1', port: 0, webRoot: '', allowedOrigins: [] },
    logger: silent,
    version: '0.0.0-docs',
    service,
    history: new HistoryService({ db: unusable, logger: silent }),
    db: unusable,
    audit: new AuditRepository(),
    catalogue,
    schedules: stub,
    ...v2,
    discovery: stub,
    rediscovery: stub,
    provision: () => Promise.resolve({}),
    deviceTemplates: stub,
    probeRegistry: stub,
    queries: stub,
    probeConfig: stub,
    triggers: stub,
    templates: stub,
    tester: stub,
    deliveryHealth: stub,
    stream: stub,
    coreHealth: () => undefined,
    probeHealth: () => undefined,
    metrics: () => undefined,
    auth: {
      accounts: new AccountService({ db: unusable, audit: noAudit, logger: silent }),
      sessions: new SessionService({ db: unusable, logger: silent }),
      throttle: new LoginThrottle({ db: unusable, logger: silent, sleep: () => Promise.resolve() }),
      groups: new GroupService({ db: unusable, audit: noAudit, logger: silent }),
      access: new AccessService({ db: unusable, audit: noAudit, logger: silent }),
      tokens: new TokenService({ db: unusable, audit: noAudit, logger: silent }),
      totp: new TotpService({ db: unusable, audit: noAudit, logger: silent }),
      required: true,
    },
  });
  return { server, service };
}

const { server, service } = apiServer(STUBBED_V2);
// **Routes the OpenAPI document cannot carry.** `@fastify/websocket` sets `schema.hide = true`
// on every `websocket: true` route unconditionally (its `index.js`, in the `onRoute` hook), so
// `/api/v1/stream` is invisible to `@fastify/swagger` no matter what order the plugins are
// registered in. It is a real, documented part of the API, so it is collected from the router
// itself and rendered from its own schema below.
const registered = [];
server.app.addHook('onRoute', (route) => {
  if (route.method !== 'HEAD') registered.push(route);
});

await server.build('0.0.0-docs', service);
await server.app.ready();
const doc = server.app.swagger();

/**
 * The routes Fastify serves that the document does not carry.
 *
 * Computed by difference rather than by reading `schema.hide`: the flag is set by
 * `@fastify/websocket`'s own `onRoute` hook, which is added during `build()` and so runs *after*
 * the collector above. A route that declared tags meant to be documented, and any that ends up
 * here is one the reader would otherwise never learn about.
 */
const hidden = registered.filter(
  (route) =>
    route.schema?.tags !== undefined &&
    doc.paths?.[route.url.replace(/:([a-zA-Z]+)/gu, '{$1}')]?.[route.method.toLowerCase()] ===
      undefined,
);

/**
 * Refuse to write a reference that is missing a route group.
 *
 * Ten of the route modules register only when an optional service was supplied, and the failure
 * mode of forgetting one is not an error — it is a document that is quietly a third shorter. So
 * the expectation is read out of `server.ts` itself: every `somethingRoutes` it registers must
 * appear in Fastify's own plugin tree by the time the document is built. Adding a route group and
 * forgetting to wire it in here then fails loudly, here, rather than silently for a reader.
 */
function assertComplete() {
  const source = readFileSync(join(root, 'packages/core/src/api/server.ts'), 'utf8');
  // Both registration styles: `scope.register(objectRoutes, …)` and the bare `alarmRoutes(scope,
  // …)` used by the two that are plain functions rather than plugins. Fastify's plugin tree only
  // knows about the first kind, which is why this matches on declared paths instead.
  const used = new Set(
    [...source.matchAll(/([a-zA-Z]+Routes)\s*[,(]/gmu)].map(([, name]) => name),
  );
  const files = new Map(
    [...source.matchAll(/import \{ ([a-zA-Z]+Routes)[^}]*\} from '\.\/routes\/([a-z-]+)\.js'/gu)]
      .map(([, name, file]) => [name, file]),
  );
  const paths = new Set([
    ...Object.keys(doc.paths ?? {}),
    // Documented from the router rather than the document; see `hidden` above.
    ...hidden.map((route) => route.url.replace(/:([a-zA-Z]+)/gu, '{$1}')),
  ]);

  const missing = [];
  for (const name of used) {
    const file = files.get(name);
    if (file === undefined) continue;
    const routes = readFileSync(join(root, `packages/core/src/api/routes/${file}.ts`), 'utf8');
    // `.get('/objects/:id/tree'` → `/api/v1/objects/{id}/tree`, which is how the document spells
    // it. One matching path is enough: this is a "did this module contribute anything" check.
    const declared = [...routes.matchAll(/\.(?:get|post|put|patch|delete)\(\s*'([^']+)'/gu)].map(
      ([, path]) => `/api/v1${path.replace(/:([a-zA-Z]+)/gu, '{$1}')}`,
    );
    if (declared.length > 0 && !declared.some((path) => paths.has(path))) missing.push(name);
  }

  // Routes `server.ts` declares on the app itself rather than in a route module — `/metrics` and
  // the OpenAPI document. The module scan above cannot see them, and `/metrics` is exactly the
  // kind of route that goes missing here: it is gated on an option like all the rest, and it is
  // the one an operator is most likely to come looking for.
  const served = new Set(registered.map((route) => route.url));
  for (const [, path] of source.matchAll(/#app\.(?:get|post|put|patch|delete)\(\s*\n?\s*'([^']+)'/gu)) {
    if (!served.has(path)) missing.push(path);
  }

  if (missing.length > 0) {
    process.stderr.write(
      `these routes are declared by server.ts but produced nothing here: ${missing.sort().join(', ')}\n` +
        'The generator has to pass whatever service each one is gated on, or the reference is\n' +
        'silently missing them. Add it to the options above.\n',
    );
    process.exit(1);
  }
}
assertComplete();

// ---------------------------------------------------------------------------------------------

// The hidden ones carry the same schema, minus what swagger would have resolved. `parameters` and
// `requestBody` are OpenAPI's spelling and these never have either — a WebSocket upgrade takes no
// body — so the schema's own `tags`, `summary` and `description` are all that is needed.
const extra = hidden.map((route) => {
  const schema = route.schema ?? {};
  return {
    path: route.url.replace(/:([a-zA-Z]+)/gu, '{$1}'),
    method: route.method.toLowerCase(),
    operation: {
      tags: schema.tags,
      summary: schema.summary,
      description: schema.description,
      responses: {},
    },
  };
});

// ---------------------------------------------------------------------------------------------

/** The release this page ships in, and the profile `package.sh` builds it as by default. */
const RELEASE = { name: '1.0', profile: 'v1' };

/**
 * The routes on this page that a release core does not register (`H-51`).
 *
 * **Asked of `profile.ts`, never listed here.** The page is rendered from a server given every v2
 * subsystem, so it lists maps, libraries and reports, which the v1 build does not construct: in
 * 1.0 they answer 404 and the core's own document leaves them out. The reference shipped in
 * `/opt/ms/docs` saying none of that. `main.ts` decides what a build constructs by calling
 * `startV2Subsystems` with its profile and hands `ApiServer` what `v2ApiOptions` makes of the
 * answer; this builds a second server the same way, with the release's profile, and every route
 * of the page that server lacks is marked. A v2 route added later is marked without anybody
 * remembering to, and a subsystem moved into 1.0 loses its marks the same way.
 */
async function releaseRoutes() {
  // Not `full`, so it is answered without reading its options; one that read them would throw
  // here, on the stub database, rather than construct a subsystem.
  const v2 = v2ApiOptions(await startV2Subsystems(RELEASE.profile, unusable));
  const { server: release, service: releaseService } = apiServer(v2);
  const routes = [];
  release.app.addHook('onRoute', (route) => {
    if (route.method !== 'HEAD') routes.push(routeKeyOf(route.method, route.url));
  });
  await release.build('0.0.0-docs', releaseService);
  await release.app.ready();
  await release.app.close();
  return routes;
}

const inRelease = await releaseRoutes();
let absent;
try {
  absent = absentFromRelease(doc, extra, {
    registered: registered.map((route) => routeKeyOf(route.method, route.url)),
    release: inRelease,
    name: RELEASE.name,
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

// `--openapi` prints the document itself, for checks that walk its schemas rather than read the
// page (`build-hygiene.test.ts`'s credential-shaped fields, `P-334`/`P-336`). Stdout only: Ajv's
// strict-mode warnings go to stderr and must not corrupt the JSON.
// The write is awaited before exiting: a pipe takes a document this size in several chunks.
if (process.argv.includes('--openapi')) {
  await new Promise((resolve) => process.stdout.write(`${JSON.stringify(doc)}\n`, resolve));
  process.exit(0);
}

const generated = renderApiReference(doc, {
  extra,
  release: { name: RELEASE.name, absent },
});

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    current = '';
  }
  if (current !== generated) {
    process.stderr.write(
      'docs/api-reference.md is out of date.\nRun: node scripts/docs/api-reference.mjs\n',
    );
    process.exit(1);
  }
  process.stdout.write('docs/api-reference.md is current\n');
} else {
  writeFileSync(target, generated, 'utf8');
  process.stdout.write(`wrote ${target}\n`);
}
process.exit(0);
