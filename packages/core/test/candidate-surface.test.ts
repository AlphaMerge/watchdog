import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { BUILT_IN_SENSOR_TYPES } from '@ms/sensors';
import { BUILD_MANIFEST, readBuildStamp, type BuildStamp } from '@ms/shared';
import {
  baseOptions,
  concrete,
  surfaceServer,
  type RouteKey,
  type SurfaceServer,
} from './support/surface.js';

/**
 * The release candidate's surface, tested (`H-13`).
 *
 * The appendix of `docs/runbook-field-test.md` lists what the v1 candidate is: every route it
 * answers, which of them answer without a credential, and which sensor types it offers. This file
 * compares that table **in both directions** with a v1 core built without a database. Its stamp
 * is read from a manifest, as a package's is, and its v2 decision comes from the same `profile.ts`
 * that `main.ts` calls.
 *
 * **Every claim is asked of the running server, never of a flag or a document.**
 *
 * - The routes are found by `inject`, not by reading the OpenAPI document, because
 *   `@fastify/websocket` hides a real route from that (`H-07`). "Absent from the document" and
 *   "does not answer" are different statements.
 * - The public set is found by requesting every route with no credential. A test that read
 *   `publicPrefixes` would pass against a build that exempted the prefix and forgot to remove the
 *   routes, or the reverse.
 *
 * A comparison of A with B is two tests, and passing one is not passing the other (catalogue
 * entry 43), so each claim is checked from both sides: what the server does that the table does
 * not say, and what the table says that the server does not do.
 *
 * The probe half — a v1 probe refusing a `flow.netflow` assignment by name — is in
 * `packages/probe/test/build-profile.test.ts`. Provenance, the other half of "is this the
 * candidate", runs against an installed package in `scripts/smoke-packages.sh`.
 */

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const HEADING = '## Appendix: the candidate’s surface';

type Access = 'public' | '401';

interface Table {
  readonly routes: ReadonlyMap<RouteKey, Access>;
  /** Every built-in sensor type, and whether the candidate carries it. */
  readonly sensorTypes: ReadonlyMap<string, boolean>;
}

/** `| \`/api/v1/objects/{id}\` | GET · PATCH · DELETE | 401 |` */
const ROUTE_ROW =
  /^\|\s*`(\/[^`\s]*)`\s*\|\s*([A-Z]+(?:\s*·\s*[A-Z]+)*)\s*\|\s*(\*\*public\*\*|401)\s*\|\s*$/u;
/** `| \`icmp.ping\` | yes |` or `| \`flow.netflow\` | **no** |` */
const TYPE_ROW = /^\|\s*`([a-z0-9]+(?:\.[a-z0-9]+)+)`\s*\|\s*(yes|\*\*no\*\*)\s*\|\s*$/u;

/**
 * The appendix's two tables, and **every row of them**.
 *
 * A row that matches neither pattern is refused rather than skipped. Otherwise a v2 route added
 * with a typo would be ignored, and the document would claim something no test had read.
 */
function readTable(runbook: string): Table {
  const start = runbook.indexOf(HEADING);
  assert.ok(start >= 0, `docs/runbook-field-test.md has no "${HEADING}" section`);
  const section = runbook.slice(start);
  const end = section.indexOf('\n## ', HEADING.length);
  const lines = (end < 0 ? section : section.slice(0, end)).split('\n');

  const routes = new Map<RouteKey, Access>();
  const sensorTypes = new Map<string, boolean>();
  const unread: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('| `')) continue;
    const route = ROUTE_ROW.exec(line);
    if (route !== null) {
      const [, path = '', methods = '', access = ''] = route;
      for (const method of methods.split('·').map((one) => one.trim())) {
        const key: RouteKey = `${method} ${path}`;
        assert.equal(routes.has(key), false, `the runbook lists ${key} twice`);
        routes.set(key, access === '401' ? '401' : 'public');
      }
      continue;
    }
    const type = TYPE_ROW.exec(line);
    if (type !== null) {
      const [, id = '', carried = ''] = type;
      assert.equal(sensorTypes.has(id), false, `the runbook lists ${id} twice`);
      sensorTypes.set(id, carried === 'yes');
      continue;
    }
    unread.push(line);
  }
  assert.deepEqual(unread, [], 'rows in the runbook’s surface tables that this test cannot read');
  return { routes, sensorTypes };
}

/** A manifest in the shape `scripts/package.sh` writes, read the way a packaged core reads its own. */
async function stampFrom(
  directory: string,
  manifest: Record<string, unknown>,
): Promise<BuildStamp> {
  const file = join(directory, BUILD_MANIFEST);
  await writeFile(file, JSON.stringify(manifest), 'utf8');
  return readBuildStamp(pathToFileURL(file), {});
}

function codeOf(response: LightMyRequestResponse): string | undefined {
  try {
    return response.json<{ error?: { code?: string } }>().error?.code;
  } catch {
    return undefined;
  }
}

async function ask(surface: SurfaceServer, key: RouteKey): Promise<LightMyRequestResponse> {
  const [method = 'GET', path = '/'] = key.split(' ');
  return surface.server.app.inject({
    method: method as 'GET',
    url: concrete(path),
    ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }),
  });
}

/**
 * The route exists, whatever it said.
 *
 * Only the core's own not-found handler says `ROUTE_NOT_FOUND`. A handler's 404 for a missing
 * object, a 400 for a body, a 500 from the stub database: each of them means a route answered.
 */
async function answers(surface: SurfaceServer, key: RouteKey): Promise<boolean> {
  const response = await ask(surface, key);
  return !(response.statusCode === 404 && codeOf(response) === 'ROUTE_NOT_FOUND');
}

/** Refused for want of a credential, by the authentication or the authorisation hook. */
async function refused(surface: SurfaceServer, key: RouteKey): Promise<boolean> {
  const response = await ask(surface, key);
  return response.statusCode === 401 && codeOf(response) === 'AUTH_REQUIRED';
}

function differences(label: string, extra: readonly string[], missing: readonly string[]): string {
  return (
    `${label}\n` +
    `  answers, and the runbook does not list it:\n    ${extra.join('\n    ') || '(none)'}\n` +
    `  the runbook lists it, and it does not answer:\n    ${missing.join('\n    ') || '(none)'}`
  );
}

/**
 * Asked of the v1 server on top of every registered route: the literal the proposal names, and a
 * path no build has, which must be refused without saying whether it exists.
 */
const PROBES: readonly RouteKey[] = [
  'GET /api/v1/public/maps/anything',
  'GET /api/v1/no-such-route',
];

describe('the release candidate’s surface (`H-13`)', () => {
  let directory: string;
  let stamp: BuildStamp;
  let table: Table;
  /** `auth.required` off, so that every handler is reachable: what answers. */
  let open: SurfaceServer;
  /** `auth.required` on: what answers without a credential. */
  let locked: SurfaceServer;
  /** Every v2 service stubbed in, as the API reference builds it: what v1 must not answer. */
  let full: SurfaceServer;
  /** Every route either build registered, every route the table lists, and the probes above. */
  let candidates: RouteKey[];
  const built: SurfaceServer[] = [];

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ms-surface-'));
    stamp = await stampFrom(directory, {
      version: '1.0.0-rc.1',
      commit: '0123456789abcdef0123456789abcdef01234567',
      dirty: false,
      profile: 'v1',
    });
    table = readTable(await readFile(join(repoRoot, 'docs', 'runbook-field-test.md'), 'utf8'));
    open = await surfaceServer(stamp, { required: false, v2: 'profile' });
    locked = await surfaceServer(stamp, { required: true, v2: 'profile' });
    full = await surfaceServer({ ...stamp, profile: 'full' }, { required: false, v2: 'stubbed' });
    built.push(open, locked, full);
    candidates = [
      ...new Set([...open.registered, ...full.registered, ...table.routes.keys(), ...PROBES]),
    ].sort();
  });

  after(async () => {
    await Promise.all(built.map((surface) => surface.close()));
    await rm(directory, { recursive: true, force: true });
  });

  it('is a v1 build, read from its stamp the way a package reads its own', () => {
    assert.equal(stamp.profile, 'v1');
  });

  it('answers every route the runbook lists, and nothing else', async () => {
    const answered: RouteKey[] = [];
    for (const key of candidates) if (await answers(open, key)) answered.push(key);

    const listed = new Set(table.routes.keys());
    const extra = answered.filter((key) => !listed.has(key));
    const missing = [...listed].filter((key) => !answered.includes(key));
    assert.deepEqual(
      { extra, missing },
      { extra: [], missing: [] },
      differences(
        'The v1 core’s routes and the runbook’s table disagree. A route that answers and is ' +
          'not listed is surface the field test did not agree to; a listed route that does ' +
          'not answer is one the profile took with it.',
        extra,
        missing,
      ),
    );
  });

  it('is asked of the router, which answers a route the OpenAPI document hides', async () => {
    // Why `inject` and not the document: this route is real, is in the table, and is missing from
    // the document. A check that read the document would have to be told about it, and would say
    // nothing about the next one.
    const stream: RouteKey = 'GET /api/v1/stream';
    const documented = Object.keys(
      (open.server.app.swagger() as { paths?: Record<string, unknown> }).paths ?? {},
    );
    assert.equal(documented.includes('/api/v1/stream'), false, 'the document carries it now');
    assert.equal(await answers(open, stream), true);
    assert.equal(table.routes.has(stream), true);
  });

  it('refuses every route but the three the runbook calls public to a request with no credential', async () => {
    const admitted: RouteKey[] = [];
    for (const key of candidates) if (!(await refused(locked, key))) admitted.push(key);

    const expected = [...table.routes]
      .filter(([, access]) => access === 'public')
      .map(([key]) => key);
    assert.deepEqual(
      admitted.sort(),
      expected.sort(),
      'the routes a v1 core answers without a credential are not the ones the runbook lists as ' +
        'public. The web shell and its files are public too, carry no data, and are not in this ' +
        'claim; nothing under /api/ or at /metrics is, except these.',
    );
    // Stated rather than inferred, because it is what the proposal promised the field test.
    assert.deepEqual(expected.sort(), [
      'GET /api/v1/auth/session',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/logout',
    ]);
  });

  it('offers the sensor types the runbook says it carries, and none that it withholds', async () => {
    const response = await open.server.app.inject({ method: 'GET', url: '/api/v1/sensor-types' });
    assert.equal(response.statusCode, 200);
    const served = response
      .json<{ items: { id: string }[] }>()
      .items.map((type) => type.id)
      .sort();

    const carried = [...table.sensorTypes].filter(([, yes]) => yes).map(([id]) => id);
    assert.deepEqual(
      served,
      carried.sort(),
      'the sensor types a v1 core offers are not the ones the runbook says the candidate carries',
    );
    // And the table accounts for every built-in type, so a new one cannot arrive unlisted either
    // way — carried by a candidate nobody agreed to, or withheld without saying so.
    assert.deepEqual(
      [...table.sensorTypes.keys()].sort(),
      BUILT_IN_SENSOR_TYPES.map((type) => type.id).sort(),
      'the runbook’s sensor-type table does not list exactly the built-in types',
    );
  });

  it('sees a v2 route when one is registered, so that their absence is the profile’s doing', async () => {
    // Without this, a harness that could not see a map route at all would pass everything above.
    for (const key of [
      'GET /api/v1/maps',
      'GET /api/v1/reports',
      'GET /api/v1/libraries',
      'GET /api/v1/public/maps/{token}',
    ] as const) {
      assert.equal(await answers(full, key), true, `the full harness does not answer ${key}`);
      assert.equal(table.routes.has(key), false, `the runbook lists ${key}`);
    }

    const build = async (surface: SurfaceServer) =>
      (await surface.server.app.inject({ method: 'GET', url: '/api/v1/build' })).json<{
        profile: string;
        subsystems: Record<string, boolean>;
      }>();
    assert.deepEqual(await build(open), {
      ...stamp,
      subsystems: { maps: false, reports: false, libraries: false },
    });
    assert.deepEqual((await build(full)).subsystems, {
      maps: true,
      reports: true,
      libraries: true,
    });
  });

  it('refuses a manifest that does not name its profile, rather than building everything', async () => {
    // What a package made before `H-12` carries. Read as `full`, it would be every row above.
    await assert.rejects(
      stampFrom(directory, { version: '1.0.0-rc.1', commit: null, dirty: false }),
      /does not say which profile it was built as/,
    );
  });

  it('is built the way main.ts builds its API', async () => {
    // **The harness is only as good as its likeness to `main.ts`.** A service passed here and
    // forgotten there would answer routes here that the shipped core does not. That is `G-01`'s
    // maps API, which every test passed while nothing mounted it. The v2 services must reach
    // `ApiServer` through `profile.ts` and nowhere else, or the profile is not what decides them.
    const main = await readFile(join(repoRoot, 'packages', 'core', 'src', 'main.ts'), 'utf8');
    const opening = main.indexOf('new ApiServer({');
    assert.ok(opening >= 0, 'main.ts builds no ApiServer');
    const block = main.slice(opening, main.indexOf('\n  });', opening));
    const keys = [...block.matchAll(/^ {4}(?:\.\.\.(\w+)\(|(\w+)(?=[,:]))/gmu)].map(
      ([, spread, key]) => (spread === undefined ? (key ?? '') : `...${spread}`),
    );

    assert.deepEqual(
      keys.sort(),
      [...Object.keys(baseOptions(stamp, true)), '...v2ApiOptions'].sort(),
      'main.ts passes ApiServer something this harness does not, or the reverse',
    );
  });
});
