import { Ajv } from 'ajv';
import { apiSchemaKeywords } from '../../src/api/validation.js';

/**
 * An Ajv for checking a body against a route's response schema, as the server's own validator
 * would read that schema (`P-383`): strict, with the same keywords declared, so a schema it
 * compiles is one the request validator would compile too, and a mistyped keyword in it is a
 * failure rather than a keyword nobody checks.
 *
 * Not `API_VALIDATOR_OPTIONS` itself: that coerces types and fills defaults, which would pass a
 * body the response schema does not describe. Union types are meant (`P-337`), and formats are not
 * checked, as these tests never did.
 */
export function responseSchemaAjv(): Ajv {
  return new Ajv({
    strict: true,
    allowUnionTypes: true,
    validateFormats: false,
    keywords: apiSchemaKeywords(),
  });
}
