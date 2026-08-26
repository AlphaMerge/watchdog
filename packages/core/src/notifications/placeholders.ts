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
  /** The sensor's own priority, 1 (highest) to 5 — not the template's. */
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
    description: 'The sensor’s priority, 1 (highest) to 5.',
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
    resolve: (c) =>
      c.publicUrl === ''
        ? `sensor ${String(c.sensorId)}`
        : `${c.publicUrl.replace(/\/+$/, '')}/objects/${String(c.sensorId)}`,
  },
  {
    name: 'sitename',
    description: 'What this installation is called.',
    resolve: (c) => c.siteName,
  },
]);

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
export function substitute(text: string, context: MessageContext): Substitution {
  const unknown = new Set<string>();
  const substituted = text.replace(TOKEN, (match, name: string) => {
    // `%%` is a literal per cent. Without it there would be no way to write one before a word.
    if (name === '%') return '%';
    const placeholder = PLACEHOLDERS.get(name.toLowerCase());
    if (placeholder === undefined) {
      unknown.add(name.toLowerCase());
      return match;
    }
    return placeholder.resolve(context);
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
): RenderedMessage {
  const subject = substitute(template.subject, context);
  const body = substitute(template.body, context);
  return {
    subject: subject.text,
    body: body.text,
    unknown: [...new Set([...subject.unknown, ...body.unknown])],
  };
}
