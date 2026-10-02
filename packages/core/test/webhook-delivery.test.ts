import { strict as assert } from 'node:assert';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { WebhookConfig } from '@ms/shared';
import {
  isLinkLocal,
  isPrivate,
  refusedAddresses,
  refuses,
  sameOrigin,
  schemeAllowed,
} from '@ms/shared';
import {
  SUBJECT_ENCODING,
  subjectHeaders,
  WebhookTransport,
} from '../src/notifications/delivery/webhook.js';
import type { OutgoingMessage } from '../src/notifications/delivery/transport.js';
import { render, substitute, type MessageContext } from '../src/notifications/placeholders.js';
import { messageContext } from './support/messages.js';
import { silent } from './support/tree.js';

function config(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return { targetPolicy: 'link-local', maxRedirects: 3, userAgent: 'ms-core-test', ...overrides };
}

function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    requestId: 1,
    sensorId: 2,
    subject: 'Ping on edge-router is down',
    body: '{"message":"no ICMP reply"}',
    recipients: [],
    about: [],
    priority: 3,
    settings: { url: 'http://127.0.0.1/hook', verb: 'POST', contentType: 'application/json' },
    context: messageContext(),
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------
// The address policy, which is the part worth being sure about.
// -------------------------------------------------------------------------------------------

describe('the SSRF target policy', () => {
  it('knows link-local in both address families', () => {
    // 169.254.169.254 is where every cloud provider parks the instance-metadata service that
    // hands out IAM credentials to anything that asks.
    assert.equal(isLinkLocal('169.254.169.254'), true);
    assert.equal(isLinkLocal('169.254.0.1'), true);
    assert.equal(isLinkLocal('fe80::1'), true);
    assert.equal(isLinkLocal('feb0::1'), true, 'fe80::/10 runs to febf');
    assert.equal(isLinkLocal('169.253.0.1'), false);
    assert.equal(isLinkLocal('8.8.8.8'), false);
    assert.equal(isLinkLocal('fec0::1'), false, 'outside the /10');
  });

  it('knows the private ranges', () => {
    for (const address of [
      '10.0.0.1',
      '127.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fc00::1',
    ]) {
      assert.equal(isPrivate(address), true, address);
    }
    for (const address of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2001:db8::1']) {
      assert.equal(isPrivate(address), false, address);
    }
  });

  it('judges an IPv4-mapped address as the IPv4 address it is', () => {
    // The classic bypass: `::ffff:127.0.0.1` is loopback wearing a hat.
    assert.equal(isPrivate('::ffff:127.0.0.1'), true);
    assert.equal(isPrivate('::ffff:8.8.8.8'), false);
  });

  it('blocks link-local under the default policy and nothing else private', () => {
    // The default is not "block everything private", deliberately: a monitoring system posts to
    // things inside its own network all day, and a guard that refused them would be switched off
    // within the hour — which is worse than a narrower guard nobody disables.
    assert.ok(refuses('link-local', '169.254.169.254') !== null);
    assert.equal(refuses('link-local', '10.0.0.1'), null);
    assert.equal(refuses('link-local', '127.0.0.1'), null);
    assert.equal(refuses('link-local', '8.8.8.8'), null);
  });

  it('blocks every private range under the stricter policy', () => {
    assert.ok(refuses('private', '10.0.0.1') !== null);
    assert.ok(refuses('private', '127.0.0.1') !== null);
    assert.ok(refuses('private', '169.254.169.254') !== null);
    assert.equal(refuses('private', '8.8.8.8'), null);
  });

  it('blocks multicast even when nothing else is blocked', () => {
    // Not a webhook endpoint under any reading, so a POST to one is a mistake rather than a
    // configuration — which is why `none` does not mean none.
    assert.ok(refuses('none', '239.0.0.1') !== null);
    assert.ok(refuses('none', 'ff02::1') !== null);
    assert.equal(refuses('none', '169.254.169.254'), null, 'but the policy is otherwise obeyed');
  });

  it('judges every address a name resolved to, not the first', () => {
    // A name resolving to one public address and one link-local one reaches the link-local one
    // as soon as the resolver reorders them.
    const refused = refusedAddresses('link-local', ['93.184.216.34', '169.254.169.254']);
    assert.equal(refused.length, 1);
    assert.equal(refused[0]?.address, '169.254.169.254');
  });

  it('allows only http and https', () => {
    assert.equal(schemeAllowed(new URL('https://example.test/x')), true);
    assert.equal(schemeAllowed(new URL('http://example.test/x')), true);
    for (const url of ['file:///etc/passwd', 'gopher://x/1', 'ftp://x/y']) {
      assert.equal(schemeAllowed(new URL(url)), false, url);
    }
  });

  it('treats a change of scheme, host or port as a change of origin', () => {
    const from = new URL('https://a.test/x');
    assert.equal(sameOrigin(from, new URL('https://a.test/y')), true);
    assert.equal(sameOrigin(from, new URL('http://a.test/y')), false);
    assert.equal(sameOrigin(from, new URL('https://b.test/y')), false);
    assert.equal(sameOrigin(from, new URL('https://a.test:8443/y')), false);
  });
});

// -------------------------------------------------------------------------------------------
// Escaping — the reason a webhook body needs substitution to know about syntax.
// -------------------------------------------------------------------------------------------

describe('body escaping', () => {
  const context: MessageContext = {
    sensorId: 42,
    sensorName: 'Ping',
    deviceName: 'edge "quoted" router',
    groupName: 'g',
    probeName: 'p',
    host: 'h',
    location: '',
    comments: '',
    tags: [],
    priority: 3,
    state: 'down',
    previousState: 'up',
    message: 'unexpected " in response\nsecond line',
    lastValue: null,
    at: new Date('2026-08-26T15:00:00Z'),
    since: new Date('2026-08-26T15:00:00Z'),
    publicUrl: '',
    siteName: 's',
  };

  it('keeps a JSON body valid when a value contains a quote', () => {
    // The failure this prevents is silent and intermittent: it happens only for the checks whose
    // messages contain a quote, which is to say the interesting ones.
    const body = substitute('{"message":"%lastmessage"}', context, 'json');
    assert.doesNotThrow(() => JSON.parse(body.text) as unknown);
    const parsed = JSON.parse(body.text) as { message: string };
    assert.equal(parsed.message, 'unexpected " in response\nsecond line', 'and round-trips');
  });

  it('escapes a newline rather than breaking the document', () => {
    const body = substitute('{"m":"%lastmessage"}', context, 'json');
    assert.ok(!body.text.includes('\n'), 'the literal newline is encoded');
    assert.ok(body.text.includes('\\n'));
  });

  it('percent-encodes for a form body', () => {
    const body = substitute('message=%lastmessage&device=%device', context, 'form');
    assert.ok(!body.text.includes(' '));
    const parsed = new URLSearchParams(body.text);
    assert.equal(parsed.get('message'), 'unexpected " in response\nsecond line');
    assert.equal(parsed.get('device'), 'edge "quoted" router');
  });

  it('leaves the operator’s own syntax alone', () => {
    // Only substituted *values* are escaped. The braces, colons and quotes the operator typed are
    // the document's structure, and escaping them would produce a JSON string of JSON.
    const body = substitute('{"a":"%sensor"}', context, 'json');
    assert.equal(body.text, '{"a":"Ping"}');
  });

  it('does not escape a literal per cent, which is the operator’s text too', () => {
    assert.equal(substitute('100%%', context, 'json').text, '100%');
  });

  it('changes nothing when nothing needs escaping', () => {
    assert.equal(substitute('%sensor is %status', context, 'none').text, 'Ping is down');
  });
});

// -------------------------------------------------------------------------------------------
// The transport, against a real HTTP server.
// -------------------------------------------------------------------------------------------

describe('the webhook transport', () => {
  let server: Server;
  let port: number;
  let seen: { method: string; url: string; headers: Record<string, unknown>; body: string }[];
  let respond: (request: IncomingMessage, response: ServerResponse) => void;

  before(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        seen.push({
          method: request.method ?? '',
          url: request.url ?? '',
          headers: { ...request.headers },
          body: Buffer.concat(chunks).toString('utf8'),
        });
        respond(request, response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    seen = [];
    respond = (_request, response) => {
      response.writeHead(204).end();
    };
  });

  /** Resolves every name to loopback, so the tests reach the server above. */
  const toLoopback = () => Promise.resolve(['127.0.0.1']);

  function transport(overrides: Partial<WebhookConfig> = {}): WebhookTransport {
    return new WebhookTransport({
      config: config(overrides),
      logger: silent,
      resolve: toLoopback,
    });
  }

  function url(path = '/hook'): string {
    return `http://webhook.test:${String(port)}${path}`;
  }

  it('posts the body and reports success', async () => {
    const result = await transport().send(
      message({ settings: { url: url(), verb: 'POST', contentType: 'application/json' } }),
    );
    assert.ok(result.ok, result.ok ? '' : result.error);
    assert.equal(seen.length, 1);
    assert.equal(seen.at(0)?.method, 'POST');
    assert.equal(seen.at(0)?.url, '/hook');
    assert.equal(seen.at(0)?.body, '{"message":"no ICMP reply"}');
    assert.equal(seen.at(0)?.headers['content-type'], 'application/json');
    assert.equal(seen.at(0)?.headers['user-agent'], 'ms-core-test');
    // So an endpoint can route without parsing the body.
    assert.equal(seen.at(0)?.headers['x-ms-subject'], 'Ping on edge-router is down');
  });

  describe('a subject outside printable ASCII (N-18)', () => {
    // Node refuses a header value above U+00FF before the request is sent, and every retry
    // rendered the same subject, so any of these lost the alarm for good.
    const SUBJECTS: readonly (readonly [string, string])[] = [
      ['Cyrillic', 'Ping on Київ-edge is down'],
      ['CJK', 'Ping on 東京-core is down'],
      ['an emoji', 'Ping 🔥 on edge-router is down'],
      ['an em dash', 'DNS on ns1 is down: that zone does not exist — check the spelling'],
      ['U+00FF itself', 'Ping on edge-routerÿ is down'],
      ['a tab', 'Ping on edge-router\tis down'],
    ];

    for (const [what, subject] of SUBJECTS) {
      it(`delivers ${what}, and the endpoint decodes it back`, async () => {
        const result = await transport().send(
          message({
            subject,
            settings: { url: url(), verb: 'POST', contentType: 'application/json' },
          }),
        );
        assert.ok(result.ok, result.ok ? '' : result.error);
        const headers = seen.at(0)?.headers ?? {};
        assert.equal(headers['x-ms-subject-encoding'], SUBJECT_ENCODING);
        assert.equal(decodeURIComponent(String(headers['x-ms-subject'])), subject);
      });
    }

    it('delivers what a template renders, with the — of a placeholder that has nothing', async () => {
      // The review's case: a Cyrillic device and a sensor with no previous state.
      const rendered = render(
        { subject: '%sensor on %device: %laststatus', body: '{}' },
        messageContext({ deviceName: 'Київ-edge', previousState: null }),
      );
      assert.match(rendered.subject, /—/u, 'the control: the placeholder rendered its dash');
      const result = await transport().send(
        message({
          subject: rendered.subject,
          settings: { url: url(), verb: 'POST', contentType: 'application/json' },
        }),
      );
      assert.ok(result.ok, result.ok ? '' : result.error);
      assert.equal(
        decodeURIComponent(String(seen.at(0)?.headers['x-ms-subject'])),
        rendered.subject,
      );
    });

    it('sends a printable-ASCII subject as it always has, with no encoding header', () => {
      assert.deepEqual(subjectHeaders('Ping on edge-router is down: 100% loss'), {
        'x-ms-subject': 'Ping on edge-router is down: 100% loss',
      });
    });

    it('sends half a surrogate pair as U+FFFD rather than throwing', () => {
      // A subject cut at a length limit can end inside an emoji.
      const cut = 'Ping 🔥'.slice(0, -1);
      const headers = subjectHeaders(cut);
      assert.equal(decodeURIComponent(headers['x-ms-subject'] ?? ''), 'Ping \uFFFD');
    });

    it('still folds a line break before encoding, so nothing can end the header', () => {
      const headers = subjectHeaders('Ping on Київ\r\nBcc: someone@else');
      assert.equal(
        decodeURIComponent(headers['x-ms-subject'] ?? ''),
        'Ping on Київ Bcc: someone@else',
      );
      assert.doesNotMatch(headers['x-ms-subject'] ?? '', /[\r\n]/u);
    });
  });

  it('gives up at once on a stored secret header Node will not send, naming it (N-19)', async () => {
    // A row saved before the check: every attempt failed the same way and was retried.
    for (const [header, secretHeaders] of [
      ['x-token', { 'x-token': 'Bearer Київ-s3cret' }],
      ['Bad Name', { 'Bad Name': 's3cret' }],
    ] as const) {
      const result = await transport().send(
        message({
          settings: { url: url(), verb: 'POST', contentType: 'application/json', secretHeaders },
        }),
      );
      assert.ok(!result.ok);
      assert.equal(result.retryable, false, 'no retry sends it');
      assert.match(result.error, /a header this template sets cannot be sent/u);
      assert.ok(result.error.includes(header), 'the header is named');
      assert.doesNotMatch(result.error, /s3cret|Київ/u);
    }
    assert.equal(seen.length, 0, 'nothing reached the endpoint');
  });

  it('sends the secret headers it was configured with', async () => {
    await transport().send(
      message({
        settings: {
          url: url(),
          verb: 'POST',
          contentType: 'application/json',
          secretHeaders: { authorization: 'Bearer abc123' },
        },
      }),
    );
    assert.equal(seen.at(0)?.headers['authorization'], 'Bearer abc123');
  });

  it('sends no body on a GET', async () => {
    await transport().send(
      message({ settings: { url: url(), verb: 'GET', contentType: 'application/json' } }),
    );
    assert.equal(seen.at(0)?.method, 'GET');
    assert.equal(seen.at(0)?.body, '');
  });

  it('declares JSON escaping unless the content type says otherwise', () => {
    const t = transport();
    assert.equal(t.bodyEscaping({ contentType: 'application/json' }), 'json');
    assert.equal(t.bodyEscaping({}), 'json', 'the default content type is JSON');
    assert.equal(t.bodyEscaping({ contentType: 'text/plain' }), 'none');
    assert.equal(t.bodyEscaping({ contentType: 'application/x-www-form-urlencoded' }), 'form');
  });

  // ── status codes ───────────────────────────────────────────────────────────────────────

  it('reads a status code the way HTTP already means it', async () => {
    for (const [status, ok, retryable] of [
      [200, true, false],
      [204, true, false],
      [400, false, false],
      [404, false, false],
      [408, false, true],
      [429, false, true],
      [500, false, true],
      [503, false, true],
    ] as const) {
      respond = (_request, response) => {
        response.writeHead(status).end('detail');
      };
      const result = await transport().send(message({ settings: { url: url() } }));
      assert.equal(result.ok, ok, String(status));
      if (!result.ok) assert.equal(result.retryable, retryable, String(status));
    }
  });

  it('includes what the endpoint said, so a 400 can be diagnosed', async () => {
    respond = (_request, response) => {
      response.writeHead(400).end('missing field "channel"');
    };
    const result = await transport().send(message({ settings: { url: url() } }));
    assert.ok(!result.ok);
    assert.ok(result.error.includes('missing field'), result.error);
  });

  // ── the guard ──────────────────────────────────────────────────────────────────────────

  it('refuses a scheme that is not http', async () => {
    const result = await transport().send(message({ settings: { url: 'file:///etc/passwd' } }));
    assert.ok(!result.ok);
    assert.equal(result.retryable, false);
    assert.ok(result.error.includes('not http'), result.error);
  });

  it('refuses something that is not a URL at all', async () => {
    const result = await transport().send(message({ settings: { url: 'not a url' } }));
    assert.ok(!result.ok);
    assert.equal(result.retryable, false);
  });

  // `P-247`: the deadline is a duration. On the wall clock, a forward step while the name was
  // being resolved timed out a delivery that had not started.
  it('keeps its deadline across a forward step of the wall clock', async () => {
    const realNow = Date.now;
    const stepping = new WebhookTransport({
      config: config(),
      logger: silent,
      resolve: () => {
        const ahead = realNow() + 3_600_000;
        Date.now = (): number => ahead;
        return toLoopback();
      },
    });
    try {
      const result = await stepping.send(message({ settings: { url: url() } }));
      assert.ok(result.ok, result.ok ? '' : result.error);
      assert.equal(seen.length, 1);
    } finally {
      Date.now = realNow;
    }
  });

  it('refuses a name that resolves to cloud metadata', async () => {
    // The attack the default policy exists for: a name whose DNS answer points at
    // 169.254.169.254, which hands out IAM credentials to anything that asks.
    const guarded = new WebhookTransport({
      config: config(),
      logger: silent,
      resolve: () => Promise.resolve(['169.254.169.254']),
    });
    const result = await guarded.send(message({ settings: { url: url() } }));
    assert.ok(!result.ok);
    assert.equal(result.retryable, false, 'the address will not become acceptable');
    assert.ok(result.error.includes('metadata'), result.error);
    assert.equal(seen.length, 0, 'and nothing was sent');
  });

  it('refuses a name that resolves to a metadata address in any spelling', async () => {
    // `A-54`: inside an IPv4-mapped IPv6 address it is the same destination, and one metadata
    // address is not link-local at all. Alone, and beside an address that is allowed.
    for (const address of [
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      'fd00:ec2::254',
      'fd00:0ec2:0:0:0:0:0:254',
    ]) {
      for (const answers of [[address], ['127.0.0.1', address]]) {
        const guarded = new WebhookTransport({
          config: config(),
          logger: silent,
          resolve: () => Promise.resolve(answers),
        });
        const result = await guarded.send(message({ settings: { url: url() } }));
        assert.ok(!result.ok, address);
        assert.equal(result.retryable, false, address);
        assert.ok(result.error.includes('refused by the target policy'), result.error);
        assert.ok(result.error.includes('metadata'), result.error);
      }
    }
    assert.equal(seen.length, 0, 'and nothing was sent');
  });

  it('sends nothing to a URL that gives such an address itself', async () => {
    // With the system's own resolver, which is what runs. `URL.hostname` keeps the brackets and
    // the resolver does not take them for an address, so such a URL fails before the policy is
    // asked — closed, and for the wrong reason (`A-58`). What is pinned here is that nothing is
    // sent; the policy's own reading of these addresses is the test above.
    const literal = new WebhookTransport({ config: config(), logger: silent });
    for (const host of ['[::ffff:169.254.169.254]', '[::ffff:a9fe:a9fe]', '[fd00:ec2::254]']) {
      const result = await literal.send(
        message({ settings: { url: `http://${host}:${String(port)}/hook` } }),
      );
      assert.ok(!result.ok, host);
    }
    assert.equal(seen.length, 0);
  });

  it('refuses a name where any one of its addresses is blocked', async () => {
    const guarded = new WebhookTransport({
      config: config(),
      logger: silent,
      resolve: () => Promise.resolve(['127.0.0.1', '169.254.169.254']),
    });
    const result = await guarded.send(message({ settings: { url: url() } }));
    assert.ok(!result.ok);
    assert.equal(seen.length, 0);
  });

  it('refuses a private address under the stricter policy', async () => {
    const result = await transport({ targetPolicy: 'private' }).send(
      message({ settings: { url: url() } }),
    );
    assert.ok(!result.ok);
    assert.ok(result.error.includes('private'), result.error);
  });

  it('reaches a private address under the default policy', async () => {
    // The common case for a monitoring system, and the reason the default is what it is.
    const result = await transport().send(message({ settings: { url: url() } }));
    assert.ok(result.ok);
  });

  it('treats a name that will not resolve as worth retrying', async () => {
    const guarded = new WebhookTransport({
      config: config(),
      logger: silent,
      resolve: () => Promise.reject(new Error('ENOTFOUND')),
    });
    const result = await guarded.send(message({ settings: { url: url() } }));
    assert.ok(!result.ok);
    assert.equal(result.retryable, true, 'a name that does not resolve now may in a minute');
  });

  // ── redirects ──────────────────────────────────────────────────────────────────────────

  it('follows a redirect and turns it into a GET', async () => {
    // Reposting the body to wherever a redirect points is how one webhook becomes two
    // deliveries to two endpoints.
    respond = (request, response) => {
      if (request.url === '/hook') {
        response.writeHead(302, { location: '/moved' }).end();
        return;
      }
      response.writeHead(204).end();
    };
    const result = await transport().send(message({ settings: { url: url() } }));
    assert.ok(result.ok);
    assert.equal(seen.length, 2);
    assert.equal(seen.at(1)?.method, 'GET');
    assert.equal(seen.at(1)?.body, '');
  });

  it('does not forward the secret headers across a change of origin', async () => {
    // The distinction curl draws between --location and --location-trusted, and it defaults to
    // the safe one for the same reason: a bearer token that follows a redirect to somebody
    // else's host has been given to that host.
    respond = (request, response) => {
      if (request.url === '/hook') {
        response.writeHead(302, { location: `http://elsewhere.test:${String(port)}/taken` }).end();
        return;
      }
      response.writeHead(204).end();
    };
    const result = await transport().send(
      message({
        settings: { url: url(), secretHeaders: { authorization: 'Bearer abc123' } },
      }),
    );
    assert.ok(result.ok);
    assert.equal(seen.length, 2);
    assert.equal(
      seen.at(0)?.headers['authorization'],
      'Bearer abc123',
      'sent to the original host',
    );
    assert.equal(seen.at(1)?.headers['authorization'], undefined, 'and not to the new one');
  });

  it('keeps the secret headers on a same-origin redirect', async () => {
    respond = (request, response) => {
      if (request.url === '/hook') {
        response.writeHead(307, { location: '/hook2' }).end();
        return;
      }
      response.writeHead(204).end();
    };
    await transport().send(
      message({ settings: { url: url(), secretHeaders: { authorization: 'Bearer abc123' } } }),
    );
    assert.equal(seen.at(1)?.headers['authorization'], 'Bearer abc123');
  });

  it('checks the guard again at every hop', async () => {
    // A public endpoint redirecting inward is the redirect-based SSRF this exists to stop.
    let resolved = 0;
    const guarded = new WebhookTransport({
      config: config(),
      logger: silent,
      resolve: () => {
        resolved += 1;
        return Promise.resolve(resolved === 1 ? ['127.0.0.1'] : ['169.254.169.254']);
      },
    });
    respond = (request, response) => {
      if (request.url === '/hook') {
        response.writeHead(302, { location: `http://metadata.test:${String(port)}/x` }).end();
        return;
      }
      response.writeHead(204).end();
    };
    const result = await guarded.send(message({ settings: { url: url() } }));
    assert.ok(!result.ok);
    assert.ok(result.error.includes('metadata'), result.error);
    assert.equal(seen.length, 1, 'the second hop was never made');
  });

  it('stops after the configured number of redirects', async () => {
    respond = (_request, response) => {
      response.writeHead(302, { location: '/again' }).end();
    };
    const result = await transport({ maxRedirects: 2 }).send(message({ settings: { url: url() } }));
    assert.ok(!result.ok);
    assert.ok(result.error.includes('redirects'), result.error);
  });

  it('refuses redirects outright when none are allowed', async () => {
    respond = (_request, response) => {
      response.writeHead(302, { location: '/again' }).end();
    };
    const result = await transport({ maxRedirects: 0 }).send(message({ settings: { url: url() } }));
    assert.ok(!result.ok);
    assert.equal(seen.length, 1);
  });

  // ── timeouts ───────────────────────────────────────────────────────────────────────────

  it('survives a header name the http client refuses, instead of crashing the core later', async () => {
    // **`P-151`, a regression `P-143` introduced.** The deadline timer has to be armed before the
    // request so a `send()` that blocks is still bounded — but `http.request` throws
    // *synchronously* from its own constructor for a header name that is not a token, and the
    // timer captured `request` as a `const` in its temporal dead zone. The promise rejected as an
    // ordinary retryable failure, and `timeoutMs` later the timer fired
    // `ReferenceError: Cannot access 'request' before initialization` — from a timer, so it
    // reached `uncaughtException` in the lifecycle and took the whole core down. Every retry
    // re-armed it.
    //
    // Both halves are asserted: the send fails cleanly, and nothing throws once the deadline has
    // passed. Without the fix the second half does not fail this assertion — it kills the test
    // process, which is exactly what it did to ms-core.
    const result = await transport().send(
      message({
        settings: { url: url(), timeoutMs: 150, secretHeaders: { 'X Api Key': 'nope' } },
      }),
    );
    assert.ok(!result.ok, 'a header the client refuses is a delivery failure');

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(true, 'the deadline passed and nothing threw from the timer');
  });

  it('gives up on an endpoint that trickles, which an idle timeout never would', async () => {
    // **`P-143`.** `request.setTimeout` fires when the socket has been *quiet* for that long, so
    // an endpoint that sends one byte every so often resets it for ever — and the deadline across
    // redirect hops is only consulted between hops, so a single stalled hop was unbounded. The
    // delivery loop that awaits this is not concurrent: one endpoint holding a connection open
    // holds up every notification behind it, indefinitely.
    const timers: NodeJS.Timeout[] = [];
    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      // A byte every 50 ms against a 300 ms timeout: never idle, never finished.
      const tick = setInterval(() => {
        response.write('.');
      }, 50);
      timers.push(tick);
    };

    const started = Date.now();
    const result = await transport().send(message({ settings: { url: url(), timeoutMs: 300 } }));
    for (const timer of timers) clearInterval(timer);

    assert.ok(!result.ok);
    assert.ok(
      Date.now() - started < 5_000,
      'it must not wait for an endpoint that is never going to stop',
    );
  });

  it('gives up on an endpoint that never answers, and will try again', async () => {
    respond = () => {
      // Nothing. The socket stays open until the transport's own timeout closes it.
    };
    const result = await transport().send(message({ settings: { url: url(), timeoutMs: 300 } }));
    assert.ok(!result.ok);
    assert.equal(result.retryable, true, 'an endpoint that hung once may answer next time');
  });
});
