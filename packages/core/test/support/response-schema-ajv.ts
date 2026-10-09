/**
 * The Ajv a route's response schema is checked with. Since `P-390` the server compiles every
 * response schema with it as the route registers, so it lives beside the request validator's
 * options in `src/api/validation.ts`, and the tests that check a body against a response schema
 * read the schema the same way through here.
 */
export { responseSchemaAjv } from '../../src/api/validation.js';
