import { strict as assert } from 'node:assert';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { WebhookConfig } from '@ms/shared';
import { cardFor, slackTransport, teamsTransport } from '../src/notifications/delivery/chat.js';
import { bareColour, styleOf } from '../src/notifications/delivery/status.js';
import type { OutgoingMessage } from '../src/notifications/delivery/transport.js';
import { substitute } from '../src/notifications/placeholders.js';
import { SENSOR_STATES } from '../src/state/tables.js';
import { messageContext } from './support/messages.js';
import { silent } from './support/tree.js';

function config(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return { targetPolicy: 'link-local', maxRedirects: 3, userAgent: 'ms-core-test', ...overrides };
}

function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    requestId: 1,
    sensorId: 42,
    subject: 'Ping on edge-router is down',
    body: 'no ICMP reply from 192.0.2.7',
    recipients: [],
    priority: 3,
    settings: { webhookUrl: 'http://127.0.0.1/services/T000/B000/xxxx' },
    context: messageContext(),
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------
// The palette. Colour is a signal here, never the signal.
// -------------------------------------------------------------------------------------------

describe('status styling', () => {
  it('has a style for every state the machine can produce', () => {
    // A state with no entry would render as `undefined` in a channel rather than fail a test.
    for (const state of SENSOR_STATES) {
      const style = styleOf(state);
      assert.match(style.colour, /^#[0-9a-f]{6}$/, state);
      assert.ok(style.label.length > 0, state);
      assert.ok(style.glyph.length > 0, state);
    }
  });

  it('never leaves colour carrying the meaning on its own', () => {
    // One in eight men has some form of colour blindness, dark mode recolours everything, and a
    // phone notification preview shows no colour at all. The word is always there too.
    const down = styleOf('down');
    const up = styleOf('up');
    assert.notEqual(down.label, up.label);
    assert.notEqual(down.glyph, up.glyph);
  });

  it('says an acknowledged sensor is still down', () => {
    // Acknowledging stops the repeats. It does not fix the thing, and a card implying otherwise
    // would be lying to a channel.
    assert.match(styleOf('down_acknowledged').label, /^Down/);
    assert.equal(styleOf('down_acknowledged').tone, 'attention');
  });

  it('keeps paused off the traffic light', () => {
    // The alarm that arrives *because* somebody paused a sensor must not look like an outage.
    assert.equal(styleOf('paused').tone, 'default');
    assert.equal(styleOf('paused').colour, styleOf('unknown').colour);
  });

  it('writes a theme colour the way a MessageCard wants it', () => {
    assert.equal(bareColour('#d63a3a'), 'D63A3A');
  });
});

// -------------------------------------------------------------------------------------------
// The content, which both services share.
// -------------------------------------------------------------------------------------------

describe('the card content', () => {
  it('drops facts that are empty rather than showing them blank', () => {
    // A sensor with no device above it has no host, and "Host: —" is noise in a message whose
    // whole job is to be read in two seconds on a phone.
    const card = cardFor(message({ context: messageContext({ host: '', groupName: '  ' }) }));
    const names = card.facts.map((fact) => fact.name);
    assert.ok(!names.includes('Host'));
    assert.ok(!names.includes('Group'));
    assert.ok(names.includes('Device'));
  });

  it('shows no value line for a sensor that recorded none', () => {
    // No-data is not zero (`CLAUDE.md`): a Down sensor records nothing, and a card showing
    // "Value: 0" would be reporting a measurement nobody took.
    const none = cardFor(message({ context: messageContext({ lastValue: null }) }));
    assert.ok(!none.facts.some((fact) => fact.name === 'Value'));
    const some = cardFor(message({ context: messageContext({ lastValue: 0 }) }));
    assert.equal(some.facts.find((fact) => fact.name === 'Value')?.value, '0');
  });

  it('links to the sensor when the installation has a reachable URL', () => {
    const card = cardFor(
      message({ context: messageContext({ publicUrl: 'https://ms.example.test/' }) }),
    );
    assert.equal(card.link, 'https://ms.example.test/objects/42');
  });

  it('has no link at all when nothing external is configured', () => {
    // Rather than one built from what the core binds to, which would point at a loopback address
    // nobody receiving the alarm can reach — worse than no link, because it looks like one.
    assert.equal(cardFor(message()).link, null);
  });

  it('says what the state was before', () => {
    const card = cardFor(message());
    assert.match(card.footer, /was up/);
    assert.match(card.footer, /since 2026-08-26T14:58:00/);
  });

  it('leaves the transition out when there was no previous state', () => {
    const card = cardFor(message({ context: messageContext({ previousState: null }) }));
    assert.ok(!card.footer.includes('was '));
  });
});

// -------------------------------------------------------------------------------------------
// Slack's syntax, which a check message can otherwise break out of.
// -------------------------------------------------------------------------------------------

describe('mrkdwn escaping', () => {
  it('stops a check message from opening a link', () => {
    // The failure this prevents: a probe reports `<html> not expected`, and the message that
    // arrives has a piece missing and a link nobody wrote.
    const context = messageContext({ message: 'got <html> & not <https://evil.test|a reply>' });
    const rendered = substitute('%lastmessage', context, 'mrkdwn');
    assert.ok(!rendered.text.includes('<'));
    assert.ok(!rendered.text.includes('>'));
    assert.match(rendered.text, /&lt;html&gt; &amp; not/);
  });

  it('leaves the operator’s own markup alone', () => {
    // Escaping is per substituted value, not over the finished text — so a template written as
    // `*%sensor* is down` still arrives bold.
    const rendered = substitute('*%sensor* <https://x.test|link>', messageContext(), 'mrkdwn');
    assert.equal(rendered.text, '*Ping* <https://x.test|link>');
  });
});

// -------------------------------------------------------------------------------------------
// The transports, against a real HTTP server.
// -------------------------------------------------------------------------------------------

describe('the chat transports', () => {
  let server: Server;
  let port: number;
  let seen: { headers: Record<string, unknown>; body: string }[];
  let respond: (request: IncomingMessage, response: ServerResponse) => void;

  before(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        seen.push({
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
      response.writeHead(200).end('ok');
    };
  });

  /** Resolves every name to loopback, so the tests reach the server above. */
  const toLoopback = () => Promise.resolve(['127.0.0.1']);

  const slack = () => slackTransport({ config: config(), logger: silent, resolve: toLoopback });
  const teams = () => teamsTransport({ config: config(), logger: silent, resolve: toLoopback });

  function hook(): string {
    return `http://webhook.test:${String(port)}/services/T000/B000/xxxx`;
  }

  function posted(): Record<string, unknown> {
    const [first] = seen;
    assert.ok(first !== undefined, 'nothing was posted');
    return JSON.parse(first.body) as Record<string, unknown>;
  }

  it('posts a Slack attachment carrying the state’s colour', async () => {
    const result = await slack().send(message({ settings: { webhookUrl: hook() } }));
    assert.ok(result.ok, result.ok ? '' : result.error);

    const document = posted();
    const attachments = document['attachments'] as { color: string; blocks: unknown[] }[];
    const [attachment] = attachments;
    assert.ok(attachment !== undefined);
    assert.equal(attachment.color, styleOf('down').colour);
    // The banner text a phone shows, which is not decoration: a card with no fallback text
    // arrives in the notification tray as an empty line.
    assert.match(String(document['text']), /^Down — Ping on edge-router/);
  });

  it('puts the status in words beside the colour, and links the title', async () => {
    await slack().send(
      message({
        settings: { webhookUrl: hook() },
        context: messageContext({ publicUrl: 'https://ms.example.test' }),
      }),
    );
    const attachments = posted()['attachments'] as { blocks: { text?: { text: string } }[] }[];
    const heading = attachments[0]?.blocks[0]?.text?.text ?? '';
    assert.match(heading, /\*Down\*/);
    assert.match(
      heading,
      /<https:\/\/ms\.example\.test\/objects\/42\|Ping on edge-router is down>/,
    );
  });

  it('cuts an over-long body rather than earning a 400 for ever', async () => {
    // Slack answers `invalid_blocks` above 3,000 characters, and a retry loop against a limit is
    // one long check message turning into an alarm nobody receives.
    const body = 'x'.repeat(5_000);
    const result = await slack().send(message({ settings: { webhookUrl: hook() }, body }));
    assert.ok(result.ok);
    const attachments = posted()['attachments'] as { blocks: { text?: { text: string } }[] }[];
    const long = attachments[0]?.blocks[1]?.text?.text ?? '';
    assert.equal(long.length, 3_000);
    assert.ok(long.endsWith('…'));
  });

  it('sends Teams an Adaptive Card in the workflow envelope by default', async () => {
    // Microsoft retired connectors; a Power Automate workflow URL takes this shape and a bare
    // MessageCard is what the retired thing took.
    const result = await teams().send(message({ settings: { webhookUrl: hook() } }));
    assert.ok(result.ok, result.ok ? '' : result.error);

    const document = posted();
    assert.equal(document['type'], 'message');
    const attachments = document['attachments'] as { contentType: string; content: unknown }[];
    assert.equal(attachments[0]?.contentType, 'application/vnd.microsoft.card.adaptive');
    const content = attachments[0].content as Record<string, unknown>;
    assert.equal(content['type'], 'AdaptiveCard');
    const body = content['body'] as { type: string; style?: string }[];
    assert.equal(body[0]?.style, styleOf('down').tone);
  });

  it('leaves the button out when there is nowhere to send anybody', async () => {
    await teams().send(message({ settings: { webhookUrl: hook() } }));
    const attachments = posted()['attachments'] as { content: Record<string, unknown> }[];
    assert.equal(attachments[0]?.content['actions'], undefined);

    seen = [];
    await teams().send(
      message({
        settings: { webhookUrl: hook() },
        context: messageContext({ publicUrl: 'https://ms.example.test' }),
      }),
    );
    const withLink = posted()['attachments'] as { content: Record<string, unknown> }[];
    const actions = withLink[0]?.content['actions'] as { type: string; url: string }[];
    assert.equal(actions[0]?.type, 'Action.OpenUrl');
    assert.equal(actions[0].url, 'https://ms.example.test/objects/42');
  });

  it('sends a legacy connector the MessageCard it understands', async () => {
    const result = await teams().send(
      message({ settings: { webhookUrl: hook(), format: 'messageCard' } }),
    );
    assert.ok(result.ok, result.ok ? '' : result.error);

    const document = posted();
    assert.equal(document['@type'], 'MessageCard');
    assert.equal(document['themeColor'], bareColour(styleOf('down').colour));
    assert.match(String(document['title']), /Down — Ping on edge-router/);
  });

  // -----------------------------------------------------------------------------------------
  // Failures, and the URL that must never appear in one.
  // -----------------------------------------------------------------------------------------

  it('gives up on a revoked webhook URL and keeps trying a rate limit', async () => {
    respond = (_request, response) => {
      response.writeHead(403).end('invalid_token');
    };
    const revoked = await slack().send(message({ settings: { webhookUrl: hook() } }));
    assert.ok(!revoked.ok && !revoked.retryable, 'a revoked URL will never start working');

    respond = (_request, response) => {
      response.writeHead(429).end('rate_limited');
    };
    const limited = await slack().send(message({ settings: { webhookUrl: hook() } }));
    assert.ok(!limited.ok && limited.retryable);
  });

  it('never puts the webhook URL in an error, because the URL is the credential', async () => {
    // Anybody holding a Slack or Teams incoming-webhook URL can post to that channel with no
    // other authentication, and an error message is a thing that gets pasted into a ticket.
    respond = (_request, response) => {
      response.writeHead(404).end('no_service');
    };
    const result = await slack().send(message({ settings: { webhookUrl: hook() } }));
    assert.ok(!result.ok);
    assert.ok(!result.error.includes('xxxx'), result.error);
    assert.ok(!result.error.includes('/services/'), result.error);
    // The host and the status still come through, which is what an operator can act on.
    assert.match(result.error, /404/);

    const malformed = await slack().send(message({ settings: { webhookUrl: 'not a url' } }));
    assert.ok(!malformed.ok);
    assert.ok(!malformed.error.includes('not a url'), malformed.error);
  });

  it('refuses a chat webhook pointing at cloud instance metadata', async () => {
    // The same guard as N-08's, deliberately: a Slack URL is a URL, and "it is Slack" is not
    // something the transport can verify before it connects.
    const transport = slackTransport({
      config: config(),
      logger: silent,
      resolve: () => Promise.resolve(['169.254.169.254']),
    });
    const result = await transport.send(message({ settings: { webhookUrl: hook() } }));
    assert.ok(!result.ok);
    assert.equal(result.retryable, false);
    assert.match(result.error, /link-local/);
    assert.equal(seen.length, 0, 'nothing was connected to');
  });

  it('asks for the escaping its own syntax needs', () => {
    assert.equal(slack().bodyEscaping(), 'mrkdwn');
    assert.equal(teams().bodyEscaping(), 'none');
  });
});
