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
