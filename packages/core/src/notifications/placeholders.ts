import type { SensorState } from '../state/tables.js';

/**
 * Placeholder substitution (`N-06`).
 *
 * `CAPABILITIES.MD §5.2` lists the names; this file is them, plus the two rules that make the
 * feature usable rather than merely present:
 *
 * - **Case-insensitive.** `%Sensor`, `%SENSOR` and `%sensor` are one placeholder. An operator
 *   writing a sentence capitalises the first word, and a system that silently blanked
 *   `%Sensor is down` would be punishing correct English.
 * - **Unknown placeholders are reported, never silently blanked.** A message that quietly loses
 *   `%lastvlaue` reads perfectly and says nothing, and nobody finds out until the night it
 *   mattered. So a template naming one is refused when it is saved — the only moment anyone can
 *   fix it — and, for anything already stored, substitution leaves the text exactly as written
 *   and says which names it did not know.
 */

/** Everything a message can be built from, for one notification. */
export interface MessageContext {
  readonly sensorId: number;
  readonly sensorName: string;
  readonly deviceName: string;
  readonly groupName: string;
  readonly probeName: string;
  readonly host: string;
  readonly location: string;
  readonly comments: string;
  readonly tags: readonly string[];
  /** The sensor's own priority, 1 (lowest) to 5 (highest) — not the template's (`P-137`). */
  readonly priority: number;
  readonly state: SensorState;
  /** What it was before. Null when this is the first state it has ever had. */
  readonly previousState: SensorState | null;
  readonly message: string;
  /** The channel value the notification is about, or the primary channel's latest. */
  readonly lastValue: number | null;
  /** When the notification fell due. */
  readonly at: Date;
  /** When the sensor entered its current state. */
  readonly since: Date;
  /** The externally reachable base URL of the web UI, or empty. */
  readonly publicUrl: string;
  readonly siteName: string;
}

/** One placeholder: its name, what it means, and how to read it. */
interface Placeholder {
  readonly name: string;
  readonly description: string;
  resolve(context: MessageContext): string;
}

/**
 * Dates go out as ISO 8601, in UTC.
 *
 * Unambiguous, and unambiguous is what a timestamp in an alarm has to be. A locale-formatted
 * date needs a locale and a timezone the installation has not been asked for, and "03/04" read
 * in the wrong country is a date two months out.
 */
function isoOf(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function define(placeholders: readonly Placeholder[]): ReadonlyMap<string, Placeholder> {
  const byName = new Map<string, Placeholder>();
  for (const placeholder of placeholders) {
    // Lower-cased once, here, so the case-insensitivity is a property of the table rather than
    // of every lookup that consults it.
    const key = placeholder.name.toLowerCase();
    if (byName.has(key)) throw new Error(`duplicate placeholder %${placeholder.name}`);
    byName.set(key, placeholder);
  }
  return byName;
}

export const PLACEHOLDERS = define([
  { name: 'sensor', description: 'The sensor’s name.', resolve: (c) => c.sensorName },
  { name: 'device', description: 'The device the sensor is on.', resolve: (c) => c.deviceName },
  { name: 'group', description: 'The group the device is in.', resolve: (c) => c.groupName },
  { name: 'probe', description: 'The probe that runs the check.', resolve: (c) => c.probeName },
  { name: 'host', description: 'The device’s address.', resolve: (c) => c.host },
  {
    name: 'location',
    description: 'Where the object is, inherited downward.',
    resolve: (c) => c.location,
  },
  { name: 'comments', description: 'The sensor’s comments field.', resolve: (c) => c.comments },
  {
    name: 'objecttags',
    // Inherited ones included: `CAPABILITIES.MD §1` makes "tags + inherited parent tags" a v1
    // capability, and a message showing only a sensor's own would disagree with the search that
    // found it.
    description: 'The sensor’s tags and its ancestors’, comma-separated.',
    resolve: (c) => c.tags.join(', '),
  },
  {
    name: 'priority',
    /**
     * **5 is the highest, and this said the opposite** (`P-137`).
     *
     * The object model's own definition is the filter: `priorityMin` selects `priority >= n`,
     * which only reads as "at least this important" if a larger number is more important. The
     * alarms list sorts descending for the same reason. An operator reading "1 (highest)" in the
     * placeholder list — the one place the meaning is written down for them — would put the
     * least important sensors at the top of their own notification triage, which is the one
     * direction of that mistake that matters at three in the morning.
     *
     * Not to be confused with a *template's* priority, which is the mail convention (1 high, 5
     * low) because it becomes `X-Priority` and every mail client already agrees on that.
     */
    description: 'The sensor’s priority, 1 (lowest) to 5 (highest).',
    resolve: (c) => String(c.priority),
  },
  { name: 'status', description: 'The state the notification is about.', resolve: (c) => c.state },
  {
    name: 'laststatus',
    description: 'The state it was in before that.',
    // A sensor that has only ever had one state has no previous one, and "unknown" would be a
    // lie about a state the machine actually has. The em dash says "there was not one".
    resolve: (c) => c.previousState ?? '—',
  },
  {
    name: 'lastmessage',
    description: 'What the check had to say.',
    resolve: (c) => c.message,
  },
  {
    name: 'lastvalue',
    description: 'The channel value the notification is about, or the primary channel’s latest.',
    // No-data is not zero (`CLAUDE.md`), so a sensor with no reading renders as nothing rather
    // than as a number nobody measured.
    resolve: (c) => (c.lastValue === null ? '—' : String(c.lastValue)),
  },
  {
    name: 'datetime',
    description: 'When the notification fell due, ISO 8601 UTC.',
    resolve: (c) => isoOf(c.at),
  },
  {
    name: 'since',
    description: 'When the sensor entered this state, ISO 8601 UTC.',
    resolve: (c) => isoOf(c.since),
  },
  {
    name: 'linksensor',
    description: 'A link to the sensor in the web UI.',
    // Falls back to the bare id when nothing has been configured. A link built from what the
    // core *binds* to would point at a loopback address nobody receiving the alarm can reach,
    // which is worse than no link at all because it looks like one.
    resolve: (c) => sensorLink(c) ?? `sensor ${String(c.sensorId)}`,
  },
  {
    name: 'sitename',
    description: 'What this installation is called.',
    resolve: (c) => c.siteName,
  },
]);

/**
 * A URL for the sensor, or null when this installation has no externally reachable one.
 *
 * Null rather than a fallback string, because a caller that builds a link *element* — `N-09`'s
 * card button — needs to leave it out entirely rather than render a button pointing at prose.
 * `%linksensor` supplies the prose itself.
 */
export function sensorLink(context: MessageContext): string | null {
  if (context.publicUrl === '') return null;
  return `${context.publicUrl.replace(/\/+$/, '')}/objects/${String(context.sensorId)}`;
}

/** Every placeholder name this build knows, for an error message and for a form's help text. */
export function placeholderNames(): string[] {
  return [...PLACEHOLDERS.keys()].sort();
}

export function describePlaceholders(): { name: string; description: string }[] {
  return [...PLACEHOLDERS.values()]
    .map((placeholder) => ({ name: placeholder.name, description: placeholder.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A placeholder is `%` and the letters that follow it.
 *
 * Letters only, deliberately. A body reading "CPU at 90% used" must survive, and it does: the
 * `%` is followed by a space, so nothing matches. "100%uptime" does not survive, and should not
 * — it is indistinguishable from a placeholder, and the rule that saves it is `%%`.
 */
const TOKEN = /%(%|[A-Za-z]+)/g;

/**
 * How a substituted value has to be escaped to survive the syntax around it.
 *
 * A subject line is plain text and needs nothing. A JSON webhook body is not: an operator writes
 * `{"message": "%lastmessage"}` and a probe reports `unexpected " in response`, and the document
 * that goes out is not JSON at all. The failure is silent from here — the endpoint rejects it, or
 * worse parses it into something else — and it happens only for the checks whose messages contain
 * a quote, which is to say the interesting ones.
 *
 * The escaping belongs to substitution rather than to the transport, because only substitution
 * knows which characters came from a *value* and which the operator typed as syntax.
 */
export type Escaping = 'none' | 'json' | 'form' | 'mrkdwn' | 'html';

function escapeWith(escaping: Escaping, value: string): string {
  switch (escaping) {
    case 'none':
      return value;
    case 'json':
      // The inside of a JSON string: quotes, backslashes and control characters, and nothing
      // else. `JSON.stringify` is the encoder the language already ships and agrees with every
      // parser; the slice drops the quotes it adds, which the operator's template supplies.
      return JSON.stringify(value).slice(1, -1);
    case 'form':
      return encodeURIComponent(value);
    case 'html':
      // **An HTML email is a document, and a probe writes part of it** (`P-118`). A device named
      // after a tag, or a check reporting `unexpected </p> in body`, produced an email with a
      // piece missing; a hostile response to a `rest.custom` sensor produced whatever it liked in
      // the inbox of everybody on the notification list. The five characters `escapeHtml` covers
      // are the ones that can leave a text position, and quotes are in the set because a value
      // that reaches an attribute would otherwise close it.
      //
      // Per substituted value, like every other escaping here: the operator's own markup in the
      // template is theirs and survives untouched, which is the whole reason an HTML format
      // exists.
      return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    case 'mrkdwn':
      // Slack's three reserved characters, and only these three — its own documentation names
      // them. `<` opens a link, so a probe reporting `<html> not expected` would otherwise
      // produce a message with a piece missing and a link nobody wrote. The operator's own
      // `*bold*` and `<url|label>` survive, because escaping happens per substituted value
      // rather than over the finished text.
      return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

/** The same three, for a string the transport itself puts into mrkdwn syntax. */
export function escapeMrkdwn(value: string): string {
  return escapeWith('mrkdwn', value);
}

/** What a substitution produced, and what it could not. */
export interface Substitution {
  readonly text: string;
  /**
   * Placeholder names this build does not know, lower-cased and deduplicated.
   *
   * Never empty for a template that was refused at save time, which is the point: this is the
   * second line, for templates written by a build that knew a name this one does not.
   */
  readonly unknown: readonly string[];
}

/**
 * Substitutes every placeholder it knows, and reports the ones it does not.
 *
 * An unknown placeholder is left **exactly as written**. Blanking it would produce a message
 * that reads correctly and has lost a fact; leaving it produces one an operator can look at and
 * immediately see what is wrong with.
 */
export function substitute(
  text: string,
  context: MessageContext,
  escaping: Escaping = 'none',
): Substitution {
  const unknown = new Set<string>();
  const substituted = text.replace(TOKEN, (match, name: string) => {
    // `%%` is a literal per cent. Without it there would be no way to write one before a word.
    // Not escaped: it is the operator's own text, not a value read out of the system.
    if (name === '%') return '%';
    const placeholder = PLACEHOLDERS.get(name.toLowerCase());
    if (placeholder === undefined) {
      unknown.add(name.toLowerCase());
      return match;
    }
    return escapeWith(escaping, placeholder.resolve(context));
  });
  return { text: substituted, unknown: [...unknown] };
}

/**
 * The placeholder names a template uses that this build does not know.
 *
 * What `TemplateService` calls when a subject or a body is saved. Refusing there is the whole
 * of "reported, not silently blanked": it is the one moment somebody is looking at the text and
 * can correct it.
 */
export function unknownPlaceholdersIn(text: string): string[] {
  const unknown = new Set<string>();
  for (const match of text.matchAll(TOKEN)) {
    const name = match[1];
    if (name === undefined || name === '%') continue;
    if (!PLACEHOLDERS.has(name.toLowerCase())) unknown.add(name.toLowerCase());
  }
  return [...unknown];
}

/**
 * The unknown placeholder names in every string a method's settings carry (`P-121`).
 *
 * Only the fields the method *declares* carry them, because a percent-encoded webhook URL is
 * indistinguishable from a placeholder and refusing one would be worse than the hole this closes.
 * Within a declared field it walks strings, arrays and nested objects: a program's `args` is an
 * array, and a card's fields are an object.
 */
export function unknownPlaceholdersInSettings(
  settings: Record<string, unknown>,
  fields: readonly string[],
): string[] {
  const unknown = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > 10) return;
    if (typeof value === 'string') {
      for (const name of unknownPlaceholdersIn(value)) unknown.add(name);
      return;
    }
    if (Array.isArray(value)) {
      for (const one of value) walk(one, depth + 1);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const one of Object.values(value)) walk(one, depth + 1);
    }
  };
  for (const field of fields) walk(settings[field], 0);
  return [...unknown];
}

/** A rendered message, ready for a delivery method to send. */
export interface RenderedMessage {
  readonly subject: string;
  readonly body: string;
  readonly unknown: readonly string[];
}

/** Renders a template's subject and body against one notification's context. */
export function render(
  template: { readonly subject: string; readonly body: string },
  context: MessageContext,
  escaping: Escaping = 'none',
): RenderedMessage {
  // The subject is never escaped, whatever the body needs. It is a header or a title in every
  // method that has one, and JSON-escaping a subject line would put backslashes in an email.
  const subject = substitute(template.subject, context);
  const body = substitute(template.body, context, escaping);
  return {
    subject: subject.text,
    body: body.text,
    unknown: [...new Set([...subject.unknown, ...body.unknown])],
  };
}
