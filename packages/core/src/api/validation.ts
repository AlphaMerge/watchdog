import type { FastifySchemaValidationError, FastifyServerOptions } from 'fastify';
import { PATTERN_MESSAGE, patternMessageOf } from '@ms/sensors';

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
  // Declared as the sensor catalogue declares it (`U-53`): strict mode then admits the keyword
  // and refuses one that is not a non-empty string, where an unknown keyword would refuse the
  // route's schema outright.
  keywords: [{ keyword: PATTERN_MESSAGE, metaSchema: { type: 'string', minLength: 1 } }],
};

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
