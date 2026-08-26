import type { Logger, WebhookConfig } from '@ms/shared';
import { SLACK_METHOD, TEAMS_METHOD } from '../methods.js';
import { escapeMrkdwn, sensorLink, type Escaping, type MessageContext } from '../placeholders.js';
import { GuardedHttpClient } from './http-client.js';
import { bareColour, styleOf, type StatusStyle } from './status.js';
import type { DeliveryResult, DeliveryTransport, OutgoingMessage } from './transport.js';

export interface ChatTransportOptions {
  config: WebhookConfig;
  logger: Logger;
  /** Swapped in tests. Production resolves through the system resolver. */
  resolve?: (hostname: string) => Promise<string[]>;
}

/** A fact worth a line of its own in the card. */
export interface Fact {
  readonly name: string;
  readonly value: string;
}

/**
 * What a chat message says, before either service's document shape is imposed on it.
 *
 * Slack and Teams disagree about almost everything at the wire — attachments against cards, hex
 * against a named palette, `mrkdwn` against a subset of Markdown — and agree completely about
 * what an alarm has to communicate. So the content is decided once, here, and each format is a
 * translation of it. A third service later is one more translation and no new decisions.
 */
export interface Card {
  readonly title: string;
  readonly body: string;
  readonly style: StatusStyle;
  /** Null when this installation has no externally reachable URL configured. */
  readonly link: string | null;
  readonly facts: readonly Fact[];
  readonly footer: string;
}

interface ChatFormat {
  /** The `NotificationMethod` id this serves. */
  readonly method: string;
  /** How a substituted value has to be escaped to survive this service's text syntax. */
  readonly escaping: Escaping;
  build(card: Card, settings: Readonly<Record<string, unknown>>): unknown;
}

const MAX_FACTS = 8;

/**
 * Slack and Teams delivery (`N-09`, `CAPABILITIES.MD §5.2`).
 *
 * **Both are the same transport.** Each posts a JSON document to an incoming-webhook URL that is
 * itself the credential, through the guard `N-08` already built; the only difference is the shape
 * of the document, which is the `ChatFormat` above. Writing them as two classes would have
 * duplicated the guard, the timeout and the status reading to gain nothing.
 *
 * **The URL is a secret and is treated as one everywhere.** Anybody holding a Slack or Teams
 * incoming-webhook URL can post to that channel with no further authentication, which is why the
 * method marks it `writeOnly` and why nothing here — not a log line, not an error message — ever
 * contains it. A failure reports the host and the status, which is what an operator needs and is
 * the most that can be said safely.
 */
export class ChatTransport implements DeliveryTransport {
  readonly method: string;
  readonly #format: ChatFormat;
  readonly #http: GuardedHttpClient;

  constructor(format: ChatFormat, options: ChatTransportOptions) {
    this.method = format.method;
    this.#format = format;
    this.#http = new GuardedHttpClient({
      config: options.config,
      logger: options.logger.child({ component: format.method }),
      ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
    });
  }

  bodyEscaping(): Escaping {
    return this.#format.escaping;
  }

  async send(message: OutgoingMessage): Promise<DeliveryResult> {
    const settings = message.settings;
    const raw = typeof settings['webhookUrl'] === 'string' ? settings['webhookUrl'] : '';
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      // Deliberately without the value. A malformed webhook URL is still a webhook URL, and an
      // error message is a thing that gets pasted into a ticket.
      return { ok: false, retryable: false, error: 'the configured webhook URL is not a URL' };
    }

    const document = this.#format.build(cardFor(message), settings);

    return this.#http.send({
      url,
      body: JSON.stringify(document),
      contentType: 'application/json',
      timeoutMs: typeof settings['timeoutMs'] === 'number' ? settings['timeoutMs'] : 10_000,
    });
  }
}

export function slackTransport(options: ChatTransportOptions): ChatTransport {
  return new ChatTransport(SLACK_FORMAT, options);
}

export function teamsTransport(options: ChatTransportOptions): ChatTransport {
  return new ChatTransport(TEAMS_FORMAT, options);
}

// -------------------------------------------------------------------------------------------
// The content, decided once.
// -------------------------------------------------------------------------------------------

/** What the card says, from the rendered text and the facts it was rendered from. */
export function cardFor(message: OutgoingMessage): Card {
  const context = message.context;
  return {
    title: message.subject,
    // Trimmed, because a template whose first line is a placeholder that resolved to nothing —
    // `%lastmessage` on a recovery, which has none — otherwise opens the card with a blank line.
    body: message.body.trim(),
    style: styleOf(context.state),
    link: sensorLink(context),
    facts: factsFor(context),
    footer: footerFor(context),
  };
}

/**
 * The facts worth a line, in the order somebody triaging reads them.
 *
 * Empty ones are dropped rather than shown blank: a sensor on a group with no device above it has
 * no host, and a row reading "Host: —" is noise in a message whose whole job is to be scanned in
 * two seconds on a phone.
 */
function factsFor(context: MessageContext): Fact[] {
  const facts: Fact[] = [
    { name: 'Device', value: context.deviceName },
    { name: 'Host', value: context.host },
    { name: 'Group', value: context.groupName },
    { name: 'Probe', value: context.probeName },
    { name: 'Location', value: context.location },
    { name: 'Priority', value: String(context.priority) },
    // No-data is not zero (`CLAUDE.md`): a sensor with no reading has no value line at all,
    // rather than a nought nobody measured.
    { name: 'Value', value: context.lastValue === null ? '' : String(context.lastValue) },
    { name: 'Tags', value: context.tags.join(', ') },
  ];
  return facts.filter((fact) => fact.value.trim() !== '').slice(0, MAX_FACTS);
}

/** The line underneath: where this came from, and when the state started. */
function footerFor(context: MessageContext): string {
  const parts = [context.siteName, `since ${context.since.toISOString()}`];
  if (context.previousState !== null) {
    parts.push(`was ${styleOf(context.previousState).label.toLowerCase()}`);
  }
  return parts.filter((part) => part !== '').join(' · ');
}

/** `Down — Ping on edge-router`, for a notification preview and for a client that renders nothing. */
function summaryOf(card: Card): string {
  return `${card.style.label} — ${card.title}`;
}

// -------------------------------------------------------------------------------------------
// Slack.
// -------------------------------------------------------------------------------------------

/** Slack's own limits. Exceeding one is a 400 with `invalid_blocks`, not a truncated message. */
const SLACK_TEXT_LIMIT = 3000;
const SLACK_FIELD_LIMIT = 2000;
/** Ten, but they come in two columns, so an even number keeps the grid square. */
const SLACK_FIELDS = 8;

interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  fields?: { type: string; text: string }[];
  elements?: { type: string; text: string }[];
}

/**
 * An attachment, which is the only thing in Slack that has a colour.
 *
 * Slack calls secondary attachments legacy and has done for years, and the replacement — blocks
 * posted at the top level — has no colour at any version. Since the ticket is "status colour",
 * the attachment is the mechanism, with blocks *inside* it so the layout is the modern one. The
 * top-level `text` is not decoration either: it is what a phone shows in the notification banner
 * and what a screen reader reads, and a card with no fallback text arrives as an empty line.
 */
const SLACK_FORMAT: ChatFormat = {
  method: SLACK_METHOD.id,
  escaping: 'mrkdwn',
  build(card) {
    const heading =
      card.link === null
        ? `*${escapeMrkdwn(card.title)}*`
        : `*<${card.link}|${escapeMrkdwn(card.title)}>*`;

    const blocks: SlackBlock[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: clamp(
            `${card.style.glyph} *${card.style.label}*\n${heading}`,
            SLACK_TEXT_LIMIT,
          ),
        },
      },
    ];

    if (card.body !== '') {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: clamp(card.body, SLACK_TEXT_LIMIT) },
      });
    }

    const fields = card.facts.slice(0, SLACK_FIELDS);
    if (fields.length > 0) {
      blocks.push({
        type: 'section',
        fields: fields.map((fact) => ({
          type: 'mrkdwn',
          text: clamp(`*${fact.name}*\n${escapeMrkdwn(fact.value)}`, SLACK_FIELD_LIMIT),
        })),
      });
    }

    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: clamp(escapeMrkdwn(card.footer), SLACK_TEXT_LIMIT) }],
    });

    return {
      // The banner text, which Slack renders as mrkdwn — so a subject containing `<` is escaped
      // here, while `fallback` beside it is plain text by definition and is not.
      text: escapeMrkdwn(summaryOf(card)),
      attachments: [
        {
          color: card.style.colour,
          fallback: summaryOf(card),
          blocks,
        },
      ],
    };
  },
};

// -------------------------------------------------------------------------------------------
// Teams.
// -------------------------------------------------------------------------------------------

/**
 * Teams, in whichever of its two shapes this webhook URL expects.
 *
 * Microsoft retired Office 365 connectors and replaced them with Power Automate workflows, which
 * take an Adaptive Card wrapped in a `message` envelope; a connector URL that predates the change
 * takes a `MessageCard` and rejects the envelope outright. Which one an operator has is a
 * property of the URL they were given and cannot be inferred from it, so it is a setting, and the
 * default is the one Microsoft still creates. Sending the wrong shape produces a 400 with a
 * useless body, which is why this is worth a field rather than a guess.
 */
const TEAMS_FORMAT: ChatFormat = {
  method: TEAMS_METHOD.id,
  // A card's text is a small Markdown subset and there is nothing in it a value can break out
  // of — no link syntax that swallows the rest of a line, and `JSON.stringify` handles the
  // document itself.
  escaping: 'none',
  build(card, settings) {
    return settings['format'] === 'messageCard' ? messageCard(card) : adaptiveCard(card);
  },
};

function adaptiveCard(card: Card): unknown {
  const body: unknown[] = [
    {
      type: 'Container',
      style: card.style.tone,
      bleed: true,
      items: [
        {
          type: 'TextBlock',
          text: `${card.style.glyph} ${card.style.label}`,
          weight: 'Bolder',
          color: toneColour(card.style.tone),
          wrap: true,
        },
      ],
    },
    { type: 'TextBlock', text: card.title, size: 'Large', weight: 'Bolder', wrap: true },
  ];
  if (card.body !== '') body.push({ type: 'TextBlock', text: card.body, wrap: true });
  if (card.facts.length > 0) {
    body.push({
      type: 'FactSet',
      facts: card.facts.map((fact) => ({ title: fact.name, value: fact.value })),
    });
  }
  body.push({ type: 'TextBlock', text: card.footer, isSubtle: true, wrap: true, spacing: 'Small' });

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          // 1.4 is what Teams renders everywhere, desktop and mobile. Later versions exist and
          // degrade to a blank card on the clients that do not know them.
          version: '1.4',
          msteams: { width: 'Full' },
          body,
          // Omitted entirely when there is nothing to point at: an `Action.OpenUrl` needs an
          // absolute URL, and a button that goes nowhere is worse than no button.
          ...(card.link === null
            ? {}
            : { actions: [{ type: 'Action.OpenUrl', title: 'Open sensor', url: card.link }] }),
        },
      },
    ],
  };
}

function messageCard(card: Card): unknown {
  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    summary: summaryOf(card),
    themeColor: bareColour(card.style.colour),
    title: `${card.style.glyph} ${card.style.label} — ${card.title}`,
    text: card.body,
    sections: [
      {
        facts: card.facts.map((fact) => ({ name: fact.name, value: fact.value })),
        text: card.footer,
      },
    ],
    ...(card.link === null
      ? {}
      : {
          potentialAction: [
            {
              '@type': 'OpenUri',
              name: 'Open sensor',
              targets: [{ os: 'default', uri: card.link }],
            },
          ],
        }),
  };
}

/** A card's accent colour, which Adaptive Cards names rather than spells. */
function toneColour(tone: StatusStyle['tone']): string {
  return tone === 'default' ? 'Default' : tone === 'accent' ? 'Accent' : capitalise(tone);
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Cuts text to what the service accepts.
 *
 * Truncating is the lesser evil: the alternative is a 400 and a retry loop that will never
 * succeed, which turns one long check message into an alarm nobody ever receives.
 */
function clamp(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
