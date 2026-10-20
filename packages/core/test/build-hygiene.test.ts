import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { coreHealth, CREDENTIAL_KINDS, probeHealth } from '@ms/sensors';
import { healthForPeer, PROTOCOL_VERSION, versionFor, type ProbeHealthReport } from '@ms/shared';
import { BUILT_IN_LOOKUPS } from '../src/lookups/built-in.js';
import { notificationMethods } from '../src/notifications/methods.js';
import { coreCatalogue } from '../src/profile.js';
import { sortedAliases, templateLiterals } from './support/sql-order-aliases.js';

/**
 * `tsc -b` is incremental and never deletes output for a source file that has gone away.
 *
 * For a test that means it keeps running for ever, against whatever the code looked like when it
 * was last compiled — two throwaway files from the S-03 review were found still running here,
 * long after their sources were deleted. For anything under `src` it is worse: `scripts/
 * package.sh` copies `dist` wholesale, so a deleted module keeps shipping, and the pool loads
 * its registry *by path* — a stale one would be loadable in production.
 *
 * P-05 deleted `placeholder-registry.ts` and left exactly that behind, which is why this now
 * covers `src` as well as `test`, and every package rather than just this one.
 */
describe('build hygiene', () => {
  it('has no compiled file whose source has been deleted', async () => {
    // At runtime this file is <repo>/packages/core/dist/test/build-hygiene.test.js.
    const packagesRoot = join(import.meta.dirname, '..', '..', '..');
    const orphans: string[] = [];

    for (const pkg of await readdir(packagesRoot).catch(() => [])) {
      const dist = join(packagesRoot, pkg, 'dist');
      for (const area of ['src', 'test']) {
        await compare(join(dist, area), join(packagesRoot, pkg, area), (file) => {
          orphans.push(relative(packagesRoot, file));
        });
      }
    }

    assert.deepEqual(
      orphans,
      [],
      `compiled output with no source — delete it, or run "npm run clean" and rebuild:\n  ${orphans.join('\n  ')}`,
    );
  });

  /**
   * `P-21` moved the measured budgets out of `npm test` and behind `npm run test:perf`, which
   * buys an ordinary run that never reports a perf failure and costs the thing this checks: a
   * suite nothing runs automatically is a suite that can rot for weeks without anybody noticing.
   *
   * So the wiring is asserted rather than assumed. A new file under `test/perf/` that no script
   * globs, or a `test` script that quietly starts running them again, fails here — in the suite
   * that *does* run on every push.
   */
  it('has every perf test behind test:perf, and none of them in the ordinary run', async () => {
    const packagesRoot = join(import.meta.dirname, '..', '..', '..');
    const problems: string[] = [];

    for (const pkg of await readdir(packagesRoot).catch(() => [])) {
      const perfDir = join(packagesRoot, pkg, 'test', 'perf');
      const perfTests = (await readdir(perfDir).catch(() => [])).filter((name) =>
        name.endsWith('.test.ts'),
      );
      if (perfTests.length === 0) continue;

      const manifest = JSON.parse(
        await readFile(join(packagesRoot, pkg, 'package.json'), 'utf8'),
      ) as { scripts?: Record<string, string> };
      const scripts = manifest.scripts ?? {};

      if (scripts['test:perf'] === undefined) {
        problems.push(`${pkg} has ${String(perfTests.length)} perf tests and no test:perf script`);
      }
      // `dist/test/*.test.js` does not descend into `perf/`; `**` does, which is the mistake
      // this catches — it is one character and it puts the budgets back in the ordinary run.
      for (const key of ['test', 'test:unit']) {
        const script = scripts[key];
        if (script !== undefined && script.includes('dist/test/**')) {
          problems.push(`${pkg}'s ${key} script globs perf tests: ${script}`);
        }
      }
    }

    assert.deepEqual(problems, [], problems.join('\n  '));
  });

  /**
   * `P-192`: the root `test:perf` prints the conditions the budgets are measured under, because
   * the findings files were recording the host's load while the tests ran in a container that
   * disagreed with it by a factor of twenty.
   *
   * That only keeps working while the script is still invoked, and dropping it from the chain
   * fails silently in the worst way available: the run still passes, the numbers still look like
   * numbers, and the one line saying what they were measured against is gone.
   */
  it('takes the conditions before it measures anything', async () => {
    const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
    const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    const script = manifest.scripts?.['test:perf'];
    assert.ok(script, 'the root package has no test:perf script');
    assert.match(
      script,
      /scripts\/perf-conditions\.mjs/,
      `the root test:perf no longer records the run's conditions: ${script}`,
    );

    await readFile(join(repoRoot, 'scripts', 'perf-conditions.mjs'), 'utf8');
  });
});

/** Walks compiled output, reporting any `.js` with no matching `.ts` beside its source. */
/**
 * The two generated documents (`H-07`).
 *
 * `docs/sensor-reference.md` and `docs/api-reference.md` are rendered from the catalogue and from
 * the OpenAPI document, and the whole reason they are generated is that a hand-written reference
 * is right on the day it is written and silently wrong from then on. That only holds if something
 * fails when they drift, and this is that something: a parameter renamed, a channel added, a
 * route registered — any of them makes the committed file stale, and the build goes red rather
 * than the documentation going quietly wrong.
 *
 * Each generator's own `--check` does the comparing, so there is one renderer and no second
 * implementation of it here to disagree.
 */
describe('generated documentation', () => {
  const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');

  for (const generator of ['sensor-reference', 'api-reference']) {
    it(`has docs/${generator}.md in step with the code`, () => {
      const run = spawnSync(
        process.execPath,
        [join(repoRoot, 'scripts', 'docs', `${generator}.mjs`), '--check'],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      assert.equal(
        run.status,
        0,
        `${run.stdout}${run.stderr}\nRegenerate with: node scripts/docs/${generator}.mjs`,
      );
    });
  }
});

/**
 * Credential-shaped fields: none in a response without a reason (`P-55`), none in a request body
 * without `writeOnly` (`P-334`).
 *
 * **The response half is a default-deny list, and it exists because the hand-maintained one
 * failed.** `api-routes.test.ts` sweeps a list of URLs with a canary and asserts no secret comes
 * back. That catches everything on the list and nothing else, and `GET /discovery/schedules` —
 * which returned the stored SNMP community in cleartext from three separate responses — was never
 * on it. CLAUDE.md's rule is absolute: a credential is never returned by any API route, to anyone,
 * including administrators.
 *
 * **It walks the OpenAPI document itself (`P-336`).** It used to read `docs/api-reference.md`'s
 * `**200** { a, b }` summary lines, which held a route's top-level names only and missed a line
 * listing more than one response: `tokenId` two levels down in every audit entry, and three Core
 * Health counters, were never read. The document is what the reference is rendered from (`H-07`),
 * built by the same generator from the live route set, so every route, every response, every
 * level and every shared schema is read, and a new route cannot dodge it by not being added
 * anywhere.
 *
 * **The request half is the same names, the other way round.** A request field named like a
 * secret must be `writeOnly`, which is how the OpenAPI document and the reference tell a client
 * it is never sent back. `writeOnly` is an annotation: Ajv validates the field as before.
 *
 * **One-time codes are secrets too (`P-343`).** The TOTP `code` a login and an MFA confirmation
 * take, and the `recoveryCodes` MFA set-up answers, were found by reading the auth routes: no name
 * above matched them. Recovery codes join `SHAPE`, so both halves ask about them, and the one
 * response that must carry them is allowed at its two routes and nowhere else (`ALLOWED_ONLY_AT`).
 * A bare `code` is asked of request bodies only, by exact name (`ONE_TIME_CODE`): in a response it
 * is an error code, and a request field called `code` that is not a secret is exempted by its
 * place (`NOT_A_CODE`), so the exemption cannot reach the auth routes'.
 *
 * It matches on *names*, so it is a smoke alarm and not a proof: it cannot tell whether a field
 * called `note` holds a password. What it does is make the easy mistake loud.
 */
describe('credential-shaped fields', () => {
  /**
   * Each of these is a deliberate exception with a reason, and the reason is the point: an entry
   * added without one is how the rule erodes.
   */
  const ALLOWED = new Map([
    [
      'secret',
      'TOTP enrolment and API-token creation return it once, at creation. A shared secret the operator is never shown cannot be enrolled or used.',
    ],
    [
      'token',
      'The API token, returned once by its creation route for the same reason. It is hashed at rest and never readable again.',
    ],
    [
      'tokenId',
      "An audit entry's actor: the id of the API token a change was made with, never the token.",
    ],
    [
      'credentials',
      "The object detail's credential block carries presence and inheritance source, never a value — which the canary sweep in api-routes.test.ts asserts directly.",
    ],
    ['credentialsChanged', 'A boolean on a clone response.'],
    [
      'credentialsToReenter',
      'A Core Health channel: how many credential sets need re-entering, a count.',
    ],
    ['credentialsUnbounded', 'A Core Health channel: how many credential sets have no targets.'],
    [
      'credentialsWithheld',
      'A Core Health channel: how many sensors are withheld for their credentials.',
    ],
    [
      'droppedCredentialKinds',
      'A list of credential *kind* names that were not copied, never their values.',
    ],
    ['mustChangePassword', 'A boolean on the session and user routes.'],
    ['cappedByToken', "A boolean saying an API token's ceiling limited the right."],
    [
      'secretsCleared',
      'The names of the secret fields a credential write cleared because it widened where the set may go (A-41b), never their values.',
    ],
    [
      'recoveryCodes',
      'The MFA recovery codes, returned once when they are issued: by `POST /auth/mfa/confirm` at set-up and by `POST /auth/mfa/recovery-codes` when replaced. They are hashed at rest, and a set the operator is never shown cannot be written down. Allowed at those two routes only (ALLOWED_ONLY_AT).',
    ],
    [
      'recoveryCodesLeft',
      'A count on `GET /auth/mfa`: how many recovery codes are still unused, never one of them.',
    ],
    [
      'secretsSet',
      "The names of the secret fields a credential set holds a value for (U-21), never their values: what a form needs to offer keep, replace and clear, and what the set's audit entries already name. credential-view.test.ts asserts no value is in the answer.",
    ],
  ]);

  /**
   * Where an `ALLOWED` name may appear, for a name that is safe only where it is meant to be. A
   * recovery code returned anywhere else is a second way to read one.
   */
  const ALLOWED_ONLY_AT = new Map<string, readonly string[]>([
    [
      'recoveryCodes',
      [
        'POST /api/v1/auth/mfa/confirm 200 recoveryCodes',
        'POST /api/v1/auth/mfa/recovery-codes 200 recoveryCodes',
      ],
    ],
  ]);

  /** Request fields named like a secret that are not one, so need not be `writeOnly`. */
  const NOT_SECRET = new Map([
    [
      'credentials',
      "`POST /device-templates/plan`'s list of credential *kind* names the caller can supply, never a value.",
    ],
  ]);

  const SHAPE =
    /(community|password|secret|auth_?key|priv(ate)?_?key|passphrase|token|api_?key|credential|recovery_?codes?)/i;

  /**
   * A one-time code in a request body: TOTP's six digits, or a recovery code typed in their place
   * (`P-343`). By exact name, and requests only: `code` is also an error code, a status code or a
   * country code, and a response carries several of those.
   */
  const ONE_TIME_CODE = /^(((totp|mfa|otp)_?)?code|otp)$/i;

  /**
   * Request fields called like a one-time code that are not one, by their place (`METHOD path body
   * field`) rather than their name, so that excusing one cannot excuse the auth routes'. None yet.
   */
  const NOT_A_CODE = new Map<string, string>([]);

  const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');

  /** The document the reference is rendered from, built by the same generator, once. */
  let built: OpenApi | undefined;
  function openApiDocument(): OpenApi {
    if (built !== undefined) return built;
    const run = spawnSync(
      process.execPath,
      [join(repoRoot, 'scripts', 'docs', 'api-reference.mjs'), '--openapi'],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(run.status, 0, run.stderr);
    built = JSON.parse(run.stdout) as OpenApi;
    return built;
  }

  /** Response fields named like a credential that nothing in `ALLOWED` explains. */
  function unexplained(doc: OpenApi): string[] {
    const found = new Map<string, string>();
    for (const field of fieldsOf(doc, 'response')) {
      if (!SHAPE.test(field.name) || found.has(field.name)) continue;
      const only = ALLOWED_ONLY_AT.get(field.name);
      if (ALLOWED.has(field.name) && (only === undefined || only.includes(field.where))) continue;
      found.set(field.name, `${field.name} (${field.where})`);
    }
    return [...found.values()];
  }

  /** Request body fields named like a secret or a one-time code, and not `writeOnly`. */
  function readable(doc: OpenApi): string[] {
    const secret = (field: Field): boolean =>
      (SHAPE.test(field.name) && !NOT_SECRET.has(field.name)) ||
      (ONE_TIME_CODE.test(field.name) && !NOT_A_CODE.has(field.where));
    return fieldsOf(doc, 'request')
      .filter((field) => secret(field) && !field.writeOnly)
      .map((field) => field.where);
  }

  it('in responses are all accounted for', () => {
    const fields = unexplained(openApiDocument());
    assert.deepEqual(
      fields,
      [],
      'a response now carries a credential-shaped field that nothing justifies:\n  ' +
        `${fields.join('\n  ')}\n` +
        'Either stop returning it, or add it to ALLOWED with the reason it is safe.',
    );
  });

  it('in request bodies are all writeOnly', () => {
    const fields = readable(openApiDocument());
    assert.deepEqual(
      fields,
      [],
      'a request body takes a field named like a secret that is not writeOnly:\n  ' +
        `${fields.join('\n  ')}\n` +
        'Mark it writeOnly: true, or add it to NOT_SECRET with the reason it is not a secret.',
    );
  });

  /**
   * The schemas the document cannot see into (`P-344`). A sensor's `params`, a credential set's
   * `values` and a notification template's `settings` are free-form objects in the OpenAPI
   * document: their shape is each sensor type's `paramsSchema`, each credential kind's `schema`
   * and each notification method's `settingsSchema`, and `writeOnly` there is what decides what
   * is returned. `ObjectService.#redact` strips a sensor's `writeOnly` parameters from every
   * read, the template routes strip a method's, and a kind's `writeOnly` fields are the half the
   * vault encrypts while the rest is stored and served in the clear as `publicParams`. So a field
   * named like a secret and not marked `writeOnly` would be answered to every reader, and the
   * walk above would never see it. These are walked as request bodies, with the same rule, for
   * every type the full build registers, every kind and every method.
   */
  function parameterDocument(
    types: readonly { readonly id: string; readonly paramsSchema: Schema }[],
    kinds: readonly { readonly id: string; readonly schema: Schema }[],
    methods: readonly { readonly id: string; readonly settingsSchema: Schema }[] = [],
  ): OpenApi {
    const body = (schema: Schema): Operation => ({
      requestBody: { content: { 'application/json': { schema } } },
    });
    const paths: Record<string, Record<string, Operation>> = {};
    for (const type of types) paths[`sensor type ${type.id}`] = { params: body(type.paramsSchema) };
    for (const kind of kinds) paths[`credential kind ${kind.id}`] = { values: body(kind.schema) };
    for (const method of methods) {
      paths[`notification method ${method.id}`] = { settings: body(method.settingsSchema) };
    }
    return { paths };
  }

  it('in sensor parameters, credential kinds and notification settings are all writeOnly (P-344)', () => {
    const fields = readable(
      parameterDocument(
        coreCatalogue('full').summaries(),
        CREDENTIAL_KINDS,
        notificationMethods.all(),
      ),
    );
    assert.deepEqual(
      fields,
      [],
      'a sensor type, credential kind or notification method takes a field named like a ' +
        'secret that is not writeOnly, ' +
        'so every read would return it:\n  ' +
        `${fields.join('\n  ')}\n` +
        'Mark it writeOnly: true, or add it to NOT_SECRET with the reason it is not a secret.',
    );
  });

  it('finds a parameter, credential or method field named like a secret, nested too (P-344)', () => {
    const fields = readable(
      parameterDocument(
        [
          {
            id: 'test.nested',
            paramsSchema: {
              type: 'object',
              properties: {
                host: { type: 'string' },
                auth: {
                  type: 'object',
                  properties: {
                    user: { type: 'string' },
                    password: { type: 'string' },
                    authKey: { type: 'string', writeOnly: true },
                  },
                },
              },
            },
          },
        ],
        [
          {
            id: 'test.kind',
            schema: {
              type: 'object',
              properties: {
                community: { type: 'string', writeOnly: true },
                privateKey: { type: 'string' },
              },
            },
          },
        ],
        [
          {
            id: 'test.method',
            settingsSchema: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                headers: {
                  type: 'array',
                  items: { type: 'object', properties: { apiKey: { type: 'string' } } },
                },
                // Write-only as a whole, so what is inside it is too: not reported.
                signing: {
                  type: 'object',
                  writeOnly: true,
                  properties: { secret: { type: 'string' } },
                },
              },
            },
          },
        ],
      ),
    );
    assert.deepEqual(fields, [
      'PARAMS sensor type test.nested body auth.password',
      'VALUES credential kind test.kind body privateKey',
      'SETTINGS notification method test.method body headers[].apiKey',
    ]);
  });

  /**
   * The walk itself, on a document small enough to read: a credential at every place the summary
   * line could not see — nested, behind a shared schema, in an array, in a union, and in the
   * second response of a route that declares two.
   */
  describe('read every level of every response', () => {
    const fixture: OpenApi = {
      components: {
        schemas: {
          'def-0': {
            title: 'ms:shared',
            type: 'object',
            properties: { inner: { type: 'object', properties: { authKey: { type: 'string' } } } },
          },
        },
      },
      paths: {
        '/api/v1/things': {
          get: {
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        id: { type: 'integer' },
                        probe: {
                          type: 'object',
                          properties: {
                            snmp: { type: 'object', properties: { community: { type: 'string' } } },
                          },
                        },
                        items: {
                          type: 'array',
                          items: { type: 'object', properties: { passphrase: { type: 'string' } } },
                        },
                        shared: { $ref: '#/components/schemas/def-0' },
                        either: {
                          oneOf: [
                            { type: 'object', properties: { privKey: { type: 'string' } } },
                            { type: 'null' },
                          ],
                        },
                      },
                    },
                  },
                },
              },
              202: {
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { apiKey: { type: 'string' } } },
                  },
                },
              },
            },
          },
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      password: { type: 'string', writeOnly: true },
                      nested: { type: 'object', properties: { secret: { type: 'string' } } },
                      credentials: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
            responses: { 204: {} },
          },
        },
      },
    };

    it('finds a nested credential-shaped response field, wherever it is', () => {
      assert.deepEqual(unexplained(fixture).sort(), [
        'apiKey (GET /api/v1/things 202 apiKey)',
        'authKey (GET /api/v1/things 200 shared.inner.authKey)',
        'community (GET /api/v1/things 200 probe.snmp.community)',
        'passphrase (GET /api/v1/things 200 items[].passphrase)',
        'privKey (GET /api/v1/things 200 either.privKey)',
      ]);
    });

    it('finds a request field named like a secret that is not writeOnly, nested too', () => {
      assert.deepEqual(readable(fixture), ['POST /api/v1/things body nested.secret']);
    });
  });

  /**
   * The names nothing caught before `P-343`: a TOTP `code` an auth route takes without
   * `writeOnly`, and `recoveryCodes` answered somewhere other than the two routes that issue them.
   * An error `code` in a response is not a secret and is not reported.
   */
  describe('one-time codes', () => {
    const json = (schema: Schema) => ({ content: { 'application/json': { schema } } });
    const object = (properties: Record<string, Schema>): Schema => ({ type: 'object', properties });
    const codes = { type: 'array', items: { type: 'string' } };
    const fixture: OpenApi = {
      paths: {
        '/api/v1/auth/login': {
          post: {
            requestBody: json(
              object({
                username: { type: 'string' },
                password: { type: 'string', writeOnly: true },
                code: { type: 'string' },
              }),
            ),
            responses: { 401: json(object({ error: object({ code: { type: 'string' } }) })) },
          },
        },
        '/api/v1/auth/mfa/confirm': {
          post: {
            requestBody: json(object({ code: { type: 'string', writeOnly: true } })),
            responses: { 200: json(object({ recoveryCodes: codes })) },
          },
        },
        '/api/v1/auth/mfa': {
          get: {
            responses: {
              200: json(object({ recoveryCodes: codes, recoveryCodesLeft: { type: 'integer' } })),
            },
          },
        },
      },
    };

    it('finds an auth request’s code that is not writeOnly', () => {
      assert.deepEqual(readable(fixture), ['POST /api/v1/auth/login body code']);
    });

    it('finds recovery codes answered by a route that is not listed for them', () => {
      assert.deepEqual(unexplained(fixture), [
        'recoveryCodes (GET /api/v1/auth/mfa 200 recoveryCodes)',
      ]);
    });
  });
});

/** As much of an OpenAPI document as the credential walk reads. */
interface OpenApi {
  readonly components?: { readonly schemas?: Record<string, Schema> };
  readonly paths: Record<string, Record<string, Operation>>;
}
interface Operation {
  readonly requestBody?: { readonly content?: Record<string, { readonly schema?: Schema }> };
  readonly responses?: Record<
    string,
    { readonly content?: Record<string, { readonly schema?: Schema }> }
  >;
}
type Schema = Readonly<Record<string, unknown>>;

interface Field {
  readonly name: string;
  /** `GET /api/v1/audit 200 items[].actor.tokenId`. */
  readonly where: string;
  readonly writeOnly: boolean;
}

/**
 * Every named field in the document's request bodies or responses, at every depth, through every
 * shared schema, array, map and union alternative. A shared schema is followed once per path, so
 * a schema that contains itself ends rather than recursing.
 */
function fieldsOf(doc: OpenApi, side: 'request' | 'response'): Field[] {
  const components = doc.components?.schemas ?? {};
  const fields: Field[] = [];
  const isSchema = (value: unknown): value is Schema =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const objectAt = (schema: Schema, keyword: string): Schema => {
    const value = schema[keyword];
    return isSchema(value) ? value : {};
  };
  const resolve = (schema: Schema): { schema: Schema; key?: string } => {
    const ref = schema['$ref'];
    if (typeof ref !== 'string') return { schema };
    const key = /^#\/components\/schemas\/(.+)$/u.exec(ref)?.[1];
    const target = key === undefined ? undefined : components[key];
    assert.ok(target !== undefined && key !== undefined, `the document does not define ${ref}`);
    return { schema: target, key };
  };

  // `hidden`: the field is inside one marked `writeOnly`, and so is write-only itself — a
  // notification method's `secretHeaders` is one `writeOnly` object, and every header in it is
  // stripped with it (`P-344`).
  const walk = (
    raw: Schema,
    where: string,
    path: string,
    seen: ReadonlySet<string>,
    hidden = false,
  ): void => {
    const { schema, key } = resolve(raw);
    if (key !== undefined && seen.has(key)) return;
    const inside = key === undefined ? seen : new Set([...seen, key]);
    const at = (name: string): string => (path === '' ? name : `${path}.${name}`);
    const under = hidden || schema['writeOnly'] === true;

    for (const [name, property] of Object.entries(objectAt(schema, 'properties'))) {
      if (!isSchema(property)) continue;
      const writeOnly =
        under || property['writeOnly'] === true || resolve(property).schema['writeOnly'] === true;
      fields.push({ name, where: `${where} ${at(name)}`, writeOnly });
      walk(property, where, at(name), inside, writeOnly);
    }
    for (const property of Object.values(objectAt(schema, 'patternProperties'))) {
      if (isSchema(property)) walk(property, where, at('*'), inside, under);
    }
    const map = schema['additionalProperties'];
    if (isSchema(map)) walk(map, where, at('*'), inside, under);
    const items = schema['items'];
    for (const item of Array.isArray(items) ? items : [items]) {
      if (isSchema(item)) walk(item, where, `${path}[]`, inside, under);
    }
    for (const keyword of ['oneOf', 'anyOf', 'allOf', 'prefixItems']) {
      const alternatives = schema[keyword];
      if (!Array.isArray(alternatives)) continue;
      for (const alternative of alternatives) {
        if (isSchema(alternative)) walk(alternative, where, path, inside, under);
      }
    }
    for (const keyword of ['then', 'else']) {
      const branch = schema[keyword];
      if (isSchema(branch)) walk(branch, where, path, inside, under);
    }
  };

  for (const [route, operations] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      // A path item may carry `parameters`, an array, beside its operations.
      if (Array.isArray(operation)) continue;
      const verb = `${method.toUpperCase()} ${route}`;
      if (side === 'request') {
        for (const media of Object.values(operation.requestBody?.content ?? {})) {
          if (media.schema !== undefined) walk(media.schema, `${verb} body`, '', new Set());
        }
        continue;
      }
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        for (const media of Object.values(response.content ?? {})) {
          if (media.schema !== undefined) walk(media.schema, `${verb} ${status}`, '', new Set());
        }
      }
    }
  }
  return fields;
}

/**
 * Every link between documents points at a file that exists (`P-54`).
 *
 * **The documentation is a graph and nothing was checking its edges.** Adding a finding means
 * adding a line to `docs/README.md`'s index by hand, and the two findings written on 2026-09-04
 * were missing from it until somebody happened to look — a typo in the path would have been just
 * as silent, and the reader who follows a dead link is the one person who needed the document.
 *
 * `H-07` generates the two references that *can* be generated so they cannot drift. This is the
 * same argument for the half that cannot be: the prose stays hand-written, but a link in it either
 * resolves or the build goes red.
 *
 * Ticket cross-references are deliberately not checked here. `P-24` waited on `D-05`'s "VMware
 * transport" for weeks, and `D-05` exists — the reference resolved perfectly and was pointing at a
 * ticket that had never been about that. Checking that a name exists would have said nothing, and
 * would have implied a guarantee it cannot give.
 */
describe('documentation links', () => {
  const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
  // Written for an operator to fill in when they run the field test, not a link to follow.
  const placeholder = /<[^>]+>/;

  it('all resolve to a file that exists', async () => {
    const roots = ['docs', 'CLAUDE.md', 'README.md'];
    const files: string[] = [];
    for (const root of roots) {
      const full = join(repoRoot, root);
      if (root.endsWith('.md')) {
        files.push(full);
        continue;
      }
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const here = join(dir, entry.name);
          if (entry.isDirectory()) await walk(here);
          else if (entry.name.endsWith('.md')) files.push(here);
        }
      };
      await walk(full);
    }

    const broken: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      // `[label](path.md)` and paths named in backticks, which is how this repo cites documents.
      const targets = [
        ...[...text.matchAll(/\]\(([^)#\s]+\.md)[^)]*\)/g)].map((m) => m[1]),
        ...[...text.matchAll(/`((?:docs|findings)\/[^`\s]+\.md)`/g)].map((m) => m[1]),
      ];
      for (const target of targets) {
        if (target === undefined || target.startsWith('http') || placeholder.test(target)) continue;
        const beside = join(file, '..', target);
        const fromRoot = join(repoRoot, target);
        if (!existsSync(beside) && !existsSync(fromRoot)) {
          broken.push(`${relative(repoRoot, file)} → ${target}`);
        }
      }
    }

    assert.deepEqual(broken, [], `dead documentation links:\n  ${broken.join('\n  ')}`);
  });

  /**
   * And the other direction, which is the one that actually happened.
   *
   * A dead link is loud when someone follows it. A finding that nothing links to is silent for
   * ever: it was written, committed, and is now reachable only by listing the directory. Two of
   * the findings written on 2026-09-04 sat unindexed until somebody thought to look, and there is
   * no reason to expect the next author to think of it either.
   */
  it('leave no findings document unreachable', async () => {
    const findingsDir = join(repoRoot, 'docs', 'findings');
    const findings = (await readdir(findingsDir)).filter((name) => name.endsWith('.md'));

    // Everything outside `findings/` itself: a finding cited only by another finding is still
    // unreachable from the documentation an operator or a maintainer actually starts from.
    const corpus: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const here = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (here !== findingsDir) await walk(here);
        } else if (entry.name.endsWith('.md')) corpus.push(await readFile(here, 'utf8'));
      }
    };
    await walk(join(repoRoot, 'docs'));
    corpus.push(await readFile(join(repoRoot, 'CLAUDE.md'), 'utf8'));

    const text = corpus.join('\n');
    const orphans = findings.filter((name) => !text.includes(name));
    assert.deepEqual(
      orphans,
      [],
      `findings nothing links to — add them to docs/README.md's index:\n  ${orphans.join('\n  ')}`,
    );
  });
});

/**
 * Every `.ps1` in the tree parses (`P-53`).
 *
 * **A parse error in `ms-setup.ps1` breaks every Windows install**, and until now the only thing
 * anywhere that would have caught one was `H-06`'s `windows-install` CI job — which has never run,
 * because CI is disabled. So the scripts that register the services, open the firewall and gate an
 * upgrade on `config check` were unchecked by anything at all.
 *
 * `H-06` recorded that a local check was impossible: "PowerShell publishes no arm64 container, the
 * amd64 one dies under QEMU on an Apple Silicon machine, and the `dotnet tool` package is broken —
 * three routes tried, all dead." That was true of those three routes and not of the fourth:
 * `P-51` put the official `linux-arm64` tarball in the toolchain image for the Windows *sensor*
 * transport, and a parser is a parser.
 *
 * Parsing is not running. This cannot tell whether `New-Service` was called with the right
 * arguments — only Windows can, which is what `H-06` still waits for. It catches the class of
 * mistake that costs a release, at the price of one process.
 */
describe('PowerShell installers', () => {
  const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
  const pwsh = ((): string => {
    for (const candidate of [process.env['MS_TEST_PWSH'] ?? '', 'pwsh', 'powershell.exe']) {
      if (candidate === '') continue;
      const probe = spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', '$true'], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      if (probe.status === 0) return candidate;
    }
    return '';
  })();

  it('parse without error', { skip: pwsh === '' ? 'no pwsh on this machine' : false }, () => {
    // One process for every file: starting PowerShell costs far more than parsing does, and the
    // report has to name which file failed rather than only that one did.
    const script = [
      '$bad = @()',
      "Get-ChildItem -Recurse -Path 'deploy','scripts' -Filter *.ps1 | ForEach-Object {",
      '  $errors = $null',
      '  [System.Management.Automation.Language.Parser]::ParseFile(',
      '    $_.FullName, [ref]$null, [ref]$errors) | Out-Null',
      '  if ($errors -and $errors.Count -gt 0) {',
      '    foreach ($e in $errors) {',
      '      $bad += ($_.FullName + ":" + $e.Extent.StartLineNumber + " " + $e.Message)',
      '    }',
      '  }',
      '}',
      'if ($bad.Count -gt 0) { $bad -join "`n"; exit 1 }',
      "Write-Output 'ok'",
    ].join('\n');

    const run = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  });
});

async function compare(
  compiledDir: string,
  sourceDir: string,
  report: (file: string) => void,
): Promise<void> {
  const entries = await readdir(compiledDir, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) return;

  const sources = new Set(
    (await readdir(sourceDir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await compare(join(compiledDir, entry.name), join(sourceDir, entry.name), report);
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;
    if (!sources.has(entry.name.replace(/\.js$/, '.ts'))) {
      report(join(compiledDir, entry.name));
    }
  }
}

/**
 * Every number the probe sends must be read by something (`P-79`).
 *
 * `PROBE_HEALTH_SCHEMA` is `additionalProperties: false`, so adding a field to it is a deliberate
 * act with a protocol bump attached — and precisely *because* it is deliberate, it is easy to
 * finish the probe side, bump the version, watch the tests pass, and never wire the core side at
 * all. Five fields had reached that state: `skippedTicks`, `spoolCorrupt` and `sessionsOpened`
 * from older tickets, and `checksOutstanding` and `checkStalledMs` from `P-76`, which was written
 * the day before this check was. All five were measured on the probe, validated on the wire, and
 * discarded on arrival.
 *
 * Nothing failed, because nothing was wrong — the probe measured correctly and the core did not
 * crash. That is the shape of every defect in this family: a run that reports what it measured
 * and says nothing about what it never looked at (`P-49`, `P-52`, `P-75`). `CLAUDE.md` says the
 * system monitors itself; a counter nobody can read is not monitoring, it is bookkeeping.
 *
 * The check is against `probe-health.ts` alone, with comments stripped and matched on a word
 * boundary, because that is the one place a health field becomes a channel reading. A broad grep across `packages/core` is what
 * missed `sessionsOpened` when this was first audited by hand: the name appeared in a *comment*
 * beside `sessionsEvicted`, describing a diagnosis the operator could not actually make.
 */
describe('the probe health protocol', () => {
  const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');

  it('has every field it defines read by the core', async () => {
    const schema = await readFile(
      join(repoRoot, 'packages', 'shared', 'src', 'protocol', 'messages.ts'),
      'utf8',
    );
    const start = schema.indexOf('const PROBE_HEALTH_SCHEMA');
    const end = schema.indexOf('\n} as const', start);
    assert.ok(start !== -1 && end !== -1, 'PROBE_HEALTH_SCHEMA has moved or changed shape');
    const fields = [
      ...new Set(
        [...schema.slice(start, end).matchAll(/^ {4}([a-zA-Z][a-zA-Z0-9]*):\s*\S/gm)].map(
          (m) => m[1] ?? '',
        ),
      ),
    ];
    // A sanity floor on the extraction itself: a regex that silently matched nothing would make
    // this test pass for ever while checking absolutely nothing, which is the failure it exists
    // to catch, arriving in the guard.
    assert.ok(fields.length > 30, `only found ${String(fields.length)} fields; the parse is wrong`);

    const source = await readFile(
      join(repoRoot, 'packages', 'core', 'src', 'health', 'probe-health.ts'),
      'utf8',
    );
    // Comments stripped: a field named only in prose is exactly the case that fooled the manual
    // audit, and a mention is not a reading.
    const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/\/\/[^\n]*/g, ' ');

    // Word-boundary, not substring (`P-80`). `includes` let a field whose name is a *prefix* of
    // another be satisfied by its longer sibling — `sessionsOpen` by `sessionsOpened` — so the
    // guard could pass while the shorter one was read by nothing. The floor above catches a regex
    // that matches nothing; only this catches a match that is accidentally satisfied.
    const unread = fields.filter((field) => !new RegExp(`\\b${field}\\b`).test(code));
    assert.deepEqual(
      unread,
      [],
      `the probe sends these and the core reads none of them — give each a channel in ` +
        `packages/sensors/src/types/probe-health.ts and map it in packages/core/src/health/` +
        `probe-health.ts, or delete it from the protocol:\n  ${unread.join('\n  ')}`,
    );
  });
});

/**
 * The field-test runbook names channels; it must name ones that exist (`H-09`, `S-11`'s lesson).
 *
 * `docs/runbook-field-test.md` is the procedure for the Phase 10 exit criterion — a week of
 * unattended running on hardware nobody has yet — and its whole reason for existing is that a
 * test designed at the moment it is run is a test run badly. So it names channels, and says of
 * each whether the channel carries a declared limit, because that decides whether a *state*
 * trigger will ever see it or whether an operator has to write a threshold themselves.
 *
 * **Both halves of that are claims about code, in a document nothing was checking.** The table
 * said all seven channels ship with declared limits; `probesDown` does not and never did, so a
 * reader following the runbook would have set up delivery for an alarm that cannot fire — the
 * exact failure the runbook exists to prevent, on the week nobody is watching. Renaming a channel
 * would do it the other way round.
 *
 * This is `S-11`'s rule applied to a second document: when a document depends on a list, assert
 * the list rather than trusting the person who wrote it down.
 */
describe('the field-test runbook', () => {
  const SENSORS = new Map([
    ['Core Health', coreHealth],
    ['Probe Health', probeHealth],
  ]);

  /**
   * `| \`key\` | Core Health | yes |` — the three columns this test can check. `yes (lookup)` is a
   * channel whose lookup moves its sensor's state (`P-432`'s `lookupHelperTrouble`): no limit, and
   * a state trigger sees it all the same.
   */
  const ROW =
    /^\|\s*`([a-zA-Z]+)`\s*\|\s*(Core Health|Probe Health)\s*\|\s*\*{0,2}(yes \(lookup\)|yes|no)\*{0,2}\s*\|/gm;

  /** A lookup the core ships, with an entry that is not Up: a value of it moves the state. */
  const moves = (lookup: string | undefined): boolean =>
    BUILT_IN_LOOKUPS.some(
      (definition) =>
        definition.id === lookup && definition.entries.some((entry) => entry.state !== 'up'),
    );

  it('names channels that exist, on the sensor it says, with the limits it claims', async () => {
    const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
    const runbook = await readFile(join(repoRoot, 'docs', 'runbook-field-test.md'), 'utf8');

    const rows = [...runbook.matchAll(ROW)].map(([, key, sensor, limit]) => ({
      key: key ?? '',
      sensor: sensor ?? '',
      claims: limit === 'yes' ? 'limit' : limit === 'no' ? 'nothing' : 'lookup',
    }));
    // A regex that matched nothing would make every assertion below vacuous — the table is seven
    // rows and the failure mode is somebody reformatting it, not emptying it.
    assert.ok(rows.length >= 7, `parsed ${String(rows.length)} rows from the runbook's table`);

    const wrong: string[] = [];
    for (const row of rows) {
      const type = SENSORS.get(row.sensor);
      assert.ok(type, `no sensor type for "${row.sensor}"`);
      const channel = type.channels({}).find((each) => each.key === row.key);
      if (channel === undefined) {
        wrong.push(`${row.key}: not a channel on ${row.sensor}`);
        continue;
      }
      // A *bound*, not merely a `limits` object. The catalogue refuses a declaration with no
      // bound, so this is belt and braces — but the claim the runbook makes is "a state trigger
      // will see this", and only a bound makes that true.
      const limits = channel.limits;
      const hasLimit =
        limits !== undefined &&
        (limits.upperError !== undefined ||
          limits.upperWarning !== undefined ||
          limits.lowerWarning !== undefined ||
          limits.lowerError !== undefined);
      // Or a lookup with an entry that is not Up, which moves the state as a limit does.
      const has = hasLimit ? 'limit' : moves(channel.lookup) ? 'lookup' : 'nothing';
      if (has !== row.claims) {
        wrong.push(
          `${row.key}: the runbook claims ${row.claims === 'nothing' ? 'nothing' : `a ${row.claims}`} ` +
            `that moves the state, and the channel has ${has === 'nothing' ? 'neither' : `a ${has}`}`,
        );
      }
    }

    assert.deepEqual(
      wrong,
      [],
      'docs/runbook-field-test.md describes channels that are not what it says they are. A ' +
        "channel with no declared limit never moves its sensor's state, so a state trigger on " +
        `it delivers nothing:\n  ${wrong.join('\n  ')}`,
    );
  });

  /**
   * Step 4's criteria for `probe.nameResolver: gate` name every channel the gate adds to Probe
   * Health, each as the kind the type declares it (`H-50`).
   *
   * The gate's channels are what the protocol carries for it: what `healthForPeer` strips from a
   * core below the protocol `nameResolver` needs, and keeps above it, so a channel a later slice
   * adds is held here without this list being written again. The runbook says which are counters,
   * which the core stores as rates and the criteria judge as such, which are readings and how many
   * are states; a counter called a reading, or a channel the week never reads, fails here. The
   * prepared runbook named five of the fourteen, as the design named them before S3 and S6 landed.
   */
  it('judges every channel the gate adds, each as the kind it is declared', async () => {
    const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
    const runbook = await readFile(join(repoRoot, 'docs', 'runbook-field-test.md'), 'utf8');
    const start = runbook.indexOf("- **The gate's channels, on every probe**");
    const end = runbook.indexOf('- **`lookupsGivenUp`', start);
    assert.ok(start >= 0 && end > start, 'step 4 has no list of the gate’s channels');
    const section = runbook.slice(start, end).replace(/\s+/g, ' ');

    const channels = new Map(probeHealth.channels({}).map((channel) => [channel.key, channel]));
    const full = Object.fromEntries(
      [...channels.keys()].map((key) => [key, 1]),
    ) as unknown as ProbeHealthReport;
    const older = new Set(Object.keys(healthForPeer(full, versionFor('nameResolver') - 1)));
    const newest = new Set(Object.keys(healthForPeer(full, PROTOCOL_VERSION)));
    const gate = [...channels.keys()].filter((key) => newest.has(key) && !older.has(key));
    // A strip that matched nothing would make every assertion below vacuous.
    assert.ok(gate.length >= 6, `found ${String(gate.length)} gate channels: ${gate.join(', ')}`);

    const named = (text: string): string[] =>
      [...text.matchAll(/`([a-zA-Z]+)`/g)].map((match) => match[1] ?? '').sort();
    const declared = (kind: (key: string) => boolean): string[] => gate.filter(kind).sort();
    const counter = (key: string): boolean => channels.get(key)?.counter !== undefined;
    const lookup = (key: string): boolean => channels.get(key)?.lookup !== undefined;

    const mentioned = new Set(named(section));
    assert.deepEqual(
      gate.filter((key) => !mentioned.has(key)),
      [],
      'step 4 does not judge every channel the gate adds',
    );
    const counters = /The counters are ([^;]+);/.exec(section);
    assert.ok(counters, 'step 4 does not say which of the gate’s channels are counters');
    assert.deepEqual(named(counters[1] ?? ''), declared(counter), 'the counters step 4 names');
    const readings = /;([^;]+) are readings;/.exec(section);
    assert.ok(readings, 'step 4 does not say which of the gate’s channels are readings');
    assert.deepEqual(
      named(readings[1] ?? ''),
      declared((key) => !counter(key) && !lookup(key)),
      'the readings step 4 names',
    );
    const states = /the other (\w+) are states/.exec(section);
    const numbers = new Map([
      ['two', 2],
      ['three', 3],
      ['four', 4],
      ['five', 5],
      ['six', 6],
    ]);
    assert.equal(
      numbers.get(states?.[1] ?? ''),
      declared((key) => !counter(key) && lookup(key)).length,
      'the states step 4 counts',
    );
  });
});

/**
 * The 1.0 release notes name the protocol and the last migration an upgrade from rc.2 brings
 * (`H-50`). Both moved while rc.3 was prepared, the protocol three times (`P-438`'s 37, `P-432`
 * S3's 38 and S6's 39), and the prepared notes said 38 until they were brought onto the code. An
 * operator reads that line to know what a core or probe left on rc.2 negotiates down from.
 */
describe('the 1.0 release notes', () => {
  it('name the protocol this build speaks, and its last migration', async () => {
    const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
    const notes = (await readFile(join(repoRoot, 'docs', 'release-notes-1.0.md'), 'utf8')).replace(
      /\s+/g,
      ' ',
    );
    const protocol = /the protocol between core and probe moves from (\d+) to (\d+)/.exec(notes);
    assert.ok(protocol, 'the upgrade section names no protocol');
    assert.equal(Number(protocol[2]), PROTOCOL_VERSION, 'the protocol the notes say rc.3 speaks');

    const migrations = /applies migrations (\d{3}) to (\d{3})/.exec(notes);
    assert.ok(migrations, 'the upgrade section names no migrations');
    const files = (await readdir(join(repoRoot, 'packages', 'core', 'src', 'db', 'migrations')))
      .map((name) => /^(\d{3})-/.exec(name)?.[1])
      .filter((number): number is string => number !== undefined)
      .sort();
    assert.equal(migrations[2], files.at(-1), 'the last migration the notes say rc.3 applies');
  });
});

/**
 * The administration guide's Probe Health table names channels that exist, and every listener
 * channel is in it (`B-16`).
 *
 * The table is a guide to what is worth watching and not a list of every channel, so it is not
 * held to the whole declaration. The listener counters are held to it, because a gap in them has
 * already happened once: `B-14` added the two overwritten counts beside six older counters the
 * table had never had, and an operator whose trap sensor read zero had no row telling them the
 * probe counts what it turned away. A listener channel added to the sensor type without a row
 * fails here, and so does a row naming a channel that was renamed.
 */
describe("the administration guide's Probe Health table", () => {
  /** The table under the Probe Health heading, up to the next heading. */
  const SECTION = /^### Probe Health[^\n]*\n([\s\S]*?)(?=^#{1,6} )/m;
  const LISTENER = /^(trap|syslog|flow)[A-Z]/;

  it('names channels that exist, and has a row for every listener channel', async () => {
    const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
    const guide = await readFile(join(repoRoot, 'docs', 'administration.md'), 'utf8');
    const section = SECTION.exec(guide)?.[1];
    assert.ok(section, 'docs/administration.md has no "### Probe Health" section');

    // The first cell of each row: one channel or several, each in backticks.
    const named = section
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .flatMap((line) => [...(line.split('|')[1] ?? '').matchAll(/`([a-zA-Z]+)`/g)])
      .map((match) => match[1] ?? '');
    // A pattern that matched nothing would make every assertion below vacuous.
    assert.ok(named.length >= 20, `parsed ${String(named.length)} channels from the table`);

    const declared = probeHealth.channels({}).map((channel) => channel.key);
    const listeners = declared.filter((key) => LISTENER.test(key));
    // The control on that pattern: three listeners, and the fewest any of them declares is four.
    assert.ok(listeners.length >= 14, `found ${String(listeners.length)} listener channels`);

    assert.deepEqual(
      named.filter((key) => !declared.includes(key)),
      [],
      "docs/administration.md's Probe Health table names channels the sensor does not declare",
    );
    assert.deepEqual(
      listeners.filter((key) => !named.includes(key)),
      [],
      "listener channels on Probe Health with no row in docs/administration.md's table",
    );
    assert.deepEqual(
      named.filter((key, index) => named.indexOf(key) !== index),
      [],
      'a channel with two rows in the table',
    );
  });
});

/**
 * Every GitHub workflow parses, and every job it defines has steps (`S-11`).
 *
 * **The workflow is the one file in this repository that nothing was checking.** It is also the
 * file that runs everything else, and it has been switched off for weeks — so a syntax error in
 * it would sit there silently until the day somebody turns CI back on and needs it to work. That
 * is the same argument `P-53` made for the PowerShell installers, and the same answer: parse it
 * in the ordinary suite, on every machine, disabled CI or not.
 *
 * Written because it caught its author. Adding `S-11`'s Windows job meant embedding PowerShell in
 * a YAML block scalar, a PowerShell here-string must close at column zero, and column zero is not
 * available inside a block scalar — so the workflow became invalid YAML and nothing said so.
 *
 * A parse is a floor and not a proof: it cannot tell whether a job does what it claims, only that
 * GitHub would get as far as reading it. The job assertions are in the job.
 */
describe('the CI workflows', () => {
  it('parse, and define jobs with steps', async () => {
    const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
    const dir = join(repoRoot, '.github', 'workflows');
    const files = (await readdir(dir)).filter(
      (name) => name.endsWith('.yml') || name.endsWith('.yaml'),
    );
    // A directory that has been renamed or emptied would make every assertion below vacuous.
    assert.ok(files.length > 0, `no workflows found in ${dir}`);

    const { load } = await import('js-yaml');
    for (const file of files) {
      const text = await readFile(join(dir, file), 'utf8');
      let document: unknown;
      try {
        document = load(text);
      } catch (error: unknown) {
        assert.fail(`${file} is not valid YAML: ${(error as Error).message}`);
      }

      const jobs = (document as { jobs?: Record<string, { steps?: unknown[] }> }).jobs;
      assert.ok(jobs !== undefined, `${file} defines no jobs`);
      for (const [name, job] of Object.entries(jobs)) {
        // A job with no steps is a job that runs nothing and reports success, which is the one
        // shape of broken workflow that looks green.
        assert.ok(
          Array.isArray(job.steps) && job.steps.length > 0,
          `${file}: job "${name}" has no steps`,
        );
      }
    }
  });
});

/**
 * No query sorts by a column it computed from the column of that name, or cast to text (`P-389`).
 *
 * A bare name in `ORDER BY` or `DISTINCT ON` resolves to an output column before an input one, so
 * `SELECT object_id::text AS object_id … ORDER BY starts_at, object_id` sorts the text, and
 * `'1000'` comes before `'999'`. `P-385` found that shape twice — the pause sweep, whose keyset
 * skipped 995..999 so they alarmed through a maintenance window, and `AccessService`'s tiebreak —
 * and both were wrong only across a power of ten, which a test database never reaches unless it is
 * made to. The review found the rest with two scripts, by hand; this is those scripts, run on
 * every suite. It reads source text, so it needs no database and takes a fraction of a second.
 *
 * The fix is to qualify the name (`ORDER BY object_pause.object_id`), which resolves the input
 * column. What it reports, and what it cannot see, is in `test/support/sql-order-aliases.ts`.
 */
describe('SQL that sorts by its own computed column', () => {
  /**
   * Each one a query that does sort by such a column and is right to, with the reason. One entry
   * per query: a second query of the same shape in the same file is not covered by the first.
   */
  const ALLOWED: readonly { where: string; column: string; reason: string }[] = [
    {
      where: 'src/notifications/health.ts ORDER BY',
      column: "coalesce(t.method, '…') AS method",
      reason:
        "Delivery Health's rows, by method name (`ORDER BY 1`). The text is what is meant: the " +
        'coalesce only names the requests that have no template.',
    },
    {
      where: 'src/objects/credential-vouching.ts ORDER BY',
      column: 'cs.kind::text AS kind (from owners)',
      reason:
        'The credential owners for a write, by sensor and then by credential kind: the kind is an ' +
        "enum's name, made text to compare with a text array, and its names are the order meant.",
    },
    {
      where: 'src/timeseries/store.ts DISTINCT ON, ORDER BY',
      column: 'sensor_id::text AS sensor_id',
      reason:
        "`stateAtHorizon`: each sensor's last state before the horizon. Text and bigint ids are " +
        'one to one, so `DISTINCT ON` keeps the same row under either. Measured in `P-388`: ' +
        'qualified, it skips the sort and is about a third faster warm at 5,000 sensors, but ' +
        'reads 45,463 blocks where this reads 386, and a retention pass reads the chunks it is ' +
        'about to drop (docs/findings/2026-10-11-state-latest-plan.md).',
    },
    // The form `P-388` measured, kept beside what replaced it so it can be measured again.
    {
      where: 'test/perf/state-latest-plan.test.ts DISTINCT ON, ORDER BY',
      column: 'sensor_id::text AS sensor_id',
      reason: '`orderedAfterLast` as it was, measured against what replaced it.',
    },
    {
      where: 'test/perf/state-latest-plan.test.ts DISTINCT ON, ORDER BY',
      column: 'sensor_id::text AS sensor_id',
      reason: '`stateAtHorizon` as it is, measured against the qualified form.',
    },
  ];

  const packageRoot = join(import.meta.dirname, '..', '..');

  /**
   * The check's own fixtures, which are the shapes it must catch, planted on purpose. Paths from
   * the package root, as `where` names files.
   */
  const FIXTURES = new Set(['test/build-hygiene.test.ts', 'test/support/sql-order-aliases.ts']);

  interface Scan {
    readonly found: Finding[];
    /** Literals with a `SELECT` in them, read under `src` and under `test`. */
    readonly literals: { readonly src: number; readonly test: number };
  }

  /**
   * Every finding in `packages/core/src` and `packages/core/test` (`P-392`), as `ALLOWED` names
   * them, with how much was read. The tests' SQL is read too: a test that sorts a text id lists
   * rows in an order nobody meant, and passes only until the ids cross a power of ten.
   */
  let scanned: Promise<Scan> | undefined;
  const scan = (): Promise<Scan> => (scanned ??= read());
  async function read(): Promise<Scan> {
    const found: Finding[] = [];
    const literals = { src: 0, test: 0 };
    const walk = async (dir: string, tree: 'src' | 'test'): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const here = join(dir, entry.name);
        const file = relative(packageRoot, here);
        if (entry.isDirectory()) await walk(here, tree);
        else if (entry.name.endsWith('.ts') && !FIXTURES.has(file)) {
          for (const literal of templateLiterals(await readFile(here, 'utf8'))) {
            if (/\bSELECT\b/u.test(literal.text)) literals[tree] += 1;
            for (const hit of sortedAliases(literal.text, literal.line)) {
              found.push({
                where: `${file} ${hit.clauses.join(', ')}`,
                column: hit.column,
                line: hit.line,
              });
            }
          }
        }
      }
    };
    await walk(join(packageRoot, 'src'), 'src');
    await walk(join(packageRoot, 'test'), 'test');
    return { found, literals };
  }

  /** Pairs each finding with an entry, each entry used once: what is left on either side. */
  function unmatched(found: readonly Finding[]): { unexplained: Finding[]; stale: string[] } {
    const left = [...ALLOWED];
    const unexplained = found.filter((finding) => {
      const index = left.findIndex(
        (entry) => entry.where === finding.where && entry.column === finding.column,
      );
      if (index === -1) return true;
      left.splice(index, 1);
      return false;
    });
    return { unexplained, stale: left.map((entry) => `${entry.where}: ${entry.column}`) };
  }

  it('has none in packages/core/src or test that the allow-list does not explain', async () => {
    const { found, literals } = await scan();
    // A floor on the reading itself: a lexer that lost its place would find no SQL, and this would
    // pass for ever while checking nothing.
    assert.ok(
      literals.src > 300,
      `read only ${String(literals.src)} literals with a SELECT in src`,
    );
    assert.ok(
      literals.test > 300,
      `read only ${String(literals.test)} literals with a SELECT in test`,
    );
    const { unexplained } = unmatched(found);
    assert.deepEqual(
      unexplained.map((one) => `${one.where} (line ${String(one.line)}): ${one.column}`),
      [],
      'a query sorts by an output column computed from the column of its name, or cast to ' +
        "text, so the sort is the computed value's — for `::text`, '1000' before '999'. Qualify the name in " +
        '`ORDER BY` / `DISTINCT ON` (`t.x`) so it is the input column, or add the query to ' +
        'ALLOWED with the reason its order is right.',
    );
  });

  it('has every allow-listed query still in the source', async () => {
    const { stale } = unmatched((await scan()).found);
    assert.deepEqual(stale, [], 'ALLOWED names a query that is gone or fixed; remove its entry');
  });

  /** The shapes it must catch, each in a template literal of a TypeScript file. */
  const CAUGHT: readonly { sql: string; column: string; clauses: string[] }[] = [
    // `P-385`'s two, as they were.
    {
      sql: `SELECT object_id::text AS object_id, starts_at FROM object_pause
            WHERE (starts_at, object_id) > ($1, $2) ORDER BY starts_at, object_id LIMIT $3`,
      column: 'object_id::text AS object_id',
      clauses: ['ORDER BY'],
    },
    {
      sql: `WITH nearest AS (SELECT DISTINCT ON (group_id) group_id, depth FROM grant_ ORDER BY
              group_id, depth)
            SELECT group_id::text AS group_id, depth FROM nearest ORDER BY depth, group_id LIMIT 1`,
      column: 'group_id::text AS group_id',
      clauses: ['ORDER BY'],
    },
    {
      sql: 'SELECT DISTINCT ON (sensor_id) sensor_id::text AS sensor_id FROM s ORDER BY sensor_id, time DESC',
      column: 'sensor_id::text AS sensor_id',
      clauses: ['DISTINCT ON', 'ORDER BY'],
    },
    // Qualified in the select list, by ordinal, with no alias (PostgreSQL still calls it `id`),
    // as a `CAST`, inside a CTE, and in lower case.
    {
      sql: 'SELECT o.id::text AS id FROM object o ORDER BY id DESC NULLS LAST',
      column: 'o.id::text AS id',
      clauses: ['ORDER BY'],
    },
    {
      sql: 'SELECT id::text AS id, name FROM object ORDER BY 1',
      column: 'id::text AS id',
      clauses: ['ORDER BY'],
    },
    {
      sql: 'SELECT id::text FROM object ORDER BY id',
      column: 'id::text AS id',
      clauses: ['ORDER BY'],
    },
    {
      sql: 'SELECT CAST(id AS text) AS id FROM object ORDER BY id',
      // Words are compared, and so reported, in lower case.
      column: 'cast(id as text) AS id',
      clauses: ['ORDER BY'],
    },
    {
      sql: `WITH page AS (SELECT id::text AS id FROM object ORDER BY id LIMIT 5) SELECT * FROM page`,
      column: 'id::text AS id',
      clauses: ['ORDER BY'],
    },
    {
      sql: 'select lower(name) as name from object order by name',
      column: 'lower(name) AS name',
      clauses: ['ORDER BY'],
    },
    // Cast to text under another name, or none.
    {
      sql: 'SELECT o.id::text AS object_id FROM object o ORDER BY object_id',
      column: 'o.id::text AS object_id',
      clauses: ['ORDER BY'],
    },
    {
      sql: 'SELECT (o.id + 1)::text FROM object o ORDER BY 1',
      column: '(o.id + 1)::text',
      clauses: ['ORDER BY'],
    },
    // An alias written without `AS` (`P-392`).
    {
      sql: 'SELECT id::text id, name FROM object ORDER BY id',
      column: 'id::text AS id',
      clauses: ['ORDER BY'],
    },
    // A number made text by `to_char` rather than by a cast (`P-392`), and text joined under the
    // name of a column it reads.
    {
      sql: "SELECT to_char(id, 'FM0000') AS code FROM object ORDER BY code",
      column: "to_char(id, '…') AS code",
      clauses: ['ORDER BY'],
    },
    {
      sql: "SELECT 'p-' || id AS id FROM object ORDER BY 1",
      column: "'…' || id AS id",
      clauses: ['ORDER BY'],
    },
    // A CTE's or a subquery's text column, sorted by the level that reads it (`P-392`): bare,
    // qualified, by ordinal, through `*`, and from a level below the one that names the CTE.
    {
      sql: 'WITH page AS (SELECT id::text AS id FROM object) SELECT id FROM page ORDER BY id',
      column: 'id::text AS id (from page)',
      clauses: ['ORDER BY'],
    },
    {
      sql: 'WITH page AS (SELECT id::text AS id FROM object) SELECT p.id FROM page p ORDER BY p.id',
      column: 'id::text AS id (from page)',
      clauses: ['ORDER BY'],
    },
    {
      sql: 'WITH page AS (SELECT id::text AS id FROM object) SELECT DISTINCT ON (id) * FROM page ORDER BY id',
      column: 'id::text AS id (from page)',
      clauses: ['DISTINCT ON', 'ORDER BY'],
    },
    {
      sql: `WITH page AS (SELECT id::text AS id FROM object)
            SELECT n FROM (SELECT id, 1 AS n FROM page ORDER BY 1) t`,
      column: 'id::text AS id (from page)',
      clauses: ['ORDER BY'],
    },
    {
      sql: 'SELECT s.id FROM other JOIN (SELECT id::text AS id FROM object) s ON true ORDER BY s.id',
      column: 'id::text AS id (from s)',
      clauses: ['ORDER BY'],
    },
  ];

  /** The shapes that resolve an input column, or sort a value that is what it says. */
  const PASSED: readonly string[] = [
    'SELECT id::text AS id FROM object ORDER BY object.id',
    'SELECT o.id::text AS id FROM object o ORDER BY o.id',
    // An expression in `ORDER BY` reads input columns only.
    'SELECT id::text AS id FROM object ORDER BY id + 0',
    // A window's and an aggregate's `ORDER BY` read input columns only.
    'SELECT id::text AS id, row_number() OVER (ORDER BY id) AS rn FROM object',
    "SELECT string_agg(id::text, ',' ORDER BY id) AS id FROM object",
    // A column under another name sorts as the column does.
    'SELECT o.id AS object_id FROM object o ORDER BY object_id',
    // Computed, but not from a column of its own name, and not made text.
    'SELECT count(*)::int AS count FROM object GROUP BY kind ORDER BY count',
    'SELECT 0 AS depth, id FROM object ORDER BY depth',
    'SELECT lower(name) AS key FROM object ORDER BY key',
    // `GROUP BY` resolves an input column first.
    'SELECT id::text AS id FROM object GROUP BY id',
    // A CTE's text column the outer level does not sort by, and one it sorts that is not text.
    'WITH x AS (SELECT id::text AS id FROM object) SELECT id FROM x',
    'WITH x AS (SELECT id::text AS label, id FROM object) SELECT label FROM x ORDER BY id',
    'WITH x AS (SELECT id FROM object) SELECT id FROM x ORDER BY x.id',
    // Cast back to a number on the way out: the outer level sorts the number.
    'WITH x AS (SELECT id::text AS id FROM object) SELECT id::bigint AS n FROM x ORDER BY n',
    // A table aliased like a CTE's column, but not the CTE.
    'WITH x AS (SELECT id::text AS id FROM object) SELECT o.id FROM object o ORDER BY o.id',
    // Words that end an expression, or a type, are not aliases written without `AS`.
    'SELECT CASE WHEN kind = $1 THEN 1 END FROM object ORDER BY 1',
    'SELECT name IS NULL FROM object ORDER BY 1',
    'SELECT name COLLATE "C" FROM object ORDER BY 1',
    // Text joined under another name: a label or a key, nearly always text already (listed as
    // not seen in the check's comment).
    "SELECT 'p-' || name AS label FROM object ORDER BY label",
    "SELECT concat(kind, ':', name) AS key FROM object ORDER BY key",
    // An array whose elements are cast, which is not a cast of the array.
    'SELECT ARRAY[name, id::text] AS path FROM object ORDER BY path',
    'SELECT id::text[] AS ids FROM object ORDER BY ids',
    // A cast of the last operand, not of the whole: `::` binds tighter than `||`.
    "SELECT name || ':' || kind::text AS key FROM object ORDER BY key",
    // In a comment or a string, not SQL.
    "SELECT id FROM object -- id::text AS id ORDER BY id\n WHERE note = 'x::text AS x ORDER BY x'",
  ];

  it('catches each shape it was written for, planted in a source file', () => {
    // Each in a template literal behind a substitution, a comment and a regular expression with a
    // backtick in it, so the lexer has to find it as well as the parser.
    const blocks = CAUGHT.map(
      ({ sql }, index) =>
        `// a \` in a comment\nconst re${String(index)} = /\`/u;\n` +
        `const q${String(index)} = \`${sql.replace('FROM', 'FROM ${table}')}\`;\n`,
    );
    const literals = templateLiterals(blocks.join(''));
    assert.deepEqual(
      literals.map((literal) =>
        sortedAliases(literal.text).map(({ column, clauses }) => ({ column, clauses })),
      ),
      CAUGHT.map(({ column, clauses }) => [{ column, clauses }]),
    );
    // Each on the line its literal starts on, the third of its block.
    assert.deepEqual(
      literals.map((literal) => literal.line),
      blocks.map((_, index) => blocks.slice(0, index).join('').split('\n').length + 2),
    );
  });

  it('passes the shapes that sort by what they mean', () => {
    assert.deepEqual(
      PASSED.map((sql) => ({ sql, found: sortedAliases(sql) })).filter(({ found }) => found.length),
      [],
    );
  });
});

interface Finding {
  readonly where: string;
  readonly column: string;
  readonly line: number;
}

describe('the smoke harnesses', () => {
  // Each boots privileged systemd containers on the machine CI shares with whoever is developing
  // on it. `smoke-packages.sh` removed its box only on the way out of a pass, so every failed
  // assertion left one running, and a night of them is what loaded the VM (`H-21`). Bash runs an
  // EXIT trap on `exit`, on `set -e`, and on the TERM that `timeout` sends.
  it('trap EXIT, before starting a box, with a handler that removes it', async () => {
    const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
    const dir = join(repoRoot, 'scripts');
    const files = (await readdir(dir)).filter((name) => /^smoke-.+\.sh$/.test(name));
    assert.ok(files.length > 0, `no smoke harnesses found in ${dir}`);

    for (const file of files) {
      const code = (await readFile(join(dir, file), 'utf8'))
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');
      const run = code.search(/\bdocker run\b/);
      if (run < 0) continue;

      // At the top level: a trap set inside a function is set only if that function runs.
      const trap = /^trap (\w+) EXIT$/m.exec(code);
      assert.ok(trap !== null, `${file} starts a container and never traps EXIT`);
      assert.ok(trap.index < run, `${file} starts a container before it traps EXIT`);

      // The handler removes a container itself, or calls a function here that does. A function
      // is one line (`fail() { …; }`) or runs to the first `}` in column 0. `docker rm -f` counts
      // as a command, not as text: the handlers that keep a box print it for the reader.
      const functions = new Map(
        [...code.matchAll(/^(\w+)\(\) \{(?:.*\}$|[\s\S]*?^\})/gm)].map(
          ([body, name = '']) => [name, body] as const,
        ),
      );
      const removes = (body: string): boolean => /(^\s*|[{;&|]\s*)docker rm -f\b/m.test(body);
      const handlerName = trap[1] ?? '';
      const handler = functions.get(handlerName) ?? '';
      const removers = [...functions].filter(([, body]) => removes(body)).map(([name]) => name);
      assert.ok(
        removes(handler) || removers.some((name) => new RegExp(`\\b${name}\\b`).test(handler)),
        `${file}: ${handlerName} removes no container`,
      );
    }
  });
});

/**
 * `scripts/test-all.sh` bounds its runs inside the container (`H-50`).
 *
 * The rc.3 cut runs the full suite through it, and it called `dev.sh "npm test"` with no bound.
 * A hung suite then had only the host's alarm, which kills `dev.sh` and leaves the toolchain
 * container running and counted by every session's VM check (CLAUDE.md, rule 22 of
 * `docs/findings/2026-09-04-tests-that-passed-for-the-wrong-reason.md`). Run here against a
 * `dev.sh` that records what it was asked to run, so nothing starts a container.
 */
describe('scripts/test-all.sh', () => {
  const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');

  /** A copy of the script beside a `dev.sh` that records its command and answers as told. */
  const run = (
    env: Record<string, string>,
    args: readonly string[] = [],
  ): { status: number | null; out: string; calls: string[] } => {
    const dir = mkdtempSync(join(tmpdir(), 'test-all-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      copyFileSync(join(repoRoot, 'scripts', 'test-all.sh'), join(dir, 'scripts', 'test-all.sh'));
      writeFileSync(
        join(dir, 'scripts', 'dev.sh'),
        [
          '#!/usr/bin/env bash',
          'printf "%s\\n" "$*" >> "$(dirname "$0")/../calls"',
          'case "$*" in',
          '  *"npm run lint"*) exit "${STUB_LINT_STATUS:-0}" ;;',
          'esac',
          "printf 'ℹ tests 2\\nℹ pass 2\\nℹ fail 0\\nℹ cancelled 0\\nℹ skipped 0\\n'",
          'exit "${STUB_TEST_STATUS:-0}"',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      const result = spawnSync('bash', [join(dir, 'scripts', 'test-all.sh'), ...args], {
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...env },
        timeout: 30_000,
      });
      const calls = existsSync(join(dir, 'calls'))
        ? readFileSync(join(dir, 'calls'), 'utf8').trimEnd().split('\n')
        : [];
      return { status: result.status, out: `${result.stdout}${result.stderr}`, calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('runs the suite and the lint each under timeout, inside the container', () => {
    const bounded = run({ MS_TEST_TIMEOUT: '77' });
    assert.equal(bounded.status, 0, bounded.out);
    assert.deepEqual(bounded.calls, ['timeout 77 npm test', 'timeout 77 npm run lint']);

    const one = run({ MS_TEST_TIMEOUT: '77' }, ['@ms/sensors']);
    assert.deepEqual(one.calls, [
      'timeout 77 npm test --workspace @ms/sensors',
      'timeout 77 npm run lint',
    ]);

    const byDefault = run({});
    assert.deepEqual(byDefault.calls, ['timeout 3600 npm test', 'timeout 3600 npm run lint']);
  });

  it('says a run stopped at its bound, and is not clean', () => {
    const suite = run({ MS_TEST_TIMEOUT: '77', STUB_TEST_STATUS: '124' });
    assert.equal(suite.status, 1, suite.out);
    assert.match(suite.out, /npm test ran past 77 s and was stopped/);
    assert.doesNotMatch(suite.out, /==> clean/);

    const lint = run({ MS_TEST_TIMEOUT: '77', STUB_LINT_STATUS: '124' });
    assert.equal(lint.status, 1, lint.out);
    assert.match(lint.out, /npm run lint ran past 77 s and was stopped/);
  });

  it('refuses a bound that is not a whole number of seconds, and runs nothing', () => {
    for (const bound of ['0', '090', '1h', '-5']) {
      const refused = run({ MS_TEST_TIMEOUT: bound });
      assert.equal(refused.status, 2, `${bound}: ${refused.out}`);
      assert.deepEqual(refused.calls, [], bound);
    }
  });
});

/**
 * The rc.3 cut checklist's guards are commands, and its redo path starts where the gates run
 * (`H-50`).
 *
 * The suite, the differential and S7 run in step 0 on the commit to be cut, and the release notes'
 * *Verified* line claims all three for the tag's parent. The redo path said "fix on `main` and cut
 * again from step 1", whose only guard was a comment, so a fix tagged a commit none of them ran
 * on; it cleared two of the page's three worktrees, so step 0.4 run again stopped at its
 * `worktree add`; and step 0.7's quiet window left `ms-server` running, which no toolchain count
 * sees. Each block is read from the page and its guards run here in bash, with `git` and `docker`
 * stubbed, so nothing touches a repository or a container.
 */
describe('the rc.3 cut checklist', () => {
  const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
  const read = (path: string): Promise<string> => readFile(join(repoRoot, path), 'utf8');
  const page = (): Promise<string> => read('docs/findings/2026-10-19-rc3-cut-checklist.md');

  /** Every fenced bash block on the page, with its list indentation taken off. */
  const blocks = (text: string): string[] =>
    [...text.matchAll(/^( *)```bash\n([\s\S]*?)^\1```$/gm)].map(([, indent = '', body = '']) =>
      body
        .split('\n')
        .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
        .join('\n'),
    );
  /** The one block that runs `marker`. */
  const only = (all: readonly string[], marker: string): string => {
    const found = all.filter((block) => block.includes(marker));
    assert.equal(found.length, 1, `one block runs ${marker}, not ${String(found.length)}`);
    return found[0] ?? '';
  };
  /** A line of `block` that `pattern` matches whole. */
  const line = (block: string, pattern: RegExp): RegExpExecArray => {
    const found = new RegExp(`^${pattern.source}$`, 'm').exec(block);
    assert.ok(found, `no line ${pattern.source} in:\n${block}`);
    return found;
  };

  /**
   * Runs `script` in bash in a scratch directory standing for `/tmp`, with `git` printing
   * `$STUB_HEAD` for anything it is asked and `docker` printing `$STUB_PS`.
   */
  const inScratch = (
    script: string,
    env: Record<string, string>,
    files: Record<string, string> = {},
  ): { status: number | null; out: string; file: (name: string) => string | undefined } => {
    const dir = mkdtempSync(join(tmpdir(), 'rc3-cut-'));
    try {
      mkdirSync(join(dir, 'bin'));
      mkdirSync(join(dir, 'rc3-diff'));
      writeFileSync(join(dir, 'bin', 'git'), '#!/bin/sh\nprintf "%s\\n" "$STUB_HEAD"\n', {
        mode: 0o755,
      });
      writeFileSync(join(dir, 'bin', 'docker'), '#!/bin/sh\nprintf "%s" "$STUB_PS"\n', {
        mode: 0o755,
      });
      for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
      const result = spawnSync('bash', ['-c', script.replaceAll('/tmp/', `${dir}/`)], {
        encoding: 'utf8',
        env: { PATH: `${join(dir, 'bin')}:${process.env['PATH'] ?? '/usr/bin:/bin'}`, ...env },
        timeout: 30_000,
      });
      const kept = new Map(
        ['rc3-suite-commit', 'rc3-diff-commit']
          .filter((name) => existsSync(join(dir, name)))
          .map((name) => [name, readFileSync(join(dir, name), 'utf8')] as const),
      );
      return {
        status: result.status,
        out: `${result.stdout}${result.stderr}`,
        file: (name) => kept.get(name),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('clears every worktree it makes before a second attempt', async () => {
    const text = await page();
    const made = [
      ...new Set(
        [...text.matchAll(/\.claude\/worktrees\/(rc3-[a-z0-9]+)/g)].map((m) => m[1] ?? ''),
      ),
    ].sort();
    assert.deepEqual(made, ['rc3-amd64', 'rc3-cut', 'rc3-suite'], 'the worktrees the page makes');

    const clear = only(blocks(text), 'git tag -d v1.0.0-rc.3');
    const loop = line(clear, /for tree in ([a-z0-9 -]+); do/);
    assert.deepEqual((loop[1] ?? '').split(' ').sort(), made, 'step 3 removes each worktree');
    const check = line(clear, /git worktree list \| grep -E 'rc3-\(([a-z0-9|]+)\)'.*/);
    assert.deepEqual(
      (check[1] ?? '')
        .split('|')
        .map((name) => `rc3-${name}`)
        .sort(),
      made,
      'step 3 checks each worktree is gone',
    );

    // Step 0.4, run again after a stop at 0.6 or 0.7, finds its worktree from the first attempt.
    const suite = only(blocks(text), './scripts/test-all.sh');
    const removed = suite.indexOf(
      'if [ -e "${suite}" ]; then git worktree remove --force "${suite}"',
    );
    const added = suite.indexOf('git worktree add --detach "${suite}" origin/main || exit 1');
    assert.ok(removed >= 0 && added > removed, 'step 0.4 removes a worktree left before adding');
  });

  it('cuts only the commit the suite and the differential passed on', async () => {
    const text = await page();
    const all = blocks(text);
    const suite = only(all, './scripts/test-all.sh');
    const differential = only(all, 'name-gate-differential.sh');

    // Each records the commit it passed on, from the line its script prints last on a pass.
    const marker = /tail -n 1 (\S+) \| grep -q '([^']+)' && git rev-parse HEAD > (\S+)/;
    const passed = [line(suite, marker), line(differential, marker)];
    const files = passed.map((found) => found[3] ?? '');
    const testAll = await read('scripts/test-all.sh');
    const gate = await read('scripts/smoke/name-gate-differential.sh');
    for (const said of [
      'echo "==> clean. Full log: ${log}"',
      'echo "==> clean, but ${skipped_suites} suite(s) never ran. Full log: ${log}"',
      'echo "==> not clean. Full log: ${log}"',
    ]) {
      assert.ok(testAll.includes(said), `test-all.sh says ${said}`);
    }
    for (const said of [
      'echo "==> NAME GATE DIFFERENTIAL PASSED (runs in ${out})"',
      'echo "==> NAME GATE DIFFERENTIAL FAILED (runs in ${out})" >&2',
    ]) {
      assert.ok(gate.includes(said), `the differential says ${said}`);
    }
    const cases: readonly (readonly [number, string, boolean])[] = [
      [0, '==> clean. Full log: /x/1.log', true],
      [0, '==> clean, but 2 suite(s) never ran. Full log: /x/1.log', false],
      [0, '==> not clean. Full log: /x/1.log', false],
      [1, '==> NAME GATE DIFFERENTIAL PASSED (runs in /tmp/rc3-diff)', true],
      [1, '==> NAME GATE DIFFERENTIAL FAILED (runs in /tmp/rc3-diff)', false],
    ];
    for (const [which, last, writes] of cases) {
      const found = passed[which];
      const out = (found?.[1] ?? '').replace('/tmp/', '');
      const name = (found?.[3] ?? '').replace('/tmp/', '');
      const ran = inScratch(found?.[0] ?? '', { STUB_HEAD: 'c0ffee' }, { [out]: `…\n${last}\n` });
      assert.equal(ran.file(name), writes ? 'c0ffee\n' : undefined, `after ${last}`);
    }
    for (const [block, file, run] of [
      [suite, files[0] ?? '', './scripts/test-all.sh'],
      [differential, files[1] ?? '', 'name-gate-differential.sh'],
    ] as const) {
      const cleared = new RegExp(`^rm -f .*${file.replaceAll('.', '\\.')}`, 'm').exec(block);
      assert.ok(cleared && cleared.index < block.indexOf(run), `${file} is cleared before ${run}`);
    }

    // The differential and S7 start only on the commit the suite passed on.
    const s7 = only(all, 'name-lookups.test.js');
    for (const [block, run] of [
      [differential, 'name-gate-differential.sh'],
      [s7, 'name-lookups.test.js'],
    ] as const) {
      const guard = line(
        block,
        new RegExp(
          `\\[ "\\$\\(cat ${(files[0] ?? '').replaceAll('.', '\\.')} 2>/dev/null\\)" = "\\$\\(git rev-parse HEAD\\)" \\] \\|\\| \\{ .*exit 1; \\}`,
        ),
      );
      assert.ok(guard.index < block.indexOf(run), `the suite's commit is checked before ${run}`);
      const suiteFile = (files[0] ?? '').replace('/tmp/', '');
      assert.equal(
        inScratch(guard[0], { STUB_HEAD: 'c0ffee' }, { [suiteFile]: 'c0ffee\n' }).status,
        0,
      );
      assert.equal(
        inScratch(guard[0], { STUB_HEAD: 'c0ffee' }, { [suiteFile]: 'feed\n' }).status,
        1,
      );
      assert.equal(inScratch(guard[0], { STUB_HEAD: 'c0ffee' }).status, 1, 'no file, no pass');
    }

    // Step 1 compares both with origin/main before it makes the branch.
    const step1 = only(all, 'git worktree add -b release/rc3');
    const loop = /^for passed in ([^;]+); do\n[\s\S]*?^done$/m.exec(step1);
    assert.ok(loop, 'step 1 compares nothing with origin/main');
    assert.deepEqual((loop[1] ?? '').split(' ').sort(), [...files].sort(), 'what step 1 compares');
    assert.ok(loop.index < step1.indexOf('git worktree add'), 'step 1 compares before it makes');
    const [suiteName, diffName] = files.map((file) => file.replace('/tmp/', ''));
    const both = { [suiteName ?? '']: 'c0ffee\n', [diffName ?? '']: 'c0ffee\n' };
    assert.equal(inScratch(loop[0], { STUB_HEAD: 'c0ffee' }, both).status, 0, 'both passed here');
    const moved = inScratch(loop[0], { STUB_HEAD: 'beef' }, both);
    assert.equal(moved.status, 1, 'a fix landed since');
    assert.match(moved.out, /cut again from step 0\.3/);
    const stale = { ...both, [diffName ?? '']: 'feed\n' };
    assert.equal(inScratch(loop[0], { STUB_HEAD: 'c0ffee' }, stale).status, 1, 'one is stale');
    const none = { [diffName ?? '']: 'c0ffee\n' };
    assert.equal(inScratch(loop[0], { STUB_HEAD: 'c0ffee' }, none).status, 1, 'no suite');

    // And a failure goes back to the gates, not to step 1.
    assert.match(
      text.replace(/\s+/g, ' '),
      /\*\*If anything fails before then\*\*, fix it on `main`, then cut again from step 0\.3/,
    );
  });

  it('stops ms-server for S7’s quiet window, refuses to run beside it, and starts it after', async () => {
    const all = blocks(await page());
    const s7 = only(all, 'name-lookups.test.js');
    const run = s7.indexOf('name-lookups.test.js');
    const stop = s7.indexOf('./scripts/dev-services.sh stop');
    const up = line(
      s7,
      /\[ -z "\$\(docker ps -q --filter name='\^ms-server\$'\)" \] \|\| \{ .*exit 1; \}/,
    );
    const busy = line(
      s7,
      /\[ "\$\(docker ps -q --filter name=toolchain-run \| wc -l \| tr -d ' '\)" = 0 \] \|\| \{ .*exit 1; \}/,
    );
    assert.ok(stop >= 0 && stop < up.index, 'S7’s block stops ms-server before it looks');
    assert.ok(up.index < run && busy.index < run, 'S7’s block looks before it runs');
    assert.equal(inScratch(up[0], { STUB_PS: '80a262488132\n' }).status, 1, 'ms-server up');
    assert.equal(inScratch(up[0], { STUB_PS: '' }).status, 0, 'ms-server stopped');
    assert.equal(inScratch(busy[0], { STUB_PS: 'a1\n' }).status, 1, 'a toolchain run');
    assert.equal(inScratch(busy[0], { STUB_PS: '' }).status, 0, 'no toolchain run');
    const made = s7.indexOf('mkdir -p /tmp/rc3-diff');
    assert.ok(made >= 0 && made < s7.indexOf('tee /tmp/rc3-diff/'), 'S7 makes what it tees into');

    // `stop` removes the container, so Docker does not start it again; `start` is checked.
    const services = await read('scripts/dev-services.sh');
    assert.match(services, /^name="ms-server"$/m);
    assert.match(services, /^ {2}stop\)\n {4}docker rm -f "\$\{name\}"/m);
    const after = only(all, './scripts/dev-services.sh start');
    const client = await read('packages/probe/src/transport/core-client.ts');
    assert.ok(client.includes("'connected to core'"), 'the probe logs connected to core');
    for (const check of ['connected to core', '"level":"error"', '%{http_code}', '"commit":"']) {
      assert.ok(after.includes(check), `ms-server's start is checked for ${check}`);
    }
  });
});
