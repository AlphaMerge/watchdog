import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  BUILD_PROFILES,
  DEVELOPMENT_PROFILE,
  describeError,
  newCorrelationId,
  withCorrelation,
  type BuildStamp,
  type Logger,
} from '@ms/shared';
import type { CoreConfig } from '@ms/shared';
import type { SensorCatalogue } from '@ms/sensors';
import type { ObjectService } from '../objects/service.js';
import type { AuditRepository } from '../audit/store.js';
import type { Database } from '../db/pool.js';
import type { HistoryService } from '../timeseries/history.js';
import { AlarmService } from '../state/alarms.js';
import { StateLogService } from '../timeseries/state-log.js';
import { logIfUnexpected, toHttpError } from './errors.js';
import { registerAuthentication } from './authentication.js';
import {
  INSTALLATION,
  READS,
  registerAuthorization,
  visibilityOf,
  type AuditDeclaration,
  type RouteAccess,
} from './authorization.js';
import { registerCsrfGuard, registerRateLimit, registerSecurityHeaders } from './hardening.js';
import { validatorSalt } from './preconditions.js';
import { authRoutes } from './routes/auth.js';
import { groupRoutes } from './routes/groups.js';
import { accessRoutes } from './routes/access.js';
import { tokenRoutes } from './routes/tokens.js';
import type { AccountService } from '../auth/accounts.js';
import type { GroupService } from '../auth/groups.js';
import type { AccessService, Visibility } from '../auth/access.js';
import type { TokenService } from '../auth/tokens.js';
import type { TotpService } from '../auth/totp.js';
import type { SessionService } from '../auth/sessions.js';
import type { LoginThrottle } from '../auth/throttle.js';
import { auditRoutes } from './routes/audit.js';
import { historyRoutes } from './routes/history.js';
import { queryRoutes } from './routes/queries.js';
import { objectRoutes } from './routes/objects.js';
import { probeRoutes } from './routes/probes.js';
import { BulkService } from '../objects/bulk.js';
import type { ProbeRegistry } from '../probes/registry.js';
import { sensorTypeRoutes } from './routes/sensor-types.js';
import { lookupRoutes } from './routes/lookups.js';
import { mapBackgroundRoute, mapRoutes } from './routes/maps.js';
import { reportDownloadRoute, reportRenderRoute, reportRoutes } from './routes/reports.js';
import { libraryRoutes } from './routes/libraries.js';
import {
  PUBLIC_MAP_PREFIX,
  publicMapBackgroundRoute,
  publicMapRoutes,
} from './routes/public-maps.js';
import { ShareRateLimit } from '../maps/shares.js';
import { scheduleRoutes } from './routes/schedules.js';
import { discoveryRoutes } from './routes/discovery.js';
import { deviceTemplateRoutes } from './routes/device-templates.js';
import { stateRoutes } from './routes/state.js';
import { alarmRoutes, ALARM_SCHEMAS } from './routes/alarms.js';
import { stateLogRoutes, STATE_LOG_SCHEMAS } from './routes/state-log.js';
import type { DeliveryHealthReader } from '../notifications/health.js';
import type { CoreHealthService } from '../health/core-health.js';
import type { ProbeHealthService } from '../health/probe-health.js';
import type { MetricsExporter } from '../metrics/exporter.js';
import { healthRoutes } from './routes/health.js';
import type { NotificationTester } from '../notifications/test-send.js';
import { templateRoutes, TEMPLATE_SCHEMAS } from './routes/templates.js';
import { notificationRoutes, NOTIFICATION_SCHEMAS } from './routes/notifications.js';
import { STREAM_MAX_PAYLOAD_BYTES, streamRoutes } from './routes/stream.js';
import type { StateBroadcaster } from '../state/stream.js';
import { triggerRoutes, TRIGGER_SCHEMAS } from './routes/triggers.js';
import { AUDIT_SCHEMAS } from './schemas/audit.js';
import { HISTORY_SCHEMAS } from './schemas/history.js';
import { QUERY_SCHEMAS } from './schemas/queries.js';
import type { ProbeQueryService } from '../probes/queries.js';
import type { ProbeConfigService } from '../probes/config.js';
import { LookupCatalogue } from '../lookups/catalogue.js';
import type { MapResolver } from '../maps/resolver.js';
import type { MapService } from '../maps/service.js';
import type { LibraryService } from '../libraries/service.js';
import type { ReportService } from '../reports/service.js';
import type { ReportContext } from '../reports/context.js';
import type { ReportRenderer } from '../reports/render.js';
import type { ReportRunner, ReportRunRepository } from '../reports/runs.js';
import type { ReportOutputRepository } from '../reports/delivery.js';
import type { ReportFormatter } from '../reports/formatter.js';
import type { DiscoveryService } from '../discovery/service.js';
import type { DeviceTemplateCatalogue } from '../device-templates/catalogue.js';
import type { ProvisionReport } from '../discovery/provision.js';
import type { RediscoveryService } from '../discovery/rediscovery.js';
import type { Actor } from '../objects/audit.js';
import type { ScheduleService } from '../schedules/service.js';
import type { TemplateService } from '../notifications/templates.js';
import type { TriggerService } from '../triggers/service.js';
import { LOOKUP_SCHEMAS } from './schemas/lookups.js';
import { PAUSE_SCHEMAS } from './schemas/pause.js';
import { SCHEDULE_SCHEMAS } from './schemas/schedules.js';
import { LIBRARY_SCHEMAS } from './schemas/libraries.js';
import { STATE_SCHEMAS } from './schemas/state.js';
import { SHARED_SCHEMAS } from './schemas/objects.js';

export interface ApiServerOptions {
  config: CoreConfig['api'];
  logger: Logger;
  version: string;
  /**
   * Which build is serving, for `GET /api/v1/build` (`H-11`), and what it was built to contain
   * (`H-12`). Absent in the route tests; a server without one reports its version, no commit and
   * the working tree's profile, which is what it knows.
   */
  build?: BuildStamp;
  service: ObjectService;
  history: HistoryService;
  db: Database;
  audit: AuditRepository;
  catalogue: SensorCatalogue;
  /**
   * The lookups this installation loaded (`M-06`).
   *
   * Optional so a test that cares about objects need not build one; an empty catalogue serves
   * an empty list, which is the honest answer for an installation with no lookups.
   */
  lookups?: LookupCatalogue;
  /**
   * Maps and dashboards (`G-01`).
   *
   * Optional, like the schedule library: a test about objects need not build one, and absent the
   * routes are simply not registered rather than answering an empty list — a build without maps
   * has no maps API, which is a different statement from having no maps.
   */
  maps?: MapService;
  /**
   * Where a geographical map's tiles come from (`G-08`, `ADR-004`).
   *
   * Absent or empty means no provider is configured, which is the default and is a working map
   * rather than a broken one: the widgets draw over the background image instead.
   */
  mapTiles?: { urlTemplate: string; attribution: string };
  /** Fills a map's widgets in for the view route (`G-10`). */
  mapResolver?: MapResolver;
  /**
   * Libraries (`L-01`).
   *
   * Optional on the same terms as `maps`: absent, the routes are not registered at all, because a
   * build with no libraries API and an installation with no libraries are different answers.
   */
  libraries?: LibraryService;
  /**
   * Reports (`E-01`), and the security context they render through (`E-03`).
   *
   * Optional on the same terms as `maps`: absent, the routes are not registered at all rather
   * than answering an empty list, because "this build has no reporting" and "this installation
   * has written no reports" are different answers and a client should be able to tell them apart.
   *
   * **One option holding both, rather than two that can be passed separately.** `maps` and
   * `mapResolver` are two fields and `G-06`'s public routes have to check for the second before
   * registering; here the second decides *whose data a report contains*, so a build that mounted
   * the routes without one would not be a reduced API, it would be an unscoped one. Making them
   * inseparable is cheaper than remembering.
   */
  reports?: {
    service: ReportService;
    context: ReportContext;
    renderer: ReportRenderer;
    runner: ReportRunner;
    runs: ReportRunRepository;
    outputStore: ReportOutputRepository;
    /** Turns a document into files, off the event loop (`P-204`). */
    formatter: ReportFormatter;
  };
  /**
   * The schedule library (`M-09`).
   *
   * Optional so a test about objects need not build one; absent, the routes are simply not
   * registered rather than served as an empty list — an installation whose schedules are
   * missing should 404 rather than quietly report that it has none.
   */
  schedules?: ScheduleService;
  /** Absent until D-01 is wired; the discovery routes then simply do not exist. */
  discovery?: DiscoveryService;
  /** Absent until D-03 is wired. */
  deviceTemplates?: DeviceTemplateCatalogue;
  /** Absent until D-04 is wired; the provision route then does not exist. */
  provision?: (runId: number, actor: Actor) => Promise<ProvisionReport>;
  /** Absent until D-07 is wired; the rediscovery routes then do not exist. */
  rediscovery?: RediscoveryService;
  /** Absent until R-01 is wired; the approval queue then has no routes. */
  probeRegistry?: ProbeRegistry;
  /**
   * Running a check on demand (`R-09`). Both are needed or neither route exists: asking a probe
   * requires knowing what to ask it, and half of that pair is a route that always 404s.
   */
  queries?: ProbeQueryService;
  probeConfig?: ProbeConfigService;
  /**
   * Accounts, sessions and login throttling (`A-01`).
   *
   * Optional like the rest, and absent has a specific meaning: no `/auth` routes and no
   * authentication hook, so every request is `anonymous` exactly as it was before `A-01`. That is
   * what the transport's own tests run against, and what an upgrade looks like before anybody
   * has been given an account.
   */
  auth?: {
    accounts: AccountService;
    sessions: SessionService;
    throttle: LoginThrottle;
    groups: GroupService;
    access: AccessService;
    tokens: TokenService;
    totp: TotpService;
    /** Whether an API request without a session is refused. */
    required: boolean;
  };
  /**
   * Notification triggers (`N-01`).
   *
   * Optional for the same reason as the schedules, and absent for the same effect: not
   * registered rather than empty, so a build without them 404s instead of reporting that
   * nothing would ever notify anybody.
   */
  triggers?: TriggerService;
  /**
   * Notification templates (`N-05`).
   *
   * Optional for the same reason as the schedules and the triggers, and absent for the same
   * effect: not registered rather than empty.
   */
  templates?: TemplateService;
  /**
   * How delivery is going (`N-13`).
   *
   * Optional like the rest, and for the same reason: a build with no notification subsystem
   * should 404 rather than report that everything is fine.
   */
  deliveryHealth?: DeliveryHealthReader;
  /**
   * The core's own numbers, live (`P-12`).
   *
   * A getter rather than the service, because it is built from the ingestor and the probe
   * endpoint — both constructed after the API, so that a slow first housekeeping pass cannot
   * delay the port opening. The route answers 503 for the milliseconds in between.
   */
  coreHealth?: () => CoreHealthService | undefined;
  /** One probe's health, live (`P-13`). Late-bound like the core's, and for the same reason. */
  probeHealth?: () => ProbeHealthService | undefined;
  /**
   * The Prometheus exporter (`P-14`). Late-bound like the health services it reads.
   *
   * Optional like the rest: a build without it has no `/metrics` at all, which is a 404 an
   * operator can diagnose rather than an endpoint that answers with nothing.
   */
  metrics?: () => MetricsExporter | undefined;
  /** What "send test notification" actually sends through (`N-14`). */
  tester?: NotificationTester;
  /**
   * Live state changes (`U-02`).
   *
   * Optional like the rest: absent, `/stream` is not registered and a client falls back to
   * reading — which is slower and correct, rather than a socket that connects and says nothing.
   */
  stream?: StateBroadcaster;
}

/**
 * The HTTP API.
 *
 * Fastify serialises every 2xx body with `fast-json-stringify` against the route's declared
 * response schema, which is the structural half of the credential defence: a property that is
 * not in the schema is dropped even if a repository leaks it. A startup assertion refuses to
 * serve any 2xx route that has no response schema, so that defence cannot be skipped by
 * forgetting one.
 */
export class ApiServer {
  readonly #app: FastifyInstance;
  readonly #config: CoreConfig['api'];
  readonly #logger: Logger;
  readonly #history: HistoryService;
  readonly #stateLog: StateLogService;
  readonly #alarms: AlarmService;
  readonly #db: Database;
  readonly #audit: AuditRepository;
  readonly #build: BuildStamp;
  /** Computed once: a validator issued by this process must match the next one it checks. */
  readonly #validatorSalt: string;
  readonly #catalogue: SensorCatalogue;
  readonly #lookups: LookupCatalogue;
  readonly #maps: MapService | undefined;
  readonly #mapResolver: MapResolver | undefined;
  readonly #libraries: LibraryService | undefined;
  /** Per share link, because the global limiter already bounds per address (`G-06`). */
  readonly #shareLimit = new ShareRateLimit();
  readonly #mapTiles: { urlTemplate: string; attribution: string } | undefined;
  readonly #reports: ApiServerOptions['reports'];
  readonly #schedules: ScheduleService | undefined;
  readonly #discovery: DiscoveryService | undefined;
  readonly #deviceTemplates: DeviceTemplateCatalogue | undefined;
  readonly #provision: ApiServerOptions['provision'];
  readonly #rediscovery: RediscoveryService | undefined;
  readonly #probeRegistry: ProbeRegistry | undefined;
  readonly #queries: ProbeQueryService | undefined;
  readonly #probeConfig: ProbeConfigService | undefined;
  readonly #auth: ApiServerOptions['auth'];
  readonly #triggers: TriggerService | undefined;
  readonly #templates: TemplateService | undefined;
  readonly #deliveryHealth: DeliveryHealthReader | undefined;
  readonly #coreHealth: (() => CoreHealthService | undefined) | undefined;
  readonly #probeHealth: (() => ProbeHealthService | undefined) | undefined;
  readonly #metrics: (() => MetricsExporter | undefined) | undefined;
  readonly #tester: NotificationTester | undefined;
  readonly #stream: StateBroadcaster | undefined;
  readonly #undeclared: string[] = [];
  /** Routes that declared no `access`, which makes `build` throw (`A-11`). */
  readonly #unauthorized: string[] = [];
  /**
   * Routes exempted from the response-schema guard, and why each one is.
   *
   * Recorded rather than skipped silently: the guard is the structural half of the credential
   * defence, and an exemption nobody can enumerate is an exemption nobody reviews. It is logged
   * at startup and asserted in a test. The reason travels with the route because two exemptions
   * with different justifications — bytes off disk, and a text format that is not JSON — are two
   * decisions, and a boolean would have collapsed them into one.
   */
  readonly #unfiltered: { route: string; why: string }[] = [];
  readonly #routes: {
    method: string;
    url: string;
    access: RouteAccess;
    changes: boolean;
    rightsIn?: string;
    audit?: AuditDeclaration;
  }[] = [];
  /** Non-null while registering routes that are exempt, holding the reason. */
  #exempting: string | null = null;
  /**
   * The authorisation stamped onto routes a plugin registers for us (`A-11`).
   *
   * `fastify-static` registers its own route, so there is nowhere to write a `config` on it. The
   * declaration is made here instead, next to the registration it covers, rather than letting
   * the plugin's route fall through the guard as an unnamed exception.
   */
  #exemptAccess: RouteAccess | null = null;

  constructor(options: ApiServerOptions) {
    this.#config = options.config;
    this.#logger = options.logger.child({ component: 'api' });
    this.#history = options.history;
    // Built here rather than injected: it is a query over one table with no configuration, and
    // a second constructor argument for it would be ceremony (`M-15`).
    this.#stateLog = new StateLogService({ db: options.db, logger: this.#logger });
    this.#alarms = new AlarmService({ db: options.db, logger: this.#logger });
    this.#db = options.db;
    this.#audit = options.audit;
    this.#build = options.build ?? {
      version: options.version,
      commit: null,
      dirty: false,
      profile: DEVELOPMENT_PROFILE,
    };
    this.#validatorSalt = validatorSalt(this.#build, randomUUID());
    this.#catalogue = options.catalogue;
    this.#lookups = options.lookups ?? new LookupCatalogue().seal();
    this.#maps = options.maps;
    this.#mapResolver = options.mapResolver;
    this.#libraries = options.libraries;
    this.#mapTiles = options.mapTiles;
    this.#reports = options.reports;
    this.#schedules = options.schedules;
    this.#discovery = options.discovery;
    this.#deviceTemplates = options.deviceTemplates;
    this.#provision = options.provision;
    this.#rediscovery = options.rediscovery;
    this.#probeRegistry = options.probeRegistry;
    this.#queries = options.queries;
    this.#probeConfig = options.probeConfig;
    this.#auth = options.auth;
    this.#triggers = options.triggers;
    this.#templates = options.templates;
    this.#deliveryHealth = options.deliveryHealth;
    this.#coreHealth = options.coreHealth;
    this.#probeHealth = options.probeHealth;
    this.#metrics = options.metrics;
    this.#tester = options.tester;
    this.#stream = options.stream;

    this.#app = Fastify({
      logger: false, // pino is configured centrally; Fastify's own instance would double-log
      ajv: {
        customOptions: {
          coerceTypes: true,
          allErrors: true,
          removeAdditional: false,
          useDefaults: true,
        },
      },
      // A request id per request, so every log line from a handler ties back to it.
      genReqId: () => newCorrelationId(),
    });

    // Installed in the constructor, not in build(), so it sees *every* route — including any
    // registered by a plugin before our own. A guard with a blind spot is not a guard.
    this.#app.addHook('onRoute', (route) => {
      if (route.method === 'HEAD' || route.method === 'OPTIONS') return;
      // Bounded to the registration that sets it: the static plugin serves bytes off disk and
      // `/metrics` serves a text format, and `fast-json-stringify` has nothing to filter in
      // either. Everything else must declare its responses.
      // **Who may call it, checked before any exemption** (`A-11`). The response-schema guard
      // has two justified exemptions — bytes off disk, and a text format that is not JSON —
      // and neither of them is a reason for nobody to have decided who may call the route. A
      // route that says nothing stops the build, exactly as a missing response schema does,
      // because the failure it hides is silent and total.
      if (this.#exemptAccess !== null && route.config?.access === undefined) {
        route.config = { ...route.config, access: this.#exemptAccess };
      }
      if (route.config?.access === undefined) {
        this.#unauthorized.push(`${String(route.method)} ${route.url}`);
      }
      if (this.#exempting !== null) {
        this.#unfiltered.push({
          route: `${String(route.method)} ${route.url}`,
          why: this.#exempting,
        });
      } else if ((route.schema as { response?: unknown } | undefined)?.response === undefined) {
        this.#undeclared.push(`${String(route.method)} ${route.url}`);
      }
      // **Listed whether or not it is exempt from the response schema** (`A-12`). An exemption
      // is about what the body is, not about who may read it — and returning early here once left
      // `/metrics` and a map's background out of every sweep that walks this list.
      const access = route.config?.access;
      if (access === undefined) return;
      // A route says so when it changes nothing; everything else is assumed to.
      const changes = route.config?.changes ?? true;
      // And where the right on its subject is decided, when that is not the object tree (`A-14`).
      const rightsIn = route.config?.rightsIn;
      // And why it writes no audit entry, when it does not (`A-17`).
      const audit = route.config?.audit;
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        this.#routes.push({
          method,
          url: route.url,
          access,
          changes,
          ...(rightsIn === undefined ? {} : { rightsIn }),
          ...(audit === undefined ? {} : { audit }),
        });
      }
    });
  }

  get app(): FastifyInstance {
    return this.#app;
  }

  /** Routes exempted from the response-schema guard. Asserted in a test, so it stays reviewed. */
  get unfilteredRoutes(): readonly string[] {
    return this.#unfiltered.map((one) => one.route);
  }

  /**
   * Every route this instance registered.
   *
   * Exposed so `A-10` can sweep *all* of them for a credential rather than a list somebody
   * maintains by hand — a hand-maintained list is exactly the thing that goes stale the day a
   * route is added, which is the day the test was supposed to catch it.
   *
   * **Each carries the authorisation it declared** (`A-11`), so the sweep can assert the bar a
   * route set *and* that the bar is enforced. Reading the declaration back is what lets the test
   * fail on a route nobody has written yet: a new `POST` that declares `read` is caught by the
   * shape of its own declaration, without anybody adding it to a list.
   */
  get routes(): readonly {
    method: string;
    url: string;
    access: RouteAccess;
    changes: boolean;
    rightsIn?: string;
    audit?: AuditDeclaration;
  }[] {
    return this.#routes;
  }

  /**
   * A scrape body without the series of probes this reader cannot see (`A-12`).
   *
   * The registry is one shared object, rendered once for everybody, so the filter is over the
   * rendered lines: every per-probe series carries `probe="<id>"`, and a probe carved out of the
   * reader's view takes its name and its counts with it. Everything else is the installation's
   * own and stays — the route already required read on the root to get this far.
   */
  async #withoutHiddenProbes(body: string, visibility: Visibility): Promise<string> {
    if (visibility.everything) return body;
    const values: unknown[] = [];
    const visible = visibility.where('o.id', (value) => `$${String(values.push(value))}`);
    const rows = await this.#db.query<{ id: string }>(
      `SELECT o.id::text AS id FROM object o WHERE o.kind = 'probe' AND ${visible}`,
      values,
    );
    const seen = new Set(rows.map((row) => row.id));
    return body
      .split('\n')
      .filter((line) => {
        const probe = /[{,]probe="([^"]*)"/.exec(line)?.[1];
        return probe === undefined || seen.has(probe);
      })
      .join('\n');
  }

  async build(version: string, service: ObjectService): Promise<void> {
    for (const schema of [
      ...SHARED_SCHEMAS,
      ...HISTORY_SCHEMAS,
      ...AUDIT_SCHEMAS,
      ...STATE_SCHEMAS,
      ...ALARM_SCHEMAS,
      ...LOOKUP_SCHEMAS,
      ...PAUSE_SCHEMAS,
      ...SCHEDULE_SCHEMAS,
      ...LIBRARY_SCHEMAS,
      ...STATE_LOG_SCHEMAS,
      ...TRIGGER_SCHEMAS,
      ...TEMPLATE_SCHEMAS,
      ...NOTIFICATION_SCHEMAS,
      ...QUERY_SCHEMAS,
    ])
      this.#app.addSchema(schema);

    // **Security headers on everything, including the app shell and the error pages** (`A-09`).
    // Registered first so nothing can answer without them.
    // The tile provider's origin, and nothing else, joins `img-src` (`ADR-004`). A template
    // that does not parse adds nothing rather than breaking the policy.
    const tileOrigin = originOf(this.#mapTiles?.urlTemplate ?? '');
    registerSecurityHeaders(this.#app, tileOrigin === null ? {} : { imageOrigins: [tileOrigin] });

    // Rate limiting sits *after* authentication in registration order, so it can key by account
    // where there is one — everybody behind one NAT would otherwise share a bucket.
    // CSRF is checked before any handler runs.

    // **Before the routes, and before anything else that could answer.** A hook added here runs
    // for every request the instance ever serves; adding it after a route would leave that route
    // unauthenticated, which is a guard with a blind spot (`A-01`).
    if (this.#auth !== undefined) {
      registerAuthentication(this.#app, {
        sessions: this.#auth.sessions,
        tokens: this.#auth.tokens,
        logger: this.#logger,
        required: this.#auth.required,
        // **The one unauthenticated namespace** (`G-06`, `ADR-002`). A prefix rather than an
        // exact path because a share token lives in the URL; narrow enough that the whole public
        // surface is one file and one prefix.
        ...(this.#maps !== undefined && this.#mapResolver !== undefined
          ? { publicPrefixes: [PUBLIC_MAP_PREFIX] }
          : {}),
      });
      registerCsrfGuard(this.#app, {
        logger: this.#logger,
        allowedOrigins: this.#config.allowedOrigins,
      });
      registerRateLimit(this.#app, { logger: this.#logger });
      // **After authentication, before every route** (`A-11`). Authentication answers who this
      // is; this answers whether they may. Both are global hooks for the same reason: a check
      // wired per route is a check the next route forgets.
      registerAuthorization(this.#app, {
        access: this.#auth.access,
        required: this.#auth.required,
      });
    }

    // Before the routes, because a route declared `websocket: true` needs the plugin in place.
    // Registered only when there is something to stream: the plugin hooks the upgrade path, and
    // a build with no state service has nothing to say over it.
    // The payload cap is `ws`'s own, and its default is 100 MiB per frame (`P-217`).
    if (this.#stream !== undefined) {
      await this.#app.register(fastifyWebsocket, {
        options: { maxPayload: STREAM_MAX_PAYLOAD_BYTES },
      });
    }

    await this.#app.register(fastifySwagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'MonitoringSystem API',
          version,
          description:
            'Object tree, settings and credentials. Monitored-device credentials are ' +
            'write-only: no route returns a secret, to anyone.\n\n' +
            'Live state changes are pushed over a WebSocket at `GET /api/v1/stream`, which is ' +
            'not listed below: `@fastify/swagger` does not describe routes that upgrade. Send ' +
            '`{"subscribe":{"objectId":42}}` to scope it to a subtree, or `{"subscribe":{}}` ' +
            'for everything; the server answers with a `snapshot` frame and then one `state` ' +
            'frame per change. Subscribing again is how a client resyncs.',
        },
      },
    });

    this.#app.addHook('onRequest', (request, _reply, done) => {
      withCorrelation({ requestId: request.id }, done);
    });

    this.#app.setErrorHandler((error: FastifyError, request, reply) => {
      // Fastify's own schema failures arrive here; map them onto the same envelope so a client
      // never has to parse two error shapes.
      const mapped =
        error.validation === undefined
          ? toHttpError(error, request.id)
          : {
              status: 400,
              body: {
                error: {
                  code: 'OBJECT_INVALID',
                  message: error.message,
                  context: { phase: 'validate-request' },
                  details: { problems: error.validation },
                  correlationId: request.id,
                },
              },
            };

      logIfUnexpected(this.#logger, error, mapped.status);
      void reply.status(mapped.status).send(mapped.body);
    });

    this.#app.setNotFoundHandler((request, reply) => {
      // A deep link into the single-page app — /objects/42 — is a route in the browser's
      // router, not here. Anything that is not an API call and is not asking for JSON gets the
      // app shell; the API keeps answering 404 with a body a client can parse.
      if (
        this.#config.webRoot !== '' &&
        request.method === 'GET' &&
        !request.url.startsWith('/api/') &&
        !(request.headers.accept ?? '').includes('application/json')
      ) {
        void reply.type('text/html').sendFile('index.html');
        return;
      }

      void reply.status(404).send({
        error: {
          code: 'ROUTE_NOT_FOUND',
          message: `no route for ${request.method} ${request.url}`,
          context: {},
          details: {},
          correlationId: request.id,
        },
      });
    });

    await this.#app.register(
      async (scope) => {
        await scope.register(objectRoutes, {
          service,
          validatorSalt: this.#validatorSalt,
          // Built here rather than taken as an option: it holds no state and wraps the service
          // it is given, so there is nothing for a caller to configure or get wrong (`D-09`).
          bulk: new BulkService({ objects: service, logger: this.#logger }),
          // The bulk route resolves a right per id in the selection; every other object route
          // is guarded by the global hook from its path (`A-11`). It is handed the same
          // `required` flag the hook reads, because a per-object check that stays on while the
          // hook stands down refuses ids that every other route in the installation allows
          // (`R10`).
          ...(this.#auth === undefined
            ? {}
            : { access: this.#auth.access, authorizing: this.#auth.required }),
        });
        await scope.register(historyRoutes, { history: this.#history });
        if (this.#queries !== undefined && this.#probeConfig !== undefined) {
          await scope.register(queryRoutes, {
            queries: this.#queries,
            probeConfig: this.#probeConfig,
          });
        }
        await scope.register(stateRoutes, { db: this.#db });
        await scope.register(stateLogRoutes, { log: this.#stateLog });
        alarmRoutes(scope, { alarms: this.#alarms });
        await scope.register(auditRoutes, { db: this.#db, audit: this.#audit });
        await scope.register(sensorTypeRoutes, { catalogue: this.#catalogue });
        await scope.register(lookupRoutes, { lookups: this.#lookups });
        if (this.#maps !== undefined) {
          mapRoutes(scope, {
            maps: this.#maps,
            ...(this.#mapResolver === undefined ? {} : { resolver: this.#mapResolver }),
            ...(this.#mapTiles === undefined ? {} : { tiles: this.#mapTiles }),
          });
          // The one map route that answers bytes rather than JSON (`G-05`). Exempted from the
          // response-schema rule for the same reason the static plugin is, and registered on its
          // own so the exemption covers this route and not the eight beside it.
          this.#exempting = 'a stored image, with no JSON to filter';
          mapBackgroundRoute(scope, { maps: this.#maps });
          this.#exempting = null;

          // The public surface (`G-06`). Registered only when there is a resolver to fill the
          // widgets in: a share link answering with an empty canvas is worse than one that does
          // not exist.
          if (this.#mapResolver !== undefined) {
            const shared = {
              maps: this.#maps,
              resolver: this.#mapResolver,
              limit: this.#shareLimit,
              ...(this.#mapTiles === undefined ? {} : { tiles: this.#mapTiles }),
            };
            publicMapRoutes(scope, shared);
            this.#exempting = 'a stored image, with no JSON to filter';
            publicMapBackgroundRoute(scope, shared);
            this.#exempting = null;
          }
        }
        if (this.#reports !== undefined) {
          const wired = {
            reports: this.#reports.service,
            context: this.#reports.context,
            renderer: this.#reports.renderer,
            runner: this.#reports.runner,
            runs: this.#reports.runs,
            outputStore: this.#reports.outputStore,
            formatter: this.#reports.formatter,
            db: this.#db,
          };
          reportRoutes(scope, wired);
          // The one report route that answers text rather than JSON (`E-04`). Exempted from the
          // response-schema rule for the reason the map background is, and registered on its own
          // so the exemption covers this route and not the seven beside it.
          this.#exempting = 'a rendered report, as a document rather than JSON';
          reportRenderRoute(scope, wired);
          reportDownloadRoute(scope, wired);
          this.#exempting = null;
        }
        if (this.#libraries !== undefined) {
          libraryRoutes(scope, { libraries: this.#libraries });
        }
        if (this.#schedules !== undefined) {
          await scope.register(scheduleRoutes, { schedules: this.#schedules });
        }
        if (this.#discovery !== undefined) {
          await scope.register(discoveryRoutes, {
            discovery: this.#discovery,
            ...(this.#provision === undefined ? {} : { provision: this.#provision }),
            ...(this.#rediscovery === undefined ? {} : { rediscovery: this.#rediscovery }),
          });
        }
        if (this.#probeRegistry !== undefined) {
          await scope.register(probeRoutes, { registry: this.#probeRegistry });
        }
        if (this.#auth !== undefined) {
          const auth = this.#auth;
          await scope.register(authRoutes, {
            accounts: auth.accounts,
            sessions: auth.sessions,
            throttle: auth.throttle,
            totp: auth.totp,
            // The same flag `registerAuthentication` enforces, so `GET /auth/session` reports
            // what is actually in force rather than a second copy of it.
            requireAuthentication: auth.required,
            logger: this.#logger,
          });
          await scope.register(groupRoutes, { groups: auth.groups });
          await scope.register(accessRoutes, { access: auth.access, accounts: auth.accounts });
          await scope.register(tokenRoutes, { tokens: auth.tokens });
        }
        if (this.#deviceTemplates !== undefined) {
          const templates = this.#deviceTemplates;
          await scope.register(deviceTemplateRoutes, {
            templates,
            ...(this.#discovery === undefined ? {} : { discovery: this.#discovery }),
            sensorsOf: (deviceId, visibility) =>
              sensorsOfDevice(this.#db, this.#catalogue, deviceId, visibility),
            credentialKindsFor: (sensorType) =>
              this.#catalogue.has(sensorType)
                ? (this.#catalogue.declaration(sensorType).credentialKinds ?? [])
                : [],
          });
        }
        if (this.#triggers !== undefined) {
          await scope.register(triggerRoutes, { triggers: this.#triggers });
        }
        if (this.#templates !== undefined) {
          await scope.register(templateRoutes, {
            templates: this.#templates,
            ...(this.#tester === undefined ? {} : { tester: this.#tester }),
          });
        }
        if (this.#stream !== undefined) {
          await scope.register(streamRoutes, { db: this.#db, stream: this.#stream });
        }
        if (this.#deliveryHealth !== undefined) {
          await scope.register(notificationRoutes, {
            db: this.#db,
            health: this.#deliveryHealth,
          });
        }
        if (this.#coreHealth !== undefined) {
          healthRoutes(scope, {
            coreHealth: this.#coreHealth,
            ...(this.#probeHealth === undefined ? {} : { probeHealth: this.#probeHealth }),
          });
        }
      },
      { prefix: '/api/v1' },
    );

    /**
     * The Prometheus scrape endpoint (`P-14`).
     *
     * **At `/metrics` rather than under `/api/v1`**, because that is the path every scraper
     * config, service-discovery rule and Helm chart in the world already assumes, and a
     * monitoring system that made people configure a non-standard path would be picking a fight
     * it cannot win.
     *
     * **Which means it must be guarded here, explicitly.** `registerAuthentication` only guards
     * paths under `/api/`, on the reasoning that the app shell has to be public — so a route
     * outside that prefix is public by default. That default is right for `index.html` and wrong
     * for this: the scrape body carries every queue depth, the sensor counts per probe and the
     * probe names, which together is a map of the installation. A scraper authenticates with an
     * API token (`A-06`), which is what `authorization` in a Prometheus `scrape_config` is for.
     *
     * Exempt from the response-schema rule for the same reason the OpenAPI document is: the body
     * is a text format, and serialising it as JSON would destroy it.
     */
    if (this.#metrics !== undefined) {
      const metrics = this.#metrics;
      this.#exempting = 'the Prometheus text format, which is not JSON to filter';
      this.#app.get(
        '/metrics',
        {
          // Read, and a token scoped to read is enough: a scraper never writes. Declared like
          // every other route now rather than checked inline in the handler (`A-11`) — the
          // inline check was correct and was also the only one in the installation.
          //
          // **Read on the root, not merely a login** (`A-12`). The body names every probe and
          // counts its sensors; an account granted one branch was not given that, and the
          // installation's own queue depths are not a branch's either.
          config: INSTALLATION,
          schema: {
            tags: ['meta'],
            summary: 'Prometheus scrape endpoint — text format, not JSON',
            description:
              'Outside `/api/v1` because that is the path every scraper config already ' +
              'assumes, and guarded here explicitly because of it: the scrape body is a map of ' +
              'the installation, and a route outside that prefix would otherwise be public. A ' +
              'scraper authenticates with an API token, which is what `authorization` in a ' +
              'Prometheus `scrape_config` is for. 503 while the core is still starting, ' +
              'because an empty body would be recorded as every series vanishing at once.',
          },
        },
        async (request, reply) => {
          const exporter = metrics();
          if (exporter === undefined) {
            // 503 in the scraper's own terms: an empty body would be recorded as "every series
            // vanished", which is worse than a failed scrape it will simply retry.
            await reply
              .status(503)
              .header('content-type', 'text/plain; charset=utf-8')
              .send('# the core is still starting; scrape again shortly\n');
            return reply;
          }
          const { body, contentType } = await exporter.scrape();
          await reply
            .header('content-type', contentType)
            .send(await this.#withoutHiddenProbes(body, await visibilityOf(request)));
          return reply;
        },
      );
      this.#exempting = null;
    }

    // The OpenAPI document is exempt from the response-schema rule on purpose: it *is* a
    // schema document, and serialising it against a strict schema of our own would strip it.
    this.#app.get(
      '/api/v1/openapi.json',
      {
        config: READS,
        schema: {
          tags: ['meta'],
          summary: 'This API, as an OpenAPI 3 document',
          response: { 200: { type: 'object', additionalProperties: true } },
        },
      },
      () => this.#app.swagger(),
    );

    // **Which build is answering** (`H-11`). Every build said `0.1.0` until this existed, so a
    // bug report, a field test and an upgrade could not say what they were about. Read-scoped
    // like the OpenAPI document beside it: the exact commit tells an attacker which advisories
    // apply, and an unauthenticated caller has no use for it.
    this.#app.get(
      '/api/v1/build',
      {
        config: READS,
        schema: {
          tags: ['meta'],
          summary:
            'Which build is serving: its version, the commit it was packaged from, and what it ' +
            'contains',
          response: {
            200: {
              type: 'object',
              additionalProperties: false,
              required: ['version', 'commit', 'dirty', 'profile', 'subsystems'],
              properties: {
                version: { type: 'string' },
                commit: {
                  type: ['string', 'null'],
                  description:
                    'The full commit this build was packaged from; null when that is not ' +
                    'known — a working tree, or a package made before this route existed.',
                },
                dirty: {
                  type: 'boolean',
                  description:
                    'Packaged with uncommitted changes on top of `commit`, so the commit ' +
                    'names the nearest code rather than this code.',
                },
                profile: {
                  type: 'string',
                  enum: [...BUILD_PROFILES],
                  description:
                    'What the build was packaged to contain: `v1` is the release candidate, ' +
                    'without the v2 subsystems; `full` is everything.',
                },
                subsystems: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['maps', 'reports', 'libraries'],
                  description:
                    'Which optional subsystems this server constructed. One that is false has ' +
                    'no routes here at all, and a client should not offer it.',
                  properties: {
                    maps: { type: 'boolean' },
                    reports: { type: 'boolean' },
                    libraries: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
      // **What was constructed, not what the profile says should have been** (`H-12`). The web
      // UI hides what is false here, so it asks the thing that registers the routes rather than
      // a name for a set of them that could drift from it.
      () => ({
        ...this.#build,
        subsystems: {
          maps: this.#maps !== undefined,
          reports: this.#reports !== undefined,
          libraries: this.#libraries !== undefined,
        },
      }),
    );

    // The web UI, served by the core itself — ADR-001 Decision 8, no second web server to
    // install. Registered *after* the API so a file can never shadow a route, and rooted at an
    // absolute path so the plugin's traversal checks have something stable to resolve against.
    if (this.#config.webRoot !== '') {
      const root = resolve(this.#config.webRoot);
      this.#exempting = 'bytes off disk, with no JSON to filter';
      // **Public, and it has to be**: the login form is served from these bytes, so a shell that
      // needed a session could never be used to get one. It carries the client bundle and
      // nothing else — every datum it displays comes from an API route that is guarded.
      this.#exemptAccess = { kind: 'public' };
      await this.#app.register(fastifyStatic, {
        root,
        prefix: '/',
        // The hashed asset filenames Vite emits are content-addressed, so they can be cached
        // hard; index.html cannot, or an upgrade would serve last week's app forever.
        maxAge: '1y',
        immutable: true,
        index: ['index.html'],
        setHeaders(reply, path) {
          if (path.endsWith('index.html')) {
            reply.header('cache-control', 'no-cache');
          }
        },
      });
      this.#exempting = null;
      this.#exemptAccess = null;
      this.#logger.info({ webRoot: root, routes: this.unfilteredRoutes }, 'serving the web UI');
    }

    await this.#app.ready();
    this.#assertEveryRouteDeclaresItsResponses();
    this.#assertEveryRouteDeclaresItsAccess();
  }

  async start(): Promise<AddressInfo> {
    await this.#app.listen({ host: this.#config.host, port: this.#config.port });
    const address = this.#app.server.address() as AddressInfo;
    this.#logger.info({ host: address.address, port: address.port }, 'API listening');
    return address;
  }

  async stop(): Promise<void> {
    await this.#app.close();
    this.#logger.info('API stopped');
  }

  /**
   * A 2xx route without a response schema is not serialised against one, so it returns
   * whatever the handler happened to hand it — which is exactly how a secret escapes.
   * Refusing to start is the only enforcement that cannot be forgotten.
   */
  #assertEveryRouteDeclaresItsResponses(): void {
    if (this.#undeclared.length > 0) {
      throw new Error(
        `these routes have no response schema, so their bodies are not filtered: ${this.#undeclared.join(', ')}`,
      );
    }
  }

  /**
   * A route that declares no `access` is a route nobody decided the authorisation for (`A-11`).
   *
   * Refusing to start rather than defaulting either way. Defaulting to open is how every
   * mutating route in this installation came to be callable by a read-only account; defaulting
   * to closed would hide the omission behind a 403 that looks like a permissions problem.
   */
  #assertEveryRouteDeclaresItsAccess(): void {
    if (this.#unauthorized.length > 0) {
      throw new Error(
        `these routes declare no authorisation, so nobody decided who may call them: ${this.#unauthorized.join(', ')}`,
      );
    }
  }
}

/** Builds a ready-to-inject app without binding a socket. Used by the route tests. */
export async function buildApiServer(options: ApiServerOptions): Promise<ApiServer> {
  const server = new ApiServer(options);
  try {
    await server.build(options.version, options.service);
  } catch (error) {
    options.logger.error({ err: describeError(error) }, 'failed to build the API');
    throw error;
  }
  return server;
}

/**
 * A device's sensors, for save-as-template (`D-03`).
 *
 * Read straight rather than through `ObjectService`, because what is wanted is the *stored*
 * parameters: a template has to carry the settings forward, and the service's `redactedParams`
 * shape is right for an API response and wrong for a template.
 *
 * **It still redacts the credentials, and the comment that used to say it need not was wrong**
 * (`P-56`). It claimed "a monitored device's credentials live in the vault and never appear in
 * `params`". Two shipped types disprove it: `exe.script` and `exe.script.advanced` spread
 * `SCRIPT_SCHEMA`, whose `secret` is `writeOnly` and is read straight back out of
 * `context.params['secret']` to set `MS_SECRET`; and every SNMP type spreads
 * `SNMP_CREDENTIAL_SCHEMA`, whose `community`, `authKey` and `privKey` are `writeOnly` too. Those
 * live in `sensor_config.params`, and `POST /objects/:id/as-template` returned them in cleartext
 * to anyone who could reach the route — the exact thing CLAUDE.md says never happens to anyone,
 * administrators included.
 *
 * The catalogue does the stripping, so this shares one definition of "secret" with
 * `ObjectService.#redact` rather than keeping a second list that could drift.
 *
 * **And only the sensors the caller can see** (`A-23`). The route checks `read` on the device, and
 * a sensor carved `none` beneath it came back with its name, type and parameters all the same. The
 * device is visible, so its children need only `whereChildOfVisible`'s membership test, not a walk.
 */
export async function sensorsOfDevice(
  db: Database,
  catalogue: SensorCatalogue,
  deviceId: number,
  visibility: Visibility,
): Promise<
  { name: string; sensorType: string; params: Record<string, unknown>; isMaster: boolean }[]
> {
  const values: unknown[] = [deviceId];
  const visible = visibility.whereChildOfVisible(
    'o.id',
    (value) => `$${String(values.push(value))}`,
  );
  const rows = await db.query<{
    name: string;
    type: string;
    params: Record<string, unknown>;
    is_master: boolean;
  }>(
    // The master is a *setting on the device* pointing back at one of its sensors (`M-11`), so
    // it is read from there rather than from the sensor — which is also why `D-05` sets it by
    // calling `setDependency` on the sensor rather than writing a column.
    `SELECT o.name, sc.type, sc.params,
            COALESCE(s.value #>> '{}' = o.id::text, false) AS is_master
     FROM object o
     JOIN sensor_config sc ON sc.object_id = o.id
     LEFT JOIN object_setting s
       ON s.object_id = $1 AND s.key = 'dependency.masterId'
     WHERE o.parent_id = $1 AND o.kind = 'sensor' AND ${visible}
     ORDER BY o.id`,
    values,
  );
  return rows.map((row) => ({
    name: row.name,
    sensorType: row.type,
    // A type the catalogue does not know cannot be redacted against its schema, and shipping its
    // parameters on a guess is the failure this is fixing. Nothing is safer than nothing.
    params: catalogue.has(row.type) ? catalogue.redact(row.type, row.params).params : {},
    isMaster: row.is_master,
  }));
}

/**
 * The origin a tile template loads from, or `null` when it is not a usable template.
 *
 * Here rather than in the renderer because the policy is written at startup: a template with a
 * missing placeholder or a bad scheme widens nothing, which is the safe direction — the map then
 * draws no tiles and says so, instead of the browser refusing images the policy forgot to allow.
 */
function originOf(template: string): string | null {
  if (!template.includes('{z}') || !template.includes('{x}') || !template.includes('{y}')) {
    return null;
  }
  try {
    const url = new URL(template.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0'));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}
