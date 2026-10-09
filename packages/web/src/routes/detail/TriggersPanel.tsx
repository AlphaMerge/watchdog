import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, send, useApi } from '../../api/client';
import type { TemplateView, TriggerKind, TriggerView } from '../../api/types';
import { CorrelationId, Empty, ErrorPanel, Loading } from '../../components/Panels';
import { SchemaForm } from '../../forms/SchemaForm';
import type { JsonSchema } from '../../forms/schema';
import { seedFrom } from './model';

interface TriggersResponse {
  objectId: number;
  items: TriggerView[];
}

/**
 * What would notify anybody about this object (`N-01`, `N-16`).
 *
 * **Inherited triggers accumulate; they do not displace.** This is the one place in the system
 * where inheritance does not mean "nearest wins": a trigger on the root and a trigger on the
 * device both fire, whereas an inherited *setting* is replaced by a nearer one. A UI that showed
 * only the nearest — or that greyed the inherited ones out the way an inherited setting is
 * greyed — would be describing the wrong mechanism, and the operator would conclude the root
 * trigger had been overridden when it is about to page them.
 *
 * Each row names the object it is defined on, because that is the only place it can be edited or
 * removed, and links there. `U-10` builds the editor.
 */
export function TriggersPanel({
  objectId,
  inheritsTriggers,
}: {
  objectId: number;
  /** `N-16`'s switch. When it is off, nothing above this object reaches it. */
  inheritsTriggers: boolean;
}): React.JSX.Element {
  const triggers = useApi<TriggersResponse>(`/objects/${String(objectId)}/triggers`);
  const kinds = useApi<{ items: TriggerKind[] }>('/trigger-kinds');
  const templates = useApi<{ items: TemplateView[] }>('/templates');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);

  const reload = triggers.reload;
  const done = useCallback(() => {
    setAdding(false);
    setEditing(null);
    reload();
  }, [reload]);

  if (triggers.status === 'loading' || kinds.status === 'loading')
    return <Loading what="triggers" />;
  if (triggers.status === 'error') {
    return <ErrorPanel error={triggers.error} retry={triggers.reload} />;
  }
  if (kinds.status === 'error') return <ErrorPanel error={kinds.error} retry={kinds.reload} />;

  const items = triggers.data.items;
  const own = items.filter((trigger) => !trigger.inherited);
  const inherited = items.filter((trigger) => trigger.inherited);
  const known = templates.status === 'ready' ? templates.data.items : [];

  return (
    <div className="space-y-4">
      {!inheritsTriggers && (
        <p className="border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-fg">
          This object does not inherit triggers. Nothing defined above it applies here, or to
          anything beneath it.
        </p>
      )}

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">
            Defined here
          </h3>
          {!adding && (
            <button
              type="button"
              onClick={() => {
                setAdding(true);
                setEditing(null);
              }}
              className="border border-control px-2 py-0.5 text-xs text-text-muted hover:text-text"
            >
              + Add a trigger
            </button>
          )}
        </div>

        {adding && (
          <TriggerForm
            objectId={objectId}
            kinds={kinds.data.items}
            templates={known}
            onDone={done}
            onCancel={() => {
              setAdding(false);
            }}
          />
        )}

        {own.length === 0 && !adding ? (
          <p className="text-sm text-text-muted">
            None. Every trigger in effect comes from an ancestor.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {own.map((trigger) =>
              editing === trigger.id ? (
                <li key={trigger.id} className="py-2">
                  <TriggerForm
                    objectId={objectId}
                    kinds={kinds.data.items}
                    templates={known}
                    trigger={trigger}
                    onDone={done}
                    onCancel={() => {
                      setEditing(null);
                    }}
                  />
                </li>
              ) : (
                <OwnRow
                  key={trigger.id}
                  trigger={trigger}
                  templates={known}
                  onEdit={() => {
                    setEditing(trigger.id);
                    setAdding(false);
                  }}
                  onDeleted={done}
                />
              ),
            )}
          </ul>
        )}
      </section>

      <Group
        title="Inherited"
        triggers={inherited}
        empty="None. Only the triggers defined here apply."
        note="An inherited trigger fires as well as the ones defined here, not instead of them. It can only be edited where it is defined."
      />

      {items.length === 0 && !adding && (
        <Empty because="Without one, a state change here notifies nobody.">
          No triggers are in effect.
        </Empty>
      )}
    </div>
  );
}

/** One trigger defined on this object, with the two things only its owner may do. */
function OwnRow({
  trigger,
  templates,
  onEdit,
  onDeleted,
}: {
  trigger: TriggerView;
  templates: readonly TemplateView[];
  onEdit: () => void;
  onDeleted: () => void;
}): React.JSX.Element {
  const [failed, setFailed] = useState<ApiError | null>(null);
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-text">{trigger.kindName}</span>
        <span className="text-sm text-text-muted">{trigger.summary}</span>
        {!trigger.enabled && (
          <span
            className="border border-border px-1.5 py-0.5 text-xs text-text-muted"
            title="Configured, but it will not fire"
          >
            disabled
          </span>
        )}
        <NamedTemplates settings={trigger.settings} templates={templates} />
        <span className="ml-auto flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onEdit}
            className="border border-control px-2 py-0.5 text-xs text-text-muted hover:text-text"
          >
            Edit
          </button>
          {confirming ? (
            <>
              <button
                type="button"
                onClick={() => {
                  // Emptied as the attempt starts, so a second refusal in the same words is a
                  // change and is said again (`U-56`).
                  setFailed(null);
                  send('DELETE', `/triggers/${String(trigger.id)}`)
                    .then(onDeleted)
                    .catch((error: unknown) => {
                      setFailed(
                        error instanceof ApiError
                          ? error
                          : new ApiError(0, 'UNKNOWN', 'could not delete it'),
                      );
                    });
                }}
                className="border border-down-border bg-down-bg px-2 py-0.5 text-xs text-down-fg"
              >
                Yes, delete
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                }}
                className="border border-control px-2 py-0.5 text-xs text-text-muted"
              >
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                setConfirming(true);
              }}
              className="border border-control px-2 py-0.5 text-xs text-down-fg"
            >
              Delete
            </button>
          )}
        </span>
      </div>
      {/* A refused delete. **Always there, empty until a refusal** (`U-56`, as `U-54`'s are):
          focus is on *Yes, delete* when the core refuses, and a region added with its text
          already in it is not reliably announced (`U-41`). An alert, for `U-48`'s reason: the
          trigger the operator thinks they removed is still there. Not in a `space-y-*` stack,
          which would margin the line above it while it says nothing; `empty:mt-0` gives its own
          margin back (`U-45`). */}
      <p role="alert" className="mt-1 text-xs text-down-fg empty:mt-0">
        {failed?.message}
        <CorrelationId id={failed?.correlationId} />
      </p>
    </li>
  );
}

/**
 * Which templates this trigger names, by name.
 *
 * A trigger references templates by id inside a `jsonb` document, so no foreign key enforces it
 * and a trigger may name one that has been deleted (`N-02` chose that deliberately: refusing to
 * record the obligation would lose it rather than surface it). Saying "template 9, missing" is
 * the surfacing.
 */
function NamedTemplates({
  settings,
  templates,
}: {
  settings: Record<string, unknown>;
  templates: readonly TemplateView[];
}): React.JSX.Element | null {
  const named = Object.entries(settings)
    .filter(([key, value]) => key.endsWith('TemplateId') && typeof value === 'number')
    .map(([key, value]) => ({
      role: key.replace(/TemplateId$/, ''),
      id: value as number,
      name: templates.find((template) => template.id === value)?.name ?? null,
    }));
  if (named.length === 0) return null;

  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      {named.map((entry) => (
        <span key={entry.role} className="text-text-muted">
          {entry.role}:{' '}
          {entry.name === null ? (
            <span className="text-warning-fg">#{entry.id} is missing</span>
          ) : (
            <Link to={`/templates?id=${String(entry.id)}`} className="text-accent hover:underline">
              {entry.name}
            </Link>
          )}
        </span>
      ))}
    </span>
  );
}

/**
 * Adding or editing a trigger, from the kind's own schema.
 *
 * The third thing generated from a published JSON Schema, after sensor parameters (`U-08`) and
 * notification-method settings — a new trigger kind is a one-file job for the same reason a new
 * sensor type is.
 */
function TriggerForm({
  objectId,
  kinds,
  templates,
  trigger,
  onDone,
  onCancel,
}: {
  objectId: number;
  kinds: readonly TriggerKind[];
  templates: readonly TemplateView[];
  trigger?: TriggerView;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [kindId, setKindId] = useState(trigger?.kind ?? kinds[0]?.id ?? '');
  const [settings, setSettings] = useState<Record<string, unknown>>(
    () => trigger?.settings ?? seedFrom(kinds[0]),
  );
  const [enabled, setEnabled] = useState(trigger?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<ApiError | null>(null);

  const kind = kinds.find((entry) => entry.id === kindId);
  const schema = useMemo(() => (kind?.settingsSchema ?? {}) as JsonSchema, [kind]);
  const noReplace = useCallback(() => undefined, []);

  const save = (): void => {
    setSaving(true);
    setFailed(null);
    const body = { kind: kindId, settings, enabled };
    const write =
      trigger === undefined
        ? send('POST', `/objects/${String(objectId)}/triggers`, body)
        : send('PUT', `/triggers/${String(trigger.id)}`, body);
    write
      .then(onDone)
      .catch((error: unknown) => {
        setFailed(
          error instanceof ApiError ? error : new ApiError(0, 'UNKNOWN', 'could not save it'),
        );
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <form
      className="space-y-3 border border-accent px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="space-y-1">
        <label htmlFor="trigger-kind" className="text-sm font-medium text-text">
          Kind
        </label>
        <select
          id="trigger-kind"
          value={kindId}
          disabled={saving || trigger !== undefined}
          onChange={(event) => {
            const picked = kinds.find((entry) => entry.id === event.target.value);
            setKindId(event.target.value);
            setSettings(seedFrom(picked));
          }}
          className="w-full max-w-md border border-control bg-surface px-2 py-1 text-sm text-text"
        >
          {kinds.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        {kind !== undefined && <p className="text-xs text-text-muted">{kind.description}</p>}
        {trigger !== undefined && (
          // Changing the kind would change which settings are meaningful; deleting and adding is
          // the honest way to say "a different trigger".
          <p className="text-xs text-text-muted">
            A trigger keeps the kind it was made with. Delete it to make a different one.
          </p>
        )}
      </div>

      <SchemaForm
        schema={schema}
        values={settings}
        redacted={[]}
        onChange={setSettings}
        replacing={EMPTY}
        onReplace={noReplace}
        disabled={saving}
      />

      {templates.length === 0 && (
        <p className="text-xs text-warning-fg">
          There are no templates yet, so a template id here would name nothing. A trigger with no
          template records the obligation and delivers nothing.
        </p>
      )}
      {templates.length > 0 && (
        <p className="text-xs text-text-muted">
          Templates:{' '}
          {templates.map((template) => `${String(template.id)} ${template.name}`).join(', ')}
        </p>
      )}

      <label className="flex min-h-6 items-center gap-1.5 text-sm text-text-muted">
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(event) => {
            setEnabled(event.target.checked);
          }}
        />
        Enabled
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50"
        >
          {saving ? 'Saving…' : trigger === undefined ? 'Add trigger' : 'Save trigger'}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={onCancel}
          className="border border-control px-3 py-1 text-sm text-text-muted hover:text-text disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      {failed !== null && (
        <div className="space-y-1 text-xs text-down-fg">
          <p>{failed.message}</p>
          {(failed.details.problems ?? []).map((problem, index) => (
            <p key={index} className="font-mono">
              {typeof problem === 'string' ? problem : (problem.message ?? '')}
            </p>
          ))}
        </div>
      )}
    </form>
  );
}

const EMPTY: ReadonlySet<string> = new Set();

function Group({
  title,
  triggers,
  empty,
  note,
}: {
  title: string;
  triggers: readonly TriggerView[];
  empty: string;
  note?: string;
}): React.JSX.Element {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">{title}</h3>
      {note !== undefined && triggers.length > 0 && (
        <p className="text-xs text-text-muted">{note}</p>
      )}
      {triggers.length === 0 ? (
        <p className="text-sm text-text-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {triggers.map((trigger) => (
            <li key={trigger.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
              <span className="text-sm font-medium text-text">{trigger.kindName}</span>
              <span className="text-sm text-text-muted">{trigger.summary}</span>
              {!trigger.enabled && (
                <span
                  className="border border-border px-1.5 py-0.5 text-xs text-text-muted"
                  title="Configured, but it will not fire"
                >
                  disabled
                </span>
              )}
              {trigger.inherited &&
                (trigger.definedOn.name === null ? (
                  // It fires for this object, so it is listed; where it is defined is outside
                  // what this account may see, so it is not named or linked (`A-12`).
                  <span className="ml-auto text-xs text-text-muted">
                    from an object outside your view
                  </span>
                ) : (
                  <Link
                    to={`/objects/${String(trigger.definedOn.objectId)}?tab=triggers`}
                    className="ml-auto text-xs text-accent hover:underline"
                  >
                    from {trigger.definedOn.name}
                  </Link>
                ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
