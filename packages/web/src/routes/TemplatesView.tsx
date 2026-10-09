import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
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
  TemplateTestResult,
  TemplateView,
} from '../api/types';
import { HeldListFailure } from '../components/HeldListFailure';
import { Card, CorrelationId, Empty, ErrorPanel, Loading } from '../components/Panels';
import { useRefusal } from '../components/refusal';
import { SchemaForm } from '../forms/SchemaForm';
import type { JsonSchema } from '../forms/schema';
import { PageTitle } from '../components/PageTitle';
import { initial, seed } from './templates-model';
import { RecipientsEditor } from './RecipientsEditor';
import { mayChoosePeople } from './recipients-model';
import { useSession } from '../auth/session';

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

  // **A deleted or saved template, said, and focus somewhere that stays** (`U-64` review,
  // `U-69`). An accepted delete or save closes the editor, and the button that had focus goes
  // with it. Focus goes to *New template*: a real control, at the top of the page, there whether
  // the list is empty or not, one Tab after the heading; and a polite region that was there from
  // the start says what happened, since nothing else on the page does (the template just leaves
  // the list, or stays in it as it was). Emptied and filled through `sayAgain`, so a second
  // template deleted or saved under the same name is said too, and emptied when an editor is
  // opened.
  const [done, setDone, sayDone] = useRefusal<string>();
  const newButton = useRef<HTMLButtonElement>(null);
  const focusNew = useCallback(() => {
    newButton.current?.focus();
  }, []);

  const open = useCallback(
    (id: number | null) => {
      setDone(null);
      setParams(id === null ? { new: '1' } : { id: String(id) }, { replace: true });
    },
    [setParams, setDone],
  );

  const close = useCallback(() => {
    setParams({}, { replace: true });
  }, [setParams]);

  // The list last read, kept while it is read again after a save or a delete: otherwise the page
  // is *Loading templates…* for the length of the request, and *New template*, the region that
  // says the delete, and the focus on it go with it. **Kept when that read fails, too** (`U-67`),
  // with the failure said beside it: the page used to give way to an error panel, taking the
  // list, *New template*, the region and the focus with it.
  const heldTemplates = useRef<readonly TemplateView[] | null>(null);
  useEffect(() => {
    if (templates.status === 'ready') heldTemplates.current = templates.data.items;
  }, [templates]);
  const items = templates.status === 'ready' ? templates.data.items : heldTemplates.current;

  if ((templates.status === 'loading' && items === null) || methods.status === 'loading') {
    return <Loading what="templates" />;
  }
  if (templates.status === 'error' && items === null) {
    return <ErrorPanel error={templates.error} retry={templates.reload} />;
  }
  if (methods.status === 'error')
    return <ErrorPanel error={methods.error} retry={methods.reload} />;
  if (items === null) return <Loading what="templates" />;

  const chosen = editing === null ? undefined : items.find((t) => String(t.id) === editing);

  return (
    <div className="space-y-4">
      {/* One block, so the region below never ends up as an empty child of the page's stack. */}
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <PageTitle title="Notification templates" />
          <button
            ref={newButton}
            type="button"
            onClick={() => {
              open(null);
            }}
            className="ml-auto border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast"
          >
            New template
          </button>
        </div>
        <p role="status" className="mt-2 text-sm text-text-muted empty:mt-0">
          {done}
        </p>
      </div>

      {(creating || chosen !== undefined) && (
        <Editor
          key={chosen?.id ?? 'new'}
          template={chosen}
          methods={methods.data.items}
          onSaved={(saved, created) => {
            sayDone(`Template ${saved.name} ${created ? 'created' : 'saved'}.`);
            templates.reload();
            close();
            focusNew();
          }}
          onDeleted={(name) => {
            sayDone(`Template ${name} deleted.`);
            templates.reload();
            close();
            focusNew();
          }}
          onCancel={close}
        />
      )}

      <Card>
        <HeldListFailure
          what="The template list"
          error={templates.status === 'error' ? templates.error : null}
          reading={templates.status === 'loading'}
          onRetry={templates.reload}
          focusAfter={focusNew}
        />
        {items.length === 0 ? (
          <Empty because="Without one, a trigger has nothing to send and an alarm reaches nobody.">
            No templates yet.
          </Empty>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((template) => (
              <li key={template.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <button
                  type="button"
                  onClick={() => {
                    open(template.id);
                  }}
                  className="text-sm font-medium text-accent hover:underline"
                >
                  {template.name}
                </button>
                <span className="text-xs text-text-muted">{template.methodName}</span>
                <span className="text-xs text-text-muted">{template.summary}</span>
                {!template.enabled && (
                  <span
                    className="border border-border px-1.5 py-0.5 text-xs text-text-muted"
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
  onDeleted,
  onCancel,
}: {
  template: TemplateView | undefined;
  methods: readonly NotificationMethod[];
  /** The template was written; what the core answered, and whether it was a new one. */
  onSaved: (saved: TemplateView, created: boolean) => void;
  /** The template was deleted; its name, for the page to say so. */
  onDeleted: (name: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const placeholders = useApi<{ items: PlaceholderInfo[] }>('/notification-placeholders');
  const modes = useApi<{ items: SummarisationMode[] }>('/summarisation-modes');
  const schedules = useApi<{ items: ScheduleSummary[] }>('/schedules');

  const [draft, setDraft] = useState<TemplateInput>(() => initial(template, methods));
  const choosePeople = mayChoosePeople(useSession().session);
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
      .then((saved) => {
        onSaved(saved, template === undefined);
      })
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
              className="w-full max-w-md border border-control bg-surface px-2 py-1 text-sm text-text"
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

          <fieldset className="space-y-4 border border-border px-3 pb-3 pt-1">
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
            <RecipientsEditor
              items={draft.recipients ?? []}
              onChange={(recipients) => {
                setDraft({ ...draft, recipients });
              }}
              choosePeople={choosePeople}
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
            <label className="flex min-h-6 items-center gap-1.5 text-sm text-text-muted">
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
                className="w-full max-w-md border border-control bg-surface px-2 py-1 text-sm text-text"
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
                className="w-full max-w-md border border-control bg-surface px-2 py-1 text-sm text-text"
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
                    className="ml-2 border border-control bg-surface px-2 py-1 text-sm text-text"
                  >
                    <option value="queue">queued until the window opens</option>
                    <option value="discard">discarded</option>
                  </select>
                </div>
              )}
            </div>
          )}

          {/* The buttons and the refused save are one block of the form's `space-y-4` stack, so
              the region, empty, is not a last child that leaves the stack's margin under the
              buttons (`U-52`). */}
          <div>
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <button
                type="submit"
                disabled={saving || draft.name.trim() === ''}
                className="border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50"
              >
                {saving ? 'Saving…' : template === undefined ? 'Create template' : 'Save template'}
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={onCancel}
                className="border border-control px-3 py-1 text-sm text-text-muted hover:text-text disabled:opacity-50"
              >
                Cancel
              </button>
              {template !== undefined && (
                <Delete
                  template={template}
                  onDeleted={() => {
                    onDeleted(template.name);
                  }}
                />
              )}
            </div>

            <Failure error={failed} className="mt-4 empty:mt-0" />
          </div>
        </form>

        <div className="space-y-4">
          <Preview draft={draft} />
          {template !== undefined && <TestSend template={template} />}
        </div>
      </div>
    </Card>
  );
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
  const [problem, setProblem, sayAgain] = useRefusal<ApiError>();
  const settled = useRef<number | undefined>(undefined);

  const chosen =
    sensorId ?? (sensors.status === 'ready' ? (sensors.data.items[0]?.id ?? null) : null);

  // The draft goes through the same validation a write does, so a name that is not there yet
  // fails it — with a message about the name, in a panel that is about the subject and body.
  // Saying what is missing beats surfacing a JSON Pointer somebody has to decode.
  const incomplete = draft.name.trim() === '';

  useEffect(() => {
    if (chosen === null || incomplete) return;
    // An answer about a draft that has changed since is not shown: the newer one is asked.
    let stale = false;
    window.clearTimeout(settled.current);
    settled.current = window.setTimeout(() => {
      send<TemplatePreview>('POST', '/templates/preview', { template: draft, sensorId: chosen })
        .then((rendered) => {
          if (stale) return;
          setPreview(rendered);
          setProblem(null);
        })
        .catch((error: unknown) => {
          if (stale) return;
          // The rendering it replaces is about a draft that is no longer in the boxes, and is
          // not what shows for the moment the refusal waits below.
          setPreview(null);
          // Emptied now and said a moment later (`U-56`, as `U-57` does for a range): a draft
          // edited and refused in the same words is a new refusal, and a region whose text did
          // not change says nothing — a local core can answer before the empty one is seen.
          sayAgain(
            error instanceof ApiError
              ? error
              : new ApiError(0, 'UNKNOWN', 'could not render this draft'),
          );
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      stale = true;
      window.clearTimeout(settled.current);
    };
  }, [draft, chosen, incomplete, setProblem, sayAgain]);

  return (
    <div className="space-y-2 border border-border p-3">
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
              className="border border-control bg-surface px-1.5 py-0.5 text-xs text-text"
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

      {/* What the preview shows and its refusal are one block of the `space-y-2` stack, so the
          region, empty, takes no margin. One or the other has something to say, never both. */}
      <div>
        {chosen === null ? (
          <p className="text-xs text-text-muted">
            There are no sensors to render against yet. A preview needs something real — an invented
            state would read well and prove nothing.
          </p>
        ) : incomplete ? (
          <p className="text-xs text-text-muted">Give the template a name to preview it.</p>
        ) : problem !== null ? null : preview === null ? (
          <p className="text-xs text-text-muted">Rendering…</p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium text-text">{preview.subject}</p>
            <pre className="whitespace-pre-wrap break-words bg-surface-muted p-2 text-xs text-text">
              {preview.body}
            </pre>
          </div>
        )}
        {/* The refusal names the placeholder and lists the real ones — which is the whole use of
            it, and a panel that showed only the sentence would throw that away. **Always there,
            empty until a refusal, and polite** (`U-56`): it answers the draft as it is typed, so
            it changes as the operator types and should not interrupt them (`U-48`). */}
        <Failure error={chosen !== null && !incomplete ? problem : null} polite />
      </div>
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
    <div className="space-y-2 border border-border p-3">
      <h3 className="text-sm font-medium text-text">Test send</h3>
      <p className="text-xs text-warning-fg">
        This really sends, to the real recipients, through the real transport. Testing an on-call
        template at three in the morning pages whoever is on call — which is why it is audited.
      </p>
      {/* The button and its refusal are one block of the `space-y-2` stack, so the region,
          empty, leaves no margin between the button and a result (`U-52`). */}
      <div>
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
          className="border border-control px-2 py-1 text-sm text-text-muted hover:text-text disabled:opacity-50"
        >
          {sending ? 'Sending…' : 'Send a test'}
        </button>

        <Failure error={failed} className="mt-2 empty:mt-0" />
      </div>

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
  // The request is out (`U-64` review). *Keep it* is not offered while it is: a delete that has
  // been sent cannot be called back, so a *Keep it* pressed now would close the question and then
  // delete the template anyway when the core accepted it — or, refused, leave a refusal with no
  // question to come back to. *Yes, delete* stays where it is, saying so, and does nothing more.
  const [deleting, setDeleting] = useState(false);

  // **Where focus goes when the button that had it is taken away** (`U-64`), so that no step
  // here leaves it on the page, where a keyboard user starts again from the top and a screen
  // reader may say nothing of where they are.
  // - **Asking the question puts it on *Keep it*.** *Delete* is gone, and of the two answers the
  //   one a second press of Enter or Space should land on is the one that loses nothing: with
  //   focus on *Yes, delete*, pressing *Delete* twice would delete. *Keep it* is described by the
  //   question, and *Yes, delete* is one Shift+Tab away.
  // - **A refusal puts it on *Close***, the one control the refusal leaves, rather than on the
  //   region: the alert already says the refusal, a focused region would say it a second time and
  //   is not something the operator can act on, and *Close* is described by the region, so a
  //   reader whose focus change cut the alert short still hears why it is there. The triggers
  //   that still name the template are links just before it, one Shift+Tab away.
  // - ***Close* and *Keep it* put it back on *Delete***, which takes their place.
  // An accepted delete closes the editor; the page puts focus on *New template* and says so.
  const focusNext = useRef<'keep' | 'close' | 'delete' | null>(null);
  const yesButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const region = useId();
  const question = useId();

  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    const button = { keep: keepButton, close: closeButton, delete: deleteButton }[target];
    button.current?.focus();
  }, [failed, confirming]);

  // The core refuses a template a trigger still names, and returns the list (`N-05`). That list
  // is the useful part — a bare "cannot delete" leaves somebody hunting through every object for
  // the reference — so it is shown, with a link to each trigger's object.
  const usedBy = failed?.details.usedBy ?? [];

  return (
    <div className="ml-auto max-w-md">
      {!confirming ? (
        <button
          ref={deleteButton}
          type="button"
          onClick={() => {
            focusNext.current = 'keep';
            // The question is always asked: nothing refused is left standing in its place.
            setFailed(null);
            setConfirming(true);
          }}
          className="border border-down-fg px-3 py-1 text-sm text-down-fg"
        >
          Delete
        </button>
      ) : failed === null ? (
        <span className="flex items-center gap-2">
          <span id={question} className="text-xs text-text-muted">
            Delete it?
          </span>
          <button
            ref={yesButton}
            type="button"
            // Not `disabled`: a button disabled while it has focus can lose it.
            aria-disabled={deleting}
            onClick={() => {
              if (deleting) return;
              // Emptied as the attempt starts (`U-56`); it already is, since the question is
              // only asked while nothing is refused, but this does not rest on that.
              setFailed(null);
              setDeleting(true);
              send('DELETE', `/templates/${String(template.id)}`)
                .then(onDeleted)
                .catch((error: unknown) => {
                  // Only from *Yes, delete*: an operator who moved on while the core answered
                  // keeps their focus where they took it. A click that did not focus the button
                  // (Safari's) leaves it on the page, and that is moved too.
                  const at = document.activeElement;
                  if (at === yesButton.current || at === null || at === document.body) {
                    focusNext.current = 'close';
                  }
                  setDeleting(false);
                  setFailed(
                    error instanceof ApiError
                      ? error
                      : new ApiError(
                          0,
                          'UNKNOWN',
                          error instanceof Error ? error.message : 'failed',
                        ),
                  );
                });
            }}
            className="border border-down-fg bg-down-bg px-2 py-1 text-xs text-down-fg aria-disabled:opacity-50"
          >
            {deleting ? 'Deleting…' : 'Yes, delete'}
          </button>
          {!deleting && (
            <button
              ref={keepButton}
              type="button"
              aria-describedby={question}
              onClick={() => {
                focusNext.current = 'delete';
                setConfirming(false);
                setFailed(null);
              }}
              className="border border-control px-2 py-1 text-xs text-text-muted"
            >
              Keep it
            </button>
          )}
        </span>
      ) : null}

      {/* A refused delete. **Always there, empty until a refusal** (`U-56`, as `U-54`'s are):
          focus is on *Yes, delete* when the core refuses, and a region added with its text
          already in it is not reliably announced (`U-41`). An alert, for `U-48`'s reason: the
          template the operator thinks they removed is still there. It takes the question's place
          and needs no margin of its own, so an empty one takes no space. */}
      <div id={region} role="alert" className="space-y-1 text-xs text-down-fg">
        {failed !== null && (
          <p>
            {failed.message}
            <CorrelationId id={failed.correlationId} />
          </p>
        )}
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
      </div>

      {failed !== null && (
        <button
          ref={closeButton}
          type="button"
          aria-describedby={region}
          onClick={() => {
            focusNext.current = 'delete';
            setConfirming(false);
            setFailed(null);
          }}
          className="mt-1 border border-control px-2 py-1 text-xs text-text-muted"
        >
          Close
        </button>
      )}
    </div>
  );
}

function Placeholders({ items }: { items: readonly PlaceholderInfo[] }): React.JSX.Element {
  return (
    <details className="border border-border px-3 py-2">
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

/**
 * A refusal with the problems the core listed, in a region that is always there (`U-56`).
 *
 * **Empty until there is one**, as `U-54`'s are: a region added with its text already in it is
 * not reliably announced (`U-41`). An alert by default, for a refused save or test send — focus
 * is on the button when the core refuses, and what it says is that what the operator just did
 * did not happen (`U-48`). `polite` for the preview, which answers the draft as it is typed and
 * changes with it; it is said whole, as an alert is, so a list that changed under the same
 * sentence is not read as the list alone. `className` is the margin and its `empty:` twin
 * (`U-45`), when the caller's block needs one.
 */
function Failure({
  error,
  className = '',
  polite = false,
}: {
  error: ApiError | null;
  className?: string;
  polite?: boolean;
}): React.JSX.Element {
  const problems = error?.details.problems ?? [];
  return (
    <div
      role={polite ? undefined : 'alert'}
      aria-live={polite ? 'polite' : undefined}
      aria-atomic={polite ? true : undefined}
      className={`space-y-1 text-xs text-down-fg ${className}`.trim()}
    >
      {error !== null && (
        <p>
          {error.message}
          <CorrelationId id={error.correlationId} />
        </p>
      )}
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
        className="w-full border border-control bg-surface px-2 py-1 text-sm text-text"
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
        className="w-full border border-control bg-surface px-2 py-1 font-mono text-sm text-text"
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
        className="w-24 border border-control bg-surface px-2 py-1 text-sm tabular-nums text-text"
      />
    </div>
  );
}
