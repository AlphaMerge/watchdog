import { Ajv, type AnySchema, type AnySchemaObject } from 'ajv';
import type {
  FastifyInstance,
  FastifySchemaValidationError,
  FastifyServerOptions,
  RouteOptions,
} from 'fastify';
import { patternMessageKeyword, patternMessageOf } from '@ms/shared';

/**
 * What Fastify's validator compiler builds its Ajv with, for every route's body, querystring,
 * params and headers alike (`@fastify/ajv-compiler` keeps one instance per set of options).
 *
 * Exported so that a test building routes on a bare Fastify validates as the server does
 * (`P-363`, `P-364`): a bare `Fastify()` has Ajv's defaults, which coerce differently, print a
 * strict-mode warning for every union type each time the routes are built, and refuse to compile
 * a schema carrying `x-patternMessage` at all.
 */
export const API_VALIDATOR_OPTIONS = {
  // **A route schema Ajv cannot read whole stops the build (`P-383`)**, as every other Ajv in the
  // source does since `P-379`. Ajv's default already refuses an unknown keyword, so a mistyped
  // one never compiled, but it only logs a keyword with no type to apply to and says nothing of a
  // `required` naming a property its schema does not declare. Strict refuses both, so
  // `fastify.ready()` rejects and the server never listens with such a schema. What a route
  // schema may carry beyond Ajv's own keywords is `apiSchemaKeywords()`, below.
  strict: true,
  coerceTypes: true,
  allErrors: true,
  removeAdditional: false,
  useDefaults: true,
  // **`type: ['string', 'array']` is meant (`P-337`).** A repeatable query parameter (`tag`,
  // `effective`) is a string for one occurrence and an array for several, and the handler reads
  // both through `asArray`. Without this, strict mode logs "use allowUnionTypes" each time the
  // object routes are built, once for each. It only lets the schema compile quietly: Ajv
  // validates a type list the same with it as without, and OpenAPI 3.1 carries the list as it is.
  allowUnionTypes: true,
  // **A pattern says a sentence, never its expression (`P-372`).** `verbose` puts the failing
  // keyword's schema on each error as `parentSchema`, which is where `x-patternMessage` is read
  // from. It also puts the refused value there as `data`, and the schema as `schema`: neither
  // leaves this process, because `requestProblem` copies out only the fields Ajv gives without
  // `verbose`, and a 400 is never logged (`logIfUnexpected` starts at 500).
  verbose: true,
  keywords: apiSchemaKeywords(),
};

/**
 * The keywords the API's schemas carry that are not Ajv's own (`P-383`): `x-patternMessage`,
 * declared as the sensor catalogue declares it (`U-53`), so strict mode admits it and refuses one
 * that is not a non-empty string, where an unknown keyword would refuse the schema outright.
 *
 * **The only one.** The annotations the schemas use besides — `description`, `default` and
 * `writeOnly` — are Ajv's own, and none uses OpenAPI's `example`, `nullable` or
 * `discriminator`, which would each have to be declared here.
 *
 * A fresh list on each call, so no two Ajvs hold one definition object; shared by the request
 * validator and `responseSchemaAjv`, so that each refuses what the other refuses.
 */
export function apiSchemaKeywords(): ReturnType<typeof patternMessageKeyword>[] {
  return [patternMessageKeyword()];
}

/**
 * A subschema that holds when every name given is present: for a `then`, a `not` or a branch of
 * an `anyOf` saying which fields go together.
 *
 * **Each name is declared `true` beside its `required`** (`P-379`, `P-383`). Strict mode refuses a
 * `required` that its own subschema does not declare (`strictRequired`), and the root's
 * `properties` is not that subschema. `true` constrains nothing, so this accepts and refuses what
 * `{ required: names }` would, and the API reference reads such a `properties` as saying nothing.
 */
export function present<const Names extends readonly string[]>(
  ...names: Names
): { readonly properties: Readonly<Record<Names[number], true>>; readonly required: Names } {
  return {
    properties: Object.fromEntries(names.map((name) => [name, true])) as Record<
      Names[number],
      true
    >,
    required: names,
  };
}

/**
 * An Ajv that reads a route's response schema as the request validator would read it (`P-383`,
 * `P-390`): strict, with the same keywords declared, so a mistyped keyword in it is a refusal
 * rather than a keyword nobody checks.
 *
 * Not `API_VALIDATOR_OPTIONS` itself: that coerces types and fills defaults, which would pass a
 * body the response schema does not describe. Union types are meant (`P-337`), and formats are not
 * checked: in a response schema a format tells the serialiser how to write a `Date`, and is not a
 * rule about the body.
 */
export function responseSchemaAjv(): Ajv {
  return new Ajv({
    strict: true,
    allowUnionTypes: true,
    validateFormats: false,
    keywords: apiSchemaKeywords(),
  });
}

/**
 * The `onRoute` hook that compiles each response schema of a route strict as it registers
 * (`P-390`), telling `refuse` of each one the request validator would refuse, so that the server
 * can refuse to start on it.
 *
 * **Why it is needed.** Fastify serialises a response with `fast-json-stringify`, which builds its
 * own Ajv with `strictSchema: false` and `validateSchema: false` forced after any options given.
 * A `maxLenght` in a response schema is therefore ignored at registration whatever the server
 * sets, and the serialiser writes the field unchecked; until this, only a test walked them.
 *
 * Called with the route's scope as `this`, as Fastify calls `onRoute`, so a `$ref` resolves to the
 * shared schemas that scope can see, a plugin's own included. **One Ajv for every scope whose
 * shared schemas agree**: a child scope holds its parent's schemas as the same objects, so the
 * core's plugins share one, and a shared schema is compiled once however many routes in however
 * many plugins reach it. A scope that gives an `$id` a different schema gets an Ajv of its own.
 * A schema object two routes share is compiled once too (Ajv caches by object), and only what a
 * response reaches is compiled. A `HEAD` is passed over: the one Fastify adds for a `GET` carries
 * the `GET`'s schema, which would be told twice.
 */
export function strictResponseSchemas(
  refuse: (problem: string) => void,
): (this: FastifyInstance, route: RouteOptions) => void {
  /** An Ajv and the shared schemas it holds, by `$id`. */
  interface Pool {
    readonly ajv: Ajv;
    readonly held: Map<string, unknown>;
  }
  const pools: Pool[] = [];
  const byScope = new WeakMap<FastifyInstance, Pool>();
  return function (this: FastifyInstance, route: RouteOptions): void {
    const responses = (route.schema as { response?: unknown } | undefined)?.response;
    if (typeof responses !== 'object' || responses === null || route.method === 'HEAD') return;
    const method = Array.isArray(route.method) ? route.method.join(',') : route.method;
    const refused = (where: string, error: unknown): void => {
      refuse(
        `${method} ${route.url} ${where}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    };

    const shared = Object.entries(this.getSchemas());
    const agrees = (pool: Pool): boolean =>
      shared.every(([id, schema]) => !pool.held.has(id) || pool.held.get(id) === schema);
    let scope = byScope.get(this);
    if (scope === undefined || !agrees(scope)) {
      scope = pools.find(agrees);
      if (scope === undefined) {
        scope = { ajv: responseSchemaAjv(), held: new Map() };
        pools.push(scope);
      }
      byScope.set(this, scope);
    }
    for (const [id, schema] of shared) {
      if (scope.held.has(id)) continue;
      scope.held.set(id, schema);
      try {
        scope.ajv.addSchema(schema as AnySchemaObject, id);
      } catch (error) {
        refused(`shared schema ${id}`, error);
      }
    }

    for (const [status, response] of Object.entries(responses as Record<string, unknown>)) {
      // `{ content: { 'application/json': { schema } } }` is Fastify's per-media-type form.
      const content = (response as { content?: unknown } | null)?.content;
      const schemas =
        typeof content === 'object' && content !== null
          ? Object.entries(content as Record<string, { schema?: unknown }>).map(
              ([media, each]) => [`${status} ${media}`, each.schema] as const,
            )
          : [[status, response] as const];
      for (const [where, schema] of schemas) {
        try {
          scope.ajv.compile(schema as AnySchema);
        } catch (error) {
          refused(`response ${where}`, error);
        }
      }
    }
  };
}

/**
 * One refusal as a 400's `details.problems` carries it: the fields Ajv gives an error without
 * `verbose`, which is the shape the API served before `P-372`, with a `pattern`'s message the
 * sentence its schema gives.
 *
 * **Never the value.** `params` and `propertyName` hold the schema's words, and the name of a key
 * the client sent where that key is what was refused (`additionalProperties`, `propertyNames`);
 * `verbose`'s `data`, `schema` and `parentSchema` are left behind.
 */
export interface RequestProblem {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly params: Record<string, unknown>;
  readonly propertyName?: string;
  readonly message: string;
}

export function requestProblem(error: FastifySchemaValidationError): RequestProblem {
  const propertyName: unknown = (error as { propertyName?: unknown }).propertyName;
  return {
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    params: error.params,
    ...(typeof propertyName === 'string' ? { propertyName } : {}),
    message: patternMessageOf(error) ?? error.message ?? 'is invalid',
  };
}

/**
 * Fastify's `schemaErrorFormatter`: the 400's `message`, as Fastify's default spells it —
 * `body/processing/scaleMul must be …`, each refusal joined by a comma — but with each message
 * `requestProblem`'s, so a failed `pattern` says the sentence there too (`P-372`).
 */
export const sayRequestRefusal: NonNullable<FastifyServerOptions['schemaErrorFormatter']> = (
  errors,
  dataVar,
) =>
  new Error(
    errors
      .map((error) => `${dataVar}${error.instancePath} ${requestProblem(error).message}`)
      .join(', '),
  );
