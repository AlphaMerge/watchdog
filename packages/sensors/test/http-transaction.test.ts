import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import {
  httpTransaction,
  misplacedCredentials,
  readSteps,
  substitute,
} from '../src/types/http-transaction.js';
import { SensorCatalogue } from '../src/catalogue.js';
import type { CheckContext, CheckExecution } from '../src/contract.js';
import { SCRUBBED } from '../src/support/secrets.js';

/**
 * A real login flow, against a server that behaves like the ones this sensor exists for.
 *
 * Including the two traps: a rejected sign-in that answers 200 with the form again, and a
 * dashboard that redirects back to the login page unless the session cookie arrives. Both are
 * indistinguishable from success by status code alone, which is the whole argument for this type.
 */

let server: Server;
let port = 0;
/** Every path the server was asked for, so "the steps after a failure did not run" is assertable. */
let visited: string[] = [];
/** Every body the server was sent, by path, so what a step carried is assertable (`A-42`). */
let received: string[] = [];
const TOKEN = 'tok-9f3a';

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    visited.push(`${req.method ?? ''} ${url}`);
    const cookies = new Map<string, string>();
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const at = part.indexOf('=');
      if (at > 0) cookies.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      received.push(`${url} ${body}`);
      if (url === '/login' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/html',
          'set-cookie': 'session=guest; Path=/',
        });
        res.end(
          `<html><body><form method="post"><input name="csrf" value="${TOKEN}">` +
            '<input name="user"><input name="pass"></form></body></html>',
        );
        return;
      }
      if (url === '/login' && req.method === 'POST') {
        const fields = new URLSearchParams(body);
        if (fields.get('csrf') !== TOKEN) {
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end('bad csrf');
          return;
        }
        if (fields.get('user') !== 'ops' || fields.get('pass') !== 'hunter2') {
          // The trap. A rejected sign-in is a 200 with the form on it, and every status-code
          // sensor in the world calls that healthy.
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html><body>Sign in failed<form method="post"></form></body></html>');
          return;
        }
        res.writeHead(302, {
          location: '/dashboard',
          'set-cookie': 'session=authed; Path=/',
        });
        res.end();
        return;
      }
      if (url === '/dashboard') {
        if (cookies.get('session') !== 'authed') {
          res.writeHead(302, { location: '/login' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body>Welcome ops — 3 open tickets</body></html>');
        return;
      }
      if (url === '/logout') {
        res.writeHead(200, {
          'content-type': 'text/plain',
          'set-cookie': 'session=; Max-Age=0; Path=/',
        });
        res.end('bye');
        return;
      }
      if (url === '/whoami') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`session=${cookies.get('session') ?? 'none'}`);
        return;
      }
      if (url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('y'.repeat(20_000));
        return;
      }
      if (url === '/backtrack') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`${'a'.repeat(200)}b`);
        return;
      }
      if (url === '/echo') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`method=${req.method ?? ''} body=${body}`);
        return;
      }
      if (url === '/reflect') {
        // A server that says back what it was sent, the way debug endpoints and error pages do:
        // the header as it arrived, and the body raw, percent-encoded and in base64.
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(
          `auth=${req.headers.authorization ?? 'none'} raw=${body} ` +
            `url=${encodeURIComponent(body)} b64=${Buffer.from(body).toString('base64')}`,
        );
        return;
      }
      if (url === '/relocate') {
        res.writeHead(302, {
          location:
            `/landing?k=${encodeURIComponent(body)}` + `&b=${Buffer.from(body).toString('base64')}`,
        });
        res.end();
        return;
      }
      if (url === '/bounce') {
        res.writeHead(302, { location: '/echo' });
        res.end();
        return;
      }
      if (url === '/bounce307') {
        res.writeHead(307, { location: '/echo' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

const CREDENTIAL = { http: { username: 'ops', password: 'hunter2' } };

function run(
  params: Record<string, unknown>,
  over: Partial<CheckContext> = {},
): Promise<CheckExecution> {
  return httpTransaction.execute({
    sensorId: 1,
    target: { host: '127.0.0.1', ipVersion: 'v4' },
    params: { scheme: 'http', port, timeoutMs: 5_000, ...params },
    credentials: CREDENTIAL,
    signal: new AbortController().signal,
    ...over,
  });
}

/** The flow this sensor exists for, as an operator would actually write it. */
const LOGIN_FLOW = [
  {
    name: 'open the sign-in page',
    path: '/login',
    capture: [{ name: 'csrf', pattern: 'name="csrf" value="([^"]+)"' }],
  },
  {
    name: 'sign in',
    method: 'POST',
    path: '/login',
    headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
    body: 'csrf={{csrf}}&user={{credential.username}}&pass={{credential.password}}',
    mustContain: 'Welcome',
  },
  { name: 'read the dashboard', path: '/dashboard', mustContain: 'open tickets' },
];

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

describe('substitute', () => {
  it('fails on a name nothing provides, rather than sending an empty one', () => {
    // A login POST whose {{csrf}} quietly became "" is a request the server rejects for a reason
    // that has nothing to do with the application being down.
    assert.throws(
      () => substitute('a={{missing}}', new Map([['csrf', 'x']]), 'step 2'),
      /step 2 uses \{\{missing\}\}.*what is available here is csrf/s,
    );
  });

  it('substitutes every occurrence, and tolerates spacing', () => {
    const variables = new Map([['id', '42']]);
    assert.equal(substitute('/a/{{id}}/b/{{ id }}', variables, 'step 1'), '/a/42/b/42');
  });

  it('leaves text with no placeholders alone', () => {
    assert.equal(substitute('/plain?a=1', new Map(), 'step 1'), '/plain?a=1');
  });
});

describe('readSteps', () => {
  it('names a step after its path when it was given no name', () => {
    assert.equal(readSteps({ steps: [{ path: '/health' }] })[0]?.name, '/health');
  });

  it('makes a path absolute, because a relative one is a different request', () => {
    assert.equal(readSteps({ steps: [{ path: 'health' }] })[0]?.path, '/health');
  });
});

describe('http.transaction', () => {
  it('signs in and reaches the page behind the login', async () => {
    visited = [];
    const execution = await run({ steps: LOGIN_FLOW });

    assert.equal(execution.channels.length, 4);
    assert.ok((valueOf(execution, 'totalTime') ?? -1) > 0);
    assert.match(execution.message ?? '', /3 steps in \d+ ms; slowest was /);
    // The redirect after the POST landed on the dashboard rather than back at the login page,
    // which only happens if the session cookie set by the 302 went out on the very next hop.
    assert.ok(visited.includes('GET /dashboard'), visited.join(' | '));
  });

  it('carries the cookie set by a redirect onto the hop that follows it', async () => {
    // The reason the jar lives in `fetchHttp` rather than between steps. Reading the dashboard
    // as its own step would pass either way; this asserts it inside the POST's own redirect.
    visited = [];
    const execution = await run({
      steps: [LOGIN_FLOW[0], { ...LOGIN_FLOW[1], name: 'sign in', mustContain: 'open tickets' }],
    });
    assert.equal(execution.channels.length, 3);
    assert.equal(
      visited.filter((entry) => entry === 'GET /dashboard').length,
      1,
      `the redirect did not reach the dashboard: ${visited.join(' | ')}`,
    );
  });

  it('turns a POST into a GET across a 302, and keeps both across a 307', async () => {
    // RFC 7231 §6.4.3 permits the change "for historical reasons"; every browser and `curl -L`
    // make it, and a login POST replayed against the dashboard is a request no application
    // expects. 307 exists to say "do not do that".
    const execution = await run({
      steps: [
        { name: 'bounce', method: 'POST', path: '/bounce', body: 'a=1', mustContain: 'method=GET' },
        {
          name: 'bounce 307',
          method: 'POST',
          path: '/bounce307',
          body: 'a=1',
          mustContain: 'method=POST body=a=1',
        },
      ],
    });
    assert.equal(execution.channels.length, 3);
  });

  it('catches a rejected sign-in that answers 200 with the form again', async () => {
    await assert.rejects(
      () =>
        run(
          { steps: LOGIN_FLOW },
          { credentials: { http: { username: 'ops', password: 'wrong' } } },
        ),
      /step 2 of 3 \(sign in\) answered 200 but does not contain "Welcome"/,
    );
  });

  it('refuses to run one saved with a credential in its path or a header, and sends nothing (A-42)', async () => {
    // Saved before the rule, so it never passed `paramProblems`. It says why, in the words the
    // write would have used, and no step runs — not even the ones before it.
    for (const misplaced of [
      { name: 'call the api', path: '/v1/things?key={{credential.token}}' },
      {
        name: 'call the api',
        path: '/whoami',
        headers: [{ name: 'X-Api-Key', value: '{{ credential.token }}' }],
      },
    ]) {
      visited = [];
      const error = await run(
        { steps: [{ name: 'first', path: '/whoami' }, misplaced] },
        { credentials: { http: { token: 'sk-live-DO-NOT-LOG-ME' } } },
      ).then(
        () => null,
        (caught: unknown) => (caught instanceof Error ? caught.message : String(caught)),
      );
      assert.ok(error !== null, 'it was supposed to refuse');
      assert.match(
        error,
        /^step 2 \(call the api\) puts \{\{credential\.token\}\} in its (path|X-Api-Key header), and a credential may go only in the Authorization header or the body/,
      );
      assert.match(error, /saved before that was refused: edit it to move the credential/);
      assert.ok(!error.includes('sk-live-DO-NOT-LOG-ME'), error);
      assert.deepEqual(visited, [], 'nothing was sent');
    }
  });

  it('stops at the first failure instead of running the rest', async () => {
    // One outage is one alarm. Every step after a failed sign-in would fail for the same reason.
    visited = [];
    await assert.rejects(() =>
      run({
        steps: [
          { name: 'refuse', path: '/login', method: 'POST', body: 'csrf=nope' },
          { name: 'never runs', path: '/whoami' },
        ],
      }),
    );
    assert.ok(!visited.includes('GET /whoami'), visited.join(' | '));
  });

  it('names the step, its position and what it expected', async () => {
    await assert.rejects(
      () =>
        run({
          steps: [
            { name: 'health', path: '/whoami' },
            { name: 'the broken one', path: '/login', method: 'POST', body: 'csrf=nope' },
          ],
        }),
      /step 2 of 2 \(the broken one\) answered 403/,
    );
  });

  it('fails when a capture found nothing, rather than leaving a hole for a later step', async () => {
    await assert.rejects(
      () =>
        run({
          steps: [
            { name: 'open', path: '/login', capture: [{ name: 'csrf', pattern: 'nothing="(x)"' }] },
          ],
        }),
      /step 1 of 1 \(open\) did not match \/nothing="\(x\)"\/, so \{\{csrf\}\}/,
    );
  });

  it('forgets a cookie the server cleared', async () => {
    const execution = await run({
      steps: [
        { name: 'sign in', path: '/login' },
        { name: 'check', path: '/whoami', mustContain: 'session=guest' },
        { name: 'sign out', path: '/logout' },
        { name: 'check again', path: '/whoami', mustContain: 'session=none' },
      ],
    });
    assert.equal(execution.channels.length, 5);
  });

  it('declares one channel per step, keyed by position and named by label', () => {
    // Keyed by position so renaming a step keeps its history; named by label so the graph is
    // readable. A checkout that got slower got slower somewhere.
    const defs = httpTransaction.channels({ steps: LOGIN_FLOW });
    assert.deepEqual(
      defs.map((def) => def.key),
      ['totalTime', 'step1', 'step2', 'step3'],
    );
    assert.equal(defs[2]?.name, 'sign in');
    assert.deepEqual(
      defs.filter((def) => def.isPrimary === true).map((def) => def.key),
      ['totalTime'],
    );
  });

  it('fails rather than truncating a response bigger than it reads', async () => {
    await assert.rejects(
      () => run({ maxBodyBytes: 2_048, steps: [{ name: 'huge', path: '/big' }] }),
      /step 1 of 1 \(huge\) returned 20000 bytes, larger than the 2048 bytes/,
    );
  });

  it('stops a backtracking capture instead of holding the worker', async () => {
    const started = Date.now();
    await assert.rejects(
      () =>
        run({
          steps: [
            { name: 'trap', path: '/backtrack', capture: [{ name: 'x', pattern: '^(a+)+$' }] },
          ],
        }),
      /still running after \d+ ms and was stopped/,
    );
    assert.ok(Date.now() - started < 5_000, 'the watchdog ends it, not the scan interval');
  });

  it('searches past the four kilobytes an SNMP string is bounded to', async () => {
    // `pattern.ts` bounds a subject at 4 KB, which is right for something an agent returned and
    // wrong for a page: a token below the fold would read as "not found" — a value reported as
    // missing when it is right there.
    const execution = await run({
      steps: [
        { name: 'far down', path: '/big', capture: [{ name: 'tail', pattern: '(y)y{19998}' }] },
      ],
    });
    assert.equal(execution.channels.length, 2);
  });
});

describe('where a credential may go (`A-42`)', () => {
  const catalogue = new SensorCatalogue().register(httpTransaction).seal();
  const PASSWORD = 'hunter2&x';
  const SENT = { http: { username: 'ops', password: PASSWORD } };
  /** Through the catalogue, which is what hands the type S-19's scrub. */
  const through = (steps: unknown[]): Promise<CheckExecution> =>
    catalogue.execute('http.transaction', {
      sensorId: 1,
      target: { host: '127.0.0.1', ipVersion: 'v4' },
      params: { scheme: 'http', port, timeoutMs: 5_000, followRedirects: false, steps },
      credentials: SENT,
      signal: new AbortController().signal,
    });
  /** The password as a server echoes it: raw, percent-encoded, in base64, and in basic auth's pair. */
  const echoes = [
    PASSWORD,
    encodeURIComponent(PASSWORD),
    Buffer.from(PASSWORD).toString('base64'),
    Buffer.from(`ops:${PASSWORD}`).toString('base64'),
  ];

  it('refuses a credential anywhere but the Authorization header and the body, naming the step and the field', () => {
    const outcome = catalogue.validate('http.transaction', {
      steps: [
        {
          name: 'sign in',
          method: 'POST',
          path: '/login',
          body: 'pass={{credential.password}}',
          headers: [
            { name: 'Authorization', value: 'Token {{credential.token}}' },
            { name: ' authorization ', value: '{{ credential.password }}' },
          ],
        },
        {
          name: 'call the api',
          path: '/v1/things?key={{ credential.token }}',
          headers: [
            { name: 'Accept', value: 'text/plain' },
            { name: 'X-Api-Key', value: '{{credential.token}}' },
          ],
        },
      ],
    });
    assert.ok(!outcome.valid);
    assert.deepEqual(
      outcome.problems.map((problem) => problem.path),
      ['/steps/1/path', '/steps/1/headers/1/value'],
    );
    assert.match(
      outcome.problems[0]?.message ?? '',
      /^step 2 \(call the api\) puts \{\{credential\.token\}\} in its path, and a credential may go only in the Authorization header or the body/,
    );
    assert.match(
      outcome.problems[1]?.message ?? '',
      /^step 2 \(call the api\) puts \{\{credential\.token\}\} in its X-Api-Key header/,
    );
    // The flow the sensor exists for is still one it takes.
    assert.ok(catalogue.validate('http.transaction', { steps: LOGIN_FLOW }).valid);
    // A capture is named for a later step, and cannot be named for a credential.
    assert.ok(
      !catalogue.validate('http.transaction', {
        steps: [{ path: '/', capture: [{ name: 'credential.password', pattern: '(x)' }] }],
      }).valid,
    );
  });

  it('names a step by its path when it has no name, and finds nothing where there is nothing', () => {
    assert.deepEqual(misplacedCredentials({ steps: [{ path: '/a' }, 'not a step'] }), []);
    assert.deepEqual(misplacedCredentials({}), []);
    assert.match(
      misplacedCredentials({ steps: [{ path: '/x?u={{credential.username}}' }] })[0]?.message ?? '',
      /^step 1 \(\/x\?u=\{\{credential\.username\}\}\) puts \{\{credential\.username\}\} in its path/,
    );
  });

  it('scrubs an echo before a capture carries it into the next step', async () => {
    // Allowed where it went — the body, and basic auth's header — and echoed straight back. A
    // capture of the echo, put in a later step's path, would be the path rule undone. Carried on
    // in a body here, because a path or a header refuses the marker's characters outright.
    received = [];
    await through([
      {
        name: 'post it',
        method: 'POST',
        path: '/reflect',
        body: '{{credential.password}}',
        capture: [
          { name: 'raw', pattern: 'raw=(\\S+)' },
          { name: 'url', pattern: 'url=(\\S+)' },
          { name: 'b64', pattern: 'b64=(\\S+)' },
          { name: 'basic', pattern: 'auth=Basic (\\S+)' },
        ],
      },
      {
        name: 'carry it on',
        method: 'POST',
        path: '/whoami',
        body: 'r={{raw}}&u={{url}}&b={{b64}}&a={{basic}}',
      },
    ]);
    const carried = received.find((one) => one.startsWith('/whoami ')) ?? '';
    for (const echo of echoes) assert.ok(!carried.includes(echo), `${echo} in ${carried}`);
    assert.equal(
      carried,
      `/whoami r=${SCRUBBED}&u=${SCRUBBED}&b=${SCRUBBED}&a=${SCRUBBED}`,
      'each capture carried the marker, not the secret',
    );
  });

  it('cannot be asked whether a response holds the password', async () => {
    // Without the scrub, `mustContain` over an echo is a question with a yes or no answer — the
    // sensor's state — and a writer could spell the password out one guess at a time.
    for (const guess of [PASSWORD, 'hunter', encodeURIComponent(PASSWORD)]) {
      await assert.rejects(
        () =>
          through([
            {
              name: 'guess',
              method: 'POST',
              path: '/reflect',
              body: '{{credential.password}}',
              mustContain: guess,
            },
          ]),
        /step 1 of 1 \(guess\) answered 200 but does not contain/,
        guess,
      );
    }
  });

  it('says nothing of an echo in a redirect it reports, raw or encoded', async () => {
    const error = await through([
      {
        name: 'post it',
        method: 'POST',
        path: '/relocate',
        body: '{{credential.password}}',
        expectStatus: '200',
      },
    ]).then(
      () => null,
      (caught: unknown) => (caught instanceof Error ? caught.message : String(caught)),
    );
    assert.ok(error !== null, 'a 302 was supposed to fail a step expecting 200');
    assert.match(
      error,
      /step 1 of 1 \(post it\) answered 302, and expects 200 pointing at \/landing/,
    );
    for (const echo of echoes) assert.ok(!error.includes(echo), `${echo} in ${error}`);
    assert.ok(error.includes(`k=${SCRUBBED}&b=${SCRUBBED}`), error);
  });
});
