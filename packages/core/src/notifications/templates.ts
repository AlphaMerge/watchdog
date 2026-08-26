import type { Logger } from '@ms/shared';
import type { Database, Queryable } from '../db/pool.js';
import type { Actor, AuditSink } from '../objects/audit.js';
import { ObjectError } from '../objects/errors.js';
import type { ObjectId } from '../objects/types.js';
import { triggerKinds } from '../triggers/definition.js';
import type { MessageContextLoader } from './context.js';
import { MethodError, notificationMethods } from './methods.js';
import {
  placeholderNames,
  render,
  unknownPlaceholdersIn,
  type MessageContext,
} from './placeholders.js';

/** Who a message goes to. Only `address` resolves until `A-01` and `A-02` exist. */
export interface Recipient {
  readonly kind: 'address' | 'user' | 'userGroup';
  readonly value: string;
}

/** A template as it is stored. `settings` still holds the secrets. */
export interface StoredTemplate {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly method: string;
  readonly settings: Record<string, unknown>;
  readonly subject: string;
  readonly body: string;
  readonly recipients: Recipient[];
  readonly priority: number;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What a client sends. Absent fields on an update keep what is stored. */
export interface TemplateInput {
  readonly name: string;
  readonly description?: string;
  readonly method: string;
  readonly settings: Record<string, unknown>;
  readonly subject?: string;
  readonly body?: string;
  readonly recipients?: readonly Recipient[];
  readonly priority?: number;
  readonly enabled?: boolean;
}

/**
 * A template as the API serves it: **without its secrets**.
 *
 * `redactedSettings` names what was removed rather than leaving a hole, so a form can render
 * "webhook URL: set, not shown" instead of an empty box that looks unconfigured — the same
 * arrangement `ObjectDetail.redactedParams` uses for a sensor's credentials.
 */
export interface TemplateView {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly method: string;
  readonly methodName: string;
  readonly settings: Record<string, unknown>;
  readonly redactedSettings: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly recipients: Recipient[];
  readonly priority: number;
  readonly enabled: boolean;
  readonly summary: string;
  /** Whether `N-11` may ever fold this method's messages into a digest. */
  readonly summarisable: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a template would say about one sensor right now (`N-06`). */
export interface RenderedPreview {
  readonly templateId: number;
  readonly sensorId: ObjectId;
  readonly subject: string;
  readonly body: string;
  /** Placeholder names this build did not know. Empty for anything it accepted on the way in. */
  readonly unknown: readonly string[];
}

/** One trigger that names a template, for `CAPABILITIES.MD §5.2`'s "used by" lookup. */
export interface TemplateUse {
  readonly triggerId: number;
  readonly triggerKind: string;
  readonly objectId: ObjectId;
  readonly objectName: string;
  readonly summary: string;
}

interface TemplateRow {
  id: string;
  name: string;
  description: string;
  method: string;
  settings: Record<string, unknown>;
  subject: string;
  body: string;
  recipients: Recipient[];
  priority: number;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

function toStored(row: TemplateRow): StoredTemplate {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description,
    method: row.method,
    settings: row.settings,
    subject: row.subject,
    body: row.body,
    recipients: row.recipients,
    priority: row.priority,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = `
  t.id::text AS id, t.name, t.description, t.method, t.settings, t.subject, t.body,
  t.recipients, t.priority, t.enabled, t.created_at, t.updated_at
`;

/** Where templates live. */
export class TemplateRepository {
  async get(q: Queryable, id: number): Promise<StoredTemplate | null> {
    const rows = await q.query<TemplateRow>(
      `SELECT ${COLUMNS} FROM notification_template t WHERE t.id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : toStored(row);
  }

  async list(q: Queryable): Promise<StoredTemplate[]> {
    const rows = await q.query<TemplateRow>(
      `SELECT ${COLUMNS} FROM notification_template t ORDER BY t.name`,
    );
    return rows.map(toStored);
  }

  async create(
    q: Queryable,
    write: Omit<StoredTemplate, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<number> {
    const rows = await q.query<{ id: string }>(
      `INSERT INTO notification_template
         (name, description, method, settings, subject, body, recipients, priority, enabled)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, $9)
       RETURNING id::text AS id`,
      [
        write.name,
        write.description,
        write.method,
        JSON.stringify(write.settings),
        write.subject,
        write.body,
        JSON.stringify(write.recipients),
        write.priority,
        write.enabled,
      ],
    );
    return Number(rows[0]?.id ?? 0);
  }

  async update(
    q: Queryable,
    id: number,
    write: Omit<StoredTemplate, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<void> {
    await q.query(
      `UPDATE notification_template
       SET name = $2, description = $3, method = $4, settings = $5::jsonb, subject = $6,
           body = $7, recipients = $8::jsonb, priority = $9, enabled = $10
       WHERE id = $1`,
      [
        id,
        write.name,
        write.description,
        write.method,
        JSON.stringify(write.settings),
        write.subject,
        write.body,
        JSON.stringify(write.recipients),
        write.priority,
        write.enabled,
      ],
    );
  }

  async delete(q: Queryable, id: number): Promise<boolean> {
    const rows = await q.query<{ id: string }>(
      'DELETE FROM notification_template WHERE id = $1 RETURNING id::text AS id',
      [id],
    );
    return rows.length > 0;
  }

  /**
   * Every trigger that names this template, with the object it is defined on.
   *
   * A jsonb scan over `notification_trigger`, because the reference lives inside a document and
   * no index can help — and it does not need to: an installation has tens of triggers, not
   * thousands, and this runs when somebody opens a template or tries to delete one.
   *
   * The *which fields* question is `triggerKinds.templatesIn`'s, not SQL's: each kind declares
   * which of its settings are template references, so a new kind cannot be missed here.
   */
  async usedBy(q: Queryable, templateId: number): Promise<TemplateUse[]> {
    const rows = await q.query<{
      id: string;
      kind: string;
      settings: Record<string, unknown>;
      object_id: string;
      object_name: string;
    }>(
      `SELECT t.id::text AS id, t.kind, t.settings,
              t.object_id::text AS object_id, o.name AS object_name
       FROM notification_trigger t
       JOIN object o ON o.id = t.object_id
       ORDER BY t.id`,
    );

    const uses: TemplateUse[] = [];
    for (const row of rows) {
      let references: number[];
      try {
        references = triggerKinds.templatesIn(row.kind, row.settings);
      } catch {
        // A trigger of a kind this build does not know. It cannot be interpreted, so it cannot
        // be shown to reference anything — and refusing the whole lookup because of one bad row
        // would make an unrelated template undeletable.
        continue;
      }
      if (!references.includes(templateId)) continue;
      uses.push({
        triggerId: Number(row.id),
        triggerKind: row.kind,
        objectId: Number(row.object_id),
        objectName: row.object_name,
        summary: triggerKinds.get(row.kind).describe(row.settings),
      });
    }
    return uses;
  }
}

export interface TemplateServiceOptions {
  db: Database;
  audit: AuditSink;
  logger: Logger;
  repository?: TemplateRepository;
  /**
   * What builds the facts a message is written from (`N-06`).
   *
   * Absent means `preview` is unavailable rather than wrong — a preview rendered against an
   * empty context would show an operator a message that is nothing like the one they will get.
   */
  contexts?: MessageContextLoader;
}

/**
 * Creating, editing and reading notification templates (`N-05`).
 *
 * Nothing here sends anything: `N-06` substitutes the placeholders, `N-07` onwards deliver,
 * `N-11` decides what is folded into a digest. This is the storage, the validation boundary and
 * — the part worth the most care — the one place a secret is removed on the way out.
 */
export class TemplateService {
  readonly #db: Database;
  readonly #repo: TemplateRepository;
  readonly #audit: AuditSink;
  readonly #logger: Logger;
  readonly #contexts: MessageContextLoader | undefined;

  constructor(options: TemplateServiceOptions) {
    this.#db = options.db;
    this.#repo = options.repository ?? new TemplateRepository();
    this.#audit = options.audit;
    this.#logger = options.logger.child({ component: 'templates' });
    this.#contexts = options.contexts;
  }

  async list(): Promise<TemplateView[]> {
    return (await this.#repo.list(this.#db)).map((template) => this.#view(template));
  }

  async get(id: number): Promise<TemplateView> {
    const stored = await this.#repo.get(this.#db, id);
    if (stored === null) throw notFound(id);
    return this.#view(stored);
  }

  /** Which triggers name this template (`CAPABILITIES.MD §5.2`). */
  async usedBy(id: number): Promise<TemplateUse[]> {
    await this.get(id);
    return this.#repo.usedBy(this.#db, id);
  }

  /**
   * What this template would say about one sensor, right now (`N-06`).
   *
   * The reason placeholder substitution is worth building rather than merely specifying: an
   * operator writing `%device / %sensor: %lastmessage` has no way to know whether that reads
   * well until they see it against something real, and finding out from the first genuine
   * outage is finding out too late. Read-only, and rendered against the sensor's actual state
   * rather than an invented one — `N-14`'s send-test uses the same rendering.
   */
  async preview(id: number, sensorId: ObjectId): Promise<RenderedPreview> {
    const stored = await this.#repo.get(this.#db, id);
    if (stored === null) throw notFound(id);
    if (this.#contexts === undefined) {
      throw new ObjectError('OBJECT_INVALID', 'this build cannot preview a template', {
        context: { templateId: id, phase: 'templates' },
      });
    }

    const now = new Date();
    const runtime = await this.#db.query<{ state: string; message: string }>(
      'SELECT state, message FROM sensor_runtime WHERE object_id = $1',
      [sensorId],
    );
    const current = runtime[0];
    if (current === undefined) {
      throw new ObjectError('OBJECT_NOT_FOUND', `no sensor ${String(sensorId)}`, {
        context: { objectId: sensorId, phase: 'templates' },
      });
    }

    const contexts = await this.#contexts.loadFor(
      this.#db,
      [
        {
          // Not a queued notification: nothing is owed, and nothing is written. The id is only
          // a key into the map the loader returns.
          id: 0,
          sensorId,
          at: now,
          state: current.state as MessageContext['state'],
          message: current.message,
          observed: null,
        },
      ],
      now,
    );
    const context = contexts.get(0);
    if (context === undefined) throw notFound(id);

    const rendered = render(stored, context);
    return { templateId: id, sensorId, ...rendered };
  }

  async create(actor: Actor, input: TemplateInput): Promise<TemplateView> {
    const write = this.#parse(input, null);
    const now = new Date();
    return this.#db.tx(async (q) => {
      const id = await this.#repo.create(q, write);
      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'template.created',
            objectId: null,
            templateId: id,
            name: write.name,
            method: write.method,
          },
        ],
        now,
      );
      return this.#loaded(q, id);
    });
  }

  /**
   * Replaces a template.
   *
   * Whole-document, like a schedule and a trigger — with one deliberate exception. A secret the
   * client did not send is **kept**, not cleared: the form was rendered from a redacted read, so
   * a PUT that faithfully echoes what the operator saw carries no webhook URL, and treating that
   * as "remove it" would break the template every time somebody fixed a typo in the subject.
   * Sending an explicit `null` clears it. See `notificationMethods.mergeSecrets`.
   */
  async update(actor: Actor, id: number, input: TemplateInput): Promise<TemplateView> {
    const now = new Date();
    return this.#db.tx(async (q) => {
      const before = await this.#repo.get(q, id);
      if (before === null) throw notFound(id);

      const write = this.#parse(input, before);
      await this.#repo.update(q, id, write);
      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'template.updated',
            objectId: null,
            templateId: id,
            name: write.name,
            method: write.method,
          },
        ],
        now,
      );
      return this.#loaded(q, id);
    });
  }

  /**
   * Removes a template, unless a trigger still names it.
   *
   * Refused rather than cascaded, and refused with the list: deleting a template out from under
   * a trigger would leave the trigger firing into nothing, which is the silent failure this
   * whole subsystem exists to prevent. The operator is told which triggers to fix.
   */
  async delete(actor: Actor, id: number): Promise<void> {
    const now = new Date();
    await this.#db.tx(async (q) => {
      const before = await this.#repo.get(q, id);
      if (before === null) throw notFound(id);

      const uses = await this.#repo.usedBy(q, id);
      if (uses.length > 0) {
        throw new ObjectError(
          'OBJECT_NOT_DELETABLE',
          `"${before.name}" is still used by ${String(uses.length)} trigger(s)`,
          {
            context: { templateId: id, phase: 'templates' },
            details: {
              usedBy: uses.map((use) => ({
                triggerId: use.triggerId,
                objectId: use.objectId,
                objectName: use.objectName,
                summary: use.summary,
              })),
            },
          },
        );
      }

      await this.#repo.delete(q, id);
      await this.#audit.record(
        q,
        actor,
        [
          {
            action: 'template.deleted',
            objectId: null,
            templateId: id,
            name: before.name,
            method: before.method,
          },
        ],
        now,
      );
      this.#logger.info({ templateId: id, name: before.name }, 'template deleted');
    });
  }

  /** Validates the input against its method and fills the schema's defaults in. */
  #parse(
    input: TemplateInput,
    before: StoredTemplate | null,
  ): Omit<StoredTemplate, 'id' | 'createdAt' | 'updatedAt'> {
    const method = notificationMethods.get(input.method);
    // A secret the client did not resend is the one it was never shown. Merge before validating,
    // so a required secret is not reported missing when it is sitting in the row.
    const incoming =
      before === null || before.method !== method.id
        ? input.settings
        : notificationMethods.mergeSecrets(method.id, { ...input.settings }, before.settings);
    const settings = notificationMethods.validate(method.id, incoming);

    const recipients = [...(input.recipients ?? before?.recipients ?? [])];
    if (!method.usesRecipients && recipients.length > 0) {
      throw new MethodError(
        `a ${method.id} template has no recipients to send to`,
        { method: method.id },
        [`${method.name} delivers to what its settings name, not to a recipient list`],
      );
    }
    for (const recipient of recipients) {
      if (recipient.kind === 'address' && !recipient.value.includes('@')) {
        throw new MethodError('this template cannot be saved', { method: method.id }, [
          `"${recipient.value}" is not an address`,
        ]);
      }
    }

    const subject = input.subject ?? before?.subject ?? '';
    const body = input.body ?? before?.body ?? '';
    // `N-06`: unknown placeholders are reported, never silently blanked. This is the moment
    // somebody is looking at the text and can fix it — a message that quietly loses
    // `%lastvlaue` reads perfectly, says nothing, and nobody finds out until it matters.
    const unknown = [
      ...new Set([...unknownPlaceholdersIn(subject), ...unknownPlaceholdersIn(body)]),
    ];
    if (unknown.length > 0) {
      throw new MethodError(
        'this template uses placeholders this build does not know',
        { method: method.id },
        [
          ...unknown.map((name) => `%${name} is not a placeholder`),
          `known placeholders: ${placeholderNames()
            .map((name) => `%${name}`)
            .join(', ')}`,
          'write %% for a literal per cent sign',
        ],
      );
    }

    return {
      name: input.name,
      description: input.description ?? before?.description ?? '',
      method: method.id,
      settings,
      subject,
      body,
      recipients,
      priority: input.priority ?? before?.priority ?? 3,
      enabled: input.enabled ?? before?.enabled ?? true,
    };
  }

  async #loaded(q: Queryable, id: number): Promise<TemplateView> {
    const stored = await this.#repo.get(q, id);
    if (stored === null) throw notFound(id);
    return this.#view(stored);
  }

  /**
   * The **one** place a template's secrets are removed.
   *
   * Every read goes through here, exactly as every object read goes through
   * `ObjectService.#redact`, and for the reason `CLAUDE.md` gives: a new endpoint cannot forget
   * to strip what it never receives.
   */
  #view(stored: StoredTemplate): TemplateView {
    const method = notificationMethods.get(stored.method);
    const { settings, redacted } = notificationMethods.redact(stored.method, stored.settings);
    return {
      id: stored.id,
      name: stored.name,
      description: stored.description,
      method: stored.method,
      methodName: method.name,
      settings,
      redactedSettings: redacted,
      subject: stored.subject,
      body: stored.body,
      recipients: stored.recipients,
      priority: stored.priority,
      enabled: stored.enabled,
      // Built from the *redacted* copy, deliberately. A one-line summary is the likeliest place
      // for a secret to escape by accident — a method whose `describe` reached for a webhook URL
      // would leak it into every list — so the summary is denied the secrets too.
      summary: method.describe(settings),
      summarisable: method.summarisable,
      createdAt: stored.createdAt.toISOString(),
      updatedAt: stored.updatedAt.toISOString(),
    };
  }
}

function notFound(id: number): ObjectError {
  return new ObjectError('OBJECT_NOT_FOUND', `no template ${String(id)}`, {
    context: { phase: 'templates' },
    details: { templateId: id },
  });
}
