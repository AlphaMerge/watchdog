import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { httpAdvanced } from '../src/types/http-advanced.js';
import { SensorCatalogue } from '../src/catalogue.js';
import { HTTP_CONTENT_OWN_KEYS, httpContent } from '../src/types/http-content.js';
import type { CheckContext, CheckExecution, SensorType } from '../src/contract.js';

let server: Server;
let port = 0;
/** What the last request carried, so the header and auth assertions can read it. */
let lastHeaders: IncomingHttpHeaders = {};
let lastMethod = '';
let lastBody = '';

before(async () => {
  server = createServer((req, res) => {
    lastHeaders = req.headers;
    lastMethod = req.method ?? '';
    lastBody = '';
    req.on('data', (chunk: Buffer) => {
      lastBody += chunk.toString('utf8');
    });
    req.on('end', () => {
      const url = req.url ?? '/';

      if (url === '/status') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'abc123' });
        res.end(JSON.stringify({ status: 'healthy', queue: 12, version: '4.2.1', uptime: 98.5 }));
        return;
      }
      if (url === '/broken') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body>NullPointerException at line 42</body></html>');
        return;
      }
      if (url === '/nocache') {
        // Deliberately sets no Cache-Control: the header check is what notices.
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('ok');
        return;
      }
      if (url === '/cached') {
        res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'public, max-age=300' });
        res.end('ok');
        return;
      }
      if (url === '/huge') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('y'.repeat(20_000));
        return;
      }
      if (url === '/backtrack') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`${'a'.repeat(200)}b`);
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

function run(
  type: SensorType,
  params: Record<string, unknown> = {},
  over: Partial<CheckContext> = {},
): Promise<CheckExecution> {
  return type.execute({
    sensorId: 1,
    target: { host: '127.0.0.1', ipVersion: 'v4' },
    params: { scheme: 'http', port, timeoutMs: 5_000, ...params },
    credentials: {},
    signal: new AbortController().signal,
    ...over,
  });
}

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

describe('http.advanced', () => {
  it('sends the headers, method and body it was given', async () => {
    await run(httpAdvanced, {
      path: '/',
      method: 'POST',
      body: '{"ping":1}',
      requestHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    });
    assert.equal(lastMethod, 'POST');
    assert.equal(lastBody, '{"ping":1}');
    assert.equal(lastHeaders['content-type'], 'application/json');
  });

  it('turns a stored bearer token into an Authorization header', async () => {
    // The credential is on the *device*, inherited: a hundred sensors against one API rotate
    // their token in one place rather than a hundred.
    await run(httpAdvanced, { path: '/' }, { credentials: { http: { token: 'sekrit-token' } } });
    assert.equal(lastHeaders['authorization'], 'Bearer sekrit-token');
  });

  it('turns a stored user name and password into basic authentication', async () => {
    await run(
      httpAdvanced,
      { path: '/' },
      { credentials: { http: { username: 'ops', password: 'hunter2' } } },
    );
    assert.equal(
      lastHeaders['authorization'],
      `Basic ${Buffer.from('ops:hunter2').toString('base64')}`,
    );
  });

  it('prefers a token when both are set, so moving to one is the easy change', async () => {
    await run(
      httpAdvanced,
      { path: '/' },
      { credentials: { http: { username: 'ops', password: 'old', token: 'new-token' } } },
    );
    assert.equal(lastHeaders['authorization'], 'Bearer new-token');
  });

  it('needs no credential at all, because plenty of endpoints do not', async () => {
    const execution = await run(httpAdvanced, { path: '/' });
    assert.equal(valueOf(execution, 'statusCode'), 200);
    assert.equal(lastHeaders['authorization'], undefined);
  });

  it('fails when a required response header is missing', async () => {
    // A cache that stopped setting Cache-Control is a real regression that a status code and a
    // response time both report as perfectly healthy.
    await assert.rejects(
      () => run(httpAdvanced, { path: '/nocache', expectHeaders: [{ name: 'Cache-Control' }] }),
      /response headers are wrong: Cache-Control is missing/,
    );
  });

  it('fails when a required header is present but says the wrong thing', async () => {
    await assert.rejects(
      () =>
        run(httpAdvanced, {
          path: '/cached',
          expectHeaders: [{ name: 'Cache-Control', contains: 'no-store' }],
        }),
      /Cache-Control is "public, max-age=300" and should contain "no-store"/,
    );
  });

  it('passes when the header is there and contains what it should', async () => {
    const execution = await run(httpAdvanced, {
      path: '/cached',
      expectHeaders: [{ name: 'Cache-Control', contains: 'max-age' }],
    });
    assert.equal(valueOf(execution, 'statusCode'), 200);
  });
});

describe('http.content', () => {
  it('pulls numbers out of a response into channels', async () => {
    const execution = await run(httpContent, {
      path: '/status',
      extract: [
        { key: 'queue', name: 'Queue depth', unit: 'jobs', pattern: '"queue":\\s*(\\d+)' },
        { key: 'uptime', name: 'Uptime', unit: '%', pattern: '"uptime":\\s*([0-9.]+)' },
      ],
    });
    assert.equal(valueOf(execution, 'queue'), 12);
    assert.equal(valueOf(execution, 'uptime'), 98.5);
    assert.match(execution.message ?? '', /queue=12 uptime=98\.5/);
  });

  it('makes the first extraction the channel the sensor is judged by', () => {
    const defs = httpContent.channels({
      extract: [
        { key: 'queue', pattern: 'a' },
        { key: 'depth', pattern: 'b' },
      ],
    });
    assert.deepEqual(
      defs.filter((def) => def.isPrimary === true).map((def) => def.key),
      ['queue'],
    );
    // Response time is still there, last, so a content sensor is still a timing sensor.
    assert.equal(defs[defs.length - 1]?.key, 'responseTime');
  });

  it('checks for text that must be there', async () => {
    const execution = await run(httpContent, { path: '/status', mustContain: 'healthy' });
    assert.ok((valueOf(execution, 'responseTime') ?? -1) >= 0);
    await assert.rejects(
      () => run(httpContent, { path: '/status', mustContain: 'degraded' }),
      /does not contain "degraded"/,
    );
  });

  it('checks for text that must not be there', async () => {
    // A page that returns 200 with a stack trace in it is Up by every other measure.
    await assert.rejects(
      () => run(httpContent, { path: '/broken', mustNotContain: 'Exception' }),
      /contains "Exception"/,
    );
  });

  it('gaps a number that stopped appearing, rather than reporting zero', async () => {
    const execution = await run(httpContent, {
      path: '/status',
      extract: [
        { key: 'queue', pattern: '"queue":\\s*(\\d+)' },
        { key: 'missing', pattern: '"nothing":\\s*(\\d+)' },
      ],
    });
    assert.equal(valueOf(execution, 'queue'), 12);
    assert.equal(valueOf(execution, 'missing'), undefined);
    assert.match(execution.message ?? '', /missing was not found/);
  });

  it('fails when none of its patterns matched at all', async () => {
    await assert.rejects(
      () => run(httpContent, { path: '/status', extract: [{ key: 'x', pattern: 'nope(\\d+)' }] }),
      /matched none of this sensor’s patterns/,
    );
  });

  it('fails rather than truncating a response bigger than it reads', async () => {
    // A pattern matched against half a document reports a value as missing, which is a far more
    // confusing fault than "this page is bigger than this sensor will read".
    await assert.rejects(
      () => run(httpContent, { path: '/huge', maxBodyBytes: 2_048, mustContain: 'y' }),
      /larger than the 2048 bytes this sensor reads/,
    );
  });

  it('refuses a pattern that is not a regular expression, before requesting anything', async () => {
    await assert.rejects(
      () => run(httpContent, { path: '/status', extract: [{ key: 'x', pattern: '([0-9]+' }] }),
      /not a valid regular expression/,
    );
  });

  it('stops a backtracking pattern instead of holding the worker', async () => {
    // The sandbox `T-03` built, on its third caller. JavaScript has no interruptible regex, so
    // `ctx.signal` cannot help and a mistyped pattern would run until the pool killed the worker.
    const started = Date.now();
    await assert.rejects(
      () =>
        run(httpContent, {
          path: '/backtrack',
          extract: [{ key: 'x', pattern: '^(a+)+$' }],
        }),
      /still running after \d+ ms and was stopped.*nested quantifier/s,
    );
    assert.ok(Date.now() - started < 5_000, 'the watchdog, not the scan interval, ends it');
  });
});

describe('an http.content extract key (P-348)', () => {
  const catalogue = new SensorCatalogue().register(httpContent).seal();
  const withKey = (key: string): Record<string, unknown> => ({
    path: '/status',
    extract: [{ key, pattern: 'queue=(\\d+)' }],
  });

  it('names exactly the key the sensor reports of its own', () => {
    assert.deepEqual(
      httpContent.channels({}).map((def) => def.key),
      [...HTTP_CONTENT_OWN_KEYS],
    );
  });

  it('refuses the sensor’s own key, spaced as readExtractions would trim it', () => {
    for (const own of HTTP_CONTENT_OWN_KEYS) {
      for (const key of [own, ` ${own}`, `${own} `]) {
        const outcome = catalogue.validate(httpContent.id, withKey(key));
        assert.ok(!outcome.valid, JSON.stringify(key));
        assert.deepEqual(
          outcome.problems.map((problem) => problem.path),
          ['/extract/0/key'],
        );
      }
    }
  });

  it('still takes a key that only resembles it, declared once', () => {
    for (const key of ['ResponseTime', 'responseTime2', 'response time', 'queue']) {
      const outcome = catalogue.validate(httpContent.id, withKey(key));
      assert.ok(outcome.valid, key);
      const keys = catalogue.channelsFor(httpContent.id, outcome.params).map((def) => def.key);
      assert.equal(new Set(keys).size, keys.length, key);
    }
  });
});
