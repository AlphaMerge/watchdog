import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as tls from 'node:tls';
import type { PeerCertificate } from 'node:tls';
import type { WebhookConfig } from '@ms/shared';
import {
  isLinkLocal,
  isPrivate,
  refusedAddresses,
  refuses,
  sameOrigin,
  schemeAllowed,
  serverIdentity,
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

  // ── a URL whose host is an address (`A-58`) ─────────────────────────────────────────────
  // With the system's own resolver, which is what runs: no `resolve` is injected unless the
  // test is about what a resolver is asked.

  it('refuses by the policy a URL that gives a blocked IPv6 address itself, and does not retry', async () => {
    // `URL.hostname` keeps the brackets and the system resolver does not take `[::1]` for an
    // address, so these used to fail as a name that did not resolve, and were retried.
    const literal = new WebhookTransport({ config: config(), logger: silent });
    for (const host of ['[::ffff:169.254.169.254]', '[::ffff:a9fe:a9fe]', '[fd00:ec2::254]']) {
      const result = await literal.send(
        message({ settings: { url: `http://${host}:${String(port)}/hook` } }),
      );
      assert.ok(!result.ok, host);
      assert.equal(result.retryable, false, `${host}: ${result.error}`);
      assert.ok(result.error.includes('refused by the target policy'), result.error);
      assert.ok(result.error.includes('metadata'), result.error);
      assert.ok(!result.error.includes('['), `named without the brackets: ${result.error}`);
    }
    assert.equal(seen.length, 0, 'and nothing was sent');
  });

  it('refuses a private IPv6 address in a URL under the stricter policy', async () => {
    const literal = new WebhookTransport({
      config: config({ targetPolicy: 'private' }),
      logger: silent,
    });
    for (const host of ['[::1]', '[fd00::1]', '[::ffff:127.0.0.1]']) {
      const result = await literal.send(
        message({ settings: { url: `http://${host}:${String(port)}/hook` } }),
      );
      assert.ok(!result.ok, host);
      assert.equal(result.retryable, false, `${host}: ${result.error}`);
      assert.ok(result.error.includes('private'), result.error);
    }
    assert.equal(seen.length, 0);
  });

  it('judges an address in a URL as itself, whatever a resolver would say about it', async () => {
    // The socket connects straight to an address and asks nobody, so an answer for one would be
    // an answer about somewhere the request does not go.
    let asked = 0;
    const guarded = new WebhookTransport({
      config: config(),
      logger: silent,
      resolve: () => {
        asked += 1;
        return Promise.resolve(['127.0.0.1']);
      },
    });
    for (const host of ['169.254.169.254', '[fd00:ec2::254]']) {
      const result = await guarded.send(
        message({ settings: { url: `http://${host}:${String(port)}/hook` } }),
      );
      assert.ok(!result.ok, host);
      assert.equal(result.retryable, false, host);
      assert.ok(result.error.includes('refused by the target policy'), result.error);
    }
    assert.equal(asked, 0, 'an address is not looked up');
    assert.equal(seen.length, 0);

    // And the other way about: an allowed address is reached though the resolver would have
    // answered with one that is refused.
    const lying = new WebhookTransport({
      config: config(),
      logger: silent,
      resolve: () => Promise.resolve(['169.254.169.254']),
    });
    const result = await lying.send(
      message({ settings: { url: `http://127.0.0.1:${String(port)}/hook` } }),
    );
    assert.ok(result.ok, result.ok ? '' : result.error);
    assert.equal(seen.length, 1);
    assert.equal(seen.at(0)?.headers['host'], `127.0.0.1:${String(port)}`);
  });

  it('delivers to a URL that gives an allowed IPv6 address itself', async (t) => {
    // The default policy allows loopback. A server of its own, since the one above is on
    // 127.0.0.1 only.
    const arrived: { url: string; host: unknown }[] = [];
    const six = createServer((request, response) => {
      arrived.push({ url: request.url ?? '', host: request.headers['host'] });
      response.writeHead(204).end();
    });
    const listening = await new Promise<boolean>((resolve) => {
      six.once('error', () => {
        resolve(false);
      });
      six.listen(0, '::1', () => {
        resolve(true);
      });
    });
    if (!listening) {
      t.skip('this machine has no IPv6 loopback to listen on');
      return;
    }
    const sixPort = (six.address() as AddressInfo).port;
    try {
      const literal = new WebhookTransport({ config: config(), logger: silent });
      const result = await literal.send(
        message({ settings: { url: `http://[::1]:${String(sixPort)}/hook`, timeoutMs: 5_000 } }),
      );
      assert.ok(result.ok, result.ok ? '' : result.error);
      // `Host` keeps the URL's spelling of the address, brackets and all.
      assert.deepEqual(arrived, [{ url: '/hook', host: `[::1]:${String(sixPort)}` }]);
      assert.equal(seen.length, 0, 'and not to the IPv4 server');
    } finally {
      await new Promise<void>((resolve) => {
        six.close(() => {
          resolve();
        });
      });
    }
  });

  it('pins a name under the spelling the socket asks with', async () => {
    // The socket's lookup is answered from what was pinned for the name it asks about, so a
    // name pinned under any other spelling than Node's has no address and nothing arrives.
    // The resolver here answers only the spelling it expects, and each delivery arriving shows
    // that the check, the pin and the socket agreed on it.
    for (const [written, expected] of [
      ['webhook.test', 'webhook.test'],
      ['WebHook.TEST', 'webhook.test'],
      ['webhook.test.', 'webhook.test.'],
    ] as const) {
      const asked: string[] = [];
      const guarded = new WebhookTransport({
        config: config(),
        logger: silent,
        resolve: (hostname) => {
          asked.push(hostname);
          return hostname === expected
            ? Promise.resolve(['127.0.0.1'])
            : Promise.reject(new Error(`asked for ${hostname}`));
        },
      });
      seen = [];
      const result = await guarded.send(
        message({ settings: { url: `http://${written}:${String(port)}/hook` } }),
      );
      assert.ok(result.ok, result.ok ? '' : `${written}: ${result.error}`);
      assert.deepEqual(asked, [expected], 'one lookup, by the guard');
      assert.equal(seen.length, 1, written);
      assert.equal(seen.at(0)?.headers['host'], `${expected}:${String(port)}`);
    }
  });

  it('a name that answers nothing fails where it is, after another was delivered to', async () => {
    // Two names through one client: the first is allowed and pinned, the second answers
    // nothing and is stopped at the check. That the socket's lookup answers a name only from
    // that name's own pin is not shown here: no request gets as far as a socket without one.
    const guarded = new WebhookTransport({
      config: config(),
      logger: silent,
      resolve: (hostname) => Promise.resolve(hostname === 'good.test' ? ['127.0.0.1'] : []),
    });
    const good = await guarded.send(
      message({ settings: { url: `http://good.test:${String(port)}/hook` } }),
    );
    assert.ok(good.ok, good.ok ? '' : good.error);
    const other = await guarded.send(
      message({ settings: { url: `http://other.test:${String(port)}/hook` } }),
    );
    assert.ok(!other.ok);
    assert.equal(other.retryable, true);
    assert.equal(seen.length, 1);
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

// -------------------------------------------------------------------------------------------
// HTTPS to a URL whose host is an address (`A-60`).
// -------------------------------------------------------------------------------------------

/**
 * Certificates made here with `openssl`, as `tls.test.ts` and `pinned-transports.test.ts` make
 * theirs: a committed one expires on a date nobody chose, and brings a private key into the
 * repository with it. Each is self-signed, and the ones a test means to be believed are added to
 * what this process trusts, so that what a refusal is about is the name on the certificate and
 * not who issued it.
 */
describe('the webhook transport over HTTPS, to a URL whose host is an address', () => {
  interface Pair {
    readonly key: string;
    readonly cert: string;
  }
  interface Pairs {
    /** Names both loopback addresses, and no DNS name. */
    readonly forAddresses: Pair;
    /** Names `webhook.test`, and no address. */
    readonly forName: Pair;
    /** Names an address, and not the one the server is on. */
    readonly forAnotherAddress: Pair;
    /** Has `::1` as its common name and as a DNS name, and lists no address. */
    readonly speltLikeAnAddress: Pair;
    /** Names both loopback addresses, and nothing in this process trusts it. */
    readonly untrusted: Pair;
  }

  let dir = '';
  let made: Pairs | undefined;

  /** Whether this Node can be told to trust a certificate from inside the process. */
  const setTrusted = (tls as { setDefaultCACertificates?: (certs: string[]) => void })
    .setDefaultCACertificates;
  const getTrusted = (tls as { getCACertificates?: (type: string) => string[] }).getCACertificates;
  let trustedBefore: string[] | undefined;

  function certificate(file: string, commonName: string, names: string): Pair {
    const keyFile = join(dir, `${file}.key`);
    const certFile = join(dir, `${file}.crt`);
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyFile,
        '-out',
        certFile,
        '-days',
        '30',
        '-subj',
        `/CN=${commonName}`,
        '-addext',
        `subjectAltName=${names}`,
      ],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8') };
  }

  before(() => {
    try {
      dir = mkdtempSync(join(tmpdir(), 'ms-webhook-tls-'));
      made = {
        forAddresses: certificate('addresses', 'ms-webhook-test', 'IP:127.0.0.1,IP:::1'),
        forName: certificate('name', 'webhook.test', 'DNS:webhook.test'),
        forAnotherAddress: certificate('another', 'ms-webhook-test', 'IP:127.0.0.2'),
        speltLikeAnAddress: certificate('spelt', '::1', 'DNS:::1'),
        untrusted: certificate('untrusted', 'ms-webhook-test', 'IP:127.0.0.1,IP:::1'),
      };
    } catch {
      made = undefined;
    }
    if (made !== undefined && setTrusted !== undefined && getTrusted !== undefined) {
      trustedBefore = getTrusted('default');
      setTrusted([
        ...trustedBefore,
        made.forAddresses.cert,
        made.forName.cert,
        made.forAnotherAddress.cert,
        made.speltLikeAnAddress.cert,
      ]);
    }
  });

  after(() => {
    if (trustedBefore !== undefined && setTrusted !== undefined) setTrusted(trustedBefore);
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  /** Skips, saying why, where the machine cannot make or trust a certificate. */
  function pairs(t: { skip(reason: string): void }): Pairs | null {
    if (made === undefined) {
      t.skip('openssl is not on this machine');
      return null;
    }
    if (trustedBefore === undefined) {
      t.skip('this Node has no tls.setDefaultCACertificates to trust a test certificate with');
      return null;
    }
    return made;
  }

  interface Secure {
    readonly port: number;
    /** Every request that arrived: its path and the `Host` it was sent with. */
    readonly arrived: { url: string; host: unknown }[];
    /** Every name a client put in its hello (SNI). Nothing is added for a hello without one. */
    readonly named: string[];
    close(): Promise<void>;
  }

  /** A TLS server with one certificate, or null where the address cannot be listened on. */
  async function secure(pair: Pair, address: string): Promise<Secure | null> {
    const arrived: Secure['arrived'] = [];
    const named: string[] = [];
    const server = createSecureServer(
      {
        key: pair.key,
        cert: pair.cert,
        // Called only for a hello that carries a server name; with no context given back, the
        // handshake goes on with the certificate above.
        SNICallback: (servername, done) => {
          named.push(servername);
          done(null);
        },
      },
      (request, response) => {
        arrived.push({ url: request.url ?? '', host: request.headers['host'] });
        response.writeHead(204).end();
      },
    );
    const listening = await new Promise<boolean>((resolve) => {
      server.once('error', () => {
        resolve(false);
      });
      server.listen(0, address, () => {
        resolve(true);
      });
    });
    if (!listening) return null;
    return {
      port: (server.address() as AddressInfo).port,
      arrived,
      named,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    };
  }

  /** An address is its own answer: any lookup at all fails the delivery, naming what was asked. */
  const neverAsked = (hostname: string): Promise<string[]> =>
    Promise.reject(new Error(`looked up ${hostname}`));

  function toAddress(): WebhookTransport {
    return new WebhookTransport({ config: config(), logger: silent, resolve: neverAsked });
  }

  const hook = (host: string, port: number): OutgoingMessage =>
    message({ settings: { url: `https://${host}:${String(port)}/hook`, timeoutMs: 5_000 } });

  it('delivers to https://127.0.0.1, checking the certificate against the address', async (t) => {
    const certificates = pairs(t);
    if (certificates === null) return;
    const server = await secure(certificates.forAddresses, '127.0.0.1');
    assert.ok(server !== null, '127.0.0.1 could not be listened on');
    try {
      const result = await toAddress().send(hook('127.0.0.1', server.port));
      assert.ok(result.ok, result.ok ? '' : result.error);
      assert.equal(result.detail, `204 from 127.0.0.1:${String(server.port)}`);
      assert.deepEqual(server.arrived, [
        { url: '/hook', host: `127.0.0.1:${String(server.port)}` },
      ]);
      // An address is not a server name, and Node puts none in the hello for one.
      assert.deepEqual(server.named, []);
    } finally {
      await server.close();
    }
  });

  it('delivers to https://[::1], checking the certificate against the address', async (t) => {
    const certificates = pairs(t);
    if (certificates === null) return;
    const server = await secure(certificates.forAddresses, '::1');
    if (server === null) {
      t.skip('this machine has no IPv6 loopback to listen on');
      return;
    }
    try {
      const result = await toAddress().send(hook('[::1]', server.port));
      assert.ok(result.ok, result.ok ? '' : result.error);
      // `Host` keeps the URL's spelling, brackets and all; the certificate was matched without.
      assert.deepEqual(server.arrived, [{ url: '/hook', host: `[::1]:${String(server.port)}` }]);
      assert.deepEqual(server.named, []);
    } finally {
      await server.close();
    }
  });

  it('names the server in its hello for a name, which the address tests show it does not for an address', async (t) => {
    // The other half of "no server name for an address": the same server does see one when one
    // is sent, so the empty list above is the client's doing and not the server's deafness.
    const certificates = pairs(t);
    if (certificates === null) return;
    const server = await secure(certificates.forName, '127.0.0.1');
    assert.ok(server !== null, '127.0.0.1 could not be listened on');
    try {
      const byName = new WebhookTransport({
        config: config(),
        logger: silent,
        resolve: () => Promise.resolve(['127.0.0.1']),
      });
      const result = await byName.send(hook('webhook.test', server.port));
      assert.ok(result.ok, result.ok ? '' : result.error);
      assert.deepEqual(server.named, ['webhook.test']);
      assert.deepEqual(server.arrived, [
        { url: '/hook', host: `webhook.test:${String(server.port)}` },
      ]);
    } finally {
      await server.close();
    }
  });

  it('refuses a certificate that names only a DNS name, for a URL that gives the address', async (t) => {
    // The same certificate the name test was delivered under: reached by address, its server is
    // nobody the certificate vouches for. The failure is the handshake's and not the target
    // policy's, so it is a failed attempt like any other and is retried.
    const certificates = pairs(t);
    if (certificates === null) return;
    const server = await secure(certificates.forName, '127.0.0.1');
    assert.ok(server !== null, '127.0.0.1 could not be listened on');
    try {
      const result = await toAddress().send(hook('127.0.0.1', server.port));
      assert.ok(!result.ok, 'a certificate for a name was taken for an address');
      assert.match(result.error, /IP: 127\.0\.0\.1 is not in the cert's list/);
      assert.doesNotMatch(result.error, /refused by the target policy/);
      assert.equal(result.retryable, true);
      assert.deepEqual(server.arrived, [], 'the request was sent before the certificate was read');
      assert.deepEqual(server.named, []);
    } finally {
      await server.close();
    }
  });

  it('refuses a certificate that names another address', async (t) => {
    // Not "any certificate with an address on it": the one the URL gives.
    const certificates = pairs(t);
    if (certificates === null) return;
    const server = await secure(certificates.forAnotherAddress, '127.0.0.1');
    assert.ok(server !== null, '127.0.0.1 could not be listened on');
    try {
      const result = await toAddress().send(hook('127.0.0.1', server.port));
      assert.ok(!result.ok, 'a certificate for 127.0.0.2 was taken for 127.0.0.1');
      assert.match(result.error, /IP: 127\.0\.0\.1 is not in the cert's list: 127\.0\.0\.2/);
      assert.equal(result.retryable, true);
      assert.deepEqual(server.arrived, []);
    } finally {
      await server.close();
    }
  });

  it('refuses, for https://[::1], every certificate that does not list that address', async (t) => {
    // Node's own check takes an IPv6 address for a name (`serverIdentity`), so this address is
    // checked here: against the addresses a certificate lists, and nothing spelt like one.
    const certificates = pairs(t);
    if (certificates === null) return;
    for (const [label, pair, listed] of [
      ['a DNS name only', certificates.forName, 'DNS:webhook.test'],
      ['another address', certificates.forAnotherAddress, 'IP Address:127.0.0.2'],
      ['the address as a DNS name and a common name', certificates.speltLikeAnAddress, 'DNS:::1'],
    ] as const) {
      const server = await secure(pair, '::1');
      if (server === null) {
        t.skip('this machine has no IPv6 loopback to listen on');
        return;
      }
      try {
        const result = await toAddress().send(hook('[::1]', server.port));
        assert.ok(!result.ok, `${label}: taken for ::1`);
        assert.equal(
          result.error,
          `Hostname/IP does not match certificate's altnames: IP: ::1 is not in the cert's list: ${listed}`,
          label,
        );
        assert.equal(result.retryable, true, label);
        assert.deepEqual(server.arrived, [], label);
      } finally {
        await server.close();
      }
    }
  });

  it('checks an IPv6 address itself, and leaves every other host to Node', (t) => {
    const certificates = pairs(t);
    if (certificates === null) return;
    /** A certificate as the handshake hands one over, with only what the check reads. */
    const peer = (fields: { pair?: Pair; subjectaltname?: string }): PeerCertificate =>
      ({
        ...(fields.pair === undefined ? {} : { raw: new X509Certificate(fields.pair.cert).raw }),
        ...(fields.subjectaltname === undefined ? {} : { subjectaltname: fields.subjectaltname }),
        subject: { CN: 'ms-webhook-test' },
      }) as unknown as PeerCertificate;

    // An IPv6 address: asked of the certificate, in any spelling of the address.
    const both = peer({ pair: certificates.forAddresses });
    assert.equal(serverIdentity('::1', both), undefined);
    assert.equal(serverIdentity('0:0:0:0:0:0:0:1', both), undefined);
    const refused = serverIdentity('::1', peer({ pair: certificates.forAnotherAddress }));
    assert.ok(refused instanceof Error);
    assert.equal((refused as { code?: unknown }).code, 'ERR_TLS_CERT_ALTNAME_INVALID');
    assert.ok(serverIdentity('::2', both) instanceof Error, 'an address it does not list');
    // A certificate there is nothing to ask of is refused, whatever its names say.
    assert.ok(
      serverIdentity('::1', peer({ subjectaltname: 'IP Address:0:0:0:0:0:0:0:1' })) instanceof
        Error,
    );

    // Anything else is Node's to judge, which reads the names and has no use for the rest: an
    // answer for a certificate with nothing but names is Node's answer.
    assert.equal(
      serverIdentity('127.0.0.1', peer({ subjectaltname: 'IP Address:127.0.0.1' })),
      undefined,
    );
    assert.ok(
      serverIdentity('127.0.0.1', peer({ subjectaltname: 'IP Address:127.0.0.2' })) instanceof
        Error,
    );
    assert.equal(
      serverIdentity('webhook.test', peer({ subjectaltname: 'DNS:webhook.test' })),
      undefined,
    );
    assert.ok(
      serverIdentity('other.test', peer({ subjectaltname: 'DNS:webhook.test' })) instanceof Error,
    );
  });

  it('refuses a certificate that names the address and that nothing here trusts', async (t) => {
    // What makes the deliveries above mean something: the client is verifying, and it believed
    // the certificates this file told it to and no other.
    const certificates = pairs(t);
    if (certificates === null) return;
    const server = await secure(certificates.untrusted, '127.0.0.1');
    assert.ok(server !== null, '127.0.0.1 could not be listened on');
    try {
      const result = await toAddress().send(hook('127.0.0.1', server.port));
      assert.ok(!result.ok, 'an untrusted certificate was believed');
      assert.match(result.error, /self-signed certificate/);
      assert.equal(result.retryable, true);
      assert.deepEqual(server.arrived, []);
    } finally {
      await server.close();
    }
  });
});
