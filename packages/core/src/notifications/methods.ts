import { Ajv, type ValidateFunction } from 'ajv';
import {
  AppError,
  patternMessageKeyword,
  patternMessageOf,
  unsaidPatternProblem,
} from '@ms/shared';

/**
 * How many arguments a program template may carry, split the way the form shows them.
 *
 * **Named rather than written twice** (`P-120`). The schema allowed 32 visible plus 8 secret
 * while the transport capped the concatenation at 32, so a template using its full complement of
 * visible arguments had every secret one silently dropped — the program ran, exited non-zero for
 * want of a credential nobody removed, and the notification was recorded as a failed delivery
 * with no hint why. Two numbers for one limit is how that happens; the transport derives its cap
 * from these now.
 */
export const MAX_VISIBLE_ARGS = 32;
export const MAX_SECRET_ARGS = 8;

/**
 * How a notification is delivered (`N-05`).
 *
 * Declared the way sensor types and trigger kinds are declared, and for the same reasons: the
 * JSON Schema generates the form, validates the API, documents the field and **marks the
 * secrets** in one place, so adding `[V2]`'s SMS, syslog, SNMP-trap, SNS and MQTT methods is a
 * one-file job rather than a migration and a column set. Nothing here sends anything — `N-07`
 * onwards do — this is the shape the storage keeps and the boundary refuses bad input at.
 */
export interface NotificationMethod {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** JSON Schema for `notification_template.settings`. `writeOnly` marks a secret. */
  readonly settingsSchema: Record<string, unknown>;
  /**
   * Whether the template's `recipients` list means anything for this method.
   *
   * Email has recipients; a Slack webhook posts to the channel the URL belongs to and a script
   * runs where it runs. Declared rather than inferred so the form can hide the field and the
   * validator can refuse a list nobody would ever read.
   */
  readonly usesRecipients: boolean;
  /**
   * Whether `N-11` may ever fold this method's messages into a digest.
   *
   * `CAPABILITIES.MD §5.2`: Slack, Teams, HTTP action and execute-program always send
   * immediately. They are cheap and usually machine-consumed, and a digest of webhook calls is
   * not a webhook call. Declared here so `N-11` reads it rather than hard-coding a list that
   * would drift the first time a method is added.
   */
  readonly summarisable: boolean;
  /**
   * Settings fields whose strings carry `N-06` placeholders (`P-121`).
   *
   * **Declared rather than "every string in the document"**, and the difference is a URL. A
   * webhook endpoint is percent-encoded, and `%AF` in an encoded path is indistinguishable from a
   * placeholder called `af` — so validating every string would refuse templates that are correct.
   * These are the fields where an operator is invited to write one, so these are the fields where
   * a name this build does not know is a mistake worth refusing at the moment somebody can fix it.
   *
   * Empty for a method whose settings are all switches and endpoints.
   */
  readonly placeholderFields: readonly string[];
  /**
   * Where each secret is sent (`A-40`): every `writeOnly` path, mapped to the settings fields that
   * name its destination. An empty list is a secret that is its own destination, as a Slack
   * webhook URL is.
   *
   * **A secret does not follow its destination.** An edit that leaves a secret out keeps it —
   * the form was rendered without it — but only while the fields named here are unchanged. Change
   * the webhook's URL, or the program's path or arguments, and a secret the same request does not
   * send again is cleared. Otherwise anybody who may edit a template could point a bearer token somebody else
   * set at a host of their own, press "test", and read it off the wire.
   *
   * Required, and checked against the schema's `writeOnly` paths when the registry is built, so
   * a method added later cannot store a secret without saying where it goes.
   */
  readonly secretDestinations: Readonly<Record<string, readonly string[]>>;
  /** One line an operator reads on the template list, built from the settings. */
  describe(settings: Record<string, unknown>): string;
}

export class MethodError extends AppError {
  readonly details: Readonly<{ problems: string[] }>;

  constructor(message: string, context: Record<string, string | number>, problems?: string[]) {
    super('TEMPLATE_INVALID', message, { context });
    this.name = 'MethodError';
    this.details = { problems: problems ?? [] };
  }
}

/**
 * Email (`CAPABILITIES.MD §5.2`).
 *
 * The relay itself — host, port, authentication, TLS, fallback — is installation-wide
 * configuration and belongs to `N-07`, not to each template. What is per-template is what the
 * message looks like and who it goes to.
 */
export const EMAIL_METHOD: NotificationMethod = {
  id: 'email',
  name: 'Email',
  description: 'Sends the subject and body to the template’s recipients through the SMTP relay.',
  usesRecipients: true,
  summarisable: true,
  // Nothing but a format switch and a sender address; the message itself is the subject and body.
  placeholderFields: [],
  // No secret: the relay's credentials are the installation's configuration, not a template's.
  secretDestinations: {},
  settingsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      format: { enum: ['plain', 'html'], default: 'plain' },
      /** Overrides the relay's configured sender, for a template that should reply elsewhere. */
      senderOverride: { type: ['string', 'null'], maxLength: 320, default: null },
    },
  },
  describe(settings) {
    const format = settings['format'] === 'html' ? 'HTML' : 'plain text';
    const sender = settings['senderOverride'];
    return typeof sender === 'string' && sender !== ''
      ? `email, ${format}, from ${sender}`
      : `email, ${format}`;
  },
};

/**
 * What Node will put on the wire as a header name: an HTTP token (RFC 9110 §5.6.2), which is what
 * `http.request` checks before it sends anything (`N-19`).
 */
const HEADER_NAME = "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$";
/**
 * What Node will put on the wire as a header value: a tab, printable ASCII or the rest of Latin-1.
 * A line break or anything above U+00FF throws before the request is sent (`N-19`).
 */
const HEADER_VALUE = '^[\\t\\x20-\\x7E\\x80-\\xFF]*$';

/**
 * A generic HTTP action (`CAPABILITIES.MD §5.2`) — the method that covers most integrations.
 *
 * The URL is **visible**, unlike Slack's and Teams', because a generic webhook's address is
 * usually just an address and an operator has to be able to see where their alarms are going.
 * Anything secret goes in `secretHeaders`, which never comes back. Splitting them is the honest
 * shape: a system that hid the URL would make the template unreviewable, and one that showed a
 * bearer token would leak it.
 */
export const WEBHOOK_METHOD: NotificationMethod = {
  id: 'webhook',
  name: 'HTTP action',
  description: 'Posts the message to a URL. Covers most integrations that are not Slack or Teams.',
  usesRecipients: false,
  summarisable: false,
  // Deliberately not the URL: a percent-encoded path is indistinguishable from a placeholder.
  placeholderFields: [],
  secretDestinations: { secretHeaders: ['url'] },
  settingsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: {
      url: { type: 'string', minLength: 1, maxLength: 2000 },
      verb: { enum: ['GET', 'POST', 'PUT'], default: 'POST' },
      contentType: {
        enum: ['application/json', 'text/plain', 'application/x-www-form-urlencoded'],
        default: 'application/json',
      },
      /**
       * Headers that never come back from any route, to anyone.
       *
       * A bearer token or a signing secret. `writeOnly` is what strips it — see
       * `TemplateService.#redact`.
       */
      secretHeaders: {
        type: 'object',
        writeOnly: true,
        // Refused here rather than at every delivery (`N-19`): a header Node will not send
        // failed each attempt, retried, and gave up, and the template looked fine until then.
        // Each pattern's refusal in words (`P-372`), where the pattern itself would tell an
        // operator nothing; `validate` says it, and `GET /notification-methods` carries it.
        propertyNames: {
          pattern: HEADER_NAME,
          'x-patternMessage': "is not a header name: letters, digits and !#$%&'*+-.^_`|~ only",
        },
        additionalProperties: {
          type: 'string',
          maxLength: 2000,
          pattern: HEADER_VALUE,
          'x-patternMessage':
            'cannot be sent as a header value: it has a line break or a character above U+00FF',
        },
        default: {},
      },
      timeoutMs: { type: 'integer', minimum: 100, maximum: 120_000, default: 10_000 },
    },
  },
  describe(settings) {
    const verb = typeof settings['verb'] === 'string' ? settings['verb'] : 'POST';
    const url = typeof settings['url'] === 'string' ? settings['url'] : '?';
    return `${verb} ${url}`;
  },
};

/** Slack and Teams differ only in name: both are an incoming-webhook URL and a message. */
function chatMethod(
  id: string,
  name: string,
  service: string,
  extra: Record<string, unknown> = {},
): NotificationMethod {
  return {
    id,
    name,
    description: `Posts the message to a ${service} incoming webhook.`,
    usesRecipients: false,
    summarisable: false,
    placeholderFields: [],
    // The URL is the credential and the destination at once: re-pointing it replaces it.
    secretDestinations: { webhookUrl: [] },
    settingsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['webhookUrl'],
      properties: {
        /**
         * The credential, and marked as one.
         *
         * A ${service} incoming-webhook URL is not an address that happens to be private:
         * anybody holding it can post to that channel, with no other authentication. It never
         * comes back from any route, to anyone, including administrators.
         */
        webhookUrl: { type: 'string', writeOnly: true, minLength: 1, maxLength: 2000 },
        timeoutMs: { type: 'integer', minimum: 100, maximum: 120_000, default: 10_000 },
        ...extra,
      },
    },
    describe() {
      // Nothing from the settings: the only field worth naming is the one nobody may see.
      return `${service} incoming webhook`;
    },
  };
}

export const SLACK_METHOD = chatMethod('slack', 'Slack message', 'Slack');
export const TEAMS_METHOD = chatMethod('teams', 'Microsoft Teams message', 'Teams', {
  /**
   * Which document this webhook URL expects (`N-09`).
   *
   * Microsoft retired Office 365 connectors and replaced them with Power Automate workflows.
   * A workflow URL takes an Adaptive Card inside a `message` envelope; a surviving connector
   * URL takes a bare `MessageCard` and rejects the envelope with a 400 whose body says nothing
   * useful. The two are indistinguishable by inspection, so which one this is has to be stated
   * rather than guessed, and it defaults to the one Microsoft still hands out.
   */
  format: { type: 'string', enum: ['adaptiveCard', 'messageCard'], default: 'adaptiveCard' },
});

/**
 * Execute a program or script (`CAPABILITIES.MD §5.2`, delivered by `N-10`).
 *
 * The escape hatch: whatever an installation needs that no built-in method covers is a script.
 * Which also makes it the one method where a template is close to being code, so `path` is a
 * **file name inside the configured programs directory**, never a path of its own choosing —
 * otherwise permission to edit a notification would be permission to run anything as the service
 * account. `notifications.program.directory` is empty by default and the method does nothing
 * until an operator sets it.
 *
 * Arguments carry `N-06`'s placeholders like any other content, and `secretArgs` is for the ones
 * that are a password — a script told to authenticate somewhere has to be given the secret, and
 * it must not come back out of the API afterwards.
 */
export const PROGRAM_METHOD: NotificationMethod = {
  id: 'program',
  name: 'Execute program',
  description: 'Runs a program or script, sandboxed and timed out, with the message as arguments.',
  usesRecipients: false,
  summarisable: false,
  // The arguments are content: an operator writes `--message %lastmessage` and means it.
  placeholderFields: ['args', 'secretArgs'],
  // A password written for one command line is not one for the next (`A-48`). The visible
  // arguments are as much where it goes as the path: `--gateway https://sms.example/api` becomes
  // somebody's own URL without the program changing at all.
  secretDestinations: { secretArgs: ['path', 'args'] },
  settingsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      /**
       * A file name inside `notifications.program.directory`.
       *
       * Relative, and it stays relative: an absolute path, a `..`, or a symlink leading out of
       * the directory are all refused when the notification runs.
       */
      path: { type: 'string', minLength: 1, maxLength: 1000 },
      args: {
        type: 'array',
        maxItems: MAX_VISIBLE_ARGS,
        items: { type: 'string', maxLength: 2000 },
        default: [],
      },
      /**
       * Appended after `args`, and never returned by any route.
       *
       * Write-only in the API, and still an argument on a command line: on Linux any local user
       * can read `/proc/<pid>/cmdline` while the program runs. That is what an argument is, and
       * it is why the same facts are also handed to the program in its environment — a script
       * that reads `MS_*` needs no secret on its command line at all.
       */
      secretArgs: {
        type: 'array',
        writeOnly: true,
        maxItems: MAX_SECRET_ARGS,
        items: { type: 'string', maxLength: 2000 },
        default: [],
      },
      timeoutMs: { type: 'integer', minimum: 100, maximum: 300_000, default: 30_000 },
    },
  },
  describe(settings) {
    const path = typeof settings['path'] === 'string' ? settings['path'] : '?';
    const args = Array.isArray(settings['args']) ? settings['args'].length : 0;
    return args === 0 ? `run ${path}` : `run ${path} with ${String(args)} argument(s)`;
  },
};

const METHODS: readonly NotificationMethod[] = [
  EMAIL_METHOD,
  WEBHOOK_METHOD,
  SLACK_METHOD,
  TEAMS_METHOD,
  PROGRAM_METHOD,
];

/** Subschema keywords the redactor cannot follow — the same list `SensorCatalogue` refuses. */
const COMBINATORS = ['oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', 'items'] as const;

// `verbose` puts a failed pattern's schema on its error, which is where its `x-patternMessage` is
// read (`P-372`); it puts the value there too, and `validate` reads only the path, the property
// name and the message.
const ajv = new Ajv({
  allErrors: true,
  // Strict (`P-379`): a mistyped keyword in a method's settings schema refuses it when this
  // module loads, rather than being ignored and constraining nothing.
  strict: true,
  useDefaults: true,
  verbose: true,
  keywords: [patternMessageKeyword()],
});

/**
 * The methods this build knows, the one place a template's settings are checked, and the one
 * place its secrets are removed.
 *
 * Sealed at module load rather than registered at runtime: a method appearing later would mean
 * two halves of the system disagreeing about what a stored template means — and, worse, about
 * which of its fields are secret.
 */
export class MethodRegistry {
  readonly #entries = new Map<
    string,
    { method: NotificationMethod; validate: ValidateFunction; writeOnly: readonly string[] }
  >();

  constructor(methods: readonly NotificationMethod[]) {
    for (const method of methods) {
      if (this.#entries.has(method.id)) throw new Error(`duplicate method ${method.id}`);
      // Collected once, at load. A `writeOnly` the redactor could not reach would be a secret
      // that quietly comes back, so finding one is a startup failure rather than a surprise.
      const writeOnly = collectWriteOnly(method.settingsSchema, method.id);
      checkDestinations(method, writeOnly);
      // A pattern that would be refused in its own expression, as the sensor catalogue refuses
      // one (`U-53`, `P-372`): `validate` and the template form say the sentence instead.
      const unsaid = unsaidPatternProblem(
        method.settingsSchema,
        `method ${method.id}`,
        'its settings',
      );
      if (unsaid !== undefined) throw new Error(unsaid);
      this.#entries.set(method.id, {
        method,
        validate: ajv.compile(method.settingsSchema),
        writeOnly,
      });
    }
  }

  get ids(): string[] {
    return [...this.#entries.keys()];
  }

  all(): NotificationMethod[] {
    return [...this.#entries.values()].map((entry) => entry.method);
  }

  get(id: string): NotificationMethod {
    return this.#entry(id).method;
  }

  /** The dotted paths this method marks secret. Exported for the test that asserts they exist. */
  secretsOf(id: string): readonly string[] {
    return this.#entry(id).writeOnly;
  }

  /**
   * Validates settings against their method, filling in the schema's defaults.
   *
   * Returns a copy: `useDefaults` mutates, and a caller handing in a frozen literal or reusing an
   * object across two templates should not have it quietly grow fields.
   */
  validate(methodId: string, settings: Record<string, unknown>): Record<string, unknown> {
    const { validate } = this.#entry(methodId);
    const copy: Record<string, unknown> = structuredClone(settings);
    if (!validate(copy)) {
      // **Never the value** (`N-19`). The path names the field, and a property name is named
      // when it is the name that failed; a value can be a secret and is never quoted back.
      const problems = (validate.errors ?? [])
        .filter((error) => error.keyword !== 'propertyNames')
        .map((error) => {
          const at = error.instancePath === '' ? 'settings' : error.instancePath;
          const name = error.propertyName === undefined ? '' : ` "${error.propertyName}"`;
          // A pattern's own sentence (`P-372`), read from the schema and never from `data`.
          return `${at}${name} ${patternMessageOf(error) ?? error.message ?? 'is invalid'}`;
        });
      throw new MethodError(
        `this ${methodId} template cannot be saved`,
        { method: methodId },
        problems,
      );
    }
    return copy;
  }

  /**
   * Strips every secret from a method's settings, and says which it removed.
   *
   * The one place. `CLAUDE.md` requires monitored-device credentials to be stripped at a single
   * point so a new endpoint cannot forget; a Slack webhook URL is a credential by the same
   * argument — anybody holding it can post to the channel — and gets the same treatment.
   */
  redact(
    methodId: string,
    settings: Readonly<Record<string, unknown>>,
  ): { settings: Record<string, unknown>; redacted: readonly string[] } {
    const paths = this.#entries.get(methodId)?.writeOnly ?? [];
    const clone = structuredClone(settings) as Record<string, unknown>;
    if (paths.length === 0) return { settings: clone, redacted: [] };

    const redacted: string[] = [];
    for (const path of paths) {
      const segments = path.split('.');
      // Removed always; *reported* only when it held something. `redactedSettings` is what a
      // form renders as "set, not shown", and a schema default of `{}` is not a secret anybody
      // set — saying it was would invite an operator to retype a credential that does not exist.
      const held = readAtPath(clone, segments);
      deleteAtPath(clone, segments);
      if (isConfigured(held)) redacted.push(path);
    }
    return { settings: clone, redacted };
  }

  /**
   * Merges an edit over what is stored, keeping any secret the client did not resend.
   *
   * Without this, every edit would clear the secrets: the client renders a form from a redacted
   * read, the operator changes the subject line, and the PUT comes back with no webhook URL in
   * it. Absent means "unchanged" and an explicit `null` means "clear it" — two different
   * intentions that a merge collapsing them would make one.
   */
  mergeSecrets(
    methodId: string,
    incoming: Record<string, unknown>,
    stored: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    const merged = structuredClone(incoming);
    for (const path of this.#entries.get(methodId)?.writeOnly ?? []) {
      const segments = path.split('.');
      if (hasAtPath(merged, segments)) continue;
      const held = readAtPath(stored, segments);
      // Kept only where it was going (`A-40`): a secret whose destination this edit changes is
      // left behind, and the request has to send it again to keep it.
      if (held !== undefined && this.#stays(methodId, path, incoming, stored)) {
        setAtPath(merged, segments, held);
      }
    }
    return merged;
  }

  /**
   * The secrets `mergeSecrets` leaves behind because the edit moved where they are sent: held
   * before, not sent again, and bound to a destination that changed. For the audit entry and the
   * log, so a template that stopped authenticating after an edit says why.
   */
  secretsLeftBehind(
    methodId: string,
    incoming: Readonly<Record<string, unknown>>,
    stored: Readonly<Record<string, unknown>>,
  ): readonly string[] {
    return (this.#entries.get(methodId)?.writeOnly ?? []).filter((path) => {
      const segments = path.split('.');
      return (
        !hasAtPath(incoming, segments) &&
        isConfigured(readAtPath(stored, segments)) &&
        !this.#stays(methodId, path, incoming, stored)
      );
    });
  }

  /** Whether every field naming where this secret goes is the same in the edit as before. */
  #stays(
    methodId: string,
    path: string,
    incoming: Readonly<Record<string, unknown>>,
    stored: Readonly<Record<string, unknown>>,
  ): boolean {
    const method = this.#entries.get(methodId)?.method;
    const destinations = method?.secretDestinations[path] ?? [];
    return destinations.every((field) =>
      sameDestination(asSaved(method, incoming, field), asSaved(method, stored, field)),
    );
  }

  #entry(id: string): {
    method: NotificationMethod;
    validate: ValidateFunction;
    writeOnly: readonly string[];
  } {
    const entry = this.#entries.get(id);
    if (entry === undefined) {
      throw new MethodError(`no delivery method "${id}"`, { method: id }, [
        `known methods: ${this.ids.join(', ')}`,
      ]);
    }
    return entry;
  }
}

/** Every `writeOnly` path in a schema, refusing any the redactor could not reliably reach. */
function collectWriteOnly(schema: Record<string, unknown>, methodId: string): readonly string[] {
  const found: string[] = [];
  walk(schema, '', false);
  return found;

  function walk(node: unknown, path: string, insideCombinator: boolean): void {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;

    if (record['writeOnly'] === true) {
      if (insideCombinator) {
        throw new Error(
          `method "${methodId}" marks "${path}" writeOnly inside a schema combinator, where it ` +
            'cannot be reliably redacted — hoist it to a plain property',
        );
      }
      found.push(path);
      // A writeOnly object is removed whole; there is nothing below it left to find.
      return;
    }

    const properties = record['properties'];
    if (typeof properties === 'object' && properties !== null) {
      for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
        walk(child, path === '' ? key : `${path}.${key}`, insideCombinator);
      }
    }

    for (const keyword of COMBINATORS) {
      const branch = record[keyword];
      if (branch === undefined) continue;
      for (const child of Array.isArray(branch) ? branch : [branch]) {
        walk(child, path, true);
      }
    }
  }
}

/**
 * Refuses a method whose secrets do not each say where they are sent (`A-40`), or that names a
 * destination which is not one of its settings — or is itself a secret, which would never be in
 * the edit to compare.
 */
function checkDestinations(method: NotificationMethod, writeOnly: readonly string[]): void {
  const declared = Object.keys(method.secretDestinations).sort();
  const secrets = [...writeOnly].sort();
  if (declared.join('\n') !== secrets.join('\n')) {
    throw new Error(
      `method "${method.id}" must say where each of its secrets is sent: secretDestinations ` +
        `names [${declared.join(', ')}] and the schema's writeOnly fields are ` +
        `[${secrets.join(', ')}]`,
    );
  }
  const properties = (method.settingsSchema['properties'] ?? {}) as Record<string, unknown>;
  for (const [secret, fields] of Object.entries(method.secretDestinations)) {
    for (const field of fields) {
      if (!(field in properties) || writeOnly.includes(field)) {
        throw new Error(
          `method "${method.id}" sends "${secret}" to "${field}", which is not a visible setting`,
        );
      }
    }
  }
}

/**
 * A destination field as the template will be saved with it: absent reads as the schema's default.
 *
 * The merge runs before validation fills the defaults in, and a whole-document edit that leaves
 * out a field with a default means the default. Read raw, a program template saved with no
 * arguments stores `args: []`, and an edit that did not mention them would read as a new command
 * line and clear the secret it never touched (`A-48`).
 */
function asSaved(
  method: NotificationMethod | undefined,
  settings: Readonly<Record<string, unknown>>,
  field: string,
): unknown {
  const value = readAtPath(settings, field.split('.'));
  if (value !== undefined) return value;
  const properties = (method?.settingsSchema['properties'] ?? {}) as Record<string, unknown>;
  const declared = properties[field];
  return typeof declared === 'object' && declared !== null
    ? (declared as Record<string, unknown>)['default']
    : undefined;
}

/**
 * Whether two values of a destination field name the same place. A URL is compared as the URL it
 * parses to, so `HTTPS://Hooks.example.com/x` is not a new destination; anything else, and any
 * text that is not a URL, must be identical.
 */
function sameDestination(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    if (a === b) return true;
    try {
      return new URL(a).href === new URL(b).href;
    } catch {
      return false;
    }
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether a secret slot actually holds one. Absent, null, empty text or an empty bag do not. */
function isConfigured(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function deleteAtPath(target: Record<string, unknown>, segments: readonly string[]): boolean {
  const [head, ...rest] = segments;
  if (head === undefined) return false;
  if (rest.length === 0) {
    if (!Object.hasOwn(target, head)) return false;
    Reflect.deleteProperty(target, head);
    return true;
  }
  const child = target[head];
  if (typeof child !== 'object' || child === null || Array.isArray(child)) return false;
  return deleteAtPath(child as Record<string, unknown>, rest);
}

function hasAtPath(
  target: Readonly<Record<string, unknown>>,
  segments: readonly string[],
): boolean {
  return readAtPath(target, segments) !== undefined;
}

function readAtPath(
  target: Readonly<Record<string, unknown>>,
  segments: readonly string[],
): unknown {
  let cursor: unknown = target;
  for (const segment of segments) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function setAtPath(
  target: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): void {
  const [head, ...rest] = segments;
  if (head === undefined) return;
  if (rest.length === 0) {
    target[head] = value;
    return;
  }
  const child = target[head];
  const next =
    typeof child === 'object' && child !== null && !Array.isArray(child)
      ? (child as Record<string, unknown>)
      : {};
  target[head] = next;
  setAtPath(next, rest, value);
}

export const notificationMethods = new MethodRegistry(METHODS);
