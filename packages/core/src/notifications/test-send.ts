import { describeError, type Logger } from '@ms/shared';
import type { Database } from '../db/pool.js';
import type { Actor, AuditSink } from '../objects/audit.js';
import { ObjectError } from '../objects/errors.js';
import type { ObjectId } from '../objects/types.js';
import { TemplateActivation } from './activation.js';
import type { MessageContextLoader } from './context.js';
import type { DeliveryTransport } from './delivery/transport.js';
import { notificationMethods } from './methods.js';
import { render, type MessageContext } from './placeholders.js';
import { summarises } from './summarisation.js';
import { TemplateRepository, type Recipient, type StoredTemplate } from './templates.js';

export interface NotificationTesterOptions {
  db: Database;
  contexts: MessageContextLoader;
  transports: readonly DeliveryTransport[];
  audit: AuditSink;
  logger: Logger;
  repository?: TemplateRepository;
  publicUrl?: string;
  siteName?: string;
}

/** What a test send did, in enough detail to fix whatever went wrong. */
export interface TestSendReport {
  readonly templateId: number;
  readonly templateName: string;
  readonly method: string;
  readonly methodName: string;
  /** Null when the message was rendered against the example sensor rather than a real one. */
  readonly sensorId: ObjectId | null;
  readonly sensorName: string;
  readonly subject: string;
  readonly body: string;
  readonly recipients: readonly Recipient[];
  /** Placeholder names this build does not know. Empty for anything it accepted on the way in. */
  readonly unknownPlaceholders: readonly string[];
  readonly delivered: boolean;
  /** What the transport said on success — the relay, the status code, the exit code. */
  readonly detail: string | null;
  readonly error: string | null;
  /** Whether a real notification would have been tried again. Null when it succeeded. */
  readonly retryable: boolean | null;
  readonly durationMs: number;
  /**
   * What would have been different for a real notification.
   *
   * The half of the report that makes it worth having: a test that succeeds while the template
   * is switched off, or outside its activation schedule, or set to summarise everything, has
   * proved the relay works and proved nothing about whether an alarm would arrive.
   */
  readonly notes: readonly string[];
}

export interface TestSendRequest {
  readonly templateId: number;
  /** Render against this sensor. Absent uses an example one, so a relay can be tested first. */
  readonly sensorId?: ObjectId;
}

/**
 * "Send test notification" (`CAPABILITIES.MD §5.2`, `WORKFLOW.MD §6`).
 *
 * **The point is that it is the real thing.** The same rendering, the same transport, the same
 * settings and the same recipients — a test that stubbed any of them would prove the stub works.
 * So this genuinely sends: an operator testing an on-call template at three in the morning has
 * paged whoever is on call, which is why it is audited.
 *
 * **What it deliberately skips is the queue.** No `notification_request` row, so nothing is
 * retried, nothing is folded into a digest and nothing is suppressed by an activation schedule.
 * Those three would each turn "did my relay work" into "wait fifteen minutes and find out", which
 * is the opposite of what somebody clicking Test wants. They are *reported* instead: the notes
 * say what a real notification would have run into, so a green test on a template that is
 * switched off cannot be mistaken for a working alarm.
 */
export class NotificationTester {
  readonly #db: Database;
  readonly #contexts: MessageContextLoader;
  readonly #transports = new Map<string, DeliveryTransport>();
  readonly #audit: AuditSink;
  readonly #logger: Logger;
  readonly #repo: TemplateRepository;
  readonly #activation = new TemplateActivation();
  readonly #publicUrl: string;
  readonly #siteName: string;

  constructor(options: NotificationTesterOptions) {
    this.#db = options.db;
    this.#contexts = options.contexts;
    for (const transport of options.transports) this.#transports.set(transport.method, transport);
    this.#audit = options.audit;
    this.#logger = options.logger.child({ component: 'templates' });
    this.#repo = options.repository ?? new TemplateRepository();
    this.#publicUrl = options.publicUrl ?? '';
    this.#siteName = options.siteName ?? 'MonitoringSystem';
  }

  async send(actor: Actor, request: TestSendRequest, now = new Date()): Promise<TestSendReport> {
    const template = await this.#repo.get(this.#db, request.templateId);
    if (template === null) {
      throw new ObjectError('OBJECT_NOT_FOUND', `no template ${String(request.templateId)}`, {
        context: { templateId: request.templateId, phase: 'templates' },
      });
    }

    const context = await this.#contextFor(request.sensorId, now);
    const transport = this.#transports.get(template.method);
    const escaping = transport?.bodyEscaping?.(template.settings) ?? 'none';
    const rendered = render(template, context, escaping);
    const notes = await this.#notesFor(template, request.sensorId, now);

    const started = process.hrtime.bigint();
    const result =
      transport === undefined
        ? ({
            ok: false,
            retryable: false,
            error: `this build has no transport for delivery method "${template.method}"`,
          } as const)
        : await this.#attempt(transport, {
            // Not a queued request, so there is no id. Zero is what the loader and the log use
            // for "this is not an obligation", and it keeps the header honest rather than
            // naming a row that does not exist.
            requestId: 0,
            sensorId: context.sensorId,
            subject: rendered.subject,
            body: rendered.body,
            recipients: template.recipients,
            priority: template.priority,
            settings: template.settings,
            context,
          });
    const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);

    const report: TestSendReport = {
      templateId: template.id,
      templateName: template.name,
      method: template.method,
      methodName: notificationMethods.get(template.method).name,
      sensorId: request.sensorId ?? null,
      sensorName: context.sensorName,
      subject: rendered.subject,
      body: rendered.body,
      recipients: template.recipients,
      unknownPlaceholders: rendered.unknown,
      delivered: result.ok,
      detail: result.ok ? result.detail : null,
      error: result.ok ? null : result.error,
      retryable: result.ok ? null : result.retryable,
      durationMs,
      notes,
    };

    await this.#db.tx((q) =>
      this.#audit.record(
        q,
        actor,
        [
          {
            action: 'template.tested',
            objectId: null,
            templateId: template.id,
            name: template.name,
            method: template.method,
            delivered: result.ok,
          },
        ],
        now,
      ),
    );
    this.#logger[result.ok ? 'info' : 'warn'](
      { templateId: template.id, delivered: result.ok, durationMs },
      'test notification sent',
    );
    return report;
  }

  /** One send, with anything the transport throws turned into a report rather than a 500. */
  async #attempt(
    transport: DeliveryTransport,
    message: Parameters<DeliveryTransport['send']>[0],
  ): Promise<Awaited<ReturnType<DeliveryTransport['send']>>> {
    try {
      return await transport.send(message);
    } catch (error: unknown) {
      return { ok: false, retryable: true, error: describeError(error).message };
    }
  }

  /**
   * The facts to render against.
   *
   * A real sensor when one is named, and an invented one when none is — which is not a
   * convenience: the first thing an operator does with a new installation is check that the SMTP
   * relay works, and at that point there may be no sensors at all.
   */
  async #contextFor(sensorId: ObjectId | undefined, now: Date): Promise<MessageContext> {
    if (sensorId === undefined) return this.#exampleContext(now);

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
    return context;
  }

  #exampleContext(now: Date): MessageContext {
    return {
      sensorId: 0,
      sensorName: 'Example sensor',
      deviceName: 'example-device',
      groupName: 'Example group',
      probeName: 'Local probe',
      host: '192.0.2.1',
      location: '',
      comments: '',
      tags: ['example'],
      priority: 3,
      state: 'down',
      previousState: 'up',
      message: 'This is a test notification. Nothing is actually wrong.',
      lastValue: null,
      at: now,
      since: new Date(now.getTime() - 5 * 60_000),
      publicUrl: this.#publicUrl,
      siteName: this.#siteName,
    };
  }

  /** Everything that would have been different if this had been a real alarm. */
  async #notesFor(
    template: StoredTemplate,
    sensorId: ObjectId | undefined,
    now: Date,
  ): Promise<string[]> {
    const notes: string[] = [];
    if (sensorId === undefined) {
      notes.push('Rendered against an example sensor, because none was named.');
    }
    if (!template.enabled) {
      notes.push('This template is switched off. A real notification would not have been sent.');
    }

    const method = notificationMethods.get(template.method);
    if (method.summarisable && summarises(template.summarisation)) {
      notes.push(
        `A real notification could be folded into a digest: this template summarises ` +
          `("${template.summarisation}") over ${String(
            Math.round(template.summaryWindowSeconds / 60),
          )} minutes.`,
      );
    }

    if (template.scheduleId !== null) {
      const suppressed = await this.#activation.suppressed(this.#db, now);
      const mine = [...suppressed.queued, ...suppressed.discarded].find(
        (one) => one.templateId === template.id,
      );
      if (mine !== undefined) {
        const fate =
          mine.whenInactive === 'discard'
            ? 'thrown away'
            : 'held until the schedule reopens' +
              (mine.activeAt === null ? '' : ` at ${mine.activeAt.toISOString()}`);
        notes.push(
          `This template is outside its "${mine.scheduleName}" schedule right now. ` +
            `A real notification would be ${fate}.`,
        );
      }
    }
    return notes;
  }
}
