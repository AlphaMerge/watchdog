import { strict as assert } from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { pino } from 'pino';
import type { Logger } from '@ms/shared';
import {
  HostAllowList,
  proxyTrust,
  registerCsrfGuard,
  registerForwardedHeaderNotice,
  registerHostCheck,
  registerRateLimit,
  registerSecurityHeaders,
  registerUpgradeOriginCheck,
} from '../src/api/hardening.js';
import { toHttpError } from '../src/api/errors.js';
import { API_VALIDATOR_OPTIONS } from '../src/api/server.js';
import { silent } from './support/tree.js';
import { pollWithin } from './support/within.js';

/**
 * Security headers, CSRF and rate limiting (`A-09`).
 *
 * Built on a bare Fastify rather than the whole `ApiServer`: these are three hooks with three
 * policy decisions in them, and standing up a database to test a response header would be
 * measuring the harness.
 */

const build = async (
  install: (app: FastifyInstance) => void,
  options: FastifyServerOptions = {},
): Promise<FastifyInstance> => {
  // Validated as the server validates (`P-364`), not with Ajv's defaults; a test's own options
  // still win.
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { ...API_VALIDATOR_OPTIONS } },
    ...options,
  });
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

  it('exempts a request an API token authenticated', async () => {
    // A token carries no ambient authority: there is nothing for a third-party page to ride on,
    // and demanding an Origin from `curl` would break every integration for no gain. The
    // authentication hook stands in here: it runs first, and sets the principal the guard reads.
    const tokened = await build((instance) => {
      instance.addHook('onRequest', (request, _reply, done) => {
        request.principal = {
          userId: 7,
          login: 'script',
          role: 'readwrite',
          mustChangePassword: false,
          mayAcknowledge: true,
          sessionId: '',
          tokenId: 3,
          scope: 'write',
        };
        done();
      });
      registerCsrfGuard(instance, { logger: silent });
    });
    try {
      const response = await tokened.inject({
        method: 'POST',
        url: '/api/v1/thing',
        headers: {
          origin: 'http://evil.test',
          host: 'example.test',
          authorization: 'Bearer mst_something',
        },
      });
      assert.equal(response.statusCode, 200);
    } finally {
      await tokened.close();
    }
  });

  it('does not exempt an Authorization header that authenticated nothing (A-36)', async () => {
    // A proxy that authenticates with HTTP Basic or Negotiate forwards the browser's own header,
    // and a browser attaches that to a cross-site form on its own — as ambient as a cookie. A
    // bearer token that did not resolve is no better: whatever let the request in, it was not a
    // token.
    for (const authorization of ['Basic b3BzOmh1bnRlcjI=', 'Negotiate YIIGhgYGKwYB', 'Bearer x']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/thing',
        headers: { origin: 'http://evil.test', host: 'example.test', authorization },
      });
      assert.equal(response.statusCode, 403, `${authorization.split(' ')[0] ?? ''} was exempted`);
    }
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

/**
 * The stream's handshake from another origin (`A-36`).
 *
 * A WebSocket handshake is a GET, which the guard above passes, and it is the one GET whose answer
 * another origin can read. These drive the hook with the headers a handshake carries; the real
 * upgrade, against the real stream, is `stream-origin.test.ts`.
 */
describe('the handshake origin check', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await build((instance) => {
      registerUpgradeOriginCheck(instance, {
        logger: silent,
        allowedOrigins: ['http://127.0.0.1:5173'],
      });
    });
  });

  after(async () => {
    await app.close();
  });

  const handshake = (headers: Record<string, string>) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/thing',
      headers: { upgrade: 'websocket', connection: 'Upgrade', ...headers },
    });

  it('refuses one from another origin', async () => {
    // Another port on the same host is another origin, and the same site: the cookie goes with it.
    const response = await handshake({ origin: 'http://10.0.0.5:3000', host: '10.0.0.5:8080' });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json<{ error: { code: string } }>().error.code, 'AUTH_FORBIDDEN');
  });

  it('refuses one whose Origin is not a URL, which is what a sandboxed page sends', async () => {
    assert.equal((await handshake({ origin: 'null', host: '10.0.0.5:8080' })).statusCode, 403);
  });

  it('lets through its own origin, a configured one, and a client that sends none', async () => {
    for (const headers of [
      { origin: 'http://10.0.0.5:8080', host: '10.0.0.5:8080' },
      // Vite's proxy: the browser's origin, and the Host it rewrote.
      { origin: 'http://127.0.0.1:5173', host: '127.0.0.1:8080' },
      { host: '10.0.0.5:8080' },
    ])
      assert.equal((await handshake(headers)).statusCode, 200, JSON.stringify(headers));
  });

  it('leaves an ordinary read alone, whatever its origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/thing',
      headers: { origin: 'http://evil.test', host: 'example.test' },
    });
    assert.equal(response.statusCode, 200);
  });
});

describe('which proxies are believed (A-36)', () => {
  it('trusts nobody when none is listed', () => {
    assert.equal(proxyTrust([]), false);
  });

  it('accepts an address, a range and loopback', () => {
    const entries = ['127.0.0.1', '10.0.4.7', '10.0.4.0/28', '::1', 'fd00:1:2::/48', 'loopback'];
    assert.deepEqual(proxyTrust(entries), entries);
  });

  it('refuses a range as wide as where the browsers are, as loading the file does (A-47)', () => {
    assert.throws(() => proxyTrust(['0.0.0.0/0']), /"0\.0\.0\.0\/0" is wider than \/16/);
    assert.throws(() => proxyTrust(['::/0']), /"::\/0" is wider than \/48/);
    assert.throws(() => proxyTrust(['10.0.0.0/8']), /"10\.0\.0\.0\/8" is wider than \/16/);
  });

  it('names the setting and the entry it cannot use', () => {
    for (const entry of ['ms-proxy', '10.0.4.0/33', '10.0.4.7/', '::1/129', '10.0.4.0/28/1'])
      assert.throws(
        () => proxyTrust([entry]),
        new RegExp(`api\\.trustedProxies: "${entry.replace(/[./:]/g, '\\$&')}" is not`),
        entry,
      );
  });

  it('refuses the names that mean every private address, since the browsers are there too', () => {
    // A browser inside a trusted range writes its own X-Forwarded-For and is counted as whoever it
    // names — the throttle's address is then the attacker's choice.
    assert.throws(() => proxyTrust(['uniquelocal']), /names every private address/);
    assert.throws(() => proxyTrust(['linklocal']), /names every link-local address/);
  });

  it('is what the server believes: the browser behind a listed proxy, and nobody else', async () => {
    const app = await build(
      (instance) => {
        instance.get('/whoami', (request) => ({ ip: request.ip, protocol: request.protocol }));
      },
      { trustProxy: proxyTrust(['127.0.0.1']) },
    );
    try {
      const forwarded = {
        'x-forwarded-for': '198.51.100.1, 203.0.113.5',
        'x-forwarded-proto': 'https',
      };
      const through = await app.inject({
        url: '/whoami',
        remoteAddress: '127.0.0.1',
        headers: forwarded,
      });
      // The proxy appended the browser's address; what came before it, the browser wrote itself.
      assert.deepEqual(through.json(), { ip: '203.0.113.5', protocol: 'https' });
      const direct = await app.inject({
        url: '/whoami',
        remoteAddress: '198.51.100.9',
        headers: forwarded,
      });
      assert.deepEqual(direct.json(), { ip: '198.51.100.9', protocol: 'http' });
    } finally {
      await app.close();
    }
  });
});

describe('a proxy that is not believed (A-36)', () => {
  const capture = (): { logger: Logger; warnings: () => string[] } => {
    const lines: { level: number; msg: string }[] = [];
    const logger = pino(
      { level: 'warn' },
      { write: (line: string) => lines.push(JSON.parse(line) as { level: number; msg: string }) },
    ) as unknown as Logger;
    return { logger, warnings: () => lines.filter((l) => l.level === 40).map((l) => l.msg) };
  };

  it('is said once, naming the peer, when a request carries X-Forwarded-For it ignored', async () => {
    const { logger, warnings } = capture();
    const app = await build((instance) => {
      registerForwardedHeaderNotice(instance, { logger, trustedProxies: [] });
    });
    try {
      await app.inject({ url: '/api/v1/thing' });
      assert.deepEqual(warnings(), [], 'nothing forwarded, nothing to say');
      for (let n = 0; n < 3; n += 1)
        await app.inject({ url: '/api/v1/thing', headers: { 'x-forwarded-for': '203.0.113.5' } });
      assert.equal(warnings().length, 1);
      assert.match(warnings()[0] ?? '', /api\.trustedProxies is empty/);
    } finally {
      await app.close();
    }
  });

  it('says nothing once a proxy is listed, even for a request from the proxy’s own host', async () => {
    // `curl` on the proxy's host, forwarded as `127.0.0.1`: its address stays the peer's, and a
    // warning about an unlisted proxy would be wrong.
    const { logger, warnings } = capture();
    const app = await build(
      (instance) => {
        registerForwardedHeaderNotice(instance, { logger, trustedProxies: ['loopback'] });
      },
      { trustProxy: proxyTrust(['loopback']) },
    );
    try {
      await app.inject({ url: '/api/v1/thing', headers: { 'x-forwarded-for': '127.0.0.1' } });
      await app.inject({ url: '/api/v1/thing', headers: { 'x-forwarded-for': '203.0.113.5' } });
      assert.deepEqual(warnings(), []);
    } finally {
      await app.close();
    }
  });
});

describe('the names this core answers to (A-47)', () => {
  const capture = (): { logger: Logger; warnings: () => string[] } => {
    const lines: string[] = [];
    const logger = pino(
      { level: 'warn' },
      {
        write: (line: string) => {
          lines.push(line);
        },
      },
    ) as unknown as Logger;
    return {
      logger,
      warnings: () => lines.map((line) => (JSON.parse(line) as { host?: string }).host ?? ''),
    };
  };

  const withCheck = async (
    hosts: HostAllowList,
    logger: Logger = silent,
  ): Promise<FastifyInstance> =>
    build((instance) => {
      registerHostCheck(instance, { hosts, logger });
      registerSecurityHeaders(instance);
    });

  it('answers every address, localhost, and a request that names no host at all', () => {
    const hosts = new HostAllowList({});
    for (const header of [
      '127.0.0.1:8080',
      '10.9.9.9',
      '[::1]:8080',
      '[2001:db8::1]',
      'localhost:8080',
      'LOCALHOST',
      'localhost.',
      'ui.localhost:5173',
      '',
      undefined,
    ]) {
      assert.equal(hosts.allows(header), true, String(header));
    }
  });

  it('refuses any other name, including one built to look like an address', () => {
    const hosts = new HostAllowList({});
    for (const header of [
      'evil.example:8080',
      'evil.example',
      '127.0.0.1.evil.example',
      '127.0.0.1.nip.io:8080',
      'localhost.evil.example',
      'evillocalhost',
      '[::1].evil.example',
    ]) {
      assert.equal(hosts.allows(header), false, header);
    }
  });

  it('answers the names it is given, from each of the three places, whatever the case or port', () => {
    const hosts = new HostAllowList({
      allowedHosts: ['Monitoring.Example.com.', 'ms01'],
      allowedOrigins: ['https://ui.example.com:8443'],
      publicUrl: 'https://alerts.example.com/ms/',
    });
    for (const header of [
      'monitoring.example.com',
      'MONITORING.EXAMPLE.COM.:8080',
      'ms01:8080',
      'ui.example.com',
      'ui.example.com:9999',
      'alerts.example.com:443',
    ]) {
      assert.equal(hosts.allows(header), true, header);
    }
    for (const header of ['example.com', 'sub.monitoring.example.com', 'ms02', 'ms01.evil']) {
      assert.equal(hosts.allows(header), false, header);
    }
  });

  it('takes nothing from a URL that is empty or does not parse', () => {
    const hosts = new HostAllowList({ allowedOrigins: ['not a url'], publicUrl: '' });
    assert.equal(hosts.allows('not a url'), false);
    assert.equal(hosts.allows('evil.example'), false);
  });

  it('refuses a rebound page with 421, before anything else runs, naming the setting', async () => {
    const app = await withCheck(new HostAllowList({}));
    try {
      for (const method of ['GET', 'POST'] as const) {
        const response = await app.inject({
          method,
          url: '/api/v1/thing',
          headers: { host: 'evil.example:8080', origin: 'http://evil.example:8080' },
        });
        assert.equal(response.statusCode, 421, method);
        const body = response.json<{
          error: { code: string; message: string; context: Record<string, string> };
        }>();
        assert.equal(body.error.code, 'HOST_NOT_ALLOWED');
        assert.match(body.error.message, /"evil\.example".*api\.allowedHosts/);
        assert.deepEqual(body.error.context, {
          host: 'evil.example:8080',
          setting: 'api.allowedHosts',
        });
        // The refusal is an answer like any other, and carries the headers every answer does.
        assert.ok(response.headers['content-security-policy'] !== undefined);
      }
    } finally {
      await app.close();
    }
  });

  it('lets an address and a listed name through to the route', async () => {
    const app = await withCheck(new HostAllowList({ allowedHosts: ['ms.example.com'] }));
    try {
      for (const host of ['127.0.0.1:8080', 'ms.example.com:8080']) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/thing',
          headers: { host },
        });
        assert.equal(response.statusCode, 200, host);
      }
    } finally {
      await app.close();
    }
  });

  it('counts every refusal, and logs each name once', async () => {
    const hosts = new HostAllowList({});
    const { logger, warnings } = capture();
    const app = await withCheck(hosts, logger);
    try {
      for (const host of ['a.example', 'a.example:8080', 'A.EXAMPLE', 'b.example', '127.0.0.1']) {
        await app.inject({ url: '/api/v1/thing', headers: { host } });
      }
      assert.deepEqual(hosts.stats(), { refused: 4 });
      assert.deepEqual(warnings(), ['a.example', 'b.example']);
    } finally {
      await app.close();
    }
  });

  it('stops logging new names at a hundred, and goes on counting them', async () => {
    const hosts = new HostAllowList({});
    const { logger, warnings } = capture();
    const app = await withCheck(hosts, logger);
    try {
      for (let n = 0; n < 105; n += 1) {
        await app.inject({ url: '/api/v1/thing', headers: { host: `n${String(n)}.example` } });
      }
      assert.equal(warnings().length, 100);
      assert.deepEqual(hosts.stats(), { refused: 105 });
    } finally {
      await app.close();
    }
  });
});

describe('the CSRF guard, on a name the Host check let through (A-47)', () => {
  // The Host check makes the Host header one of this core's names; the guard still compares the
  // whole host and port, so another port on an answered name is another origin.
  let app: FastifyInstance;

  before(async () => {
    app = await build((instance) => {
      registerCsrfGuard(instance, { logger: silent });
    });
  });

  after(async () => {
    await app.close();
  });

  it('refuses a write from another port on localhost', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/thing',
      headers: { origin: 'http://localhost:3000', host: 'localhost:8080' },
    });
    assert.equal(response.statusCode, 403);
  });

  it('refuses a write from another port on the same address', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/thing',
      headers: { origin: 'http://10.9.9.9:3000', host: '10.9.9.9:8080' },
    });
    assert.equal(response.statusCode, 403);
  });
});

describe('rate limiting', () => {
  let app: FastifyInstance;
  let clock = 0;
  let limiter: ReturnType<typeof registerRateLimit> | undefined;

  beforeEach(async () => {
    clock = 1_000_000;
    app = await build((instance) => {
      limiter = registerRateLimit(instance, {
        logger: silent,
        max: 3,
        windowMs: 60_000,
        now: () => clock,
      });
    });
  });

  afterEach(async () => {
    await app.close();
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

  it('counts what it refuses, for Core Health, and nothing it lets through (A-39)', async () => {
    assert.ok(limiter !== undefined);
    for (let n = 0; n < 3; n += 1) await get();
    assert.deepEqual(limiter.stats(), { refused: 0 });
    await get();
    await get();
    assert.deepEqual(limiter.stats(), { refused: 2 });
  });

  it('lets a script that honours Retry-After finish a 5,000-create build at the default (A-39)', async () => {
    // The project's own named legitimate client. At 1,200 a minute it is refused at request 1,201;
    // one that waits as it is told finishes, in four waits of a minute, rather than stopping with
    // the tree half-built. The clock is injected, so the four minutes are the limiter's
    // arithmetic and not this test's running time.
    let at = 5_000_000;
    const defaulted = await build((instance) => {
      registerRateLimit(instance, { logger: silent, now: () => at });
    });
    try {
      let created = 0;
      let refused = 0;
      let waitedSeconds = 0;
      while (created < 5_000) {
        const response = await defaulted.inject({ method: 'POST', url: '/api/v1/thing' });
        if (response.statusCode === 429) {
          refused += 1;
          const retryAfter = Number(response.headers['retry-after']);
          assert.ok(retryAfter >= 1, 'a refusal says when to come back');
          waitedSeconds += retryAfter;
          at += retryAfter * 1_000;
          continue;
        }
        assert.equal(response.statusCode, 200);
        created += 1;
      }
      assert.equal(refused, 4, 'one wait for each full window');
      assert.equal(waitedSeconds, 240, 'four minutes, which administration.md says');
    } finally {
      await defaulted.close();
    }
  });

  it('reports what is left on every response, not only the refusal', async () => {
    // A client that can see the budget can slow itself down; one that only learns at the wall
    // has to fail first.
    const first = await get();
    assert.equal(first.headers['x-ratelimit-limit'], '3');
    assert.equal(first.headers['x-ratelimit-remaining'], '2');
  });

  it('counts an IPv6 client as its /64, so rotating through it is one client (A-47)', async () => {
    for (let n = 0; n < 3; n += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/thing',
        remoteAddress: `2001:db8:1:2::${String(n + 1)}`,
      });
      assert.equal(response.statusCode, 200);
    }
    const rotated = await app.inject({
      method: 'GET',
      url: '/api/v1/thing',
      remoteAddress: '2001:db8:1:2:ffff::9',
    });
    assert.equal(rotated.statusCode, 429);
    const neighbour = await app.inject({
      method: 'GET',
      url: '/api/v1/thing',
      remoteAddress: '2001:db8:1:3::1',
    });
    assert.equal(neighbour.statusCode, 200, 'the next /64 is somebody else');
  });

  it('says when the window resets as a Unix time, from the time it has left', async () => {
    const wall = await build((instance) => {
      registerRateLimit(instance, {
        logger: silent,
        max: 3,
        windowMs: 60_000,
        now: () => 5_000,
        wallNow: () => 1_750_000_000_000,
      });
    });
    try {
      const response = await wall.inject({ method: 'GET', url: '/api/v1/thing' });
      assert.equal(response.headers['x-ratelimit-reset'], String(1_750_000_000 + 60));
    } finally {
      await wall.close();
    }
  });

  // `P-247`: on the wall clock, a backward step of an hour kept every window open for the hour,
  // and a client over the limit was refused all of it.
  it('opens a new window on time across a backward step of the wall clock', async () => {
    // The wall clock is replaced before the limiter exists, so a default that captured it would
    // hold this one, which then steps back and stands still.
    const realNow = Date.now;
    let wall = realNow();
    Date.now = (): number => wall;
    const stepped = await build((instance) => {
      registerRateLimit(instance, { logger: silent, max: 1, windowMs: 50 });
    });
    try {
      const once = (): Promise<{ statusCode: number }> =>
        stepped.inject({ method: 'GET', url: '/api/v1/thing' });
      assert.equal((await once()).statusCode, 200);
      assert.equal((await once()).statusCode, 429);
      wall -= 3_600_000;
      await sleep(80);
      assert.equal((await once()).statusCode, 200, 'the window is a duration, not a date');
    } finally {
      Date.now = realNow;
      await stepped.close();
    }
  });

  it('starts a fresh window once the old one has passed', async () => {
    for (let n = 0; n < 4; n += 1) await get();
    assert.equal((await get()).statusCode, 429);

    clock += 61_000;
    assert.equal((await get()).statusCode, 200, 'a new window');
  });

  it('stops sweeping when the server closes (A-36)', async () => {
    // The sweep reads the clock and nothing else does between requests, so a clock nobody else
    // is asking is the sweep running. A real, short window: the claim is about a real timer.
    // (This once only closed the server and asserted `true`: the timer is unref'd, so a sweep
    // left running held nothing open and could not fail it.)
    let asked = 0;
    const swept = await build((instance) => {
      registerRateLimit(instance, {
        logger: silent,
        windowMs: 5,
        now: () => {
          asked += 1;
          return Date.now();
        },
      });
    });
    await pollWithin(5_000, 'the sweep to run while the server is open', () => asked > 0, 5);

    await swept.close();
    asked = 0;
    await sleep(60);
    assert.equal(asked, 0, 'and not once it has closed');
  });

  it('holds nothing open, so a server nobody closed cannot keep the process up', async () => {
    const timers = (): number =>
      process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
    const before = timers();
    const unclosed = await build((instance) => {
      registerRateLimit(instance, { logger: silent });
    });
    try {
      assert.equal(timers(), before);
    } finally {
      await unclosed.close();
    }
  });
});
