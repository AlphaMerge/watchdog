import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describeError, newCorrelationId, withCorrelation, type Logger } from '@ms/shared';
import type { CoreConfig } from '@ms/shared';
import type { SensorCatalogue } from '@ms/sensors';
import type { ObjectService } from '../objects/service.js';
import type { AuditRepository } from '../audit/store.js';
import type { Database } from '../db/pool.js';
import type { HistoryService } from '../timeseries/history.js';
import { logIfUnexpected, toHttpError } from './errors.js';
import { auditRoutes } from './routes/audit.js';
import { historyRoutes } from './routes/history.js';
import { objectRoutes } from './routes/objects.js';
import { sensorTypeRoutes } from './routes/sensor-types.js';
import { lookupRoutes } from './routes/lookups.js';
import { stateRoutes } from './routes/state.js';
import { AUDIT_SCHEMAS } from './schemas/audit.js';
import { HISTORY_SCHEMAS } from './schemas/history.js';
import { LookupCatalogue } from '../lookups/catalogue.js';
import { LOOKUP_SCHEMAS } from './schemas/lookups.js';
import { PAUSE_SCHEMAS } from './schemas/pause.js';
import { STATE_SCHEMAS } from './schemas/state.js';
import { SHARED_SCHEMAS } from './schemas/objects.js';

export interface ApiServerOptions {
  config: CoreConfig['api'];
  logger: Logger;
  version: string;
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
  readonly #db: Database;
  readonly #audit: AuditRepository;
  readonly #catalogue: SensorCatalogue;
  readonly #lookups: LookupCatalogue;
  readonly #undeclared: string[] = [];
  /**
   * Routes exempted from the response-schema guard because they serve files, not JSON.
   *
   * Recorded rather than skipped silently: the guard is the structural half of the credential
   * defence, and an exemption nobody can enumerate is an exemption nobody reviews. It is logged
   * at startup and asserted in a test.
   */
  readonly #assetRoutes: string[] = [];
  #registeringAssets = false;

  constructor(options: ApiServerOptions) {
    this.#config = options.config;
    this.#logger = options.logger.child({ component: 'api' });
    this.#history = options.history;
    this.#db = options.db;
    this.#audit = options.audit;
    this.#catalogue = options.catalogue;
    this.#lookups = options.lookups ?? new LookupCatalogue().seal();

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
      // The static plugin serves bytes off disk; `fast-json-stringify` has nothing to filter
      // and no schema to filter it against. The exemption is bounded to the one registration.
      if (this.#registeringAssets) {
        this.#assetRoutes.push(`${String(route.method)} ${route.url}`);
        return;
      }
      const schema = route.schema as { response?: unknown } | undefined;
      if (schema?.response === undefined) {
        this.#undeclared.push(`${String(route.method)} ${route.url}`);
      }
    });
  }

  get app(): FastifyInstance {
    return this.#app;
  }

  /** Routes exempted from the response-schema guard because they serve files. Asserted in a test. */
  get assetRoutes(): readonly string[] {
    return this.#assetRoutes;
  }

  async build(version: string, service: ObjectService): Promise<void> {
    for (const schema of [
      ...SHARED_SCHEMAS,
      ...HISTORY_SCHEMAS,
      ...AUDIT_SCHEMAS,
      ...STATE_SCHEMAS,
      ...LOOKUP_SCHEMAS,
      ...PAUSE_SCHEMAS,
    ])
      this.#app.addSchema(schema);

    await this.#app.register(fastifySwagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'MonitoringSystem API',
          version,
          description:
            'Object tree, settings and credentials. Monitored-device credentials are ' +
            'write-only: no route returns a secret, to anyone.',
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
        await scope.register(objectRoutes, { service, buildVersion: version });
        await scope.register(historyRoutes, { history: this.#history });
        await scope.register(stateRoutes, { db: this.#db });
        await scope.register(auditRoutes, { db: this.#db, audit: this.#audit });
        await scope.register(sensorTypeRoutes, { catalogue: this.#catalogue });
        await scope.register(lookupRoutes, { lookups: this.#lookups });
      },
      { prefix: '/api/v1' },
    );

    // The OpenAPI document is exempt from the response-schema rule on purpose: it *is* a
    // schema document, and serialising it against a strict schema of our own would strip it.
    this.#app.get(
      '/api/v1/openapi.json',
      { schema: { response: { 200: { type: 'object', additionalProperties: true } } } },
      () => this.#app.swagger(),
    );

    // The web UI, served by the core itself — ADR-001 Decision 8, no second web server to
    // install. Registered *after* the API so a file can never shadow a route, and rooted at an
    // absolute path so the plugin's traversal checks have something stable to resolve against.
    if (this.#config.webRoot !== '') {
      const root = resolve(this.#config.webRoot);
      this.#registeringAssets = true;
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
      this.#registeringAssets = false;
      this.#logger.info({ webRoot: root, routes: this.#assetRoutes }, 'serving the web UI');
    }

    await this.#app.ready();
    this.#assertEveryRouteDeclaresItsResponses();
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
