import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import { httpRequest } from '../src/types/http.js';
import { resolveRedirect, statusAccepted } from '../src/support/http/request.js';
import type { CheckContext, CheckExecution } from '../src/contract.js';

/**
 * A real HTTP server, because the interesting behaviour is all at the protocol edges: a redirect
 * chain, a redirect that leaves the device, a server that answers the headers and then thinks
 * for a while, and a body big enough that buffering it would matter.
 */

let server: Server;
let port = 0;
/** Every path the server was asked for, so a redirect chain can be asserted as a *chain*. */
let seen: string[] = [];

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    seen.push(url);

    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
      return;
    }
    if (url === '/slow-body') {
      // Headers now, body later: this is what separates time-to-first-byte from the total, and
      // a sensor with one timing cannot tell an operator which of the two moved.
      //
      // `flushHeaders` is the whole trick, and leaving it out is why this test failed first
      // time: `writeHead` only *stages* the headers, and Node sends them with the first body
      // chunk — so the server appeared to think for 250 ms and then answer instantly, which is
      // exactly the shape this test exists to tell apart.
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.flushHeaders();
      setTimeout(() => {
        res.end('done');
      }, 250);
      return;
    }
    if (url === '/hang') {
      // Never answers at all, so a timeout or an abort is the only way out.
      return;
    }
    if (url === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      // 4 MB in chunks. Counted, never accumulated — buffering this in a worker shared by
      // hundreds of sensors is how one bad URL takes all of them down.
      let sent = 0;
      const pump = (): void => {
        while (sent < 4_194_304) {
          sent += 65_536;
          if (!res.write('x'.repeat(65_536))) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
      return;
    }
    if (url === '/hop1') {
      res.writeHead(302, { location: '/hop2' });
      res.end();
      return;
    }
    if (url === '/hop2') {
      res.writeHead(302, { location: '/' });
      res.end();
      return;
    }
    if (url === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
      return;
    }
    if (url === '/offsite') {
      res.writeHead(301, { location: 'https://elsewhere.example.com/landing' });
      res.end();
      return;
    }
    if (url === '/teapot') {
      res.writeHead(418, { 'content-type': 'text/plain' });
      res.end('no');
      return;
    }
    if (url === '/echo') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, body, agent: req.headers['user-agent'] }));
      });
      return;
    }
    res.writeHead(404);
    res.end('nope');
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
  params: Record<string, unknown> = {},
  over: Partial<CheckContext> = {},
): Promise<CheckExecution> {
  seen = [];
  return httpRequest.execute({
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

describe('http.request', () => {
  it('reports the status, both timings and the size', async () => {
    const execution = await run({ path: '/' });
    assert.equal(valueOf(execution, 'statusCode'), 200);
    assert.equal(valueOf(execution, 'size'), 5);
    assert.equal(valueOf(execution, 'redirects'), 0);
    assert.ok((valueOf(execution, 'responseTime') ?? -1) >= 0);
    assert.match(execution.message ?? '', /200 in [\d.]+ ms \([\d.]+ ms to first byte, 5 bytes\)/);
  });

  it('separates time to first byte from the total', async () => {
    // The whole reason there are two: a query that got slower moves the first, a page that got
    // bigger moves only the second, and one number cannot say which happened.
    const execution = await run({ path: '/slow-body' });
    const ttfb = valueOf(execution, 'timeToFirstByte') ?? 0;
    const total = valueOf(execution, 'responseTime') ?? 0;
    assert.ok(total >= 240, `total was ${String(total)} ms, expected the 250 ms body delay`);
    assert.ok(
      ttfb < total - 100,
      `first byte ${String(ttfb)} ms should precede total ${String(total)} ms`,
    );
  });

  it('counts a large body without holding it', async () => {
    // 4 MB. The assertion is the count; the point is that nothing accumulated it.
    const execution = await run({ path: '/big', timeoutMs: 20_000 });
    assert.equal(valueOf(execution, 'size'), 4_194_304);
  });

  it('follows a redirect chain and says how many hops', async () => {
    const execution = await run({ path: '/hop1' });
    assert.equal(valueOf(execution, 'statusCode'), 200);
    assert.equal(valueOf(execution, 'redirects'), 2);
    assert.deepEqual(seen, ['/hop1', '/hop2', '/']);
    assert.match(execution.message ?? '', /after 2 redirects/);
  });

  it('stops a redirect loop and says that is what it is', async () => {
    await assert.rejects(
      () => run({ path: '/loop' }),
      /redirected more than 5 times.*redirect loop/s,
    );
  });

  it('does not follow a redirect off this device', async () => {
    // Following it means the next reading is about elsewhere.example.com under a sensor named
    // for this device, with nothing on the graph saying the subject changed.
    const execution = await run({ path: '/offsite', expectStatus: '301' });
    assert.equal(valueOf(execution, 'statusCode'), 301);
    assert.equal(valueOf(execution, 'redirects'), 0);
    assert.deepEqual(seen, ['/offsite']);
    assert.match(execution.message ?? '', /off this device and was not followed/);
  });

  it('treats an unfollowed redirect as success when redirects are off', async () => {
    // "Check that this still redirects" is a real thing to watch, and calling the correct answer
    // a failure would make it inexpressible.
    const execution = await run({ path: '/hop1', followRedirects: false });
    assert.equal(valueOf(execution, 'statusCode'), 302);
    assert.deepEqual(seen, ['/hop1']);
  });

  it('fails on a status it was not expecting, naming both', async () => {
    await assert.rejects(() => run({ path: '/teapot' }), /answered 418/);
  });

  it('is Up on a status it was told to expect', async () => {
    // A sensor that is *supposed* to see a 404 or a 401 is real — a canary for a page that must
    // stay unpublished, or an endpoint that must stay authenticated.
    const execution = await run({ path: '/teapot', expectStatus: '418' });
    assert.equal(valueOf(execution, 'statusCode'), 418);
  });

  it('sends a POST body and its own user agent', async () => {
    const execution = await run({
      path: '/echo',
      method: 'POST',
      body: '{"ping":1}',
      contentType: 'application/json',
    });
    assert.equal(valueOf(execution, 'statusCode'), 200);
    // The server echoed what it received; the size proves the body and agent went out.
    assert.ok((valueOf(execution, 'size') ?? 0) > 30);
  });

  it('has no size channel for HEAD, which has no body to measure', () => {
    assert.deepEqual(
      httpRequest.channels({ method: 'HEAD' }).map((channel) => channel.key),
      ['responseTime', 'timeToFirstByte', 'statusCode', 'redirects'],
    );
    assert.ok(httpRequest.channels({}).some((channel) => channel.key === 'size'));
  });

  it('says nothing is listening rather than "request failed"', async () => {
    await assert.rejects(() => run({ port: 1, path: '/' }), /nothing is listening at/);
  });

  it('returns promptly when the check is aborted', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = run({ path: '/hang', timeoutMs: 30_000 }, { signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 50);
    await assert.rejects(() => pending, /cancelled/);
    assert.ok(Date.now() - started < 3_000);
  });
});

describe('deciding whether a status is the one being watched for', () => {
  it('accepts any 2xx when nothing was asked for', () => {
    assert.equal(statusAccepted(200, '', true), true);
    assert.equal(statusAccepted(204, '', true), true);
    assert.equal(statusAccepted(404, '', true), false);
    assert.equal(statusAccepted(500, '', true), false);
  });

  it('accepts a 3xx only when redirects are not being followed', () => {
    // Following one and still seeing a 3xx means the chain ended somewhere it would not go,
    // which is a fact to report rather than a pass.
    assert.equal(statusAccepted(301, '', false), true);
    assert.equal(statusAccepted(301, '', true), false);
  });

  it('takes an exact code, a class and a range', () => {
    assert.equal(statusAccepted(404, '404', true), true);
    assert.equal(statusAccepted(403, '404', true), false);
    assert.equal(statusAccepted(204, '2xx', true), true);
    assert.equal(statusAccepted(301, '2xx', true), false);
    assert.equal(statusAccepted(202, '200-204', true), true);
    assert.equal(statusAccepted(205, '200-204', true), false);
  });
});

describe('deciding whether a redirect stays on this device', () => {
  it('follows a path on the same host, port and scheme', () => {
    assert.equal(resolveRedirect('/next', 'example.com', 'https', 443), '/next');
    assert.equal(
      resolveRedirect('https://example.com/next?a=1', 'example.com', 'https', 443),
      '/next?a=1',
    );
  });

  it('refuses another host', () => {
    assert.equal(resolveRedirect('https://elsewhere.com/x', 'example.com', 'https', 443), null);
  });

  it('refuses a scheme or port change, which is a different listener', () => {
    assert.equal(resolveRedirect('http://example.com/x', 'example.com', 'https', 443), null);
    assert.equal(resolveRedirect('https://example.com:8443/x', 'example.com', 'https', 443), null);
  });

  it('treats a bare relative target as root-relative, which is what a browser does', () => {
    assert.equal(resolveRedirect('next', 'example.com', 'https', 443), '/next');
  });

  it('refuses an empty or absent location', () => {
    assert.equal(resolveRedirect(null, 'example.com', 'https', 443), null);
    assert.equal(resolveRedirect('   ', 'example.com', 'https', 443), null);
  });
});
