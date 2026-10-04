import type { Logger } from '@ms/shared';
import { recipientId } from './recipients.js';
import type { Database, Queryable } from '../db/pool.js';
import { MAX_WALK_DEPTH } from '../db/walk.js';
import { Visibility } from '../auth/access.js';
import { AuthError } from '../auth/errors.js';
import type { Actor, AuditSink } from '../objects/audit.js';
import { ObjectError } from '../objects/errors.js';
import type { ObjectId } from '../objects/types.js';
import { triggerKinds } from '../triggers/definition.js';
import { isWhenInactive, type WhenInactive } from './activation.js';
import type { MessageContextLoader } from './context.js';
import { MethodError, notificationMethods } from './methods.js';
import {
  placeholderNames,
  render,
  unknownPlaceholdersIn,
  unknownPlaceholdersInSettings,
  type MessageContext,
} from './placeholders.js';
import {
  DEFAULT_SUMMARISATION,
  isSummarisationMode,
  SUMMARISATION_MODES,
  type SummarisationMode,
} from './summarisation.js';

/** The migration's own default, repeated here so a create with no mode agrees with the column. */
const DEFAULT_WINDOW_SECONDS = 900;

/** What a preview says in place of a container its reader cannot see (`A-12`). */
const HIDDEN_NAME = '(outside your view)';

/**
 * The facts about one sensor as a reader may be shown them: **the containers the reader cannot
 * see left unnamed** (`A-12`), and a hidden device's address with its name (`A-49`).
 *
 * `%probe` is the probe above a customer's branch, and `%device` over a sensor re-granted inside
 * a hole is a device they were refused. A real notification goes to whoever the template names and
 * says it all; a preview, and the echo of a test send (`A-16`), go to whoever asked. The sensor
 * itself is the reader's: every route that renders against one holds them to `read` on it.
 */
export async function contextSeenBy(
  q: Queryable,
  context: MessageContext,
  visibility: Visibility,
): Promise<MessageContext> {
  if (visibility.everything) return context;

  // The nearest of each kind, as the loader picks them, and which of those the reader cannot see.
  const values: unknown[] = [context.sensorId];
  const visible = visibility.where('nearest.id', (value) => `$${String(values.push(value))}`);
  const hidden = await q.query<{ kind: string }>(
    `WITH RECURSIVE chain AS (
       SELECT o.id, o.parent_id, o.kind, 0 AS depth FROM object o WHERE o.id = $1
       UNION ALL
       SELECT p.id, p.parent_id, p.kind, chain.depth + 1
       FROM object p JOIN chain ON p.id = chain.parent_id
       WHERE chain.depth < ${String(MAX_WALK_DEPTH)}
     )
     SELECT nearest.kind::text AS kind
     FROM (
       SELECT DISTINCT ON (kind) id, kind FROM chain
       WHERE kind IN ('device', 'group', 'probe')
       ORDER BY kind, depth
     ) AS nearest
     WHERE NOT (${visible})`,
    values,
  );
  const outside = new Set(hidden.map((row) => row.kind));
  return {
    ...context,
    deviceName: outside.has('device') ? HIDDEN_NAME : context.deviceName,
    // The device's own fact, as its name is (`A-49`): `%host` over a sensor re-granted inside a
    // hole is the address of a device the reader was refused.
    host: outside.has('device') ? HIDDEN_NAME : context.host,
    groupName: outside.has('group') ? HIDDEN_NAME : context.groupName,
    probeName: outside.has('probe') ? HIDDEN_NAME : context.probeName,
  };
}

/** Who a message goes to. Only `address` resolves until `A-01` and `A-02` exist. */
export interface Recipient {
  readonly kind: 'address' | 'user' | 'userGroup';
  readonly value: string;
}

/** Who is writing a template, where that changes what they may write (`A-44`). */
export interface TemplateWriter {
  /**
   * Whether this caller may name an account or a group as a recipient: an administrator, who may
   * list both (`M-20`). Anybody else keeps or removes the ones a template has, and adds none.
   */
  readonly namesAccounts: boolean;
}

/** A writer who may add no account and no group: the default, so a caller that forgets is refused. */
export const NAMES_NOBODY: TemplateWriter = { namesAccounts: false };

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
  /** How eagerly this template sends during a storm (`N-11`). */
  readonly summarisation: SummarisationMode;
  /** How long a collection window stays open, in seconds. */
  readonly summaryWindowSeconds: number;
  /** The `M-09` schedule this template is active during, or null for always (`N-12`). */
  readonly scheduleId: number | null;
  /** Joined for the read, never written: the schedule's own name lives on the schedule. */
  readonly scheduleName: string | null;
  readonly whenInactive: WhenInactive;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A template as it is written: everything the row owns, and nothing it merely joins. */
export type TemplateWrite = Omit<StoredTemplate, 'id' | 'scheduleName' | 'createdAt' | 'updatedAt'>;

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
  readonly summarisation?: string;
  readonly summaryWindowSeconds?: number;
  /** `null` clears the schedule, which means "always active". */
  readonly scheduleId?: number | null;
  readonly whenInactive?: string;
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
  /**
   * The mode as stored, which for a method that is never summarised is always
   * `always-immediate` — it is forced on write rather than accepted and ignored, so what a form
   * shows and what the dispatcher does cannot disagree.
   */
  readonly summarisation: SummarisationMode;
  readonly summaryWindowSeconds: number;
  readonly scheduleId: number | null;
  readonly scheduleName: string | null;
  readonly whenInactive: WhenInactive;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a template would say about one sensor right now (`N-06`). */
export interface RenderedPreview {
  /** `null` for a draft that has never been saved (`U-10`). */
  readonly templateId: number | null;
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
  summarisation: string;
  summary_window_seconds: number;
  schedule_id: string | null;
  schedule_name: string | null;
  when_inactive: string;
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
    summarisation: isSummarisationMode(row.summarisation)
      ? row.summarisation
      : DEFAULT_SUMMARISATION,
    summaryWindowSeconds: row.summary_window_seconds,
    scheduleId: row.schedule_id === null ? null : Number(row.schedule_id),
    scheduleName: row.schedule_name,
    whenInactive: isWhenInactive(row.when_inactive) ? row.when_inactive : 'queue',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = `
  t.id::text AS id, t.name, t.description, t.method, t.settings, t.subject, t.body,
  t.recipients, t.priority, t.enabled, t.summarisation, t.summary_window_seconds,
  t.schedule_id::text AS schedule_id, t.when_inactive,
  (SELECT name FROM schedule WHERE id = t.schedule_id) AS schedule_name,
  t.created_at, t.updated_at
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

  async create(q: Queryable, write: TemplateWrite): Promise<number> {
    const rows = await q.query<{ id: string }>(
      `INSERT INTO notification_template
         (name, description, method, settings, subject, body, recipients, priority, enabled,
          summarisation, summary_window_seconds, schedule_id, when_inactive)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13)
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
        write.summarisation,
        write.summaryWindowSeconds,
        write.scheduleId,
        write.whenInactive,
      ],
    );
    return Number(rows[0]?.id ?? 0);
  }

  async update(q: Queryable, id: number, write: TemplateWrite): Promise<void> {
    await q.query(
      `UPDATE notification_template
       SET name = $2, description = $3, method = $4, settings = $5::jsonb, subject = $6,
           body = $7, recipients = $8::jsonb, priority = $9, enabled = $10,
           summarisation = $11, summary_window_seconds = $12, schedule_id = $13,
           when_inactive = $14
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
        write.summarisation,
        write.summaryWindowSeconds,
        write.scheduleId,
        write.whenInactive,
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
  async usedBy(q: Queryable, templateId: number, visibility: Visibility): Promise<TemplateUse[]> {
    const values: unknown[] = [];
    // A trigger names the object it is defined on, so one on an object the reader cannot see is
    // absent from the reader's answer (`A-12`).
    const visible = visibility.where('t.object_id', (value) => `$${String(values.push(value))}`);
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
       WHERE ${visible}
       ORDER BY t.id`,
      values,
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

  /**
   * Which triggers name this template (`CAPABILITIES.MD §5.2`), among those on objects the
   * reader can see (`A-12`).
   */
  async usedBy(id: number, visibility: Visibility): Promise<TemplateUse[]> {
    await this.get(id);
    return this.#repo.usedBy(this.#db, id, visibility);
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
  async preview(id: number, sensorId: ObjectId, visibility: Visibility): Promise<RenderedPreview> {
    const stored = await this.#repo.get(this.#db, id);
    if (stored === null) throw notFound(id);
    const context = await this.#contextFor(sensorId, id, visibility);
    return { templateId: id, sensorId, ...render(stored, context) };
  }

  /**
   * What an *unsaved* draft would say (`U-10`).
   *
   * The editor's preview has to answer for the text in the box, not the text on disk — an
   * operator fixing a subject line wants to see the fix, and a preview that only ever showed the
   * last saved version would be answering a question nobody asked. The alternative was
   * substituting in the browser, which would put a second implementation of `N-06`'s placeholder
   * and escaping rules somewhere it could drift from this one.
   *
   * Reads nothing but the sensor and writes nothing at all. The input still goes through the
   * same `#parse` every write does, so a draft that could not be saved is refused here with the
   * same message rather than previewing something the operator cannot keep.
   */
  async previewDraft(
    input: TemplateInput,
    sensorId: ObjectId,
    visibility: Visibility,
  ): Promise<RenderedPreview> {
    const draft = this.#parse(input, null);
    const context = await this.#contextFor(sensorId, null, visibility);
    return { templateId: null, sensorId, ...render(draft, context) };
  }

  /**
   * The facts a message is rendered against: one sensor, as it stands right now.
   *
   * **With the containers the reader cannot see left unnamed** (`A-12`), and a hidden device's
   * address with its name (`A-49`). `%probe` is the probe above a customer's branch, and
   * `%device` over a sensor re-granted inside a hole is a device they were refused; a real
   * notification goes to whoever the template names and says it all, but a preview goes to
   * whoever asked.
   */
  async #contextFor(
    sensorId: ObjectId,
    templateId: number | null,
    visibility: Visibility,
  ): Promise<MessageContext> {
    if (this.#contexts === undefined) {
      throw new ObjectError('OBJECT_INVALID', 'this build cannot preview a template', {
        context: { templateId: templateId ?? 0, phase: 'templates' },
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
    if (context === undefined) {
      throw new ObjectError('OBJECT_NOT_FOUND', `no sensor ${String(sensorId)}`, {
        context: { objectId: sensorId, phase: 'templates' },
      });
    }
    return contextSeenBy(this.#db, context, visibility);
  }

  async create(
    actor: Actor,
    input: TemplateInput,
    writer: TemplateWriter = NAMES_NOBODY,
  ): Promise<TemplateView> {
    const write = this.#parse(input, null);
    refuseNewAccounts(write.recipients, [], writer);
    const now = new Date();
    return this.#db.tx(async (q) => {
      await this.#requireSchedule(q, write.scheduleId);
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
   *
   * **Kept only while it goes where it went** (`A-40`). An edit that changes the webhook's URL, or
   * the program's path or any of its visible arguments (`A-48`), clears the secrets bound to it
   * unless it sends them again, so editing a template is not a way to send somebody else's token
   * to a host of one's own. A field left out counts as its default, as the save will store it.
   */
  async update(
    actor: Actor,
    id: number,
    input: TemplateInput,
    writer: TemplateWriter = NAMES_NOBODY,
  ): Promise<TemplateView> {
    const now = new Date();
    return this.#db.tx(async (q) => {
      const before = await this.#repo.get(q, id);
      if (before === null) throw notFound(id);

      const write = this.#parse(input, before);
      refuseNewAccounts(write.recipients, before.recipients, writer);
      // What this edit left behind by moving where it was sent (`A-40`). Named in the audit
      // entry and the log — the paths, never the values — so a webhook that stops authenticating
      // after somebody changed its URL says why, and who.
      const secretsCleared =
        before.method === write.method
          ? notificationMethods.secretsLeftBehind(write.method, input.settings, before.settings)
          : [];
      await this.#requireSchedule(q, write.scheduleId);
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
            ...(secretsCleared.length === 0 ? {} : { secretsCleared }),
          },
        ],
        now,
      );
      if (secretsCleared.length > 0) {
        this.#logger.info(
          { templateId: id, secretsCleared },
          'template edit moved where its secrets were sent, and cleared them',
        );
      }
      return this.#loaded(q, id);
    });
  }

  /**
   * Removes a template, unless a trigger still names it.
   *
   * Refused rather than cascaded, and refused with the list: deleting a template out from under
   * a trigger would leave the trigger firing into nothing, which is the silent failure this
   * whole subsystem exists to prevent. The operator is told which triggers to fix.
   *
   * **Which triggers, among those `visibility` shows** (`A-16`). Every use refuses the delete,
   * whoever asks, but a trigger on an object outside the caller's branch is not listed, and
   * not counted: `outsideView` says that there are some, and never how many, since a number
   * would say how busy a branch the caller was not given is. An administrator is told them all.
   */
  async delete(actor: Actor, id: number, visibility: Visibility): Promise<void> {
    const now = new Date();
    await this.#db.tx(async (q) => {
      const before = await this.#repo.get(q, id);
      if (before === null) throw notFound(id);

      // Every use, whoever is asking: a template still in use must not be deleted from under a
      // trigger the caller happens not to be able to see.
      const uses = await this.#repo.usedBy(q, id, Visibility.EVERYTHING);
      if (uses.length > 0) {
        const seen = visibility.everything ? uses : await this.#repo.usedBy(q, id, visibility);
        const outsideView = seen.length < uses.length;
        throw new ObjectError(
          'OBJECT_NOT_DELETABLE',
          `"${before.name}" is still used by ` +
            (!outsideView
              ? `${String(seen.length)} trigger(s)`
              : seen.length === 0
                ? 'triggers outside your view'
                : `${String(seen.length)} trigger(s) you can see, and by others outside your view`),
          {
            context: { templateId: id, phase: 'templates' },
            details: {
              usedBy: seen.map((use) => ({
                triggerId: use.triggerId,
                objectId: use.objectId,
                objectName: use.objectName,
                summary: use.summary,
              })),
              outsideView,
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
  #parse(input: TemplateInput, before: StoredTemplate | null): TemplateWrite {
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
      // A person or a group is named by id (`M-19`): a login or a group name can be changed, and
      // a template that followed the old one would page somebody else's account.
      if (recipient.kind !== 'address' && recipientId(recipient.value) === null) {
        throw new MethodError('this template cannot be saved', { method: method.id }, [
          `a ${recipient.kind === 'user' ? 'user' : 'group'} recipient is named by its id, ` +
            `and "${recipient.value}" is not one`,
        ]);
      }
    }

    const subject = input.subject ?? before?.subject ?? '';
    const body = input.body ?? before?.body ?? '';
    // `N-06`: unknown placeholders are reported, never silently blanked. This is the moment
    // somebody is looking at the text and can fix it — a message that quietly loses
    // `%lastvlaue` reads perfectly, says nothing, and nobody finds out until it matters.
    // **And every string in the method's own settings** (`P-121`). A program template's arguments
    // carry placeholders like any other content and were substituted at send time with the result
    // of `substitute` thrown away — so an unknown name was neither refused here nor reported
    // there, and the program was handed the literal text `%lastvlaue` as an argument. Same for a
    // webhook URL and a chat card's fields: anywhere an operator can type a placeholder, this is
    // still the one moment somebody is looking at the text and can fix it.
    const unknown = [
      ...new Set([
        ...unknownPlaceholdersIn(subject),
        ...unknownPlaceholdersIn(body),
        ...unknownPlaceholdersInSettings(settings, method.placeholderFields),
      ]),
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

    const asked = input.summarisation ?? before?.summarisation ?? DEFAULT_SUMMARISATION;
    if (!isSummarisationMode(asked)) {
      throw new MethodError('this template cannot be saved', { method: method.id }, [
        `"${asked}" is not a summarisation mode`,
        `known modes: ${SUMMARISATION_MODES.join(', ')}`,
      ]);
    }
    // `CAPABILITIES.MD §5.2`: Slack, Teams, HTTP action and execute program are never
    // summarised. Forced rather than accepted-and-ignored, so a form cannot show a mode the
    // dispatcher will not honour — the stored value always describes what actually happens.
    const summarisation: SummarisationMode = method.summarisable ? asked : 'always-immediate';

    const whenInactive = input.whenInactive ?? before?.whenInactive ?? 'queue';
    if (!isWhenInactive(whenInactive)) {
      throw new MethodError('this template cannot be saved', { method: method.id }, [
        `"${whenInactive}" is not a choice; use "queue" or "discard"`,
      ]);
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
      summarisation,
      summaryWindowSeconds:
        input.summaryWindowSeconds ?? before?.summaryWindowSeconds ?? DEFAULT_WINDOW_SECONDS,
      // Absent keeps what is stored; an explicit `null` clears it, which is the same
      // absent-versus-null distinction the secret merge draws and for the same reason.
      scheduleId: input.scheduleId === undefined ? (before?.scheduleId ?? null) : input.scheduleId,
      whenInactive,
    };
  }

  /**
   * Refuses a schedule that is not there.
   *
   * The column has a foreign key, so the database would refuse it anyway — with a constraint
   * name. This is the same refusal in words an operator can act on, which is the difference
   * between "fix the schedule id" and "ask a developer what 23503 means".
   */
  async #requireSchedule(q: Queryable, scheduleId: number | null): Promise<void> {
    if (scheduleId === null) return;
    const rows = await q.query<{ id: string }>(
      'SELECT id::text AS id FROM schedule WHERE id = $1',
      [scheduleId],
    );
    if (rows.length === 0) {
      throw new ObjectError('OBJECT_NOT_FOUND', `no schedule ${String(scheduleId)}`, {
        context: { scheduleId, phase: 'templates' },
      });
    }
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
      summarisation: stored.summarisation,
      summaryWindowSeconds: stored.summaryWindowSeconds,
      scheduleId: stored.scheduleId,
      scheduleName: stored.scheduleName,
      whenInactive: stored.whenInactive,
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

/**
 * Refuses an account or a group recipient this writer added (`A-44`).
 *
 * **`M-20` was the web editor's rule, and only the web editor's.** It offers users and groups to
 * an administrator alone, because the list of logins is a list of what to try passwords against;
 * the API took any id from any writer. A writer could save a template naming ids 1 to 200 and send
 * a test, and the report named every one that was skipped — which ids are accounts, their logins,
 * the groups and who is in them. Now the server holds the rule: a row already on the template may
 * stay or go, because the writer did not choose it and removing it discloses nothing, and a row it
 * did not have is refused.
 */
function refuseNewAccounts(
  recipients: readonly Recipient[],
  had: readonly Recipient[],
  writer: TemplateWriter,
): void {
  if (writer.namesAccounts) return;
  const kept = new Set(had.map(recipientKey));
  const added = recipients.filter(
    (recipient) => recipient.kind !== 'address' && !kept.has(recipientKey(recipient)),
  );
  if (added.length === 0) return;
  throw new AuthError(
    'AUTH_FORBIDDEN',
    'only an administrator may add an account or a group as a recipient; keep or remove the ' +
      'ones this template has, or add an address',
    { added: added.length },
  );
}

function recipientKey(recipient: Recipient): string {
  return `${recipient.kind}\u0000${recipient.value}`;
}

function notFound(id: number): ObjectError {
  return new ObjectError('OBJECT_NOT_FOUND', `no template ${String(id)}`, {
    context: { phase: 'templates' },
    details: { templateId: id },
  });
}
