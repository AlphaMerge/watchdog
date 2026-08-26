import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, send, useApi } from '../api/client';
import type {
  NotificationMethod,
  ObjectPage,
  PlaceholderInfo,
  ScheduleSummary,
  SummarisationMode,
  TemplateInput,
  TemplatePreview,
  TemplateRecipient,
  TemplateTestResult,
  TemplateView,
} from '../api/types';
import { Card, Empty, ErrorPanel, Loading } from '../components/Panels';
import { SchemaForm } from '../forms/SchemaForm';
import { seedDefaults, type JsonSchema } from '../forms/schema';

/** How long to wait after a keystroke before asking the core what the draft renders as. */
const PREVIEW_DEBOUNCE_MS = 500;

/**
 * Notification templates (`U-10`, `CAPABILITIES.MD §5.2`).
 *
 * **The preview renders the text in the box, not the text on disk.** That needed
 * `POST /templates/preview`, because the saved preview takes an id and an editor is about the
 * edit. Substituting in the browser would have been the other option and would have put a second
 * implementation of `N-06`'s placeholder and escaping rules somewhere it could drift.
 *
 * **A test send really sends**, and says what a green result does not prove: a template that is
 * switched off, outside its activation schedule, or folded into a digest can deliver a test and
 * still never deliver an alarm. `N-14` collects those notes; this shows them.
 */
export function TemplatesView(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const templates = useApi<{ items: TemplateView[] }>('/templates');
  const methods = useApi<{ items: NotificationMethod[] }>('/notification-methods');

  const editing = params.get('id');
  const creating = params.get('new') === '1';

  const open = useCallback(
    (id: number | null) => {
      setParams(id === null ? { new: '1' } : { id: String(id) }, { replace: true });
    },
    [setParams],
  );

  const close = useCallback(() => {
    setParams({}, { replace: true });
  }, [setParams]);

  if (templates.status === 'loading' || methods.status === 'loading') {
    return <Loading what="templates" />;
  }
  if (templates.status === 'error') {
    return <ErrorPanel error={templates.error} retry={templates.reload} />;
  }
  if (methods.status === 'error')
    return <ErrorPanel error={methods.error} retry={methods.reload} />;

  const chosen =
    editing === null ? undefined : templates.data.items.find((t) => String(t.id) === editing);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-text">Notification templates</h1>
        <button
          type="button"
          onClick={() => {
            open(null);
          }}
          className="ml-auto rounded border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          New template
        </button>
      </div>

      {(creating || chosen !== undefined) && (
        <Editor
          key={chosen?.id ?? 'new'}
          template={chosen}
          methods={methods.data.items}
          onSaved={() => {
            templates.reload();
            close();
          }}
          onCancel={close}
        />
      )}

      <Card>
        {templates.data.items.length === 0 ? (
          <Empty because="Without one, a trigger has nothing to send and an alarm reaches nobody.">
            No templates yet.
          </Empty>
        ) : (
          <ul className="divide-y divide-border">
            {templates.data.items.map((template) => (
              <li key={template.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <button
                  type="button"
                  onClick={() => {
                    open(template.id);
                  }}
                  className="text-sm font-medium text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {template.name}
                </button>
                <span className="text-xs text-text-muted">{template.methodName}</span>
                <span className="text-xs text-text-muted">{template.summary}</span>
                {!template.enabled && (
                  <span
                    className="rounded border border-border px-1.5 py-0.5 text-xs text-text-muted"
                    title="Configured, but it will never send"
                  >
                    disabled
                  </span>
                )}
                {template.scheduleName !== null && (
                  <span className="text-xs text-text-muted">
                    only during {template.scheduleName}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Editor({
  template,
  methods,
  onSaved,
  onCancel,
}: {
  template: TemplateView | undefined;
  methods: readonly NotificationMethod[];
  onSaved: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const placeholders = useApi<{ items: PlaceholderInfo[] }>('/notification-placeholders');
  const modes = useApi<{ items: SummarisationMode[] }>('/summarisation-modes');
  const schedules = useApi<{ items: ScheduleSummary[] }>('/schedules');

  const [draft, setDraft] = useState<TemplateInput>(() => initial(template, methods));
  const [replacing, setReplacing] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<ApiError | null>(null);

  const method = methods.find((entry) => entry.id === draft.method);
  const schema = useMemo(() => (method?.settingsSchema ?? {}) as JsonSchema, [method]);

  const onReplace = useCallback((path: string, on: boolean) => {
    setReplacing((held) => {
      const next = new Set(held);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const save = (): void => {
    setSaving(true);
    setFailed(null);
    const write =
      template === undefined
        ? send<TemplateView>('POST', '/templates', draft)
        : send<TemplateView>('PUT', `/templates/${String(template.id)}`, draft);
    write
      .then(onSaved)
      .catch((error: unknown) => {
        setFailed(
          error instanceof ApiError
            ? error
            : new ApiError(0, 'UNKNOWN', error instanceof Error ? error.message : 'failed'),
        );
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <Card title={template === undefined ? 'New template' : `Editing ${template.name}`}>
      <div className="grid gap-6 lg:grid-cols-2">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <TextField
            label="Name"
            value={draft.name}
            onChange={(name) => {
              setDraft({ ...draft, name });
            }}
          />
          <TextField
            label="Description"
            value={draft.description ?? ''}
            onChange={(description) => {
              setDraft({ ...draft, description });
            }}
          />

          <div className="space-y-1">
            <label htmlFor="template-method" className="text-sm font-medium text-text">
              Method
            </label>
            <select
              id="template-method"
              value={draft.method}
              onChange={(event) => {
                // Settings belong to the method. Carrying a Slack webhook URL across to a
                // program's arguments would be nonsense at best and a leak at worst — the core
                // refuses to merge them for the same reason (`N-05`).
                const picked = methods.find((entry) => entry.id === event.target.value);
                setDraft({
                  ...draft,
                  method: event.target.value,
                  settings: seed(picked?.settingsSchema),
                });
                setReplacing(new Set());
              }}
              className="w-full max-w-md rounded border border-border bg-surface px-2 py-1 text-sm text-text"
            >
              {methods.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
            {method !== undefined && (
              <p className="text-xs text-text-muted">{method.description}</p>
            )}
          </div>

          <fieldset className="space-y-4 rounded border border-border px-3 pb-3 pt-1">
            <legend className="px-1 text-xs font-medium uppercase tracking-wide text-text-muted">
              {method?.name ?? 'Method'} settings
            </legend>
            <SchemaForm
              schema={schema}
              values={draft.settings}
              redacted={template?.redactedSettings ?? []}
              onChange={(settings) => {
                setDraft({ ...draft, settings });
              }}
              replacing={replacing}
              onReplace={onReplace}
              disabled={saving}
            />
          </fieldset>

          <TextField
            label="Subject"
            value={draft.subject ?? ''}
            onChange={(subject) => {
              setDraft({ ...draft, subject });
            }}
          />
          <TextArea
            label="Body"
            value={draft.body ?? ''}
            onChange={(body) => {
              setDraft({ ...draft, body });
            }}
          />

          {placeholders.status === 'ready' && <Placeholders items={placeholders.data.items} />}

          {method?.usesRecipients === true && (
            <Recipients
              items={draft.recipients ?? []}
              onChange={(recipients) => {
                setDraft({ ...draft, recipients });
              }}
            />
          )}

          <div className="flex flex-wrap items-end gap-4">
            <NumberField
              label="Priority"
              value={draft.priority ?? 3}
              min={1}
              max={5}
              onChange={(priority) => {
                setDraft({ ...draft, priority });
              }}
            />
            <label className="flex items-center gap-1.5 text-sm text-text-muted">
              <input
                type="checkbox"
                checked={draft.enabled ?? true}
                onChange={(event) => {
                  setDraft({ ...draft, enabled: event.target.checked });
                }}
              />
              Enabled
            </label>
          </div>

          {method?.summarisable === true && modes.status === 'ready' && (
            <div className="space-y-1">
              <label htmlFor="template-summarisation" className="text-sm font-medium text-text">
                Summarisation
              </label>
              <select
                id="template-summarisation"
                value={draft.summarisation ?? 'first-down-and-up'}
                onChange={(event) => {
                  setDraft({ ...draft, summarisation: event.target.value });
                }}
                className="w-full max-w-md rounded border border-border bg-surface px-2 py-1 text-sm text-text"
              >
                {modes.data.items.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.id}
                  </option>
                ))}
              </select>
              <p className="text-xs text-text-muted">
                {modes.data.items.find((mode) => mode.id === (draft.summarisation ?? ''))
                  ?.description ??
                  'One outage, one alarm — how much of a storm is folded together.'}
              </p>
            </div>
          )}

          {schedules.status === 'ready' && (
            <div className="space-y-1">
              <label htmlFor="template-schedule" className="text-sm font-medium text-text">
                Active only during
              </label>
              <select
                id="template-schedule"
                value={
                  draft.scheduleId === null || draft.scheduleId === undefined
                    ? ''
                    : String(draft.scheduleId)
                }
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    scheduleId: event.target.value === '' ? null : Number(event.target.value),
                  });
                }}
                className="w-full max-w-md rounded border border-border bg-surface px-2 py-1 text-sm text-text"
              >
                <option value="">always</option>
                {schedules.data.items.map((schedule) => (
                  <option key={schedule.id} value={schedule.id}>
                    {schedule.name}
                  </option>
                ))}
              </select>
              {draft.scheduleId !== null && draft.scheduleId !== undefined && (
                <div className="space-y-1">
                  <span className="text-xs text-text-muted">Outside it, a notification is</span>
                  <select
                    aria-label="What happens outside the schedule"
                    value={draft.whenInactive ?? 'queue'}
                    onChange={(event) => {
                      setDraft({ ...draft, whenInactive: event.target.value });
                    }}
                    className="ml-2 rounded border border-border bg-surface px-2 py-1 text-sm text-text"
                  >
                    <option value="queue">queued until the window opens</option>
                    <option value="discard">discarded</option>
                  </select>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <button
              type="submit"
              disabled={saving || draft.name.trim() === ''}
              className="rounded border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {saving ? 'Saving…' : template === undefined ? 'Create template' : 'Save template'}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={onCancel}
              className="rounded border border-border px-3 py-1 text-sm text-text-muted hover:text-text disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Cancel
            </button>
            {template !== undefined && <Delete template={template} onDeleted={onSaved} />}
          </div>

          {failed !== null && <Failure error={failed} />}
        </form>

        <div className="space-y-4">
          <Preview draft={draft} />
          {template !== undefined && <TestSend template={template} />}
        </div>
      </div>
    </Card>
  );
}

export function initial(
  template: TemplateView | undefined,
  methods: readonly NotificationMethod[],
): TemplateInput {
  if (template === undefined) {
    const first = methods[0];
    return {
      name: '',
      method: first?.id ?? 'email',
      // Seeded from the method's own defaults, which the core applies and stores anyway — the
      // same rule the sensor-parameter form follows when adding rather than editing (`U-08`).
      settings: seed(first?.settingsSchema),
      subject: '%sitename: %sensor on %device is %status',
      body: '%lastmessage\n\n%linksensor',
      recipients: [],
      priority: 3,
      enabled: true,
    };
  }
  // Rebuilt from the read, which carries no secrets — and must not. A PUT that omits one keeps
  // the stored value; `N-05` merges rather than clearing, which is what makes editing a subject
  // line safe on a template with a webhook URL in it.
  return {
    name: template.name,
    description: template.description,
    method: template.method,
    settings: template.settings,
    subject: template.subject,
    body: template.body,
    recipients: template.recipients,
    priority: template.priority,
    enabled: template.enabled,
    summarisation: template.summarisation,
    summaryWindowSeconds: template.summaryWindowSeconds,
    scheduleId: template.scheduleId,
    whenInactive: template.whenInactive,
  };
}

/** A method's settings pre-filled from the defaults its schema declares. */
export function seed(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  return seedDefaults(schema ?? {});
}

/**
 * What the draft would say about a real sensor, right now.
 *
 * Debounced rather than per-keystroke: the core substitutes, which is a round trip, and a preview
 * that fired on every character would be one request per character for an answer that changes
 * once a word.
 *
 * A draft with a misspelled placeholder is *refused*, not partially rendered — the write path
 * refuses it too, so previewing it would preview something unsaveable. The refusal names the
 * placeholder and lists the real ones, which is more use than a half-substituted string.
 */
function Preview({ draft }: { draft: TemplateInput }): React.JSX.Element {
  const sensors = useApi<ObjectPage>('/objects?kind=sensor&limit=50');
  const [sensorId, setSensorId] = useState<number | null>(null);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const settled = useRef<number | undefined>(undefined);

  const chosen =
    sensorId ?? (sensors.status === 'ready' ? (sensors.data.items[0]?.id ?? null) : null);

  // The draft goes through the same validation a write does, so a name that is not there yet
  // fails it — with a message about the name, in a panel that is about the subject and body.
  // Saying what is missing beats surfacing a JSON Pointer somebody has to decode.
  const incomplete = draft.name.trim() === '';

  useEffect(() => {
    if (chosen === null || incomplete) return;
    window.clearTimeout(settled.current);
    settled.current = window.setTimeout(() => {
      send<TemplatePreview>('POST', '/templates/preview', { template: draft, sensorId: chosen })
        .then((rendered) => {
          setPreview(rendered);
          setProblem(null);
        })
        .catch((error: unknown) => {
          setProblem(
            error instanceof ApiError
              ? error
              : new ApiError(0, 'UNKNOWN', 'could not render this draft'),
          );
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(settled.current);
    };
  }, [draft, chosen, incomplete]);

  return (
    <div className="space-y-2 rounded border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-text">Preview</h3>
        {sensors.status === 'ready' && sensors.data.items.length > 0 && (
          <>
            <label htmlFor="preview-sensor" className="sr-only">
              Preview against
            </label>
            <select
              id="preview-sensor"
              value={chosen === null ? '' : String(chosen)}
              onChange={(event) => {
                setSensorId(Number(event.target.value));
              }}
              className="rounded border border-border bg-surface px-1.5 py-0.5 text-xs text-text"
            >
              {sensors.data.items.map((sensor) => (
                <option key={sensor.id} value={sensor.id}>
                  {sensor.name}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      {chosen === null ? (
        <p className="text-xs text-text-muted">
          There are no sensors to render against yet. A preview needs something real — an invented
          state would read well and prove nothing.
        </p>
      ) : incomplete ? (
        <p className="text-xs text-text-muted">Give the template a name to preview it.</p>
      ) : problem !== null ? (
        // The refusal names the placeholder and lists the real ones — which is the whole use of
        // it, and a panel that showed only the sentence would throw that away.
        <Failure error={problem} />
      ) : preview === null ? (
        <p className="text-xs text-text-muted">Rendering…</p>
      ) : (
        <div className="space-y-2">
          <p className="text-sm font-medium text-text">{preview.subject}</p>
          <pre className="whitespace-pre-wrap break-words rounded bg-surface-muted p-2 text-xs text-text">
            {preview.body}
          </pre>
        </div>
      )}
      <p className="text-xs text-text-muted">
        Rendered against that sensor’s actual state, not an invented one.
      </p>
    </div>
  );
}

/** The test send, and what a green result does not prove. */
function TestSend({ template }: { template: TemplateView }): React.JSX.Element {
  const [result, setResult] = useState<TemplateTestResult | null>(null);
  const [failed, setFailed] = useState<ApiError | null>(null);
  const [sending, setSending] = useState(false);

  return (
    <div className="space-y-2 rounded border border-border p-3">
      <h3 className="text-sm font-medium text-text">Test send</h3>
      <p className="text-xs text-warning-fg">
        This really sends, to the real recipients, through the real transport. Testing an on-call
        template at three in the morning pages whoever is on call — which is why it is audited.
      </p>
      <button
        type="button"
        disabled={sending}
        onClick={() => {
          setSending(true);
          setFailed(null);
          send<TemplateTestResult>('POST', `/templates/${String(template.id)}/test`, {})
            .then(setResult)
            .catch((error: unknown) => {
              setFailed(
                error instanceof ApiError
                  ? error
                  : new ApiError(0, 'UNKNOWN', error instanceof Error ? error.message : 'failed'),
              );
            })
            .finally(() => {
              setSending(false);
            });
        }}
        className="rounded border border-border px-2 py-1 text-sm text-text-muted hover:text-text disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {sending ? 'Sending…' : 'Send a test'}
      </button>

      {failed !== null && <Failure error={failed} />}

      {result !== null && (
        <div className="space-y-2 text-xs">
          <p className={result.delivered ? 'text-up-fg' : 'text-down-fg'}>
            {result.delivered ? 'Delivered' : 'Not delivered'} in {result.durationMs}ms —{' '}
            {result.error ?? result.detail}
          </p>
          {result.notes.length > 0 && (
            <ul className="space-y-1 text-text-muted">
              {result.notes.map((note) => (
                <li key={note}>• {note}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Delete({
  template,
  onDeleted,
}: {
  template: TemplateView;
  onDeleted: () => void;
}): React.JSX.Element {
  const [failed, setFailed] = useState<ApiError | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => {
          setConfirming(true);
        }}
        className="ml-auto rounded border border-down-border px-3 py-1 text-sm text-down-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Delete
      </button>
    );
  }

  if (failed !== null) {
    // The core refuses a template a trigger still names, and returns the list (`N-05`). That
    // list is the useful part — a bare "cannot delete" leaves somebody hunting through every
    // object for the reference — so it is shown, with a link to each trigger's object.
    const usedBy = failed.details.usedBy ?? [];
    return (
      <div className="ml-auto max-w-md space-y-1 text-xs text-down-fg">
        <p>{failed.message}</p>
        {usedBy.length > 0 && (
          <ul className="space-y-0.5">
            {usedBy.map((use, index) => (
              <li key={index}>
                <Link
                  to={`/objects/${String(use.objectId ?? 0)}?tab=triggers`}
                  className="text-accent hover:underline"
                >
                  {use.objectName ?? `#${String(use.objectId ?? 0)}`}
                </Link>
                {use.summary !== undefined && <span className="ml-2">{use.summary}</span>}
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
            setFailed(null);
          }}
          className="rounded border border-border px-2 py-1 text-text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <span className="ml-auto flex items-center gap-2">
      <span className="text-xs text-text-muted">Delete it?</span>
      <button
        type="button"
        onClick={() => {
          send('DELETE', `/templates/${String(template.id)}`)
            .then(onDeleted)
            .catch((error: unknown) => {
              setFailed(
                error instanceof ApiError
                  ? error
                  : new ApiError(0, 'UNKNOWN', error instanceof Error ? error.message : 'failed'),
              );
            });
        }}
        className="rounded border border-down-border bg-down-bg px-2 py-1 text-xs text-down-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Yes, delete
      </button>
      <button
        type="button"
        onClick={() => {
          setConfirming(false);
          setFailed(null);
        }}
        className="rounded border border-border px-2 py-1 text-xs text-text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Keep it
      </button>
    </span>
  );
}

function Placeholders({ items }: { items: readonly PlaceholderInfo[] }): React.JSX.Element {
  return (
    <details className="rounded border border-border px-3 py-2">
      <summary className="cursor-pointer text-xs text-text-muted">
        {items.length} placeholders
      </summary>
      <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-xs">
        {items.map((item) => (
          <div key={item.name} className="contents">
            <dt className="font-mono text-text">%{item.name}</dt>
            <dd className="text-text-muted">{item.description}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function Recipients({
  items,
  onChange,
}: {
  items: readonly TemplateRecipient[];
  onChange: (next: TemplateRecipient[]) => void;
}): React.JSX.Element {
  return (
    <fieldset className="space-y-2 rounded border border-border px-3 pb-3 pt-1">
      <legend className="px-1 text-xs font-medium uppercase tracking-wide text-text-muted">
        Recipients
      </legend>
      {items.length === 0 && (
        <p className="text-xs text-text-muted">
          None. A template with no recipients delivers to nobody.
        </p>
      )}
      {items.map((recipient, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`recipient-${String(index)}`}>
            Recipient {index + 1}
          </label>
          <input
            id={`recipient-${String(index)}`}
            value={recipient.value}
            onChange={(event) => {
              const next = [...items];
              next[index] = { ...recipient, value: event.target.value };
              onChange(next);
            }}
            className="w-64 rounded border border-border bg-surface px-2 py-1 text-sm text-text"
          />
          <button
            type="button"
            onClick={() => {
              onChange(items.filter((_, at) => at !== index));
            }}
            className="rounded border border-border px-2 py-0.5 text-xs text-text-muted hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          onChange([...items, { kind: 'address', value: '' }]);
        }}
        className="rounded border border-border px-2 py-1 text-xs text-text-muted hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Add a recipient
      </button>
    </fieldset>
  );
}

function Failure({ error }: { error: ApiError }): React.JSX.Element {
  const problems = error.details.problems ?? [];
  return (
    <div className="space-y-1 text-xs text-down-fg">
      <p>{error.message}</p>
      {problems.length > 0 && (
        <ul className="space-y-0.5">
          {problems.map((problem, index) => (
            <li key={index} className="font-mono">
              {typeof problem === 'string' ? problem : (problem.message ?? '')}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}): React.JSX.Element {
  const id = `template-${label.toLowerCase()}`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="w-full rounded border border-border bg-surface px-2 py-1 text-sm text-text"
      />
    </div>
  );
}

function TextArea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}): React.JSX.Element {
  const id = `template-${label.toLowerCase()}`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      <textarea
        id={id}
        rows={6}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="w-full rounded border border-border bg-surface px-2 py-1 font-mono text-sm text-text"
      />
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
}): React.JSX.Element {
  const id = `template-${label.toLowerCase()}`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => {
          onChange(Number(event.target.value));
        }}
        className="w-24 rounded border border-border bg-surface px-2 py-1 text-sm tabular-nums text-text"
      />
    </div>
  );
}
