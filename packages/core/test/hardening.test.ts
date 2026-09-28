import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  registerCsrfGuard,
  registerRateLimit,
  registerSecurityHeaders,
} from '../src/api/hardening.js';
import { toHttpError } from '../src/api/errors.js';
import { silent } from './support/tree.js';

/**
 * Security headers, CSRF and rate limiting (`A-09`).
 *
 * Built on a bare Fastify rather than the whole `ApiServer`: these are three hooks with three
 * policy decisions in them, and standing up a database to test a response header would be
 * measuring the harness.
 */

const build = async (install: (app: FastifyInstance) => void): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => {
    const mapped = toHttpError(error, request.id);
    void reply.status(mapped.status).send(mapped.body);
  });
  install(app);
  app.get('/api/v1/thing', () => ({ ok: true }));
  app.post('/api/v1/thing', () => ({ ok: true }));
  await app.ready();
  return app;
};

describe('security headers', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await build((instance) => {
      registerSecurityHeaders(instance);
    });
  });

  after(async () => {
    await app.close();
  });

  it('leaves a stricter policy alone when a route has already set one', async () => {
    // **Every header here is a floor, not a ceiling.** `G-05` serves an operator's uploaded image
    // under `default-src 'none'`, and a hook that overwrote it would quietly widen the one
    // response on the system whose bytes did not come from us.
    const strict = await build((instance) => {
      registerSecurityHeaders(instance);
      instance.get('/api/v1/image', (_request, reply) => {
        void reply.header('content-security-policy', "default-src 'none'").send('bytes');
      });
    });
    try {
      const response = await strict.inject({ method: 'GET', url: '/api/v1/image' });
      assert.equal(response.headers['content-security-policy'], "default-src 'none'");
      // And the ones it did not set still arrive.
      assert.equal(response.headers['x-frame-options'], 'DENY');
    } finally {
      await strict.close();
    }
  });

  it('sets a content security policy that makes an injected script inert', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/thing' });
    const csp = response.headers['content-security-policy'];
    assert.ok(typeof csp === 'string');
    assert.match(csp, /default-src 'self'/);
    assert.equal(/unsafe-inline/.test(csp), false, 'unsafe-inline would defeat the whole policy');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
  });

  it('turns off content sniffing, because a sniffed JSON response is an XSS', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/thing' });
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  });

  it('refuses to be framed, for browsers that predate frame-ancestors', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/thing' });
    assert.equal(response.headers['x-frame-options'], 'DENY');
  });

  it('sends no referrer, because a monitoring URL carries object ids', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/thing' });
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
  });

  it('does not send HSTS over plain HTTP', async () => {
    // A year-long HSTS issued over HTTP would make an installation reachable on both schemes
    // unreachable on one of them, for a year.
    const response = await app.inject({ method: 'GET', url: '/api/v1/thing' });
    assert.equal(response.headers['strict-transport-security'], undefined);
  });

  it('sets them on an error response too', async () => {
    // The response that renders an attacker's input is as likely to be a 404 as a 200.
    const response = await app.inject({ method: 'GET', url: '/api/v1/nothing-here' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  });
});

describe('the CSRF guard', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await build((instance) => {
      registerCsrfGuard(instance, { logger: silent });
    });
  });

  after(async () => {
    await app.close();
  });

  it('lets a same-origin write through', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/thing',
      headers: { origin: 'http://example.test', host: 'example.test' },
    });
    assert.equal(response.statusCode, 200);
  });

  it('refuses a cross-origin write', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/thing',
      headers: { origin: 'http://evil.test', host: 'example.test' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json<{ error: { code: string } }>().error.code, 'AUTH_FORBIDDEN');
  });

  it('leaves reads alone, whatever their origin', async () => {
    // A GET has no side effects to forge, and refusing cross-origin reads would break every
    // embedded dashboard for nothing.
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/thing',
      headers: { origin: 'http://evil.test', host: 'example.test' },
    });
    assert.equal(response.statusCode, 200);
  });

  it('exempts a request authenticated by a bearer token', async () => {
    // A token carries no ambient authority: there is nothing for a third-party page to ride on,
    // and demanding an Origin from `curl` would break every integration for no gain.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/thing',
      headers: {
        origin: 'http://evil.test',
        host: 'example.test',
        authorization: 'Bearer mst_something',
      },
    });
    assert.equal(response.statusCode, 200);
  });

  it('allows a write with no Origin at all', async () => {
    // Every non-browser client. Refusing this would break `curl` against a cookie session, which
    // is how an operator debugs this system.
    const response = await app.inject({ method: 'POST', url: '/api/v1/thing' });
    assert.equal(response.statusCode, 200);
  });

  it('refuses an Origin that is not a URL rather than ignoring it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/thing',
      headers: { origin: 'not a url', host: 'example.test' },
    });
    assert.equal(response.statusCode, 403);
  });

  it('checks every method that changes something', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: '/api/v1/thing',
        headers: { origin: 'http://evil.test', host: 'example.test' },
      });
      assert.equal(response.statusCode, 403, `${method} was not checked`);
    }
  });
});

/**
 * The allowlist (`A-19`).
 *
 * It exists because **a proxy that rewrites `Host` makes a same-site request look cross-origin**:
 * Vite's `changeOrigin` sends `Origin: http://127.0.0.1:5173` with `Host: 127.0.0.1:8080`, and so
 * does a reverse proxy in front of a production install. Before this key, every write from either
 * was refused — the guard reading the headers correctly and the deployment wrongly.
 */
describe('the CSRF guard with configured origins', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await build((instance) => {
      registerCsrfGuard(instance, {
        logger: silent,
        // The trailing slash and the path are deliberate: this is what gets pasted out of a
        // browser's address bar, and an allowlist that only matches a hand-trimmed origin is one
        // an operator gives up on.
        allowedOrigins: ['http://127.0.0.1:5173', 'https://ui.example.test/app'],
      });
    });
  });

  after(async () => {
    await app.close();
  });

  it('lets a configured origin write through a proxy that rewrote Host', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/thing',
      headers: { origin: 'http://127.0.0.1:5173', host: '127.0.0.1:8080' },
    });
    assert.equal(response.statusCode, 200);
  });

  it('matches on the origin a browser would send, not on the string configured', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/thing',
      headers: { origin: 'https://ui.example.test', host: 'core.example.test' },
    });
    assert.equal(response.statusCode, 200);
  });

  it('still refuses everything not on the list', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/thing',
      headers: { origin: 'http://evil.test', host: '127.0.0.1:8080' },
    });
    assert.equal(response.statusCode, 403);
  });

  it('distinguishes the scheme and the port', async () => {
    // `https://127.0.0.1:5173` and `http://127.0.0.1:5174` are different origins to a browser,
    // and a guard that compared hosts alone would accept both from a listener on the same box.
    for (const origin of ['https://127.0.0.1:5173', 'http://127.0.0.1:5174', 'http://127.0.0.1'])
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/thing',
            headers: { origin, host: '127.0.0.1:8080' },
          })
        ).statusCode,
        403,
        `${origin} was accepted`,
      );
  });

  it('leaves same-origin writes working, allowlist or no allowlist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/thing',
      headers: { origin: 'http://direct.test', host: 'direct.test' },
    });
    assert.equal(response.statusCode, 200);
  });
});

describe('an allowlist that could never match', () => {
  // Refused at startup rather than skipped, because an entry that is quietly ignored looks
  // exactly like a config file that was never read — and what the operator would then debug is
  // the guard.
  const registering = (allowedOrigins: string[]) => (): void => {
    registerCsrfGuard(Fastify(), { logger: silent, allowedOrigins });
  };

  it('names a value that is not a URL', () => {
    assert.throws(registering(['not a url']), /"not a url" is not a URL/);
  });

  it('names a host and port written without a scheme', () => {
    // The likeliest mistake, since this is how the address is written everywhere else in the
    // config file.
    assert.throws(registering(['127.0.0.1:5173']), /needs a scheme/);
  });

  it('names a scheme that never appears in an Origin', () => {
    // `file:` and `data:` have no origin — a browser sends the literal `null` — and no other
    // scheme reaches an HTTP API. Each of these parses, so a check for "is it a URL" alone would
    // leave an entry that looks configured and matches nothing.
    assert.throws(registering(['file:///opt/ms/web']), /a browser only sends an http/);
    assert.throws(registering(['ftp://ui.example.com']), /is ftp:/);
  });

  it('accepts the shapes an operator actually writes', () => {
    assert.doesNotThrow(
      registering(['http://127.0.0.1:5173', 'https://ms.example.com/', 'https://ms.example.com']),
    );
  });
});

describe('rate limiting', () => {
  let app: FastifyInstance;
  let clock = 0;

  beforeEach(async () => {
    clock = 1_000_000;
    app = await build((instance) => {
      registerRateLimit(instance, {
        logger: silent,
        max: 3,
        windowMs: 60_000,
        now: () => clock,
      });
    });
  });

  const get = () => app.inject({ method: 'GET', url: '/api/v1/thing' });

  it('allows requests up to the limit', async () => {
    for (let n = 0; n < 3; n += 1) assert.equal((await get()).statusCode, 200);
  });

  it('refuses the one past it, and says when to come back', async () => {
    for (let n = 0; n < 3; n += 1) await get();
    const response = await get();
    assert.equal(response.statusCode, 429);
    assert.equal(response.json<{ error: { code: string } }>().error.code, 'AUTH_THROTTLED');
    assert.ok(response.headers['retry-after'] !== undefined);
  });

  it('reports what is left on every response, not only the refusal', async () => {
    // A client that can see the budget can slow itself down; one that only learns at the wall
    // has to fail first.
    const first = await get();
    assert.equal(first.headers['x-ratelimit-limit'], '3');
    assert.equal(first.headers['x-ratelimit-remaining'], '2');
  });

  it('starts a fresh window once the old one has passed', async () => {
    for (let n = 0; n < 4; n += 1) await get();
    assert.equal((await get()).statusCode, 429);

    clock += 61_000;
    assert.equal((await get()).statusCode, 200, 'a new window');
  });

  it('closes its sweep when the server does', async () => {
    // An interval left running keeps the process alive, which turns a graceful shutdown into a
    // timeout somebody has to investigate.
    await app.close();
    // Nothing to assert beyond this returning: an un-cleared interval would hold the loop open
    // and the test runner would report a hang rather than a failure.
    assert.ok(true);
  });
});
